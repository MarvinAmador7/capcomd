import XCTest
@testable import CapcomdStore

/// The Active card's state (design/active-card, direction B): what it says folded, and what unfolds it.
@MainActor
final class ActiveCardTests: XCTestCase {
  var seq = 0
  /// planner ─┬ worker (running, editing)
  ///          └ reviewer (queued)
  func store(_ more: (CapcomdStore, (String, String?, [String: JSONValue], Int) -> Void) -> Void = { _, _ in }) -> CapcomdStore {
    let s = CapcomdStore()
    func ev(_ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int = 0) {
      seq += 1
      s.receive(.event(Envelope(id: "e\(seq)", scope: "run-c", seq: seq, entity: agent ?? "run-c", type: type, epochMs: at == 0 ? 1_000_000 + seq * 1000 : at,
                                projectId: "prj-c", runId: "run-c", agentId: agent, data: d)), scope: "run-c")
    }
    ev("run.created", nil, ["goal": .string("Add a clamp(x, lo, hi) function to src/math.ts")], at: 1_000_000)
    ev("agent.spawned", "pl", ["profile": .string("planner")])
    ev("agent.spawned", "wk", ["profile": .string("worker"), "parent": .string("pl")])
    ev("agent.spawned", "rv", ["profile": .string("critic"), "parent": .string("pl")])
    ev("agent.started", "pl"); ev("agent.started", "wk")
    ev("agent.activity_changed", "pl", ["activity": .object(["text": .string("Waiting on 1 agent"), "kind": .string("spawn")])], at: 1_020_000)
    ev("agent.activity_changed", "wk", ["activity": .object(["text": .string("Editing 2 files"), "kind": .string("edit")])], at: 1_030_000)
    more(s) { t, a, d, at in ev(t, a, d, at: at) }
    return s
  }
  func card(_ s: CapcomdStore) -> ActiveCard { s.activeCard(s.projects[0], nowMs: 1_100_000) }

  func testFoldedSaysWhoIsDoingWhatFromTheLatestActivity() {
    let c = card(store())
    guard case .working = c.body else { return XCTFail("\(c.body)") }
    XCTAssertNil(c.reason)
    XCTAssertEqual(c.sentence.text, "worker is editing 2 files")
    XCTAssertEqual(c.sentence.who?.agentId, "wk")
    XCTAssertEqual(c.crew.map(\.name), ["planner", "worker", "critic"])
    XCTAssertEqual(c.crewTotal, 3); XCTAssertEqual(c.crewMore, 0)
    XCTAssertEqual(c.startedAtMs, 1_000_000)
    XCTAssertEqual(c.title, "Add a clamp(x, lo, hi) function to src/math.ts")
  }

  func testTheSentenceReadsAnyActivityLine() {
    XCTAssertEqual(CapcomdStore.predicate("Reading 4 files"), " is reading 4 files")
    XCTAssertEqual(CapcomdStore.predicate("Read 4 files"), ": Read 4 files")
    XCTAssertEqual(CapcomdStore.predicate("Started 2 sub-agents"), ": Started 2 sub-agents")
    // Nobody working yet: the first queued agent; no agents at all: starting.
    let s = CapcomdStore()
    s.receive(.event(Envelope(id: "a", scope: "run-q", seq: 1, entity: "run-q", type: "run.created", epochMs: 1, projectId: "p", runId: "run-q", agentId: nil, data: ["goal": .string("g")])), scope: "run-q")
    XCTAssertEqual(s.activeCard(s.projects[0], nowMs: 2).sentence.text, "Starting")
    s.receive(.event(Envelope(id: "b", scope: "run-q", seq: 2, entity: "pl", type: "agent.spawned", epochMs: 2, projectId: "p", runId: "run-q", agentId: "pl", data: ["profile": .string("planner")])), scope: "run-q")
    XCTAssertEqual(s.activeCard(s.projects[0], nowMs: 3).sentence.text, "planner is queued")
  }

