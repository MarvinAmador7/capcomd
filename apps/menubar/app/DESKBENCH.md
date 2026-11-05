# deskbench: the desktop window's bench, for coding agents

`CapcomdDeskBench` hosts the capcomd desktop window (the `CapcomdDesk` library: the same model, reel and title bar the
app shows) **in its own process, on generated data, with instruments around it**, and drives it the way a user would:
tab clicks, project switches, swipes, typing, a resize, an ask arriving. It prints numbers against the budgets in
`design/desktop/SPEC.md` §1, a verdict, and an explanation of where the time went. Everything is in-process: no daemon,
no screen-recording permission, no synthetic input to the system (nothing else on the Mac is clicked).

You are its user. It is written for someone who cannot see the screen: every command has `--json`, the schema is in
`Sources/DeskBenchKit/Results.swift` and never renames a field, exit codes mean one thing each, and `explain` turns a
result into the sentences you would otherwise have to work out.

```sh
cd apps/menubar/app
swift build -c release --product CapcomdDeskBench      # ~3 min the first time; always bench a release build
B=.build/release/CapcomdDeskBench
$B list                                                 # this build's commit, scenarios → budgets, fixtures
$B describe --json                                      # the perfloop.manifest/1: scenarios, objectives, guards, knobs
$B run step --fixture crew17 --reps 5                   # one scenario, text verdict (add --json for the result)
$B suite --reps 3 --out /tmp/bench                      # everything, one line each; JSON per scenario in /tmp/bench
$B snapshot --out /tmp/snap                             # window.png + window.json (view tree, scroll geometry, model)
$B profile step --template hitches --out /tmp/prof      # the same run under Instruments, summarised
$B selftest sampler                                     # headless check of the stack sampler (no window)
```

Debug builds are 5–20× slower in SwiftUI's own code and will fail every budget: the result says `"configuration":
"debug"` so you can tell, but don't quote those numbers.

Every result says which binary made it: `tool.build` (perfloop.build/1) has the commit, whether the package's tracked
sources had uncommitted changes (`dirty`), a hash of those sources (`sourceHash`: two clean builds of one commit
agree), the build time, configuration, Xcode, and the executable's own `hash`. The `BuildStamp` plugin
(`Plugins/BuildStamp`) compiles that into the binary before every build, so a copied binary run from anywhere still
reports its own commit; `tool.commit` is the same commit. Built without git (a tarball), `commit` is null and `dirty`
true. Results from before the stamp have no `build` and often no `commit`.

## When to use what

| You want to know | Run | Read |
|---|---|---|
| Is the reel smooth / did my change hurt it? | `run step` (or `jump`, `fling`) `--reps 5` | `verdict`, `summary.hitchTimeRatioMsPerS`, `summary.mainThreadCpuMsPerStep`, `summary.longestStretchMs`, then the stretches |
| Does the window open / switch fast enough? | `run open`, `run switch` | `summary.latencyMs.median` vs the budget (100 / 50 ms) |
| Does the reel follow my fingers, and how much does a real swipe cost? | `run swipe --gesture FILE` (a recording: `record-gesture`) | `summary.smoothness` (`positionErrorP95Pt`, `stalls`, `jerkP95`), `summary.mainThreadCpuMsPerStep`; see *Recorded gestures* |
| Does a thread item re-render only its column? | `run burst` | `checks` named `isolation-*`; `reps[].steps[].notes` has the counts |
| Does typing stay inside the composer? | `run typing` | `checks` `isolation`; which views leaked is in the detail |
| Does Follow go to the ask, and how fast? | `run follow` | `latencyMs` (ask → reel starts), `settleMs`, check `landed` |
| What does the window look like / why does it scroll vertically? | `snapshot` | `window.png`; `window.json → scrollViews` (doc vs clip size, insets, safe area) |
| Which views re-rendered when X happened? | any `run`, look at `reps[].steps[].bodies` and `worstStretches[].bodies` | per view type; `Column`, `EntryRow` etc. carry the agent id internally for the isolation checks |
| What ran inside a long stretch (stacks)? | any `run` (the sampler is on by default), then `explain` | `worstStretches[].topOurs`, `topFramework` (with `under`), `topSelf`, `stacks` (the tree) |
| The same, confirmed by Instruments | `profile <scenario> --template time` | `timeProfile.burstFrames` (what the ≥16 ms bursts were doing), `inclusiveOurs` |
| What did the compositor count as hitches? | `profile <scenario> --template hitches` | `hitches.hitches`, `causes`, `potentialHangsMs` |
| Where did a step's main-thread time go? | `profile <scenario> --template time`, or `trace <file.trace>` | `msPerStep`, `treeInSteps`, `treePerStep` (call trees per `step` signpost) |
| What did build B make cheaper or dearer than A, and where? | `diff a.trace b.trace` (or two profile JSONs) | the grew/shrank lists, ms per step; `--json` → `perfloop.diff/1` |
| Did commit B regress commit A? | build both, `ab --a A/CapcomdDeskBench --b B/CapcomdDeskBench step --reps 5` | the `[objective]` and `[guard]` lines; exit 4 on a regression beyond noise |
| Was a decision right (the slide, the build rate)? | `ab step --a-knobs reel.slide=ca --b-knobs reel.slide=clip --reps 5`: one binary, two knob settings | the same lines; the `knobs:` line says what differed |
| What can a runner drive, decide on, sweep? | `describe --json` | `scenarios[]` (`objective`, `guards`, `checks`, `params`), `fixtures`, `knobs` |
| Did my change leave a column blank or change the look? | `run switch --guards built-within,snapshot-diff --artifacts DIR`, then `snapdiff A.png B.png` | `reps[].guards[]`; see *Correctness guards* |
| Gate in a script | `run … --baseline saved.json` or `compare a.json b.json` | exit code |

Exit codes: `0` pass · `1` usage · `2` harness error · `3` budget failed · `4` regression beyond noise · `5` untrusted
(the budget failed **and** the machine was noisy: the run says nothing about the reel; run it again when quiet) ·
`6` refused (a profiled result was given to `compare` or `--baseline`).

Two hosts (`--host`): `scene` (default) runs the bench as a SwiftUI app whose `Window` scene shows the fixture — the
app's own NSWindow subclass, hosting view and toolbar handling, so what the app pays, the bench pays; `window` makes an
NSWindow by hand with the same content view and chrome (what `open` always uses: it needs a fresh window per rep).
The result's `params.host` says which. The two differ (see *What the bench found*), so compare like with like.

`trace <file.trace>` summarises a trace you already have (one recorded by hand, or from an earlier session) the same
way `profile` does. `diff A B` (or `trace --diff A B`) compares two time profiles, `.trace` files or profile JSONs:
see *Comparing two builds' call trees* below.

## Scenarios and their budgets

`list` prints these with the exact rule. Each maps to a SPEC §1 row:

- `open`: window on a filled store → first committed frame. Budget 100 ms. Rep 0 is the cold one (fonts, Metal,
  SwiftUI's first graph); later reps are warm windows in the same process. `params.processLaunchToFirstFrameMs` is the
  process-launch number.
- `switch`: `model.open(project:)` between the two largest projects → the frame showing the new columns. Budget 50 ms.
- `step` / `jump`: animated scrolls as a crew-tab click does (one screen at a time; first ↔ last). Budget: no late frame
  while the reel moves (judged as late frame time: `hitchTimeRatioMsPerS` must be 0), no main-thread stretch over a
  frame.
- `fling`: a swipe with momentum, see *Fidelity* below. Also checks the reel rested on a column edge.
- `swipe`: a recorded gesture (`--gesture FILE`, `perfloop.gesture/1`; default the synthetic `flick-forward`) replayed
  into the reel at its recorded times, `swipes` (4) times from the middle column; budget as `fling` plus the content
  within 1 pt of the fingers (p95) with no stall. See *Recorded gestures* below. Not in `suite`.
- `burst`: thread items for one on-screen agent at N/s (default 20/s for 3 s), standing still and then while stepping.
  Passes when no other column's thread, no `Column`/`ColumnHead`/`CrewTab`/`TitleBar` body ran.
- `typing`: key events into an on-screen composer. Passes when only `ColumnComposer` bodies ran.
- `resize`: 1440 → 1100 → 720 → 1440 wide; the column count must follow (3 → 2 → 1 → 3); no stretch over 100 ms.
- `follow`: an `approval.requested` frame for a far-off agent with Follow on; latency is ask → reel starts moving.

Fixtures (`list fixtures`): `solo` (1 agent), `trio` (3), `crew17` (SPEC's 17-agent reference, the default),
`crew17-long` (400–600 items a thread), `swarm64` (64 agents: past the warm cap of 32). Same name, same bytes, every
time (a seeded generator: markdown with headings/lists/code/tables, tool calls with diffs, thinking, handoffs, errors,
images as attachments, one or more pending asks). `fixture <name>` describes one.

## Reading a result

```
step on crew17: PASS  (5 reps, 9800 ms, 120 Hz, release)
build: 9bcd41a · release · built 2026-10-30T15:31:02Z
budget: Reel scroll: no dropped frames at 120 Hz with 17 agents
rule:   no late frame while the reel moves; no stretch over 16.7 ms during a step
  ✓ met
