import AppKit
import Foundation
import CapcomdDesk
import DeskBenchKit

/// Runs one scenario for N repetitions in this process and builds the result.
@MainActor enum Runner {
  /// What this binary is, from the stamp Plugins/BuildStamp compiled into it (never the cwd's git: a copied binary
  /// would report whatever checkout it was run from).
  static let build: BuildInfo = {
    #if DEBUG
    let cfg = "debug"
    #else
    let cfg = "release"
    #endif
    return BuildInfo(stamp: generatedBuildStamp, configuration: cfg, hash: BuildInfo.sha256(file: Commands.selfPath()))
  }()

  static func tool() -> ToolInfo { ToolInfo(version: "1", commit: build.commit, configuration: build.configuration, build: build) }

  /// Process start → now, from the kernel's record of this process.
  static func sinceProcessStartMs() -> Double? {
    var info = kinfo_proc(); var size = MemoryLayout<kinfo_proc>.size
    var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, ProcessInfo.processInfo.processIdentifier]
    guard sysctl(&mib, 4, &info, &size, nil, 0) == 0 else { return nil }
    let tv = info.kp_proc.p_starttime
    let start = Double(tv.tv_sec) + Double(tv.tv_usec) / 1e6
    return (Date().timeIntervalSince1970 - start) * 1000
  }

  struct Options {
    var scenario: String
    var fixture = "crew17"
    var reps = 3
    var params: [String: String] = [:]
    var width: CGFloat = 1440, height: CGFloat = 900
    var activate = true
    var quietCheck = true
    var artifacts: URL?
    var baseline: URL?
    var waitFor: URL?
    var holdSeconds: Double = 0
    var variant: String?
    var host = "window"
    /// A profiler is attached: the result says so and is never compared.
    var profiled = false
    var objective: Objective?
  }

  static func run(_ o: Options) async -> Result<BenchResult, CLIError> {
    guard let spec = Scenarios.spec(o.scenario) else { return .failure(.usage("unknown scenario '\(o.scenario)'; see `deskbench list`")) }
    guard let world = Fixtures.make(o.fixture) else { return .failure(.usage(Fixtures.problem(o.fixture) ?? "unknown fixture '\(o.fixture)'; see `deskbench list fixtures`")) }
    var params = spec.params; for (k, v) in o.params { params[k] = v }
    let startedAt = ISO8601DateFormatter().string(from: Date())
    let began = CACurrentMediaTime()
    let h = Harness.current ?? Harness(world: world)
    let size = CGSize(width: o.width, height: o.height)
    var artifacts: [String] = []
    var repResults: [RepResult] = []
    var runParams = params
    runParams["fixtureLoadMs"] = String(Stats.round(h.fixtureLoadMs, 1))
    runParams["window"] = "\(Int(o.width))x\(Int(o.height))"
    runParams["activate"] = String(o.activate)
    runParams["host"] = h.hostName

    // The window, the noise floor, then (for profile) the wait for the parent to attach.
    var noiseFrames = FrameStats.empty, noiseMain = MainThreadStats.empty
    if spec.name == "open" {
      // open makes its own windows; the noise floor comes from the first one after its measurement.
    } else {
      await h.sceneWindowReady()
      h.showWindow(size: size, activate: o.activate)
      _ = await h.nextCommit()
      _ = await h.ensureActive(o.activate)
      await h.sleep(ms: 500)   // warming finishes; the first layout settles
      (noiseFrames, noiseMain) = await h.idle(seconds: o.quietCheck ? 1.0 : 0.3)
    }
    if let wf = o.waitFor {
      FileHandle.standardError.write(Data("waiting for \(wf.path) (attach a profiler to pid \(ProcessInfo.processInfo.processIdentifier))\n".utf8))
      while !FileManager.default.fileExists(atPath: wf.path) { await h.sleep(ms: 50) }
    }
    var drive = Drive(h: h, params: params, world: world)
    // `open` needs a fresh window per rep: a hand-made one, even when the bench runs as a scene (its window stays hidden).
    let wasScene = h.sceneHosted
    if spec.name == "open" { h.sceneHosted = false }
    defer { h.sceneHosted = wasScene }
    let repStart = h.mark()
    for rep in 0..<max(1, o.reps) {
      let m = h.mark()
      let samplerMark = h.sampler?.mark()
      let (steps, checks): ([StepResult], [Check])
      switch spec.name {
      case "open": (steps, checks) = await drive.open(rep: rep, size: size, activate: o.activate)
      case "switch": (steps, checks) = await drive.switchProjects()
      case "step": (steps, checks) = await drive.step()
      case "jump": (steps, checks) = await drive.jump()
      case "fling": (steps, checks) = await drive.fling()
      case "swipe": (steps, checks) = await drive.swipe()
      case "burst": (steps, checks) = await drive.burst()
      case "typing": (steps, checks) = await drive.typing()
      case "resize": (steps, checks) = await drive.resize()
      case "follow": (steps, checks) = await drive.follow()
      default: return .failure(.usage("scenario '\(spec.name)' has no driver"))
      }
      if spec.name == "open", rep == 0 {
        _ = await h.ensureActive(o.activate)
        if let ms = sinceProcessStartMs() { runParams["processLaunchToFirstFrameMs"] = String(Stats.round(ms - (steps.first?.durationMs ?? 0) + (steps.first?.latencyMs ?? 0), 0)) }
        (noiseFrames, noiseMain) = await h.idle(seconds: o.quietCheck ? 1.0 : 0.3)
      }
      // Whole-rep stats cover the steps only (not the pauses between them), so idle ticks don't dilute the frame numbers.
      var its: [Double] = [], st: [Double] = [], cpu: [Double] = []
      let stepWindows = steps.map { ($0.atMs, $0.atMs + $0.durationMs) }
      let allTicks = h.ticks[m.tick...]
      for (a, b) in zip(allTicks.dropFirst(), allTicks) where stepWindows.contains(where: { b >= $0.0 && a <= $0.1 }) { its.append(a - b) }
      // A stretch counts when it overlaps a step: the one in which a step starts began before it.
      for s in h.stretches[m.stretch...] where stepWindows.contains(where: { s.at <= $0.1 && s.at + s.dur >= $0.0 }) { st.append(s.dur); cpu.append(s.cpu) }
      var bodies: [String: Int] = [:]
      for s in steps { for (k, v) in s.bodies { bodies[k, default: 0] += v } }
      let worst = h.worstStretches(from: m.stretch, steps: steps)
      repResults.append(RepResult(index: rep, variant: o.variant, steps: steps, frames: FrameStats(intervalsMs: its, nominalHz: h.nominalHz),
                                  mainThread: MainThreadStats(stretchesMs: st, cpuMs: cpu), bodies: bodies, checks: checks, worstStretches: worst, window: h.windowState()))
      repResults[repResults.count - 1].measure = currentMeasure
      if let s = h.sampler, let sm = samplerMark { repResults[repResults.count - 1].sampler = s.stats(since: sm) }
      // Correctness guards (Guards.swift), when asked for: after the rep's numbers, so they cost the objective nothing.
      if let g = await GuardPhase.after(rep: rep, scenario: spec.name, steps: steps, h: h, label: o.variant) { repResults[repResults.count - 1].guards = g }
      if let dir = o.artifacts { artifacts += h.snapshot(into: dir, name: "\(spec.name)-rep\(rep)") }
      await h.sleep(ms: 200)
    }
    _ = repStart
    // `profile` stops its recording here, while the window holds (no fixed time limit cutting the run short).
    if let wf = o.waitFor { FileManager.default.createFile(atPath: wf.path + ".done", contents: Data()) }
    let summary = Summary(reps: repResults, objective: o.objective ?? .default(for: spec))
    let machine = MachineInfo.capture(screenHz: h.nominalHz)
    let windowState = h.windowState()
    let noise = Noise(idle: noiseFrames, idleMain: noiseMain, machine: machine, window: windowState)
    let budget = Budgets.evaluate(spec, reps: repResults, summary: summary)
    var comparison: [Regression]?
    if let b = o.baseline {
      do {
        let base = try JSONOut.decode(BenchResult.self, from: Data(contentsOf: b))
        guard base.scenario == spec.name else { return .failure(.usage("baseline is for scenario '\(base.scenario)', not '\(spec.name)'")) }
        if base.profiled == true || o.profiled { return .failure(.refused("a profiled run is never compared (the profiler's cost is in its numbers): record the baseline and this run without one")) }
        comparison = Comparison(spec, objective: o.objective, baseline: base.reps, candidate: repResults).rows
      } catch { return .failure(.harness("couldn't read the baseline: \(error)")) }
    }
    if o.holdSeconds > 0 { await h.sleep(ms: o.holdSeconds * 1000) }
    var result = BenchResult(tool: tool(), scenario: spec.name, fixture: o.fixture, params: runParams, startedAt: startedAt, durationMs: Stats.round((CACurrentMediaTime() - began) * 1000, 0),
                             machine: machine, noise: noise, window: windowState, reps: repResults, summary: summary, budget: budget, comparison: comparison, artifacts: artifacts, profiled: o.profiled)
    result.knobs = DeskKnobs.vector
    h.closeWindow()
    return .success(result)
  }
}

