import XCTest
@testable import CapcomdStore

@MainActor
final class StepHistoryTests: XCTestCase {
  func ev(_ seq: Int, _ type: String, agent: String, data: [String: JSONValue] = [:], text: String? = nil) -> Envelope {
    var e = Envelope(id: "e\(seq)", scope: "run-x", seq: seq, entity: agent, type: type, epochMs: 1_000 * seq, projectId: "prj-x", runId: "run-x",
                     agentId: agent, data: data)
    e.text = text
    return e
  }
  func step(_ seq: Int, agent: String, kind: String, n: Int = 1, text: String) -> Envelope {
    ev(seq, "agent.step", agent: agent, data: ["kind": .string(kind), "n": .number(Double(n)), "startedAt": .number(Double(seq * 1_000 - 500)), "endedAt": .number(Double(seq * 1_000))], text: text)
  }
  func send(_ s: CapcomdStore, _ e: Envelope) { s.receive(.event(e), scope: "run-x") }

  func testAFinishedAgentShowsEachStepInOrderAndNotItsLastLineAgain() {
    let s = CapcomdStore()
    send(s, ev(1, "agent.spawned", agent: "agt-w", data: ["profile": .string("worker")]))
    send(s, ev(2, "agent.started", agent: "agt-w"))
    send(s, step(3, agent: "agt-w", kind: "read", n: 2, text: "Read 2 files"))
    send(s, step(4, agent: "agt-w", kind: "edit", text: "Edited a file"))
    send(s, step(5, agent: "agt-w", kind: "test", text: "Ran the tests"))
    send(s, ev(6, "agent.done", agent: "agt-w"))
    let rows = s.steps(forRun: "run-x")
    XCTAssertEqual(rows.map(\.text), ["Read 2 files", "Edited a file", "Ran the tests"])
    XCTAssertEqual(rows.map(\.agentId), ["agt-w", "agt-w", "agt-w"])                  // the bot leads each row
    XCTAssertEqual(rows.map(\.kind), [.fileRead, .fileWrite, .tool])
  }

  func testAWorkingAgentKeepsItsLiveLineAfterItsHistory() {
    let s = CapcomdStore()
    send(s, ev(1, "agent.spawned", agent: "agt-w", data: ["profile": .string("worker")]))
    send(s, ev(2, "agent.spawned", agent: "agt-r", data: ["profile": .string("worker")]))
    send(s, ev(3, "agent.started", agent: "agt-w"))
    send(s, step(4, agent: "agt-w", kind: "read", text: "Read a file"))
    send(s, ev(5, "agent.activity_changed", agent: "agt-w", data: ["activity": .object(["text": .string("Editing a file"), "kind": .string("edit")])]))
    let rows = s.steps(forRun: "run-x")
    XCTAssertEqual(rows.map(\.text), ["worker", "Read a file", "Editing a file"])     // agt-r has no history: its spawn row stays
    XCTAssertEqual(rows.last?.status, .running)
  }

  func testAPlannersSpawnAndWaitStepsStay() {
    let s = CapcomdStore()
    send(s, ev(1, "agent.spawned", agent: "agt-p", data: ["profile": .string("planner")]))
    send(s, ev(2, "agent.started", agent: "agt-p"))
    send(s, step(3, agent: "agt-p", kind: "spawn", text: "Started a sub-agent"))
    send(s, step(4, agent: "agt-p", kind: "wait", text: "Waited for sub-agents"))
    send(s, step(5, agent: "agt-p", kind: "report", text: "Reported back"))
    send(s, ev(6, "agent.done", agent: "agt-p"))
    XCTAssertEqual(s.steps(forRun: "run-x").map(\.text), ["Started a sub-agent", "Waited for sub-agents", "Reported back"])
  }

  func testAReplayedStepIsOneRow() {
    let s = CapcomdStore()
    send(s, ev(1, "agent.spawned", agent: "agt-w", data: ["profile": .string("worker")]))
    send(s, step(2, agent: "agt-w", kind: "read", text: "Read a file"))
    var again = step(2, agent: "agt-w", kind: "read", text: "Read a file"); again.seq = 9; again.id = "e9"
    send(s, again)
    XCTAssertEqual(s.steps(forRun: "run-x").filter { $0.id.hasPrefix("step:") }.count, 1)
  }
}