noise: quiet (idle: 0/120 late frames, longest idle stretch 2.1 ms, load/core 0.31)

numbers (medians across reps):
  settle        median 412.0 ms  max 440.1 ms
  objective     mainThreadCpuMsPerStep 41.2 (min 39.8, max 44.0, n=5)
  per step      main-thread cpu 41.2 ms (mad 0.9)  instructions 61.20 M (mad 0.01 M)
  frames        late frame time 0.0 ms/s (max 1.2)  display at 120 Hz  p95 8.41 ms  p99 8.6 ms  late 0.0/rep (max 1.0)  dropped 0.0/rep
  main thread   longest 6.9 ms (max 11.2)  >16.7 ms: 0.0/rep  >100 ms: 0.0/rep
  bodies/rep    Column 136  CrewTab 128  Reel 8  OpenGroup 8

longest main-thread stretches (what SwiftUI evaluated inside each, and where the sampled stacks were):
     11.2 ms  during step#3 9→12  Column×17 CrewTab×16 OpenGroup×1
```

- **objective** and **per step**: the numbers `ab`, `compare` and `--baseline` decide on (see *Comparing two builds*).
  `mainThreadCpuMsPerStep` is the main thread's CPU time over the steps' stretches (`thread_info`) divided by the
  steps; `instructionsPerStep` is the instructions the process retired during the steps (`proc_pid_rusage`, all
  threads; null where the counters read zero, as in a VM). Both are rate-invariant and far less noisy than wall
  time on a busy machine: the instruction count varied 0.01 % across identical work where wall time varied 9–15 %.
- **frames**: display-link ticks on the main thread while a step ran. **Late frame time** (`hitchTimeRatioMsPerS`) is
  the sum, over intervals longer than 1.5× the steady frame, of how much longer they were than one frame, per second
  of scenario: ms of lateness per second, the same whatever rate the panel ran at and however long the scenario was
  (Apple's bands: under 5 good, 5–10 noticeable, over 10 act). It is what the budgets and the frame guard use; the
  counts below are kept and printed but never decide. `steadyHz` is the rate the display actually ran
  at (the fastest quartile of intervals, snapped to a panel rate: a ProMotion panel idles at 24–48 Hz and the bench
  asks for its top rate, but a main thread that can't keep up pulls it down); `late` = an interval over 1.5× that frame;
  `lateAtNominal` judges against the panel's top rate; `dropped` = how many frames the late intervals spanned. This is
  what the main thread could have drawn; the compositor's own list is `profile --template hitches`. `frameP95Ms`
  depends on `steadyHz`, so between runs at different rates trust `late` and the stretches, not p95.
- **main thread**: each run-loop awakening is a stretch, in wall time, with its CPU time beside it. Over 16.7 ms is a
  dropped 60 Hz frame; over 100 ms is felt; over 250 ms is a hang by Instruments' definition. `cpuMs` far below the
  wall time means the thread was preempted (the machine, not the work); `summary.mainThreadCpuShare` is the ratio.
- **bodies**: SwiftUI `body` evaluations per view type (the views call `DeskProbe.body` first thing; with no sink
  attached, as in the app, that is a nil check). `Column×17` after a tab click means every column re-evaluated once;
  `Column` counts growing with the length of a jump means columns are being rebuilt mid-scroll.
- **stretches**: the longest awakenings, with the bodies evaluated inside each and, under it, what the sampler saw
  (next section): the top inclusive frames that are ours or SwiftUI/AppKit hot spots, the hottest path through the
  stack, and the leaf frames. A long stretch with no bodies is AppKit layout, text, or the fixture; its stacks say which.
- **noise** and **window**: the idle floor measured before the scenario, the load average, thermal state, busy
  processes, and whether the window was active, key and unoccluded. SwiftUI flushes timer-driven state changes
  late (seconds) when the app is in the background, so the bench activates itself; `window.trustworthy` in the JSON
  says whether that held. **One run proves nothing on a shared machine**; use `--reps 5` and medians, or `ab`.

JSON: `BenchResult` in `Results.swift`. The useful paths: `.verdict`, `.exitCode`, `.budget.reasons[]`,
`.summary.{objective,mainThreadCpuMsPerStep,instructionsPerStep,hitchTimeRatioMsPerS,latencyMs,longestStretchMs,bodies}`
(and the frame counts `lateFrames`, `frameP95Ms`), `.reps[].steps[]` (per step: `latencyMs`, `settleMs`, `cpuMs`,
`instructions`, `frames` with `hitchTimeRatioMsPerS`, `mainThread`, `bodies`, `notes`), `.reps[].checks[]`,
`.reps[].worstStretches[]`, `.noise`, `.window`, `.machine`, `.tool.build`, `.profiled`, `.comparison[]` (each row
with its `role`). Fields are only ever added: older results still decode, with the new ones absent. With the sampler, `.reps[].worstStretches[].{samples,topOurs,topFramework,topSelf,stacks}`
and `.reps[].sampler`.

## Stacks inside stretches: the sampler

While a `run` (or `suite`, `ab`'s children, `profile`'s child) has its window up, a background thread samples the main
thread's stack, but only inside a stretch that has already lasted `--sample-gate-ms` (default 4 ms), at `--sample-hz`
(default 1000): it suspends the main thread, reads its registers, walks the frame pointers, resumes it. Idle time and
short wake-ups cost two observer callouts and nothing else. After each rep the stacks of the worst stretches are
symbolised in-process (`dladdr`, demangled, cleaned to xctrace-style names such as `ScrollViewCommitMutation.commit`,
`AG::Graph::propagate_dirty`) and attached to `worstStretches[]`:

| field | what |
|---|---|
| `samples` | stacks taken in the stretch; `0` = shorter than the gate (not sampled) |
| `topOurs` | our frames (anything in the bench's executable: CapcomdDesk, CapcomdUI, the store, the bench), inclusive |
| `topFramework` | framework frames, inclusive, minus the run loop's own (`CFRunLoopRun…`, `_dispatch_…`, `main`); `under` = our frame they ran beneath |
| `topSelf` | the leaf frames: where the samples landed |
| `stacks` | the folded tree (`{n, v, c}`, `v` = samples, heaviest child first, nodes under 0.5 % pruned) |
| `awakeMs` | the wake-up as the sampler saw it (see below) |

`reps[].sampler` has what it did and cost: `samples`, `sampledStretches`, `failures`, `truncated`, `costP50Us`
(per sample), `stallMs` (time the main thread was held suspended), `overheadPct` (the sampler thread's CPU over the
main thread's). `--sampler off` (or `DESKBENCH_SAMPLER=off` in the environment) turns it all off: the fields are then absent, as in
results from before it existed.
In `explain` each sampled stretch gets up to three lines (this one is from `selftest sampler`, whose burn is
`selftestBurn` → 90 % `selftestHot` → `selftestHotInner` → `selftestSpin`, 10 % `selftestCold` → `selftestSpin`):

```
    120.1 ms wall  120.1 ms cpu  during selftest  (no view bodies)
             116 samples: SelfTest.sampler 100 % · selftestBurn 100 % · selftestSpin 99 % · selftestHot 89 % · selftestHotInner 89 %
             path: SelfTest.sampler 100 % › selftestBurn 100 % › selftestHot 89 % › selftestHotInner 89 % › selftestSpin 88 %
             self: selftestSpin 99 % · selftestHotInner 1 %
