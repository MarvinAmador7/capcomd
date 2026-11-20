import XCTest
import Foundation
@testable import CapcomdStore

final class FakeArchiver: RunControlling, RunArchiving, @unchecked Sendable {
  var outcome: Error?
  var restored: [String] = []
  func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws {}
  func control(runId: String, agentId: String, _ action: RunControl, idempotencyKey: String) async throws {}
  func restore(runId: String, idempotencyKey: String) async throws { restored.append(runId); if let e = outcome { throw e } }
  func archive(runId: String, idempotencyKey: String) async throws {}
}

/// An agent is idle, not done (capability agents.idle, ADR-026 §1): its header and composer say so, a message wakes it
/// (agent.continued), "waking" shows only after a second of setup, and an archived run (runs.archive) gives way to Restore.
@MainActor
final class AgentLifeTests: XCTestCase {
  let scope = "lifecycle:run-i"
  let t0 = 1_795_099_500_000

  func feed(_ s: CapcomdStore, status: String = "done", archived: Bool = false, continued: String = "null") {
    let agent = { (id: String, profile: String, parent: String) in
      #"{"id":"\#(id)","runId":"run-i","parent":\#(parent),"depth":\#(parent == "null" ? 0 : 1),"profile":"\#(profile)","status":"\#(status)","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-19T14:43:49.000Z","activity":null,"continued":\#(continued)}"#
    }
    let agents = [agent("agt-p", "planner", "null"), agent("agt-k", "worker", #""agt-p""#)].joined(separator: ",")
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-i","projectId":"prj-i","label":null,"state":"running","goal":"Ship it","archived":\#(archived)}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents)]}"#), ("snapshot.approvals", #"{"approvals":[]}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
  }
  var seq = 3
  func event(_ s: CapcomdStore, _ type: String, _ data: String, ms: Int) {
    seq += 1
    let frame = #"{"v":1,"id":"evt_run-i_\#(seq)","scope":"run-i","seq":\#(seq),"entity":"agt-p","entitySeq":\#(seq),"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-11-19T14:45:00.000Z","epochMs":\#(ms),"projectId":"prj-i","runId":"run-i","agentId":"agt-p","text":"x","data":\#(data)}"#
    s.receive(StreamFrame.parse(event: type, data: frame), scope: scope)
  }
  func setup(_ s: CapcomdStore, _ phase: String, ms: Int) {
    let at = ISO8601DateFormatter.string(from: Date(timeIntervalSince1970: Double(ms) / 1000), timeZone: .gmt, formatOptions: [.withInternetDateTime, .withFractionalSeconds])
    event(s, "agent.activity_changed", #"{"activity":{"text":"Setting up","kind":"setup","at":"\#(at)","setup":{"phase":"\#(phase)"}},"status":"running"}"#, ms: ms)
  }

  func testAnEndedAgentIsIdleAndItsComposerSaysSendToContinue() {
    let s = CapcomdStore()
    feed(s)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p"), .idle)
    XCTAssertEqual(s.columnHeader(runId: "run-i", agentId: "agt-p")?.life, .idle)
    let c = s.composerState(runId: "run-i", agentId: "agt-p", name: "planner")
    XCTAssertEqual(c.placeholder, "planner is idle. Send to continue.")
    XCTAssertTrue(c.isIdle); XCTAssertFalse(c.isArchived); XCTAssertFalse(c.isWorking)
    XCTAssertNil(s.wakingLine(runId: "run-i", agentId: "agt-p", name: "planner"))
  }

  func testAWorkingAgentIsActive() {
    let s = CapcomdStore()
    feed(s, status: "running")
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p"), .active)
    let c = s.composerState(runId: "run-i", agentId: "agt-p", name: "planner")
    XCTAssertEqual(c.placeholder, "Tell planner…")
    XCTAssertTrue(c.isWorking); XCTAssertFalse(c.isIdle)
    XCTAssertNil(AgentLife.active.word)
  }

  func testAMessageWakesItAndWakingShowsOnlyAfterASecond() {
    let s = CapcomdStore()
    feed(s)
    event(s, "agent.continued", #"{"epoch":2,"from":"done","by":"operator","messageSeq":5}"#, ms: t0)
    let a = s.runs["run-i"]?.agents["agt-p"]
    XCTAssertEqual(a?.status, .running)
    XCTAssertEqual(a?.continuedAtMs, t0)
    // Not set up yet (no setup activity): it reads as working, never "waking".
    XCTAssertNil(a?.wakingShowsAtMs)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p", nowMs: t0 + 5000), .active)
    setup(s, "machine", ms: t0 + 100)
    XCTAssertEqual(s.runs["run-i"]?.agents["agt-p"]?.wakingShowsAtMs, t0 + AgentLife.wakingDelayMs)
    // Within the first second: no flash of "waking".
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p", nowMs: t0 + 999), .active)
    XCTAssertNil(s.wakingLine(runId: "run-i", agentId: "agt-p", name: "planner", nowMs: t0 + 999))
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p", nowMs: t0 + 1000), .waking)
    XCTAssertEqual(s.wakingLine(runId: "run-i", agentId: "agt-p", name: "planner", nowMs: t0 + 1000), "Waking planner")
    let c = s.composerState(runId: "run-i", agentId: "agt-p", name: "planner", nowMs: t0 + 1500)
    XCTAssertTrue(c.isWaking); XCTAssertTrue(c.isWorking); XCTAssertEqual(c.placeholder, "Tell planner…")
    // Its first step of its own: no longer waking.
    event(s, "agent.activity_changed", #"{"activity":{"text":"Reading the plan","kind":"tool","at":null},"status":"running"}"#, ms: t0 + 3000)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p", nowMs: t0 + 3000), .active)
    XCTAssertNil(s.runs["run-i"]?.agents["agt-p"]?.wakingShowsAtMs)
  }

  func testTheSetupTrailOfAWokenAgentExpectsRestore() {
    let s = CapcomdStore()
    feed(s)
    event(s, "agent.continued", #"{"epoch":2,"from":"done","by":"operator","messageSeq":5}"#, ms: t0)
    setup(s, "machine", ms: t0)
    setup(s, "machine", ms: t0 + 500)   // the same phase again: one step
    setup(s, "workspace", ms: t0 + 2000)
    setup(s, "restore", ms: t0 + 2500)
    let trail = s.setupTrail(runId: "run-i", agentId: "agt-p", nowMs: t0 + 3000)
    XCTAssertEqual(trail?.steps.map(\.phase), [.machine, .workspace, .restore, .agent])
    XCTAssertEqual(trail?.steps.map(\.state), [.done, .done, .now, .next])
    XCTAssertEqual(trail?.steps.map(\.ms), [2000, 500, nil, nil])
    XCTAssertEqual(trail?.elapsedMs, 3000)
    XCTAssertEqual(trail?.steps[2].line, "Restoring the conversation")
    XCTAssertEqual(s.preparing(runId: "run-i", agentId: "agt-p", name: "planner")?.line, "Restoring the conversation")
    // A message wakes it again: the trail starts over.
    event(s, "agent.done", #"{"result":{"summary":"ok"},"spent":null,"budget":null,"cause":"finished"}"#, ms: t0 + 9000)
    event(s, "agent.continued", #"{"epoch":3,"from":"done","by":"operator","messageSeq":6}"#, ms: t0 + 10_000)
    XCTAssertNil(s.setupTrail(runId: "run-i", agentId: "agt-p", nowMs: t0 + 10_000))
  }

  func testAFirstStartsTrailDoesNotExpectRestore() {
    let trail = SetupTrail.of(marks: [SetupMark(phase: "machine", atMs: 0)], current: "machine", woken: false, nowMs: 400)
    XCTAssertEqual(trail?.steps.map(\.phase), [.machine, .workspace, .copy, .agent])
    XCTAssertEqual(trail?.steps.first?.state, .now)
  }

  func testAContinuedSnapshotKeepsWhenItWasWoken() {
    let s = CapcomdStore()
    feed(s, status: "running", continued: #"{"at":"2026-11-19T14:45:00.000Z","by":"operator","from":"done"}"#)
    XCTAssertEqual(s.runs["run-i"]?.agents["agt-p"]?.continuedAtMs, 1_795_099_500_000)
  }

  func testAnArchivedRunTakesNoMessagesAndRestoresOnTheFeed() {
    let s = CapcomdStore()
    feed(s, archived: true)
    XCTAssertEqual(s.runs["run-i"]?.archived, true)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p"), .archived)
    XCTAssertEqual(s.columnHeader(runId: "run-i", agentId: "agt-k")?.life, .archived)
    let c = s.composerState(runId: "run-i", agentId: "agt-p", name: "planner")
    XCTAssertTrue(c.isArchived); XCTAssertEqual(c.placeholder, "This run is archived.")
    event(s, "run.restored", "{}", ms: t0)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p"), .idle)
    event(s, "run.archived", "{}", ms: t0 + 1)
    XCTAssertEqual(s.agentLife(runId: "run-i", agentId: "agt-p"), .archived)
  }

  func testRestoreClearsArchivedOrSaysWhyNot() async {
    let ar = FakeArchiver()
    let s = CapcomdStore(controls: ar)
    feed(s, archived: true)
    await s.restoreRun(runId: "run-i")
    XCTAssertEqual(ar.restored, ["run-i"])
    XCTAssertEqual(s.runs["run-i"]?.archived, false)
    XCTAssertNil(s.restoreStates["run-i"])
    ar.outcome = MessageRefused("run-i has agents still working")
    await s.restoreRun(runId: "run-i")
    XCTAssertEqual(s.restoreStates["run-i"], .failed("run-i has agents still working"))
    // A daemon that can't restore: said so, nothing sent.
    let plain = CapcomdStore(controls: FakeControls())
    await plain.restoreRun(runId: "run-i")
    XCTAssertEqual(plain.restoreStates["run-i"], .failed("This capcomd can't restore runs"))
  }

  func testAnArchivedRefusalMarksTheRunArchived() async {
    let m = FakeMessenger(); m.outcomes = [.failure(MessageRefused("run run-i is archived · restore to continue", code: "archived"))]
    let s = CapcomdStore(messenger: m)
    feed(s)
    await s.steer(runId: "run-i", agentId: "agt-p", body: "one more thing")
    XCTAssertEqual(s.pendingSteers(agentId: "agt-p").first?.state, .failed("This run is archived. Restore it to continue."))
    XCTAssertEqual(s.runs["run-i"]?.archived, true)
    XCTAssertTrue(s.composerState(runId: "run-i", agentId: "agt-p", name: "planner").isArchived)
  }
}
