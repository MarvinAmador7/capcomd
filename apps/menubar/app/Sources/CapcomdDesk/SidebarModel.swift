#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import CapcomdStore
import CapcomdBot
import PerfLoopProbe

// The window's navigation (design/desktop/rex, SPEC §2 "Navigation"): folded, C's rail beside the approved title bar
// and reel; opened, the Rex-style sidebar (agents by what needs you) and one agent's pane. The sidebar reads one slice,
// `SidebarSlice.content`, rebuilt from the runs a change names (`.run(id)`, `.agent(id)`, `.all`) and assigned only when
// it differs; nothing in it depends on a thread's items, so a thread item that arrives re-renders no row.

/// Folded or opened, and the sidebar's own view state. `sidebarOpen` is remembered across launches.
@Observable @MainActor
package final class DeskNav {
  package internal(set) var sidebarOpen = false {
    didSet { Mutations.record("DeskNav.sidebarOpen"); if sidebarOpen != oldValue { defaults?.set(sidebarOpen, forKey: Self.key) } }
  }
  /// Bumped to hand the sidebar's list the keyboard (↑ ↓ Return ← →).
  package private(set) var listFocus = 0 { didSet { Mutations.record("DeskNav.listFocus") } }
  /// The row the keyboard is on (a `SidebarKey`), ringed while the list has the keyboard; Return shows it.
  package internal(set) var cursor: SidebarKey? { didSet { Mutations.record("DeskNav.cursor") } }
  /// Finished is folded until opened (→ or a click on its heading).
  package internal(set) var finishedOpen = false { didSet { Mutations.record("DeskNav.finishedOpen") } }
  /// Projects folded or unfolded by hand; the rest fold by themselves once the list outgrows the window.
  package internal(set) var unfolded: Set<String> = [] { didSet { Mutations.record("DeskNav.unfolded") } }
  package internal(set) var foldedByHand: Set<String> = [] { didSet { Mutations.record("DeskNav.foldedByHand") } }
  /// The height the list has (set by the sidebar when the window's height changes, never per frame).
  package internal(set) var listHeight: CGFloat = 0 { didSet { Mutations.record("DeskNav.listHeight") } }
  @ObservationIgnored var defaults: UserDefaults?
  static let key = "desk.sidebarOpen"

  func restore(from d: UserDefaults?) {
    defaults = nil
    sidebarOpen = d?.bool(forKey: Self.key) ?? false
    defaults = d
  }
  func focusList() { listFocus &+= 1 }
}

/// A line of the sidebar the keyboard can stand on.
package enum SidebarKey: Hashable, Sendable {
  case agent(String)
  /// A folded project label (→ unfolds it), by section and project.
  case project(SidebarSection, String)
  case finished
}

package enum SidebarSection: String, Sendable, Hashable { case needs, running, finished }

/// How a row's trailing word and its title are drawn.
package enum RowTone: Sendable, Hashable {
  /// Running: no word.
  case plain
  /// An ask, a question or a usage limit: amber.
  case ask
  /// Failed: a red word.
  case error
  /// Queued or paused: dim, a grey word.
  case dim
  /// Done, stopped, handed back: grey.
  case done
}

/// One agent: its catalog head with the provider badge, its own lowercase title, a short word when it matters.
package struct SidebarRow: Sendable, Hashable, Identifiable {
  package var id: String
  package var runId: String
  package var projectId: String
  package var title: String
  package var bot: BotTraits?
  package var provider: Provider?
  /// Indent level (0–2): its depth in the tree under the project, capped; 0 in Needs you.
  package var level: Int
  package var word: String?
  package var tone: RowTone
}

/// A project as a quiet label inside a section, with its agents under it.
package struct SidebarGroup: Sendable, Hashable, Identifiable {
  package var id: String { projectId }
  package var projectId: String
  package var runId: String
  package var title: String
  /// "docker" / "fake-host" (This Mac), "boxd" (cloud), else unknown.
  package var sandbox: String?
  package var rows: [SidebarRow]
}

/// Every section's groups, in the title bar's project order (oldest first; nothing jumps as others start).
package struct SidebarContent: Sendable, Hashable {
  package var needs: [SidebarGroup] = []
  package var running: [SidebarGroup] = []
  package var finished: [SidebarGroup] = []
  package var needsCount: Int { needs.reduce(0) { $0 + $1.rows.count } }
  package var runningCount: Int { running.reduce(0) { $0 + $1.rows.count } }
  package var finishedCount: Int { finished.reduce(0) { $0 + $1.rows.count } }
  package var isEmpty: Bool { needs.isEmpty && running.isEmpty && finished.isEmpty }
  package func groups(_ s: SidebarSection) -> [SidebarGroup] { switch s { case .needs: needs; case .running: running; case .finished: finished } }
  /// Every agent row, in the order shown (Needs you, Running, Finished).
  package var allRows: [SidebarRow] { (needs + running + finished).flatMap(\.rows) }
}

