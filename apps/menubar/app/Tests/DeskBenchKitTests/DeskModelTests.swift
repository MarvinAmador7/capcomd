import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// The desktop model against a store fed event by event, as the live daemon feeds it: Follow, and what the window says
/// before and between connections.
final class DeskModelTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  var seq = 0
  @MainActor func ev(_ s: CapcomdStore, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: "run-a", seq: seq, entity: agent ?? "run-a", type: type, epochMs: at, projectId: "prj-a",
                              runId: "run-a", agentId: agent, data: d)), scope: "run-a")
  }

  /// One run: a lead and five workers, all running.
  @MainActor func store(failed: [String] = []) -> CapcomdStore {
    let s = CapcomdStore()
    ev(s, "run.created", nil, ["goal": .string("Backfill the ids")], at: 1_000)
    ev(s, "agent.spawned", "ld", ["profile": .string("lead")], at: 1_001)
    for (n, w) in ["w1", "w2", "w3", "w4", "w5"].enumerated() {
      ev(s, "agent.spawned", w, ["profile": .string("worker"), "parent": .string("ld")], at: 1_002 + n)
      ev(s, "agent.started", w, at: 1_010 + n)
    }
    for w in failed { ev(s, "agent.failed", w, at: 1_020) }
    return s
  }

  /// SPEC §3: a failure in the open project scrolls the reel to it while Follow is on.
  @MainActor func testAFailureScrollsTheReelToItWhileFollowing() {
    let s = store()
    let m = DeskModel(store: s)
    m.across = 2
    XCTAssertEqual(m.columns, ["ld", "w1", "w2", "w3", "w4", "w5"])
    XCTAssertFalse(m.onScreen.contains("w4"))
    ev(s, "agent.failed", "w4", at: 2_000)
    XCTAssertEqual(m.focusedAgent, "w4")
    XCTAssertTrue(m.onScreen.contains("w4"))
    XCTAssertEqual(m.reelRequest?.agentId, "w3")   // the least move that shows it: w4 lands as the last column on screen
    XCTAssertEqual(m.reelRequest?.animated, true)
  }

  /// A project opened with failures already in it starts where it starts; only a new failure moves it.
  @MainActor func testFailuresAlreadyThereDontMoveTheReel() {
    let s = store(failed: ["w5"])
    let m = DeskModel(store: s)
    m.across = 2
    XCTAssertNil(m.focusedAgent)
    ev(s, "agent.activity_changed", "w1", ["activity": .object(["text": .string("Reading"), "kind": .string("read")])], at: 2_000)
    ev(s, "agent.done", "w2", at: 2_001)
    XCTAssertNil(m.focusedAgent)
    XCTAssertFalse(m.onScreen.contains("w5"))
  }

  /// The window opens a project as soon as the daemon lists its run, before the run's own feed has sent its agents.
  /// The failures in that first snapshot of the agents were already there: they don't move the reel; a later one does.
  @MainActor func testFailuresInTheFirstSnapshotOfTheAgentsDontMoveTheReel() throws {
    let s = CapcomdStore()
    s.receive(.reset(snapshotSeq: 1, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotRun(SnapshotRun(id: "run-a", projectId: "p", label: nil, state: "running", goal: "g", createdAt: nil)), scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 1), scope: "daemon")
    let m = DeskModel(store: s)
    m.across = 2
    XCTAssertEqual(m.openRunId, "run-a")
    XCTAssertTrue(m.columns.isEmpty)
    let key = CapcomdStore.lifecycleKey("run-a")
    let agents = try JSONDecoder().decode([SnapshotAgent].self, from: Data("""
      [{"id":"ld","runId":"run-a","parent":null,"depth":0,"profile":"lead","status":"running"},
       {"id":"w1","runId":"run-a","parent":"ld","depth":1,"profile":"worker","status":"running"},
       {"id":"w2","runId":"run-a","parent":"ld","depth":1,"profile":"worker","status":"running"},
       {"id":"w3","runId":"run-a","parent":"ld","depth":1,"profile":"worker","status":"failed"}]
      """.utf8))
    s.receive(.reset(snapshotSeq: 9, reason: "compacted"), scope: key)
    s.receive(.snapshotAgents(agents), scope: key)
    s.receive(.snapshotEnd(snapshotSeq: 9), scope: key)
    XCTAssertEqual(m.columns, ["ld", "w1", "w2", "w3"])
    XCTAssertNil(m.focusedAgent)
    XCTAssertFalse(m.onScreen.contains("w3"))
    s.receive(.event(Envelope(id: "f", scope: key, seq: 10, entity: "w2", type: "agent.failed", epochMs: 2_000, projectId: "p", runId: "run-a",
                              agentId: "w2", data: [:])), scope: key)
    XCTAssertEqual(m.focusedAgent, "w2")
  }

  @MainActor func testWithFollowOffAFailureStaysPut() {
    let s = store()
    let m = DeskModel(store: s)
    m.across = 2
    m.follow = false
    ev(s, "agent.failed", "w4", at: 2_000)
    XCTAssertNil(m.focusedAgent)
    XCTAssertFalse(m.onScreen.contains("w4"))
  }

  /// Before the daemon's first snapshot the window has nothing to say (not "nothing running"); when its feed drops the
  /// window says so, and says so no more once it's back.
  @MainActor func testLoadedAndUnreachableFollowTheDaemonFeed() {
    let s = CapcomdStore()
    let m = DeskModel(store: s)
    XCTAssertFalse(m.loaded)
    XCTAssertFalse(m.unreachable)
    s.receive(.reset(snapshotSeq: 1, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 1), scope: "daemon")
    XCTAssertTrue(m.loaded)
    XCTAssertNil(m.openRunId)
    s.receive(.link(up: false), scope: "daemon")
    XCTAssertTrue(m.unreachable)
    s.receive(.link(up: true), scope: "daemon")
    XCTAssertFalse(m.unreachable)
  }
  #endif
}
