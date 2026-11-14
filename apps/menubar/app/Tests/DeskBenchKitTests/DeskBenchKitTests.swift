import XCTest
import DeskBenchKit
import CapcomdStore

/// The bench's pure parts: fixtures are deterministic and load into the store as the daemon's events would; the
/// statistics and the verdicts behave; xctrace exports parse.
final class DeskBenchKitTests: XCTestCase {
  func testFixturesAreDeterministicAndLoad() async throws {
    let a = Fixtures.make("crew17")!, b = Fixtures.make("crew17")!
    XCTAssertEqual(a.events.map(\.envelope.id), b.events.map(\.envelope.id))
    XCTAssertEqual(a.threads.mapValues { $0.map(\.id) }, b.threads.mapValues { $0.map(\.id) })
    XCTAssertEqual(a.threads.mapValues { $0.map(\.text) }, b.threads.mapValues { $0.map(\.text) })
    XCTAssertEqual(a.agents[a.openRunId!]?.count, 17)
    XCTAssertEqual(a.asking[a.openRunId!]?.count, 1)
    await MainActor.run {
      let s = CapcomdStore(thread: FixtureThread(a))
      a.load(into: s)
      let decks = s.decks()
      XCTAssertEqual(decks.count, 3)
      XCTAssertEqual(decks[0].runId, a.openRunId)       // the open project is the oldest, with the ask
      XCTAssertEqual(decks[0].agentIds.count, 17)
      XCTAssertNotNil(decks[0].askingAgentId)
      let cols = s.reelColumns(runId: a.openRunId!)
      XCTAssertEqual(cols.map(\.agentId), a.agents[a.openRunId!])
      XCTAssertEqual(cols[0].kind.rawValue, "planner")
    }
  }

  func testFixturePagesServeTheWholeThreadAndLiveFramesAppend() async throws {
    var w = Fixtures.make("trio")!
    let t = FixtureThread(w)
    let agent = w.agents[w.openRunId!]![0]
    var after = 0, got = 0
    for _ in 0..<50 {
      let p = try await t.thread(runId: w.openRunId!, agentId: agent, after: after, limit: 100)
      got += p.items.count
      guard let n = p.next else { break }
      after = n
    }
    XCTAssertEqual(got, w.threads[agent]!.count)
    XCTAssertLessThanOrEqual(t.pagesServed, 2)
    let item = Fixtures.liveItem(world: &w, agentId: agent, text: "hello")
    let f = Fixtures.liveFrame(runId: w.openRunId!, item: item)
    let world = w, runId = w.openRunId!
    await MainActor.run {
      let s = CapcomdStore(thread: t)
      world.load(into: s)
      XCTAssertNil(s.books[agent])
      var seen: Set<ChangeKey> = []
      s.onChanges = { seen = $0 }
      s.receive(.event(f.envelope), scope: f.scope)
      XCTAssertEqual(s.books[agent]?.items.map(\.text), ["hello"])
      XCTAssertEqual(seen, [.run(runId), .agent(agent), .thread(agent)])   // narrowed: only that column re-renders
    }
  }

  func testEveryFixtureBuildsAndMatchesItsSpec() {
    for spec in Fixtures.all {
      let w = Fixtures.make(spec.name)!
      XCTAssertEqual(w.runIds.count, spec.projects, spec.name)
      XCTAssertEqual(w.agents[w.openRunId!]?.count, spec.openAgents, spec.name)
      for (_, items) in w.threads { XCTAssertTrue(spec.itemsPerThread.contains(items.count), spec.name) }
      if spec.needs == true {
        // Spread across projects: every ask is its own agent's (one column each), kinds mixed.
        XCTAssertEqual(w.askFrames.count, spec.asks, spec.name)
        XCTAssertEqual(Set(w.askFrames.map(\.agentId)).count, spec.asks, spec.name)
        XCTAssertEqual(Set(w.askFrames.map(\.runId)).count, min(spec.asks, spec.projects), spec.name)
        XCTAssertEqual(Set(w.askFrames.map(\.kind)), ["merge", "question", "limit"], spec.name)
      } else {
        XCTAssertEqual(w.asking[w.openRunId!]?.count, spec.asks, spec.name)
      }
    }
  }

