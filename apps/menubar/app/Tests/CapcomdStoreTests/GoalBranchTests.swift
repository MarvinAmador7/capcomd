import XCTest
import Foundation
@testable import CapcomdStore

/// Goal branches (capability `runs.goal_branch`), scripted per test.
final class FakeGoals: GoalBranchActing, @unchecked Sendable {
  var view: GoalView?
  var prAnswers: [Result<GoalPullRequestResult, Error>] = []
  var prKeys: [String] = []
  var keepAnswers: [Error?] = []
  var branchQueries: [[String?]] = []
  var branches = ProjectBranches(path: "/src/app", root: "/src/app", source: "github", defaultBranch: "develop", branches: ["develop", "main"], suggestedBase: "develop")
  func goal(runId: String) async throws -> GoalView { guard let view else { throw GoalActionRefused("run \(runId) has no goal branch") }; return view }
  func openPullRequest(runId: String, idempotencyKey: String) async throws -> GoalPullRequestResult { prKeys.append(idempotencyKey); return try prAnswers.removeFirst().get() }
  func keepBranch(runId: String, idempotencyKey: String) async throws { if let e = keepAnswers.isEmpty ? nil : keepAnswers.removeFirst() { throw e } }
  func projectBranches(path: String, goal: String?, goalBranch: String?, base: String?) async throws -> ProjectBranches {
    branchQueries.append([path, goal, goalBranch, base]); return branches
  }
}

/// What the daemon answers on GET /v1/runs/{runId}/goal (tests/api/goal-branch.test.ts has the same shape).
let goalJSON = """
{"runId":"run-g","branch":"capcomd/add-x","base":"dev","state":"ready","goal":"Add x","readyAt":"2026-11-01T10:00:00.000Z","plannerId":"agt-p",
 "summary":"Added x.\\nLeft: docs.","compare":{"baseSha":"aaaa","headSha":"bbbb","ahead":2,"behind":0,"commits":[{"sha":"bbbb","subject":"Add x","at":null}],"commitsTotal":2,
 "files":[{"path":"src/x.ts","oldPath":null,"status":"added","added":3,"removed":0}],"filesTotal":1,"added":3,"removed":0,"error":null},
 "landed":[{"agentId":"agt-w","parent":"agt-p","profile":"worker","task":"write x","branch":"capcomd/run-g/agt-w","mergeId":"mrg-1","sha":"cccc","verifyId":"vfy-1","mergedBy":"agt-p","checks":{"passed":true},"review":{"passed":true,"agentId":"agt-r","reasons":["ok"]}}],
 "notLanded":[{"agentId":"agt-v","parent":"agt-p","profile":"worker","task":"write y","branch":null,"status":"failed","reason":"failed","detail":"boom"},
              {"agentId":"agt-z","parent":"agt-p","profile":"worker","task":"write z","branch":null,"status":"done","reason":"something_new","detail":null}],
 "pullRequest":null,"openPullRequest":{"available":true,"reason":null,"repo":"acme/app"},"decision":null}
"""

@MainActor
final class GoalBranchTests: XCTestCase {
  func store(_ f: FakeGoals, keys: [String] = ["k1", "k2", "k3"]) -> CapcomdStore {
    var k = keys
    let s = CapcomdStore(goals: f, makeKey: { k.isEmpty ? "k-more" : k.removeFirst() })
    s.capabilities = [Capability.runsGoalBranch]
    return s
  }
  func event(_ type: String, _ seq: Int, _ data: [String: JSONValue]) -> StreamFrame {
    .event(Envelope(id: "e\(seq)", scope: "run-g", seq: seq, entity: "run-g", type: type, epochMs: 1_792_900_000_000 + seq, projectId: "p", runId: "run-g", agentId: nil, data: data))
  }

