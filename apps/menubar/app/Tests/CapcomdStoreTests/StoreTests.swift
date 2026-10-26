import XCTest
import Foundation
@testable import CapcomdStore

/// Splits a recorded text/event-stream fixture into (event, data) frames.
func loadSSE(_ name: String) throws -> [(String, String)] {
  let url = Bundle.module.url(forResource: name, withExtension: "sse", subdirectory: "Fixtures")!
  return try String(contentsOf: url, encoding: .utf8).components(separatedBy: "\n\n").compactMap { block in
    var ev = "message", data: [String] = []
    for line in block.split(separator: "\n") {
      if line.hasPrefix("event: ") { ev = String(line.dropFirst(7)) }
      if line.hasPrefix("data: ") { data.append(String(line.dropFirst(6))) }
    }
    return data.isEmpty ? nil : (ev, data.joined(separator: "\n"))
  }
}

final class FakeDecider: ApprovalDeciding, @unchecked Sendable {
  var outcomes: [Result<DecideOutcome, Error>] = []
  var keys: [String] = []
  func decide(approvalId: String, decision: ApprovalDecision, idempotencyKey: String) async throws -> DecideOutcome {
    keys.append(idempotencyKey); return try outcomes.removeFirst().get()
  }
}
struct Boom: Error {}

@MainActor
final class StoreTests: XCTestCase {
  func feed(_ s: CapcomdStore, _ name: String, scope: String = "run-a1") throws {
    for (e, d) in try loadSSE(name) { s.receive(StreamFrame.parse(event: e, data: d), scope: scope) }
  }

  func testProjectTitledByGoalWithRun() async throws {
    let s = CapcomdStore(); try feed(s, "contract")
    XCTAssertEqual(s.projects.count, 1)
    XCTAssertEqual(s.projects[0].id, "prj-1")
    XCTAssertEqual(s.projects[0].title, "Fix flaky login tests")          // first line only
    XCTAssertEqual(s.projects[0].runs.map(\.id), ["run-a1"])
    XCTAssertTrue(s.projects[0].isRunning)
  }

