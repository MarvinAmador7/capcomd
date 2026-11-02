// "Benching the Reel", the desktop app's perf log of 30 Oct 2026, as the site tells it: the readouts the desktop page
// and /desktop/perf/ share, and the log's own words, terminals and findings. Numbers are DeskBench and xctrace results
// on the crew17 fixture, builds 3a6b5b7 (before, the SwiftUI reel) and 9bcd41a (after, the AppKit reel).

/** [before, after, unit, what]: the four headline results. */
export const READOUTS: Array<[string, string, string, string]> = [
  ["257", "52", "", "compositor hitches in a 12-second recording. The worst went from 450 ms late to 25."],
  ["10.1", "3.6", "s", "of main-thread CPU in those same 12 seconds."],
  ["68", "12.6", "ms", "a frame while the reel steps, 95th percentile, median of five runs a side."],
  ["544", "170", "ms", "from a click to the first frame of another project, median of 30 switches."],
];

export const FIXES = [
  "SwiftUI's scroll view redrew all 16 columns on every scroll frame. The reel is now an AppKit scroll view with one hosting view per column.",
  "Auto Layout asked every column for its size on each update, 65% of the main thread. The column now answers that itself, in three lines.",
  "Each slide moved the reel from the main thread, about 20 ms a frame. It is now one Core Animation animation that the render server draws on its own.",
  "Opening a project built all 16 columns at once. The nearest come first now: 217 ms became 158.",
];

export const BENCH_HELP = `$ swift run -c release CapcomdDeskBench help
commands
  list [scenarios|fixtures|budgets] [--json]   what can be run, and the budget each scenario maps to
  run <scenario> [options]                      drive one scenario on a fixture, judge it against its budget
  suite [options]                               every scenario in turn; exit non-zero if any fails
  snapshot [--fixture F] [--out DIR] [--at N]   the window as PNG + a view/geometry dump (JSON)
  profile <scenario> --template hitches|time|swiftui [--out DIR]
                                                run the scenario under xctrace, summarise the trace as JSON
  trace <file.trace> [--process NAME] [--json]  summarise an existing trace the same way
  ab --a EXE --b EXE <scenario> [--reps N]      alternate two builds, compare medians within the noise
  compare <baseline.json> <candidate.json>      regression check between two saved results
  explain <result.json>                         a saved result as text: verdict, numbers, causes

exit codes  0 pass · 1 usage · 2 harness error · 3 budget failed · 4 regression beyond noise · 5 untrusted`;

/** [API, how it's set up, what it measures, the JSON fields it fills]. */
export const PROBES: Array<[string, string, string, string]> = [
  ["CADisplayLink", "pinned to 120 Hz", "One tick per vsync the main thread actually serviced. An interval over 1.5 times the display's steady rate is a late frame. ProMotion's own rate is detected first, so a panel idling at 60 Hz isn't counted as 60 drops a second.", "frames.p95Ms · late · dropped · steadyHz"],
  ["CFRunLoopObserver", "afterWaiting · beforeWaiting", "Each wake-up of the main run loop is one stretch, timed on the wall clock and on the thread's own CPU clock. Wall time far above CPU time means the machine preempted the app, not that its code was slow.", "mainThread.longestMs · over16 · cpuMs"],
  ["DeskProbe.body", "one call per SwiftUI body", "Columns, tabs and rows report each body evaluation. Inside each long stretch the bench lists which views were re-evaluated.", "bodies per step"],
  ["OSSignposter", "one interval per step", "Each scenario step is a signpost, so an xctrace recording of the same run lines up with the in-process numbers. The step marks above the strips come from these.", "signposts.step"],
  ["CATransaction", "completion block", "Latency ends when the Core Animation commit that shows the change has gone out, not when the model changed. That is the moment a click becomes visible.", "steps[].latencyMs"],
];

export const STRETCH_PROBE = `let o = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault,
    CFRunLoopActivity.afterWaiting.rawValue | CFRunLoopActivity.beforeWaiting.rawValue, true, 0) { _, a in
  if a == .afterWaiting { awoke = now(); awokeCpu = threadCpuMs() }   // the thread woke up
  else if let s = awoke {                                               // …and is about to sleep
    stretches.append((s, now() - s, threadCpuMs() - awokeCpu)); awoke = nil
  }
}
CFRunLoopAddObserver(CFRunLoopGetMain(), o, CFRunLoopMode.commonModes)`;

