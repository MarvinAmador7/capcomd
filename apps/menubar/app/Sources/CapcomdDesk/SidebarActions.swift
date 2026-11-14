#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

// What the rail, the sidebar and the pane do (design/desktop/rex; SPEC §2 "Navigation", §4).

extension DeskModel {
  // MARK: folded / opened

  /// ⌃⌘S, ⌘\, the sidebar button, View › Show Sidebar. The window lays out once, at rest: opening puts the sidebar and
  /// the pane over the reel, which keeps its size (it is never reflowed by a toggle). Animated only when the caller
  /// wraps it (a click); from the keyboard it just happens.
  package func toggleSidebar() {
    if nav.expanded { return collapsePane() }   // expanded, the sidebar is hidden: ⌃⌘S brings it back
    setSidebar(open: !nav.sidebarOpen)
  }

  package func setSidebar(open: Bool) {
    guard nav.sidebarOpen != open else { return }
    if !open { collapsePane() }
    if open {
      refreshSidebar(all: true)
      // The pane shows the open project's focused agent; with none yet, the one that asks, else its planner.
      if focusedAgent == nil, openRunId != nil, let first = sidebarDefaultAgent() { focusedAgent = first }
      nav.cursor = selectedAgent.map { .agent($0) }
    }
    if open, !nav.everOpened { nav.everOpened = true }
    if !open { sidebar.pointer(inside: false) }   // hidden, it gets no hover: nothing waits on the pointer
    nav.sidebarOpen = open
    if open { placeFocusInPanes(); nav.focusList() }
    else {
      // The reel stood still under the pane: it comes to the pane's agent now (not animated), and warms again.
      if let f = focusedAgent { scroll(to: f, animated: false) }
      resumeWarming()
    }
  }

  /// The agent the opened pane shows: the open project's focused agent, else its first column. Nil on Home, or with
  /// nothing open.
  package var paneAgent: String? {
    guard openRunId != nil else { return nil }
    if nav.sidebarOpen, let p = panes.focusedAgent { return p }
    if let f = focusedAgent, agent(f) != nil { return f }
    return columns.first
  }
  /// The agents the panes show (the sidebar marks the ones beside the selected: RexSplit `.row.vis`).
  package var paneAgents: Set<String> { newProject == nil && nav.sidebarOpen && panes.count > 1 ? Set(panes.agents) : [] }
  /// The sidebar's selected row (its pill): the pane's agent, except while Home shows.
  package var selectedAgent: String? { newProject == nil ? paneAgent : nil }

  private func sidebarDefaultAgent() -> String? {
    columns.first { agent($0)?.approval != nil } ?? columns.first
  }

  // MARK: the slice

  /// Rebuilds the sidebar's content from the runs `keys` name (all of them for `.all`), reusing every other run's rows.
  /// Nothing here reads a thread, so a thread item (which also names its run) recomputes that run's rows, finds them
  /// equal and assigns nothing.
  func refreshSidebar(_ keys: Set<ChangeKey>) {
    if keys.contains(.all) { refreshSidebar(all: true); return }
    var runs: Set<String> = []
    for k in keys { if case .run(let r) = k { runs.insert(r) } }
    guard !runs.isEmpty else { return }
    refreshSidebar(runs: runs)
  }

  func refreshSidebar(all: Bool = false, runs: Set<String> = []) {
    if all { sidebar.needIds = Set(store.needsAsks().map(\.agentId)) }
    let want = Set(decks.map(\.runId))
    sidebarRowsByRun = sidebarRowsByRun.filter { want.contains($0.key) }
    let content = sidebarContent { d in
      if !all, !runs.contains(d.runId), let cached = sidebarRowsByRun[d.runId] { return cached }
      let rows = sidebarRows(d)
      sidebarRowsByRun[d.runId] = rows
      return rows
    }
    sidebar.set(content)
  }

  // MARK: lines and the keyboard

  /// The sidebar as drawn now (folding included): what the view lays out and what ↑ ↓ walk through.
  package var sidebarLines: SidebarLines {
    let selected = selectedAgent.flatMap { id in sidebar.content.allRows.first { $0.id == id }?.projectId }
    return SidebarLines.make(sidebar.content, height: nav.listHeight, selectedProject: selected, finishedOpen: nav.finishedOpen,
                             unfolded: nav.unfolded, foldedByHand: nav.foldedByHand)
  }

  /// ↑ ↓: the cursor moves through the rows (and folded projects, Finished); it stops at either end.
  package func moveSidebarCursor(_ by: Int) {
    let keys = sidebarLines.keys
    guard !keys.isEmpty else { return }
    let at = nav.cursor.flatMap { keys.firstIndex(of: $0) } ?? selectedAgent.flatMap { keys.firstIndex(of: .agent($0)) }
    let next = at.map { min(max(0, $0 + by), keys.count - 1) } ?? (by > 0 ? 0 : keys.count - 1)
    if nav.cursor != keys[next] { nav.cursor = keys[next] }
  }