enum CLIError: Error, CustomStringConvertible {
  case usage(String), harness(String), refused(String)
  var description: String { switch self { case .usage(let s), .harness(let s), .refused(let s): s } }
  var code: Int { switch self { case .usage: ExitCode.usage; case .harness: ExitCode.harness; case .refused: ExitCode.refused } }
}

/// Subcommands that spawn this executable again (profile, ab) and the pure ones (compare, explain, list).
enum Commands {
  static func selfPath() -> String { Bundle.main.executablePath ?? CommandLine.arguments[0] }

  /// Runs `exe run …` and decodes its JSON.
  static func child(_ exe: String, _ args: [String], env: [String: String] = [:], onStart: ((Process) -> Void)? = nil) throws -> (BenchResult?, Int32, String) {
    let p = Process(); p.executableURL = URL(fileURLWithPath: exe); p.arguments = args
    var e = ProcessInfo.processInfo.environment; for (k, v) in env { e[k] = v }; p.environment = e
    let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.standardError
    try p.run(); onStart?(p)
    let data = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    let text = String(decoding: data, as: UTF8.self)
    return ((try? JSONOut.decode(BenchResult.self, from: data)), p.terminationStatus, text)
  }

  /// How `ab` runs its pairs (`--order`, `--seed`, `--pause-ms`, `--quiet-wait`, `--quiet-busy`, `--sampler`).
  struct ABOptions {
    var reps = 5
    /// random: each pair's first side drawn from a seeded shuffle with as many AB as BA pairs (one more of either
    /// when the count is odd); abba: AB BA AB BA …
    var order = "random"
    var seed: UInt64?
    /// After each run, before the quiet check: the window torn down, the last child's teardown and our decode done.
    var pauseMs = 1500.0
    /// Before each run, wait up to this long for the machine to be quiet (then run anyway, and say so).
    var quietWaitS = 10.0
    /// Quiet: at most this share of all cores busy over half a second, and no compiler or linker running.
    var quietBusyPct = 30.0
    /// The children's in-process sampler (off by default: it costs ~1 % and older builds don't have it).
    var sampler = false
  }

