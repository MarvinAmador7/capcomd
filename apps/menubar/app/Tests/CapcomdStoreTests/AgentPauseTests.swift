import XCTest
@testable import CapcomdStore

@MainActor
final class AgentPauseTests: XCTestCase {
  func event(_ s: CapcomdStore, _ type: String, seq: Int, data: [String: JSONValue] = [:]) {
    s.receive(.event(Envelope(id: "e\(seq)", scope: "run-x", seq: seq, entity: "agt-1", type: type, epochMs: seq, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-1", data: data)), scope: "run-x")
  }

  func testPauseHoldsUntilTheAgentIsPausedThenResumeUntilItRuns() async {
    let c = FakeControls(); var n = 0
    let s = CapcomdStore(controls: c, makeKey: { n += 1; return "key-\(n)-xxxxxxxx" })
    event(s, "agent.spawned", seq: 1, data: ["profile": .string("lead")])
    event(s, "agent.started", seq: 2)
    let r = await s.controlAgent(runId: "run-x", agentId: "agt-1", .pause)
    XCTAssertEqual(r, .requested(.pause))
    XCTAssertEqual(c.agentCalls.map { "\($0.0) \($0.1.rawValue)" }, ["agt-1 pause"])
    event(s, "agent.paused", seq: 3)                     // the lifecycle confirms it
    XCTAssertEqual(s.agentControlState["agt-1"], .idle)
    _ = await s.controlAgent(runId: "run-x", agentId: "agt-1", .resume)
    XCTAssertEqual(s.agentControlState["agt-1"], .requested(.resume))
    event(s, "agent.resumed", seq: 4); event(s, "agent.started", seq: 5)
    XCTAssertEqual(s.agentControlState["agt-1"], .idle)
    XCTAssertEqual(Set(c.agentCalls.map(\.2)).count, 2)   // a fresh key per tap
  }

  func testRefusalsAndOlderDaemons() async {
    let c = FakeControls(); let s = CapcomdStore(controls: c)
    c.outcome = ControlRefused("nothing in agt-1's subtree is running to pause")
    let refused = await s.controlAgent(runId: "run-x", agentId: "agt-1", .pause)
    XCTAssertEqual(refused, .failed("nothing in agt-1's subtree is running to pause"))
    c.outcome = DetailUnavailable.unsupported
    let old = await s.controlAgent(runId: "run-x", agentId: "agt-1", .pause)
    XCTAssertEqual(old, .failed("This capcomd can't pause one agent yet"))
  }
}
