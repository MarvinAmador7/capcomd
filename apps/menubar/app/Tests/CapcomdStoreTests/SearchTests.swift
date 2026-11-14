import XCTest
@testable import CapcomdStore

/// Search ⌘K as data (design/desktop/rex/CommandK.dc.html): matching, ranking by group, the empty search, the commands,
/// and how long a keystroke takes with hundreds of items.
@MainActor
final class SearchTests: XCTestCase {
  var seq = 0
  func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int = 1_000) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)",
                              runId: run, agentId: agent, data: d)), scope: run)
  }
  func agent(_ s: CapcomdStore, _ run: String, _ id: String, _ profile: String, title: String, parent: String? = nil, at: Int) {
    var d: [String: JSONValue] = ["profile": .string(profile), "title": .string(title)]
    if let parent { d["parent"] = .string(parent) }
    ev(s, run, "agent.spawned", id, d, at: at)
    ev(s, run, "agent.started", id, at: at + 1)
  }

  /// Two projects, as on the board: "migrate matchkey" (a planner, a lead, a worker that asks) and "fix proration".
  func board() -> CapcomdStore {
    let s = CapcomdStore()
    ev(s, "run-a", "run.created", nil, ["goal": .string("migrate matchkey")], at: 1_000)
    agent(s, "run-a", "a-pl", "planner", title: "matchkey migration", at: 1_001)
    agent(s, "run-a", "a-ld", "lead", title: "ids/v1 split", parent: "a-pl", at: 1_010)
    agent(s, "run-a", "a-w1", "worker", title: "fix email join", parent: "a-ld", at: 1_020)
    agent(s, "run-a", "a-w2", "worker", title: "v3.2 shards", parent: "a-ld", at: 1_030)
    ev(s, "run-a", "approval.requested", "a-w1", ["approvalId": .string("apr-1"), "kind": .string("egress"), "question": .string("Reach the registry?"),
                                                  "requestedBy": .object(["agentId": .string("a-w1"), "runId": .string("run-a")])], at: 1_040)
    ev(s, "run-b", "run.created", nil, ["goal": .string("fix proration")], at: 2_000)
    agent(s, "run-b", "b-pl", "planner", title: "proration plan", at: 2_001)
    agent(s, "run-b", "b-w1", "worker", title: "invoice rounding", parent: "b-pl", at: 2_010)
    ev(s, "run-b", "agent.paused", "b-w1", ["result": .object(["limit": .string("quota")])], at: 2_020)
    return s
  }

  func index(_ s: CapcomdStore, menu: ProjectMenu? = nil, focusedAsk: String? = nil) -> SearchIndex {
    var i = SearchIndex()
    let decks = s.decks()
    i.set(runs: decks.map(\.runId))
    for d in decks { i.set(agents: s.searchAgents(deck: d), run: d.runId) }
    i.set(asks: s.searchAsks(decks: decks))
    i.set(projects: CapcomdStore.searchProjects(decks))
    i.set(commands: SearchCommands.make(SearchCommandContext(menu: menu, projectTitle: decks.first?.title, focusedAsk: focusedAsk, follow: true, homeShown: false)))
    return i
  }
  func titles(_ r: [SearchSection]) -> [String] { r.flatMap { sec in sec.hits.map { "\(sec.group.title): \($0.item.title.text)" } } }

  // MARK: matching

  func testWholeWordsBeatWordStartsBeatInsidesBeatFuzzy() throws {
    let t = SearchText("matchkey migration")
    let prefix = try XCTUnwrap(t.match(SearchText.tokens("match")[0]))
    let word = try XCTUnwrap(t.match(SearchText.tokens("migr")[0]))
    let inside = try XCTUnwrap(t.match(SearchText.tokens("key")[0]))
    let fuzzy = try XCTUnwrap(t.match(SearchText.tokens("mkm")[0]))
    XCTAssertGreaterThan(prefix.score, word.score)
    XCTAssertGreaterThan(word.score, inside.score)
    XCTAssertGreaterThan(inside.score, fuzzy.score)
    XCTAssertEqual(prefix.at, [0, 1, 2, 3, 4])
    XCTAssertEqual(word.at, [9, 10, 11, 12])
    // Fuzzy takes the word starts it can: m(atch)k(ey) m(igration).
    XCTAssertEqual(fuzzy.at, [0, 5, 9])
  }

  func testCaseDiacriticsAndCamelCase() {
    XCTAssertNotNil(SearchText("Résumé builder").match(SearchText.tokens("resume")[0]))
    XCTAssertNotNil(SearchText("loginRedirect").match(SearchText.tokens("lr")[0]))      // camel-case word starts
    XCTAssertEqual(SearchText("loginRedirect").match(SearchText.tokens("red")[0])?.score, 800 - 10)
    XCTAssertNil(SearchText("matchkey").match(SearchText.tokens("x")[0]))
    XCTAssertNil(SearchText("matchkey").match(SearchText.tokens("ak")[0]))               // fuzzy starts at a word start
    XCTAssertNil(SearchText("ab").match(SearchText.tokens("abc")[0]))
  }

  // MARK: ranking

  /// The board's "match" search: Needs you first, then agents (by their own titles; the project's name counts too),
  /// projects, commands. An agent that needs you shows there only.
  func testRankedByAttentionThenScore() {
    let s = board()
    let menu = s.projectMenu(projectId: s.decks()[0].id, runId: "run-a")
    let r = index(s, menu: menu).search("match").sections
    XCTAssertEqual(r.map(\.group), [.needsYou, .agents, .projects, .commands])
    XCTAssertEqual(r[0].hits.map(\.item.title.text), ["fix email join"])
    // The planner's own title starts with it; the others match through their project.
    XCTAssertEqual(r[1].hits.map(\.item.title.text), ["matchkey migration", "ids/v1 split", "v3.2 shards"])
    XCTAssertEqual(r[1].hits[0].titleHits, [0, 1, 2, 3, 4])
    XCTAssertEqual(r[1].hits[1].subtitleHits, [8, 9, 10, 11, 12])          // "migrate matchkey · lead"
    XCTAssertEqual(r[2].hits.map(\.item.title.text), ["migrate matchkey"])
    XCTAssertTrue(r[3].hits.map(\.item.title.text).contains("Message the planner of migrate matchkey…"))
    XCTAssertFalse(r[1].hits.contains { $0.item.agentId == "a-w1" })
  }

  func testEveryWordMustMatch() {
    let s = board()
    XCTAssertEqual(titles(index(s).search("proration plan").sections), ["Agents: proration plan"])
    XCTAssertEqual(titles(index(s).search("fix join").sections), ["Needs you: fix email join"])
    XCTAssertTrue(index(s).search("zzz").sections.isEmpty)
  }

  func testUsageLimitsNeedYouAndWordsAreRight() {
    let s = board()
    let i = index(s)
    XCTAssertEqual(i.asks.map(\.title.text), ["fix email join", "invoice rounding"])
    XCTAssertEqual(i.asks.map(\.trailing), [.ask("asks"), .ask("usage limit")])
    XCTAssertEqual(i.asks.map(\.action), [.agent(runId: "run-a", agentId: "a-w1"), .agent(runId: "run-b", agentId: "b-w1")])
    XCTAssertEqual(i.agents["run-a"]?.first?.trailing, .status("working"))
    XCTAssertEqual(i.agents["run-a"]?.first?.subtitle?.text, "migrate matchkey · planner")
    XCTAssertEqual(i.projects.first?.trailing, .ask("asks"))
  }

  /// A longer query only looks at the shorter one's matches, and gets the same results as a full search.
  func testNarrowingGivesTheSameResults() {
    let s = board()
    let i = index(s)
    let (_, m) = i.search("ma")
    XCTAssertEqual(i.search("mat", among: m).sections, i.search("mat").sections)
    XCTAssertEqual(i.search("ma s", among: m).sections, i.search("ma s").sections)
  }

  // MARK: the empty search

  func testEmptySearchShowsAsksRecentAndCommonCommands() {
    let s = board()
    let menu = s.projectMenu(projectId: s.decks()[0].id, runId: "run-a")
    let i = index(s, menu: menu, focusedAsk: "apr-1")
    let r = i.empty(recent: ["agent.a-ld", "agent.a-w1", "agent.a-pl"], exclude: ["agent.a-pl"])
    XCTAssertEqual(r.map(\.group), [.needsYou, .recent, .commands])
    XCTAssertEqual(r[0].hits.map(\.item.title.text), ["fix email join", "invoice rounding"])
    // Recent: newest first, without what needs you or what's excluded (the focused agent), topped up with projects.
    XCTAssertEqual(r[1].hits.map(\.item.title.text), ["ids/v1 split", "migrate matchkey", "fix proration"])
    XCTAssertEqual(r[2].hits.map(\.item.title.text), ["New project", "Approve the focused ask", "Message the planner of migrate matchkey…",
                                                      "Home", "Settings"])   // no run.controls: no Pause
  }

  // MARK: commands

  func testCommandsAreOnlyRealActionsWithShortcuts() {
    let menu = ProjectMenu(projectId: "p", runId: "r", goal: "g", repos: [], agents: 2, plannerId: "pl",
                           sections: [[.messagePlanner, .changes(added: 73, removed: 5, files: 3, url: URL(string: "https://x")!)], [.pause, .stop],
                                      [.fold, .copyRunId(short: "run-1")]], control: .idle)
    let c = SearchCommands.make(SearchCommandContext(menu: menu, projectTitle: "migrate matchkey", focusedAsk: nil, follow: false, homeShown: false))
    XCTAssertEqual(c.map(\.title.text), ["New project", "Message the planner of migrate matchkey…", "Changes in migrate matchkey", "Pause migrate matchkey",
                                         "Stop migrate matchkey…", "Fold migrate matchkey into the title bar", "Copy the run ID of migrate matchkey",
                                         "Home", "Turn Follow on", "Settings"])
    XCTAssertEqual(c.first { $0.id == "command.stop" }?.destructive, true)
    XCTAssertEqual(c.filter(\.destructive).count, 1)
    XCTAssertEqual(c.first { $0.id == "command.pause" }?.trailing, .shortcut("⌥⌘P"))
    XCTAssertEqual(c.first { $0.id == "command.changes" }?.trailing, .changes(added: 73, removed: 5, files: 3))
    XCTAssertEqual(c.first { $0.id == "command.follow" }?.action, .follow(true))
    // Home shows: no project's commands, and Home isn't offered as a common one.
    let home = SearchCommands.make(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: true))
    XCTAssertEqual(home.filter(\.common).map(\.title.text), ["New project", "Settings"])
  }

  // MARK: speed

  /// 300+ items (agents, projects, asks, commands): a keystroke's query stays well under a frame, and a narrowed one
  /// costs less again. Debug builds are several times slower than release; the bound is for debug.
  func testAKeystrokeIsFastWithHundredsOfItems() {
    var i = SearchIndex()
    let words = ["matchkey", "proration", "invoice", "shards", "backfill", "login", "redirect", "billing", "nightly", "bumps", "parser", "schema"]
    var runs: [String] = []
    for p in 0..<12 {
      let run = "run-\(p)"; runs.append(run)
      let project = "\(words[p % words.count]) \(words[(p + 5) % words.count])"
      i.set(agents: (0..<25).map { a in
        SearchItem(id: "agent.\(run)-\(a)", group: .agents, title: "\(words[(a + p) % words.count]) \(words[(a * 7) % words.count]) \(a)",
                   subtitle: "\(project) · worker", icon: .bot(runId: run, agentId: "\(a)"), action: .agent(runId: run, agentId: "\(a)"), agentId: "\(run)-\(a)")
      }, run: run)
    }
    i.set(runs: runs)
    i.set(projects: (0..<12).map { SearchItem(id: "project.\($0)", group: .projects, title: "project \(words[$0])", icon: .place(sandbox: "docker"), action: .project(runId: "run-\($0)")) })
    i.set(commands: SearchCommands.make(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: false)))
    XCTAssertGreaterThanOrEqual(i.count, 300)
    let typed = "match inv"
    var prefix = "", matched: Set<String>?
    var worst = 0.0, total = 0.0
    for c in typed {
      prefix.append(c)
      let t = ProcessInfo.processInfo.systemUptime
      let r = i.search(prefix, among: matched)
      let ms = (ProcessInfo.processInfo.systemUptime - t) * 1000
      matched = r.matched; worst = max(worst, ms); total += ms
    }
    let t = ProcessInfo.processInfo.systemUptime
    _ = i.search("m")
    let first = (ProcessInfo.processInfo.systemUptime - t) * 1000
    print("search: \(i.count) items; first keystroke \(String(format: "%.3f", first)) ms; worst of \(typed.count) keystrokes \(String(format: "%.3f", worst)) ms, mean \(String(format: "%.3f", total / Double(typed.count))) ms")
    XCTAssertLessThan(worst, 8)
  }
}
