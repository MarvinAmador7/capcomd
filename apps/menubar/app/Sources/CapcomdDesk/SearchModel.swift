#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import PerfLoopProbe

// Search ⌘K (design/desktop/rex/CommandK.dc.html; SPEC §2, §6): the palette's state and what it does. The index is the
// store's `SearchIndex`; it is rebuilt per source from the store's keyed changes, and only the sources a change names:
// while the palette is closed a change only marks what's stale, and opening it rebuilds that (a few hundred titles, no
// threads). A keystroke matches the folded titles; a longer query only looks at the shorter one's matches.

/// One line of the list: a group's header, or a result with its place in the selection order.
package struct SearchRow: Identifiable, Equatable {
  package var id: String
  package var header: SearchGroup?
  package var hit: SearchHit?
  package var index: Int
}

@Observable @MainActor
package final class SearchModel {
  /// What's typed, the results by group, and the selected result (an index into `hits`).
  package internal(set) var query = "" { didSet { Mutations.record("Search.query") } }
  package internal(set) var sections: [SearchSection] = [] { didSet { Mutations.record("Search.sections") } }
  package internal(set) var selection = 0 { didSet { Mutations.record("Search.selection") } }
  /// The results in order, and the list's lines (headers and results), made once per change of the results.
  @ObservationIgnored package private(set) var hits: [SearchHit] = []
  @ObservationIgnored package private(set) var rows: [SearchRow] = []

  @ObservationIgnored package internal(set) var index = SearchIndex()
  /// Stale since the last rebuild: everything (an unnarrowed change), or these runs' agents.
  @ObservationIgnored var staleAll = true
  @ObservationIgnored var staleRuns: Set<String> = []
  @ObservationIgnored var refreshQueued = false
  /// The last query's matches, for the next, longer one.
  @ObservationIgnored var last: (query: String, version: Int, matched: Set<String>)?
  /// Recently shown agents and projects (item ids), newest first.
  @ObservationIgnored package private(set) var recent: [String] = []
  /// How long the last rebuild and the last query took (ms), for the bench and the debug state.
  @ObservationIgnored package internal(set) var lastIndexMs = 0.0
  @ObservationIgnored package internal(set) var lastQueryMs = 0.0

  package init() {}

  func setResults(_ s: [SearchSection], keep: String? = nil) {
    var r: [SearchRow] = [], h: [SearchHit] = []
    for sec in s {
      r.append(SearchRow(id: "h\(sec.group.rawValue)", header: sec.group, hit: nil, index: -1))
      for hit in sec.hits { r.append(SearchRow(id: hit.id, header: nil, hit: hit, index: h.count)); h.append(hit) }
    }
    hits = h; rows = r
    let sel = keep.flatMap { k in h.firstIndex { $0.id == k } } ?? 0
    if sections != s { sections = s }
    if selection != sel { selection = sel }
  }

  func remember(_ id: String) {
    recent.removeAll { $0 == id }
    recent.insert(id, at: 0)
    if recent.count > 20 { recent.removeLast() }
  }
}

extension DeskModel {
  // MARK: opening and closing

  /// ⌘K, the title bar's button, the sidebar's search: opens on an empty query (`query` from the debug control file),
  /// or closes an open palette.
  package func togglePalette(query: String = "") {
    if paletteOpen && query.isEmpty { closePalette(); return }
    menuOpen = false; stopAsked = false
    // What you were looking at becomes recent: the empty search offers the way back.
    if newProject == nil {
      if let p = openProjectId { search.remember("project.\(p)") }
      if let a = focusedAgent { search.remember("agent.\(a)") }
    }
    refreshSearchIndex()
    search.query = query
    runSearch()
    paletteOpen = true
  }

  /// Esc, a click outside, the window losing the keyboard, or a result opened.
  package func closePalette() {
    guard paletteOpen else { return }
    paletteOpen = false
    SearchPanelController.hide(for: self)
  }

  // MARK: the query and the selection

  package var paletteQuery: String {
    get { search.query }
    set { guard newValue != search.query else { return }; search.query = newValue; runSearch() }
  }
  package var paletteSelection: Int { search.selection }
  /// What the query shows, in order.
  package var paletteShown: [SearchHit] { search.hits }

  /// ↑ ↓: the selection moves, and stops at either end. Never animated.
  package func movePaletteSelection(_ by: Int) {
    let n = search.hits.count
    let s = n == 0 ? 0 : min(max(0, search.selection + by), n - 1)
    if s != search.selection { search.selection = s }
  }
  package func selectPalette(_ i: Int) { if search.hits.indices.contains(i), i != search.selection { search.selection = i } }

  /// ↩ opens the selected result; ⌘↩ opens it in a split. Nothing when nothing matches.
  package func runPaletteSelection(split: Bool = false) {
    guard search.hits.indices.contains(search.selection) else { return }
    let hit = search.hits[search.selection]
    if split { openInSplit(hit) } else { open(hit) }
  }

  /// ↩ on a result, or a click.
  package func open(_ hit: SearchHit) {
    closePalette()
    if case .agent = hit.item.action { search.remember(hit.item.id) }
    if case .project = hit.item.action { search.remember(hit.item.id) }
    perform(hit.item.action)
  }

