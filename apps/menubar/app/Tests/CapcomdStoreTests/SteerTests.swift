import XCTest
@testable import CapcomdStore

final class FakeMessenger: AgentMessaging, @unchecked Sendable {
  var outcomes: [Result<SentMessage, Error>] = []
  var calls: [(body: String, skills: [String], key: String)] = []
  func send(runId: String, agentId: String, body: String, skills: [String], idempotencyKey: String) async throws -> SentMessage {
    calls.append((body, skills, idempotencyKey)); return try outcomes.removeFirst().get()
  }
}
final class FakeInfo: DaemonInfoFetching, @unchecked Sendable {
  var caps: Set<String> = []
  func capabilities() async throws -> Set<String> { caps }
  func skills() async throws -> [SkillInfo] { [SkillInfo(name: "validate-shards", description: "Null checks", source: "user")] }
}

@MainActor
final class SteerTests: XCTestCase {
  func messageSent(_ s: CapcomdStore, to agent: String, seq: Int, text: String) {
    s.receive(.event(Envelope(id: "m\(seq)", scope: "run-x", seq: 100 + seq, entity: "msg", type: "message.sent", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: "operator", data: ["from": .string("operator"), "to": .string(agent), "seq": .number(Double(seq)), "text": .string(text)])), scope: "run-x")
  }

  func testASentSteerGivesWayToItsMessageSent() async {
    let m = FakeMessenger(); m.outcomes = [.success(SentMessage(seq: 7, note: nil))]
    let s = CapcomdStore(messenger: m, makeKey: { "key-1" })
    s.receive(.event(Envelope(id: "sp", scope: "run-x", seq: 1, entity: "agt-1", type: "agent.spawned", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-1", data: ["profile": .string("lead")])), scope: "run-x")
    await s.steer(runId: "run-x", agentId: "agt-1", body: "  Re-run shards 116–118  ")
    XCTAssertEqual(m.calls.first?.body, "Re-run shards 116–118")
    XCTAssertEqual(s.pendingSteers(agentId: "agt-1").map(\.state), [.sent(seq: 7)])
    messageSent(s, to: "agt-1", seq: 7, text: "Re-run shards 116–118")
    XCTAssertTrue(s.pendingSteers(agentId: "agt-1").isEmpty)                 // the real message replaced it
    XCTAssertEqual(s.thread(agentId: "agt-1").map(\.id), ["msg:operator:agt-1:7"])
  }

  func testAFailedSteerRetriesWithTheSameKey() async {
    struct Down: Error {}
    let m = FakeMessenger(); m.outcomes = [.failure(Down()), .success(SentMessage(seq: 3, note: nil))]
    var n = 0
    let s = CapcomdStore(messenger: m, makeKey: { n += 1; return "key-\(n)" })
    await s.steer(runId: "run-x", agentId: "agt-1", body: "hello")
    let failed = s.pendingSteers(agentId: "agt-1")
    XCTAssertEqual(failed.map(\.state), [.failed("Couldn't reach capcomd")])
    await s.steer(runId: "run-x", agentId: "agt-1", body: "hello", retrying: failed[0].id)
    XCTAssertEqual(m.calls.map(\.key), ["key-1", "key-1"])                     // a retry replays, never sends twice
    XCTAssertEqual(s.pendingSteers(agentId: "agt-1").count, 1)
  }

  func testSkillsRideAlongOnlyWhenTheDaemonSaysSo() async {
    let m = FakeMessenger(); m.outcomes = [.success(SentMessage(seq: 1, note: nil)), .success(SentMessage(seq: 2, note: nil))]
    let info = FakeInfo()
    let s = CapcomdStore(messenger: m, daemonInfo: info)
    await s.refreshDaemonInfo()
    XCTAssertEqual(s.skills?.value?.map(\.name), ["validate-shards"])
    await s.steer(runId: "run-x", agentId: "agt-1", body: "a", skills: ["validate-shards"])
    XCTAssertEqual(m.calls.last?.skills, [])                                  // older daemon: not sent
    info.caps = [Capability.steerSkills]; await s.refreshDaemonInfo()
    await s.steer(runId: "run-x", agentId: "agt-1", body: "b", skills: ["validate-shards"])
    XCTAssertEqual(m.calls.last?.skills, ["validate-shards"])
  }

  func testARefusalIsShownAsSuch() async {
    let m = FakeMessenger(); m.outcomes = [.failure(MessageRefused("agt-1 is done: nothing will read this message"))]
    let s = CapcomdStore(messenger: m)
    await s.steer(runId: "run-x", agentId: "agt-1", body: "late")
    XCTAssertEqual(s.pendingSteers(agentId: "agt-1").first?.state, .failed("agt-1 is done: nothing will read this message"))
    s.discardSteer(agentId: "agt-1", id: s.pendingSteers(agentId: "agt-1")[0].id)
    XCTAssertTrue(s.pendingSteers(agentId: "agt-1").isEmpty)
  }
}
