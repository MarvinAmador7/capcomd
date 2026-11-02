import XCTest
import DeskBenchKit

/// PerfLoop Phase 0 (design/perf-loop SPEC §6): the build stamp, the hitch time ratio, the objectives and the verdicts
/// they drive.
final class TruthTests: XCTestCase {
  // MARK: hitch time ratio

  func testHitchTimeRatioSumsLatenessPerSecond() {
    let f = FrameStats(intervalsMs: [8.3, 8.4, 8.3, 25.1, 8.3, 50.2, 8.3], nominalHz: 120)
    // Steady 120 Hz (8.333 ms): late by 25.1 − 8.333 and 50.2 − 8.333 = 58.63 ms over 116.9 ms of intervals.
    XCTAssertEqual(f.hitchTimeMs, 58.63)
    XCTAssertEqual(f.hitchTimeRatioMsPerS!, 501.6, accuracy: 0.1)
    // Callback jitter inside 1.5 × the frame is not lateness.
    XCTAssertEqual(FrameStats(intervalsMs: [8.3, 9.1, 7.6, 10.4, 8.3, 12.4], nominalHz: 120).hitchTimeRatioMsPerS, 0)
    XCTAssertEqual(FrameStats.empty.hitchTimeRatioMsPerS, 0)
  }

  func testHitchTimeRatioIsRateAndLengthInvariant() {
    // A panel running smoothly at 60 Hz is not late at all, though every interval is two 120 Hz frames.
    let at60 = FrameStats(intervalsMs: Array(repeating: 16.67, count: 60), nominalHz: 120)
    XCTAssertEqual(at60.steadyHz, 60); XCTAssertEqual(at60.hitchTimeRatioMsPerS, 0); XCTAssertEqual(at60.lateAtNominal, 60)
    // The same 100 ms stall in a second of scenario reads about the same at 60 and 120 Hz (within one frame).
    let s60 = FrameStats(intervalsMs: Array(repeating: 16.67, count: 54) + [100], nominalHz: 60)
    let s120 = FrameStats(intervalsMs: Array(repeating: 8.333, count: 108) + [100], nominalHz: 120)
    XCTAssertEqual(s60.hitchTimeRatioMsPerS!, s120.hitchTimeRatioMsPerS!, accuracy: 9)
    // A scenario twice as long with the same pattern: twice the late frames, the same ratio.
    let pattern: [Double] = Array(repeating: 8.333, count: 50) + [25, 41.7]
    let once = FrameStats(intervalsMs: pattern, nominalHz: 120), twice = FrameStats(intervalsMs: pattern + pattern, nominalHz: 120)
    XCTAssertEqual(twice.late, 2 * once.late)
    XCTAssertEqual(once.hitchTimeRatioMsPerS!, twice.hitchTimeRatioMsPerS!, accuracy: 0.01)
    // Two 25 ms frames and one 41.7 ms frame hold frames back equally long; the late count says 2 vs 1.
    let two = FrameStats(intervalsMs: Array(repeating: 8.333, count: 20) + [25, 25], nominalHz: 120)
    let one = FrameStats(intervalsMs: Array(repeating: 8.333, count: 20) + [41.67], nominalHz: 120)
    XCTAssertEqual(two.late, 2); XCTAssertEqual(one.late, 1)
    XCTAssertEqual(two.hitchTimeMs!, one.hitchTimeMs!, accuracy: 0.05)
  }

  func testBudgetJudgesLateFrameTimeNotTheCount() {
    let spec = Scenarios.spec("step")!
    let smooth = rep(0, cpu: 10, intervals: Array(repeating: 8.333, count: 120))
    XCTAssertTrue(Budgets.evaluate(spec, reps: [smooth], summary: Summary(reps: [smooth])).pass)
    let hitchy = rep(0, cpu: 10, intervals: Array(repeating: 8.333, count: 120) + [40])
    let v = Budgets.evaluate(spec, reps: [hitchy], summary: Summary(reps: [hitchy]))
    XCTAssertFalse(v.pass); XCTAssertTrue(v.reasons[0].hasPrefix("late frame time"), v.reasons[0])
  }

  // MARK: build stamp

