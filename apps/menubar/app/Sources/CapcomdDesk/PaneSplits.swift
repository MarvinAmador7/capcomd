#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

// Splits and expand for the opened window (design/desktop/rex: RexSplit, RexExpanded, RexStates "Splits", RexNotes
// "Expand a pane (owner)"; SPEC §2.1). The opened window shows one or more panes beside the sidebar: ⌘D splits right,
// ⇧⌘D splits down, ⌘W or a pane's × closes one; ⇧⌘↩ or a pane's arrows-out gives the focused pane the whole window, and
// Esc or arrows-in gives it back. Each pane is the reel's AppKit column in its pane style (NativeColumnView), so a split
// adds a column view and its thread, and expanding re-frames that view: nothing is rebuilt.

/// One pane: a stable id (its AppKit column keeps it while the agent it shows changes) and its agent.
package struct PaneSlot: Hashable, Sendable {
  package var id: Int
  package var agent: String
  package init(id: Int, agent: String) { self.id = id; self.agent = agent }
}

/// The opened window's panes for one run (RexSplit): columns left to right (⌘D adds one), each a stack top to bottom
/// (⇧⌘D adds one under the focused pane). The focused pane is the window's focus: it shows the focused agent, its
/// header has the split buttons, and it is the one that expands.
package struct PaneLayout: Equatable, Sendable {
  package var columns: [[PaneSlot]] = []
  /// The focused pane's id.
  package var focused = 0
  package init() {}
  package init(_ slot: PaneSlot) { columns = [[slot]]; focused = slot.id }

  package var slots: [PaneSlot] { columns.flatMap { $0 } }
  package var isEmpty: Bool { columns.isEmpty }
  package var count: Int { columns.reduce(0) { $0 + $1.count } }
  package var agents: [String] { slots.map(\.agent) }
  package var focusedSlot: PaneSlot? { slots.first { $0.id == focused } }
  package var focusedAgent: String? { focusedSlot?.agent }
  package func slot(showing agent: String) -> PaneSlot? { slots.first { $0.agent == agent } }

  func position(of id: Int) -> (column: Int, row: Int)? {
    for (c, col) in columns.enumerated() { if let r = col.firstIndex(where: { $0.id == id }) { return (c, r) } }
    return nil
  }

  /// The agent shows in the focused pane, or, when another pane already shows it, that pane takes the focus. Returns
  /// whether anything changed.
  @discardableResult
  package mutating func show(_ agent: String) -> Bool {
    if let s = slot(showing: agent) { guard focused != s.id else { return false }; focused = s.id; return true }
    guard let (c, r) = position(of: focused) else { return false }
    columns[c][r].agent = agent
    return true
  }

  /// A new pane right of the focused pane's column (⌘D), focused.
  package mutating func splitRight(_ new: PaneSlot) {
    let c = position(of: focused)?.column ?? columns.count - 1
    columns.insert([new], at: min(columns.count, c + 1))
    focused = new.id
  }

  /// A new pane under the focused pane, in its column (⇧⌘D), focused.
  package mutating func splitDown(_ new: PaneSlot) {
    guard let (c, r) = position(of: focused) else { columns.append([new]); focused = new.id; return }
    columns[c].insert(new, at: r + 1)
    focused = new.id
  }

  /// Closes a pane; the focus, if it was there, goes to the pane before it in reading order (else the one after).
  package mutating func close(_ id: Int) {
    let order = slots.map(\.id)
    guard let i = order.firstIndex(of: id), let (c, r) = position(of: id) else { return }
    columns[c].remove(at: r)
    if columns[c].isEmpty { columns.remove(at: c) }
    if focused == id {
      let rest = order.filter { $0 != id }
      focused = rest.isEmpty ? 0 : rest[max(0, min(i - 1, rest.count - 1))]
    }
  }

  /// The pane `by` steps from the focused one in reading order (columns left to right, each top to bottom), clamped.
  package func neighbour(_ by: Int) -> PaneSlot? {
    let s = slots
    guard let i = s.firstIndex(where: { $0.id == focused }) else { return s.first }
    return s[min(max(0, i + by), s.count - 1)]
  }

  /// Keeps only the panes whose agent `keep` accepts (a run's agents), and the focus on one of them.
  package mutating func prune(_ keep: (String) -> Bool) {
    for id in slots.filter({ !keep($0.agent) }).map(\.id) { close(id) }
  }

  /// Each pane's frame in `rect` (columns share the width, panes in a column share its height), `gap` apart.
  package func frames(in rect: CGRect, gap: CGFloat) -> [Int: CGRect] {
    var out: [Int: CGRect] = [:]
    guard !columns.isEmpty else { return out }
    let n = CGFloat(columns.count)
    let w = max(0, (rect.width - gap * (n - 1)) / n)
    for (c, col) in columns.enumerated() {
      let x = rect.minX + CGFloat(c) * (w + gap)
      let m = CGFloat(col.count)
      let h = max(0, (rect.height - gap * (m - 1)) / m)
      for (r, s) in col.enumerated() {
        out[s.id] = CGRect(x: x, y: rect.minY + CGFloat(r) * (h + gap), width: w, height: h).integral
      }
    }
    return out
  }
}

