import XCTest
import DeskBenchKit

/// PerfLoop Phase 0–1 hardening: `ab`'s order and paired verdict, the bench measure, stretch labels, and the causes
/// `explain` takes from the sampled stacks.
final class FairnessTests: XCTestCase {
  // MARK: rank tests

  func testMannWhitneyIsExact() {
    // Fully separated 5 v 5: 2 of the C(10, 5) = 252 splits are as extreme (either way).
    XCTAssertEqual(RankTests.mannWhitneyP([1, 2, 3, 4, 5], [6, 7, 8, 9, 10]), 2.0 / 252, accuracy: 1e-9)
    XCTAssertEqual(RankTests.mannWhitneyP([6, 7, 8, 9, 10], [1, 2, 3, 4, 5]), 2.0 / 252, accuracy: 1e-9)
    // 3 v 3 can't go below 0.1: the screen stage's limit (SPEC §5.1).
    XCTAssertEqual(RankTests.mannWhitneyP([1, 2, 3], [4, 5, 6]), 0.1, accuracy: 1e-9)
    // Interleaved, and all tied: nothing to see.
    XCTAssertEqual(RankTests.mannWhitneyP([1, 3, 5, 7, 9], [2, 4, 6, 8, 10]), 1, accuracy: 0.35)
    XCTAssertEqual(RankTests.mannWhitneyP([4, 4, 4], [4, 4, 4]), 1)
    XCTAssertEqual(RankTests.mannWhitneyP([], [1]), 1)
    // Ties across the groups (frame counts) still give a p-value, conditional on the ties.
    let p = RankTests.mannWhitneyP([0, 0, 1, 1, 2], [3, 3, 4, 4, 5])
    XCTAssertLessThan(p, 0.02)
  }

  func testSignTest() {
    XCTAssertEqual(RankTests.signP(worse: 5, better: 0), 2.0 / 32, accuracy: 1e-9)
    XCTAssertEqual(RankTests.signP(worse: 3, better: 3), 1)
    XCTAssertEqual(RankTests.signP(worse: 0, better: 0), 1)
  }

  // MARK: the paired verdict

  func testSameBuildWithAnOrderEffectIsNotARegression() {
    // The first ab run on this Mac: B ran second in every pair and paid ~35 % for it. Counterbalanced, the same
    // effect lands on both builds; the per-pair differences straddle zero and the verdict holds.
    let order = PairOrder.draw(pairs: 6, mode: "random", seed: 42)
    let base: [Double] = [120, 95, 140, 110, 130, 100]
    let pairs = zip(order, base).map { o, x -> (a: Double, b: Double) in o == "AB" ? (x, x * 1.35) : (x * 1.35, x) }
    let r = Regression(metric: "mainThreadCpuMsPerStep", pairs: pairs, floorPct: 5, absoluteFloor: 0.5)
    XCTAssertFalse(r.regression, r.reason); XCTAssertFalse(r.improvement, r.reason)
    XCTAssertEqual(r.pairs, 6)
    // The same numbers with B always second (the old A B A B …) read as a regression: that was the bug.
    let biased = Regression(metric: "mainThreadCpuMsPerStep", baseline: base, candidate: base.map { $0 * 1.35 }, floorPct: 5, absoluteFloor: 0.5)
    XCTAssertTrue(biased.regression)
  }

  func testPairedVerdictNeedsTheEffectAndSignificance() {
    let a: [Double] = [100, 104, 98, 101, 103], b = a.map { $0 * 0.7 }
    let better = Regression(metric: "cpu", pairs: Array(zip(a, b)).map { (a: $0.0, b: $0.1) }, floorPct: 5)
    XCTAssertTrue(better.improvement); XCTAssertFalse(better.regression)
    XCTAssertLessThan(better.pValue!, 0.05); XCTAssertEqual(better.betterPairs, 5); XCTAssertEqual(better.deltaPct, -30, accuracy: 1)
    let worse = Regression(metric: "cpu", pairs: Array(zip(b, a)).map { (a: $0.0, b: $0.1) }, floorPct: 5)
    XCTAssertTrue(worse.regression)
    // Every pair 30 worse, but the pairs spread so widely that the two sides overlap: unsure, not a verdict.
    let mixed = Regression(metric: "cpu", pairs: [100.0, 200, 300, 400, 500].map { (a: $0, b: $0 + 30) }, floorPct: 5)
    XCTAssertFalse(mixed.regression); XCTAssertFalse(mixed.improvement)
    XCTAssertEqual(mixed.unsure, true, mixed.reason)
    XCTAssertTrue(mixed.reason.contains("more pairs"), mixed.reason)
  }

