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
  }

  static func run(_ o: Options) async -> Result<BenchResult, CLIError> {
    guard let spec = Scenarios.spec(o.scenario) else { return .failure(.usage("unknown scenario '\(o.scenario)'; see `deskbench list`")) }
    guard let world = Fixtures.make(o.fixture) else { return .failure(.usage("unknown fixture '\(o.fixture)'; see `deskbench list fixtures`")) }
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
      let (steps, checks): ([StepResult], [Check])
      switch spec.name {
      case "open": (steps, checks) = await drive.open(rep: rep, size: size, activate: o.activate)
      case "switch": (steps, checks) = await drive.switchProjects()
      case "step": (steps, checks) = await drive.step()
      case "jump": (steps, checks) = await drive.jump()
      case "fling": (steps, checks) = await drive.fling()
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
      for s in h.stretches[m.stretch...] where stepWindows.contains(where: { s.at >= $0.0 && s.at <= $0.1 }) { st.append(s.dur); cpu.append(s.cpu) }
      var bodies: [String: Int] = [:]
      for s in steps { for (k, v) in s.bodies { bodies[k, default: 0] += v } }
      let worst = h.worstStretches(from: m.stretch, steps: steps)
      repResults.append(RepResult(index: rep, variant: o.variant, steps: steps, frames: FrameStats(intervalsMs: its, nominalHz: h.nominalHz),
                                  mainThread: MainThreadStats(stretchesMs: st, cpuMs: cpu), bodies: bodies, checks: checks, worstStretches: worst, window: h.windowState()))
      if let dir = o.artifacts { artifacts += h.snapshot(into: dir, name: "\(spec.name)-rep\(rep)") }
      await h.sleep(ms: 200)
    }
    _ = repStart
    let summary = Summary(reps: repResults)
    let machine = MachineInfo.capture(screenHz: h.nominalHz)
    let windowState = h.windowState()
    let noise = Noise(idle: noiseFrames, idleMain: noiseMain, machine: machine, window: windowState)
    let budget = Budgets.evaluate(spec, reps: repResults, summary: summary)
    var comparison: [Regression]?
    if let b = o.baseline {
      do {
        let base = try JSONOut.decode(BenchResult.self, from: Data(contentsOf: b))
        guard base.scenario == spec.name else { return .failure(.usage("baseline is for scenario '\(base.scenario)', not '\(spec.name)'")) }
        comparison = compare(spec, baseline: base.reps, candidate: repResults)
      } catch { return .failure(.harness("couldn't read the baseline: \(error)")) }
    }
    if o.holdSeconds > 0 { await h.sleep(ms: o.holdSeconds * 1000) }
    let result = BenchResult(tool: tool(), scenario: spec.name, fixture: o.fixture, params: runParams, startedAt: startedAt, durationMs: Stats.round((CACurrentMediaTime() - began) * 1000, 0),
                             machine: machine, noise: noise, window: windowState, reps: repResults, summary: summary, budget: budget, comparison: comparison, artifacts: artifacts)
    h.closeWindow()
    return .success(result)
  }

  static func compare(_ spec: ScenarioSpec, baseline: [RepResult], candidate: [RepResult]) -> [Regression] {
    Budgets.metrics(for: spec).map { m in
      Regression(metric: m.name, baseline: baseline.compactMap(m.pick), candidate: candidate.compactMap(m.pick), floorPct: m.floorPct, absoluteFloor: m.absoluteFloor)
    }
  }
}

enum CLIError: Error, CustomStringConvertible {
  case usage(String), harness(String)
  var description: String { switch self { case .usage(let s), .harness(let s): s } }
  var code: Int { switch self { case .usage: ExitCode.usage; case .harness: ExitCode.harness } }
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