  /// A side of one pair, as `ab` ran it.
  struct ABRun: Codable {
    var pair: Int
    var side: String
    /// 1 or 2: which of the pair ran first.
    var position: Int
    /// Share of all cores busy (other processes: none of ours runs then) over the last half second before the run.
    var busyPct: Double
    /// Compilers and linkers running then (another agent's `swift build`, say).
    var builds: [String]
    var waitedS: Double
    var quiet: Bool
    var exit: Int32
    /// The objective's value for this run (filled in once the objective is known).
    var objective: Double?
  }

  /// A and B in pairs, one process each, `reps` pairs; within a pair the first side is counterbalanced (seeded, recorded),
  /// every run waits for a settle pause and a quiet machine, and the verdict is paired (Regression(metric:pairs:)): the
  /// per-pair differences against their own spread, and Mann-Whitney U on the two sides. `envA` and `envB` go into each
  /// side's environment (PERFLOOP_KNOBS: two knob settings of one binary).
  static func ab(a: String, b: String, scenario: String, fixture: String, params: [String], activate: Bool = true, objective: Objective? = nil, options o: ABOptions = ABOptions(),
                 envA: [String: String] = [:], envB: [String: String] = [:]) throws -> (ABResult, Int) {
    guard let spec = Scenarios.spec(scenario) else { throw CLIError.usage("unknown scenario '\(scenario)'") }
    guard ["random", "abba"].contains(o.order) else { throw CLIError.usage("--order must be random or abba") }
    let seed = o.seed ?? UInt64.random(in: 1...999_999)
    let order = PairOrder.draw(pairs: o.reps, mode: o.order, seed: seed)
    var got: [Int: [String: RepResult]] = [:]
    var runs: [ABRun] = []
    var failures: [String] = []
    var builds: [String: BuildInfo] = [:], knobs: [String: [String: String]] = [:]
    let env = o.sampler ? [:] : ["DESKBENCH_SAMPLER": "off"]
    for (i, first) in order.enumerated() {
      let labels: [String] = first == "AB" ? ["A", "B"] : ["B", "A"]   // typed: older Swift can't infer the ternary here
      for (pos, label) in labels.enumerated() {
        let exe = label == "A" ? a : b
        var args = ["run", scenario, "--fixture", fixture, "--reps", "1", "--json", "--quiet-check", "0", "--variant", label]
        for p in params { args += ["--set", p] }
        if !activate { args.append("--no-activate") }
        let q = Quiet.wait(pauseMs: o.pauseMs, maxS: o.quietWaitS, busyPct: o.quietBusyPct)
        FileHandle.standardError.write(Data("ab: pair \(i + 1)/\(order.count) \(first) · \(label)\(q.quiet ? "" : "  (not quiet after \(Int(q.waitedS)) s: \(q.busyPct) % busy\(q.builds.isEmpty ? "" : ", " + q.builds.joined(separator: ", ")))")\n".utf8))
        let (r, code, text) = try child(exe, args, env: env.merging(label == "A" ? envA : envB) { $1 })
        runs.append(ABRun(pair: i, side: label, position: pos + 1, busyPct: q.busyPct, builds: q.builds, waitedS: q.waitedS, quiet: q.quiet, exit: code))
        guard let r, let rep = r.reps.first else { failures.append("\(label) pair \(i + 1): exit \(code): \(text.prefix(300))"); continue }
        got[i, default: [:]][label] = rep
        if let b = r.tool.build { builds[label] = b }
        if let k = r.knobs { knobs[label] = k }
      }
    }
    let ra = order.indices.compactMap { got[$0]?["A"] }, rb = order.indices.compactMap { got[$0]?["B"] }
    let pairs = order.indices.compactMap { i in got[i].flatMap { g in g["A"].flatMap { x in g["B"].map { (a: x, b: $0) } } } }
    let c = pairs.isEmpty ? nil : Comparison(spec, objective: objective, pairs: pairs)
    let used = c.flatMap { Objective(argument: $0.objective) } ?? objective ?? .default(for: spec)
    for k in runs.indices { runs[k].objective = got[runs[k].pair]?[runs[k].side].flatMap(used.value) }
    // The order effect: how much the second run of a pair differed from the first, whichever build it was.
    var orderEffect: [Double] = []
    for i in order.indices {
      let rs = runs.filter { $0.pair == i }.sorted { $0.position < $1.position }
      if rs.count == 2, let x = rs[0].objective, let y = rs[1].objective, x != 0 { orderEffect.append((y - x) / abs(x) * 100) }
    }
    var notes = c?.notes ?? []
    if pairs.count < order.count { notes.append("\(order.count - pairs.count) of \(order.count) pairs lost a side (see failures): the verdict uses the \(pairs.count) complete ones") }
    let noisy = runs.filter { !$0.quiet }
    if !noisy.isEmpty { notes.append("\(noisy.count) of \(runs.count) runs started on a busy machine (> \(Int(o.quietBusyPct)) % of the cores, or a build running) after waiting \(Int(o.quietWaitS)) s") }
    let res = ABResult(scenario: scenario, fixture: fixture, a: a, b: b, repsPerSide: o.reps, summaryA: Summary(reps: ra, objective: used), summaryB: Summary(reps: rb, objective: used),
                       comparison: c?.rows ?? [], failures: failures, regression: c?.regression ?? false, improvement: c?.improvement ?? false,
                       objective: used.metric, guardsFailed: c?.guardsFailed ?? [], notes: notes, buildA: ra.isEmpty ? nil : builds["A"], buildB: rb.isEmpty ? nil : builds["B"],
                       order: order, orderMode: o.order, seed: seed, pairs: pairs.count, runs: runs, orderEffectPct: orderEffect.isEmpty ? nil : Stats.round(Stats.median(orderEffect), 1),
                       samplerInChildren: o.sampler, pauseMs: o.pauseMs, quietBusyPct: o.quietBusyPct, knobsA: knobs["A"], knobsB: knobs["B"],
                       guardsA: ra.contains { $0.guards != nil } ? ra.flatMap { $0.guards ?? [] } : nil, guardsB: rb.contains { $0.guards != nil } ? rb.flatMap { $0.guards ?? [] } : nil)
    return (res, pairs.isEmpty ? ExitCode.harness : res.regression ? ExitCode.regression : ExitCode.ok)
  }