export const UNTRUSTED = `step on crew17: UNTRUSTED  (2 reps, 19353 ms, 120 Hz, release)
noise: NOT QUIET. load average 7.11 on 8 cores; busy processes:
  com.apple.dt.instruments.dtsecurity 172%, WindowServer 46%, DTServiceHub 27%.
  A failed budget here means 'run it again', not 'the reel is slow'.
frames        display at 24 Hz  p95 61.37 ms  p99 69.59 ms  late 7.0/rep
main thread   longest 148.98 ms  >16.7 ms: 82.0/rep  >100 ms: 6.0/rep  cpu while awake 97 %`;

/** deskbench profile, step by step: [what, detail]. */
export const PIPELINE: Array<[string, string]> = [
  ["Fixtures.make", "crew17: 17 agents of generated work, built in 5 ms"],
  ["A child process", "the app's real views in a window, waiting on a file"],
  ["xctrace record", "attached to the child's pid: Time Profiler, Animation Hitches or SwiftUI"],
  ["The scenario", "runs under the recorder, with the five probes on"],
  ["xctrace export", "tables pulled with --xpath, rows and backtraces resolved"],
  ["Profile JSON", "hot spots, bursts of 16 ms or more, hitches and hangs"],
];

export const FLAMES = [
  { key: "before", title: "Before", sub: "SwiftUI ScrollView reel · 3a6b5b7 · 10,088 samples" },
  { key: "middle", title: "Middle", sub: "AppKit reel, Auto Layout still sizing columns · 9,451 samples" },
  { key: "after", title: "After", sub: "AppKit reel, slides in the render server · 9bcd41a · 3,631 samples" },
] as const;

/** [build, what, ms, the story]. */
export const CALLOUTS: Array<[string, string, string, string]> = [
  ["Before", "focus walk", "1,529", "To find the window's draggable title-bar region, AppKit asked each hosting view whether it accepts first responder, and SwiftUI answered by walking its whole focus graph. 15% of the main thread before; 29 samples after."],
  ["Before", "scroll animation", "2,451", "NSScrollAnimationHelper moved the clip view on every display-link tick, and each move posted a bounds change that SwiftUI turned into a graph update across all 16 columns. 24% of samples; 231 after."],
  ["Middle", "sizeThatFits", "6,181", "The first AppKit reel fixed scrolling and exposed the next wall: Auto Layout asking for a fitting size on every update, which made SwiftUI lay out every column. 65% of the main thread, fixed by a three-line method."],
];

export const SIZE_PROFILE = `time profile: 9451 main-thread samples (every 1.0 ms)
bursts ≥16 ms: 73 covering 9320 samples
  ours + hot spots, inclusive:
    9436  _DPSBlockUntilNextEventMatchingListInMode
    6819  AG::Graph::UpdateStack::update
    6143  LayoutEngineBox.sizeThatFits
    6136  ViewLayoutEngine.sizeThatFits
    6096  _FlexFrameLayout.sizeThatFits
    6080  PlatformViewLayoutEngine.sizeThatFits`;

export const SIZE_FIX = `// Reel.swift: answer SwiftUI's size question here, so Auto
// Layout never asks 16 hosting views for a fitting size.
func sizeThatFits(_ proposal: ProposedViewSize,
                  nsView: ReelView, context: Context) -> CGSize? {
  proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
}`;

export const SLIDE = `// Reel.swift: move the offset once, let the render server move.
scroll.contentView.setBoundsOrigin(NSPoint(x: to, y: 0))
let a = CABasicAnimation(keyPath: "position.x")
a.isAdditive = true
a.fromValue = to - from   // where the old offset showed it
a.toValue = 0
a.duration = 0.35
a.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
layer.add(a, forKey: "slide")`;