/// The panes' geometry (RexSplit `.main`: 8 pt from the window's top, right and bottom, 8 pt apart; the sidebar's own
/// 8 pt side is the gap on the left).
enum PaneMetrics {
  static let inset: CGFloat = 8, gap: CGFloat = 8
  /// A split refuses to make panes narrower or shorter than this: three across at 1440 pt with the sidebar open
  /// (389 pt each), two at 1100.
  static let minWidth: CGFloat = 340, minHeight: CGFloat = 220
  /// Expanded (RexExpanded): the 52 pt header (the title bar's band, clear of the traffic lights), the 800 pt reading
  /// column, diffs and logs 1060 pt, the ask bar at column width.
  static let expandedHeader: CGFloat = 52
  static let reading: CGFloat = 800, wide: CGFloat = 1060
  static let expandedBody = EdgeInsets(top: 12, leading: 32, bottom: 20, trailing: 32)
  /// A split pane's thread (RexSplit `.pbd` 4 px 18 px 16 px).
  static let splitBody = EdgeInsets(top: 4, leading: 18, bottom: 16, trailing: 18)
  static let dockFill = Color(red: 0x1D / 255, green: 0x1B / 255, blue: 0x17 / 255)
  static let dockRadius: CGFloat = 12
}

extension DeskModel {
  // MARK: which panes show

  /// The focused agent goes into the panes: its own pane takes the focus, or it shows in the focused pane (a row, ⌃1–9,
  /// ⌘J, a palette pick, a click). Only while the sidebar is open; opening it places the focus once.
  func placeFocusInPanes() {
    guard nav.sidebarOpen, openRunId != nil else { return }
    guard let f = focusedAgent ?? columns.first else { return }
    var p = panes
    if p.isEmpty { p = PaneLayout(newSlot(f)) } else { p.show(f) }
    if p != panes { panes = p }
  }

  func newSlot(_ agent: String) -> PaneSlot {
    nextPaneId += 1
    return PaneSlot(id: nextPaneId, agent: agent)
  }

  /// The project changes: its panes are put away by run and the new run's come back (splits are kept per project; a new
  /// run of it has new agents, so it starts with one pane).
  func swapPanes(from old: String?, to new: String?) {
    if let old, !panes.isEmpty { savedPanes[old] = panes }
    let next = new.flatMap { savedPanes[$0] } ?? PaneLayout()
    if panes != next { panes = next }
  }

  /// Panes whose agent the run no longer lists go (the first read of a run may come before its agents).
  func prunePanes() {
    guard !columns.isEmpty else { return }
    let known = Set(columns)
    var p = panes
    p.prune { known.contains($0) }
    if p.isEmpty, nav.sidebarOpen, let f = focusedAgent.flatMap({ known.contains($0) ? $0 : nil }) ?? columns.first { p = PaneLayout(newSlot(f)) }
    if p != panes { panes = p }
  }

  /// The panes show (the sidebar is open, a project is open, and neither Home nor the Needs you reel has their place).
  package var panesShown: Bool { nav.sidebarOpen && openRunId != nil && newProject == nil && !needs.isOpen && !panes.isEmpty }

  // MARK: splits (⌘D, ⇧⌘D, ⌘W, ⌘-click, ⌘↩ in the palette)

  /// The agent a split opens (RexStates: "A split opens the next agent in tree order"): the first after the focused one
  /// that no pane shows, round to the start.
  package func nextAgentForSplit() -> String? {
    let shown = Set(panes.agents)
    let start = panes.focusedAgent.flatMap { columns.firstIndex(of: $0) } ?? -1
    let n = columns.count
    guard n > 0 else { return nil }
    for k in 1...n { let id = columns[(start + k + n) % n]; if !shown.contains(id) { return id } }
    return nil
  }