  /// A and B alternate, one process each, `reps` times a side; the medians are compared with the noise band.
  static func ab(a: String, b: String, scenario: String, fixture: String, reps: Int, params: [String], activate: Bool = true) throws -> (ABResult, Int) {
    guard let spec = Scenarios.spec(scenario) else { throw CLIError.usage("unknown scenario '\(scenario)'") }
    var ra: [RepResult] = [], rb: [RepResult] = []
    var failures: [String] = []
    for i in 0..<reps {
      for (label, exe) in [("A", a), ("B", b)] {
        var args = ["run", scenario, "--fixture", fixture, "--reps", "1", "--json", "--quiet-check", "0", "--variant", label]
        for p in params { args += ["--set", p] }
        if !activate { args.append("--no-activate") }
        FileHandle.standardError.write(Data("ab: \(label) rep \(i + 1)/\(reps)\n".utf8))
        let (r, code, text) = try child(exe, args)
        guard let r else { failures.append("\(label) rep \(i): exit \(code): \(text.prefix(300))"); continue }
        if label == "A" { ra += r.reps } else { rb += r.reps }
      }
    }
    let regs = ra.isEmpty || rb.isEmpty ? [] : Budgets.metrics(for: spec).map { m in
      Regression(metric: m.name, baseline: ra.compactMap(m.pick), candidate: rb.compactMap(m.pick), floorPct: m.floorPct, absoluteFloor: m.absoluteFloor)
    }
    let res = ABResult(scenario: scenario, fixture: fixture, a: a, b: b, repsPerSide: reps, summaryA: Summary(reps: ra), summaryB: Summary(reps: rb), comparison: regs, failures: failures,
                       regression: regs.contains { $0.regression }, improvement: regs.contains { $0.improvement } && !regs.contains { $0.regression })
    return (res, failures.count == reps * 2 ? ExitCode.harness : res.regression ? ExitCode.regression : ExitCode.ok)
  }

  struct ABResult: Codable {
    var schema = "deskbench.ab/1"
    var scenario: String, fixture: String, a: String, b: String, repsPerSide: Int
    var summaryA: Summary, summaryB: Summary
    var comparison: [Regression]
    var failures: [String]
    var regression: Bool, improvement: Bool
    var text: String {
      var o = ["ab \(scenario) on \(fixture): \(repsPerSide) reps a side", "  A: \(a)", "  B: \(b)"]
      for c in comparison { o.append("  \(c.regression ? "✗ REGRESSION" : c.improvement ? "✓ better" : "· same") \(c.reason)") }
      func line(_ s: Summary) -> String {
        var p = ["late \(s.lateFrames.median)/rep", "frame p95 \(s.frameP95Ms.median) ms", "longest stretch \(s.longestStretchMs.median) ms", ">16.7 ms \(s.stretchesOver16.median)/rep"]
        if let l = s.latencyMs { p.insert("latency \(l.median) ms", at: 0) }
        return p.joined(separator: "  ")
      }
      o.append("  A medians: " + line(summaryA)); o.append("  B medians: " + line(summaryB))
      for f in failures { o.append("  ! " + f) }
      return o.joined(separator: "\n")
    }
  }