export const HITCH_LISTS: Array<[string, string]> = [
  ["Before", `hitches: 257 (total 8241.6 ms, max 450.0 ms, ≥16 ms: 202)
  230× Potentially expensive app update(s)
   24× unspecified
    2× Potentially expensive app update(s), render
    1× Potentially expensive render`],
  ["After", `hitches: 52 (total 725.0 ms, max 25.0 ms, ≥16 ms: 18)
   31× Potentially expensive app update(s)
   18× unspecified
    2× Potentially expensive render
    1× Potentially expensive app update(s), render`],
];

export const AB_RUNS: Array<[string, string]> = [
  ["deskbench ab --a before --b after step --reps 5", `ab step on crew17: 5 reps a side
  · same    lateFrames 9.0 → 16.0 (+77.8 %), inside the ±82.4 % noise band
  better    frameP95Ms 67.71 → 12.59 (−81.4 %), outside ±15.0 %
  better    longestStretchMs 285.8 → 103.75 (−63.7 %), outside ±41.4 %
  better    stretchesOver16 72.0 → 9.0 (−87.5 %), outside ±25.0 %
exit 0`],
  ["deskbench ab --a before --b after switch --reps 5", `ab switch on crew17: 5 reps a side
  better    latencyMs 543.89 → 153.25 (−71.8 %), outside ±15.0 %
  better    longestStretchMs 1112.69 → 482.67 (−56.6 %), outside ±30.7 %
  A: latency 543.89 ms  frame p95 156.52 ms  longest 1112.69 ms
  B: latency 169.9 ms   frame p95 179.45 ms  longest 482.67 ms
exit 0`],
];

/** [id, kept, hypothesis, evidence, verdict, outcome]. */
export const HYPOTHESES: Array<[string, boolean, string, string, string, string]> = [
  ["H1", false, "A tab click re-renders every column and tab.", "Per-column focused and on-screen flags, then ab on step and switch.", "Within noise", "Kept as hygiene. Not the cause."],
  ["H2", false, "A focus walk still runs on every frame.", "It did in the original build, but that trace predated the first fix. Re-profiled, the current build had none.", "Stale trace", "Reverted the experiment it prompted."],
  ["H3", true, "SwiftUI's ScrollView dirties all 16 columns every scroll frame.", "ScrollViewCommitMutation.commit and propagate_dirty inside nearly every burst; the display fell to 24 Hz.", "Confirmed", "Reel rebuilt as an NSScrollView, one hosting view per column."],
  ["H4", true, "Auto Layout sizes every column on each update.", "6,143 of 9,451 main-thread samples under sizeThatFits.", "Confirmed", "The representable answers sizeThatFits itself."],
  ["H5", false, "ab exits 4: late frames got worse.", "Per-step JSON: the display went from 24 to 48 Hz, so twice as many frames could be counted late.", "Metric artefact", "Judged on frame p95 and stretches."],
  ["H6", true, "Setting the clip offset every frame costs about 20 ms a frame.", "ViewGraph.invalidateTransform in the bursts; the slide ran on the main thread.", "Confirmed", "One additive Core Animation animation per slide."],
  ["H7", true, "Opening a project builds all 16 columns and renders twice.", "Body counts per step; switch latency 217 ms.", "Confirmed", "Near columns first, far ones blank: 217 → 158 ms."],
];

/** [ms, scenario, symbol, what it is and what's next]. */
export const LEADS: Array<[string, string, string, string]> = [
  ["2,024", "switch", "LazyHVStack · sizeThatFits", "Building each opened column's thread: about a hundred rows laid out so the newest sit at the bottom. 28% of the switch profile. A tail-first build is the next change."],
  ["392", "switch", "NSHostingView deinit", "The closing project's columns are torn down inside the same run-loop turn as the click. Deferring the teardown takes it off the click's path."],
  ["629", "step", "_findAnySubviewNeedingAutoLayoutEngine", "AppKit recursing through every subview on each layout pass, looking for one that uses Auto Layout. The largest single item left in the step profile, 17%."],
  ["488", "step", "_NSTrackingAreaAKManager", "Tracking areas rebuilt across the scroll view's subviews whenever its structure changes. Fewer views per column would shrink it."],
  ["259", "step", "TimeDataFormattingStorage", "Relative timestamps (“2m ago”) re-resolved during layout. Small, but it runs in every column."],
];
