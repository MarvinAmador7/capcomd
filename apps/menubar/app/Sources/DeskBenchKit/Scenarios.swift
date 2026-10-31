import Foundation

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
  ]
  public static func spec(_ name: String) -> ScenarioSpec? { all.first { $0.name == name } }
  /// The scenarios `suite` runs, in order.
  public static let suite = ["open", "switch", "step", "jump", "fling", "burst", "typing", "resize", "follow"]
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