  /// The needs fixtures in a store: one ask per column, oldest first, not in project order.
  @MainActor func testTheNeedsFixturesAskAcrossProjects() {
    for name in ["needs5", "needs20"] {
      let w = Fixtures.make(name)!
      let s = CapcomdStore()
      w.load(into: s)
      let asks = s.needsAsks()
      XCTAssertEqual(asks.count, w.spec.asks, name)
      XCTAssertEqual(asks.map(\.key), asks.map(\.key).sorted(), name)
      XCTAssertNotEqual(asks.map(\.runId), asks.map(\.runId).sorted(), name)
      XCTAssertTrue(asks.contains { $0.limit != nil }, name)
      XCTAssertTrue(asks.contains { $0.approval?.diff?.total == 3 }, name)
    }
  }

  func testFrameStatsCountLateAndDroppedFrames() {
    let f = FrameStats(intervalsMs: [8.3, 8.4, 8.3, 25.1, 8.3, 50.2, 8.3], nominalHz: 120)
    XCTAssertEqual(f.ticks, 7); XCTAssertEqual(f.late, 2); XCTAssertEqual(f.dropped, 2 + 5)
    XCTAssertEqual(f.p50Ms, 8.3); XCTAssertEqual(f.maxMs, 50.2)
    let m = MainThreadStats(stretchesMs: [1, 2, 20, 120, 300])
    XCTAssertEqual(m.over16, 3); XCTAssertEqual(m.over100, 2); XCTAssertEqual(m.over250, 1); XCTAssertEqual(m.longestMs, 300)
  }

  func testRegressionNeedsMoreThanNoise() {
    let same = Regression(metric: "x", baseline: [10, 11, 10, 12, 10], candidate: [11, 10, 12, 11, 10])
    XCTAssertFalse(same.regression); XCTAssertFalse(same.improvement)
    let worse = Regression(metric: "x", baseline: [10, 11, 10, 12, 10], candidate: [30, 28, 31, 29, 33])
    XCTAssertTrue(worse.regression); XCTAssertEqual(worse.deltaPct, 200)
    let better = Regression(metric: "x", baseline: [30, 28, 31], candidate: [10, 11, 10])
    XCTAssertTrue(better.improvement)
    // Counts near zero: an absolute floor keeps 0 → 1 late frame from being a regression.
    let frames = Regression(metric: "late", baseline: [0, 0, 1, 0, 0], candidate: [1, 0, 1, 1, 0], absoluteFloor: 2)
    XCTAssertFalse(frames.regression)
    let many = Regression(metric: "late", baseline: [0, 0, 1, 0, 0], candidate: [40, 38, 51, 44, 39], absoluteFloor: 2)
    XCTAssertTrue(many.regression)
  }