  func testTheGoalViewDecodes() throws {
    let v = try GoalWire.view(Data(goalJSON.utf8))
    XCTAssertEqual(v.branch, "capcomd/add-x"); XCTAssertEqual(v.base, "dev"); XCTAssertTrue(v.awaitsDecision)
    XCTAssertEqual(v.summary?.firstLine, "Added x.")
    XCTAssertEqual(v.compare.ahead, 2); XCTAssertEqual(v.compare.files.first?.path.plain, "src/x.ts"); XCTAssertEqual(v.compare.added, 3)
    XCTAssertEqual(v.landed.first?.checksPassed, true); XCTAssertEqual(v.landed.first?.review?.reasons.first?.plain, "ok"); XCTAssertEqual(v.landed.first?.mergedBy, "agt-p")
    XCTAssertEqual(v.notLanded.map(\.reasonText), ["The agent failed", "Not landed"])   // an unknown reason still reads
    XCTAssertEqual(v.notLanded.first?.detail?.plain, "boom")
    XCTAssertEqual(v.openPullRequest, .init(available: true, reason: nil, repo: "acme/app"))
  }

  func testRunGoalBranchFollowsTheSnapshotAndTheEvents() throws {
    let s = store(FakeGoals())
    let run = try JSONDecoder().decode(SnapshotRun.self, from: Data("""
      {"id":"run-g","projectId":"p","label":null,"state":"running","goal":"Add x","goalBranch":{"branch":"capcomd/add-x","base":"dev","state":"working","readyAt":null,"pullRequest":null}}
      """.utf8))
    s.receive(.reset(snapshotSeq: 1, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotRun(run), scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 1), scope: "daemon")
    XCTAssertEqual(s.runs["run-g"]?.goalBranch, GoalBranchSummary(branch: "capcomd/add-x", base: "dev"))
    XCTAssertEqual(s.runs["run-g"]?.goalBranch?.awaitsDecision, false)
    s.receive(event("run.goal_completed", 2, ["branch": .string("capcomd/add-x"), "base": .string("dev"), "plannerId": .string("agt-p")]), scope: "daemon")
    XCTAssertEqual(s.runs["run-g"]?.goalBranch?.state, GoalBranchSummary.ready)
    XCTAssertNotNil(s.runs["run-g"]?.goalBranch?.readyAt)
    XCTAssertEqual(s.runs["run-g"]?.goalBranch?.awaitsDecision, true)
    s.receive(event("run.pr_opened", 3, ["branch": .string("capcomd/add-x"), "base": .string("dev"), "number": .number(7), "url": .string("https://github.com/acme/app/pull/7"), "by": .string("client:x")]), scope: "daemon")
    XCTAssertEqual(s.runs["run-g"]?.goalBranch?.state, GoalBranchSummary.prOpened)
    XCTAssertEqual(s.runs["run-g"]?.goalBranch?.pullRequest, GoalPullRequest(number: 7, url: "https://github.com/acme/app/pull/7"))
    // A run without a goal branch has none, and older daemons send none.
    s.receive(.snapshotRun(SnapshotRun(id: "run-old", projectId: "p", label: nil, state: "idle", goal: "g", createdAt: nil)), scope: "daemon")
    XCTAssertNil(s.runs["run-old"]?.goalBranch)
  }

  func testLoadGoalAndOpenAPullRequestOnce() async throws {
    let f = FakeGoals(); f.view = try GoalWire.view(Data(goalJSON.utf8))
    let pr = GoalPullRequestResult(runId: "run-g", branch: "capcomd/add-x", base: "dev", created: true, pullRequest: GoalPullRequest(number: 1, url: "https://github.com/acme/app/pull/1", state: "open"))
    f.prAnswers = [.failure(URLError(.timedOut)), .success(pr)]
    let s = store(f)
    await s.loadGoal(runId: "run-g")
    XCTAssertEqual(s.goalViews["run-g"]?.value?.landed.count, 1)
    let failed = await s.openPullRequest(runId: "run-g")
    XCTAssertEqual(failed, .failed("Couldn't reach capcomd"))
    let opened = await s.openPullRequest(runId: "run-g")
    XCTAssertEqual(opened, .opened(pr))
    XCTAssertEqual(f.prKeys, ["k1", "k1"])          // a lost response can't open a second one
  }

