import Foundation

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

  /// When the asked-for objective has no values on a side, the one to use instead.
  var fallback: Objective? { self == .cpu ? nil : .cpu }

  public func compare(baseline: [RepResult], candidate: [RepResult], role: String) -> Regression {
    var r = Regression(metric: metric, baseline: baseline.compactMap(value), candidate: candidate.compactMap(value), floorPct: floors.pct, absoluteFloor: floors.absolute)
    r.role = role
    return r
  }
}

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
  /// Main-thread CPU over the steps' stretches, per step.
  public var cpuMsPerStep: Double? { steps.isEmpty ? nil : Stats.round(mainThread.cpuMs / Double(steps.count), 2) }
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

  public init(_ spec: ScenarioSpec, objective asked: Objective? = nil, baseline a: [RepResult], candidate b: [RepResult]) {
    var o = asked ?? .default(for: spec)
    var notes: [String] = []
    func available(_ x: Objective) -> Bool { !a.compactMap(x.value).isEmpty && !b.compactMap(x.value).isEmpty }
    if !available(o), let f = o.fallback, available(f) {
      notes.append("\(o.metric) is missing on \(a.compactMap(o.value).isEmpty ? "the baseline" : "the candidate") (counters off, an older bench, or no such step): decided on \(f.metric) instead")
      o = f
    }
    objective = o.metric
    var rows = [o.compare(baseline: a, candidate: b, role: "objective")]
    // Guards: frames may not get worse beyond their band (SPEC §5.1), whatever the objective.
    if o != .frames, available(.frames) { rows.append(Objective.frames.compare(baseline: a, candidate: b, role: "guard")) }
    var longest = Regression(metric: "longestStretchMs", baseline: a.map(\.mainThread.longestMs), candidate: b.map(\.mainThread.longestMs), floorPct: 25, absoluteFloor: 4)
    longest.role = "guard"; rows.append(longest)
    // Information: the other objectives and the frame counts the bench has always printed.
    for x in Objective.allCases where x != o && !rows.contains(where: { $0.metric == x.metric }) && available(x) { rows.append(x.compare(baseline: a, candidate: b, role: "info")) }
    for m in Budgets.metrics(for: spec) where !rows.contains(where: { $0.metric == m.name }) {
      var r = Regression(metric: m.name, baseline: a.compactMap(m.pick), candidate: b.compactMap(m.pick), floorPct: m.floorPct, absoluteFloor: m.absoluteFloor)
      r.role = "info"; rows.append(r)
    }
    self.rows = rows; self.notes = notes
    guardsFailed = rows.filter { $0.role == "guard" && $0.regression }.map(\.metric)
    regression = rows.contains { $0.decides && $0.regression }
    improvement = rows.first!.improvement && !regression
  }
}
