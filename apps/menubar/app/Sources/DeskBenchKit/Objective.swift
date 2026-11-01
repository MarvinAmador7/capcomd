import Foundation
import PerfLoopProbe

// What `ab`, `compare` and `run --baseline` decide on (design/perf-loop/SPEC.md §5.1): one objective, lower is
// better, plus frame guards that must not get worse beyond their band. Every other metric is printed as information
// and never decides: wall-clock frame counts swing with the machine and the panel's rate, CPU time and instructions
// much less.

public enum Objective: String, Codable, Sendable, CaseIterable {
  /// Main-thread CPU ms per step (thread_info, summed over the stretches inside the steps).
  case cpu
  /// Instructions retired per step (proc_pid_rusage, process-wide): the least noisy, when the counters exist.
  case instructions
  /// Hitch time ratio: ms of late frame time per second of scenario.
  case frames
  /// The latency scenarios' own number (open, switch, follow).
  case latency

  public init?(argument s: String) {
    if let o = Objective(rawValue: s) { self = o; return }
    guard let o = Objective.allCases.first(where: { $0.metric == s }) else { return nil }
    self = o
  }

  /// The metric's name in results.
  public var metric: String {
    switch self {
    case .cpu: "mainThreadCpuMsPerStep"
    case .instructions: "instructionsPerStep"
    case .frames: "hitchTimeRatioMsPerS"
    case .latency: "latencyMs"
    }
  }

  /// SPEC §5.1: latency scenarios keep their latency; the rest climb on main-thread CPU.
  public static func `default`(for spec: ScenarioSpec) -> Objective { spec.kind == .latency ? .latency : .cpu }

  /// One rep's value, nil where the rep doesn't carry it (old results, counters reading zero, no latency step).
  public func value(_ r: RepResult) -> Double? {
    switch self {
    case .cpu: r.cpuMsPerStep
    case .instructions: r.instructionsPerStep
    case .frames: r.frames.hitchTimeRatioMsPerS
    case .latency: r.latencies.isEmpty ? nil : Stats.median(r.latencies)
    }
  }

  /// Smallest change worth calling (SPEC §5.1: a gain must be ≥ 5 % to count) and an absolute floor in the metric's units.
  var floors: (pct: Double, absolute: Double) {
    switch self {
    case .cpu: (5, 0.5)
    case .instructions: (5, 0)
    case .frames: (25, 2)
    case .latency: (15, 3)
    }
  }

  /// When the asked-for objective can't be used, the ones to try instead, in order: CPU, then late frame time.
  var fallbacks: [Objective] { [.cpu, .frames].filter { $0 != self } }

  /// Whether the number depends on where the bench draws a stretch's edges and which threads it counts (`measure`):
  /// CPU and instructions do; the display link's frame times and the commit-completion latencies don't.
  public var dependsOnMeasure: Bool { self == .cpu || self == .instructions }

  public func compare(baseline: [RepResult], candidate: [RepResult], role: String) -> Regression {
    var r = Regression(metric: metric, baseline: baseline.compactMap(value), candidate: candidate.compactMap(value), floorPct: floors.pct, absoluteFloor: floors.absolute)
    r.role = role
    return r
  }
}

/// How this bench measures (`RepResult.measure`; nil in results from before it = 1). 1: a stretch ran from
/// `afterWaiting` to `beforeWaiting` at observer order 0, so it ended before Core Animation's commit; CPU per step was
/// summed over the stretches that began inside a step; instructions were process-wide. 2: a stretch runs from the
/// first observer of a wake-up to the last before the thread sleeps (the commit and AppKit's display cycle included,
/// not cut at a run-loop exit); CPU and instructions per step are the main thread's own counters between the step's
/// start and end; the first step starts once the setup (rewinding the reel, building columns, warming threads) has
/// gone quiet. CPU and instructions from different measures are not compared.
public let currentMeasure = 2

/// The objective's medians across reps, for `Summary`.
public struct ObjectiveValue: Codable, Sendable, Equatable {
  public var name: String
  public var value: Double?
  public var dist: Dist?
  public init(_ o: Objective, reps: [RepResult]) {
    name = o.metric
    let xs = reps.compactMap(o.value)
    dist = xs.isEmpty ? nil : Dist(xs); value = dist?.median
  }
}

extension RepResult {
  /// Main-thread CPU per step: the steps' own counters (measure 2), or the stretches inside the steps (measure 1).
  public var cpuMsPerStep: Double? {
    guard !steps.isEmpty else { return nil }
    let own = steps.compactMap(\.cpuMs)
    if (measure ?? 1) >= 2, own.count == steps.count { return Stats.round(own.reduce(0, +) / Double(steps.count), 2) }
    return Stats.round(mainThread.cpuMs / Double(steps.count), 2)
  }
  /// Instructions retired during the steps, per step; nil unless every step has a non-zero count.
  public var instructionsPerStep: Double? {
    let xs = steps.compactMap(\.instructions)
    guard !steps.isEmpty, xs.count == steps.count, xs.reduce(0, +) > 0 else { return nil }
    return (Double(xs.reduce(0, +)) / Double(steps.count)).rounded()
  }
}