  struct ABResult: Codable {
    var schema = "deskbench.ab/1"
    var scenario: String, fixture: String, a: String, b: String, repsPerSide: Int
    var summaryA: Summary, summaryB: Summary
    var comparison: [Regression]
    var failures: [String]
    /// The objective or a guard got worse beyond its band, significantly (exit 4); information rows never set it.
    var regression: Bool, improvement: Bool
    var objective: String?
    var guardsFailed: [String]?
    var notes: [String]?
    var buildA: BuildInfo?, buildB: BuildInfo?
    /// Each pair's order ("AB" = A ran first), how it was drawn, and the seed that redraws it (`--seed`).
    var order: [String]? = nil
    var orderMode: String? = nil
    var seed: UInt64? = nil
    /// Complete pairs the verdict used.
    var pairs: Int? = nil
    var runs: [ABRun]? = nil
    /// Median over pairs of (second run − first run) / first on the objective, whichever build ran second: what
    /// running second costs or saves on this machine (the order is counterbalanced, so it doesn't bias the verdict).
    var orderEffectPct: Double? = nil
    var samplerInChildren: Bool? = nil
    var pauseMs: Double? = nil
    var quietBusyPct: Double? = nil
    /// Each side's knob vector, as its runs reported it.
    var knobsA: [String: String]?, knobsB: [String: String]?
    /// Each side's correctness guards (Guards.swift), every rep's in order; nil when the runs weren't asked for them.
    var guardsA: [GuardResult]? = nil, guardsB: [GuardResult]? = nil
    var text: String {
      var o = ["ab \(scenario) on \(fixture): \(pairs.map { "\($0) pairs" } ?? "\(repsPerSide) reps a side"), decided on \(objective ?? "?")",
               "  A: \(a)" + (buildA.map { "  [\($0.line)]" } ?? ""), "  B: \(b)" + (buildB.map { "  [\($0.line)]" } ?? "")]
      if let order { o.append("  order: \(order.joined(separator: " "))\(seed.map { " (\(orderMode ?? "random"), seed \($0))" } ?? "")\(orderEffectPct.map { "; running second moved the objective \($0 > 0 ? "+" : "")\($0) % (median)" } ?? "")") }
      if let runs, !runs.isEmpty {
        let busy = runs.map(\.busyPct)
        o.append("  machine before each run: \(Stats.round(Stats.median(busy), 0)) % of the cores busy (median, max \(Stats.round(busy.max() ?? 0, 0)) %); \(runs.filter(\.quiet).count)/\(runs.count) runs started quiet")
      }
      if let ka = knobsA, let kb = knobsB, ka != kb {
        let differ = Set(ka.keys).union(kb.keys).filter { ka[$0] != kb[$0] }.sorted()
        o.append("  knobs: " + differ.map { "\($0) A=\(ka[$0] ?? "-") B=\(kb[$0] ?? "-")" }.joined(separator: ", "))
      }
      o += Commands.rows(comparison)
      for n in notes ?? [] { o.append("  note: " + n) }
      func line(_ s: Summary) -> String { Commands.medians(s) }
      o.append("  A medians: " + line(summaryA)); o.append("  B medians: " + line(summaryB))
      for f in failures { o.append("  ! " + f) }
      for (side, gs) in [("A", guardsA), ("B", guardsB)] { for g in gs ?? [] { o.append("  guard \(side) \(g.name): \(g.pass ? "pass" : "FAIL") \(g.detail)") } }
      return o.joined(separator: "\n")
    }
  }

