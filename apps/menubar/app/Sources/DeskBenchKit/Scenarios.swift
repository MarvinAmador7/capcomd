import Foundation
import PerfLoopProbe

/// The scenarios the bench drives, each tied to one SPEC §1 budget. The bench's `Harness` knows how to drive them;
/// this is what `list` prints and what `Budgets.evaluate` judges by.
public struct ScenarioSpec: Codable, Sendable, Hashable {
  public enum Kind: String, Codable, Sendable { case latency, smooth, isolation }
  public var name: String
  public var summary: String
  /// Which SPEC §1 row this measures.
  public var budget: String
  /// The pass rule in words.
  public var rule: String
  public var kind: Kind
  /// For latency scenarios: the median must be at or under this.
  public var latencyBudgetMs: Double?
  /// Parameters the scenario takes (`--set key=value`), with defaults.
  public var params: [String: String]
}

public enum Scenarios {
  public static let all: [ScenarioSpec] = [
    ScenarioSpec(name: "open", summary: "Show the window on a filled store and wait for the first frame that has columns in it.",
                 budget: "Open the window: first frame ≤ 100 ms", rule: "median latency from makeKeyAndOrderFront to the first committed frame ≤ 100 ms; no stretch over 250 ms",
                 kind: .latency, latencyBudgetMs: 100, params: [:]),
    ScenarioSpec(name: "switch", summary: "Switch between the two largest projects (as ⌘1/⌘2 do), back and forth.",
                 budget: "Switch project: first frame ≤ 50 ms", rule: "median latency from open(project:) to the frame that shows the new columns ≤ 50 ms",
                 kind: .latency, latencyBudgetMs: 50, params: ["switches": "6"]),
    ScenarioSpec(name: "step", summary: "Click through the reel one screen at a time, to the end and back (animated, as a crew tab does).",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; no stretch over 16.7 ms during a step",
                 kind: .smooth, latencyBudgetMs: nil, params: ["steps": "8"]),
    ScenarioSpec(name: "jump", summary: "First column ↔ last column: the longest jump there is, repeatedly.",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; no stretch over 16.7 ms during a jump",
                 kind: .smooth, latencyBudgetMs: nil, params: ["jumps": "6"]),
    ScenarioSpec(name: "fling", summary: "A synthetic trackpad swipe with momentum, delivered to the reel's NSScrollView (see DESKBENCH.md for its fidelity).",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["flings": "6", "velocity": "2400"]),
    ScenarioSpec(name: "swipe", summary: "A recorded trackpad gesture (perfloop.gesture/1, --gesture FILE) replayed into the reel's NSScrollView at its recorded times, in-process; how closely the content followed the fingers.",
                 budget: "Reel scroll: no dropped frames at 120 Hz with 17 agents", rule: "no late frame while the reel moves; the content within 1 pt of the fingers (p95) with no stall; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["gesture": "synthetic:flick-forward", "swipes": "4", "from": "middle", "timestamps": "recorded", "deliver": "window"]),
    ScenarioSpec(name: "burst", summary: "Thread items arrive for one on-screen agent at a steady rate while the reel stands still, then again while it steps.",
                 budget: "A thread item arrives: re-renders its own column only", rule: "no Column, ColumnHead, CrewTab, TitleBar or other column's thread body during the burst; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "typing", summary: "Type into an on-screen column's composer with key events sent to the window.",
                 budget: "Typing in a composer: no work outside the composer", rule: "only ColumnComposer bodies while typing; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["text": "Please normalize the emails before the join and rerun the tests."]),
    ScenarioSpec(name: "resize", summary: "Resize the window across the 3 → 2 → 1 → 3 column steps.",
                 budget: "(no §1 row; general: nothing hangs)", rule: "no stretch over 100 ms per resize; the column count follows the width",
                 kind: .smooth, latencyBudgetMs: nil, params: [:]),
    ScenarioSpec(name: "follow", summary: "An ask arrives for a far-off agent with Follow on: the reel must go there.",
                 budget: "Follow (SPEC §3): 0.35 s spring to the asking column", rule: "the reel starts moving within 50 ms of the ask and lands on it; no late frame on the way",
                 kind: .latency, latencyBudgetMs: 50, params: ["asks": "4"]),
    // The folding rail and the Rex-style sidebar (design/desktop/rex; SPEC §1 "Fold or open the sidebar").
    ScenarioSpec(name: "sidebar-toggle", summary: "Open and fold the sidebar as ⌃⌘S does (animated=1: as its button does), with the reel kept underneath.",
                 budget: "Fold or open the sidebar: first frame ≤ 50 ms, the reel untouched", rule: "median latency from the toggle to the frame that shows it ≤ 50 ms; no reel body; the reel's frame unchanged; sidebar and pane drawn",
                 kind: .latency, latencyBudgetMs: 50, params: ["toggles": "8", "animated": "0"]),
    ScenarioSpec(name: "sidebar-select", summary: "With the sidebar open, click rows (events handed to the window) and walk it with ↓ and Return; each pick shows in the pane.",
                 budget: "Switch agent from the sidebar: first frame ≤ 50 ms", rule: "median latency from the click or Return to the frame that shows the agent ≤ 50 ms; every pick shown",
                 kind: .latency, latencyBudgetMs: 50, params: ["clicks": "6", "keys": "4"]),
    ScenarioSpec(name: "sidebar-burst", summary: "With the sidebar open, thread items for the pane's agent and another agent at a steady rate.",
                 budget: "A thread item arrives: re-renders its own column only (the sidebar never)", rule: "no sidebar body and no sidebar slice assignment during the burst; the pane's thread renders; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "sidebar-scroll", summary: "A long sidebar (every project unfolded) scrolled down and back with replayed trackpad gestures.",
                 budget: "Sidebar scroll: no dropped frames, no pane work", rule: "no late frame while it moves; no stretch over 16.7 ms; no pane body",
                 kind: .smooth, latencyBudgetMs: nil, params: ["scrolls": "4", "gesture": "synthetic:scroll-down", "gestureBack": "synthetic:scroll-up"]),
    ScenarioSpec(name: "palette-open", summary: "Search ⌘K on the empty search, then Esc, repeatedly (fixture `search`: 250+ items): ⌘K to the frame that shows the panel and its results.",
                 budget: "Search ⌘K opens: first frame ≤ 50 ms", rule: "median latency from ⌘K to the first frame with the panel and its results ≤ 50 ms; checks: items, empty-search, panel-drawn, esc-closes",
                 kind: .latency, latencyBudgetMs: 50, params: ["opens": "6"]),
    ScenarioSpec(name: "palette-type", summary: "Type a query into Search ⌘K a character at a time (key events to its field): each keystroke to the frame that shows its results.",
                 budget: "Search ⌘K: a keystroke's results within a frame", rule: "median latency from a key to the frame that shows its results ≤ 16.7 ms; checks: typed, ranking, panel-drawn",
                 kind: .latency, latencyBudgetMs: 16.7, params: ["query": "matchkey"]),
    ScenarioSpec(name: "palette-keys", summary: "Search ⌘K's keys: type a query, ↓ ↓ ↑, ↩ opens the selection, ⌘↩ opens the first (splits fall back to ↩), Esc closes.",
                 budget: "Search ⌘K: keys and opening a result ≤ 50 ms", rule: "median latency from a key to the frame that shows what it did ≤ 50 ms; checks: selection, return-opens, split-falls-back, esc-closes, panel-drawn",
                 kind: .latency, latencyBudgetMs: 50, params: ["query": "shard"]),
    // Splits and expand in the opened window (design/desktop/rex RexSplit, RexExpanded; SPEC §2.1). Each rep starts from
    // one pane and ends with its panes on screen.
    ScenarioSpec(name: "split-open", summary: "With the sidebar open, ⌘D (split right), ⇧⌘D (split down), then ⌘W twice, as key events to the app; each shows the panes.",
                 budget: "Split or close a pane: first frame ≤ 50 ms", rule: "median latency from the key to the frame that shows the panes ≤ 50 ms; the new pane is the next agent in tree order, focused; ⌘W closes the focused split",
                 kind: .latency, latencyBudgetMs: 50, params: ["cycles": "2"]),
    ScenarioSpec(name: "split-focus", summary: "Three panes: ⌃← ⌃→ and clicks move the focus between them.",
                 budget: "Move the focus between panes: first frame ≤ 50 ms, no thread renders", rule: "median latency from the key or click to the frame that shows the focus ≤ 50 ms; no PaneThread or PaneEntryRow body; the pane views kept",
                 kind: .latency, latencyBudgetMs: 50, params: ["clicks": "2"]),
    ScenarioSpec(name: "split-burst", summary: "Three panes: thread items for the middle pane's agent at a steady rate.",
                 budget: "A thread item arrives: re-renders its own column only (in a split: its own pane)", rule: "no other pane's body, no sidebar body or slice assignment during the burst; the target pane's thread renders; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["itemsPerSecond": "20", "seconds": "3"]),
    ScenarioSpec(name: "pane-expand", summary: "Two panes, the focused thread scrolled up: ⇧⌘↩ expands it to the window, Esc brings back the same panes.",
                 budget: "Expand or collapse a pane: first frame ≤ 50 ms, no thread rebuilt", rule: "median latency from the key to the frame that shows it ≤ 50 ms; expanded fills the window; back: same panes, frames, scroll position and views",
                 kind: .latency, latencyBudgetMs: 50, params: ["toggles": "4"]),
    ScenarioSpec(name: "expand-switch", summary: "A pane expanded: other agents picked as the palette's ↩ picks them, then ⌘K over it and Esc.",
                 budget: "Switch agent: first frame ≤ 50 ms (expanded stays expanded)", rule: "median latency from the pick to the frame that shows the agent ≤ 50 ms; still expanded, full window, every pick shown",
                 kind: .latency, latencyBudgetMs: 50, params: ["switches": "4"]),
    // The Needs you reel (SPEC, Needs you reel). Run them on `needs5` or `needs20` (asks across projects).
    ScenarioSpec(name: "needs-open", summary: "Open the Needs you reel (the hand): every ask across projects as a column, oldest first.",
                 budget: "Open the Needs you reel: first frame ≤ 50 ms", rule: "median latency from openNeedsReel() to the frame that shows its columns ≤ 50 ms; the columns are the asks oldest first; no stretch over 100 ms",
                 kind: .latency, latencyBudgetMs: 50, params: [:]),
    ScenarioSpec(name: "needs-answer", summary: "Answer the focused ask, again and again: its column slides out (≤ 300 ms, transform and opacity) and the next takes its place.",
                 budget: "Answer an ask: the column slides out with no dropped frame", rule: "no late frame while the columns close up; no stretch over 16.7 ms; the answered column left, the rest kept their order, the next one leads and has the focus",
                 kind: .smooth, latencyBudgetMs: nil, params: ["answers": "3"]),
    ScenarioSpec(name: "needs-arrive", summary: "A new ask arrives while the reel is open, with the reel scrolled to a middle column: it joins at the end.",
                 budget: "A new ask: joins at the end, nothing moves", rule: "the new column is last, the leading column and its place in the window are unchanged; no late frame",
                 kind: .isolation, latencyBudgetMs: nil, params: ["arrivals": "3"]),
    ScenarioSpec(name: "needs-step", summary: "⌘J through the asks: in the reel it focuses the next column; outside it opens each ask's agent in its project, oldest first, round again.",
                 budget: "⌘J: first frame ≤ 50 ms", rule: "median latency from nextAsk() to the next frame ≤ 50 ms; the asks come oldest first, one at a time",
                 kind: .latency, latencyBudgetMs: 50, params: [:]),
    ScenarioSpec(name: "needs-empty", summary: "Answer every ask until \"Nothing needs you.\", then Esc back to where the reel was opened from.",
                 budget: "Answer an ask: the column slides out with no dropped frame", rule: "no late frame; the end state shows \"Nothing needs you.\"; Esc (a key event to the window) closes the reel and gives the focus back",
                 kind: .smooth, latencyBudgetMs: nil, params: [:]),
    ScenarioSpec(name: "needs-swipe", summary: "A recorded (or synthetic) trackpad gesture replayed into the Needs you reel's scroll view, as `swipe` does for the project reel.",
                 budget: "Reel scroll: no dropped frames at 120 Hz", rule: "no late frame while the reel moves; the content within 1 pt of the fingers (p95) with no stall; it lands on a column edge",
                 kind: .smooth, latencyBudgetMs: nil, params: ["gesture": "synthetic:flick-forward", "swipes": "4", "from": "0", "timestamps": "recorded", "deliver": "window"]),
  ]
  public static func spec(_ name: String) -> ScenarioSpec? { all.first { $0.name == name } }
  /// The scenarios `suite` runs, in order.
  public static let suite = ["open", "switch", "step", "jump", "fling", "burst", "typing", "resize", "follow", "palette-open", "palette-type", "palette-keys"]
  /// The fixture a scenario runs on unless told otherwise (Search ⌘K's need hundreds of searchable items).
  public static func defaultFixture(_ scenario: String) -> String? { scenario.hasPrefix("palette-") ? "search" : nil }
}

public enum Budgets {
  /// Judges a run against its scenario's rule. Scenario-specific checks (which views re-rendered, where the reel
  /// landed) come in through each rep's `checks`.
  public static func evaluate(_ spec: ScenarioSpec, reps: [RepResult], summary: Summary) -> BudgetVerdict {
    var reasons: [String] = []
    // "No late frame" is judged on late frame time (rate-invariant); reps from an older bench only have the count.
    func lateFrames() {
      if let h = summary.hitchTimeRatioMsPerS {
        if h.median > 0 { reasons.append("late frame time: median \(h.median) ms per second of scenario (max \(h.max)) at \(summary.steadyHz.median.clean) Hz; \(summary.lateFrames.median) late frames/rep, frame p99 \(summary.frameP99Ms.median) ms") }
      } else if summary.lateFrames.median > 0 {
        reasons.append("late frames: median \(summary.lateFrames.median) per rep (max \(summary.lateFrames.max)) at \(summary.steadyHz.median.clean) Hz; frame p99 \(summary.frameP99Ms.median) ms")
      }
    }
    switch spec.kind {
    case .latency:
      if let d = summary.latencyMs, let b = spec.latencyBudgetMs, d.median > b {
        reasons.append("median latency \(d.median) ms is over the \(Int(b)) ms budget (p95 \(d.p95) ms, n=\(d.n))")
      }
      if summary.latencyMs == nil { reasons.append("no latency was measured") }
      if summary.hangsOver100.max > 0 { reasons.append("a main-thread stretch over 100 ms in \(Int(summary.hangsOver100.max)) rep(s); longest \(summary.longestStretchMs.max) ms") }
    case .smooth:
      lateFrames()
      if spec.name == "resize" {
        if summary.hangsOver100.median > 0 { reasons.append("main-thread stretches over 100 ms: median \(summary.hangsOver100.median) per rep") }
      } else if summary.stretchesOver16.median > 0 {
        reasons.append("main-thread stretches over 16.7 ms: median \(summary.stretchesOver16.median) per rep (longest \(summary.longestStretchMs.median) ms)")
      }
    case .isolation:
      lateFrames()
    }
    // A replayed gesture: the content follows the fingers (Gestures.swift).
    reasons += Smoothness.budgetReasons(summary)
    // Checks fail the budget when they failed in most reps (one wild rep is noise, not a verdict).
    for name in summary.checksFailed {
      let failed = reps.filter { $0.checks.contains { $0.name == name && !$0.pass } }
      if failed.count * 2 > reps.count {
        let detail = failed.first?.checks.first { $0.name == name }?.detail ?? ""
        reasons.append("check '\(name)' failed in \(failed.count)/\(reps.count) reps: \(detail)")
      }
    }
    return BudgetVerdict(budget: spec.budget, rule: spec.rule, pass: reasons.isEmpty, reasons: reasons)
  }

  /// The frame and stretch metrics the bench has always compared; `Comparison` prints them as information (they no
  /// longer decide: the objective and the guards do).
  public static func metrics(for spec: ScenarioSpec) -> [(name: String, pick: (RepResult) -> Double?, floorPct: Double, absoluteFloor: Double)] {
    switch spec.kind {
    case .latency:
      return [("latencyMs", { Stats.median($0.latencies) }, 15, 3), ("longestStretchMs", { $0.mainThread.longestMs }, 25, 4)]
    case .smooth, .isolation:
      return [("lateFrames", { Double($0.frames.late) }, 25, 2), ("frameP95Ms", { $0.frames.p95Ms }, 15, 1),
              ("longestStretchMs", { $0.mainThread.longestMs }, 25, 4), ("stretchesOver16", { Double($0.mainThread.over16) }, 25, 2)]
    }
  }
}
