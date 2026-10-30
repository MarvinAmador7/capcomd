import XCTest
@testable import CapcomdStore

/// The desktop window's read model (design/desktop): decks in a stable order, reel columns in tree order, the ask.
@MainActor
final class DeskTests: XCTestCase {
  var seq = 0
  func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)", runId: run,
                              agentId: agent, data: d)), scope: run)
  }
  /// run-a (started first): planner ─┬ lead ─┬ worker task-d3ce
  ///                                 │       └ worker task-4423 (asks)
  ///                                 └ critic
  /// run-b (started later): planner
  func store() -> CapcomdStore {
    let s = CapcomdStore()
    ev(s, "run-b", "run.created", nil, ["goal": .string("Fix proration rounding in billing")], at: 2_000)
    ev(s, "run-b", "agent.spawned", "bpl", ["profile": .string("planner")], at: 2_001)
    ev(s, "run-a", "run.created", nil, ["goal": .string("Migrate matchkey to v3.2")], at: 1_000)
    ev(s, "run-a", "agent.spawned", "pl", ["profile": .string("planner")], at: 1_001)
    ev(s, "run-a", "agent.spawned", "ld", ["profile": .string("lead"), "parent": .string("pl")], at: 1_002)
    ev(s, "run-a", "agent.spawned", "cr", ["profile": .string("critic"), "parent": .string("pl")], at: 1_003)
    ev(s, "run-a", "agent.spawned", "w1", ["profile": .string("worker"), "parent": .string("ld"), "key": .string("task-d3ce")], at: 1_004)
    ev(s, "run-a", "agent.spawned", "w2", ["profile": .string("worker"), "parent": .string("ld"), "key": .string("task-4423")], at: 1_005)
    ev(s, "run-a", "agent.started", "w1", at: 1_006)
    ev(s, "run-a", "agent.activity_changed", "w1", ["activity": .object(["text": .string("Writing shard 118 of 256"), "kind": .string("edit")])], at: 1_007)
    ev(s, "run-a", "approval.requested", "w2", ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge?"),
                                                "requestedBy": .object(["agentId": .string("w2"), "runId": .string("run-a")])], at: 1_008)
    // run-b moves last: decks must not reorder by activity.
    ev(s, "run-b", "agent.started", "bpl", at: 3_000)
    return s
  }

  func testDecksKeepTheirOrderAndSayWhoAsks() {
    let d = store().decks()
    XCTAssertEqual(d.map(\.title), ["Migrate matchkey to v3.2", "Fix proration rounding in billing"])
    XCTAssertEqual(d[0].runId, "run-a")
    XCTAssertEqual(d[0].askingAgentId, "w2")
    XCTAssertEqual(d[0].askingName, "worker 4423")
    XCTAssertNil(d[1].askingAgentId)
    XCTAssertEqual(d[0].agentIds, ["pl", "ld", "w1", "w2", "cr"])
  }

  func testReelColumnsFollowTheTree() {
    let cols = store().reelColumns(runId: "run-a")
    XCTAssertEqual(cols.map(\.agentId), ["pl", "ld", "w1", "w2", "cr"])
    XCTAssertEqual(cols.map(\.depth), [0, 1, 2, 2, 1])
    XCTAssertEqual(cols[2].suffix, "d3ce")
    XCTAssertEqual(cols[2].activity, "Writing shard 118 of 256")
    XCTAssertTrue(cols[3].waiting)
    XCTAssertFalse(cols[2].waiting)
  }

  func testAnActivityFrameChangesOnlyItsAgentsHeader() {
    let s = store()
    let before = s.reelColumns(runId: "run-a")
    var e = Envelope(id: "act", scope: "run-a", seq: 99, entity: "w1", type: "agent.activity_changed", epochMs: 4_000, projectId: "prj-run-a",
                     runId: "run-a", agentId: "w1", data: ["activity": .object(["text": .string("Writing shard 119 of 256"), "kind": .string("edit")])])
    e.durability = "ephemeral"
    s.receive(.event(e), scope: CapcomdStore.lifecycleKey("run-a"))
    let after = s.reelColumns(runId: "run-a")
    XCTAssertEqual(zip(before, after).filter { $0 != $1 }.map(\.0.agentId), ["w1"])   // the app reassigns one slice
  }

  func testADeckSaysWhereItRunsWhenTheDaemonDoes() {
    let s = CapcomdStore()
    ev(s, "run-c", "run.created", nil, ["goal": .string("Cloud one"), "sandbox": .string("boxd")], at: 1)
    ev(s, "run-d", "run.created", nil, ["goal": .string("Older daemon")], at: 2)
    XCTAssertEqual(s.decks().map(\.sandbox), ["boxd", nil])
  }
}