  func testBudgetVerdicts() {
    let frames = FrameStats(intervalsMs: Array(repeating: 8.3, count: 100), nominalHz: 120)
    let main = MainThreadStats(stretchesMs: [2, 3, 4])
    func rep(_ i: Int, latency: Double, checks: [Check] = []) -> RepResult {
      RepResult(index: i, steps: [StepResult(name: "s", atMs: 0, durationMs: 100, latencyMs: latency, frames: frames, mainThread: main, bodies: [:])],
                frames: frames, mainThread: main, bodies: [:], checks: checks, worstStretches: [], window: nil)
    }
    let open = Scenarios.spec("open")!
    let fast = [rep(0, latency: 40), rep(1, latency: 60), rep(2, latency: 45)]
    XCTAssertTrue(Budgets.evaluate(open, reps: fast, summary: Summary(reps: fast)).pass)
    let slow = [rep(0, latency: 140), rep(1, latency: 160), rep(2, latency: 45)]
    let v = Budgets.evaluate(open, reps: slow, summary: Summary(reps: slow))
    XCTAssertFalse(v.pass); XCTAssertTrue(v.reasons[0].contains("median latency 140.0 ms"))
    // A check failing in one rep of three is noise; in two of three it fails the budget.
    let one = [rep(0, latency: 40, checks: [Check("landed", false, "no")]), rep(1, latency: 40), rep(2, latency: 40)]
    XCTAssertTrue(Budgets.evaluate(open, reps: one, summary: Summary(reps: one)).pass)
    let two = [rep(0, latency: 40, checks: [Check("landed", false, "no")]), rep(1, latency: 40, checks: [Check("landed", false, "no")]), rep(2, latency: 40)]
    XCTAssertFalse(Budgets.evaluate(open, reps: two, summary: Summary(reps: two)).pass)
  }

  func testResultRoundTripsAndPicksExitCodes() throws {
    let frames = FrameStats(intervalsMs: [8.3, 8.3, 30], nominalHz: 120)
    let rep = RepResult(index: 0, steps: [], frames: frames, mainThread: .empty, bodies: ["Column": 3], checks: [], worstStretches: [], window: nil)
    let machine = Machine(model: "test", cores: 8, memoryGB: 16, os: "x", screenHz: 120, loadAvg1: 1, thermalState: "nominal", lowPowerMode: false, heavyProcesses: [])
    let quiet = Noise(idle: .empty, idleMain: .empty, machine: machine, window: nil)
    let noisy = Noise(idle: .empty, idleMain: .empty, machine: Machine(model: "t", cores: 8, memoryGB: 16, os: "x", screenHz: 120, loadAvg1: 9, thermalState: "serious", lowPowerMode: false, heavyProcesses: ["WindowServer 60%"]), window: nil)
    XCTAssertTrue(quiet.quiet); XCTAssertFalse(noisy.quiet); XCTAssertEqual(noisy.reasons.count, 3)
    let spec = Scenarios.spec("step")!
    let failing = Budgets.evaluate(spec, reps: [rep], summary: Summary(reps: [rep]))
    XCTAssertFalse(failing.pass)
    let r1 = BenchResult(tool: ToolInfo(version: "1", commit: nil, configuration: "debug"), scenario: "step", fixture: "crew17", params: [:], startedAt: "now", durationMs: 1,
                         machine: machine, noise: quiet, window: nil, reps: [rep], summary: Summary(reps: [rep]), budget: failing, comparison: nil, artifacts: [])
    XCTAssertEqual(r1.verdict, "fail"); XCTAssertEqual(r1.exitCode, ExitCode.budget)
    let r2 = BenchResult(tool: r1.tool, scenario: "step", fixture: "crew17", params: [:], startedAt: "now", durationMs: 1, machine: machine, noise: noisy, window: nil,
                         reps: [rep], summary: Summary(reps: [rep]), budget: failing, comparison: nil, artifacts: [])
    XCTAssertEqual(r2.verdict, "untrusted"); XCTAssertEqual(r2.exitCode, ExitCode.untrusted)
    let text = JSONOut.encode(r1)
    let back = try JSONOut.decode(BenchResult.self, from: Data(text.utf8))
    XCTAssertEqual(back, r1)
    XCTAssertTrue(Explain.text(r1).contains("FAIL"))
  }