```

The first line is the top five inclusive frames that are ours or SwiftUI/AppKit hot spots; `path` follows the
heaviest callee down from the run loop, printing the frames where the time splits; `self` is where it landed.

`selftest sampler` checks it headless, with no window: a known 90/10 workload on a bare main run loop must come out
90/10, wake-ups under the gate must not be sampled, and two seconds of allocation under sampling must not deadlock.
On an M1 Pro at a load average of 7–10 it reported ~10 µs a sample, the sampler thread at ~1.3 % of the main thread's
CPU, ~1 % less work per CPU ms in sampled stretches, and 0.4–6 % more wall time (each suspension gives up the core,
so on a loaded machine wall time pays more than CPU time; compare CPU, or turn the sampler off for both sides).

Read it with care:

- **Names are `dladdr`'s**: the nearest symbol before the address. In a stripped stretch of code that can be a
  neighbour's name. `profile --template time` is the confirmation when a name looks wrong.
- **`awakeMs` vs `durationMs`**: the harness measures a stretch with observers at order 0, which run *before* Core
  Animation's commit and AppKit's display cycle (both `beforeWaiting` observers at higher orders). The sampler's
  observers are the first and the last, so its samples include the commit; `awakeMs` > `durationMs` is that tail.
- **`ab` against a build from before the sampler**: the new side pays the sampler and the old side doesn't. `ab`
  doesn't forward flags, but the environment reaches its children: `DESKBENCH_SAMPLER=off $B ab …` (or compare CPU).
- arm64 only (the bench's architecture); elsewhere the sampler is off.

## Why a body ran: causes

The desktop model reports each set of an observed property that drives a body (`Mutations.record("AgentSlice.focused",
id:)` in `DeskModel.swift`, from PerfLoopProbe; with no sink attached, as in the app, a nil check). The bench charges
the bodies SwiftUI evaluates to the mutations recorded since the previous update, and every step and long stretch gets
`causes[]`: each key path with how often it was set (`count`), on how many objects (`ids`), the bodies charged to the
updates it was part of (`bodies`) and how many distinct objects those were (`objects`). `explain` prints it under each
stretch and sums the steps:

```
     38.5 ms wall   37.8 ms cpu  during step#0 0→3  Column×34 CrewTab×4 OpenGroup×2 Reel×2
             causes: AgentSlice.focused×2 + AgentSlice.onScreen×2 + DeskModel.focusedAgent×1 + … (Column×34 (17 distinct), CrewTab×4 (2 distinct), OpenGroup×2, Reel×2)
```

`Column×34 (17 distinct)` after a tab click: every column's body ran (twice), in the update that followed the focus
change. Key paths set in the same update share its bodies and are printed as one group: the record says which
changes preceded the bodies, not which dependency edge invalidated which view (`@Observable` doesn't say). Bodies
after no recorded mutation (the environment, layout, a property without a record) show as `(unrecorded)`. A turn is
an update: one ends where a stretch closes, and mutations whose update SwiftUI defers to a later turn keep their
bodies. `perfloop causes <result.json>` prints the whole table (all reps, per step, the longest stretches); results
from before it have no causes. Add a record when you add an observed property that a body reads.

## Comparing two builds

Noise on this machine has swung identical builds between 26 and 709 hitches in 20 s. Single runs are meaningless;
alternate.

```sh
git worktree add /tmp/wt-base <base-commit>
(cd /tmp/wt-base/apps/menubar/app && swift build -c release --product CapcomdDeskBench)
swift build -c release --product CapcomdDeskBench
.build/release/CapcomdDeskBench ab --a /tmp/wt-base/apps/menubar/app/.build/release/CapcomdDeskBench \
  --b .build/release/CapcomdDeskBench step --reps 5