  /// Comparison rows as text: what decides first, information after.
  static func rows(_ rs: [Regression]) -> [String] {
    rs.map { r in
      let mark = r.regression ? (r.decides ? "✗ REGRESSION" : "· worse (info)") : r.improvement ? (r.decides ? "✓ better" : "· better (info)") : r.unsure == true ? "? unsure" : "· same"
      return "  \(mark) [\(r.role ?? "metric")] " + (r.reason.hasPrefix(r.metric) ? r.reason : "\(r.metric): \(r.reason)")
    }
  }

  /// One summary's medians in a line: the objectives first, the frame counts after.
  static func medians(_ s: Summary) -> String {
    var p: [String] = []
    if let l = s.latencyMs { p.append("latency \(l.median) ms") }
    if let c = s.mainThreadCpuMsPerStep { p.append("cpu \(c.median) ms/step") }
    if let i = s.instructionsPerStep { p.append(String(format: "%.1f M instr/step", i.median / 1e6)) }
    if let h = s.hitchTimeRatioMsPerS { p.append("late \(h.median) ms/s") }
    p += ["longest stretch \(s.longestStretchMs.median) ms", "late frames \(s.lateFrames.median)/rep", "frame p95 \(s.frameP95Ms.median) ms", ">16.7 ms \(s.stretchesOver16.median)/rep"]
    return p.joined(separator: "  ")
  }

