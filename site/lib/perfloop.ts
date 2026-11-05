// The PerfLoop page's facts. Every number is from design/perf-loop/JOURNEY.md and apps/menubar/app/LAYOUT.md (main,
// 30–31 Oct 2026, the swipe finding as corrected on 4 Nov); what JOURNEY §7 says not to claim (a speed-up from the
// loop itself, trusted dedicated hardware, replays of the hand-recorded gestures) is not claimed here.

export type Sense = "see" | "feel" | "check";
export type Verdict = "same" | "rejected" | "lost" | "needs review" | "finding" | "queued";

/** The night: the loop's real experiments and findings of 30–31 Oct, replayed as one overnight queue. */
export const NIGHT: Array<{ at: string; sense: Sense; what: string; knob?: string; verdict: Verdict; why: string }> = [
  { at: "23:04", sense: "check", what: "The bench against itself", verdict: "same", why: "−0.8 % CPU, +4.5 % instructions: both inside their noise bands. It can't tell a build from itself, so what it says next counts." },
  { at: "23:41", sense: "see", what: "Slide the reel on the main thread", knob: "reel.slide=clip", verdict: "rejected", why: "+91 % CPU against the Core Animation slide." },
  { at: "00:26", sense: "feel", what: "Build more columns per frame", knob: "build.perFrame=4", verdict: "lost", why: "No latency win, and the longest stall 35–44 % longer. The default stays." },
  { at: "01:12", sense: "check", what: "A build that cheats, planted to test the guards", verdict: "rejected", why: "Projects switched in 67 ms instead of 114: a 41 % win on paper. Columns weren't built in either rep, and the window differed from the champion's by 1.9 % (an honest pair: 0.13 %)." },
  { at: "01:58", sense: "see", what: "Our own layout math", knob: "desk.layout=frames", verdict: "lost", why: "No faster, and the longest stretch 40 % longer. Layout arithmetic isn't where the time goes." },
  { at: "02:44", sense: "check", what: "Hide columns while they lay out", knob: "desk.layout=frames-hide", verdict: "rejected", why: "An apparent −27 %. The guards found where it came from: blank columns." },
  { at: "03:31", sense: "see", what: "AppKit column chrome instead of SwiftUI", knob: "desk.column=native", verdict: "needs review", why: "−13 % instructions, better in 5 of 5 pairs, inside a ±14 % band. One antialiased corner pixel changed, so a person looks before it's kept." },
  { at: "04:15", sense: "see", what: "Keep only nearby columns in the document", knob: "reel.columns=park", verdict: "lost", why: "+16 %: moving views between parents costs more than it saves." },
  { at: "04:52", sense: "see", what: "Fixed slots, reconfigured in place", knob: "reel.columns=reuse", verdict: "rejected", why: "+38 % on 17 agents, but the cost of each extra agent fell from 3.28 to 2.40 ms. Worth it once a column is cheap to configure." },
  { at: "05:33", sense: "feel", what: "Slide cached bitmaps of the columns", knob: "reel.cache=bitmap", verdict: "rejected", why: "The longest stall went from 50 to 872 ms: rasterising one column takes 100–150 ms." },
  { at: "05:58", sense: "feel", what: "Replay a swipe with real timestamps", verdict: "finding", why: "The reel coasted up to about 200 pt past the column edge and didn't snap back. The old synthetic fling sent none, which hid it. A flick by hand later stopped 204 pt off the edge; it's fixed, and the reel lands on the edge." },
  { at: "06:21", sense: "see", what: "Sweep: 4 to 64 agents, three column builds", verdict: "finding", why: "The cost grows with the views SwiftUI makes for the threads, about 1,100, not with layout. That's what to fix next." },
  { at: "06:58", sense: "see", what: "Thread rows drawn natively with Core Text, measured once and cached", verdict: "queued", why: "The idea the data points to, queued for the next night." },
];

export const SENSE_LABEL: Record<Sense, string> = { see: "Saw", feel: "Felt", check: "Checked" };

/** Where a step's main-thread time went, 4 and 40 agents (LAYOUT.md, profile split, ms per step). */
export const SPLIT: Array<{ what: string; at4: number; at40: number }> = [
  { what: "SwiftUI transactions", at4: 16.6, at40: 45.7 },
  { what: "Auto Layout walking the views", at4: 2.9, at40: 42.1 },
  { what: "Placing each column's hosting view", at4: 8.9, at40: 40.5 },
  { what: "Recomputing mouse-tracking areas", at4: 3.4, at40: 34.8 },
  { what: "The title bar", at4: 8.7, at40: 18.5 },
  { what: "The tab strip's scroll", at4: 0, at40: 14.3 },
];
export const SPLIT_TOTAL = { at4: 62.6, at40: 239.1 };

/** The sweep, step, 4 → 64 agents: main-thread CPU fitted per agent (2 reps a point, most on a busy machine). */
export const SWEEP: Array<{ what: string; perAgent: number; from: number; to: number }> = [
  { what: "SwiftUI columns, as today", perAgent: 3.28, from: 50, to: 261 },
  { what: "AppKit columns", perAgent: 2.96, from: 46, to: 237 },
  { what: "AppKit columns in reused slots", perAgent: 2.4, from: 43, to: 212 },
];

/** The capabilities as built: C1–C10 from JOURNEY §3, C11–C12 and the additions from the perfloop repo's README. */
export const CAPABILITIES: Array<[string, string, string]> = [
  ["C1", "In-process sampler", "Stacks inside every long stretch, every run, at about 1.3 % overhead. No profiler needed."],
  ["C2", "perfloop diff", "A differential call tree, A against B, per step: what grew in B."],
  ["C3", "Low-noise objective", "Main-thread CPU and instructions retired per step; frame metrics that keep their meaning when the refresh rate changes; a quiet-machine check before every rep."],
  ["C4", "Runtime knobs", "Compare settings in one binary, with no rebuild per idea."],
  ["C5", "Ledger and champion", "A content-addressed build store, provenance stamped into every binary, an append-only ledger."],
  ["C6", "Correctness guards", "Every column in view built at rest; the window pixel for pixel against the champion's, within 0.5 %."],
  ["C7", "Why did this body run", "Each SwiftUI body re-evaluation charged to the state change that caused it."],
  ["C8", "Sweeps", "Cost curves over crew size, thread length and knobs, with a fitted slope and where each curve crosses the frame budget."],
  ["C9", "Gesture replay", "A trackpad swipe replayed into the window, scored on how well the content followed the fingers; a recorder for a real one."],
  ["C10", "A machine nobody is using", "An idle-gated local runner, an ssh:// runner for a spare Mac, a macOS VM for screening, an overnight queue."],
  ["C11", "What to try next", "Ranked hypotheses for the next experiment, each with the share of the step it could remove and the evidence for it."],
  ["C12", "An MCP server", "The loop as tools an agent calls: long stages run as jobs it checks on, and the owner's flags aren't offered."],
];

export const LOOP_CMDS: Array<[string, string]> = [
  ["perfloop suggest champion", "What to try next, ranked, with the evidence."],
  ["perfloop exp new \"<hypothesis>\" --knobs desk.column=native", "A candidate against the champion, screened at once."],
  ["perfloop exp full ID", "5 + 5 interleaved pairs, more while it's unsure: won, lost or needs review."],
  ["perfloop explain exp/ID", "Everything needed to decide the next step, in one file."],
  ["perfloop queue run --runner ssh://mini --until 07:00", "Works the queue on a spare Mac until morning."],
];
