import Foundation

// The bench's output schema (`deskbench.result/1`). Everything the bench prints with --json is one of these; a field is
// never renamed within a schema version, only added. DESKBENCH.md documents how to read them.

public let resultSchema = "deskbench.result/1"

/// Frame timing from the display link while a step ran. A tick is one display-link callback on the main thread; an
/// interval longer than 1.5 × the nominal frame is "late" (the main thread didn't service that vsync), and the frames it
/// spanned beyond the first are "dropped". With the main thread idle the display still refreshes, so this measures
/// what the main thread could have drawn, not what Core Animation did: `profile` has the compositor's own hitch list.
public struct FrameStats: Codable, Sendable, Equatable {
  public var ticks: Int
  /// The screen's top rate.
  public var nominalHz: Double
  /// The rate the display actually ran at during the window: the fastest quartile of intervals, snapped to a refresh
  /// rate the panel uses. A ProMotion panel idles at 24–48 Hz and may animate at 60; a late frame is judged against this,
  /// so a display running at 60 Hz is not 60 "dropped" frames a second. `lateAtNominal` counts against the top rate.
  public var steadyHz: Double
  public var measuredHz: Double
  public var p50Ms: Double
  public var p95Ms: Double
  public var p99Ms: Double
  public var maxMs: Double
  public var late: Int
  public var lateAtNominal: Int
  public var dropped: Int
  /// late / ticks.
  public var lateRatio: Double

  public init(intervalsMs xs: [Double], nominalHz hz: Double) {
    ticks = xs.count; nominalHz = hz
    let nominal = 1000 / hz
    p50Ms = Stats.round(Stats.median(xs), 2); p95Ms = Stats.round(Stats.percentile(xs, 95), 2); p99Ms = Stats.round(Stats.percentile(xs, 99), 2)
    maxMs = Stats.round(xs.max() ?? 0, 2)
    measuredHz = p50Ms > 0 ? Stats.round(1000 / p50Ms, 1) : 0
    let p25 = Stats.percentile(xs, 25)
    let rates: [Double] = [24, 30, 40, 48, 60, 80, 90, 120].filter { $0 <= hz + 0.5 }
    steadyHz = xs.isEmpty || p25 <= 0 ? hz : rates.min { abs(1000 / $0 - p25) < abs(1000 / $1 - p25) } ?? hz
    let steady = 1000 / steadyHz
    late = xs.filter { $0 > steady * 1.5 }.count
    lateAtNominal = xs.filter { $0 > nominal * 1.5 }.count
    dropped = xs.reduce(0) { $0 + max(0, Int(($1 / steady).rounded()) - 1) }
    lateRatio = ticks == 0 ? 0 : Stats.round(Double(late) / Double(ticks), 4)
  }
  public static let empty = FrameStats(intervalsMs: [], nominalHz: 60)
}

/// What the main thread did between waits: each run-loop awakening is one stretch. A stretch over a frame (16.7 ms at
/// 60 Hz, 8.3 at 120) is a dropped frame if anything animated; over 100 ms the user feels it; over 250 ms Instruments
/// calls it a hang.
public struct MainThreadStats: Codable, Sendable, Equatable {
  public var stretches: Int
  /// Wall time awake.
  public var busyMs: Double
  /// CPU time the main thread got while awake. Far below `busyMs` means it was preempted: the machine, not the work.
  public var cpuMs: Double
  public var longestMs: Double
  public var over8: Int
  public var over16: Int
  public var over33: Int
  public var over100: Int
  public var over250: Int
  public init(stretchesMs xs: [Double], cpuMs cpu: [Double] = []) {
    stretches = xs.count; busyMs = Stats.round(xs.reduce(0, +), 1); longestMs = Stats.round(xs.max() ?? 0, 2)
    cpuMs = Stats.round(cpu.reduce(0, +), 1)
    over8 = xs.filter { $0 > 8.4 }.count; over16 = xs.filter { $0 > 16.7 }.count; over33 = xs.filter { $0 > 33.4 }.count
    over100 = xs.filter { $0 > 100 }.count; over250 = xs.filter { $0 > 250 }.count
  }
  public static let empty = MainThreadStats(stretchesMs: [])
}