  /// Records the scenario under xctrace: a child of this executable shows the window, waits for `go`, runs; the parent
  /// attaches, then exports and summarises the tables an agent wants. The recording is stopped with SIGINT (xctrace
  /// saves, as on Ctrl-C) when the child says its reps are done, so it covers every step; `--seconds` is only a safety
  /// limit. The child and xctrace get a scrubbed environment: a trace keeps the recorded process's.
  static func profile(scenario: String, fixture: String, template: String, out: URL, reps: Int, params: [String], seconds: Double?, activate: Bool = true, host: String? = nil) throws -> (ProfileResult, Int) {
    let templates = ["hitches": "Animation Hitches", "time": "Time Profiler", "swiftui": "SwiftUI"]
    guard let tname = templates[template] else { throw CLIError.usage("template must be one of \(templates.keys.sorted().joined(separator: ", "))") }
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let go = out.appendingPathComponent("go"), trace = out.appendingPathComponent("\(scenario)-\(template).trace"), resultPath = out.appendingPathComponent("\(scenario)-inprocess.json")
    let done = URL(fileURLWithPath: go.path + ".done")
    for f in [go, done, trace, resultPath] { try? FileManager.default.removeItem(at: f) }
    let limit = seconds ?? 600
    var args = ["run", scenario, "--fixture", fixture, "--reps", String(reps), "--json", "--wait-for", go.path, "--out", resultPath.path, "--quiet-check", "0", "--hold", "1", "--profiled"]
    for p in params { args += ["--set", p] }
    if !activate { args.append("--no-activate") }
    if let host { args += ["--host", host] }
    let env = TracePrivacy.scrub(ProcessInfo.processInfo.environment)
    let childProc = Process(); childProc.executableURL = URL(fileURLWithPath: selfPath()); childProc.arguments = args; childProc.environment = env
    childProc.standardOutput = FileHandle.nullDevice; childProc.standardError = FileHandle.standardError
    try childProc.run()
    Thread.sleep(forTimeInterval: 2.5)   // the window and the noise floor
    let rec = Process(); rec.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun"); rec.environment = env
    rec.arguments = ["xctrace", "record", "--template", tname, "--attach", String(childProc.processIdentifier), "--output", trace.path, "--time-limit", "\(Int(limit))s"]
    let recErr = Pipe(); rec.standardError = recErr; rec.standardOutput = recErr
    let log = LogBuffer()
    recErr.fileHandleForReading.readabilityHandler = { h in log.append(h.availableData) }
    let recStart = Date()
    try rec.run()
    // xctrace prints "Ctrl-C to stop the recording" once it is attached (≈1 s after "Starting", through a pipe too);
    // a little more so the first step is surely inside the recording.
    let ready = Date().addingTimeInterval(20)
    while !log.text.contains("Ctrl-C"), rec.isRunning, Date() < ready { Thread.sleep(forTimeInterval: 0.05) }
    Thread.sleep(forTimeInterval: 1.0)
    FileManager.default.createFile(atPath: go.path, contents: Data())
    while childProc.isRunning, !FileManager.default.fileExists(atPath: done.path) { Thread.sleep(forTimeInterval: 0.05) }
    let stoppedAt = Date(), hitLimit = !rec.isRunning && childProc.isRunning
    if rec.isRunning { rec.interrupt() }   // SIGINT: stop and save
    childProc.waitUntilExit()
    let saveBy = Date().addingTimeInterval(180)
    while rec.isRunning, Date() < saveBy { Thread.sleep(forTimeInterval: 0.1) }
    if rec.isRunning { rec.terminate(); rec.waitUntilExit() }
    recErr.fileHandleForReading.readabilityHandler = nil
    log.append(recErr.fileHandleForReading.readDataToEndOfFile())
    let recLog = log.text
    try recLog.write(to: out.appendingPathComponent("xctrace.log"), atomically: true, encoding: .utf8)
    guard FileManager.default.fileExists(atPath: trace.path) else { throw CLIError.harness("xctrace produced no trace:\n\(recLog.suffix(800))") }
    FileHandle.standardError.write(Data((TracePrivacy.warning(trace: trace.path) + "\n").utf8))
    var result = ProfileResult(template: tname, trace: trace.path, scenario: scenario, fixture: fixture, process: "CapcomdDeskBench", durationS: Stats.round(stoppedAt.timeIntervalSince(recStart), 1))
    if hitLimit { result.notes.append("xctrace stopped before the reps were done (the --seconds \(Int(limit)) limit?): later steps may be missing") }
    result.inProcess = try? JSONOut.decode(BenchResult.self, from: Data(contentsOf: resultPath))
    let toc = try xctrace(["export", "--input", trace.path, "--toc"])
    func table(_ schema: String) -> XCTable? {
      guard toc.contains("schema=\"\(schema)\"") else { return nil }
      guard let xml = try? xctrace(["export", "--input", trace.path, "--xpath", "/trace-toc/run[@number=\"1\"]/data/table[@schema=\"\(schema)\"]"]) else { return nil }
      return try? XCTable(xml: Data(xml.utf8))
    }
    switch template {
    case "hitches":
      if let h = table("hitches") { result.hitches = HitchSummary(hitches: h, hangs: table("potential-hangs"), process: "CapcomdDeskBench") }
      else { result.notes.append("no hitches table in the trace (did the recording attach? see xctrace.log)") }
    case "time":
      if let t = table("time-profile") { result.timeProfile = ProfileSummary(timeProfile: t, ids: t.ids); result.addCallTrees(timeProfile: t, signposts: table("os-signpost"), process: "CapcomdDeskBench") } else { result.notes.append("no time-profile table") }
      if let h = table("potential-hangs") { result.hitches = HitchSummary(hitches: XCTable.emptyHitches, hangs: h, process: "CapcomdDeskBench") }
    default:
      // The cause and effect tables (C7's confirmation): root causes by view, the longest updates, the graph's edges.
      let schemas = toc.components(separatedBy: "schema=\"").dropFirst().compactMap { $0.split(separator: "\"").first.map(String.init) }
      var tables: [String: XCTable] = [:]
      for name in SwiftUIProfile.tableNames { if let t = table(name) { tables[name] = t } }
      let s = SwiftUIProfile(tables: tables, process: "CapcomdDeskBench")
      result.swiftUI = s
      if tables.isEmpty { result.notes.append("no SwiftUI tables in the trace; schemas: \(Set(schemas).sorted().joined(separator: ", "))") }
      else if s.empty {
        let issues = recLog.split(separator: "\n").filter { $0.contains("[Warning]") || $0.contains("[Error]") }.map { $0.trimmingCharacters(in: .whitespaces) }
        result.notes.append("the SwiftUI tables have no rows" + (issues.isEmpty ? "" : " (xctrace: \(issues.joined(separator: "; ")))") + "; the in-process causes (worstStretches[].causes) are the record")
      }
      if let t = table("time-profile") { result.timeProfile = ProfileSummary(timeProfile: t, ids: t.ids) }
    }
    if let s = table("os-signpost") {
      var c: [String: Int] = [:]
      for r in s.rows { c[r["name"]?.attrs["fmt"] ?? r["name"]?.text ?? "?", default: 0] += 1 }
      result.signposts = c
    }
    let json = out.appendingPathComponent("\(scenario)-\(template).json")
    try JSONOut.encode(result).write(to: json, atomically: true, encoding: .utf8)
    result.notes.append("written: \(json.path)")
    return (result, ExitCode.ok)
  }

