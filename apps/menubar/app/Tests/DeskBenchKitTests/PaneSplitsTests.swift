import XCTest
@testable import CapcomdStore
import DeskBenchKit
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// Splits and expand in the opened window (design/desktop/rex RexSplit, RexExpanded; SPEC §2.1): the layout, which agent
/// a split opens, focus, closing, keeping splits per project, expanding and coming back to the same panes.
final class PaneSplitsTests: XCTestCase {
  /// Columns left to right, a column's panes top to bottom; the focus moves to the new pane and back to a neighbour.
  func testLayout() {
    var p = PaneLayout(PaneSlot(id: 1, agent: "a"))
    p.splitRight(PaneSlot(id: 2, agent: "b"))
    XCTAssertEqual(p.columns.map { $0.map(\.id) }, [[1], [2]])
    XCTAssertEqual(p.focused, 2)
    p.splitDown(PaneSlot(id: 3, agent: "c"))
    XCTAssertEqual(p.columns.map { $0.map(\.id) }, [[1], [2, 3]])
    p.focused = 1
    p.splitRight(PaneSlot(id: 4, agent: "d"))   // right of the focused pane's column, not at the end
    XCTAssertEqual(p.columns.map { $0.map(\.id) }, [[1], [4], [2, 3]])
    // Showing an agent another pane has focuses that pane; else it replaces the focused pane's agent.
    XCTAssertTrue(p.show("c")); XCTAssertEqual(p.focused, 3)
    XCTAssertTrue(p.show("e")); XCTAssertEqual(p.focusedSlot, PaneSlot(id: 3, agent: "e"))
    XCTAssertFalse(p.show("e"))
    XCTAssertEqual(p.neighbour(-1)?.id, 2)
    XCTAssertEqual(p.neighbour(5)?.id, 3)
    p.close(3)
    XCTAssertEqual(p.columns.map { $0.map(\.id) }, [[1], [4], [2]])
    XCTAssertEqual(p.focused, 2)
    p.close(1)
    XCTAssertEqual(p.focused, 2)
    XCTAssertEqual(p.columns.map { $0.map(\.id) }, [[4], [2]])
    // Frames: equal columns 8 pt apart; equal rows in a column.
    var q = PaneLayout(PaneSlot(id: 1, agent: "a")); q.splitRight(PaneSlot(id: 2, agent: "b")); q.splitDown(PaneSlot(id: 3, agent: "c"))
    let f = q.frames(in: CGRect(x: 0, y: 8, width: 1184, height: 884), gap: 8)
    XCTAssertEqual(f[1], CGRect(x: 0, y: 8, width: 588, height: 884))
    XCTAssertEqual(f[2], CGRect(x: 596, y: 8, width: 588, height: 438))
    XCTAssertEqual(f[3], CGRect(x: 596, y: 454, width: 588, height: 438))
  }

  #if canImport(SwiftUI) && os(macOS)
  @MainActor func model() -> (DeskModel, CapcomdStore, World) {
    let w = Fixtures.make("crew17")!
    let s = CapcomdStore()
    w.load(into: s)
    return (DeskModel(store: s), s, w)
  }

