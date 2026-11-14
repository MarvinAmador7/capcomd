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
    // w2's work waits to merge, but its lead is the one waiting (an older daemon's approval: no subject.askedBy).
    XCTAssertEqual(d[0].askingAgentId, "ld")
    XCTAssertEqual(d[0].askingName, "lead")
    XCTAssertNil(d[1].askingAgentId)
    XCTAssertEqual(d[0].agentIds, ["pl", "ld", "w1", "w2", "cr"])
  }

  func testAMergeWaitsOnTheAgentThatAskedForIt() {
    let s = store()
    // The planner merges its grandchild's work: subject.askedBy names it, over the merged agent's parent.
    ev(s, "run-a", "approval.requested", "w1", ["approvalId": .string("apr-2"), "kind": .string("merge"), "question": .string("Merge?"),
                                                "requestedBy": .object(["agentId": .string("w1"), "runId": .string("run-a")]),
                                                "subject": .object(["target": .string("main"), "askedBy": .string("pl")])], at: 1_009)
    let a = s.approvals(forRun: "run-a").first { $0.id == "apr-2" }!
    XCTAssertEqual(a.askedBy, "pl")
    XCTAssertEqual(s.waitingAgent(a), "pl")
    // An asker that isn't in the run falls back to the merged agent's parent.
    var stray = a; stray.askedBy = "agt-elsewhere"
    XCTAssertEqual(s.waitingAgent(stray), "ld")
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

  func testAFinishedDeckSaysHowItEndedNotAZeroClock() {
    let s = CapcomdStore()
    ev(s, "run-e", "run.created", nil, ["goal": .string("Finished one")], at: 10_000)
    ev(s, "run-e", "agent.spawned", "p", ["profile": .string("planner")], at: 10_001)
    ev(s, "run-e", "agent.started", "p", at: 10_002)
    ev(s, "run-e", "agent.done", "p", at: 249_000)
    ev(s, "run-e", "run.completed", nil, at: 250_000)
    let d = s.decks()
    XCTAssertEqual(d.first?.endedHead, "Done in 4m")
    XCTAssertNil(store().decks().first?.endedHead)   // a running deck keeps its clock
  }

  func testADeckSaysWhereItRunsWhenTheDaemonDoes() {
    let s = CapcomdStore()
    ev(s, "run-c", "run.created", nil, ["goal": .string("Cloud one"), "sandbox": .string("boxd")], at: 1)
    ev(s, "run-d", "run.created", nil, ["goal": .string("Older daemon")], at: 2)
    XCTAssertEqual(s.decks().map(\.sandbox), ["boxd", nil])
    // A run that names no place runs on the daemon's own (run options' default): the project label's icon shows it.
    s.runOptions = RunOptions(sandboxes: [SandboxInfo(name: "docker", label: "Local", isDefault: true), SandboxInfo(name: "boxd", label: "Cloud", isDefault: false)])
    XCTAssertEqual(s.decks().map(\.sandbox), ["boxd", "docker"])
  }

  /// A column's clock starts when its agent was spawned. A lifecycle snapshot lists agents without their agent.spawned
  /// events, so their order fell back to the snapshot's index (0, 1, 2…) and the clock read 498196 hours. The daemon's
  /// `createdAt` is the clock now; a daemon that doesn't send it shows no clock rather than a wrong one.
  func testAColumnClockStartsWhenTheAgentWasSpawned() throws {
    func agents(_ json: String) throws -> [SnapshotAgent] { try JSONDecoder().decode([SnapshotAgent].self, from: Data(json.utf8)) }
    let s = CapcomdStore()
    let key = CapcomdStore.lifecycleKey("run-s")
    s.receive(.reset(snapshotSeq: 5, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotRun(SnapshotRun(id: "run-s", projectId: "p", label: nil, state: "running", goal: "g", createdAt: nil)), scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 5), scope: "daemon")
    s.receive(.reset(snapshotSeq: 9, reason: "compacted"), scope: key)
    s.receive(.snapshotRun(SnapshotRun(id: "run-s", projectId: "p", label: nil, state: "running", goal: "g", createdAt: nil)), scope: key)
    s.receive(.snapshotAgents(try agents("""
      [{"id":"a","runId":"run-s","parent":null,"depth":0,"profile":"lead","status":"running","createdAt":"2026-11-01T04:16:48.115Z"},
       {"id":"b","runId":"run-s","parent":"a","depth":1,"profile":"worker","status":"running"}]
      """)), scope: key)
    s.receive(.snapshotEnd(snapshotSeq: 9), scope: key)
    let cols = s.reelColumns(runId: "run-s")
    XCTAssertEqual(cols.map(\.agentId), ["a", "b"])
    XCTAssertEqual(cols[0].startedAtMs, epochMs(iso: "2026-11-01T04:16:48.115Z"))
    XCTAssertNil(cols[1].startedAtMs)   // an older daemon: no clock
    // A live spawn starts the clock at its event.
    ev(s, "run-s", "agent.spawned", "c", ["profile": .string("worker"), "parent": .string("a")], at: 1_793_506_700_000)
    XCTAssertEqual(s.columnHeader(runId: "run-s", agentId: "c")?.startedAtMs, 1_793_506_700_000)
  }

  /// The daemon scope sends no snapshot (an empty daemon sends nothing but `: connected`): the first answer on its feed
  /// is what says an empty project list is really empty. A run's feed answering says nothing about the daemon's list.
  func testTheDaemonIsLoadedOnceItsFeedAnswers() async throws {
    let s = CapcomdStore()
    var changes = 0
    s.onChange = { changes += 1 }
    s.receive(.link(up: true), scope: CapcomdStore.lifecycleKey("run-x"))
    XCTAssertFalse(s.daemonLoaded)
    s.receive(.link(up: true), scope: "daemon")
    XCTAssertTrue(s.daemonLoaded)
    XCTAssertTrue(s.decks().isEmpty)   // loaded and empty: nothing running
    XCTAssertEqual(changes, 0)         // reported a moment later, after the run list on its way
    for _ in 0..<100 where changes == 0 { try await Task.sleep(for: .milliseconds(10)) }
    XCTAssertEqual(changes, 1)
    XCTAssertFalse(s.daemonUnreachable)
  }
}