  func testProjectGroupsRunsByIdAndScopesFromAgentRepos() async throws {
    let s = CapcomdStore()
    func send(_ seq: Int, _ run: String, _ type: String, agent: String? = nil, _ data: [String: JSONValue]) {
      s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: seq * 1000,
                                projectId: "prj-mk", runId: run, agentId: agent, data: data)), scope: run)
    }
    send(1, "run-a", "run.created", ["goal": .string("Migrate matchkey to v3.2")])
    send(2, "run-a", "agent.spawned", agent: "agt-1", ["profile": .string("planner")])
    send(3, "run-a", "agent.spawned", agent: "agt-2", ["profile": .string("worker"), "agent": .object(["repo": .string("matchkey")])])
    send(4, "run-a", "agent.spawned", agent: "agt-3", ["profile": .string("lead"), "repo": .string("ids/v1")])
    send(5, "run-a", "agent.spawned", agent: "agt-4", ["profile": .string("worker"), "repo": .string("matchkey")])
    send(1, "run-b", "agent.spawned", agent: "agt-9", ["profile": .string("critic"), "repo": .string("addriva")])
    XCTAssertEqual(s.projects.count, 1)                                       // grouped by project id, not goal text
    XCTAssertEqual(s.projects[0].title, "Migrate matchkey to v3.2")
    XCTAssertEqual(s.projects[0].runs.map(\.id), ["run-a", "run-b"])
    XCTAssertEqual(s.projects[0].scopes, ["matchkey", "ids/v1", "addriva"])   // distinct, spawn order, no run ids
  }

  func testAgentTreeProfilesSuffixesAndBubbling() async throws {
    let s = CapcomdStore(); try feed(s, "contract")
    let tree = s.agentTree(runId: "run-a1")
    XCTAssertEqual(tree.map(\.name), ["planner"])
    let kids = tree[0].children
    XCTAssertEqual(kids.map(\.name), ["worker", "worker", "critic", "mystery"])
    XCTAssertEqual(kids[0].suffix, "7a3f"); XCTAssertEqual(kids[1].suffix, "9b21")   // repeated profile → short task id
    XCTAssertNil(kids[2].suffix)
    XCTAssertEqual(kids.map(\.kind.symbol), ["hammer", "hammer", "checkmark.seal", "hexagon"])
    XCTAssertTrue(kids[3].kind.hasCentreDot)
    XCTAssertEqual(tree[0].kind.symbol, "point.3.connected.trianglepath.dotted")
    XCTAssertTrue(kids[0].waiting); XCTAssertEqual(kids[0].iconTint, .amber)
    XCTAssertTrue(tree[0].descendantWaiting); XCTAssertFalse(tree[0].waiting)
    XCTAssertEqual(tree[0].iconTint, .blue)                                   // running
    XCTAssertEqual(kids[2].iconTint, .grey)
  }

  func testApprovalQuestionAndBranchLine() async throws {
    let s = CapcomdStore(); try feed(s, "contract")
    XCTAssertEqual(s.badgeCount, 1)
    let a = try XCTUnwrap(s.approvals(forRun: "run-a1").first)
    XCTAssertEqual(a.question.plain, "Merge fix/auth into main?")
    XCTAssertEqual(a.branchLine, "fix/auth → main")
  }

  func testUntrustedTextStrippedAndThreadHandoff() async throws {
    let s = CapcomdStore(); try feed(s, "contract")
    let w2 = try XCTUnwrap(s.runs["run-a1"]?.agents["agt-w2"])
    XCTAssertEqual(w2.task?.plain, "Fix UI")                                  // bidi + BEL removed
    let handoff = s.thread(agentId: "agt-p").compactMap { if case .handoff(let c, _, let sum, let arts) = $0.kind { return (c, sum?.plain, arts.map(\.plain)) }; return nil }
    XCTAssertEqual(handoff.first?.0, "agt-w2")
    XCTAssertEqual(handoff.first?.1, "Patched [link](http://evil)")           // kept as literal text
    XCTAssertEqual(handoff.first?.2, ["diff.patch"])
    XCTAssertEqual(UntrustedText(String(repeating: "x", count: 5000)).plain.count, 2001)   // 2000 + "…"
  }

  func testStepsDerived() async throws {
    let s = CapcomdStore(); try feed(s, "contract")
    let steps = s.steps(forRun: "run-a1")
    XCTAssertFalse(steps.isEmpty)
    XCTAssertTrue(steps.contains { $0.status == .waiting })
    XCTAssertTrue(steps.contains { $0.status == .running && $0.kind == .verify })
  }

  func testDedupeBySeq() async throws {
    let s = CapcomdStore(); try feed(s, "contract"); let n = s.steps(forRun: "run-a1").count
    try feed(s, "contract")
    XCTAssertEqual(s.steps(forRun: "run-a1").count, n)
    XCTAssertEqual(s.lastSeq["run-a1"], 11)
  }

  func testResetRebuildsFromSnapshot() async throws {
    let s = CapcomdStore(); try feed(s, "contract"); try feed(s, "reset")
    XCTAssertEqual(s.resetCount, 1)
    XCTAssertEqual(s.lastSeq["run-a1"], 40)
    XCTAssertEqual(Set(s.runs["run-a1"]!.agents.keys), ["agt-p", "agt-w1"])
    XCTAssertEqual(s.pendingApprovals.map(\.id), ["apr-10"])
    XCTAssertEqual(s.pendingApprovals.first?.branchLine, "fix/ui → main")
    try feed(s, "contract")                                                  // old seqs ≤ 40 ignored
    XCTAssertEqual(s.pendingApprovals.map(\.id), ["apr-10"])
  }

  func testSubscriptionScopes() async {
    final class Sub: StreamSubscribing, @unchecked Sendable {
      var scopes: [String] = []
      final class H: SubscriptionHandle { func cancel() {} }
      func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle { scopes.append(scope); return H() }
    }
    let sub = Sub(); let s = CapcomdStore(subscriber: sub)
    s.start(); XCTAssertEqual(s.activeScopes, ["daemon"])
    s.openRun("run-a1"); XCTAssertEqual(s.activeScopes, ["daemon", "run-a1"])
    s.closeRun(); XCTAssertEqual(s.activeScopes, ["daemon"])
    s.stop(); XCTAssertEqual(s.activeScopes, [])
  }

  func testDecideIdempotencyOutcomes() async throws {
    let f = FakeDecider(); var n = 0
    let s = CapcomdStore(decider: f, makeKey: { n += 1; return "key-\(n)-xxxxxxxx" }); try feed(s, "contract")
    // transport error: key kept, retry reuses it
    f.outcomes = [.failure(Boom())]
    if case .failed = await s.decide("apr-9", .approve) {} else { XCTFail() }
    // conflict: key cleared, next attempt mints a new key
    f.outcomes = [.success(.idempotencyConflict("reused"))]
    _ = await s.decide("apr-9", .approve)
    f.outcomes = [.success(.alreadyDecided(DecisionRecord(approvalId: "apr-9", status: "denied", decidedBy: .init(clientId: "cli", principal: "ana"))))]
    let r = await s.decide("apr-9", .approve)
    XCTAssertEqual(f.keys, ["key-1-xxxxxxxx", "key-1-xxxxxxxx", "key-2-xxxxxxxx"])
    XCTAssertEqual(r, .decided(status: "denied", by: "ana", alreadyDecided: true))
    XCTAssertEqual(s.badgeCount, 0)
  }

  func testDecideSuccess() async throws {
    let f = FakeDecider(); let s = CapcomdStore(decider: f); try feed(s, "contract")
    f.outcomes = [.success(.decided(DecisionRecord(approvalId: "apr-9", status: "approved", decidedBy: .init(clientId: "menubar", principal: "marvin"))))]
    let r = await s.decide("apr-9", .approve)
    XCTAssertEqual(r, .decided(status: "approved", by: "marvin", alreadyDecided: false))
    XCTAssertTrue(s.pendingApprovals.isEmpty || s.badgeCount == 0)
  }

  func testPrefsRemembered() async {
    let p = InMemoryPreferences()
    let a = CapcomdStore(prefs: p); XCTAssertEqual(a.prefs.drillView, .activity); XCTAssertFalse(a.prefs.activityCollapsed)
    a.prefs.drillView = .trace; a.prefs.activityCollapsed = true
    let b = CapcomdStore(prefs: p); XCTAssertEqual(b.prefs.drillView, .trace); XCTAssertTrue(b.prefs.activityCollapsed)
  }

  /// Phase-1 (d5c8bc6): `agent.status_changed`, snapshot agent `text` as the activity line, untrusted `task` as plain detail,
  /// snapshot.steps/threads tolerated, lowercase profile names.
  func testPhase1StatusChangedAndSnapshotActivity() async throws {
    let s = CapcomdStore()
    let env = { (seq: Int, type: String, data: String) in
      #"{"v":1,"id":"evt_\#(seq)","scope":"run-z","seq":\#(seq),"entity":"agt-1","entitySeq":1,"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-10-25T06:00:00.000Z","epochMs":\#(seq),"projectId":"prj-z","runId":"run-z","agentId":"agt-1","text":"Agent agt-1 is now running.","data":\#(data)}"# }
    let frames: [(String, String)] = [
      ("stream.reset", #"{"snapshotSeq":5,"reason":"compacted"}"#),
      ("snapshot.agents", #"{"agents":[{"id":"agt-1","runId":"run-z","parent":null,"depth":0,"profile":"lead","status":"pending","text":"Waiting to start","task":"**Do** [it](http://evil)","taskAttachment":null,"result":null,"updatedAt":null}]}"#),
      ("snapshot.approvals", #"{"approvals":[]}"#),
      ("snapshot.steps", #"{"steps":[\#(env(2, "agent.spawned", #"{"agentId":"agt-1","parent":null,"depth":0,"profile":"lead","task":"**Do** [it](http://evil)","taskAttachment":null}"#))]}"#),
      ("snapshot.threads", #"{"messages":[]}"#),
      ("snapshot.end", #"{"snapshotSeq":5}"#),
      ("agent.status_changed", env(6, "agent.status_changed", #"{"agentId":"agt-1","status":"running"}"#)),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: "run-z") }
    let node = try XCTUnwrap(s.agentTree(runId: "run-z").first)
    XCTAssertEqual(node.name, "lead"); XCTAssertEqual(node.status, .running); XCTAssertEqual(node.activity, "Waiting to start")
    let step = try XCTUnwrap(s.steps(forRun: "run-z").first)
    XCTAssertEqual(step.status, .running)   // step comes from snapshot.steps replay, status from the live event
    XCTAssertEqual(step.detail?.plain, "**Do** [it](http://evil)")   // untrusted task kept literal
    XCTAssertEqual(s.lastSeq["run-z"], 6)
  }

  // MARK: lifecycle (PR #40)
  static func envelope(_ id: String, seq: Int, type: String, run: String = "run-l", agent: String? = nil, data: String) -> String {
    #"{"v":1,"id":"\#(id)","scope":"\#(run)","seq":\#(seq),"entity":"\#(agent ?? run)","entitySeq":1,"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-10-25T06:00:00.000Z","epochMs":\#(seq),"projectId":"prj-l","runId":"\#(run)","agentId":\#(agent.map { "\"\($0)\"" } ?? "null"),"text":"x","data":\#(data)}"#
  }

  func testRunLifecycleDrivesStatusAndGroupDedupesById() async throws {
    let s = CapcomdStore(); var notices: [Notice] = []; s.onNotify = { notices.append($0) }
    let frames: [(String, String)] = [
      ("run.created", Self.envelope("evt_c", seq: 1, type: "run.created", agent: nil, data: #"{"cause":"created","label":"demo"}"#)),
      ("agent.started", Self.envelope("evt_a", seq: 2, type: "agent.started", agent: "agt-1", data: #"{"agentId":"agt-1","cause":"started"}"#)),
      // group cut after its first member, then re-sent whole: agent.started must be dropped by id, run.started applied once
      ("agent.started", Self.envelope("evt_a", seq: 2, type: "agent.started", agent: "agt-1", data: #"{"agentId":"agt-1","cause":"started"}"#)),
      ("run.started", Self.envelope("evt_run-l_2_run.started", seq: 2, type: "run.started", data: #"{"cause":"agent.started","agentId":"agt-1"}"#)),
      ("run.completed", Self.envelope("evt_d", seq: 3, type: "run.completed", data: #"{"cause":"agent.done","agentId":"agt-1"}"#)),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: "lifecycle:run-l") }   // the lifecycle feed notifies
    let run = try XCTUnwrap(s.runs["run-l"])
    XCTAssertEqual(run.lifecycle.map(\.type), ["run.started", "run.completed"])
    XCTAssertEqual(run.lifecycle.first?.agentId, "agt-1")
    XCTAssertEqual(run.state, "completed"); XCTAssertFalse(run.isRunning)
    XCTAssertEqual(s.duplicatesDropped, 1)
    XCTAssertEqual(s.lastSeq["lifecycle:run-l"], 3)
    XCTAssertEqual(notices.count, 1)
  }

  func testRedactedSegments() async {
    let u = UntrustedText("token [REDACTED] and **[REDACTED]**")
    XCTAssertEqual(u.segments, [.text("token "), .redacted, .text(" and **"), .redacted, .text("**")])
    XCTAssertEqual(UntrustedText("plain").segments, [.text("plain")])
  }

  func testMessageAndResultInThread() async throws {
    let s = CapcomdStore()
    let frames: [(String, String)] = [
      ("agent.spawned", Self.envelope("e1", seq: 1, type: "agent.spawned", agent: "agt-1", data: #"{"agentId":"agt-1","parent":null,"depth":0,"profile":"lead","task":"t","taskAttachment":{"id":"att-1","bytes":4096,"mediaType":"text/plain"}}"#)),
      ("message.sent", Self.envelope("e2", seq: 2, type: "message.sent", agent: "agt-1", data: #"{"from":"agt-1","to":"agt-2","text":"*hi* <b>"}"#)),
      ("agent.done", Self.envelope("e3", seq: 3, type: "agent.done", agent: "agt-1", data: #"{"agentId":"agt-1","result":{"summary":"[done](http://x) [REDACTED]"}}"#)),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: "run-l") }
    let a = try XCTUnwrap(s.runs["run-l"]?.agents["agt-1"])
    XCTAssertEqual(a.taskAttachment?.label, "Full text stored · 4 KB")
    XCTAssertEqual(a.resultSummary?.plain, "[done](http://x) [REDACTED]")
    XCTAssertTrue(s.thread(agentId: "agt-1").contains { if case .message(_, "agt-2", let t, _) = $0.kind { return t?.plain == "*hi* <b>" }; return false })
  }
}
