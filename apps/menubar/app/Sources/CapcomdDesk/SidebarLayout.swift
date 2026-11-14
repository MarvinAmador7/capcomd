#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// The sidebar's lines, as drawn (RexMain, RexStates): fixed heights, so the list never measures itself and folding is
/// decided from arithmetic. The pinned part is Needs you (an ask never scrolls out of sight); the rest scrolls.
package enum SidebarLine: Hashable, Identifiable, Sendable {
  case heading(SidebarSection, count: Int, first: Bool)
  case calm(String, id: String)
  case label(SidebarGroup, SidebarSection, folded: Bool)
  case row(SidebarRow, SidebarSection)
  case newProject

  package var id: String {
    switch self {
    case .heading(let s, _, _): "h:\(s.rawValue)"
    case .calm(_, let id): "c:\(id)"
    case .label(let g, let s, _): "l:\(s.rawValue):\(g.projectId)"
    case .row(let r, let s): "r:\(s.rawValue):\(r.id)"
    case .newProject: "new"
    }
  }

  /// Its height with the space above it (CSS margin-top), in points.
  package var height: CGFloat {
    switch self {
    case .heading(_, _, let first): SidebarMetrics.heading + (first ? 2 : 16)
    case .calm: SidebarMetrics.calm
    case .label(_, _, let folded): folded ? SidebarMetrics.foldedLabel + 2 : SidebarMetrics.label + 4
    case .row: SidebarMetrics.row
    case .newProject: SidebarMetrics.row + 2
    }
  }

  /// Where the keyboard can stand: rows, folded projects, Finished's heading.
  package var key: SidebarKey? {
    switch self {
    case .row(let r, _): .agent(r.id)
    case .label(let g, let s, true): .project(s, g.projectId)
    case .heading(.finished, _, _): .finished
    default: nil
    }
  }
}

enum SidebarMetrics {
  static let width: CGFloat = 248
  static let header: CGFloat = 52, footer: CGFloat = 40
  static let heading: CGFloat = 28, label: CGFloat = 24, foldedLabel: CGFloat = 28, row: CGFloat = 28, calm: CGFloat = 27
  /// Indent per tree level (RexMain `.row.l1` 22, `.l2` 36 from the row's 8).
  static let indent: CGFloat = 14
  /// Toggling never moves the sidebar button: it sits where the folded title bar has it.
  static let toggleX: CGFloat = 84
}

package struct SidebarLines: Equatable, Sendable {
  package var pinned: [SidebarLine] = []
  package var list: [SidebarLine] = []
  /// The list outgrew the window: idle projects folded, and the pinned part has its hairline.
  package var overflow = false
  package var keys: [SidebarKey] { (pinned + list).compactMap(\.key) }
}

extension SidebarLines {
  /// Lays the content out. Once it outgrows `height`, projects you aren't looking at fold to one line (label, heads);
  /// the selected one, anything in Needs you, and a project unfolded by hand never fold (RexStates "20 projects").
  package static func make(_ c: SidebarContent, height: CGFloat, selectedProject: String?, finishedOpen: Bool,
                           unfolded: Set<String>, foldedByHand: Set<String>) -> SidebarLines {
    func build(autoFold: Bool) -> SidebarLines {
      var out = SidebarLines()
      out.pinned.append(.heading(.needs, count: c.needsCount, first: true))
      if c.needs.isEmpty { out.pinned.append(.calm("Nothing needs you.", id: "needs")) }
      for g in c.needs {
        out.pinned.append(.label(g, .needs, folded: false))
        out.pinned += g.rows.map { .row($0, .needs) }
      }
      func groups(_ gs: [SidebarGroup], _ s: SidebarSection) {
        for g in gs {
          let folded = !g.rows.isEmpty && (foldedByHand.contains(g.projectId)
            || (autoFold && g.projectId != selectedProject && !unfolded.contains(g.projectId)))
          out.list.append(.label(g, s, folded: folded))
          if !folded { out.list += g.rows.map { .row($0, s) } }
        }
      }
      out.list.append(.heading(.running, count: c.runningCount, first: false))
      if c.running.isEmpty { out.list.append(.calm("Nothing running.", id: "running")) }
      if c.isEmpty { out.list.append(.newProject) }
      groups(c.running, .running)
      if !c.finished.isEmpty {
        out.list.append(.heading(.finished, count: c.finishedCount, first: false))
        if finishedOpen { groups(c.finished, .finished) }
      }
      return out
    }
    let full = build(autoFold: false)
    guard height > 0, (full.pinned + full.list).reduce(0, { $0 + $1.height }) > height else { return full }
    var folded = build(autoFold: true)
    folded.overflow = true
    return folded
  }
}
#endif
