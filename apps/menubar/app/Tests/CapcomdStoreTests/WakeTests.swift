import XCTest
import Foundation
@testable import CapcomdStore

/// An agent waiting between turns (capability agents.wake, ADR-026 §3): its column reads "waiting for verify vfy-…" and
/// its clock counts the wait, from snapshot.agents (Agent.activity kind wait), live agent.activity_changed frames and
/// the lifecycle feed's agent.wake_armed; agent.woken clears it and puts a quiet line in its thread.
@MainActor
final class WakeTests: XCTestCase {
  let scope = "lifecycle:run-w"
  func feed(_ s: CapcomdStore, activity: String = "null") {
    let agent = { (id: String, profile: String, parent: String, act: String) in
      #"{"id":"\#(id)","runId":"run-w","parent":\#(parent),"depth":\#(parent == "null" ? 0 : 1),"profile":"\#(profile)","status":"running","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-19T14:43:49.000Z","activity":\#(act)}"#
    }
    let agents = [agent("agt-p", "planner", "null", activity), agent("agt-k", "worker", #""agt-p""#, "null")].joined(separator: ",")
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-w","projectId":"prj-w","label":null,"state":"running","goal":"Ship it"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents)]}"#), ("snapshot.approvals", #"{"approvals":[]}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
  }
  var seq = 3
  func event(_ s: CapcomdStore, _ type: String, _ data: String, ms: Int = 1_795_099_500_000) {
    seq += 1
    let frame = #"{"v":1,"id":"evt_run-w_\#(seq)","scope":"run-w","seq":\#(seq),"entity":"agt-p","entitySeq":\#(seq),"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-11-19T14:45:00.000Z","epochMs":\#(ms),"projectId":"prj-w","runId":"run-w","agentId":"agt-p","text":"x","data":\#(data)}"#
    s.receive(StreamFrame.parse(event: type, data: frame), scope: scope)
  }
  func header(_ s: CapcomdStore) -> ColumnHeader? { s.columnHeader(runId: "run-w", agentId: "agt-p") }

  func testASnapshotOfAWaitingAgentReadsAsWaitingWithTheWaitsClock() {
    let s = CapcomdStore()
    feed(s, activity: #"{"text":"Waiting for verify vfy-k12","kind":"wait","at":"2026-11-19T14:44:00.000Z","wake":{"id":"wk-1","kind":"op","op":"vfy-k12","opKind":"verify","armedAt":"2026-11-19T14:44:00.000Z","at":null}}"#)
    XCTAssertEqual(header(s)?.waitLine, "waiting for verify vfy-k12")
    XCTAssertEqual(header(s)?.waitSinceMs, 1_795_099_440_000)
  }

  func testArmedThenWokenOnTheLifecycleFeed() {
    let s = CapcomdStore()
    feed(s)
    XCTAssertNil(header(s)?.waitLine)
    event(s, "agent.wake_armed", #"{"wakeId":"wk-2","kind":"agents","agents":["agt-k"],"mode":"all","at":null,"note":null,"cause":"waiting"}"#)
    // One agent: named as the app names it.
    XCTAssertEqual(header(s)?.waitLine, "waiting for worker")
    XCTAssertEqual(header(s)?.waitSinceMs, 1_795_099_500_000)
    event(s, "agent.wake_armed", #"{"wakeId":"wk-3","kind":"agents","agents":["agt-k","agt-x","agt-y"],"mode":"all","at":null,"note":null,"cause":"waiting"}"#)
    XCTAssertEqual(header(s)?.waitLine, "waiting for 3 agents")
    // Another wake's end doesn't clear this one.
    event(s, "agent.woken", #"{"wakeId":"wk-2","kind":"agents","by":"event","text":"agt-k ended: done","causeSeq":4,"messageSeq":9,"armedAt":1,"cause":"woken"}"#)
    XCTAssertEqual(header(s)?.waitLine, "waiting for 3 agents")
    event(s, "agent.woken", #"{"wakeId":"wk-3","kind":"op","by":"event","text":"verify vfy-k12 passed","causeSeq":5,"messageSeq":10,"armedAt":1,"cause":"woken"}"#)
    XCTAssertNil(header(s)?.waitLine)
    let woke = s.thread(agentId: "agt-p").compactMap { if case .woke(let t) = $0.kind { return t }; return nil }
    XCTAssertEqual(woke, ["agt-k ended: done · woke planner", "verify passed · woke planner"])
    // The quiet lines are in what its thread shows.
    XCTAssertEqual(s.threadEntries(agentId: "agt-p").count, 2)
  }

  func testATimersLinesAndAnEndClearsTheWait() {
    let s = CapcomdStore()
    feed(s)
    event(s, "agent.wake_armed", #"{"wakeId":"wk-4","kind":"timer","at":1795100000000,"note":"look again","cause":"waiting"}"#)
    XCTAssertEqual(header(s)?.waitLine, "waiting for its check-in")
    XCTAssertEqual(CapcomdStore.wokeLine(["by": .string("time")], name: "planner"), "check-in time · woke planner")
    XCTAssertEqual(CapcomdStore.wokeLine(["by": .string("deadline")], name: "lead"), "wait ran out · woke lead")
    event(s, "agent.done", #"{"result":{"summary":"ok"},"spent":null,"budget":null,"cause":"finished"}"#)
    XCTAssertNil(s.runs["run-w"]?.agents["agt-p"]?.wake)
  }
}