  /// Summarises a trace that already exists (recorded by hand, by `profile`, or by an earlier session).
  static func summarise(trace: URL, template: String, scenario: String, process: String) throws -> ProfileResult {
    var result = ProfileResult(template: template, trace: trace.path, scenario: scenario, fixture: "-", process: process, durationS: 0)
    let toc = try xctrace(["export", "--input", trace.path, "--toc"])
    func table(_ schema: String) -> XCTable? {
      guard toc.contains("schema=\"\(schema)\"") else { return nil }
      guard let xml = try? xctrace(["export", "--input", trace.path, "--xpath", "/trace-toc/run[@number=\"1\"]/data/table[@schema=\"\(schema)\"]"]) else { return nil }
      return try? XCTable(xml: Data(xml.utf8))
    }
    if let h = table("hitches") { result.hitches = HitchSummary(hitches: h, hangs: table("potential-hangs"), process: process) }
    else if let h = table("potential-hangs") { result.hitches = HitchSummary(hitches: XCTable.emptyHitches, hangs: h, process: process) }
    if let t = table("time-profile") { result.timeProfile = ProfileSummary(timeProfile: t, ids: t.ids); result.addCallTrees(timeProfile: t, signposts: table("os-signpost"), process: process) }
    if result.hitches == nil && result.timeProfile == nil { result.notes.append("no hitches, potential-hangs or time-profile table in the trace") }
    return result
  }

  static func xctrace(_ args: [String]) throws -> String {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun"); p.arguments = ["xctrace"] + args
    let out = Pipe(); p.standardOutput = out; p.standardError = FileHandle.nullDevice
    try p.run()
    let d = out.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return String(decoding: d, as: UTF8.self)
  }