/// The sidebar's slice: its content and the Needs you count (the hand, the rail's badge), each assigned only on change.
@Observable @MainActor
package final class SidebarSlice {
  package private(set) var content = SidebarContent() { didSet { Mutations.record("SidebarSlice.content") } }
  package private(set) var needsCount = 0 { didSet { Mutations.record("SidebarSlice.needsCount") } }
  /// While the pointer is over the sidebar a row never moves under it: a change of sections waits until it leaves.
  @ObservationIgnored var held: SidebarContent?
  @ObservationIgnored package internal(set) var pointerInside = false
  /// How many times `content` was assigned (the bench's check that a thread item changes nothing here).
  @ObservationIgnored package private(set) var assignments = 0

  func set(_ c: SidebarContent) {
    if needsCount != c.needsCount { needsCount = c.needsCount }
    guard c != content else { held = nil; return }
    if pointerInside, Self.moves(content, c) { held = c; return }
    held = nil
    assign(c)
  }
  func pointer(inside: Bool) {
    pointerInside = inside
    if !inside, let h = held { held = nil; withAnimation(.easeOut(duration: 0.2)) { assign(h) } }
  }
  private func assign(_ c: SidebarContent) { content = c; assignments += 1 }

  /// Whether a change moves a row (to another section, or another place): only those wait for the pointer.
  static func moves(_ a: SidebarContent, _ b: SidebarContent) -> Bool {
    func layout(_ c: SidebarContent) -> [[String]] {
      [c.needs, c.running, c.finished].map { $0.flatMap { g in [g.projectId] + g.rows.map(\.id) } }
    }
    return layout(a) != layout(b)
  }
}

// MARK: building it from the store

extension DeskModel {
  /// A row's word and tone (RexStates "Rows"): asks / question / usage limit (amber), failed (red), queued / paused
  /// (dim), done / stopped / handed back (grey); running says nothing.
  static func sidebarWord(_ h: ColumnHeader, approval: PendingApproval?, limit: String?) -> (String?, RowTone) {
    if let a = approval { return (a.kind == "question" ? "question" : "asks", .ask) }
    switch h.status {
    case .running, .unknown: return (nil, .plain)
    case .paused: return limit == "quota" ? ("usage limit", .ask) : ("paused", .dim)
    case .pending: return ("queued", .dim)
    case .failed: return ("failed", .error)
    case .done: return ("done", .done)
    case .cancelled: return ("stopped", .done)
    case .handedOff: return ("handed back", .done)
    }
  }

  /// One run's rows, in tree order, each marked whether it steps out into Needs you: it asks, or (while the run is
  /// still active) it failed or waits at a usage limit. Memoised per run; `apply` recomputes only the runs a change
  /// names.
  func sidebarRows(_ deck: DeckInfo) -> [(row: SidebarRow, needs: Bool)] {
    let runId = deck.runId
    guard let run = store.runs[runId] else { return [] }
    let active = run.isActive
    let bots = team(runId)
    var asks: [String: PendingApproval] = [:]
    for a in store.approvals(forRun: runId) { if let w = store.waitingAgent(a), asks[w] == nil { asks[w] = a } }
    return store.reelColumns(runId: runId).map { h in
      let limit = run.agents[h.agentId]?.limit
      let (word, tone) = Self.sidebarWord(h, approval: asks[h.agentId], limit: limit)
      let needs = tone == .ask || (active && tone == .error)
      let row = SidebarRow(id: h.agentId, runId: runId, projectId: deck.id, title: h.tabLabel, bot: bots[h.agentId], provider: h.provider,
                           level: needs ? 0 : min(h.depth, 2), word: word, tone: tone)
      return (row, needs)
    }
  }

  /// The sections from every deck's rows: Needs you (agents stepped out of their tree), Running (active projects, the
  /// rest of their tree), Finished (the projects whose run ended).
  func sidebarContent(_ rows: (DeckInfo) -> [(row: SidebarRow, needs: Bool)]) -> SidebarContent {
    var c = SidebarContent()
    for d in decks {
      let rs = rows(d)
      let active = store.runs[d.runId]?.isActive ?? d.isRunning
      func group(_ r: [SidebarRow]) -> SidebarGroup { SidebarGroup(projectId: d.id, runId: d.runId, title: d.title, sandbox: d.sandbox, rows: r) }
      let needs = rs.filter(\.needs).map(\.row), rest = rs.filter { !$0.needs }.map(\.row)
      if !needs.isEmpty { c.needs.append(group(needs)) }
      if !rest.isEmpty || needs.isEmpty {
        if active { c.running.append(group(rest)) } else { c.finished.append(group(rest)) }
      }
    }
    return c
  }
}
#endif