  /// ⌘↩ (or ⌘-click): the result beside the focused pane.
  // TODO(splits): splits aren't built yet. When the reel gets panes, open an agent or project result in a split beside
  // the focused pane here. Until then ⌘↩ opens the result exactly as ↩ does; this is the only place that has to change.
  package func openInSplit(_ hit: SearchHit) {
    open(hit)
  }

  func perform(_ a: SearchAction) {
    // In the Needs you reel: an agent it shows is focused there; anything else that opens a place leaves the reel first.
    if needs.isOpen {
      switch a {
      case .agent(_, let agentId) where needs.columns.contains(agentId): needs.focus(agentId); return
      case .agent, .project, .home, .newProject: closeNeedsReel()
      default: break
      }
    }
    switch a {
    case .agent(let runId, let agentId): show(run: runId, agent: agentId)
    case .project(let runId): show(run: runId)
    case .needsReel(let open): if open { openNeedsReel() } else { closeNeedsReel() }
    case .nextAsk: nextAsk()
    case .menu(let item): perform(item)
    case .approve(let id): decide(id, .approve)
    case .newProject: openNewProject()
    case .home: openHome(focus: false)
    case .follow(let on): follow = on
    case .settings: Self.openSettings()
    }
  }

  /// The app menu's Settings… (⌘,): the window has no Settings scene of its own to open.
  static func openSettings() {
    func find(_ m: NSMenu?) -> (NSMenu, Int)? {
      guard let m else { return nil }
      for (i, item) in m.items.enumerated() {
        if item.keyEquivalent == "," && item.keyEquivalentModifierMask == .command { return (m, i) }
        if let hit = find(item.submenu) { return hit }
      }
      return nil
    }
    if let (menu, i) = find(NSApp.mainMenu) { menu.performActionForItem(at: i) }
  }

  // MARK: the index

  /// The store changed (`apply`): mark what's stale; while the palette shows, rebuild it once this turn's changes are in.
  func searchStoreChanged(_ keys: Set<ChangeKey>) {
    for k in keys {
      switch k {
      case .all: search.staleAll = true
      case .run(let id): search.staleRuns.insert(id)
      default: break
      }
    }
    guard paletteOpen, !search.refreshQueued, search.staleAll || !search.staleRuns.isEmpty else { return }
    search.refreshQueued = true
    Task { @MainActor [weak self] in
      guard let self else { return }
      self.search.refreshQueued = false
      guard self.paletteOpen else { return }
      self.refreshSearchIndex()
      self.runSearch(keepSelection: true)
    }
  }

  /// Rebuilds what's stale: everything after an unnarrowed change, else the named runs' agents. The commands follow
  /// the window (the open project, the focused ask, Follow), so they are made each time.
  func refreshSearchIndex() {
    let t = ProcessInfo.processInfo.systemUptime
    let s = search
    if s.staleAll {
      s.index.set(runs: decks.map(\.runId))
      for d in decks { s.index.set(agents: store.searchAgents(deck: d), run: d.runId) }
      s.index.set(asks: store.searchAsks(decks: decks))
      s.index.set(projects: CapcomdStore.searchProjects(decks))
    } else {
      for d in decks where s.staleRuns.contains(d.runId) { s.index.set(agents: store.searchAgents(deck: d), run: d.runId) }
    }
    s.staleAll = false; s.staleRuns = []
    let home = newProject != nil
    let focusedAsk = home ? nil : focusedAgent.flatMap { agent($0)?.approval?.id }
    let title = decks.first { $0.id == openProjectId }?.title
    s.index.set(commands: SearchCommands.make(SearchCommandContext(menu: home ? nil : projectMenu, projectTitle: title, focusedAsk: focusedAsk,
                                                                   follow: follow, homeShown: home, asks: s.index.asks.count, needsReelOpen: needs.isOpen)))
    s.lastIndexMs = (ProcessInfo.processInfo.systemUptime - t) * 1000
  }

  /// The results for what's typed. A query that extends the last one looks only at the last one's matches.
  func runSearch(keepSelection: Bool = false) {
    let t = ProcessInfo.processInfo.systemUptime
    let s = search
    let keep = keepSelection && s.hits.indices.contains(s.selection) ? s.hits[s.selection].id : nil
    let q = s.query
    if q.allSatisfy(\.isWhitespace) {
      var exclude = Set<String>()
      if newProject == nil {
        if let a = focusedAgent { exclude.insert("agent.\(a)") }
        if let p = openProjectId { exclude.insert("project.\(p)") }
      }
      s.last = nil
      s.setResults(s.index.empty(recent: s.recent, exclude: exclude), keep: keep)
    } else {
      let among = s.last.flatMap { l in l.version == s.index.version && q.hasPrefix(l.query) ? l.matched : nil }
      let (sections, matched) = s.index.search(q, among: among)
      s.last = (q, s.index.version, matched)
      s.setResults(sections, keep: keep)
    }
    s.lastQueryMs = (ProcessInfo.processInfo.systemUptime - t) * 1000
  }
}
#endif