  static func profileText(_ r: ProfileResult) -> String {
    var o = ["profile \(r.scenario) on \(r.fixture) · \(r.template) · \(Int(r.durationS)) s", "trace: \(r.trace)"]
    if let h = r.hitches {
      if h.hitches > 0 || r.template == "Animation Hitches" {
        o.append("hitches: \(h.hitches) (total \(h.totalMs) ms, max \(h.maxMs) ms, ≥16 ms: \(h.over16Ms))")
        for (k, v) in h.causes.sorted(by: { $0.value > $1.value }) { o.append("  \(v)× \(k)") }
      }
      if !h.potentialHangsMs.isEmpty { o.append("potential hangs (ms): \(h.potentialHangsMs.suffix(10).map { String($0) }.joined(separator: ", "))") }
    }
    if let t = r.timeProfile {
      o.append("time profile: \(t.mainThreadSamples) main-thread samples (every \(t.sampleIntervalMs) ms); bursts ≥16 ms: \(t.bursts) covering \(t.burstSamples) samples; sizes \(t.burstSizes)")
      o.append("  ours + hot spots, inclusive:"); for f in t.inclusiveOurs.prefix(25) { o.append(String(format: "  %6d  %@", f.samples, f.symbol)) }
      o.append("  inside the bursts:"); for f in t.burstFrames.prefix(25) { o.append(String(format: "  %6d  %@", f.samples, f.symbol)) }
      o.append("  self top:"); for f in t.selfTop.prefix(10) { o.append(String(format: "  %6d  %@", f.samples, f.symbol)) }
    }
    if let s = r.swiftUI { o += s.lines }
    if let sp = r.signposts { o.append("signposts: " + sp.map { "\($0.key)×\($0.value)" }.sorted().joined(separator: " ")) }
    if r.tree != nil { o.append(Explain.callTreeText(r)) }
    if let ip = r.inProcess { o.append(""); o.append("in-process (same run):"); o.append(Explain.text(ip).split(separator: "\n").prefix(14).joined(separator: "\n")) }
    for n in r.notes { o.append("note: " + n) }
    return o.joined(separator: "\n")
  }
}

/// xctrace's output, collected from the pipe's handler thread while the main thread waits on it.
final class LogBuffer: @unchecked Sendable {
  private let lock = NSLock()
  private var data = Data()
  func append(_ d: Data) { lock.lock(); data.append(d); lock.unlock() }
  var text: String { lock.lock(); defer { lock.unlock() }; return String(decoding: data, as: UTF8.self) }
}

extension XCTable {
  /// A table with no rows, for summaries that only have hangs.
  static var emptyHitches: XCTable { try! XCTable(xml: Data("<trace-query-result><node><schema name=\"hitches\"></schema></node></trace-query-result>".utf8)) }
}

/// Whether the machine is quiet enough to start a measured run: the share of all cores busy over half a second
/// (host CPU ticks; between `ab`'s runs nothing of ours is running) and whether a compiler or linker is running.
enum Quiet {
  static let buildTools: Set<String> = ["swift-build", "swift-frontend", "swiftc", "swift-driver", "clang", "clang++", "ld", "ld64", "xcodebuild", "swift-test", "swift-package"]

  struct Reading { var busyPct: Double; var builds: [String]; var waitedS: Double; var quiet: Bool }

  /// Sleeps `pauseMs`, then reads the machine every half second until it is quiet or `maxS` have passed.
  static func wait(pauseMs: Double, maxS: Double, busyPct limit: Double) -> Reading {
    let start = Date()
    Thread.sleep(forTimeInterval: pauseMs / 1000)
    while true {
      let busy = busyShare(over: 0.5), b = builds()
      let waited = Date().timeIntervalSince(start)
      let quiet = busy <= limit && b.isEmpty
      if quiet || waited >= maxS { return Reading(busyPct: Stats.round(busy, 1), builds: b, waitedS: Stats.round(waited, 1), quiet: quiet) }
    }
  }

  static func busyShare(over s: Double) -> Double {
    func ticks() -> (busy: Double, all: Double)? {
      var info = host_cpu_load_info()
      var count = mach_msg_type_number_t(MemoryLayout<host_cpu_load_info>.size / MemoryLayout<integer_t>.size)
      let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { host_statistics(mach_host_self(), HOST_CPU_LOAD_INFO, $0, &count) } }
      guard r == KERN_SUCCESS else { return nil }
      let t = info.cpu_ticks   // user, system, idle, nice
      let user = Double(t.0), sys = Double(t.1), idle = Double(t.2), nice = Double(t.3)
      return (user + sys + nice, user + sys + idle + nice)
    }
    guard let a = ticks() else { return 0 }
    Thread.sleep(forTimeInterval: s)
    guard let b = ticks(), b.all > a.all else { return 0 }
    return (b.busy - a.busy) / (b.all - a.all) * 100
  }

  /// Build tools running now, by name (once each).
  static func builds() -> [String] {
    let ps = Process(); ps.executableURL = URL(fileURLWithPath: "/bin/ps"); ps.arguments = ["-Ao", "comm="]
    let out = Pipe(); ps.standardOutput = out; ps.standardError = FileHandle.nullDevice
    guard (try? ps.run()) != nil else { return [] }
    let data = out.fileHandleForReading.readDataToEndOfFile(); ps.waitUntilExit()
    let names = String(decoding: data, as: UTF8.self).split(separator: "\n").map { $0.split(separator: "/").last.map(String.init) ?? "" }
    return Array(Set(names.filter(buildTools.contains))).sorted()
  }
}