  func testXCTraceExportParses() throws {
    let xml = """
    <?xml version="1.0"?>
    <trace-query-result>
    <node xpath='//trace-toc[1]/run[1]/data[1]/table[37]'><schema name="hitches"><col><mnemonic>start</mnemonic><name>Start</name><engineering-type>start-time</engineering-type></col><col><mnemonic>duration</mnemonic><name>Duration</name><engineering-type>duration</engineering-type></col><col><mnemonic>process</mnemonic><name>Process</name><engineering-type>process</engineering-type></col><col><mnemonic>narrative-description</mnemonic><name>Potential Issue</name><engineering-type>string</engineering-type></col></schema>
    <row><start-time id="1" fmt="00:00.548">548854666</start-time><duration id="2" fmt="12.50 ms">12499791</duration><process id="3" fmt="CapcomdDeskBench (78257)"><pid id="4" fmt="78257">78257</pid></process><string id="5" fmt="Late commit">Late commit</string><sentinel/></row>
    <row><start-time id="6" fmt="00:00.561">561354457</start-time><duration id="7" fmt="25.00 ms">25000000</duration><process ref="3"/><string ref="5"/><sentinel/></row>
    <row><start-time id="8" fmt="00:00.561">561354457</start-time><duration id="9" fmt="25.00 ms">25000000</duration><process id="10" fmt="Finder (1)"><pid id="11" fmt="1">1</pid></process><string ref="5"/><sentinel/></row>
    </node>
    </trace-query-result>
    """
    let t = try XCTable(xml: Data(xml.utf8))
    XCTAssertEqual(t.schema, "hitches"); XCTAssertEqual(t.rows.count, 3)
    XCTAssertEqual(t.rows[1]["process"]?.attrs["fmt"], "CapcomdDeskBench (78257)")   // the ref resolved
    let h = HitchSummary(hitches: t, hangs: nil, process: "CapcomdDeskBench")
    XCTAssertEqual(h.hitches, 2); XCTAssertEqual(h.over16Ms, 1); XCTAssertEqual(h.causes["Late commit"], 2); XCTAssertEqual(h.maxMs, 25)
  }

  func testTimeProfileSummaryFindsBurstsAndOurFrames() throws {
    var rows = ""
    for i in 0..<40 {   // 40 samples 1 ms apart on the main thread: one burst of 40
      rows += """
      <row><sample-time id="\(100 + i)" fmt="x">\(1_000_000 * i)</sample-time><thread id="\(200 + i)" fmt="Main Thread  0x1"><tid>1</tid></thread><backtrace id="\(300 + i)"><frame id="\(400 + i)" name="AG::Graph::propagate_dirty(unsigned int)"/><frame id="\(500 + i)" name="Column.body.getter"/><frame id="\(600 + i)" name="main"/></backtrace></row>
      """
    }
    rows += "<row><sample-time id=\"900\" fmt=\"x\">900000000</sample-time><thread id=\"901\" fmt=\"Main Thread  0x1\"><tid>1</tid></thread><backtrace id=\"902\"><frame id=\"903\" name=\"idle\"/></backtrace></row>"
    rows += "<row><sample-time id=\"910\" fmt=\"x\">900000000</sample-time><thread id=\"911\" fmt=\"worker\"><tid>2</tid></thread><backtrace id=\"912\"><frame id=\"913\" name=\"Column.body.getter\"/></backtrace></row>"
    let xml = "<trace-query-result><node><schema name=\"time-profile\"><col><mnemonic>sample-time</mnemonic></col><col><mnemonic>thread</mnemonic></col><col><mnemonic>backtrace</mnemonic></col></schema>\(rows)</node></trace-query-result>"
    let t = try XCTable(xml: Data(xml.utf8))
    let p = ProfileSummary(timeProfile: t, ids: t.ids)
    XCTAssertEqual(p.mainThreadSamples, 41)   // the worker thread's sample is not counted
    XCTAssertEqual(p.bursts, 1); XCTAssertEqual(p.burstSizes, [40])
    XCTAssertEqual(p.inclusiveOurs.first { $0.symbol == "Column.body.getter" }?.samples, 40)
    XCTAssertEqual(p.selfTop.first?.symbol, "AG::Graph::propagate_dirty")
  }
}