/// The outcome of comparing two sets of reps: the objective row, the guard rows, the information rows.
public struct Comparison: Codable, Sendable, Equatable {
  /// The objective actually used (it falls back to `cpu` when the asked-for one has no values).
  public var objective: String
  public var rows: [Regression]
  public var notes: [String]
  /// The objective or a guard got worse beyond its band.
  public var regression: Bool
  /// The objective got better beyond its band and no guard got worse.
  public var improvement: Bool
  public var guardsFailed: [String]

  /// Saved results (`compare`, `run --baseline`): the medians of the two sets of reps.
  public init(_ spec: ScenarioSpec, objective asked: Objective? = nil, baseline a: [RepResult], candidate b: [RepResult]) {
    self.init(spec, asked, a, b) { metric, pick, floorPct, absolute in
      Regression(metric: metric, baseline: a.compactMap(pick), candidate: b.compactMap(pick), floorPct: floorPct, absoluteFloor: absolute)
    }
  }

  /// `ab`: A/B pairs run back to back; every row is the paired verdict (`Regression(metric:pairs:)`).
  public init(_ spec: ScenarioSpec, objective asked: Objective? = nil, pairs: [(a: RepResult, b: RepResult)]) {
    self.init(spec, asked, pairs.map(\.a), pairs.map(\.b)) { metric, pick, floorPct, absolute in
      Regression(metric: metric, pairs: pairs.compactMap { p in pick(p.a).flatMap { x in pick(p.b).map { (a: x, b: $0) } } }, floorPct: floorPct, absoluteFloor: absolute)
    }
  }

  private init(_ spec: ScenarioSpec, _ asked: Objective?, _ a: [RepResult], _ b: [RepResult], row: (String, (RepResult) -> Double?, Double, Double) -> Regression) {
    var o = asked ?? .default(for: spec)
    var notes: [String] = []
    let ma = Set(a.map { $0.measure ?? 1 }), mb = Set(b.map { $0.measure ?? 1 })
    let sameMeasure = ma == mb && ma.count <= 1
    func has(_ x: Objective) -> Bool { !a.compactMap(x.value).isEmpty && !b.compactMap(x.value).isEmpty }
    func available(_ x: Objective) -> Bool { has(x) && (sameMeasure || !x.dependsOnMeasure) }
    func make(_ x: Objective, _ role: String) -> Regression { var r = row(x.metric, x.value, x.floors.pct, x.floors.absolute); r.role = role; return r }
    let measures = "bench measure \(ma.sorted().map(String.init).joined(separator: "/")) vs \(mb.sorted().map(String.init).joined(separator: "/"))"
    if !available(o) {
      let why = !has(o) ? "\(o.metric) is missing on \(a.compactMap(o.value).isEmpty ? "the baseline" : "the candidate") (counters off, an older bench, or no such step)"
        : "\(o.metric) isn't comparable across the two builds (\(measures): they draw stretches and count differently)"
      if let f = o.fallbacks.first(where: available) { notes.append("\(why): decided on \(f.metric) instead"); o = f }
      else { notes.append("\(why), and no other objective is measured the same way on both sides: no verdict") }
    }
    objective = o.metric
    var rows = [make(o, "objective")]
    if !available(o) { rows[0].regression = false; rows[0].improvement = false; rows[0].reason = "\(o.metric): not comparable (\(measures))" }
    // Guards: frames may not get worse beyond their band (SPEC §5.1), whatever the objective.
    if o != .frames, available(.frames) { rows.append(make(.frames, "guard")) }
    var longest = row("longestStretchMs", { $0.mainThread.longestMs }, 25, 4)
    longest.role = sameMeasure ? "guard" : "info"; rows.append(longest)
    if !sameMeasure { notes.append("longestStretchMs is information only: \(measures) draw stretches differently") }
    // A replayed gesture's smoothness (swipe): error and stalls guard, jerk informs (Gestures.swift says why).
    rows += Smoothness.comparisonRows(a, b, row: row)
    // Information: the other objectives and the frame counts the bench has always printed.
    for x in Objective.allCases where x != o && !rows.contains(where: { $0.metric == x.metric }) && available(x) { rows.append(make(x, "info")) }
    for m in Budgets.metrics(for: spec) where !rows.contains(where: { $0.metric == m.name }) {
      var r = row(m.name, m.pick, m.floorPct, m.absoluteFloor)
      r.role = "info"; rows.append(r)
    }
    self.rows = rows; self.notes = notes
    guardsFailed = rows.filter { $0.role == "guard" && $0.regression }.map(\.metric)
    regression = rows.contains { $0.decides && $0.regression }
    improvement = rows.first!.improvement && !regression
  }
}
