#if canImport(SwiftUI) && os(macOS)
import Foundation
import CoreGraphics

// The desk's layout (owner, 2026-11-27; Settings › Interface › Layout): tabs or the sidebar, never both, as Rex's
// "Toolbar layout" has it. Tabs: the crew as tabs over (or under) the reel, with the places (Home, Team, History,
// Settings, the Needs you hand, Search and +) at the tab bar's trailing end. Sidebar: the Rex-style sidebar on the left
// or the right, and one agent's pane. ⌃⌘S switches between tabs and the sidebar, keeping the side and the edge chosen.
// Foundation only, so the stored preference and its migration are tested without a window.

/// Where the window's navigation is: one of four, as the Layout tiles draw them.
package enum DeskLayout: String, CaseIterable, Sendable, Hashable, Identifiable {
  case tabsAbove, sidebarLeft, sidebarRight, tabsBelow

  package var id: String { rawValue }
  /// The tile's name (Settings › Interface › Layout) and the View menu's item.
  package var title: String {
    switch self {
    case .tabsAbove: "Tabs Above"
    case .sidebarLeft: "Sidebar Left"
    case .sidebarRight: "Sidebar Right"
    case .tabsBelow: "Tabs Below"
    }
  }
  /// The sidebar, not the tabs.
  package var isSidebar: Bool { self == .sidebarLeft || self == .sidebarRight }
  /// The sidebar's side in this layout (nil: a tabs layout).
  package var side: SidebarSide? { switch self { case .sidebarLeft: .left; case .sidebarRight: .right; default: nil } }
  /// The tab bar's edge in this layout (nil: a sidebar layout).
  package var edge: TabsEdge? { switch self { case .tabsAbove: .above; case .tabsBelow: .below; default: nil } }

  package init(sidebar: Bool, side: SidebarSide, edge: TabsEdge) {
    self = sidebar ? (side == .left ? .sidebarLeft : .sidebarRight) : (edge == .above ? .tabsAbove : .tabsBelow)
  }
}

/// The sidebar's side of the window. The traffic lights stay at the window's top left either way.
package enum SidebarSide: String, CaseIterable, Sendable, Hashable { case left, right }

/// The tab bar's edge of the window.
package enum TabsEdge: String, CaseIterable, Sendable, Hashable { case above, below }

/// Sidebar behavior, and the tab bar's: always there, or out of the way until the pointer comes to its edge.
package enum ChromeBehavior: String, CaseIterable, Sendable, Hashable, Identifiable {
  case always, hover
  package var id: String { rawValue }
  package var title: String { self == .always ? "Always Show" : "Show on Hover" }
}

/// What is kept across launches: the layout, the side and edge ⌃⌘S goes back to, and each part's behavior.
package struct DeskLayoutPrefs: Equatable, Sendable {
  package var layout: DeskLayout = .tabsAbove
  /// The side the sidebar takes when ⌃⌘S brings it back (the layout's own while it is a sidebar layout).
  package var side: SidebarSide = .left
  /// The edge the tab bar takes when ⌃⌘S brings it back (the layout's own while it is a tabs layout).
  package var edge: TabsEdge = .above
  package var sidebarBehavior: ChromeBehavior = .always
  package var tabsBehavior: ChromeBehavior = .always

  package init(layout: DeskLayout = .tabsAbove, side: SidebarSide = .left, edge: TabsEdge = .above,
               sidebarBehavior: ChromeBehavior = .always, tabsBehavior: ChromeBehavior = .always) {
    self.layout = layout; self.side = layout.side ?? side; self.edge = layout.edge ?? edge
    self.sidebarBehavior = sidebarBehavior; self.tabsBehavior = tabsBehavior
  }

  package static let layoutKey = "desk.layout"
  package static let sideKey = "desk.layout.sidebarSide"
  package static let edgeKey = "desk.layout.tabsEdge"
  package static let sidebarBehaviorKey = "desk.sidebarBehavior"
  package static let tabsBehaviorKey = "desk.tabsBehavior"
  /// Before the four layouts (≤ 0.13.0-rc.3): folded (the Reel: the rail, tabs above) or opened (the sidebar, left).
  package static let legacyKey = "desk.sidebarOpen"

  /// The stored preference, migrating the old Reel / Sidebar choice once: Reel → Tabs above, Sidebar → Sidebar left.
  /// The old key is removed once the layout is written under its own.
  package static func read(_ d: UserDefaults?) -> DeskLayoutPrefs {
    guard let d else { return DeskLayoutPrefs() }
    migrate(d)
    let layout = d.string(forKey: layoutKey).flatMap(DeskLayout.init(rawValue:)) ?? .tabsAbove
    return DeskLayoutPrefs(layout: layout,
                           side: d.string(forKey: sideKey).flatMap(SidebarSide.init(rawValue:)) ?? .left,
                           edge: d.string(forKey: edgeKey).flatMap(TabsEdge.init(rawValue:)) ?? .above,
                           sidebarBehavior: d.string(forKey: sidebarBehaviorKey).flatMap(ChromeBehavior.init(rawValue:)) ?? .always,
                           tabsBehavior: d.string(forKey: tabsBehaviorKey).flatMap(ChromeBehavior.init(rawValue:)) ?? .always)
  }

  /// Reel → Tabs above, Sidebar → Sidebar left; nothing stored → nothing written (the default is Tabs above). A layout
  /// already stored wins over the old key, which goes either way.
  package static func migrate(_ d: UserDefaults) {
    guard let old = d.object(forKey: legacyKey) else { return }
    if d.string(forKey: layoutKey).flatMap(DeskLayout.init(rawValue:)) == nil {
      let opened = (old as? Bool) ?? (old as? NSNumber)?.boolValue ?? false
      d.set((opened ? DeskLayout.sidebarLeft : .tabsAbove).rawValue, forKey: layoutKey)
    }
    d.removeObject(forKey: legacyKey)
  }

  package func write(_ d: UserDefaults) {
    d.set(layout.rawValue, forKey: Self.layoutKey)
    d.set(side.rawValue, forKey: Self.sideKey)
    d.set(edge.rawValue, forKey: Self.edgeKey)
    d.set(sidebarBehavior.rawValue, forKey: Self.sidebarBehaviorKey)
    d.set(tabsBehavior.rawValue, forKey: Self.tabsBehaviorKey)
  }

  /// ⌃⌘S: tabs ↔ the sidebar, each on the side or edge chosen last.
  package var toggled: DeskLayout { DeskLayout(sidebar: !layout.isSidebar, side: side, edge: edge) }

  /// A layout chosen: it remembers its own half (side or edge), and keeps the other.
  package mutating func choose(_ l: DeskLayout) {
    layout = l
    if let s = l.side { side = s }
    if let e = l.edge { edge = e }
  }
}

/// What the bench and the tests read of the layouts' chrome (the metrics themselves are internal).
package enum DeskLayoutProbe {
  /// The opened sidebar's hosting view's identifier.
  package static let sidebarID = "capcomd.desk.sidebar"
  /// The tab bar's height (the title bar's band).
  package static let tabBar: CGFloat = 52
  /// The sidebar's width.
  package static let sidebarWidth: CGFloat = 248
}
#endif