  func testBuildStampDecodes() {
    let text = "commit=9bcd41a\ndirty=0\nsourceHash=sha256:abc\ntoolchain=Xcode 27.1 (27A9275)\nbuiltAt=2026-10-30T15:31:02Z\n"
    let b = BuildInfo(stamp: text, configuration: "release", hash: "sha256:exe")
    XCTAssertEqual(b, BuildInfo(hash: "sha256:exe", commit: "9bcd41a", dirty: false, sourceHash: "sha256:abc", builtAt: "2026-10-30T15:31:02Z",
                                configuration: "release", toolchain: "Xcode 27.1 (27A9275)", stamp: true))
    XCTAssertEqual(b.line, "9bcd41a · release · built 2026-10-30T15:31:02Z")
    XCTAssertTrue(BuildInfo(stamp: "commit=9bcd41a\ndirty=1\n", configuration: "release", hash: nil).dirty)
    // Built without git (a tarball): stamped, but no commit and dirty, so it can never be promoted.
    let nogit = BuildInfo(stamp: "commit=\ndirty=1\nsourceHash=\ntoolchain=\nbuiltAt=2026-10-30T15:31:02Z", configuration: "debug", hash: nil)
    XCTAssertTrue(nogit.stamp); XCTAssertNil(nogit.commit); XCTAssertNil(nogit.sourceHash); XCTAssertTrue(nogit.dirty)
    // No stamp at all: unknown, which counts as dirty.
    let none = BuildInfo(stamp: nil, configuration: "release", hash: nil)
    XCTAssertFalse(none.stamp); XCTAssertNil(none.commit); XCTAssertTrue(none.dirty)
    XCTAssertTrue(none.line.contains("no build stamp"))
  }

  func testOlderResultsStillDecode() throws {
    // A deskbench.result/1 written before Phase 0: none of the added fields.
    let r = result([rep(0, cpu: 10, intervals: [8.3, 8.3])])
    var obj = try JSONSerialization.jsonObject(with: Data(JSONOut.encode(r).utf8))
    let added: Set<String> = ["hitchTimeMs", "hitchTimeRatioMsPerS", "build", "profiled", "objective", "mainThreadCpuMsPerStep", "instructionsPerStep", "instructions", "role"]
    func strip(_ x: Any) -> Any {
      if let d = x as? [String: Any] { return d.filter { !added.contains($0.key) }.mapValues(strip) }
      if let a = x as? [Any] { return a.map(strip) }
      return x
    }
    obj = strip(obj)
    let old = try JSONOut.decode(BenchResult.self, from: JSONSerialization.data(withJSONObject: obj))
    XCTAssertNil(old.tool.build); XCTAssertNil(old.profiled); XCTAssertNil(old.summary.objective); XCTAssertNil(old.reps[0].frames.hitchTimeRatioMsPerS)
    XCTAssertTrue(Explain.text(old).contains("main-thread cpu 10.0 ms"))
  }

  // MARK: objectives

  func testObjectiveSelection() {
    XCTAssertEqual(Objective.default(for: Scenarios.spec("step")!), .cpu)
    XCTAssertEqual(Objective.default(for: Scenarios.spec("burst")!), .cpu)
    for s in ["open", "switch", "follow"] { XCTAssertEqual(Objective.default(for: Scenarios.spec(s)!), .latency, s) }
    XCTAssertEqual(Objective(argument: "instructions"), .instructions)
    XCTAssertEqual(Objective(argument: "hitchTimeRatioMsPerS"), .frames)
    XCTAssertNil(Objective(argument: "lateFrames"))
    let r = rep(0, cpu: 12.5, intervals: [8.3], instructions: [100, 300])
    XCTAssertEqual(r.cpuMsPerStep, 12.5); XCTAssertEqual(r.instructionsPerStep, 200)
    // One step without a count (or all zero): no instructions for the rep, not a wrong average.
    XCTAssertNil(rep(0, cpu: 1, intervals: [8.3], instructions: [100, nil]).instructionsPerStep)
    let s = Summary(reps: [r, rep(1, cpu: 14.5, intervals: [8.3], instructions: [200, 400])], objective: .instructions)
    XCTAssertEqual(s.objective?.name, "instructionsPerStep"); XCTAssertEqual(s.objective?.value, 200)
    XCTAssertEqual(s.mainThreadCpuMsPerStep?.median, 12.5)
    XCTAssertEqual(Summary(reps: [r]).objective?.name, "mainThreadCpuMsPerStep")
  }