/// One long main-thread stretch and what SwiftUI evaluated inside it: the bench's substitute for a stack sample.
public struct Stretch: Codable, Sendable, Equatable {
  public var step: String
  public var atMs: Double
  public var durationMs: Double
  /// CPU time of the main thread inside the stretch.
  public var cpuMs: Double
  /// View bodies evaluated during the stretch, by view type ("Column", "EntryRow", …).
  public var bodies: [String: Int]
  public init(step: String, atMs: Double, durationMs: Double, cpuMs: Double, bodies: [String: Int]) { self.step = step; self.atMs = atMs; self.durationMs = durationMs; self.cpuMs = cpuMs; self.bodies = bodies }
}

/// A check a scenario makes beyond timing (which views re-rendered, where the reel landed).
public struct Check: Codable, Sendable, Equatable {
  public var name: String
  public var pass: Bool
  public var detail: String
  public init(_ name: String, _ pass: Bool, _ detail: String) { self.name = name; self.pass = pass; self.detail = detail }
}

/// One step of a scenario (one jump, one project switch, one burst).
public struct StepResult: Codable, Sendable, Equatable {
  public var name: String
  public var atMs: Double
  public var durationMs: Double
  /// For latency steps: from the state change to the completion of the Core Animation commit that showed it.
  public var latencyMs: Double?
  /// For scroll steps: from the request to the reel standing still.
  public var settleMs: Double?
  public var frames: FrameStats
  public var mainThread: MainThreadStats
  public var bodies: [String: Int]
  public var notes: [String]
  public init(name: String, atMs: Double, durationMs: Double, latencyMs: Double? = nil, settleMs: Double? = nil, frames: FrameStats, mainThread: MainThreadStats, bodies: [String: Int], notes: [String] = []) {
    self.name = name; self.atMs = atMs; self.durationMs = durationMs; self.latencyMs = latencyMs; self.settleMs = settleMs
    self.frames = frames; self.mainThread = mainThread; self.bodies = bodies; self.notes = notes
  }
}

/// Whether the window was in a state where SwiftUI flushes promptly. Inactive apps flush timer-driven state late
/// (seconds, at times); the bench activates itself, and says here whether that held.
public struct WindowState: Codable, Sendable, Equatable {
  public var appActive: Bool
  public var keyWindow: Bool
  public var visible: Bool
  public var occluded: Bool
  public var activityAsserted: Bool
  public var frame: [Double]
  public var backingScale: Double
  public init(appActive: Bool, keyWindow: Bool, visible: Bool, occluded: Bool, activityAsserted: Bool, frame: [Double], backingScale: Double) {
    self.appActive = appActive; self.keyWindow = keyWindow; self.visible = visible; self.occluded = occluded; self.activityAsserted = activityAsserted; self.frame = frame; self.backingScale = backingScale
  }
  public var trustworthy: Bool { appActive && keyWindow && visible && !occluded }
}

public struct RepResult: Codable, Sendable, Equatable {
  public var index: Int
  /// "A" / "B" in an ab run; nil otherwise.
  public var variant: String?
  public var steps: [StepResult]
  public var frames: FrameStats
  public var mainThread: MainThreadStats
  public var bodies: [String: Int]
  public var checks: [Check]
  public var worstStretches: [Stretch]
  public var window: WindowState?
  public init(index: Int, variant: String? = nil, steps: [StepResult], frames: FrameStats, mainThread: MainThreadStats, bodies: [String: Int], checks: [Check], worstStretches: [Stretch], window: WindowState?) {
    self.index = index; self.variant = variant; self.steps = steps; self.frames = frames; self.mainThread = mainThread; self.bodies = bodies; self.checks = checks; self.worstStretches = worstStretches; self.window = window
  }
  public var latencies: [Double] { steps.compactMap(\.latencyMs) }
  public var settles: [Double] { steps.compactMap(\.settleMs) }
}

