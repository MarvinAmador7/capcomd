import XCTest
@testable import CapcomdStore
import DeskBenchKit
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// The folding rail and the Rex-style sidebar (design/desktop/rex): sections by attention, keyed updates, the pane's
/// agent, folding idle projects, the keyboard, and the toggle remembered across launches.
final class SidebarModelTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  @MainActor func model(_ fixture: String = "crew17", defaults: UserDefaults? = nil) -> (DeskModel, CapcomdStore, World) {
    let w = Fixtures.make(fixture)!
    let s = CapcomdStore()
    w.load(into: s)
    return (DeskModel(store: s, defaults: defaults), s, w)
  }

  /// Agents that ask step out of their tree into Needs you; the rest stay under their project in Running.
  @MainActor func testSectionsByAttention() {
    let (m, s, w) = model()
    let c = m.sidebar.content
    // The Needs you reel's asks: a merge waits on the agent merging it (the lead), whose row steps out.
    let asking = Set(s.needsAsks().map(\.agentId))
    XCTAssertEqual(m.needs.count, asking.count)
    XCTAssertFalse(asking.isEmpty)
    XCTAssertEqual(Set(c.needs.flatMap(\.rows).map(\.id)), asking)
    XCTAssertEqual(m.sidebar.needsCount, asking.count)
    XCTAssertTrue(c.needs.flatMap(\.rows).allSatisfy { $0.tone == .ask && $0.word == "asks" && $0.level == 0 })
    // Every agent once, in Needs you or Running; every project of the title bar in Running.
    let all = c.allRows.map(\.id)
    XCTAssertEqual(all.count, Set(all).count)
    XCTAssertEqual(Set(all), Set(w.agents.values.flatMap { $0 }))
    XCTAssertEqual(c.running.map(\.projectId), m.decks.map(\.id))
    XCTAssertTrue(c.finished.isEmpty)
    // Tree order and indent kept under the project; the planner first, at level 0.
    let open = c.running.first { $0.runId == w.openRunId }!
    XCTAssertEqual(open.rows.first?.level, 0)
    XCTAssertEqual(open.rows.map(\.id), s.reelColumns(runId: w.openRunId!).map(\.agentId).filter { !asking.contains($0) })
    XCTAssertTrue(open.rows.allSatisfy { $0.level <= 2 })
  }

  /// SPEC §1: a thread item arriving changes nothing in the sidebar (it recomputes its run, finds it equal, assigns nothing).
  @MainActor func testAThreadItemDoesNotTouchTheSidebar() {
    var (m, s, w) = model()
    m.setSidebar(open: true)
    let before = m.sidebar.assignments, content = m.sidebar.content
    let target = w.agents[w.openRunId!]![2]
    for n in 0..<10 {
      let item = Fixtures.liveItem(world: &w, agentId: target, text: "item \(n)")
      let f = Fixtures.liveFrame(runId: w.openRunId!, item: item)
      s.receive(.event(f.envelope), scope: f.scope)
    }
    XCTAssertGreaterThan(s.threadEntries(agentId: target).count, 0)
    XCTAssertEqual(m.sidebar.assignments, before)
    XCTAssertEqual(m.sidebar.content, content)
  }

  /// An ask arriving moves its agent into Needs you (one assignment), and the hand's count follows.
  @MainActor func testAnAskMovesTheAgentIntoNeedsYou() {
    let (m, s, w) = model()
    let run = w.openRunId!
    let n = m.sidebar.needsCount
    let f = Fixtures.askFrame(runId: run, agentId: w.agents[run]![2], approvalId: "apr-new", seq: 900_000)
    s.receive(.event(f.envelope), scope: f.scope)
    let agent = s.waitingAgent(s.pendingApprovals.first { $0.id == "apr-new" }!)!
    XCTAssertEqual(m.sidebar.needsCount, n + 1)
    XCTAssertTrue(m.sidebar.content.needs.flatMap(\.rows).contains { $0.id == agent })
    XCTAssertFalse(m.sidebar.content.running.flatMap(\.rows).contains { $0.id == agent })
  }

  /// While the pointer is over the sidebar a row never moves under it: the change waits until the pointer leaves. The
  /// hand's count doesn't wait.
  @MainActor func testMovesWaitForThePointerToLeave() {
    let (m, s, w) = model()
    let run = w.openRunId!
    m.sidebar.pointer(inside: true)
    let n = m.sidebar.needsCount
    let f = Fixtures.askFrame(runId: run, agentId: w.agents[run]![3], approvalId: "apr-held", seq: 900_001)
    s.receive(.event(f.envelope), scope: f.scope)
    let agent = s.waitingAgent(s.pendingApprovals.first { $0.id == "apr-held" }!)!
    XCTAssertEqual(m.sidebar.needsCount, n + 1)
    XCTAssertFalse(m.sidebar.content.needs.flatMap(\.rows).contains { $0.id == agent })
    m.sidebar.pointer(inside: false)
    XCTAssertTrue(m.sidebar.content.needs.flatMap(\.rows).contains { $0.id == agent })
  }

  /// Only a row that moves waits for the pointer: the first fill, new rows and changed words go in at once.
  @MainActor func testNewRowsDontWaitForThePointer() {
    let empty = SidebarContent()
    let (m, _, _) = model()
    let full = m.sidebar.content
    XCTAssertFalse(SidebarSlice.moves(empty, full))
    var worded = full
    worded.running[0].rows[0].word = "paused"
    XCTAssertFalse(SidebarSlice.moves(full, worded))
    var moved = full
    let r = moved.running[0].rows.removeLast()
    moved.needs.append(SidebarGroup(projectId: r.projectId, runId: r.runId, title: "x", sandbox: nil, rows: [r]))
    XCTAssertTrue(SidebarSlice.moves(full, moved))
  }

  /// A row of another project opens that project with the agent in the pane; nothing animates (the reel follows).
  @MainActor func testSelectingARowOpensItsProjectAndShowsTheAgent() {
    let (m, _, w) = model()
    m.setSidebar(open: true)
    let other = m.sidebar.content.running.first { $0.runId != m.openRunId }!
    let row = other.rows.last!
    m.selectRow(row)
    XCTAssertEqual(m.openProjectId, other.projectId)
    XCTAssertEqual(m.paneAgent, row.id)
    XCTAssertEqual(m.selectedAgent, row.id)
    XCTAssertEqual(m.reelRequest?.animated, false)
    XCTAssertNotEqual(w.openRunId, m.openRunId)
  }

  /// Opened, a row of the open project shows in the pane without moving the reel kept underneath; folding brings the
  /// reel to it.
  @MainActor func testTheReelStaysStillUnderThePane() {
    let (m, _, _) = model()
    m.across = 3
    m.setSidebar(open: true)
    let request = m.reelRequest
    let far = m.columns.last!
    m.selectRow(id: far)
    XCTAssertEqual(m.paneAgent, far)
    XCTAssertEqual(m.reelRequest, request)
    XCTAssertFalse(m.onScreen.contains(far))
    m.setSidebar(open: false)
    XCTAssertTrue(m.onScreen.contains(far))
    XCTAssertEqual(m.reelRequest?.animated, false)
  }

  /// ↑ ↓ move the cursor through the rows; Return shows the cursor's agent.
  @MainActor func testKeyboardCursor() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    let keys = m.sidebarLines.keys
    m.nav.cursor = keys[0]
    m.moveSidebarCursor(1); m.moveSidebarCursor(1)
    XCTAssertEqual(m.nav.cursor, keys[2])
    m.moveSidebarCursor(-10)
    XCTAssertEqual(m.nav.cursor, keys[0])
    m.moveSidebarCursor(2)
    m.sidebarReturn()
    guard case .agent(let id) = keys[2] else { return XCTFail("the third line isn't an agent") }
    XCTAssertEqual(m.paneAgent, id)
  }

  /// Once the list outgrows the window, projects you aren't looking at fold to one line; the selected one never does,
  /// and one unfolded by hand stays open. → / Return on a folded project unfolds it.
  @MainActor func testIdleProjectsFoldOnceTheListOutgrowsTheWindow() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    m.nav.listHeight = 10_000
    XCTAssertFalse(m.sidebarLines.overflow)
    m.nav.listHeight = 300
    let lines = m.sidebarLines
    XCTAssertTrue(lines.overflow)
    let selected = m.sidebar.content.allRows.first { $0.id == m.selectedAgent }!.projectId
    var foldedProjects: [String] = []
    for l in lines.list { if case .label(let g, .running, let folded) = l { if folded { foldedProjects.append(g.projectId) } else { XCTAssertEqual(g.projectId, selected) } } }
    XCTAssertEqual(foldedProjects.count, m.decks.count - 1)
    m.nav.cursor = .project(.running, foldedProjects[0])
    m.sidebarUnfold(true)
    let first = m.sidebar.content.running.first { $0.projectId == foldedProjects[0] }!.rows[0].id
    XCTAssertEqual(m.nav.cursor, .agent(first))   // ↓ carries on inside the project just unfolded
    XCTAssertTrue(m.sidebarLines.list.contains { if case .label(let g, _, false) = $0 { return g.projectId == foldedProjects[0] }; return false })
  }

  /// The hand and the Needs you heading open the Needs you reel, in the pane's place while the sidebar is open; a row
  /// then opens just that agent (the reel closes). Needs you lists the reel's asks.
  @MainActor func testNeedsYouIsTheReelsAsks() {
    let (m, s, _) = model("swarm64")
    m.setSidebar(open: true)
    let rows = Set(m.sidebar.content.needs.flatMap(\.rows).map(\.id))
    XCTAssertEqual(rows, Set(s.needsAsks().map(\.agentId)))
    XCTAssertEqual(m.needs.count, rows.count)
    m.openNeedsReel()
    XCTAssertTrue(m.needs.isOpen)
    let row = m.sidebar.content.running[0].rows.last!
    m.selectRow(row)
    XCTAssertFalse(m.needs.isOpen)
    XCTAssertEqual(m.paneAgent, row.id)
  }

  /// Follow never moves the opened pane: the ask shows in Needs you instead.
  @MainActor func testFollowLeavesTheOpenedPaneAlone() {
    let (m, s, w) = model()
    m.setSidebar(open: true)
    let pane = m.paneAgent
    let run = w.openRunId!
    let agent = w.agents[run]!.last { $0 != pane }!
    let f = Fixtures.askFrame(runId: run, agentId: agent, approvalId: "apr-follow", seq: 900_002)
    s.receive(.event(f.envelope), scope: f.scope)
    XCTAssertEqual(m.paneAgent, pane)
    m.setSidebar(open: false)
    let g = Fixtures.askFrame(runId: run, agentId: w.agents[run]![2], approvalId: "apr-follow-2", seq: 900_003)
    s.receive(.event(g.envelope), scope: g.scope)
    let waiting = s.waitingAgent(s.pendingApprovals.first { $0.id == "apr-follow-2" }!)
    XCTAssertEqual(m.focusedAgent, waiting)   // folded, Follow works as before
  }

  /// Folded or opened is remembered across launches.
  @MainActor func testTheToggleIsRemembered() {
    let d = UserDefaults(suiteName: "sidebar-tests-\(UUID().uuidString)")!
    let (m, _, _) = model(defaults: d)
    XCTAssertFalse(m.nav.sidebarOpen)
    m.toggleSidebar()
    XCTAssertTrue(d.bool(forKey: DeskNav.key))
    let (again, _, _) = model(defaults: d)
    XCTAssertTrue(again.nav.sidebarOpen)
    again.toggleSidebar()
    XCTAssertFalse(d.bool(forKey: DeskNav.key))
  }

  /// A finished run's project goes under Finished, its agents grey; a failure there doesn't need you.
  @MainActor func testFinishedProjects() {
    let s = CapcomdStore()
    var seq = 0
    func ev(_ type: String, _ agent: String?, _ d: [String: JSONValue] = [:]) {
      seq += 1
      s.receive(.event(Envelope(id: "e\(seq)", scope: "run-a", seq: seq, entity: agent ?? "run-a", type: type, epochMs: 1_000 + seq, projectId: "prj-a",
                                runId: "run-a", agentId: agent, data: d)), scope: "run-a")
    }
    ev("run.created", nil, ["goal": .string("Export usage")])
    ev("agent.spawned", "pl", ["profile": .string("planner")])
    ev("agent.spawned", "w1", ["profile": .string("worker"), "parent": .string("pl")])
    ev("agent.spawned", "w2", ["profile": .string("worker"), "parent": .string("pl")])
    ev("agent.started", "pl"); ev("agent.started", "w1"); ev("agent.started", "w2")
    let m = DeskModel(store: s)
    XCTAssertEqual(m.sidebar.content.running.count, 1)
    ev("agent.failed", "w2")
    // A failure has no decision to make: it keeps its place in the tree, with its red word.
    XCTAssertTrue(m.sidebar.content.needs.isEmpty)
    XCTAssertEqual(m.sidebar.content.running.first?.rows.first { $0.id == "w2" }?.tone, .error)
    ev("agent.done", "w1"); ev("agent.done", "pl")
    ev("run.completed", nil)
    let c = m.sidebar.content
    XCTAssertTrue(c.needs.isEmpty)
    XCTAssertTrue(c.running.isEmpty)
    XCTAssertEqual(c.finished.first?.rows.map(\.word), ["done", "done", "failed"])
    m.closeNewProject()
    if m.selectedAgent != nil {
      // Its selected agent never hides: Finished shows while it holds the selection.
      XCTAssertTrue(m.sidebarLines.list.contains { if case .row = $0 { return true }; return false })
      m.openHome(focus: false)
    }
    XCTAssertFalse(m.sidebarLines.list.contains { if case .row = $0 { return true }; return false })   // Finished starts folded
    m.toggleFinished()
    XCTAssertEqual(m.sidebarLines.list.filter { if case .row = $0 { return true }; return false }.count, 3)
  }

  /// The ••• menu holds only what the daemon does for one agent: no Stop (the daemon refuses it), Pause only with
  /// agent.pause.
  @MainActor func testAgentMenuHasOnlyRealActions() {
    let (m, s, _) = model()
    let row = m.sidebar.content.running[0].rows[0]
    XCTAssertEqual(m.agentMenu(row).map(\.title), ["Message \(row.title)…", "Copy Agent ID"])
    s.capabilities.insert(Capability.agentPause)
    XCTAssertEqual(m.agentMenu(row).map(\.title), ["Message \(row.title)…", "Pause", "Copy Agent ID"])
  }
  #endif
}
