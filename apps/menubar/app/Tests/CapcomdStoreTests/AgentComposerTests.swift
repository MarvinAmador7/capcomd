import XCTest
@testable import CapcomdStore

/// A messenger that keeps the model and effort it was given (the pane composer's next-turn pick).
final class ModelMessenger: AgentMessaging, @unchecked Sendable {
  var calls: [(body: String, model: String?, effort: String?)] = []
  func send(runId: String, agentId: String, body: String, skills: [String], idempotencyKey: String) async throws -> SentMessage {
    calls.append((body, nil, nil)); return SentMessage(seq: calls.count, note: nil)
  }
  func send(runId: String, agentId: String, body: String, skills: [String], model: String?, effort: String?, idempotencyKey: String) async throws -> SentMessage {
    calls.append((body, model, effort)); return SentMessage(seq: calls.count, note: nil)
  }
}

@MainActor
final class AgentComposerTests: XCTestCase {
  func event(_ s: CapcomdStore, _ type: String, seq: Int, data: [String: JSONValue] = [:]) {
    s.receive(.event(Envelope(id: "e\(seq)", scope: "run-x", seq: seq, entity: "agt-1", type: type, epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-1", data: data)), scope: "run-x")
  }

  func testStopIsOfferedOnlyWhileItWorksAndTheDaemonCanPauseIt() async {
    let info = FakeInfo()
    let s = CapcomdStore(messenger: FakeMessenger(), daemonInfo: info)
    event(s, "agent.spawned", seq: 1, data: ["profile": .string("planner")])
    event(s, "agent.started", seq: 2)
    var c = s.paneComposer(runId: "run-x", agentId: "agt-1", name: "planner")
    XCTAssertEqual(c.placeholder, "Tell planner…")
    XCTAssertTrue(c.isWorking)
    XCTAssertFalse(c.canStop)                                                   // this daemon can't pause it
    XCTAssertTrue(c.canSend)
    info.caps = [Capability.agentPause]; await s.refreshDaemonInfo()
    c = s.paneComposer(runId: "run-x", agentId: "agt-1", name: "planner")
    XCTAssertTrue(c.canStop)
    event(s, "agent.done", seq: 3)
    c = s.paneComposer(runId: "run-x", agentId: "agt-1", name: "planner")
    XCTAssertFalse(c.isWorking)
    XCTAssertFalse(c.canStop)
    XCTAssertFalse(c.canSend)                                                   // before the agent lifecycle, an ended agent reads nothing
  }

  func testTheNextTurnsModelRidesOnlyWhenTheDaemonTakesIt() async {
    let m = ModelMessenger(), info = FakeInfo()
    let s = CapcomdStore(messenger: m, daemonInfo: info)
    await s.refreshDaemonInfo()
    s.setNextTurn(agentId: "agt-1", model: .some("claude-sonnet-4-5"), effort: .some("high"))
    await s.steer(runId: "run-x", agentId: "agt-1", body: "a")
    XCTAssertNil(m.calls.last?.model)                                           // older daemon: the message alone
    XCTAssertNil(m.calls.last?.effort)
    info.caps = [Capability.agentsMessagesModel]; await s.refreshDaemonInfo()
    await s.steer(runId: "run-x", agentId: "agt-1", body: "b")
    XCTAssertEqual(m.calls.last?.model, "claude-sonnet-4-5")
    XCTAssertEqual(m.calls.last?.effort, "high")
  }

  func testClearingThePickSendsTheMessageAlone() async {
    let m = ModelMessenger(), info = FakeInfo(); info.caps = [Capability.agentsMessagesModel]
    let s = CapcomdStore(messenger: m, daemonInfo: info)
    await s.refreshDaemonInfo()
    s.setNextTurn(agentId: "agt-1", effort: .some("low"))
    s.setNextTurn(agentId: "agt-1", effort: .some(nil))
    XCTAssertNil(s.nextTurn["agt-1"])
    await s.steer(runId: "run-x", agentId: "agt-1", body: "c")
    XCTAssertNil(m.calls.last?.effort)
  }
}
