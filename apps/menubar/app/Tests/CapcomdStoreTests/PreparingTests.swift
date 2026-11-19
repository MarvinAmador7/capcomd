import XCTest
import Foundation
@testable import CapcomdStore

/// An agent's empty thread while the daemon gets it ready (capability agents.setup): Agent.activity of kind setup, from
/// snapshot.agents and live agent.activity_changed frames, read as `Preparing`; gone at the agent's first own step.
@MainActor
final class PreparingTests: XCTestCase {
  let scope = "lifecycle:run-g"
  func feed(_ s: CapcomdStore, status: String = "running", activity: String = "null") {
    let agent = #"{"id":"agt-p","runId":"run-g","parent":null,"depth":0,"profile":"planner","status":"\#(status)","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-19T14:43:49.000Z","activity":\#(activity)}"#
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-g","projectId":"prj-g","label":null,"state":"running","goal":"Ship it"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agent)]}"#), ("snapshot.approvals", #"{"approvals":[]}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
  }
  var n = 0
  func live(_ s: CapcomdStore, _ activity: String, status: String = "running") {
    n += 1
    let frame = #"{"v":1,"id":"eph-\#(n)","scope":"run-g","seq":3,"entity":"agt-p","entitySeq":0,"type":"agent.activity_changed","typeVersion":1,"durability":"ephemeral","ts":"2026-11-19T14:44:00.000Z","epochMs":9,"projectId":"prj-g","runId":"run-g","agentId":"agt-p","text":"x","data":{"agentId":"agt-p","status":"\#(status)","activity":\#(activity)}}"#
    s.receive(StreamFrame.parse(event: "agent.activity_changed", data: frame), scope: scope)
  }
  func setup(_ phase: String, _ text: String, bytes: Int? = nil, total: Int? = nil) -> String {
    #"{"text":"\#(text)","kind":"setup","at":"2026-11-19T14:44:00.000Z","setup":{"phase":"\#(phase)","bytes":\#(bytes.map(String.init) ?? "null"),"totalBytes":\#(total.map(String.init) ?? "null")}}"#
  }
  func prep(_ s: CapcomdStore) -> Preparing? { s.preparing(runId: "run-g", agentId: "agt-p", name: "planner") }

  func testEachPhaseTheDaemonReportsThenTheFirstStepEndsIt() {
    let s = CapcomdStore()
    feed(s, activity: setup("machine", "Starting the machine"))
    XCTAssertEqual(prep(s)?.phase, .machine)
    XCTAssertEqual(prep(s)?.line, "Starting the machine")
    XCTAssertEqual(prep(s)?.sinceMs, 1_795_099_429_000)   // its spawn: the elapsed clock
    XCTAssertNil(prep(s)?.fraction)

    let MB = 1_048_576
    live(s, setup("copy", "Copying the repository · 53% (56 of 105 MB)", bytes: 56 * MB, total: 105 * MB + MB / 2))
    XCTAssertEqual(prep(s)?.line, "Copying the repository")
    XCTAssertEqual(prep(s)?.detail, "53% · 56 of 106 MB")
    XCTAssertEqual(prep(s)!.fraction!, 56.0 / 105.5, accuracy: 0.0001)
    live(s, setup("copy", "Copying the repository (3.5 MB)", bytes: 3 * MB + MB / 2))
    XCTAssertEqual(prep(s)?.detail, "3.5 MB")
    XCTAssertNil(prep(s)?.fraction)   // no total: no bar

    live(s, setup("agent", "Starting the agent"))
    XCTAssertEqual(prep(s)?.line, "Starting planner")
    live(s, setup("teleport", "Beaming the repository up"))   // a phase this app doesn't know: the daemon's line
    XCTAssertEqual(prep(s)?.phase, .other)
    XCTAssertEqual(prep(s)?.line, "Beaming the repository up")

    // Its first step: its own activity replaces the setup.
    live(s, #"{"text":"Thinking","kind":"think","at":"2026-11-19T14:45:19.000Z"}"#)
    XCTAssertNil(prep(s))
    XCTAssertNil(s.runs["run-g"]?.agents["agt-p"]?.setup)
  }

  func testWithoutAStepFromADaemonThatDoesntSayItIsStartingOrQueued() {
    let s = CapcomdStore()
    feed(s)
    XCTAssertEqual(prep(s)?.phase, .starting)
    XCTAssertEqual(prep(s)?.line, "Starting planner")
    XCTAssertFalse(prep(s)!.isSetup)
    let q = CapcomdStore()
    feed(q, status: "pending")
    XCTAssertEqual(prep(q)?.phase, .queued)
  }

  func testNothingOnceItStoppedOrHasSteps() {
    let s = CapcomdStore()
    feed(s, status: "failed", activity: setup("copy", "Stopped while copying the repository", bytes: 1, total: 2))
    XCTAssertNil(prep(s))   // its thread says why it failed; no getting-ready over it
    let r = CapcomdStore()
    feed(r, activity: #"{"text":"Reading 4 files","kind":"read","at":"2026-11-19T14:45:00.000Z"}"#)
    XCTAssertNil(prep(r))
  }

  func testMegabytesAsTheDaemonWritesThem() {
    XCTAssertEqual(Preparing.mb(0), "0")
    XCTAssertEqual(Preparing.mb(2_621_440), "2.5")
    XCTAssertEqual(Preparing.mb(8 * 1_048_576), "8")
    XCTAssertEqual(Preparing.mb(110_520_320), "105")
  }
}