  func testAnApprovalUnfoldsTheCardIntoTheAsk() {
    let s = store { _, ev in
      ev("approval.requested", "wk", ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge this agent's work into main?"),
                                      "requestedBy": .object(["agentId": .string("wk"), "runId": .string("run-c")]),
                                      "subject": .object(["target": .string("main"), "ref": .string("capcomd/run-c/wk"), "filesTotal": .number(3), "added": .number(25), "removed": .number(2),
                                                          "files": .array([.object(["path": .string("src/math.test.ts"), "status": .string("added"), "added": .number(13), "removed": .number(0)]),
                                                                           .object(["path": .string("src/math.ts"), "status": .string("modified"), "added": .number(11), "removed": .number(2)])])])], 1_082_000)
    }
    let c = card(s)
    guard case .ask(let ask) = c.body else { return XCTFail("\(c.body)") }
    XCTAssertEqual(c.reason, "ask:apr-1")
    XCTAssertEqual(ask.question, "Merge worker's work into main?")   // worded by the client from kind, asker and target
    XCTAssertEqual(ask.asker?.agentId, "wk")
    XCTAssertEqual(ask.waiters.map(\.name), ["planner", "critic"])   // its live parent, and the agent still queued
    XCTAssertEqual(ask.approval.requestedAtMs, 1_082_000)
    let diff = try! XCTUnwrap(ask.approval.diff)
    XCTAssertEqual(diff.files.map(\.path.plain), ["src/math.test.ts", "src/math.ts"])
    XCTAssertEqual(diff.files.map(\.added), [13, 11])
    XCTAssertEqual([diff.total, diff.added, diff.removed], [3, 25, 2])
    XCTAssertEqual(ask.approval.branchLine, "capcomd/run-c/wk → main")
    // The tree's own row shows the hand: the asker waits.
    XCTAssertTrue(s.agentTree(runId: "run-c")[0].children.first { $0.id == "wk" }!.waiting)
  }

  func testANonMergeAskKeepsItsOwnQuestionAndAnOldDaemonHasNoFiles() {
    let s = store { _, ev in
      ev("approval.requested", "wk", ["approvalId": .string("apr-2"), "kind": .string("egress"), "question": .string("Reach api.example.com?"),
                                      "requestedBy": .object(["agentId": .string("wk"), "runId": .string("run-c")]), "subject": .object(["host": .string("api.example.com")])], 0)
    }
    guard case .ask(let ask) = card(s).body else { return XCTFail() }
    XCTAssertEqual(ask.question, "Reach api.example.com?")
    XCTAssertNil(ask.approval.diff)
    XCTAssertEqual(ask.approval.branchLine, "api.example.com")
  }

  func testAFailedAgentUnfoldsWithTheLineThatSaysWhy() {
    let s = store { _, ev in
      ev("agent.failed", "wk", ["result": .object(["error": .string("exit code 1"), "costUsd": .number(0.12),
                                                   "verification": .object(["pass": .bool(false), "checks": .object(["passed": .bool(false), "status": .string("failed"),
                                                                                                                       "reason": .string("tests failed (exit 1)"), "excerpt": .string("Expected: 10.33\nReceived: 10.34")])])])], 1_090_000)
    }
    let c = card(s)
    guard case .failed(let f) = c.body else { return XCTFail("\(c.body)") }
    XCTAssertEqual(c.reason, "failed:wk")
    XCTAssertEqual(f.agent.name, "worker")
    XCTAssertTrue(f.checksFailed)
    XCTAssertEqual(f.detail?.plain, "Expected: 10.33\nReceived: 10.34")
    XCTAssertEqual(c.sentence.text, "planner is waiting on 1 agent")   // the folded line moves to whoever still works
    // An agent that failed by itself: its error.
    let t = store { _, ev in ev("agent.failed", "wk", ["result": .object(["error": .string("the VM went away")])], 0) }
    guard case .failed(let g) = card(t).body else { return XCTFail() }
    XCTAssertFalse(g.checksFailed); XCTAssertEqual(g.detail?.plain, "the VM went away")
  }

  func testAUsageLimitPauseUnfoldsWithWhenItPicksUpAgain() {
    let s = store { _, ev in
      ev("agent.paused", "pl", ["result": .object(["limit": .string("quota"), "resetAt": .number(1_700_000)]), "until": .number(1_700_000), "cause": .string("usage_limit")], 0)
      ev("agent.paused", "wk", ["result": .object(["limit": .string("quota"), "resetAt": .null]), "until": .number(1_650_000), "cause": .string("usage_limit")], 0)
    }
    let c = card(s)
    guard case .paused(let p) = c.body else { return XCTFail("\(c.body)") }
    XCTAssertEqual(p.agents.map(\.name), ["planner", "worker"])
    XCTAssertEqual(p.resumesAtMs, 1_650_000)   // the earliest: the worker's `until` (its result didn't say)
    XCTAssertEqual(c.reason, "paused:run-c:pl,wk")
    // Someone pausing an agent is no usage limit: the card stays folded.
    let t = store { _, ev in ev("agent.paused", "wk", ["result": .object(["limit": .string("paused")]), "until": .null], 0) }
    guard case .working = card(t).body else { return XCTFail() }
    // Resumed: the limit is gone.
    let u = store { _, ev in
      ev("agent.paused", "wk", ["result": .object(["limit": .string("quota")]), "until": .number(5)], 0)
      ev("agent.resumed", "wk", [:], 0)
    }
    guard case .working = card(u).body else { return XCTFail() }
  }

  func testTheAskComesFirstThenAFailureThenAPause() {
    let s = store { _, ev in
      ev("agent.paused", "pl", ["result": .object(["limit": .string("quota")]), "until": .number(9)], 0)
      ev("agent.failed", "rv", ["result": .object(["error": .string("boom")])], 0)
    }
    guard case .failed = card(s).body else { return XCTFail("\(card(s).body)") }
    s.receive(.event(Envelope(id: "x", scope: "run-c", seq: 999, entity: "apr-9", type: "approval.requested", epochMs: 1, projectId: "prj-c", runId: "run-c", agentId: "wk",
                              data: ["approvalId": .string("apr-9"), "kind": .string("merge"), "question": .string("q"), "requestedBy": .object(["agentId": .string("wk"), "runId": .string("run-c")]),
                                     "subject": .object(["target": .string("main")])])), scope: "run-c")
    guard case .ask(let a) = card(s).body else { return XCTFail() }
    XCTAssertEqual(a.waiters.map(\.name), ["planner"])   // paused is still alive and waits; the failed reviewer doesn't
  }

  func testAFinishedRunFoldsToItsOutcome() {
    let s = store { s, ev in
      ev("agent.done", "wk", ["result": .object(["costUsd": .number(0.29), "verification": .object(["pass": .bool(true), "checks": .object(["passed": .bool(true)])]),
                                                 "merge": .object(["id": .string("mrg-1"), "target": .string("main"), "state": .string("merged")])])], 0)
      ev("agent.done", "rv", ["result": .object(["costUsd": .number(0.12)])], 0)
      ev("agent.done", "pl", ["result": .object([:])], 0)
      ev("run.completed", nil, ["cause": .string("all_agents_done")], 1_372_000)
      s.files["run-c"] = .loaded(RunFiles(runId: "run-c", asOf: 9, files: [
        .init(path: "src/math.ts", oldPath: nil, status: "modified", added: 11, removed: 0, agentId: "wk"),
        .init(path: "src/math.test.ts", oldPath: nil, status: "added", added: 13, removed: 0, agentId: "wk")], total: 2, truncated: false))
    }
    let p = s.projects[0]
    XCTAssertFalse(p.isActive)
    let o = try! XCTUnwrap(s.outcome(p))
    XCTAssertEqual(o.head, "Merged into main")
    XCTAssertEqual(o.durationMs, 372_000)
    XCTAssertEqual([o.files, o.added, o.removed], [2, 24, 0])
    XCTAssertEqual(o.checksPassed, true)
    XCTAssertEqual(o.costUsd!, 0.41, accuracy: 0.0001)
    XCTAssertEqual(o.crew.map(\.name), ["planner", "worker", "critic"])
    XCTAssertNil(o.failure)
  }

  func testADeniedMergeSaysSoAndDropsTheCheckmark() {
    // As the daemon reports it on connect: the worker's result records the denial.
    let s = store { _, ev in
      ev("agent.done", "wk", ["result": .object(["verification": .object(["pass": .bool(true)]),
                                                 "merge": .object(["id": .string("mrg-1"), "target": .string("main"), "state": .string("denied")])])], 0)
      ev("agent.done", "rv", ["result": .object([:])], 0); ev("agent.done", "pl", ["result": .object([:])], 0)
      ev("run.completed", nil, [:], 96_000)
    }
    let o = try! XCTUnwrap(s.outcome(s.projects[0]))
    XCTAssertEqual(o.head, "Merge denied")
    XCTAssertTrue(o.notMerged)
    XCTAssertEqual(o.checksPassed, true)

    // Live: the denial arrives after the worker finished (its result had no merge yet).
    let live = store { _, ev in
      ev("agent.done", "wk", ["result": .object(["verification": .object(["pass": .bool(true)])])], 0)
      ev("agent.done", "rv", ["result": .object([:])], 0); ev("agent.done", "pl", ["result": .object([:])], 0)
      ev("run.completed", nil, [:], 96_000)
      ev("merge.denied", "wk", ["id": .string("mrg-1"), "merged": .bool(false), "status": .string("denied")], 120_000)
    }
    let l = try! XCTUnwrap(live.outcome(live.projects[0]))
    XCTAssertEqual(l.head, "Merge denied")
    XCTAssertTrue(l.notMerged)

    // A merge that landed later still wins over an earlier denial.
    let landed = store { _, ev in
      ev("agent.done", "wk", ["result": .object(["merge": .object(["state": .string("denied"), "target": .string("main")])])], 0)
      ev("agent.done", "rv", ["result": .object(["merge": .object(["state": .string("merged"), "target": .string("main")])])], 0)
      ev("agent.done", "pl", ["result": .object([:])], 0)
      ev("run.completed", nil, [:], 96_000)
    }
    let m = try! XCTUnwrap(landed.outcome(landed.projects[0]))
    XCTAssertEqual(m.head, "Merged into main")
    XCTAssertFalse(m.notMerged)
  }

  func testAFailedMergeSaysSo() {
    let s = store { _, ev in
      ev("agent.done", "wk", ["result": .object([:])], 0)
      ev("merge.failed", "wk", ["id": .string("mrg-1"), "target": .string("main"), "reason": .string("conflict")], 10)
      ev("agent.done", "rv", ["result": .object([:])], 0); ev("agent.done", "pl", ["result": .object([:])], 0)
      ev("run.completed", nil, [:], 96_000)
    }
    let o = try! XCTUnwrap(s.outcome(s.projects[0]))
    XCTAssertEqual(o.head, "Merge failed")
    XCTAssertTrue(o.notMerged)
  }

  func testAFailedRunsOutcomeSaysWhyAndASubscriptionRunHasNoCost() {
    let s = store { _, ev in
      ev("agent.failed", "wk", ["result": .object(["error": .string("exit code 1"), "billing": .string("subscription"), "costUsd": .number(0)])], 0)
      ev("agent.cancelled", "rv", [:], 0); ev("agent.failed", "pl", ["result": .object([:])], 0)
      ev("run.failed", nil, ["cause": .string("agent_failed")], 0)
    }
    let o = try! XCTUnwrap(s.outcome(s.projects[0]))
    XCTAssertEqual(o.head, "Failed")
    XCTAssertEqual(o.failure?.plain, "exit code 1")
    XCTAssertNil(o.costUsd); XCTAssertNil(o.files); XCTAssertNil(o.checksPassed)
  }

  func testSnapshotsCarryTheNewFields() {
    let approvals = StreamFrame.parse(event: "snapshot.approvals", data: """
    {"approvals":[{"approvalId":"apr-s","kind":"merge","status":"pending","question":"Merge this agent's work into main?","requestedBy":{"agentId":"wk","runId":"run-s"},
      "subject":{"target":"main","ref":"b","files":[{"path":"a.ts","status":"modified","added":3,"removed":1},{"path":"logo.png","status":"added","added":null,"removed":null}],"filesTotal":2,"added":3,"removed":1},
      "expiresAt":null,"requestedAt":"2026-10-27T10:00:00.000Z"}]}
    """)
    guard case .snapshotApprovals(let a) = approvals else { return XCTFail("\(approvals)") }
    XCTAssertEqual(a[0].requestedAt, "2026-10-27T10:00:00.000Z")
    let agents = StreamFrame.parse(event: "snapshot.agents", data: """
    {"agents":[{"id":"wk","runId":"run-s","parent":null,"depth":0,"profile":"worker","status":"paused","text":"t",
      "activity":{"text":"Ran the tests","kind":"test","at":"2026-10-27T09:59:00.000Z"},"task":null,"taskAttachment":null,"workspace":null,"updatedAt":null,"provider":"claude","model":null,
      "result":{"costUsd":0.25,"limit":"quota","resetAt":1792900000000,"error":"usage limit","verification":{"pass":false,"checks":{"passed":false,"reason":"tests failed","excerpt":"1 fail"}},
                "merge":{"id":"mrg-1","target":"main","state":"failed","status":"conflict"}}}]}
    """)
    let s = CapcomdStore()
    s.receive(.reset(snapshotSeq: 5, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotRun(SnapshotRun(id: "run-s", projectId: "p", label: nil, state: "running", goal: "g", createdAt: nil)), scope: "daemon")
    s.receive(agents, scope: "daemon"); s.receive(approvals, scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 5), scope: "daemon")
    let ag = try! XCTUnwrap(s.runs["run-s"]?.agents["wk"])
    XCTAssertEqual(ag.costUsd, 0.25); XCTAssertEqual(ag.limit, "quota"); XCTAssertEqual(ag.resetAtMs, 1_792_900_000_000)
    XCTAssertEqual(ag.error?.plain, "usage limit")
    XCTAssertEqual(ag.checks, CheckOutcome(passed: false, reason: UntrustedText("tests failed"), excerpt: UntrustedText("1 fail")))
    XCTAssertEqual(ag.merge, MergeOutcome(state: "failed", target: "main"))
    XCTAssertEqual(ag.activityAtMs, epochMs(iso: "2026-10-27T09:59:00.000Z"))
    let ap = try! XCTUnwrap(s.approvals["apr-s"])
    XCTAssertEqual(ap.requestedAtMs, epochMs(iso: "2026-10-27T10:00:00.000Z"))
    XCTAssertEqual(ap.target, "main")
    XCTAssertEqual(ap.diff?.files.map(\.added), [3, nil])
    XCTAssertEqual(ap.diff?.total, 2)
  }

  func testClockAndNames() {
    XCTAssertEqual(elapsedClock(ms: 42_000), "0:42")
    XCTAssertEqual(elapsedClock(ms: 252_000), "4:12")
    XCTAssertEqual(elapsedClock(ms: 3_729_000), "1:02:09")
    XCTAssertEqual(namesPhrase(["planner"]), "planner")
    XCTAssertEqual(namesPhrase(["planner", "reviewer"]), "planner and reviewer")
    XCTAssertEqual(namesPhrase(["planner", "lead", "critic"]), "planner, lead and 1 other")
    XCTAssertEqual(namesPhrase(["a", "b", "c", "d"]), "a, b and 2 others")
  }
}