  /// Return: shows the cursor's agent; on a folded project or Finished, unfolds it.
  package func sidebarReturn() {
    switch nav.cursor {
    case .agent(let id)?: if let r = sidebar.content.allRows.first(where: { $0.id == id }) { selectRow(r) }
    case .project(let sec, let p)?: unfold(p, in: sec)
    case .finished?: nav.finishedOpen.toggle()
    case nil: moveSidebarCursor(1)
    }
  }

  /// → unfolds, ← folds: Finished, or the cursor's project.
  package func sidebarUnfold(_ open: Bool) {
    switch nav.cursor {
    case .finished?: if nav.finishedOpen != open { nav.finishedOpen = open }
    case .project(let sec, let p)?: if open { unfold(p, in: sec) }
    case .agent(let id)?:
      guard !open, let r = sidebar.content.allRows.first(where: { $0.id == id }),
            !sidebar.content.needs.contains(where: { $0.projectId == r.projectId && $0.rows.contains { $0.id == id } }) else { return }
      setProjectFolded(r.projectId, true)
      nav.cursor = sidebarLines.keys.first { if case .project(_, r.projectId) = $0 { return true }; return false }
    case nil: break
    }
  }

  /// Unfolds a project from the keyboard: the cursor goes to its first agent, so ↓ carries on from there.
  private func unfold(_ projectId: String, in section: SidebarSection) {
    setProjectFolded(projectId, false)
    if let first = sidebar.content.groups(section).first(where: { $0.projectId == projectId })?.rows.first { nav.cursor = .agent(first.id) }
  }

  package func setProjectFolded(_ projectId: String, _ folded: Bool) {
    if folded { nav.unfolded.remove(projectId); nav.foldedByHand.insert(projectId) }
    else { nav.foldedByHand.remove(projectId); nav.unfolded.insert(projectId) }
  }

  package func toggleFinished() { nav.finishedOpen.toggle() }

  // MARK: rows

  /// A click on a row (or Return on it): that agent in the pane. Another project opens first (the reel follows
  /// underneath, so folding shows the same agent); nothing animates.
  package func selectRow(_ row: SidebarRow) {
    if needs.isOpen { needs.close(restore: false) }   // a row opens just that agent
    if row.projectId != openProjectId || newProject != nil { open(project: row.projectId) }
    // Opened, the reel under the pane stays where it is (moving it would build the threads of columns no one sees);
    // folding brings it to this agent. Folded (⌘J), it scrolls as a tab click does.
    if nav.sidebarOpen { if focusedAgent != row.id { focusedAgent = row.id } } else { scroll(to: row.id, animated: false) }
    nav.cursor = .agent(row.id)
  }
  package func selectRow(id: String) {
    if let r = sidebar.content.allRows.first(where: { $0.id == id }) { selectRow(r) }
  }

  /// The ••• menu's items for an agent: only what the daemon does for one agent (RexStates "The ••• menu"): message
  /// it, pause or resume it (capability agent.pause), copy its ID. Changes and Trace need views the desktop doesn't have
  /// yet; an agent can't be stopped on its own (the daemon refuses it), so there is no Stop.
  package func agentMenu(_ row: SidebarRow) -> [AgentMenuItem] {
    var items: [AgentMenuItem] = []
    if store.runs[row.runId]?.isActive == true { items.append(.message(row.title)) }
    if store.capabilities.contains(Capability.agentPause), let st = store.runs[row.runId]?.agents[row.id]?.status, !st.isTerminal {
      items.append(st == .paused ? .resume : .pause)
    }
    items.append(.copyId(String(row.id.suffix(4))))
    return items
  }

  package func perform(_ item: AgentMenuItem, on row: SidebarRow) {
    switch item {
    case .message:
      selectRow(row)
      focusBox(row.id)
    case .pause: Task { await store.controlAgent(runId: row.runId, agentId: row.id, .pause) }
    case .resume: Task { await store.controlAgent(runId: row.runId, agentId: row.id, .resume) }
    case .copyId: copyText(row.id)
    }
  }

  /// A double-click on a row: it shows, and its title opens for renaming in the pane's header.
  package func renameRow(_ row: SidebarRow) {
    selectRow(row)
    if store.capabilities.contains(Capability.agentsTitle) { beginRename(row.id, at: .header) }
  }
}

package enum AgentMenuItem: Hashable, Sendable {
  case message(String), pause, resume, copyId(String)
  package var title: String {
    switch self {
    case .message(let t): "Message \(t)…"
    case .pause: "Pause"
    case .resume: "Resume"
    case .copyId: "Copy Agent ID"
    }
  }
}
#endif