  func testPairOrderIsBalancedAndRedrawsFromItsSeed() {
    for n in 1...9 {
      let o = PairOrder.draw(pairs: n, mode: "random", seed: 7)
      XCTAssertEqual(o.count, n)
      XCTAssertLessThanOrEqual(abs(o.filter { $0 == "AB" }.count - o.filter { $0 == "BA" }.count), 1)
    }
    XCTAssertEqual(PairOrder.draw(pairs: 8, mode: "random", seed: 1234), PairOrder.draw(pairs: 8, mode: "random", seed: 1234))
    let draws = Set((1...20).map { PairOrder.draw(pairs: 8, mode: "random", seed: UInt64($0)) })
    XCTAssertGreaterThan(draws.count, 5)
    XCTAssertEqual(PairOrder.draw(pairs: 4, mode: "abba", seed: 0), ["AB", "BA", "AB", "BA"])
  }

  // MARK: measures

  func testComparisonAcrossMeasuresFallsBackToFrames() {
    let spec = Scenarios.spec("step")!
    let smooth = Array(repeating: 8.333, count: 600)
    func rep(_ cpu: Double, measure: Int?, late: Double = 0) -> RepResult {
      let f = FrameStats(intervalsMs: smooth + Array(repeating: 8.333 + late, count: late > 0 ? 6 : 0), nominalHz: 120)
      let st = StepResult(name: "s", atMs: 0, durationMs: 100, frames: f, mainThread: .empty, bodies: [:], cpuMs: cpu, instructions: 1000)
      var r = RepResult(index: 0, steps: [st], frames: f, mainThread: MainThreadStats(stretchesMs: [5], cpuMs: [cpu]), bodies: [:], checks: [], worstStretches: [], window: nil)
      r.measure = measure
      return r
    }
    let old = (0..<5).map { rep(50 + Double($0), measure: nil, late: 20) }, new = (0..<5).map { rep(80 + Double($0), measure: 2) }
    let c = Comparison(spec, pairs: Array(zip(old, new)).map { (a: $0.0, b: $0.1) })
    // CPU per step reads higher in measure 2 (the commit is in it): not comparable, so late frame time decides.
    XCTAssertEqual(c.objective, "hitchTimeRatioMsPerS")
    XCTAssertTrue(c.notes.contains { $0.contains("isn't comparable") }, "\(c.notes)")
    XCTAssertFalse(c.rows.contains { $0.metric == "mainThreadCpuMsPerStep" || $0.metric == "instructionsPerStep" })
    XCTAssertEqual(c.rows.first { $0.metric == "longestStretchMs" }?.role, "info")
    XCTAssertTrue(c.improvement, c.rows[0].reason)
    // Two old builds (base vs v5): CPU per step is theirs to compare, as before.
    let oldB = (0..<5).map { rep(30 + Double($0), measure: nil) }
    let o = Comparison(spec, pairs: Array(zip(old, oldB)).map { (a: $0.0, b: $0.1) })
    XCTAssertEqual(o.objective, "mainThreadCpuMsPerStep"); XCTAssertTrue(o.improvement)
  }

  func testMeasureTwoTakesCPUFromTheSteps() {
    let f = FrameStats(intervalsMs: [8.3], nominalHz: 120)
    let steps = [40.0, 60.0].map { StepResult(name: "s", atMs: 0, durationMs: 100, frames: f, mainThread: .empty, bodies: [:], cpuMs: $0) }
    var r = RepResult(index: 0, steps: steps, frames: f, mainThread: MainThreadStats(stretchesMs: [5], cpuMs: [30]), bodies: [:], checks: [], worstStretches: [], window: nil)
    XCTAssertEqual(r.cpuMsPerStep, 15)   // measure 1: the stretches that began inside the steps
    r.measure = 2
    XCTAssertEqual(r.cpuMsPerStep, 50)   // measure 2: the steps' own counters
  }

  // MARK: stretch labels