  func testRefusalsCarryTheDaemonsSentence() async {
    let f = FakeGoals()
    let why = "capcomd opens pull requests with your GitHub login, and there is none on this machine: run `gh auth login` (or set GITHUB_TOKEN), then try again. The work is on capcomd/add-x."
    f.prAnswers = [.failure(GoalActionRefused(why))]
    f.keepAnswers = [GoalActionRefused("a pull request (#1) is open from capcomd/add-x: there's nothing to keep")]
    let s = store(f)
    let r = await s.openPullRequest(runId: "run-g")
    XCTAssertEqual(r, .refused(why))
    let k = await s.keepBranch(runId: "run-g")
    guard case .refused(let m) = k else { return XCTFail("expected refused, got \(k)") }
    XCTAssertTrue(m.contains("nothing to keep"))
    await s.loadGoal(runId: "run-none")
    XCTAssertEqual(s.goalViews["run-none"], .unavailable(.failed("run run-none has no goal branch")))
  }

  func testWithoutTheCapabilityItSaysUpdate() async {
    let s = CapcomdStore(goals: FakeGoals())
    let r = await s.openPullRequest(runId: "run-g")
    XCTAssertEqual(r, .failed(CapcomdStore.goalBranchNeedsUpdate))
    await s.loadProjectBranches(path: "/src/app", goal: "Add x")
    XCTAssertEqual(s.projectBranches, .unavailable(.unsupported))
  }

  func testTheSetupScreensBranches() async {
    let f = FakeGoals()
    let s = store(f)
    await s.loadProjectBranches(path: "/src/app", goal: "Add x", goalBranch: nil, base: "develop")
    XCTAssertEqual(f.branchQueries, [["/src/app", "Add x", nil, "develop"]])
    XCTAssertEqual(s.projectBranches?.value?.suggestedBase, "develop")
    XCTAssertEqual(s.projectBranches?.value?.defaultBranch, "develop")
    // The query keeps + and & inside values.
    XCTAssertEqual(GoalWire.branchesQuery(path: "/src/a b", goal: "C++ & more", goalBranch: nil, base: nil), "path=/src/a%20b&goal=C%2B%2B%20%26%20more")
  }

  func testTheStartRequestSendsBaseAndGoalBranchOnlyWhenChosen() throws {
    func body(_ c: RunChoice) throws -> [String: Any] { try JSONSerialization.jsonObject(with: try StartWire.body(goal: "g", choice: c)) as! [String: Any] }
    XCTAssertEqual(try body(RunChoice()).keys.sorted(), ["goal"])
    let b = try body(RunChoice(repo: "/src/app", base: "dev", goalBranch: "capcomd/add-x"))
    XCTAssertEqual(b["base"] as? String, "dev"); XCTAssertEqual(b["goalBranch"] as? String, "capcomd/add-x")
    XCTAssertEqual(try body(RunChoice(noGoalBranch: true))["goalBranch"] as? Bool, false)
  }

  func testAStartRefusedOverTheBaseNamesTheField() async {
    let f = FakeStarter(); f.outcomes = [.failure(StartRefused("can't tell which branch this run starts from", field: "base"))]
    let s = CapcomdStore(starter: f)
    let r = await s.startRun(goal: "Ship it", RunChoice(repo: "/src/app"))
    XCTAssertEqual(r, .failed("can't tell which branch this run starts from"))
    XCTAssertEqual(s.startRefusedField, "base")
    s.clearStart()
    XCTAssertNil(s.startRefusedField)
  }

  func testInspectWithoutADefaultBranchSuggestsNoTarget() throws {
    let i = try ProjectWire.inspection(Data("""
      {"path":"/src/app","root":"/src/app","name":"app","configured":false,"values":null,"repo":"https://github.com/acme/app.git","github":"acme/app",
       "ghReady":true,"defaultBranch":null,"branches":["dev","main"],"suggestedCheck":"","suggestedMode":"pr","suggestedAgents":["claude"],"agents":[],"budgetAsked":false,"problems":[]}
      """.utf8))
    XCTAssertNil(i.defaultBranch)
    XCTAssertEqual(SetupAnswers(i).target, "")   // the person picks one: never a guessed main
  }
}