  /// Whether one more column (right) or row (down, in the focused pane's column) still leaves every pane its minimum.
  package func roomToSplit(down: Bool) -> Bool {
    let area = paneArea
    guard area.width > 0, area.height > 0 else { return true }   // not laid out yet (tests): no limit
    if down {
      let rows = CGFloat((panes.position(of: panes.focused).map { panes.columns[$0.column].count } ?? 1) + 1)
      return (area.height - 2 * PaneMetrics.inset - PaneMetrics.gap * (rows - 1)) / rows >= PaneMetrics.minHeight
    }
    let cols = CGFloat(panes.columns.count + 1)
    return (area.width - PaneMetrics.inset - PaneMetrics.gap * (cols - 1)) / cols >= PaneMetrics.minWidth
  }

  /// ⌘D (right) or ⇧⌘D (down): the next agent in tree order in a new pane beside (under) the focused one, which it
  /// takes the focus from. Opened only, with a project's panes showing and not expanded; no room or no agent left:
  /// the system beep.
  package func split(down: Bool, agent: String? = nil) {
    guard panesShown, !nav.expanded else { return }
    guard let a = agent ?? nextAgentForSplit(), roomToSplit(down: down) else { return beep() }
    var p = panes
    if down { p.splitDown(newSlot(a)) } else { p.splitRight(newSlot(a)) }
    panes = p
    if focusedAgent != a { focusedAgent = a }
  }

  /// ⌘-click on a row, ⌘↩ in the palette: the agent beside the focused pane (another project's opens that project
  /// first). Already in a pane: that pane takes the focus. No room right: under it; no room at all: the beep.
  package func openInSplit(runId: String, agentId: String) {
    if !nav.sidebarOpen { return show(run: runId, agent: agentId) }
    if needs.isOpen { needs.close(restore: false) }
    if runId != openRunId || newProject != nil {
      show(run: runId, agent: agentId)
      return
    }
    if nav.expanded || panes.slot(showing: agentId) != nil || panes.isEmpty { focusedAgent = agentId; placeFocusInPanes(); return }
    if roomToSplit(down: false) { split(down: false, agent: agentId) }
    else if roomToSplit(down: true) { split(down: true, agent: agentId) }
    else { beep() }
  }

  /// A pane's ×, or ⌘W on a split: the pane goes; the focus moves to its neighbour. The last pane never closes here
  /// (⌘W then folds the project, as approved).
  package func closePane(_ id: Int) {
    guard panes.count > 1 else { return }
    var p = panes
    let wasExpanded = nav.expanded && p.focused == id
    p.close(id)
    panes = p
    if wasExpanded { nav.expanded = false }
    if let f = p.focusedAgent, focusedAgent != f { focusedAgent = f }
  }

  /// A click in a pane, its expand button: that pane takes the focus.
  package func focusPane(_ id: Int) {
    guard let s = panes.slots.first(where: { $0.id == id }) else { return }
    if panes.focused != id { var p = panes; p.focused = id; panes = p }
    if focusedAgent != s.agent { focusedAgent = s.agent }
  }

  /// ⌃← ⌃→ with splits: the neighbouring pane takes the focus. Returns false when there is one pane (the keys then move
  /// through the agents, as before).
  func movePaneFocus(_ by: Int) -> Bool {
    guard panesShown, !nav.expanded, panes.count > 1, let s = panes.neighbour(by) else { return false }
    focusPane(s.id)
    return true
  }

  // MARK: expand (⇧⌘↩, arrows-out; Esc, arrows-in)

  /// The focused pane takes the window (the sidebar hides) or gives it back, to exactly the panes it came from. Opened
  /// only, with a project's panes showing.
  package func toggleExpand() { if nav.expanded { collapsePane() } else { expandPane() } }

  package func expandPane(_ id: Int? = nil) {
    guard panesShown else { return }
    if let id { focusPane(id) }
    if !nav.expanded { nav.expanded = true }
  }

  package func collapsePane() { if nav.expanded { nav.expanded = false } }

  func beep() { if session != nil { NSSound.beep() } }
}

extension EnvironmentValues {
  /// The pane a column view is in (its focus, whether it is one of several, whether it is expanded); nil in the reel.
  @Entry var paneState: PaneState? = nil
}

/// One pane's own state, set by the pane area (PaneDeckView) and read by its head, body and stroke: a focus change
/// re-renders the two panes whose focus changed; expanding re-renders the expanded pane only.
@Observable @MainActor
final class PaneState {
  /// The pane the view shows now (a closed pane's view is kept for the next split).
  private(set) var id: Int
  private(set) var focused = false
  /// One of several panes (split).
  private(set) var split = false
  private(set) var expanded = false
  init(id: Int) { self.id = id }
  func set(id i: Int, focused f: Bool, split s: Bool, expanded e: Bool) {
    if id != i { id = i }
    if focused != f { focused = f }
    if split != s { split = s }
    if expanded != e { expanded = e }
  }
}
#endif