/// Medians across repetitions: the numbers to quote.
public struct Summary: Codable, Sendable, Equatable {
  public var reps: Int
  public var latencyMs: Dist?
  public var settleMs: Dist?
  public var frameP95Ms: Dist
  public var frameP99Ms: Dist
  public var lateFrames: Dist
  public var droppedFrames: Dist
  public var steadyHz: Dist
  public var longestStretchMs: Dist
  /// CPU share of the main thread's awake time (1.0 = it had the core to itself).
  public var mainThreadCpuShare: Double
  public var stretchesOver16: Dist
  public var hangsOver100: Dist
  /// Median body count per view type across reps.
  public var bodies: [String: Double]
  public var checksFailed: [String]
  public init(reps rs: [RepResult]) {
    reps = rs.count
    let lat = rs.flatMap(\.latencies); latencyMs = lat.isEmpty ? nil : Dist(lat)
    let set = rs.flatMap(\.settles); settleMs = set.isEmpty ? nil : Dist(set)
    frameP95Ms = Dist(rs.map(\.frames.p95Ms)); frameP99Ms = Dist(rs.map(\.frames.p99Ms))
    lateFrames = Dist(rs.map { Double($0.frames.late) }); droppedFrames = Dist(rs.map { Double($0.frames.dropped) })
    steadyHz = Dist(rs.map(\.frames.steadyHz))
    longestStretchMs = Dist(rs.map(\.mainThread.longestMs)); stretchesOver16 = Dist(rs.map { Double($0.mainThread.over16) })
    let busy = rs.reduce(0.0) { $0 + $1.mainThread.busyMs }, cpu = rs.reduce(0.0) { $0 + $1.mainThread.cpuMs }
    mainThreadCpuShare = busy > 0 ? Stats.round(cpu / busy, 2) : 1
    hangsOver100 = Dist(rs.map { Double($0.mainThread.over100) })
    var b: [String: [Double]] = [:]
    for r in rs { for (k, v) in r.bodies { b[k, default: []].append(Double(v)) } }
    bodies = b.mapValues { Stats.median($0) }
    checksFailed = Array(Set(rs.flatMap { $0.checks.filter { !$0.pass }.map(\.name) })).sorted()
  }
}

/// The SPEC §1 budget the scenario maps to and whether the run met it.
public struct BudgetVerdict: Codable, Sendable, Equatable {
  public var budget: String
  public var rule: String
  public var pass: Bool
  public var reasons: [String]
  public init(budget: String, rule: String, pass: Bool, reasons: [String]) { self.budget = budget; self.rule = rule; self.pass = pass; self.reasons = reasons }
}

/// Machine conditions at the time of the run. Numbers from a loaded machine are not comparable with numbers from a
/// quiet one; `Noise` says which this was.
public struct Machine: Codable, Sendable, Equatable {
  public var model: String
  public var cores: Int
  public var memoryGB: Double
  public var os: String
  public var screenHz: Double
  public var loadAvg1: Double
  public var loadPerCore: Double
  public var thermalState: String
  public var lowPowerMode: Bool
  /// Processes above 25 % CPU other than the bench itself, "name pcpu".
  public var heavyProcesses: [String]
  public init(model: String, cores: Int, memoryGB: Double, os: String, screenHz: Double, loadAvg1: Double, thermalState: String, lowPowerMode: Bool, heavyProcesses: [String]) {
    self.model = model; self.cores = cores; self.memoryGB = memoryGB; self.os = os; self.screenHz = screenHz; self.loadAvg1 = loadAvg1
    loadPerCore = cores > 0 ? Stats.round(loadAvg1 / Double(cores), 2) : 0
    self.thermalState = thermalState; self.lowPowerMode = lowPowerMode; self.heavyProcesses = heavyProcesses
  }
}