```

`ab` runs A, B, A, B … one process each, then compares medians, row by row, each row with a role:

- `[objective]`: the one number the verdict climbs on, lower is better. `--objective cpu` (main-thread CPU ms per
  step; the default), `instructions` (per step: the least noisy, use it when the CPU band is wide), `frames` (late
  frame time) or `latency` (the default for `open`, `switch`, `follow`). If the asked-for one is missing on a side
  (counters read zero, a pre-stamp bench), it falls back to CPU and a note says so.
- `[guard]`: late frame time and the longest stretch may not get worse beyond their band, whatever the objective.
- `[info]`: everything else (the other objectives, `lateFrames`, `frameP95Ms`, `stretchesOver16`), printed, never
  deciding: frame counts swing with the machine and the panel's rate.

A difference counts only outside a band of max(1.48 × MAD of either side, a floor: 5 % for CPU and instructions,
15–25 % for latency and frames, an absolute floor of a few ms). Exit 4 when the objective or a guard is worse;
`improvement` when the objective is better and no guard is worse. Same-source A/B (`--a X --b X`) is the way to see the
band on a given day. The result carries both binaries' `build` blocks.

To gate on a saved baseline instead: `run step --json --out base.json` on the good commit, later
`run step --baseline base.json` (exit 4 on regression) or `compare base.json new.json`; both take `--objective`.

## Runtime knobs: two variants in one binary

A knob (design/perf-loop CAPABILITIES.md C4) is a decision the window makes at one site, kept switchable so the bench
can measure it again without a rebuild. The window's knobs are in `CapcomdDesk/DeskKnobs.swift`; `describe` lists them:

| Knob | Values | Default (the window as it is) | What it switches |
|---|---|---|---|
| `reel.slide` | `ca`, `clip` | `ca` | `ca`: an animated move sets the scroll offset once and slides the document layer in the render server (`ReelView.slide`). `clip`: the clip view scrolls frame by frame (NSClipView's animator), as the reel did before, so every column's hosting view updates on each frame |
| `build.perFrame` | `1`…`8` | `1` | how many off-screen columns the reel builds per frame after a project opens (heads-first open), nearest first |
| `desk.layout` | `auto`, `frames`, `frames-hide` | `auto` | the reel's frame engine (LAYOUT.md): pixel-snapped column frames placed once per geometry change; `frames-hide` also hides far columns at rest |
| `desk.column` | `swiftui`, `native` | `swiftui` | a column as one hosting view of `Column`, or an AppKit column (layer frame and stroke) placing a head and a body hosting view |
| `reel.columns` | `keep`, `park`, `reuse` | `keep` | every built column in the scrolling document; only those near the screen (the rest parked, still and hidden); or a fixed set of native column slots configured in place as the reel moves |
| `reel.cache` | `off`, `bitmap` | `off` | the live columns slide, or cached bitmaps of them slide in an overlay and the reel moves under it at rest |
| `reel.release` | `land`, `appkit` | `land` | when a swipe's fingers lift, the reel ends AppKit's own deceleration (`ReelRelease`) and rests on the column it chose; `appkit` leaves it running, as before 2026-11-04 (it carried the reel off the column edge: see *Recorded gestures*) |

```sh
$B run step --knob reel.slide=clip                    # or --set knob:reel.slide=clip; several: --knob a=1,b=2
$B ab step --a-knobs reel.slide=ca --b-knobs reel.slide=clip --reps 5    # one binary (this one), two settings
$B ab switch --a-knobs build.perFrame=1 --b-knobs build.perFrame=4 --reps 5
$B ab step --a OTHER/CapcomdDeskBench --a-knobs reel.slide=clip --b-knobs reel.slide=clip   # --b defaults to --a
$B knobs --json                                       # what this process would run with (PERFLOOP_KNOBS + --knob)
```

The window reads knobs only from `PERFLOOP_KNOBS=name=value,name=value` (the app too: without it every knob reads its
default and the window runs the code it always ran). The bench puts `--knob` into its own environment before anything
reads a knob, and gives each `ab` side its setting there, on top of `--knob` and the inherited variable (`ab` never
forwards knobs as `--set`, so a side's setting is never overridden). A knob is read once, when the reel is made; there is
no per-frame lookup. A name the binary doesn't have, or a value outside a knob's choices or range, stops the command with
exit 1 before a window shows (`ab` checks each side's setting first when the side is this binary).

Every result has `knobs`: the full vector the run used, defaults included (`{"build.perFrame": "1", "reel.slide":
"ca"}`); `ab` has `knobsA` and `knobsB`. Two results compare like for like only when their vectors agree or the
difference is the experiment. A knob is for an experiment: once the loop promotes a setting, the setting becomes the
code and the knob is deleted (SPEC §7.6), so knobs don't pile up.

## The manifest: `describe`

`describe --json` prints `perfloop.manifest/1` (design/perf-loop SCHEMAS.md §2), everything a generic runner needs
without importing the app: `build` (this binary's stamp), `protocol` (1: `run <scenario> --json` prints a result on
stdout, `--wait-for FILE` holds the window until FILE exists and writes FILE.done after the reps, knobs come in
`PERFLOOP_KNOBS`), `scenarios[]` (`name`, `kind`, `budget`, `rule`, `latencyBudgetMs`, `params` with defaults,
`objective` that `ab` decides on, `guards` (the correctness guards that gate acceptance, with `guardParams`), `frameGuards`
that may not get worse, `checks` the driver records, `host` when it is fixed), `isolationGuards` (scenarios whose checks
run on every promotion),
`suite`, `fixtures`, `defaultFixture`, `knobs[]` (`name`, `type`, `default`, `choices` or `range`, numbers for numeric
knobs), `objectives`, `hosts`, `defaultHost`, `probes` (the view bodies counted) and `exitCodes`. Without `--json` it
is the same as text. `describe` and `knobs` run headless (no NSApplication, no window).

## Correctness guards

A blank column is fast. The guards (design/perf-loop CAPABILITIES.md C6) make "fast because wrong" lose; perfloop
reads which ones gate a scenario from the champion's manifest (`guards`, `guardParams`) and asks both sides of every
pair for them. By hand: `run <scenario> --guards built-within,snapshot-diff --artifacts DIR` (`--guard-param k=v`;
perfloop sets `PERFLOOP_GUARDS`, `PERFLOOP_GUARD_PARAMS`, `PERFLOOP_ARTIFACTS`). They run after each rep, outside its
measured steps (a run without `--guards` times exactly as before), and land in `reps[].guards[]` (`name`, `pass`,
`detail`, `artifacts`, `value`, `limit`, `review`), `summary.guardsFailed`, and `ab`'s `guardsA`/`guardsB`.

- **Settle** is the window at rest after the last step: the main thread quiet (no stretch over 4 ms of CPU) for 300 ms,
  never before the step's own settle point. Not the frame the step measured: a switched-to project shows its heads
  first and warms its threads after, nearest first, which took 2.2–3.3 s on crew17.
- **`built-within`** (all scenarios): every column at least half in view has had its `Column`, `ColumnHead`,
  `ColumnThread` and (when the fixture gives the agent a thread) one `EntryRow` body since its project opened (a switch,
  a fresh window), the last of them at most `built-within.ms` (300) after settle; it is warm; its view in the reel is a
  hosting view with something in it (or an AppKit column holding one, `desk.column=native`), not the reel's blank
  placeholder and not hidden. The reel says which view shows each column (`ReelColumnViews`: with reused slots the
  document holds fewer views than columns); an older reel is read by position. `value` is how long after settle the last column
  was built (negative: before).
- **`snapshot-diff`** (`open`, `switch`, `step`, `jump`, `fling`, `swipe`, `follow`, `resize`; not `burst` or `typing`): after
  settle the run writes `<scenario>-rep<i>.settled.png`, `.layout.json` (where the columns and their threads are, in
  pixels) and `.later.png` 1.1 s later. `snapdiff A.png B.png [--diff-out D.png] [--json]` compares the champion's (A)
  with the candidate's (B), headless, in the champion's binary: pixel by pixel (a channel off by more than 16 of 255)
  outside what changed by itself between a side's two pictures (the system-drawn clocks tick every second; masked 56 pt
  to the left, the clock's width) and outside the threads' viewports; the share of differing pixels against
  `snapshot-diff.tolerance` (0.5 %), per column against `columnTolerance` (2 %) and its ink box (what is drawn in it)
  against `bboxPt` (4 pt); each thread by how much of its viewport is drawn, at least `threadInkMin` (20 %) of the
  champion's. Threads aren't compared pixel by pixel because the same build rests them at different scroll offsets
  after a switch. Exit 3 over tolerance; perfloop then sends the experiment to the owner (`needsReview`) and keeps both
  PNGs and the diff in `exp/<id>/<stage>/p<n>/`.

Same build against itself (2026-10-31, crew17, two binaries of one source): 0 differing pixels outside the threads on
`switch` and `step` in every pair, within and across processes; threads drawn 31 % or more of each other's (once in a
while a thread rests after a switch with most of its viewport still empty: 3.7 % drawn vs 11.6 %). A build that leaves
the columns blank after a switch (the reel's placeholders) won `switch` by 31 % (8 + 8, p = 0.003) and lost on
`built-within` in every pair, with 1.75 % of the window and 3.4–4.4 % of each column differing and its threads 0 % drawn.

What they showed about the window as it is: after a switch the reel shows the first columns while the model's `onScreen`
is the asking agent's (the non-animated reel request is served before the new columns are in the reel), so the threads
in view warm last, 2–3 s after the frame `switch` measures.

## Profiling without reading XML

`profile <scenario> --template hitches|time|swiftui --out DIR` spawns the bench as a child, lets it show the window,
attaches `xctrace record` to its pid, waits for xctrace to say it is recording, then signals the child to run. When the
child's reps are done it stops the recording with SIGINT (xctrace saves, as on Ctrl-C), so the trace covers every
step; `--seconds S` is only a safety limit (default 600). Then it exports the tables and summarises them:

- `hitches`: count, total/max ms, hitches ≥ 16 ms, Instruments' "potential issue" per hitch, potential hangs.
- `time`: main-thread samples; ≥ 16 ms bursts and what ran inside them (our symbols and the SwiftUI/AppKit hot spots:
  `AG::Graph::propagate_dirty`, `_opaqueFullSizeContentViewRegionWithClipRect`, tracking areas, CoreText…); self top.
- `swiftui`: the cause and effect tables (`swiftui-updates`, `swiftui-causes`, `swiftui-update-groups`,
  `swiftui-changes`), as `swiftUI.rows` per table, `rootCauses[]` (each root cause with its updates by view and ms),
  `longUpdates[]`, the cause graph's `edges` and the `changes`. On this Mac (macOS 27.0.1, Instruments 27.1,
  Developer Mode off) every one of those tables has come out empty, attached or launched, with xctrace warning "Trace
  file had no SwiftUI data"; the result says so in `notes`, and the in-process causes are the record. Profiles from
  before it have `swiftUI` as a list of tables; it reads as `swiftUI.tables`.

The `.trace` stays in DIR for Instruments.app; the child's own in-process result is in the JSON under `inProcess`,
marked `"profiled": true`: a profiler's cost is in those numbers, so `compare` and `--baseline` refuse them (exit 6).
`run --wait-for` (attaching a profiler by hand) marks its result the same way.

**Traces are private.** A `.trace` can hold the recorded process's environment (tokens included) and your paths.
`profile` launches the child and xctrace with an allowlisted environment (`HOME`, `PATH`, `USER`, `TMPDIR`, locale,
`DESKBENCH_*` …) and prints a warning with the trace's path (louder when it is inside a git checkout). Never commit,
publish or attach a trace to an issue; keep `--out` outside the repo (`*.trace` is gitignored here as a backstop).
The bench emits `os_signpost` intervals (`dev.capcomd.deskbench`, points of interest, one interval named `step` per
scenario step with the step's name as its message), so steps line up on the Instruments timeline.

With a time profile, the JSON (`perfloop.profile/2`; `deskbench.profile/1` files still read) also carries the main
thread's **call tree**, root first, `{ "n": frame, "v": samples, "c": [callees, heaviest first] }` (`"o": true` on
frames from the bench's own binary; a run of frames that never branches is written once, the rest of it in `chain`):
`steps` (the `step` signpost intervals), `tree` (the whole recording), `treeInSteps` (samples inside steps only),
`treePerStep`, `msPerStep` (main-thread ms per step inside steps), `stepsCovered`/`stepsExpected`. The text prints the
heaviest subtrees per step as folded chains (`outer;next;…(k);inner`). Frame names lose their argument lists, but
Objective-C names keep category and selector (`-[NSApplication(NSEventRouting) sendEvent:]`).

## Comparing two builds' call trees: `diff`

```sh
$B diff base/step-time.trace new/step-time.trace           # or two profile JSONs, or one of each; --json for the data
$B trace --diff base/step-time.trace new/step-time.trace   # the same
```

Both sides are normalised to **ms per step** (samples inside the `step` signposts × the sample interval ÷ steps), so a
recording that covered 14 steps compares with one that covered 16; samples outside steps (settling, the hold) are left
out and counted in a note. `--per run` compares whole recordings instead. `.trace` files are exported on the fly (both
sides at once; about 6 s for two 25 MB step traces), a profile JSON is read as it is (an old one without a tree is
rebuilt from its `trace` if that still exists).

What it prints, in one screen:

- **grew in b** and **shrank in b**: the subtrees that moved most, each once. A subtree is a frame over all its call
  paths (`[3 paths]`); frames that moved together by about the same amount are one folded chain, outermost first; a
  smaller move inside a bigger one is listed under it (`↳`). A frame whose net change is the remainder of large opposite
  moves (the run loop, `main`) is never "the" answer, nor is a noise frame (`objc_msgSend`, retain/release).
  `attrib.` is the part of Δ that did not just move to another caller; a subtree whose change mostly moved (the same
  frame with the same callees grew elsewhere) is listed under **moved** instead.
- **largest in b**: the heaviest subtrees left in b, run-loop plumbing left out: what to attack next.
- **provenance**: the builds each side was recorded on, when the profile says (`build` in the JSON; traces carry none
  until the build stamp). `--champion BUILD` (a commit or `sha256:` hash) refuses, exit 6, when side a is not that
  build or can't be told (unstamped); `--allow-stale` compares anyway. Two OS builds refuse unless `--allow-cross-os`
  (symbol names change between them).

Options: `--top N` (default 8 a side), `--min-ms X` (smallest move reported; default 0.5 % of the larger side),
`--process NAME` (default `CapcomdDeskBench`). The JSON (`perfloop.diff/1`) has the merged tree (`a`, `b`, `d` in ms
per step per node), `gains` (b faster) and `losses` (b slower) with each item's `chain`, heaviest `path`, `paths`,
`under` (the nearest frame of ours above it), `inside`, `attributable`; `remaining`, `moved`, `provenance`, `notes`.

## Fidelity: what is real and what isn't

- **Real**: the views, model, store and thread renderer are the app's own (CapcomdDesk, CapcomdUI, CapcomdStore).
  Window chrome (transparent full-size title bar with the empty unified toolbar) is applied the same way. Tab clicks,
  Follow, project switches and keyboard moves are the model's own entry points, as the title bar calls them.
- **Scroll animations**: `step`, `jump` and `follow` use the model's `scroll(to:)` → `ScrollPosition.scrollTo` inside
  `withAnimation`, which is exactly what a tab click does.
- **Fling**: scroll-wheel `NSEvent`s built from `CGEvent`s with trackpad phases (began/changed/ended, then momentum
  began/changed/ended) are delivered straight to the reel's `NSScrollView.scrollWheel(with:)`. AppKit's gesture handling
  and the reel's snapping run; the WindowServer, hit-testing and the trackpad driver's momentum curve do not (the decay is
  the bench's: 4 % a frame from the release velocity). Its events carry timestamp 0, which hides AppKit's own
  deceleration after release (see *Recorded gestures*): `swipe` is the closer one. Good for "does scrolling by hand
  drop frames"; not for comparing deceleration feel.
- **Swipe**: a recording's events, at its times, each stamped with its recorded time, built as `fling`'s are and handed
  to the application for the reel's window (`NSApp.sendEvent`), so the reel's own routing (its local event monitor)
  decides where they go, as under a hand. Real are that routing, AppKit's gesture handling (its queueing of deltas to the
  next refresh, its own deceleration after release), the reel's snapping and the per-frame work. Not real: the
  WindowServer, the trackpad driver and anything else a hand's event stream carries beyond the recorded numbers; a
  recorded momentum curve is the recording machine's (what A/B wants, not "feel"). Where a hand's flick lands with the
  old reel varies from flick to flick (see *Recorded gestures*), so a replay can't be held to one landing.
- **Typing**: `NSEvent.keyEvent` pairs sent with `window.sendEvent` to the composer made first responder: the real
  field editor path, minus the input method.
- **Frames**: a `CADisplayLink` callback on the main run loop, not Core Animation's commit log. A late tick means the
  main thread was busy past the vsync, which is the failure mode that matters for SwiftUI scrolls; render-server-side
  hitches (rare here) only show in `profile`.
- **Data**: generated, not a daemon's. The thread route is `FixtureThread` (pages of 100, as the daemon serves them);
  live items are `agent.thread_item_changed` frames on the run's lifecycle feed, as the daemon sends them.
- **Open**: in one process the first rep is cold and the rest are warm windows; use `suite`/`ab` (fresh process per
  run) or `params.processLaunchToFirstFrameMs` for launch-to-frame.

## Recorded gestures: `swipe` and `record-gesture`

A real swipe, recorded once by a hand, replayed into the reel as often as the loop likes (design/perf-loop
CAPABILITIES.md C9). In-process only: the events go to the reel's `NSScrollView.scrollWheel(with:)` from a main-queue
timer at their recorded times; nothing is posted to the system.

**Record** (the owner, once per gesture; the window opens on `crew17` at its middle column):

```sh
cd apps/menubar/app && swift build -c release --product CapcomdDeskBench
.build/release/CapcomdDeskBench record-gesture --name flick-left           # swipe once with two fingers over the columns
.build/release/CapcomdDeskBench record-gesture --name drags --count 3 --timeout 90
```

It writes `${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/gestures/NAME.json` (`--out FILE`; more gestures: `NAME-2.json`,
…; never inside a git checkout unless `--allow-in-repo`), says where the reel came to rest after each gesture (it
should be a column edge), and exits 2 if nothing was recorded within `--timeout` (60 s). A dev build of the app records
too: `CAPCOMD_DESK_RECORD_GESTURE=~/g/flick.json` (DeskDebug; release builds with `-Xswiftc -DDESK_PROBE`). The file is
`perfloop.gesture/1` (design/perf-loop SCHEMAS.md §8): per event `t` (ms since the first), `dx`, `dy`
(`scrollingDeltaX/Y`), `phase`, `momentum`, `precise`, and nothing else. A gesture is the fingers touching → lifting →
the system's momentum ending (or 0.3 s after lifting with no momentum). Real recordings stay out of the repo; the
synthetic ones are in `Gestures/` (`gestures --write Gestures` regenerates them, a test checks they match):
`synthetic:flick-forward` and `flick-back` (`fling`'s curve: 6 frames to 2400 pt/s, momentum −4 %/frame) and
`drag-forward` (480 pt/s for 48 frames, no momentum). `gestures [FILE…]` lists them and checks files;
`perfloop gestures list` finds the recorded ones.

**Replay**: `run swipe --gesture FILE` (repeat `--gesture` for several, taken in turn; `--set swipes=N`, `from=I`
for the start column). Deltas go out in whole points (a CGEvent's point delta is an integer; the remainder is carried,
so the sum stays within half a point) with the recorded phases, at their recorded times. Each event's timestamp is
its recorded time (the replay's start plus `t`), as a trackpad's events carry the time the hardware saw them however
late the main thread takes them: AppKit reads the release velocity from them. The events go to the application for
the reel's window, at the middle of the reel, so the reel's local event monitor routes them as it routes a hand's
(`deliver=window`; it falls back to `view` where macOS can't place an event in a window, and the step's notes say
which route the events took). The `gesture` check fails when an event didn't go out as recorded; `snapped` when the
reel didn't rest on a column edge.

**Smoothness** (`reps[].steps[].smoothness`, the rep's in `reps[].smoothness`, medians in `summary.smoothness`; the
meter is PerfLoop's PerfLoopProbe `SmoothnessMeter`). A display link on the scroll view reads the document
layer's `presentation()` position every tick (a render-server slide counts); the expected position is the start plus
the finger deltas that could be on screen by then:

- `latencyFrames`: AppKit doesn't move the clip view inside `scrollWheel(with:)`; it queues the delta and applies it
  on the next refresh, so the reel shows the fingers' position one frame late (ce66497's reel, every gesture:
  1). The meter aligns by the whole number of frames (0–3) that fits best and reports it: latency, not error.
- `positionErrorP95Pt` (and `positionErrorMaxPt`): |shown − expected| while the fingers are down, p95. After they lift
  the reel snaps, so there's nothing to hold it to. A delta due but not delivered (the main thread busy) counts.
- `stalls`: frames while the fingers moved ≥ 1 pt and the content didn't (< 0.5 pt), plus every vsync the main thread
  missed meanwhile (the screen kept the old frame). `--set inject-block-ms=60` sleeps the main thread mid-gesture: the
  meter's self-check, the stalls go up by at least the frames it held (60 ms: 7 at 120 Hz; 2026-10-31: 27–30 on a
  drag that had 0 without it, and one 16 pt error).
- `jerkP95`: the shown position's third derivative, p95, from touch to settle, in pt/frame³ at the display's rate. It
  sees a frame that sticks or jumps and a hand-off at release that changes the acceleration at once.

Budget: the content within 1 pt (p95, median of reps) and no stall, on top of `fling`'s. In `compare`/`ab` (and
perfloop's full stage) `positionErrorP95Pt` (band 25 %, at least 0.5 pt) and `stalls` (at least 1 a rep) are guards:
both sit at 0 on a main thread that keeps up, and content that stops following the fingers is what a user sees at
once. `jerkP95` is information: it differentiates three times, swings with the display link's jitter, and its band
isn't known until real recordings give one.

`--set timestamps=zero` sends every event with timestamp 0, as `fling` does; `timestamps=delivery` stamps each with the
time it went out, as the replay did before 2026-11-04 (a late timer then hands two events over together and AppKit
reads a release velocity of the main thread's jitter: one flick read 820 to 7,000 pt/s across replays of one file).
`--set deliver=view` hands the events straight to the scroll view's `scrollWheel(with:)`, skipping the reel's routing,
as before 2026-11-04. `DESKBENCH_SWIPE_TRACE=FILE` appends every event (due, delivered, the clip view's offset before
and after) and tick (time, last commit, shown, clip offset) as JSON lines: what AppKit did with them.
`DESKBENCH_APPKIT_TRACE=1` (`swipe` and `record-gesture`) prints a line each time AppKit's private scrolling animator
begins a deceleration of its own (the velocity it read, where it means to stop) and each time one is stopped: under a
hand, it says whether AppKit decelerated after the fingers lifted.

What the first replays showed (2026-10-31, ce66497's reel, release, crew17, 3 reps × 4 swipes a gesture; `untrusted`:
the idle check saw most idle frames late, so absolute frame numbers are high; the comparisons ran back to back):

| | position error p95 (max) | latency | stalls a gesture | jerk p95 | CPU ms/step | late frame ms/s | rest off an edge |
|---|---|---|---|---|---|---|---|
| `flick-forward` | 0 pt (0) in 12/12 | 1 frame | 0–3 | 1.6–22 | 665 | 194 | 17–212 pt |
| `flick-back` | 0 pt (0) in 12/12 | 1 frame | 1–3 | 2.0–21 | 689 | 220 | 0.7–223 pt |
| `drag-forward` | 0 pt (3) in 12/12 | 1 frame | 0–4 or 24–27 | 1.3–28 | 567 | 253 | 6–46 pt |
| `flick-forward`, `timestamps=zero` | 0 pt (0) in 12/12 | 1 frame | 1–3 | 0.9–1.4 | 322 | 89 | 0.2 pt |
| `fling` | – | – | – | – | 366 | 82 | (snapped) |

- The content follows the fingers exactly, a frame behind. The stalls are late frames while the fingers were down:
  on the drag, either a handful or a run of 24–27 (the main thread over a frame 29 times a rep, in AppKit's layout
  pass inside the commit): the reel's cost under a hand, what the loop can now climb on.
- The reel doesn't rest on a column edge after a swipe with real timestamps, even the slow drag with no momentum at
  all. The trace shows why: when the fingers lift the reel sets the offset to its target and slides, then NSScrollView
  runs its own deceleration from the release velocity it read in the events' timestamps (+127 pt over 0.5 s in one
  flick) and carries the reel past the edge. The reel swallows the system's momentum, not this. With timestamps 0
  (`fling`, `--set timestamps=zero`) it snaps. *Corrected 2026-11-04 (below):* the deceleration is real and was a bug
  under a hand too (flicks 204 and 126 pt off, slow drags 25–31 pt); how much the sizes here varied (up to 212 pt,
  different every replay) was the replay's, which stamped events with the time it sent them. Fixed: the reel now ends that deceleration.
- That deceleration is also the dear part: `swipe` costs about twice the main-thread CPU and 2–3× the late frame time
  of the same gesture with timestamps 0, or of `fling`. `fling` understates what a hand's swipe costs.
- A delta queued when the fingers lift can be dropped: the reel's slide starts from the offset AppKit has applied so
  far and overwrites the one still queued (20 pt in one replay).

What the owner's recordings showed (2026-11-04, MacBook Pro at 120 Hz, crew17, the machine in use: `untrusted`
throughout, so frame and CPU numbers are comparisons between runs taken in turn, never absolutes). Six gestures
recorded by hand with `record-gesture`: four quick flicks (two each way, released at 1,800–4,400 pt/s) and two slow
drags (360 and 920 pt/s over the last 80 ms, with ±111 pt of vertical travel). The hand's rests are what
`record-gesture` printed; each replay row is 3 replays (3 runs, the configurations taken in turn). These four flicks
happened to land; that evening, with `DESKBENCH_APPKIT_TRACE=1`, two more flicks by hand on the old reel
(`--knob reel.release=appkit`) stopped 204 and 126 pt off an edge and two slow drags 28 pt off, AppKit's deceleration
logged on every gesture; on the fixed reel, four by hand (two flicks, two drags) rested 0.0–0.2 pt off.

| rest off a column edge, pt | hand | replay before (delivery stamps, to the view) | replay now, old reel | replay now, reel fixed |
|---|---|---|---|---|
| `hand` (flick) | 0.0–0.5 | 184, 223, 184 | 29.3 ×3 | 0.2 ×3 |
| `hand-2` (flick) | 0.0–0.5 | 132, 113, 12 | 213.5, 213.3, 213.5 | 0.0, 0.2, 0.0 |
| `hand-3` (flick) | 0.0–0.5 | 188, 48, 169 | 58.0 ×3 | 0.2 ×3 |
| `hand-4` (flick) | 0.0–0.5 | 0.0, 104, 143 | 16.5 ×3 | 0.2 ×3 |
| `drag` | 25.3 | 30, 13, 41 | 25.5 ×3 | 0.0 ×3 |
| `drag-2` | 31.3 | 116, 107, 100 | 90.7 ×3 | 0.2 ×3 |
| `synthetic:flick-forward` (4 replays) | – | 150, 148, 45, 200 | 32.7–32.8 | 0.0–0.2 |
| `synthetic:flick-back` | – | 64, 69, 164, 199 | 32.2 ×4 | 0.0–0.2 |
| `synthetic:drag-forward` | – | 3.8–6.0 | 10.0 ×4 | 0.0–0.2 |

- **Why the reel missed.** When the fingers lift, AppKit's scrolling animator (private, `NSScrollingAnimator`) starts
  a deceleration of its own from the last event's velocity (`DESKBENCH_APPKIT_TRACE=1`: `beginMomentumWithVelocity` at
  the release), whatever the scroll view does with the system's momentum events, and when the reel's slide moves the
  clip view it starts again from there (a second call, aimed past the new offset). Swallowing the system's momentum
  doesn't stop it; a momentum-ended event does (`_stopAnimating`, and the live scroll ends:
  `NSScrollView.didEndLiveScrollNotification`, which `ReelReleaseTests` checks). That is the fix (`ReelRelease`,
  knob `reel.release`, `appkit` for the old reel): all six recordings and the three synthetic gestures now rest within
  0.2 pt, `snapped` passes in every rep.
- **Why the replay was unfaithful, part one: its timestamps.** It stamped each event with the time it sent it. On a
  busy main thread the timer hands events over in pairs, and AppKit's release velocity is then the jitter's: replays of
  `hand-2` read 820 to 7,000 pt/s, so every replay rested somewhere else. Stamped with their recorded times, the
  replays are the same every time (the third column), and AppKit reads the velocity the hand's events give
  (2,250–4,380 pt/s for the flicks, 250 and 1,850 for the drags).
- **Part two: the path.** The events now go to the application for the window, so the reel's local monitor routes
  them as it routes a hand's. That changed no rest offset: replays sent to the view, to the application, and posted to
  the bench's own process (so they come through its event queue like a hand's) all decelerated the same way, as did
  ones with the app made to report itself active and the pointer over the reel.
- **Still not reproduced: the flicks' landing under the old reel.** The hand's four flicks rested on an edge; their
  replays rest 16–214 pt off, because AppKit decelerates after them. The `drag` replay matches the hand (25.5 against
  25.3 pt), `drag-2` doesn't (90.7 against 31.3). AppKit's animator reads only the event's type, phases, deltas,
  precision and timestamp (traced with lldb), all of which the replay sends as recorded, so whatever kept it from
  decelerating after the hand's flicks is outside what a recording holds (another kind of event a trackpad sends, or
  something the window server marks). Not found yet. `record-gesture --knob reel.release=appkit` with
  `DESKBENCH_APPKIT_TRACE=1` under a hand says whether AppKit decelerated there. With the fix both end the same way,
  so this gap no longer changes where the reel rests.
- **Following the fingers** is unchanged by the fix: position error p95 0 pt in 21 of 24 flick replays now (8, 9
  and 32 pt in three, one with the fix and two without), 6–8 pt on `drag` and 15–20 pt on `drag-2` with either reel
  (the drags move vertically too), latency 1 frame (3 on `drag-2`) with either. The fix makes a flick much cheaper:
  AppKit's deceleration scrolled the clip view every frame for 0.8 s, and a flick's replay cost 630–900 ms of
  main-thread CPU with it, 150–300 ms without. `stalls` on the two recorded drags read 80–98 with the fix and 7–22
  without in the runs above, but 71–77 without (`drag`) in two later runs: it counts a missed vsync against the median tick
  interval of the whole replay, which AppKit's slow frames after the release raised to 19–20 ms in some runs and the
  fix brings to 8.5 ms. While the fingers were down the replays drew as many frames with the fix as without (46–66
  ticks against 27–58). Compare `stalls` only between replays whose frames after the release are alike.
- **`record-gesture --count N` wrote N+1** when a swipe came while it waited to see where the last one came to rest
  (`hand-3` and `hand-4` were written in the same second): it now stops recording as soon as N are written. It also
  waits until the clip view stops moving before it says where the reel came to rest.

## A worked example

"Scrolling stutters on long jumps" (the bug the reel had before 3a6b5b7):

```sh
$B run jump --reps 5 --json --out /tmp/jump.json; $B explain /tmp/jump.json
```

```
jump on crew17: FAIL …
  ✗ late frames: median 31.0 per rep (max 38.0); frame p99 41.2 ms
  ✗ main-thread stretches over 16.7 ms: median 9.0 per rep (longest 88.4 ms)
longest main-thread stretches:
     88.4 ms  during jump#2→16  Column×14 ColumnThread×14 EntryRow×612 ColumnHead×14
likely causes:
  • Column bodies ran while the reel moved (…): columns are being rebuilt mid-scroll. A lazy stack, …
```

`Column×14 … EntryRow×612` inside one stretch during a jump says fourteen columns were constructed on the way past;
the suggestion names the lazy stack. Fix it, rebuild, `run jump --baseline /tmp/jump.json` (or `ab` against the old
build) and the comparison lines say whether the medians moved beyond noise. Then `profile jump --template time` if a
stretch has no bodies in it (then it is layout, text or AppKit, and the burst frames name it).

## What the bench found (2026-10-30, 3a6b5b7's reel, release, crew17, a loaded machine)

Numbers from a Mac with a load average of 10–20 on 8 cores (CPU share of the main thread 97–99 %, so the work is
ours, but every run was `UNTRUSTED` by the noise rule; re-measure on a quiet machine before quoting them as truth):

- `open`: cold window 266 ms to the first commit, 306 ms on screen (budget 100). A warm window with 17 warm columns
  takes ~1.0 s: a column's thread costs ~55 ms to build (EntryRow × ~100).
- `switch`: 340–880 ms to the frame showing the other project (budget 50): every warm column of the target run is
  rebuilt synchronously (EntryRow × 100–260 in one stretch). Headers first and threads after would meet the budget.
- `step`/`jump`: with the hand-made window the display runs at 120 Hz and ~60 % of frames are late during a step; the
  main thread is 100 % busy for the whole 0.63 s animation (frame p50 17 ms). `profile --template time` puts it in
  `HostingScrollView.scrollViewDidScroll → ScrollViewHelper.updateGraphState` (~20 %), `NSHostingView.layout` (~30 %),
  and `NSThemeFrame _opaqueFullSizeContentViewRegionWithClipRect → NSHostingView.acceptsFirstResponder →
  FocusNavigator.firstNavigableItem` (~19 %: AppKit asks the hosting view whether it accepts first responder every
  display cycle, and SwiftUI answers by walking the whole focus sequence, i.e. every composer). A jump re-evaluates
  all 16 `CrewTab`s once per column crossed (200+ bodies, ~200 ms in one stretch): the bracket's `onScreen` set.
- Under the SwiftUI `Window` scene host every changed body is evaluated **twice** per update (Column 34 per step, not
  17) and a step runs at ~24 Hz instead of 120; `.commands` and the hosting view's sizing options are not the cause.
  The app uses the same scene; confirming this on the app itself is the first follow-up. **Corrected 2026-10-31:**
  the bench's own doing. Its command started before SwiftUI had made the scene's window, so it made a hand-made
  window in front of it, and every scene-hosted run measured two windows on one model. The harness now waits for the
  scene's window (`sceneWindowReady`); bodies are counted once, and every scene-hosted number from before is about
  twice what one window costs (step on crew17: ~180 → ~120 ms of main-thread CPU at that commit).
- `burst`: isolation holds (no other column, no title bar body), but one arriving item costs ~60 ms of main thread
  (ColumnThread + 2 EntryRow bodies, then layout).
- `typing`: isolation holds (only `ColumnComposer` bodies), but a keystroke costs 20–75 ms of main thread.
- `follow`: the reel starts moving 50–160 ms after the ask (the ask is a `.all` refresh) and lands correctly.
- The planted regression (LazyHStack, no `.geometryGroup()`): `ab` reports late frames 6 → 95 (+1483 %) and the
  longest stretch 232 → 542 ms, exit 4; `explain` on the lazy build shows `EntryRow×116 Column×34 ColumnThread×10`
  inside 580 ms stretches during jumps and names the lazy stack.

## After the AppKit reel (2026-10-30, load 2–6)

The reel became an AppKit scroll view with a hosting view per column, and slides run as a Core Animation animation of
the document layer (Reel.swift). `ab` against the SwiftUI reel, 5 reps a side, `--host scene`, crew17:

| scenario | late frames | frame p95 | longest stretch | latency |
| --- | --- | --- | --- | --- |
| step | 145 → 19 | 27.9 → 12.5 ms | 174 → 117 ms | |
| jump | 30 → 12 | 35.6 → 16.7 ms | 165 → 73 ms | |
| fling | 40 → 42 (same) | 10.3 → 10.9 ms (same) | 155 → 49 ms | |
| switch | | | 905 → 491 ms | 493 → 215 ms |

What is left: a click still costs one 50–70 ms update before the slide starts (every column's hosting view takes its
new place once, and the title bar follows); a swipe still updates every column's hosting view per event while the
fingers move; `switch` builds the target run's columns synchronously. The per-frame focus walk listed above was
already gone once the reel left the title bar's band (3a6b5b7); it no longer shows in profiles.

## Sweeps and real fixtures

**Parametric fixtures.** Any generated fixture takes parameters in its name: `--fixture crew17@agents=40` (40 agents
in the open project), `crew@agents=24,items=100` (`items=100` is 80–120 items a thread; `items=40-60` an exact
range), plus `projects`, `asks` and `seed`. Parameters keep the base name's seed, so `crew17@agents=17` is `crew17`
byte for byte and the points of a sweep differ only where the parameters do. `crew` is the family the sweeps vary
(crew17's shape). `describe` lists each fixture's `parametric` ranges; `fixture NAME@…` shows what a name builds.

**Cost curves.** `perfloop sweep` ([PerfLoop](https://github.com/MarvinAmador7/perfloop)) runs a grid and fits curves through the objective:

```sh
perfloop sweep step --bench $B --set agents=4..64/12 --reps 2 --dry-run      # the grid, the commands, an estimate
perfloop sweep step --bench $B --set agents=4..64/12 --reps 2 --lock /tmp/window.lock
perfloop sweep step --bench $B --fixture crew --set agents=4..64/4 --set items=50..400/50 --reps 3 --budget-min 60
perfloop sweep step --bench $B --set reel.slide=ca,clip --set agents=8,32,64   # a knob against the size
perfloop explain ~/.perfloop/capcomd-desktop/sweeps/<dir>/sweep.json          # the table and the fits again
```

A `--set` is a knob if the manifest has one by that name, a fixture parameter if the fixture's `parametric` has it,
else a scenario param (`knob:`, `fixture:`, `param:` force one). One value is fixed, several are an axis. Points run in
a fixed shuffled order (drift spreads over the curve instead of tilting it), one `run --reps N` child each, and each is
written as it lands: the same command resumes, `--redo agents=28` measures one again. The result is
`perfloop.sweep/1` (design/perf-loop/SCHEMAS.md §7): per point the objective's median and spread, late frame time,
the checks, and whether the machine was busy; a line (and, with ≥ 4 x values, a quadratic) per axis per slice of the
others, a plane through every numeric axis. The text says it plainly: `ms/step grows 0.9 ms per agent (r² 0.98)`.
Every point opens the window: `--lock DIR` holds a mkdir lock for each point so window runs on one Mac take turns.

The first curve (2026-10-31, dbdb80c, release, 2 reps a point, a busy machine at 5 of 6 points): `step` on
`crew17@agents=N` cost 28 ms of main-thread CPU a step at 4 agents, 99 at 16, 230 at 28, then ~310 flat from 40 to
64: "ms/step grows 4.98 ms per agent (r² 0.84)", and the quadratic (r² 0.97) says it bends. The plateau starts past
the warm cap (32), which is consistent with every warm column paying on every step. A 2-D grid on `crew` gave
"ms/step ≈ 55.5 + 6.72 ms per agent + 0.036 ms per item (r² 0.98)": agents matter, thread length barely does.
Measure again on a quiet machine before quoting the numbers.

**Real fixtures.** `fixture capture` reads runs from a daemon the way the app does (`GET /v1/events?scope=<run>`,
`/v1/runs/<run>/agents`, every agent's `/thread` pages; never attachment bytes) and writes a `deskbench.fixture/1`:

```sh
capcomd clients add deskbench-capture --scopes read          # prints a token once: put it in a 0600 file
$B fixture capture --from ~/.capcomd/harness.sock --run run-… --token-file ~/.perfloop/capture-token --name crew-real
$B run step --fixture file:crew-real --reps 5                 # a bare name is ~/.perfloop/capcomd-desktop/fixtures/NAME.json
```

Anonymised by default (`Sources/DeskBenchKit/Anonymise.swift`): every string is replaced by generated text of the
same length and shape (words of the same lengths, digits for digits; whitespace, punctuation and markdown markers
kept, so headings, lists, code, tables and diffs lay out as before); ids are hashed with a random per-capture salt
(prefixes kept, consistent across events, items and links); URLs become `https://example.com/…` of the same length
and hosts `example.com`; times move so the earliest is 2026-01-01 (intervals and durations kept); kinds, statuses,
block types, common tool names, models and numbers are kept. Unknown fields are replaced as text. Attachments keep
their kind, mime and size; the bench draws a placeholder. The file is written 0600 and never inside a git checkout
(`--allow-in-repo` overrides); it goes to `${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/fixtures/` unless `--out`
says otherwise. `--raw` keeps the real text, for a file that never leaves the Mac. The token is `--token-file`,
`$CAPCOMD_TOKEN`, or `--keychain` (the capcomd app's own). On load the times move again so the newest is a minute
ago, and the threads are served from the captured items' own bytes.

## Adding to the bench

- A scenario: a `ScenarioSpec` in `DeskBenchKit/Scenarios.swift` (name, budget, rule, kind, params) and a driver in
  `CapcomdDeskBench/Drive.swift` returning `([StepResult], [Check])`; add its name to `Scenarios.suite`.
- A fixture: a `FixtureSpec` in `Fixtures.swift`; the generator takes care of the rest.
- A knob: a `static let` `Knob(…)` in `CapcomdDesk/DeskKnobs.swift`, added to `DeskKnobs.knobs`, read once into a
  stored property where it is used (never a lookup per frame), with the default reproducing today's behaviour.
- A view worth counting: `DeskProbe.body("Name")` (or `body("Name", id: agentId)` for per-agent views) as the first
  statement of its `body`.
- Tests: `swift test --filter DeskBenchKitTests` (fixtures, statistics, budgets, xctrace parsing, call trees and
  `diff`, the manifest, the knobs' defaults: no window needed; the knob library's own tests: `swift test` in a checkout of [PerfLoop](https://github.com/MarvinAmador7/perfloop); the exports in `Tests/DeskBenchKitTests/Fixtures` are hand-made. Never commit a real
  export or `.trace`: a trace records the profiled process's environment, tokens included).

The views only ever see `DeskProbe`, a nil-checked static, and `DeskKnobs` (PerfLoop's `PerfLoopProbe`,
Foundation only, values stored once); nothing else from the bench is linked into the app.
