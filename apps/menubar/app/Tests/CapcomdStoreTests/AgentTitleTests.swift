import XCTest
@testable import CapcomdStore

/// Agent titles (capability agents.title): decoded from the snapshot and the live events, which one shows (the
/// person's sticks: agent.titled with shown false changes nothing), what the tree, the crew tabs, the column headers
/// and the asks call an agent, the suffix as a tie-breaker only, the planner's name for the run, and the inline
/// rename's model and store action.
@MainActor
final class AgentTitleTests: XCTestCase {
  var seq = 0
  func ev(_ s: CapcomdStore, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:]) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: "run-a", seq: seq, entity: agent ?? "run-a", type: type, epochMs: 1_000 + seq, projectId: "prj-a",
                              runId: "run-a", agentId: agent, data: d)), scope: "run-a")
  }
  func titled(_ s: CapcomdStore, _ agent: String, _ title: String?, by: String, shown: Bool = true, source: String? = nil) {
    var d: [String: JSONValue] = ["agentId": .string(agent), "by": .string(by), "setBy": .string(agent), "shown": .bool(shown),
                                  "titleSource": source.map(JSONValue.string) ?? .string(by)]
    d["title"] = title.map(JSONValue.string) ?? .null
    ev(s, "agent.titled", agent, d)
  }
  /// lead ─┬ worker "login redirect" (derived at spawn)
  ///       ├ worker "auth fix" (its parent's title)
  ///       └ worker (no title: an older daemon's event)
  func store(titles: AgentTitling? = nil, caps: Set<String> = [Capability.agentsTitle]) -> CapcomdStore {
    let info = FakeInfo(); info.caps = caps
    let s = CapcomdStore(daemonInfo: info, titles: titles, makeKey: { "key-\(UUID().uuidString)" })
    ev(s, "run.created", nil, ["goal": .string("Fix the login redirect")])
    ev(s, "agent.spawned", "ld", ["profile": .string("lead"), "task": .string("Goal: fix the login redirect"), "title": .string("fix login redirect"), "titleSource": .string("derived")])
    ev(s, "agent.spawned", "w1", ["profile": .string("worker"), "parent": .string("ld"), "title": .string("login redirect"), "titleSource": .string("derived")])
    ev(s, "agent.spawned", "w2", ["profile": .string("worker"), "parent": .string("ld"), "title": .string("auth fix"), "titleSource": .string("parent")])
    ev(s, "agent.spawned", "w3", ["profile": .string("worker"), "parent": .string("ld"), "key": .string("task-77ab")])
    return s
  }

  func testSpawnedTitlesNameTheTreeTabsAndHeaders() {
    let s = store()
    let tree = s.agentTree(runId: "run-a")
    XCTAssertEqual(tree[0].title, "fix login redirect")
    XCTAssertEqual(tree[0].children.map(\.title), ["login redirect", "auth fix", nil])
    // Titles tell the workers apart: no suffix for the titled ones (the untitled one keeps the old one only when its
    // own profile group needs it; it's alone among the untitled).
    XCTAssertEqual(tree[0].children.map(\.suffix), [nil, nil, nil])
    let cols = s.reelColumns(runId: "run-a")
    XCTAssertEqual(cols.map(\.tabLabel), ["fix login redirect", "login redirect", "auth fix", "worker"])
    XCTAssertEqual(cols[1].label, "worker · login redirect")
    XCTAssertEqual(cols[2].title, "auth fix")
    XCTAssertEqual(tree[0].children[0].accessibilityLabel.hasPrefix("worker · login redirect"), true)
  }

  func testTheSuffixComesBackOnlyWhenSiblingsShareATitle() {
    let s = store()
    titled(s, "w2", "login redirect", by: "self")
    let kids = s.agentTree(runId: "run-a")[0].children
    XCTAssertEqual(kids.map(\.suffix), ["w1", "w2", nil].map { $0.map { String($0.suffix(4)) } })
    XCTAssertEqual(s.reelColumns(runId: "run-a")[2].tabLabel, "login redirect w2")
  }

  func testAgentTitledPrecedence() {
    let s = store()
    titled(s, "w1", "redirect loop", by: "self")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "redirect loop")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleSource, "self")
    titled(s, "w1", "my tab", by: "user")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleSource, "user")
    // The agent renames itself under the person's title: kept by the daemon, not shown.
    titled(s, "w1", "second focus", by: "self", shown: false, source: "user")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "my tab")
    // The person clears theirs: the event carries the title shown now.
    titled(s, "w1", "second focus", by: "cleared", source: "self")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "second focus")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleSource, "self")
  }

  func testSnapshotTitlesDecodeAndAnOlderDaemonKeepsTheSuffixes() throws {
    let json = #"{"id":"w1","runId":"run-a","parent":null,"depth":0,"profile":"worker","status":"running","title":"login redirect","titleSource":"self"}"#
    let a = try JSONDecoder().decode(SnapshotAgent.self, from: Data(json.utf8))
    XCTAssertEqual(a.title, "login redirect"); XCTAssertEqual(a.titleSource, "self")
    let old = try JSONDecoder().decode(SnapshotAgent.self, from: Data(#"{"id":"w1","runId":"run-a","parent":null,"depth":0,"profile":"worker","status":"running"}"#.utf8))
    XCTAssertNil(old.title)
    // No titles at all (an older daemon): siblings of one profile get their suffixes, as before.
    let s = CapcomdStore()
    ev(s, "agent.spawned", "ld", ["profile": .string("lead")])
    ev(s, "agent.spawned", "w1", ["profile": .string("worker"), "parent": .string("ld"), "key": .string("task-d3ce")])
    ev(s, "agent.spawned", "w2", ["profile": .string("worker"), "parent": .string("ld"), "key": .string("task-4423")])
    XCTAssertEqual(s.reelColumns(runId: "run-a").map(\.tabLabel), ["lead", "d3ce", "4423"])
    XCTAssertEqual(s.agentTree(runId: "run-a")[0].children.map(\.label), ["worker d3ce", "worker 4423"])
  }

  func testAsksAndNotificationsNameTheAgentByItsTitle() {
    let s = store()
    var notices: [Notice] = []
    s.onNotify = { notices.append($0) }
    s.receive(.event(Envelope(id: "lc1", scope: "lifecycle:run-a", seq: 99, entity: "w1", type: "approval.requested", epochMs: 5_000, projectId: "prj-a", runId: "run-a", agentId: "w1",
                              data: ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge this agent's work into main?"),
                                     "requestedBy": .object(["agentId": .string("w1"), "runId": .string("run-a")]), "subject": .object(["askedBy": .string("ld"), "target": .string("main")])])), scope: CapcomdStore.lifecycleKey("run-a"))
    XCTAssertEqual(s.decks()[0].askingName, "lead · fix login redirect")
    // The Active card words the merge with the agent's title, no possessive.
    guard case .ask(let ask) = s.activeCard(s.projects[0], nowMs: 6_000).body else { return XCTFail("no ask") }
    XCTAssertEqual(ask.question, "Merge work from worker · login redirect into main?")
    guard case .approvalRequested(_, _, _, let asker)? = notices.first else { return XCTFail("no notice") }
    XCTAssertEqual(asker, "lead · fix login redirect")
  }

  func testThePlannerNamesTheRunBelowALabelOfItsOwn() {
    let s = store()
    XCTAssertEqual(s.runs["run-a"]?.title, "Fix the login redirect")
    ev(s, "run.titled", "ld", ["title": .string("login fixes"), "setBy": .string("ld")])
    XCTAssertEqual(s.runs["run-a"]?.title, "login fixes")
    XCTAssertEqual(s.runs["run-a"]?.titled?.source, .agent)
    ev(s, "run.new", nil, ["label": .string("Auth work")])
    XCTAssertEqual(s.runs["run-a"]?.title, "Auth work")
  }

  func testTitlesAreOnePlainLine() {
    XCTAssertEqual(AgentTitle.shown(UntrustedText("  Login\u{202E}  Redirect \nsecond line")), "login redirect")
    XCTAssertEqual(AgentTitle.shown(UntrustedText(String(repeating: "x", count: 40)))?.count, 32)
    XCTAssertNil(AgentTitle.shown(UntrustedText("  \n ")))
    XCTAssertEqual(AgentTitle.clean("a\u{200B}b 👩‍💻"), "ab 👩‍💻")
    let n = AgentNode(id: "agt-1234abcd", name: "worker", title: "login redirect", suffix: nil, kind: .worker, status: .running, depth: 1, waiting: false, descendantWaiting: false, children: [])
    XCTAssertEqual(AgentTitle.handle(n), "@worker-login-redirect")
  }

  // MARK: renaming

  func testTheEditingModel() {
    var e = TitleEdit(agentId: "w1", current: "login redirect", userTitled: false)
    XCTAssertEqual(e.commit, .unchanged)          // Return without a change
    e.draft = "  Redirect   Loop "
    XCTAssertEqual(e.commit, .set("redirect loop"))
    e.draft = "one two three four five"
    XCTAssertEqual(e.commit, .invalid("A name is 1 to 4 words, not 5"))
    XCTAssertEqual(e.error, "A name is 1 to 4 words, not 5")
    e.draft = String(repeating: "x", count: 33)
    XCTAssertEqual(e.commit, .invalid("A name is at most 32 characters, not 33"))
    e.draft = "   "
    XCTAssertEqual(e.commit, .unchanged, "an empty field with no name of yours changes nothing")
    XCTAssertNil(e.error)
    var mine = TitleEdit(agentId: "w1", current: "my tab", userTitled: true)
    mine.draft = ""
    XCTAssertEqual(mine.commit, .clear, "an empty field clears your name")
  }

  func testRenameShowsAtOnceAndConfirms() async {
    let t = FakeTitler(answer: .success(("redirect loop", "user")))
    let s = store(titles: t)
    let r = await s.rename(runId: "run-a", agentId: "w1", .set("redirect loop"))
    XCTAssertNil(r)
    XCTAssertEqual(t.calls.map(\.title), ["redirect loop"])
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "redirect loop")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleSource, "user")
    XCTAssertEqual(s.titleEdit(runId: "run-a", agentId: "w1")?.userTitled, true)
    // Clearing sends DELETE (nil) and shows what the daemon says is shown now.
    t.answer = .success(("login redirect", "derived"))
    _ = await s.rename(runId: "run-a", agentId: "w1", .clear)
    XCTAssertEqual(t.calls.last?.title, .some(nil))
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "login redirect")
    // Nothing to send: no call.
    _ = await s.rename(runId: "run-a", agentId: "w1", .unchanged)
    XCTAssertEqual(t.calls.count, 2)
  }

  func testARefusedOrFailedRenamePutsTheOldTitleBackAndARetryReusesItsKey() async {
    let t = FakeTitler(answer: .failure(URLError(.notConnectedToInternet)))
    let s = store(titles: t)
    let r = await s.rename(runId: "run-a", agentId: "w1", .set("redirect loop"))
    XCTAssertEqual(r, .failed("Couldn't reach capcomd"))
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleText, "login redirect")
    XCTAssertEqual(s.runs["run-a"]?.agents["w1"]?.titleSource, "derived")
    t.answer = .success(("redirect loop", "user"))
    _ = await s.rename(runId: "run-a", agentId: "w1", .set("redirect loop"))
    XCTAssertEqual(t.calls.count, 2)
    XCTAssertEqual(t.calls[0].key, t.calls[1].key, "a retry after a transport failure replays the first request")
    t.answer = .failure(AgentTitle.Refused("a title is 1 to 4 words, not 5"))
    let refused = await s.rename(runId: "run-a", agentId: "w2", .set("x"))
    XCTAssertEqual(refused, .failed("a title is 1 to 4 words, not 5"))
    XCTAssertEqual(s.runs["run-a"]?.agents["w2"]?.titleText, "auth fix")
  }

  func testAnOlderDaemonCantRename() async {
    let t = FakeTitler(answer: .success(("x", "user")))
    let s = store(titles: t, caps: ["agent.pause"])
    let r = await s.rename(runId: "run-a", agentId: "w1", .set("x"))
    XCTAssertEqual(r, .failed(CapcomdStore.titlesNeedUpdate))
    XCTAssertTrue(t.calls.isEmpty)
  }
}

final class FakeTitler: AgentTitling, @unchecked Sendable {
  var answer: Result<(String?, String?), Error>
  var calls: [(title: String?, key: String)] = []
  init(answer: Result<(String?, String?), Error>) { self.answer = answer }
  func setTitle(runId: String, agentId: String, title: String?, idempotencyKey: String) async throws -> (title: String?, titleSource: String?) {
    calls.append((title, idempotencyKey))
    let (t, s) = try answer.get()
    return (t, s)
  }
}