  /// Records the scenario under xctrace: a child of this executable shows the window, waits for `go`, runs; the parent
  /// attaches, then exports and summarises the tables an agent wants.
  static func profile(scenario: String, fixture: String, template: String, out: URL, reps: Int, params: [String], seconds: Double?, activate: Bool = true, host: String? = nil) throws -> (ProfileResult, Int) {
    let templates = ["hitches": "Animation Hitches", "time": "Time Profiler", "swiftui": "SwiftUI"]
    guard let tname = templates[template] else { throw CLIError.usage("template must be one of \(templates.keys.sorted().joined(separator: ", "))") }
    try FileManager.default.createDirectory(at: out, withIntermediateDirectories: true)
    let go = out.appendingPathComponent("go"), trace = out.appendingPathComponent("\(scenario)-\(template).trace"), resultPath = out.appendingPathComponent("\(scenario)-inprocess.json")
    try? FileManager.default.removeItem(at: go); try? FileManager.default.removeItem(at: trace)
    let limit = seconds ?? Double(max(10, reps * (scenario == "burst" ? 10 : 6)))
    var args = ["run", scenario, "--fixture", fixture, "--reps", String(reps), "--json", "--wait-for", go.path, "--out", resultPath.path, "--quiet-check", "0", "--hold", "1"]
    for p in params { args += ["--set", p] }
    if !activate { args.append("--no-activate") }
    if let host { args += ["--host", host] }
    let childProc = Process(); childProc.executableURL = URL(fileURLWithPath: selfPath()); childProc.arguments = args
    childProc.standardOutput = FileHandle.nullDevice; childProc.standardError = FileHandle.standardError
    try childProc.run()
    Thread.sleep(forTimeInterval: 2.5)   // the window and the noise floor
    let rec = Process(); rec.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    rec.arguments = ["xctrace", "record", "--template", tname, "--attach", String(childProc.processIdentifier), "--output", trace.path, "--time-limit", "\(Int(limit))s"]
    let recErr = Pipe(); rec.standardError = recErr; rec.standardOutput = recErr
    try rec.run()
    Thread.sleep(forTimeInterval: 3.0)   // xctrace needs a moment to attach before the scenario moves
    FileManager.default.createFile(atPath: go.path, contents: Data())
    childProc.waitUntilExit()
    rec.waitUntilExit()
    let recLog = String(decoding: recErr.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    try recLog.write(to: out.appendingPathComponent("xctrace.log"), atomically: true, encoding: .utf8)
    guard FileManager.default.fileExists(atPath: trace.path) else { throw CLIError.harness("xctrace produced no trace:\n\(recLog.suffix(800))") }
    var result = ProfileResult(template: tname, trace: trace.path, scenario: scenario, fixture: fixture, process: "CapcomdDeskBench", durationS: limit)
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
      if let t = table("time-profile") { result.timeProfile = ProfileSummary(timeProfile: t, ids: t.ids) } else { result.notes.append("no time-profile table") }
      if let h = table("potential-hangs") { result.hitches = HitchSummary(hitches: XCTable.emptyHitches, hangs: h, process: "CapcomdDeskBench") }
    default:
      // The SwiftUI template's tables vary by Xcode version: take every table whose schema mentions a view or update.
      let schemas = toc.components(separatedBy: "schema=\"").dropFirst().compactMap { $0.split(separator: "\"").first.map(String.init) }
      let interesting = Set(schemas.filter { ["view", "swiftui", "update", "body"].contains { $0.lowercased().contains($0) } || $0.lowercased().contains("swiftui") || $0.lowercased().contains("view-body") })
      result.swiftUI = interesting.sorted().compactMap { table($0) }.map(SwiftUISummary.init)
      if result.swiftUI?.isEmpty ?? true { result.notes.append("no SwiftUI tables recognised; schemas: \(Set(schemas).sorted().joined(separator: ", "))") }
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
    if let t = table("time-profile") { result.timeProfile = ProfileSummary(timeProfile: t, ids: t.ids) }
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
    if let s = r.swiftUI { for t in s { o.append("swiftui table \(t.table): \(t.rows) rows"); for (k, v) in t.byView.sorted(by: { $0.value > $1.value }).prefix(20) { o.append("  \(v)× \(k)") } } }
    if let sp = r.signposts { o.append("signposts: " + sp.map { "\($0.key)×\($0.value)" }.sorted().joined(separator: " ")) }
    if let ip = r.inProcess { o.append(""); o.append("in-process (same run):"); o.append(Explain.text(ip).split(separator: "\n").prefix(14).joined(separator: "\n")) }
    for n in r.notes { o.append("note: " + n) }
    return o.joined(separator: "\n")
  }
}

extension XCTable {
  /// A table with no rows, for summaries that only have hangs.
  static var emptyHitches: XCTable { try! XCTable(xml: Data("<trace-query-result><node><schema name=\"hitches\"></schema></node></trace-query-result>".utf8)) }
}