  func testABVerdictFollowsTheObjective() {
    let spec = Scenarios.spec("step")!
    let smooth = Array(repeating: 8.333, count: 1000)
    // The late count swings 0 → 3 frames, a few ms each (1.5 ms/s: inside the hitch guard's band); CPU halves: better.
    let a = (0..<5).map { rep($0, cpu: 40 + Double($0 % 2), intervals: smooth) }
    let b = (0..<5).map { rep($0, cpu: 20 + Double($0 % 2), intervals: smooth + [12.6, 12.6, 12.6]) }
    let better = Comparison(spec, baseline: a, candidate: b)
    XCTAssertEqual(better.objective, "mainThreadCpuMsPerStep")
    XCTAssertTrue(better.improvement); XCTAssertFalse(better.regression); XCTAssertEqual(better.guardsFailed, [])
    XCTAssertTrue(better.rows.contains { $0.metric == "lateFrames" && $0.regression && $0.role == "info" })
    // CPU better but frames held back much longer: the guard fails the comparison.
    let hitchy = (0..<5).map { rep($0, cpu: 20, intervals: smooth + [60, 60, 60]) }
    let guarded = Comparison(spec, baseline: a, candidate: hitchy)
    XCTAssertTrue(guarded.regression); XCTAssertFalse(guarded.improvement); XCTAssertEqual(guarded.guardsFailed, ["hitchTimeRatioMsPerS"])
    // CPU worse beyond the band: a regression on the objective.
    let slower = Comparison(spec, baseline: a, candidate: (0..<5).map { rep($0, cpu: 60, intervals: smooth) })
    XCTAssertTrue(slower.regression); XCTAssertEqual(slower.rows[0].role, "objective"); XCTAssertTrue(slower.rows[0].regression)
    // Asked for instructions where the counters read zero: falls back to CPU and says so.
    let fallback = Comparison(spec, objective: .instructions, baseline: a, candidate: b)
    XCTAssertEqual(fallback.objective, "mainThreadCpuMsPerStep"); XCTAssertEqual(fallback.notes.count, 1)
    // With counters: instructions decide, even when CPU (noisier) disagrees.
    let ia = (0..<5).map { rep($0, cpu: 40, intervals: smooth, instructions: [1_000_000 + $0 * 1000]) }
    let ib = (0..<5).map { rep($0, cpu: 60, intervals: smooth, instructions: [1_000_000 + $0 * 1000]) }
    let byInstructions = Comparison(spec, objective: .instructions, baseline: ia, candidate: ib)
    XCTAssertFalse(byInstructions.regression); XCTAssertTrue(byInstructions.rows.contains { $0.metric == "mainThreadCpuMsPerStep" && $0.role == "info" && $0.regression })
    // A latency scenario decides on latency; with none measured it falls back to CPU and says so.
    let la = (0..<5).map { rep($0, cpu: 40, intervals: smooth, latency: 200) }, lb = (0..<5).map { rep($0, cpu: 20, intervals: smooth, latency: 300) }
    let switching = Comparison(Scenarios.spec("switch")!, baseline: la, candidate: lb)
    XCTAssertEqual(switching.objective, "latencyMs"); XCTAssertTrue(switching.regression)
    XCTAssertEqual(Comparison(Scenarios.spec("switch")!, baseline: a, candidate: b).objective, "mainThreadCpuMsPerStep")
    // An info row never makes a saved run's verdict a regression.
    var info = Regression(metric: "lateFrames", baseline: [0, 0, 0], candidate: [9, 9, 9]); info.role = "info"
    XCTAssertEqual(result(a, comparison: [info]).verdict, "pass")
    var objective = info; objective.role = "objective"
    XCTAssertEqual(result(a, comparison: [objective]).verdict, "regression")
  }

  func testTraceEnvironmentIsScrubbed() {
    let env = ["HOME": "/Users/x", "PATH": "/usr/bin", "CLAUDE_CODE_MESSAGING_TOKEN": "secret", "GITHUB_TOKEN": "secret", "DESKBENCH_SIZING": "1", "LC_ALL": "C", "CAPCOMD_TOKEN": "secret"]
    XCTAssertEqual(Set(TracePrivacy.scrub(env).keys), ["HOME", "PATH", "DESKBENCH_SIZING", "LC_ALL"])
    XCTAssertTrue(TracePrivacy.warning(trace: "/nonexistent/x.trace").contains("never commit"))
  }

  // MARK: helpers

  /// A rep whose steps took `cpu` ms of main-thread CPU each; `instructions` per step (nil: counters off).
  func rep(_ i: Int, cpu: Double, intervals: [Double], instructions: [Int?] = [nil], latency: Double? = nil) -> RepResult {
    let f = FrameStats(intervalsMs: intervals, nominalHz: 120)
    let steps = instructions.enumerated().map { StepResult(name: "s\($0.offset)", atMs: 0, durationMs: 100, latencyMs: latency, frames: f, mainThread: .empty, bodies: [:], cpuMs: cpu, instructions: $0.element) }
    return RepResult(index: i, steps: steps, frames: f, mainThread: MainThreadStats(stretchesMs: [5, 5], cpuMs: [cpu * Double(steps.count)]), bodies: [:], checks: [], worstStretches: [], window: nil)
  }

  func result(_ reps: [RepResult], comparison: [Regression]? = nil) -> BenchResult {
    let machine = Machine(model: "test", cores: 8, memoryGB: 16, os: "x", screenHz: 120, loadAvg1: 1, thermalState: "nominal", lowPowerMode: false, heavyProcesses: [])
    let spec = Scenarios.spec("step")!, summary = Summary(reps: reps)
    return BenchResult(tool: ToolInfo(version: "1", commit: "abc", configuration: "release", build: BuildInfo(stamp: "commit=abc\ndirty=0", configuration: "release", hash: nil)),
                       scenario: "step", fixture: "crew17", params: [:], startedAt: "now", durationMs: 1, machine: machine, noise: Noise(idle: .empty, idleMain: .empty, machine: machine, window: nil),
                       window: nil, reps: reps, summary: summary, budget: Budgets.evaluate(spec, reps: reps, summary: summary), comparison: comparison, artifacts: [])
  }
}