  func testStretchLabels() {
    let f = FrameStats.empty
    let steps = [StepResult(name: "step#0 0→3", atMs: 1000, durationMs: 400, frames: f, mainThread: .empty, bodies: [:]),
                 StepResult(name: "step#1 3→6", atMs: 1550, durationMs: 400, frames: f, mainThread: .empty, bodies: [:])]
    XCTAssertEqual(Stretch.label(at: 500, dur: 200, steps: steps), "before step#0 0→3 (setup)")
    // The stretch a step starts in began before the step: it belongs to the step.
    XCTAssertEqual(Stretch.label(at: 995, dur: 100, steps: steps), "step#0 0→3")
    XCTAssertEqual(Stretch.label(at: 1450, dur: 60, steps: steps), "after step#0 0→3")
    XCTAssertEqual(Stretch.label(at: 1380, dur: 300, steps: steps), "step#1 3→6")
    XCTAssertEqual(Stretch.label(at: 10, dur: 1, steps: []), "the scenario")
  }

  // MARK: causes from stacks

  func testCausesComeFromTheSamples() {
    func f(_ s: String, ours: Bool = false) -> StackFrame { StackFrame(s, ours: ours) }
    let trunk = [f("-[NSApplication run]"), f("CFRunLoopRunSpecific")]
    let slide = trunk + [f("ViewGraphRootValueUpdater.updateGraph"), f("ReelRepresentable.updateNSView", ours: true), f("ReelView.slide", ours: true), f("-[NSView setBoundsOrigin:]"), f("-[NSClipView _scrollTo:]")]
    let lazy = trunk + [f("ViewGraphRootValueUpdater.updateGraph"), f("AG::Graph::UpdateStack::update"), f("LazySubviewPlacements.placeSubviews"), f("EntryRow.body", ours: true)]
    let bench = trunk + [f("closure #1 in Drive.step", ours: true), f("Harness.checkWaiters", ours: true)]
    let stacks = Array(repeating: slide.reversed().map { $0 }, count: 45) + Array(repeating: lazy.reversed().map { $0 }, count: 40) + Array(repeating: bench.reversed().map { $0 }, count: 15)
    let p = StackProfile(stacks: stacks)
    var w = Stretch(step: "step#2 2→5", atMs: 0, durationMs: 106, cpuMs: 104, bodies: ["Column": 4])
    w.samples = p.samples; w.stacks = p.tree; w.topOurs = p.ours; w.topFramework = p.framework; w.topSelf = p.selfTop
    let rep = RepResult(index: 0, steps: [], frames: .empty, mainThread: .empty, bodies: [:], checks: [], worstStretches: [w], window: nil)
    let machine = Machine(model: "test", cores: 8, memoryGB: 16, os: "x", screenHz: 120, loadAvg1: 1, thermalState: "nominal", lowPowerMode: false, heavyProcesses: [])
    let spec = Scenarios.spec("step")!, summary = Summary(reps: [rep])
    let r = BenchResult(tool: ToolInfo(version: "1", commit: "abc", configuration: "release"), scenario: "step", fixture: "crew17", params: [:], startedAt: "now", durationMs: 1,
                        machine: machine, noise: Noise(idle: .empty, idleMain: .empty, machine: machine, window: nil), window: nil, reps: [rep], summary: summary,
                        budget: Budgets.evaluate(spec, reps: [rep], summary: summary), comparison: nil, artifacts: [])
    let causes = Explain.stackCauses(r)
    XCTAssertTrue(causes[0].hasPrefix("45 % of the samples"), causes[0])
    // The wrapper (updateNSView, same weight) gives way to the specific frame; the bench's own frames are never a cause.
    XCTAssertTrue(causes[0].contains("under ReelView.slide (our code); mostly in -[NSClipView _scrollTo:]"), causes[0])
    XCTAssertTrue(causes.contains { $0.contains("LazySubviewPlacements") || $0.contains("EntryRow.body") }, "\(causes)")
    XCTAssertFalse(causes.contains { $0.contains("Drive.step") || $0.contains("Harness.") }, "\(causes)")
    // The SwiftUI-ScrollView reel is gone: its advice must not come back.
    let all = Explain.text(r)
    for stale in ["geometryGroup", "onScrollGeometryChange", "scrollPosition(id:)", "Reel.swift's HStack"] { XCTAssertFalse(all.contains(stale), stale) }
  }

  func testUnsampledStretchSaysWhy() {
    var w = Stretch(step: "after step#1", atMs: 0, durationMs: 50, cpuMs: 49, bodies: [:])
    w.samples = 0; w.unsampled = "missed"
    let lines = Explain.stretchLines(w)
    XCTAssertTrue(lines[0].contains("after step#1") && !lines[0].contains("during after"), lines[0])
    XCTAssertTrue(lines[1].contains("no core in time"), lines[1])
    w.durationMs = 3; w.unsampled = "gate"
    XCTAssertTrue(Explain.stretchLines(w)[1].contains("shorter than the sampler's gate"))
  }
}
