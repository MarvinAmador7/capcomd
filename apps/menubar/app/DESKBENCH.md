# deskbench: the desktop window's bench, for coding agents

`CapcomdDeskBench` (`deskbench`) hosts the capcomd desktop window (the `CapcomdDesk` library: the same model, reel,
sidebar, panes and palette the app shows) **in its own process, on generated data, with instruments around it**, and
drives it the way a user would: tab clicks, project switches, swipes, typing, clicks and keys, a resize, an ask
arriving. It is a [PerfLoop](https://github.com/MarvinAmador7/perfloop) bench built on **PerfLoopHost**, PerfLoop's
in-app bench library: PerfLoopHost answers the runner's whole contract (its ADAPTER.md) and gives every scenario its
clock, steps, checks, the ink guard, real input with focus records, region-by-region snapshots and the profiler.
deskbench says what to measure (the scenarios, fixtures, knobs, guards) and how to drive the window. The bench is a
SwiftUI app as the desktop app is (`BenchApp.swift`): a `Window` scene in the app's style with the app's own commands,
so shortcuts go through the real menu bar. Everything is in-process: no daemon, no screen-recording permission, no
synthetic input to the system.

You are its user, through `perfloop` (`perfloop run`, `baseline`, `exp`): a bench run by hand skips the gates, the
window lock and the ledger (PerfLoop's AGENTS.md). Its own verbs are for looking:

```sh
cd apps/menubar/app
swift build -c release --product CapcomdDeskBench      # ~3 min the first time; always bench a release build
B=.build/release/CapcomdDeskBench
$B list                                                 # this build's stamp, the scenarios, the fixtures
$B describe                                             # the perfloop.manifest/1 the runner reads (JSON)
perfloop run $B --scenario step --reps 5                # numbers, checks, guards, where the time went (opens windows)
$B fixture crew17                                       # what a fixture builds (headless)
$B help                                                 # every verb: PerfLoopHost's and deskbench's own
```

Debug builds are 5–20× slower in SwiftUI's own code: the result's `tool.build.configuration` says `debug`; don't quote
those numbers. Every result says which binary made it (`tool.build`, `perfloop.build/1`): the commit, whether the
package's sources had uncommitted changes, a hash of them, the build time and the executable's own `hash`, compiled in
by PerfLoop's `PerfLoopStamp` plugin, so a copied binary run from anywhere still reports its own commit.

## What comes from PerfLoopHost, what is deskbench's

| | PerfLoopHost (perfloop 305bd63) | deskbench |
|---|---|---|
| The contract | `list`, `describe`, `run`, `snapdiff`, `knobs`, `profile`, `diff`, `gestures`, `record-gesture`, the window lock, exit codes | `describe` adds `appearances: ["dark"]` (`DeskBenchKit/BenchCatalog.swift`); `main.swift` answers the windowless verbs, `run` and `record-gesture` start the app |
| The app | `bench.attach()` from a SwiftUI `App`'s `init` (the verb starts once the app has launched), `run.appWindow()`, `run.show(window:)`, `host: app` | `BenchApp.swift`: a `Window` scene in the app's style with `DeskCommands`; each rep's desk shown in it (`DeskStage`), the commands acting on that desk's model |
| A rep | the window (adopted, or `run.open`'s own), the stretch clock, the main-thread sampler, frames, bodies and their causes per step, the trust fields (`window`, quiet, frames), `perfloop.result/2` | a fresh desk per rep (`Desk.swift`): the fixture loaded into a store, the app's `DeskModel` and `DeskWindowContent`, the probe forwarded to PerfLoop's |
| Steps | `run.step(name, until:, ink:)` (an async action is the step's: a burst at a rate), `run.wait`, `run.settle`, `run.check`, `run.ink` (off the clock) | the drivers (`Drive*.swift`, `NeedsDrive.swift`): what a user does, what each check reads |
| Input | `run.press` through the menu bar (the item that fired), `run.type`, `run.key`, `run.click` on the app's own queue, each step's input and focus record, `--pictures` | which keys and clicks each scenario sends |
| Gestures | `run.swipe` (replay, smoothness meter; `delivery: .window`), the synthetic gestures, `record-gesture SCENARIO` | `fling`, `swipe`, `needs-swipe` (through the window), `sidebar-scroll`; `Gestures/` (the synthetic ones as files); `DESKBENCH_APPKIT_TRACE` |
| Guards | `checks` (per trusted rep: `flaky N/M` fails), `ink` (built in; a region drawn alone), `snapshot-diff` (regions, compared by ink where asked, child windows, the look) | `built-within` (`Guards.swift`), each scenario's ink regions |
| Fixtures | listed names, `NAME@k=v` within their `parametric` ranges, the schemes and values a bench registers (`bench.fixtureScheme`, `bench.fixtureValues`) | the generator (`Fixtures.swift`), `items=LO-HI`, captured fixtures (`fixture capture`, `--fixture file:PATH`) |

### What PerfLoopHost can't see (yet)

- **Materials.** Snapshots and ink crops draw views with `cacheDisplay`: vibrancy and blur draw flat. The Search ⌘K
  overlay is its own hosting view (`SearchOverlayHost`) judged drawn alone, so its ink is its own text and rows, not the
  reel behind it; its glass and shadow don't show in the crop.

## Scenarios and their budgets

`list` prints each with its budget; `describe` has its objective, guards, frame guards, params and fixture. Each maps
to a design/desktop/SPEC.md §1 row. `kind: latency` climbs on `latencyMs` (the action to the first frame after what
it waits for held), the others on `mainThreadCpuMsPerStep`; `hitchTimeRatioMsPerS` and `longestStretchMs` are frame
guards everywhere (`swipe` adds `positionErrorP95Pt` and `stalls`). A latency scenario with `latencyBudgetMs` fails
its run when the median is over it; the frame budgets are information.

- `open`: a window opening on a filled store (`run.open`: the clock starts before the window exists, so the content, the
  window, its first layout and frames are in the number) → the first frame with the reel. Budget 100 ms. The window is
  its own; the scene's (empty) is ordered out first.
- `switch`: `model.open(project:)` between the two largest projects → the frame after the new columns are in. 50 ms.
- `step` / `jump`: animated scrolls as a crew-tab click does (one screen at a time; first ↔ last). No late frame while
  the reel moves.
- `fling`: `fling`'s synthetic swipe (6 frames to `velocity` pt/s, momentum −4 %/frame), every event stamped 0, by
  PerfLoopHost's replay into the reel's scroll view; checks the reel rested on a column edge.
- `swipe`: a gesture (`--set gesture=FILE` or `synthetic:NAME`, several comma-separated, taken in turn; `--gesture FILE`
  is the same) replayed at its recorded times, `swipes` (4) times from the middle column; `timestamps=zero` stamps
  every event 0. Budget as `fling` plus the content within 1 pt of the fingers (p95) with no stall.
- `burst`: thread items for one on-screen agent at N/s (20/s for 3 s), standing still and then while stepping: one
  step each. Passes when no other column's thread, no `Column`/`ColumnHead`/`CrewTab`/`TitleBar` body ran.
- `typing`: the text typed into an on-screen composer with real keys (`run.type`: the field editor gets them), the
  focus expected to stay there. Passes when only `ColumnComposer` bodies ran.
- `resize`: 1440 → 1100 → 720 → 1440 wide; the column count must follow (3 → 2 → 1 → 3).
- `follow`: a question for a far-off agent (its own, `custom`) arrives with Follow on; latency is the ask → the first
  frame after the reel started moving; check `landed`.
- `sidebar-toggle`: open and fold the sidebar as ⌃⌘S's item does (`animated=1`: as its button does). 50 ms. Checks
  `opened`, `pane-agent`, `folded`, `reel-untouched`; ink: the sidebar and the pane after each open, the reel after
  each fold.
- `sidebar-select`: with the sidebar open, rows clicked (`run.click` at the row, laid out from the fixed line heights)
  and walked with ↓ ↓ Return (`run.key`). 50 ms; checks `clicked`, `keyboard`; ink: the sidebar and the pane.
- `sidebar-burst`: thread items for the pane's agent and another at 20/s with the sidebar open: no sidebar body, no
  sidebar slice assignment (`isolation-sidebar`), the pane's thread rendered (`delivered-pane`).
- `sidebar-scroll`: a long sidebar (every project unfolded, Finished open) scrolled with the synthetic `scroll-down` /
  `scroll-up` (`gesture`, `gestureBack`) replayed into its scroll view. Checks `scrolled`, `isolation-pane`. Use a
  fixture with several projects (`--fixture crew@projects=8,agents=24`).
- `palette-open`, `palette-type`, `palette-keys`: Search ⌘K on the `search` fixture (their default: 60 projects, 250+
  items). ⌘K through the menu bar → the frame with the panel and its results (50 ms); a query typed a key at a time (`run.type`,
  each key → the frame with its results, one frame); ↓ ↓ ↑, ↩ opens the selection, ⌘↩ opens (folded, as ↩ does), Esc
  closes (`run.key`). Checks read the UI: the empty search's groups, the ranking, the selection, what opened; ink: the
  palette (its own hosting view in the window, drawn alone; its panel with `search.host=panel`).
- `palette-first`: the first ⌘K after the window opens, once: the desk shown and its warming done (at rest 300 ms), then
  ⌘K through the menu bar → the frame with the palette and its results (50 ms; one step, so the scenario's latency is
  that ⌘K's). Checks `warmed-ahead` (what `AppKitWarmup` did before the ⌘K and how long each took, per `desk.prewarm`),
  `shown`, `items`, `empty-search`; ink: the palette. The window builds the palette hidden once it has drawn
  (`PaletteWarmer`), then does AppKit's first key equivalent (the Window menu's items made) and the first text field
  taking the keyboard ahead (`AppKitWarmup`), so this measures what the first ⌘K still pays: the palette's first layout
  on screen. `--knobs desk.prewarm=none` measures it without the AppKit warm-up.
- Splits and expand (SPEC §2.1; each rep starts from one pane with the sidebar open and ends with its panes on screen;
  the shortcuts go through the menu bar, and each step names the item that fired):
  `split-open` (⌘D, ⇧⌘D, ⌘W ×2, `cycles` 2), `split-focus` (⌃← ⌃← ⌃→ ⌃→, then real clicks in other panes), `split-burst`,
  `pane-expand` (⇧⌘↩, then a real Esc, which the expanded pane's arrows-in takes, `toggles` 4; `scroll-kept` compares the
  thread's rows in view, by entry id, before and after; the keyboard starts in the sidebar's list (`keyboard-outside`)
  and each step expects it in the pane: expanded, and still there after Esc), `expand-switch` (picks as Search's ↩ makes them, then ⌘K over it and a real
  Esc, which must give the keyboard back to the pane: `focus palette-esc`; then Esc collapses the pane with the keyboard
  still in it, `focus collapse`; then ⇧⌘↩ expands it again, and its thread must show rows: `re-expanded` and the ink of
  `pane-1` after `re-expand`). Ink: every pane's thread, once its rows are
  in.
- The Needs you reel (`needs-open`, `needs-answer`, `needs-arrive`, `needs-step` (⌘J through the menu bar), `needs-empty` (ends with
  a real Esc), `needs-swipe`), on `needs5` (their default; `needs20` for twenty across eight). Each rep starts with
  every fixture ask asking and the reel closed. Ink: the reel.

- Team (SPEC §2.2), on `team` (their default): `team-open` (the Team button in the sidebar's foot clicked, a real
  click, then again: the frame with the roster and the profile's pane header, 50 ms; checks `opened`, `roster`,
  `closed`), `team-switch` (roster rows clicked across projects and All projects: the frame with that profile's header,
  50 ms; checks `switched`, `isolation`: no reel or agent pane body), `team-settings` (an installed profile's settings
  row opened and closed in place, then Turns + written through PUT; checks `summary`, `rows`, `written`). Ink: the
  sidebar and the pane's place (`team-pane`).

A scenario whose data isn't `crew17`'s has its own fixture (`palette-*`: `search`, `needs-*`: `needs5`): the manifest
says so (`scenarios[].fixture`), and perfloop, which always passes `--fixture`, passes that one unless you name another.

## Ink regions, snapshots and the look

Every scenario names its main view as an **ink region** (PerfLoop's ADAPTER.md §3b): the reel, the Needs you reel, the
sidebar list, the pane's thread, each pane's thread (`pane-1`, `pane-2`, … left to right, top to bottom), the palette.
After the steps that should leave it drawn, PerfLoopHost draws the region by itself and fails the `ink` guard when it is
blank or nearly (under 0.5 % of its pixels unlike its background; the empty Needs you reel's one line has 0.05 %). The
crops are in the run's `ink/` folder: `perfloop run` prints `look at (ink): …`. Open them: a region can pass with the
wrong content. A pane just switched to an agent whose thread isn't read yet is blank until its first page lands, so
the drivers judge panes once their threads have rows (up to 2 s after the step). The palette in the window is judged
drawn alone (`drawnAlone`: its own hosting view by itself), so a blank palette fails even over a busy reel.

The same regions are the snapshots' (`snapshot-diff`): `snapdiff` reports each region `same`, `moved`, `differs`,
`missing`, plus `rest`, with before, after and diff pictures; `--expect-look palette` declares a change you meant
(PerfLoop's AGENTS.md, *Looks*). A thread rests at a different offset run to run (after a switch, a split), so the
pane regions are compared by their ink, not their pixels (`comparedByInk(atLeast: 0.2)`: the candidate keeps at least a
fifth of the champion's ink; PerfLoop's default is half). The app draws dark whatever the system's appearance (`.preferredColorScheme(.dark)`),
so the bench draws dark and lists only `dark` (`--set appearance=light` is refused rather than measured under a name
it isn't).

## Fixtures

`list` names them; `fixture NAME` says what one builds. `solo` (1 agent), `trio` (3), `crew17` (SPEC's 17-agent
reference, the default), `crew17-long` (400–600 items a thread), `swarm64` (64 agents: past the warm cap of 32), `crew`
(the family sweeps vary), `search` (60 projects, Search ⌘K's), `needs5` and `needs20` (the Needs you reel's asks), `team` (two small runs, and a
daemon with the profile routes: `DeskBenchKit/TeamFixture.swift`, two projects' profiles and the user's own, as
`client/mock/profiles.ts` serves them to the app).
Same name, same bytes, every time (a seeded generator: markdown with headings/lists/code/tables, tool calls with diffs,
thinking, handoffs, errors, images as attachments, asks). Generated worlds are made once per process; every rep loads
its own copy into a fresh store.

**Parametric**: `--fixture crew17@agents=40`, `crew@agents=24,items=100`, plus `projects`, `asks` and `seed`, each within
the range `describe` lists (`parametric`); `items` also takes a range a thread, `crew@items=40-60` (`accepts` in the
manifest; checked by the generator's own parser before a rep runs). Parameters keep the base name's seed, so
`crew17@agents=17` is `crew17` byte for byte.

**Captured** (real daemon data): `fixture capture` reads runs from a daemon the way the app does
(`GET /v1/events?scope=<run>`, `/v1/runs/<run>/agents`, every agent's `/thread` pages; never attachment bytes):

```sh
capcomd clients add deskbench-capture --scopes read          # prints a token once: put it in a 0600 file
$B fixture capture --from ~/.capcomd/harness.sock --run run-… --token-file ~/.perfloop/capture-token --name crew-real
perfloop run $B --scenario step --fixture file:/abs/path/crew-real.json   # a bare name: …/capcomd-desktop/fixtures/NAME.json
```

Anonymised by default (`Sources/DeskBenchKit/Anonymise.swift`): every string replaced by generated text of the same
length and shape, ids hashed with a per-capture salt, URLs become `https://example.com/…`, times moved to start at
2026-01-01 (intervals kept); kinds, statuses, block types, common tool names, models and numbers kept. Attachments
keep their kind, mime and size. The file is written 0600, never inside a git checkout (`--allow-in-repo` overrides), to
`${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/fixtures/` unless `--out` says otherwise; `--raw` keeps the real text,
for a file that never leaves the Mac. The token is `--token-file`, `$CAPCOMD_TOKEN`, or `--keychain`. On an `ssh://`
runner the file must be on that Mac, at an absolute path: perfloop copies builds there, never fixtures.

deskbench registers the `file` scheme with PerfLoopHost (`bench.fixtureScheme`, `BenchCatalog.make`): the manifest
lists it (`fixtureSchemes: ["file"]`), perfloop refuses any other scheme before a rep runs, a missing or unreadable file
is refused with the reason, and the result's fixture is the spec as asked.

## Verifying a feature: `perfloop run`, `baseline` and `--expect same`

A desktop change that adds or alters a feature (a sidebar, a palette, a split) is verified through PerfLoop before its
PR says "done", per its docs/VERIFICATION.md (Agentic Verification) and AGENTS.md. `swift test` checks the model; this
checks the window: the feature's own scenarios pass their checks and guards (`ink` included) in every trusted rep, its
input reaches what it should, and the scenarios that were already there cost no more than before. Build the `perfloop`
CLI from a clone at the revision `Package.swift` pins, and give yourself a `PERFLOOP_HOME` of your own
(`PERFLOOP_APP=capcomd-desktop`).

```sh
B=.build/release/CapcomdDeskBench            # your branch's bench, built from a commit
perfloop doctor --bench $B                   # headless: the manifest as the runner reads it
perfloop run $B --scenario sidebar-toggle --reps 5 --reference switch       # numbers, checks, ink, input: no verdict
perfloop baseline sidebar-toggle --bench $B --reference switch              # once, in the PR: first numbers + a picture
perfloop exp new "the sidebar toggle" --build-cmd "swift build -c release --product CapcomdDeskBench" --bench $B --expect same
perfloop exp screen <id> --more 3            # when it says inconclusive; or perfloop exp full <id>
```

- **`run` and `baseline`** measure one build through the same gate as an experiment (screen-lock wait, quiet gate,
  window lock, one process per rep) and write a ledger line. Exit 3: a check or guard failed (`flaky 2/3` is a
  failure); exit 5: no rep could be trusted. They print each input step's line (`key ⎋ → … focus: …`) and with
  `--pictures` the window before and after it.
- **`--expect same`** answers `noRegression`, `regressed` or `inconclusive` (quote its line); a snapshot unlike the
  champion's is a `look:` for the reviewer, region by region; `--expect-look REGION` declares one you meant.
- **Untrusted reps are named, never quoted.** The owner's Mac is usually busy: its numbers are checks, not verdicts;
  deciding stages run on the owner's ssh runner only with the owner's OK.
- **New scenarios, fixtures and checks** for your feature may go in its PR, each marked `written in this PR`; changing
  an existing one is its own PR. A new scenario is a `ScenarioSpec` in `DeskBenchKit/Scenarios.swift` (its guards in
  `Guards.swift`) and a driver registered in `main.swift`.
- Anything else that opens a window goes inside `perfloop lock -- <command>` with `PERFLOOP_LOCK_OWNER=<your name>`
  (a PerfLoopHost bench's own `run` takes the lock itself), and the PR says those numbers are outside the ledger.
- Never pass `--force`, `--owner`, `--allow-dirty` or `--guard-tolerance`, never run `champion set`, never set
  `PERFLOOP_OWNER`: those are the owner's.

## Correctness guards

A blank column is fast. The guards make "fast because wrong" lose; perfloop reads which gate a scenario from the
champion's manifest (`guards`, `guardParams`) and judges both sides of every pair by them.

- **`checks`**: each scenario's own (`landed`, `isolation`, …), counted per trusted rep.
- **`ink`** (built in, every scenario): its regions drawn after the steps that should draw them (above).
- **`built-within`** (every scenario): after the window has rested (no main-thread stretch over 2 ms for 300 ms),
  every column at least half in view (of the Needs you reel while it is open) has had its `Column`, `ColumnHead`,
  `ColumnThread` and (when the fixture gives the agent a thread) one `EntryRow` body since its project opened, the last
  of them at most `built-within.ms` (300) after rest; it is warm; its view is a hosting view with something in it (or
  an AppKit column holding one), not the reel's blank placeholder and not hidden.
- **`snapshot-diff`** (`open`, `switch`, `step`, `jump`, `fling`, `swipe`, `follow`, `resize`, the `needs-*`,
  `sidebar-toggle`, `sidebar-select`, the `palette-*`, `split-open`, `split-focus`, `pane-expand`, `expand-switch`; not
  `burst`, `typing` or the other sidebar ones): PerfLoopHost's, by region (*Ink regions, snapshots and the look*).

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
| `reel.release` | `land`, `appkit` | `land` | when a swipe's fingers lift, the reel ends AppKit's own deceleration (`ReelRelease`) and rests on the column it chose; `appkit` leaves it running, as before 2026-11-04 (it carried the reel off the column edge: see *History*) |
| `search.host` | `overlay`, `panel` | `overlay` | Search ⌘K drawn inside the window (it keeps the keyboard), or in its own key panel over it (a child window: snapshots draw it in) |
| `desk.prewarm` | `all`, `menu`, `field`, `none` | `all` | AppKit's one-time work done once the window has drawn (`AppKitWarmup`): `menu` the menu bar's first key equivalent (a ⌃⌥⇧⌘F20 no item has), `field` the first text field taking the keyboard (a transparent field, for one turn, only when nothing has the keyboard); `none`: the first shortcut and the first field pay, as before 2026-11-19 |

```sh
perfloop run $B --scenario step --knobs reel.slide=clip          # one build, one setting (or: $B run step --knob reel.slide=clip)
perfloop exp new "the clip slide" --knobs reel.slide=clip      # against the champion, no rebuild
$B knobs --json                                                # what this process would run with (PERFLOOP_KNOBS + --knob)
```

The window reads knobs only from `PERFLOOP_KNOBS=name=value,name=value` (the app too: without it every knob reads its
default and the window runs the code it always ran). A knob is read once, when the reel is made; there is no per-frame
lookup. A name the binary doesn't have, or a value outside a knob's choices or range, stops `run` with exit 1 before a
window shows. Every result's `params.knobs` has the full vector the run used, defaults included. A knob is for an
experiment: once the loop promotes a setting, it becomes the code and the knob is deleted (SPEC §7.6).

## Reading a result

`perfloop run` prints the median of the objective over the trusted reps, the frame guards, every check and guard with
its count (`ink ✓ 2/2`, `drawn flaky 1/2`), the worst stretch (our frames, the framework's and the frame of ours
they ran `under`), the input steps (`key ⎋ → … focus: …`) and the pictures to look at. The result is
`perfloop.result/2` (PerfLoop's ADAPTER.md §3, SCHEMAS.md §3): per rep `steps[]` (`latencyMs`, `settleMs`, `cpuMs`,
`instructions`, frames, bodies and their `causes`, `input`, `focus`, `smoothness`), `checks[]`, `guards[]` (the
`ink` record's `inkRegions`), `worstStretches[]` (with the sampler's stacks: `topOurs`, `topFramework`, `benchSamples`
when the bench measured itself), `window` and the quiet gate's reading. `perfloop explain run/ID` prints it again;
`perfloop causes <result.json>` the whole table of which model properties were set before which bodies (the model's
`Mutations.record` calls, PerfLoopProbe).

Bodies: the views call `DeskProbe.body("Name")` first thing (with no sink, as in the app, a nil check); the desk
forwards them to PerfLoop's probe and keeps its own log for the isolation checks and `built-within`. `Column×17` after
a tab click means every column re-evaluated once.

## Profiling

`perfloop profile champion|exp/ID --scenario S --template time|hitches|swiftui` (or `$B profile S --template time
--out DIR`): PerfLoopHost starts the bench as a child, attaches `xctrace record`, signals the child to run and stops
the recording when its reps are done; every `run.step` is a `step` signpost (subsystem `dev.perfloop.bench`), which is
what the per-step call trees are cut on. `$B diff A B` compares two time profiles, ms per step (`perfloop.diff/1`).
**Traces are private**: a `.trace` holds the recorded process's environment. The child starts with PerfLoop's allowlist
(`TraceEnv`) plus the manifest's `profileEnv` (`DESKBENCH_SAMPLER`, `DESKBENCH_SIZING`, `DESKBENCH_APPKIT_TRACE`;
nothing secret-like ever passes), and the trace is deleted once exported unless `--keep-trace`. Never commit, publish
or attach one.

## Recorded gestures

A real swipe, recorded once by a hand, replayed as often as the loop likes (CAPABILITIES.md C9), in-process: the
events go to the reel's `NSScrollView.scrollWheel(with:)` at their recorded times, stamped with them (AppKit reads the
release velocity from the timestamps); nothing is posted to the system.

```sh
$B record-gesture swipe --name flick-left           # the owner, once: swipe with two fingers over the columns
perfloop gestures list                                # the recorded ones (${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/gestures)
perfloop run $B --scenario swipe --set gesture=/abs/path/flick-left.json --reps 5
```

`record-gesture SCENARIO` (PerfLoopHost) shows the scenario's window (`swipe`: the reel at its middle column) and
records a hand's gestures over it (deltas, phases, times, nothing else) as `perfloop.gesture/1`; never inside a git
checkout. A dev build of the app records too: `CAPCOMD_DESK_RECORD_GESTURE=~/g/flick.json` (DeskDebug; release builds
with `-Xswiftc -DDESK_PROBE`). The synthetic ones (`synthetic:flick-forward`, `flick-back`, `drag-forward`, and the
vertical `scroll-down`, `scroll-up`) are PerfLoopProbe's; the three horizontal ones are in `Gestures/` as files
(`$B gestures --write Gestures` regenerates them; a test checks they match).

Smoothness (`steps[].smoothness`, PerfLoopProbe's `SmoothnessMeter`): a display link reads the document layer's
`presentation()` position every tick (a render-server slide counts) against the start plus the finger deltas that
could be on screen by then: `latencyFrames` (AppKit applies a delta at the next refresh: the reel shows the fingers'
position a frame late), `positionErrorP95Pt` while the fingers are down, `stalls` (frames the fingers moved and the
content didn't, plus missed vsyncs), `jerkP95` (information). `--set inject-block-ms=60` sleeps the main thread
mid-gesture: the meter's self-check. `DESKBENCH_APPKIT_TRACE=1` (`swipe`, `needs-swipe`, `record-gesture swipe`) prints a
line each time AppKit's private scrolling animator begins a deceleration of its own or stops one.

`fling`, `swipe` and `needs-swipe` replay through the window (`run.swipe(…, delivery: .window)`): each event goes to the
app for the reel's window, so the reel's local event monitor routes it as a hand's (as deskbench's own replay did,
`deliver=window`); `sidebar-scroll` replays into the sidebar's scroll view. Each swipe's notes say how many of the
gesture's finger and momentum events reached the reel's scroll view (`GestureTap.seen`).

## Sweeps

`perfloop sweep` runs a grid and fits curves through the objective:

```sh
perfloop sweep step --bench $B --set agents=4..64/12 --reps 2 --dry-run      # the grid, the commands, an estimate
perfloop sweep step --bench $B --fixture crew --set agents=4..64/4 --set items=50..400/50 --reps 3 --budget-min 60
perfloop sweep step --bench $B --set reel.slide=ca,clip --set agents=8,32,64   # a knob against the size
```

A `--set` is a knob if the manifest has one by that name, a fixture parameter if the fixture's `parametric` has it,
else a scenario param. Points run in a fixed shuffled order, one `run --reps N` child each, under the window lock.

## Adding to the bench

- A scenario: a `ScenarioSpec` in `DeskBenchKit/Scenarios.swift` (name, budget, rule, kind, params, and `fixture` when
  its data isn't `crew17`'s), its guards in `Guards.swift`, and a driver (a `HostRun` body: `let d = try Desk(run)`,
  `try await d.show()` (the scene's window, adopted, with this rep's desk), then `run.step`s, ink regions,
  `run.record(checks)`) registered in `main.swift`. Measure the change with `until:` (the frame that shows it), put a
  check that costs anything behind `run.check` or after the step, use real input where a user would: `run.press` for a
  menu shortcut (with the item it must fire), `run.type`, `run.key`, `run.click` where the view tree handles it.
- A fixture: a `FixtureSpec` in `Fixtures.swift`; the generator takes care of the rest.
- A knob: a `static let` `Knob(…)` in `CapcomdDesk/DeskKnobs.swift`, added to `DeskKnobs.knobs`, read once into a stored
  property where it is used, with the default reproducing today's behaviour.
- A view worth counting: `DeskProbe.body("Name")` (or `body("Name", id: agentId)`) as the first statement of its
  `body`, and its name in `BenchCatalog.probes`.
- Tests: `swift test --filter DeskBenchKitTests` (fixtures, captures, `built-within`, the manifest as the runner reads
  it, the knobs' defaults, the gesture files: no window). Never commit a real recording, a capture or a `.trace`.

The views only ever see `DeskProbe`, a nil-checked static, and `DeskKnobs` (PerfLoopProbe, Foundation only, values
stored once); nothing else from the bench is linked into the app.

## History (deskbench's own harness, before PerfLoopHost)

Until 2026-11-18 deskbench was its own protocol-1 adapter: its own harness (a SwiftUI scene host, a stretch clock, a
sampler, budgets), `ab`, `compare`, `suite`, `snapshot`, `explain`, `trace`, `selftest`, its own snapdiff (threads by
their ink) and swipe replay. These findings were made with it; the numbers are its, not PerfLoopHost's.

### Snapshots

Same build against itself (2026-10-31, crew17, two binaries of one source): 0 differing pixels outside the threads on
`switch` and `step` in every pair, within and across processes; threads drawn 31 % or more of each other's (once in a
while a thread rests after a switch with most of its viewport still empty: 3.7 % drawn vs 11.6 %). A build that leaves
the columns blank after a switch (the reel's placeholders) won `switch` by 31 % (8 + 8, p = 0.003) and lost on
`built-within` in every pair, with 1.75 % of the window and 3.4–4.4 % of each column differing and its threads 0 % drawn.

What they showed about the window as it is: after a switch the reel shows the first columns while the model's `onScreen`
is the asking agent's (the non-animated reel request is served before the new columns are in the reel), so the threads
in view warm last, 2–3 s after the frame `switch` measures.

### Recorded gestures

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

### What the bench found (2026-10-30, 3a6b5b7's reel, release, crew17, a loaded machine)

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

### After the AppKit reel (2026-10-30, load 2–6)

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

### Sweeps

The first curve (2026-10-31, dbdb80c, release, 2 reps a point, a busy machine at 5 of 6 points): `step` on
`crew17@agents=N` cost 28 ms of main-thread CPU a step at 4 agents, 99 at 16, 230 at 28, then ~310 flat from 40 to
64: "ms/step grows 4.98 ms per agent (r² 0.84)", and the quadratic (r² 0.97) says it bends. The plateau starts past
the warm cap (32), which is consistent with every warm column paying on every step. A 2-D grid on `crew` gave
"ms/step ≈ 55.5 + 6.72 ms per agent + 0.036 ms per item (r² 0.98)": agents matter, thread length barely does.
Measure again on a quiet machine before quoting the numbers.
