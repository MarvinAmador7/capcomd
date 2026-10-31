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
$B run step --fixture crew17 --reps 5                   # one scenario, text verdict (add --json for the result)
$B suite --reps 3 --out /tmp/bench                      # everything, one line each; JSON per scenario in /tmp/bench
$B snapshot --out /tmp/snap                             # window.png + window.json (view tree, scroll geometry, model)
$B profile step --template hitches --out /tmp/prof      # the same run under Instruments, summarised
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
| Does a thread item re-render only its column? | `run burst` | `checks` named `isolation-*`; `reps[].steps[].notes` has the counts |
| Does typing stay inside the composer? | `run typing` | `checks` `isolation`; which views leaked is in the detail |
| Does Follow go to the ask, and how fast? | `run follow` | `latencyMs` (ask → reel starts), `settleMs`, check `landed` |
| What does the window look like / why does it scroll vertically? | `snapshot` | `window.png`; `window.json → scrollViews` (doc vs clip size, insets, safe area) |
| Which views re-rendered when X happened? | any `run`, look at `reps[].steps[].bodies` and `worstStretches[].bodies` | per view type; `Column`, `EntryRow` etc. carry the agent id internally for the isolation checks |
| What ran inside a long stretch (stacks)? | `profile <scenario> --template time` | `timeProfile.burstFrames` (what the ≥16 ms bursts were doing), `inclusiveOurs` |
| What did the compositor count as hitches? | `profile <scenario> --template hitches` | `hitches.hitches`, `causes`, `potentialHangsMs` |
| Did commit B regress commit A? | build both, `ab --a A/CapcomdDeskBench --b B/CapcomdDeskBench step --reps 5` | the `[objective]` and `[guard]` lines; exit 4 on a regression beyond noise |
| Gate in a script | `run … --baseline saved.json` or `compare a.json b.json` | exit code |

Exit codes: `0` pass · `1` usage · `2` harness error · `3` budget failed · `4` regression beyond noise · `5` untrusted
(the budget failed **and** the machine was noisy: the run says nothing about the reel; run it again when quiet) ·
`6` refused (a profiled result was given to `compare` or `--baseline`).

Two hosts (`--host`): `scene` (default) runs the bench as a SwiftUI app whose `Window` scene shows the fixture — the
app's own NSWindow subclass, hosting view and toolbar handling, so what the app pays, the bench pays; `window` makes an
NSWindow by hand with the same content view and chrome (what `open` always uses: it needs a fresh window per rep).
The result's `params.host` says which. The two differ (see *What the bench found*), so compare like with like.

`trace <file.trace>` summarises a trace you already have (one recorded by hand, or from an earlier session) the same
way `profile` does.

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

longest main-thread stretches (what SwiftUI evaluated inside each):
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
- **stretches**: the longest awakenings, with the bodies evaluated inside each. A long stretch with no bodies is
  AppKit layout, text, or the fixture: use `profile --template time`.
- **noise** and **window**: the idle floor measured before the scenario, the load average, thermal state, busy
  processes, and whether the window was active, key and unoccluded. SwiftUI flushes timer-driven state changes
  late (seconds) when the app is in the background, so the bench activates itself; `window.trustworthy` in the JSON
  says whether that held. **One run proves nothing on a shared machine**; use `--reps 5` and medians, or `ab`.

JSON: `BenchResult` in `Results.swift`. The useful paths: `.verdict`, `.exitCode`, `.budget.reasons[]`,
`.summary.{objective,mainThreadCpuMsPerStep,instructionsPerStep,hitchTimeRatioMsPerS,latencyMs,longestStretchMs,bodies}`
(and the frame counts `lateFrames`, `frameP95Ms`), `.reps[].steps[]` (per step: `latencyMs`, `settleMs`, `cpuMs`,
`instructions`, `frames` with `hitchTimeRatioMsPerS`, `mainThread`, `bodies`, `notes`), `.reps[].checks[]`,
`.reps[].worstStretches[]`, `.noise`, `.window`, `.machine`, `.tool.build`, `.profiled`, `.comparison[]` (each row
with its `role`). Fields are only ever added: older results still decode, with the new ones absent.

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

## Profiling without reading XML

`profile <scenario> --template hitches|time|swiftui --out DIR` spawns the bench as a child, lets it show the window,
attaches `xctrace record` to its pid, waits for xctrace to say it is recording, then signals the child to run. When the
child's reps are done it stops the recording with SIGINT (xctrace saves, as on Ctrl-C), so the trace covers every
step; `--seconds S` is only a safety limit (default 600). Then it exports the tables and summarises them:

- `hitches`: count, total/max ms, hitches ≥ 16 ms, Instruments' "potential issue" per hitch, potential hangs.
- `time`: main-thread samples; ≥ 16 ms bursts and what ran inside them (our symbols and the SwiftUI/AppKit hot spots:
  `AG::Graph::propagate_dirty`, `_opaqueFullSizeContentViewRegionWithClipRect`, tracking areas, CoreText…); self top.
- `swiftui`: whatever view tables the installed Instruments exports (they vary by Xcode version; the result lists the
  schemas it saw if it recognised none).

The `.trace` stays in DIR for Instruments.app; the child's own in-process result is in the JSON under `inProcess`,
marked `"profiled": true`: a profiler's cost is in those numbers, so `compare` and `--baseline` refuse them (exit 6).
`run --wait-for` (attaching a profiler by hand) marks its result the same way.

**Traces are private.** A `.trace` can hold the recorded process's environment (tokens included) and your paths.
`profile` launches the child and xctrace with an allowlisted environment (`HOME`, `PATH`, `USER`, `TMPDIR`, locale,
`DESKBENCH_*` …) and prints a warning with the trace's path (louder when it is inside a git checkout). Never commit,
publish or attach a trace to an issue; keep `--out` outside the repo (`*.trace` is gitignored here as a backstop).
The bench emits `os_signpost` intervals (`dev.capcomd.deskbench`, points of interest, one interval named `step` per
scenario step with the step's name as its message), so steps line up on the Instruments timeline.

## Fidelity: what is real and what isn't

- **Real**: the views, model, store and thread renderer are the app's own (CapcomdDesk, CapcomdUI, CapcomdStore).
  Window chrome (transparent full-size title bar with the empty unified toolbar) is applied the same way. Tab clicks,
  Follow, project switches and keyboard moves are the model's own entry points, as the title bar calls them.
- **Scroll animations**: `step`, `jump` and `follow` use the model's `scroll(to:)` → `ScrollPosition.scrollTo` inside
  `withAnimation`, which is exactly what a tab click does.
- **Fling**: scroll-wheel `NSEvent`s built from `CGEvent`s with trackpad phases (began/changed/ended, then momentum
  began/changed/ended) are delivered straight to the reel's `NSScrollView.scrollWheel(with:)`. AppKit's gesture handling
  and the reel's snapping run; the WindowServer, hit-testing and the trackpad driver's momentum curve do not (the decay is
  the bench's: 4 % a frame from the release velocity). Good for "does scrolling by hand drop frames"; not for comparing
  deceleration feel.
- **Typing**: `NSEvent.keyEvent` pairs sent with `window.sendEvent` to the composer made first responder: the real
  field editor path, minus the input method.
- **Frames**: a `CADisplayLink` callback on the main run loop, not Core Animation's commit log. A late tick means the
  main thread was busy past the vsync, which is the failure mode that matters for SwiftUI scrolls; render-server-side
  hitches (rare here) only show in `profile`.
- **Data**: generated, not a daemon's. The thread route is `FixtureThread` (pages of 100, as the daemon serves them);
  live items are `agent.thread_item_changed` frames on the run's lifecycle feed, as the daemon sends them.
- **Open**: in one process the first rep is cold and the rest are warm windows; use `suite`/`ab` (fresh process per
  run) or `params.processLaunchToFirstFrameMs` for launch-to-frame.

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
  The app uses the same scene; confirming this on the app itself is the first follow-up.
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

## Adding to the bench

- A scenario: a `ScenarioSpec` in `DeskBenchKit/Scenarios.swift` (name, budget, rule, kind, params) and a driver in
  `CapcomdDeskBench/Drive.swift` returning `([StepResult], [Check])`; add its name to `Scenarios.suite`.
- A fixture: a `FixtureSpec` in `Fixtures.swift`; the generator takes care of the rest.
- A view worth counting: `DeskProbe.body("Name")` (or `body("Name", id: agentId)` for per-agent views) as the first
  statement of its `body`.
- Tests: `swift test --filter DeskBenchKitTests` (fixtures, statistics, budgets, xctrace parsing: no window needed).

The views only ever see `DeskProbe`, a nil-checked static; nothing else from the bench is linked into the app.
