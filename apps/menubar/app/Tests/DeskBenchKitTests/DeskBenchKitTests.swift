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







}