  /// ⌘D opens the next agent in tree order beside the focused one, which takes the focus; at 1440 pt with the sidebar
  /// open a split gives two panes, three fit, a fourth doesn't.
  @MainActor func testSplitOpensTheNextAgentInTreeOrder() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    m.paneArea = CGSize(width: 1440 - 248, height: 900)
    let first = m.columns[0]
    m.selectRow(id: first)
    XCTAssertEqual(m.panes.agents, [first])
    m.split(down: false)
    XCTAssertEqual(m.panes.agents, [first, m.columns[1]])
    XCTAssertEqual(m.focusedAgent, m.columns[1])
    XCTAssertEqual(m.paneAgent, m.columns[1])
    XCTAssertEqual(m.paneAgents, Set([first, m.columns[1]]))
    m.split(down: false)
    XCTAssertEqual(m.panes.columns.count, 3)
    m.split(down: false)   // 4 × 290 pt is under the minimum: refused
    XCTAssertEqual(m.panes.columns.count, 3)
    m.split(down: true)    // under the focused one instead
    XCTAssertEqual(m.panes.count, 4)
    XCTAssertEqual(m.panes.columns[2].count, 2)
    // Folded, nothing splits.
    m.setSidebar(open: false)
    m.split(down: false)
    XCTAssertEqual(m.panes.count, 4)
  }

  /// A row (or ⌃1–9) shows its agent in the focused pane, or focuses the pane that has it; ⌘-click opens it beside.
  @MainActor func testRowsAndOpenInSplit() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    let c = m.columns
    m.selectRow(id: c[0])
    m.openInSplit(runId: m.openRunId!, agentId: c[4])
    XCTAssertEqual(m.panes.agents, [c[0], c[4]])
    m.selectRow(id: c[0])   // already in a pane: that pane takes the focus, nothing moves
    XCTAssertEqual(m.panes.agents, [c[0], c[4]])
    XCTAssertEqual(m.panes.focusedAgent, c[0])
    m.selectRow(id: c[2])   // not in a pane: it replaces the focused pane's agent
    XCTAssertEqual(m.panes.agents, [c[2], c[4]])
    m.openInSplit(runId: m.openRunId!, agentId: c[4])   // already shown: focus only
    XCTAssertEqual(m.panes.count, 2)
    XCTAssertEqual(m.focusedAgent, c[4])
    // ⌃← ⌃→ move between the panes.
    m.moveFocus(-1)
    XCTAssertEqual(m.focusedAgent, c[2])
    m.moveFocus(1)
    XCTAssertEqual(m.focusedAgent, c[4])
  }

  /// ⌘W closes the focused split (its neighbour takes the focus); with one pane left ⌘W folds the project as before.
  @MainActor func testCloseSplit() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    let c = m.columns
    m.selectRow(id: c[0])
    m.split(down: false)
    m.split(down: true)
    XCTAssertEqual(m.panes.count, 3)
    m.foldShortcut()
    XCTAssertEqual(m.panes.count, 2)
    XCTAssertEqual(m.focusedAgent, m.panes.focusedAgent)
    m.closePane(m.panes.slots[0].id)   // a pane's ×
    XCTAssertEqual(m.panes.count, 1)
    m.closePane(m.panes.slots[0].id)   // the last pane never closes
    XCTAssertEqual(m.panes.count, 1)
    let project = m.openProjectId
    m.foldShortcut()   // one pane: the approved ⌘W (fold the project)
    XCTAssertNotEqual(m.openProjectId, project)
  }

  /// Splits are kept per project: another project shows its own panes, and coming back shows these as they were.
  @MainActor func testSplitsAreKeptPerProject() {
    let (m, _, _) = model()
    m.setSidebar(open: true)
    let project = m.openProjectId!
    m.selectRow(id: m.columns[0])
    m.split(down: false)
    let kept = m.panes
    let other = m.decks.first { $0.id != project }!
    m.open(project: other.id)
    XCTAssertEqual(m.panes.count, 1)
    m.open(project: project)
    XCTAssertEqual(m.panes, kept)
    XCTAssertEqual(m.focusedAgent, kept.focusedAgent)
  }

  /// ⇧⌘↩ gives the focused pane the window and back, to exactly the panes it came from; switching agents while expanded
  /// stays expanded; Home, the Needs you reel and folding end it; ⌃⌘S brings the sidebar back.
  @MainActor func testExpandAndCollapse() {
    let (m, _, _) = model()
    m.toggleExpand()   // folded: nothing
    XCTAssertFalse(m.nav.expanded)
    m.setSidebar(open: true)
    let c = m.columns
    m.selectRow(id: c[0])
    m.split(down: false)
    let before = m.panes
    m.toggleExpand()
    XCTAssertTrue(m.nav.expanded)
    m.split(down: false)   // no splitting while expanded
    XCTAssertEqual(m.panes, before)
    m.selectRow(id: c[5])   // a ⌘K pick while expanded: still expanded, in the focused pane
    XCTAssertTrue(m.nav.expanded)
    XCTAssertEqual(m.panes.focusedAgent, c[5])
    m.selectRow(id: c[1])
    m.toggleExpand()
    XCTAssertFalse(m.nav.expanded)
    XCTAssertEqual(m.panes, before)
    // The expanded pane's ⌃⌘S shows the sidebar again (it doesn't fold it).
    m.expandPane()
    m.toggleSidebar()
    XCTAssertFalse(m.nav.expanded)
    XCTAssertTrue(m.nav.sidebarOpen)
    m.expandPane(); m.openNeedsReel()
    XCTAssertFalse(m.nav.expanded)
    m.closeNeedsReel()
    m.expandPane(); m.openHome(focus: false)
    XCTAssertFalse(m.nav.expanded)
    m.closeNewProject()
    m.expandPane(); m.setSidebar(open: false)
    XCTAssertFalse(m.nav.expanded)
  }

  /// The palette's commands follow the panes: split, close and expand only with a project's panes showing.
  @MainActor func testPaletteCommands() {
    func ids(_ c: SearchCommandContext) -> [String] { SearchCommands.make(c).map(\.id) }
    let folded = ids(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: false))
    XCTAssertFalse(folded.contains("command.split-right"))
    XCTAssertTrue(folded.contains("command.sidebar"))
    let one = ids(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: false, sidebarOpen: true, panes: 1))
    XCTAssertTrue(one.contains("command.split-right") && one.contains("command.split-down") && one.contains("command.expand"))
    XCTAssertFalse(one.contains("command.close-split"))
    let two = ids(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: false, sidebarOpen: true, panes: 2))
    XCTAssertTrue(two.contains("command.close-split"))
    let expanded = ids(SearchCommandContext(menu: nil, projectTitle: nil, focusedAsk: nil, follow: true, homeShown: false, sidebarOpen: true, panes: 2, expanded: true))
    XCTAssertEqual(expanded.filter { $0.contains("split") || $0.contains("expand") || $0.contains("collapse") }, ["command.collapse"])
  }
  #endif
}
