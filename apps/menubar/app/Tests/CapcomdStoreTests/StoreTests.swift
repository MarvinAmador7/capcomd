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
    XCTAssertTrue(s.projects[0].id.hasPrefix("prj-1|"))                   // repository + goal
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
    XCTAssertEqual(s.projects.count, 1)                                       // a run without a goal yet joins its repo's card
    XCTAssertEqual(s.projects[0].title, "Migrate matchkey to v3.2")
    XCTAssertEqual(s.projects[0].runs.map(\.id), ["run-a", "run-b"])
    XCTAssertEqual(s.projects[0].scopes, ["matchkey", "ids/v1", "addriva"])   // distinct, spawn order, no run ids
  }

  /// The daemon's projectId is the repository: each goal in it is its own card, reruns of a goal share one.
  func testEachGoalInARepositoryIsItsOwnCard() {
    let s = CapcomdStore()
    func created(_ seq: Int, _ run: String, _ goal: String) {
      s.receive(.event(Envelope(id: "g\(seq)", scope: run, seq: seq, entity: run, type: "run.created", epochMs: seq * 1000,
                                projectId: "prj-repo", runId: run, agentId: nil, data: ["goal": .string(goal)])), scope: run)
    }
    created(1, "run-1", "Ship the CSV export")
    created(2, "run-2", "Fix the login bug")
    created(3, "run-3", "Ship the CSV export ")   // a rerun of the first goal
    XCTAssertEqual(s.projects.count, 2)
    XCTAssertEqual(Set(s.projects.map(\.title)), ["Ship the CSV export", "Fix the login bug"])
    XCTAssertEqual(s.projects.first { $0.title == "Ship the CSV export" }?.runs.map(\.id).sorted(), ["run-1", "run-3"])
  }

  func testRunOutcomeFromStateThenAgents() {
    func run(_ state: String, _ statuses: [AgentStatus] = [], startedAtMs: Int? = nil) -> Run {
      var r = Run(id: "run-x", projectId: "prj-x", label: nil, goal: nil, state: state, startedAtMs: startedAtMs, lastEventMs: 0)
      for (i, s) in statuses.enumerated() { r.agents["a\(i)"] = Agent(id: "a\(i)", runId: "run-x", parent: nil, depth: 0, profile: "worker", status: s, task: nil, key: nil, repo: nil, spawnedAtMs: i) }
      return r
    }
    let now = 10 * 60_000
    XCTAssertEqual(run("completed").outcome(nowMs: now), .done)
    XCTAssertEqual(run("failed").outcome(nowMs: now), .failed)
    XCTAssertEqual(run("cancelled").outcome(nowMs: now), .stopped)
    XCTAssertEqual(run("running").outcome(nowMs: now), .active)
    XCTAssertEqual(run("paused").outcome(nowMs: now), .active)               // waiting on the operator still needs attention
    // The daemon snapshot says "idle" once every agent ended: their statuses tell how.
    XCTAssertEqual(run("idle", [.done, .done]).outcome(nowMs: now), .done)
    XCTAssertEqual(run("idle", [.done, .failed]).outcome(nowMs: now), .failed)
    XCTAssertEqual(run("idle", [.done, .cancelled]).outcome(nowMs: now), .stopped)
    XCTAssertEqual(run("idle", [.done, .running]).outcome(nowMs: now), .active)
    // "new" (no agent spawned yet) is active for a short grace, then counts as stopped.
    XCTAssertEqual(run("new", startedAtMs: now - 60_000).outcome(nowMs: now), .active)
    XCTAssertEqual(run("new", startedAtMs: now - Run.startGraceMs).outcome(nowMs: now), .stopped)
  }

  func testFinishedRunsLeaveTheCardAndProjectsGetAnEndedLine() {
    let s = CapcomdStore()
    func send(_ seq: Int, _ run: String, _ project: String, _ type: String, ms: Int, agent: String? = nil, _ data: [String: JSONValue] = [:]) {
      s.receive(.event(Envelope(id: "e\(run)\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: ms,
                                projectId: project, runId: run, agentId: agent, data: data)), scope: run)
    }
    // prj-a: an older run that finished and a newer one still running.
    send(1, "run-old", "prj-a", "run.created", ms: 1_000, ["goal": .string("Migrate matchkey")])
    send(2, "run-old", "prj-a", "run.completed", ms: 200_000)
    send(1, "run-new", "prj-a", "run.created", ms: 300_000, ["goal": .string("Migrate matchkey")])
    send(2, "run-new", "prj-a", "agent.spawned", ms: 300_100, agent: "agt-1", ["profile": .string("planner")])
    send(3, "run-new", "prj-a", "agent.started", ms: 300_200, agent: "agt-1")
    // prj-b: finished in 4m across three folders.
    send(1, "run-b", "prj-b", "run.created", ms: 10_000, ["goal": .string("Launch Addriva Verify docs")])
    for (i, repo) in ["addriva", "relay", "docs"].enumerated() {
      send(2 + i, "run-b", "prj-b", "agent.spawned", ms: 11_000, agent: "agt-b\(i)", ["profile": .string("worker"), "repo": .string(repo)])
    }
    send(9, "run-b", "prj-b", "run.completed", ms: 250_000)
    // prj-c: failed after 45s, no folders known.
    send(1, "run-c", "prj-c", "run.created", ms: 400_000, ["goal": .string("Fix proration")])
    send(2, "run-c", "prj-c", "run.failed", ms: 445_000)

    let ps = s.projects
    XCTAssertEqual(ps.map { $0.id.prefix { $0 != "|" } }, ["prj-a", "prj-c", "prj-b"])   // active first, then most recent
    XCTAssertEqual(ps[0].activeRuns.map(\.id), ["run-new"])               // the finished run left the card
    XCTAssertTrue(ps[0].isActive); XCTAssertNil(ps[0].endedLine)
    XCTAssertEqual(ps[2].endedLine, "Done in 4m · 3 repos")
    XCTAssertEqual(ps[1].endedLine, "Failed after 45s")
    XCTAssertEqual(shortDuration(ms: 59_999), "59s"); XCTAssertEqual(shortDuration(ms: 3_600_000), "1h")
    XCTAssertEqual(shortDuration(ms: 3_900_000), "1h 5m"); XCTAssertEqual(shortDuration(ms: 2 * 86_400_000), "2d")
  }

  func testSnapshotRunCreatedAtAndAgentUpdatedAtGiveDuration() async throws {
    let s = CapcomdStore()
    let frames: [(String, String)] = [
      ("stream.reset", #"{"snapshotSeq":3,"reason":"compacted"}"#),
      ("snapshot.run", #"{"run":{"id":"run-s","projectId":"prj-s","label":null,"state":"idle","goal":"Ship docs","repo":null,"createdAt":"2026-10-26T10:00:00.000Z"}}"#),
      ("snapshot.agents", #"{"agents":[{"id":"agt-1","runId":"run-s","parent":null,"depth":0,"profile":"planner","status":"done","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":"2026-10-26T10:12:30.000Z"}]}"#),
      ("snapshot.approvals", #"{"approvals":[]}"#),
      ("snapshot.end", #"{"snapshotSeq":3}"#),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: "daemon") }
    let p = try XCTUnwrap(s.projects.first)
    XCTAssertFalse(p.isActive)
    XCTAssertEqual(p.endedLine, "Done in 12m")
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
    XCTAssertEqual(node.name, "lead"); XCTAssertEqual(node.status, .running)
    XCTAssertNil(node.activity)   // the status sentence (`text`) is not an activity line
    let step = try XCTUnwrap(s.steps(forRun: "run-z").first)
    XCTAssertEqual(step.status, .running)   // step comes from snapshot.steps replay, status from the live event
    XCTAssertEqual(step.detail?.plain, "**Do** [it](http://evil)")   // untrusted task kept literal
    XCTAssertEqual(s.lastSeq["run-z"], 6)
  }

  /// Agent.activity (snapshot.agents) and live, ephemeral agent.activity_changed (lifecycle feed with ?activity=1).
  func testActivityFromSnapshotAndEphemeralUpdates() async throws {
    let s = CapcomdStore(), scope = "lifecycle:run-l"
    let agent = #"{"id":"agt-1","runId":"run-l","parent":null,"depth":0,"profile":"lead","status":"running","text":"Agent agt-1 is now running.","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"activity":{"text":"Reading 4 files","kind":"read","at":"2026-10-26T10:00:00.000Z"}}"#
    let frames: [(String, String)] = [
      ("snapshot.run", #"{"run":{"id":"run-l","projectId":"prj-l","label":null,"state":"running","goal":"Ship it"}}"#),
      ("snapshot.agents", #"{"agents":[\#(agent)]}"#),
      ("snapshot.approvals", #"{"approvals":[]}"#),
      ("snapshot.end", #"{"snapshotSeq":7}"#),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: scope) }
    XCTAssertEqual(s.agentTree(runId: "run-l").first?.activity, "Reading 4 files")

    // Ephemeral: seq is the last durable seq (7, already the floor) and the frame has no id; it must still apply.
    let live = { (id: String, text: String?) in
      #"{"v":1,"id":"\#(id)","scope":"run-l","seq":7,"entity":"agt-1","entitySeq":0,"type":"agent.activity_changed","typeVersion":1,"durability":"ephemeral","ts":"2026-10-26T10:00:01.000Z","epochMs":8,"projectId":"prj-l","runId":"run-l","agentId":"agt-1","text":"x","data":{"agentId":"agt-1","status":"running","activity":\#(text.map { #"{"text":"\#($0)","kind":"write","at":"2026-10-26T10:00:01.000Z"}"# } ?? "null")}}"# }
    s.receive(StreamFrame.parse(event: "agent.activity_changed", data: live("eph-1", "Writing parquet shards to R2")), scope: scope)
    XCTAssertEqual(s.agentTree(runId: "run-l").first?.activity, "Writing parquet shards to R2")
    s.receive(StreamFrame.parse(event: "agent.activity_changed", data: live("eph-2", nil)), scope: scope)
    XCTAssertNil(s.agentTree(runId: "run-l").first?.activity)
    XCTAssertEqual(s.lastSeq[scope], 7)   // ephemeral frames never move the cursor
    XCTAssertEqual(s.duplicatesDropped, 0)
  }

  /// The provider comes from `Agent.provider` on snapshots, or agent.spawned's `agent.provider`, else `agent.kind`.
  func testProviderFromSpawnSpecAndSnapshot() async throws {
    let s = CapcomdStore()
    func send(_ seq: Int, _ type: String, agent: String? = nil, _ data: [String: JSONValue]) {
      s.receive(.event(Envelope(id: "p\(seq)", scope: "run-p", seq: seq, entity: agent ?? "run-p", type: type, epochMs: seq,
                                projectId: "prj-p", runId: "run-p", agentId: agent, data: data)), scope: "run-p")
    }
    send(1, "run.created", ["goal": .string("Mixed team")])
    send(2, "agent.spawned", agent: "agt-1", ["profile": .string("planner"),
                                               "agent": .object(["provider": .string("claude"), "kind": .string("claude-code"), "model": .string("claude-opus-5-5")])])
    send(3, "agent.spawned", agent: "agt-2", ["profile": .string("worker"), "agent": .object(["kind": .string("codex")])])
    send(4, "agent.spawned", agent: "agt-3", ["profile": .string("critic"), "agent": .object(["kind": .string("fake")])])
    let agents = s.runs["run-p"]?.agents
    XCTAssertEqual(agents?["agt-1"]?.provider, .claude); XCTAssertEqual(agents?["agt-1"]?.model, "claude-opus-5-5")
    XCTAssertEqual(agents?["agt-2"]?.provider, .codex); XCTAssertNil(agents?["agt-2"]?.model)
    XCTAssertNil(agents?["agt-3"]?.provider)

    let t = CapcomdStore(), scope = "lifecycle:run-q"
    let agent = #"{"id":"agt-1","runId":"run-q","parent":null,"depth":0,"profile":"lead","status":"running","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"provider":"codex","model":"gpt-5-codex"}"#
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-q","projectId":"prj-q","label":null,"state":"running","goal":"Ship it"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agent)]}"#), ("snapshot.approvals", #"{"approvals":[]}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      t.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
    XCTAssertEqual(t.runs["run-q"]?.agents["agt-1"]?.provider, .codex)
    XCTAssertEqual(t.runs["run-q"]?.agents["agt-1"]?.model, "gpt-5-codex")
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