/// The noise floor measured before the scenario: the window shown and idle for a second. Late ticks while nothing
/// happens are the machine's, not the reel's.
public struct Noise: Codable, Sendable, Equatable {
  public var idleTicks: Int
  public var idleLate: Int
  public var idleLongestStretchMs: Double
  public var quiet: Bool
  public var reasons: [String]
  public init(idle: FrameStats, idleMain: MainThreadStats, machine: Machine, window: WindowState?) {
    idleTicks = idle.ticks; idleLate = idle.late; idleLongestStretchMs = idleMain.longestMs
    var r: [String] = []
    if idle.ticks > 0, Double(idle.late) / Double(idle.ticks) > 0.02 { r.append("\(idle.late) of \(idle.ticks) idle frames were late before the scenario started") }
    if machine.loadPerCore > 0.75 { r.append("load average \(machine.loadAvg1) on \(machine.cores) cores") }
    if machine.thermalState != "nominal" { r.append("thermal state \(machine.thermalState)") }
    if machine.lowPowerMode { r.append("Low Power Mode is on") }
    if !machine.heavyProcesses.isEmpty { r.append("busy processes: " + machine.heavyProcesses.joined(separator: ", ")) }
    if let w = window, !w.trustworthy { r.append("the window was not active, key and unoccluded (SwiftUI flushes late in the background)") }
    if idleMain.busyMs > 0, idleMain.cpuMs / idleMain.busyMs < 0.5 { r.append("the main thread got \(Int(idleMain.cpuMs / idleMain.busyMs * 100)) % of a core while idle: it is being preempted") }
    quiet = r.isEmpty; reasons = r
  }
}

public struct ToolInfo: Codable, Sendable, Equatable {
  public var name = "CapcomdDeskBench"
  public var version: String
  public var commit: String?
  public var configuration: String
  public init(version: String, commit: String?, configuration: String) { self.version = version; self.commit = commit; self.configuration = configuration }
}

/// Everything one `run` prints.
public struct BenchResult: Codable, Sendable, Equatable {
  public var schema = resultSchema
  public var tool: ToolInfo
  public var scenario: String
  public var fixture: String
  public var params: [String: String]
  public var startedAt: String
  public var durationMs: Double
  public var machine: Machine
  public var noise: Noise
  public var window: WindowState?
  public var reps: [RepResult]
  public var summary: Summary
  public var budget: BudgetVerdict
  public var comparison: [Regression]?
  /// pass | fail | untrusted (a failed budget on a noisy machine: run it again when the machine is quiet).
  public var verdict: String
  public var exitCode: Int
  /// Where the window PNGs and view dumps went, if asked for.
  public var artifacts: [String]
  public init(tool: ToolInfo, scenario: String, fixture: String, params: [String: String], startedAt: String, durationMs: Double, machine: Machine, noise: Noise, window: WindowState?,
              reps: [RepResult], summary: Summary, budget: BudgetVerdict, comparison: [Regression]?, artifacts: [String]) {
    self.tool = tool; self.scenario = scenario; self.fixture = fixture; self.params = params; self.startedAt = startedAt; self.durationMs = durationMs
    self.machine = machine; self.noise = noise; self.window = window; self.reps = reps; self.summary = summary; self.budget = budget; self.comparison = comparison
    self.artifacts = artifacts
    let regressed = comparison?.contains { $0.regression } ?? false
    if budget.pass && !regressed { verdict = "pass"; exitCode = 0 }
    else if !noise.quiet { verdict = "untrusted"; exitCode = ExitCode.untrusted }
    else if !budget.pass { verdict = "fail"; exitCode = ExitCode.budget }
    else { verdict = "regression"; exitCode = ExitCode.regression }
  }
}

/// Exit codes, stable: a script can branch on them.
public enum ExitCode {
  public static let ok = 0
  public static let usage = 1
  public static let harness = 2
  public static let budget = 3
  public static let regression = 4
  public static let untrusted = 5
}

public enum JSONOut {
  public static func encode<T: Encodable>(_ v: T) -> String {
    let e = JSONEncoder(); e.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    return String(decoding: try! e.encode(v), as: UTF8.self)
  }
  public static func decode<T: Decodable>(_ t: T.Type, from d: Data) throws -> T { try JSONDecoder().decode(t, from: d) }
}
