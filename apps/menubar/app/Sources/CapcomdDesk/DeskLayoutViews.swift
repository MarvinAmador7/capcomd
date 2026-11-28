#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdUI

// The four layouts in the window (DeskLayout.swift): the tab bar above or below the reel, its places at its trailing
// end, and the tab bar's Show on hover. The sidebar's side and its Show on hover are the opened layer's (Pane.swift).

/// The rail's places, now at the tab bar's trailing end (and, as before, in the sidebar's header and foot): one list,
/// so the tab bar's buttons keep the rail's tooltips and shortcuts.
package enum PlaceButton: String, CaseIterable, Sendable {
  case needs, home, team, history, settings, search, newProject
  /// The tab bar's trailing buttons, in order (Settings board, Layout tiles: small squares at the bar's end).
  package static let tabBar: [PlaceButton] = [.needs, .home, .team, .history, .settings, .search, .newProject]
  /// The tooltip (`help`), naming the shortcut where there is one.
  package var help: String {
    switch self {
    case .needs: "Needs you"
    case .home: "Home (⌘0)"
    case .team: "Team"
    case .history: "History (not built yet)"
    case .settings: "Settings (⌘,)"
    case .search: "Search (⌘K)"
    case .newProject: "New project (⇧⌘N)"
    }
  }
  /// VoiceOver's name for it.
  package var label: String {
    switch self {
    case .needs: "Needs you"
    case .home: "Home"
    case .team: "Team"
    case .history: "History, not available yet"
    case .settings: "Settings"
    case .search: "Search"
    case .newProject: "New project"
    }
  }
}

/// The tab bar's trailing places: the Needs you hand with its amber count, Home, Team, History, Settings, Search and +,
/// as compact 28 pt icon buttons (the sidebar's own).
struct TabBarPlaces: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("TabBarPlaces")
    return HStack(spacing: 2) {
      ForEach(PlaceButton.tabBar, id: \.self) { p in
        switch p {
        case .needs: NeedsHand()
        case .home: HomePlaceButton()
        case .team: TeamButton()
        case .history: HistoryButton(size: Theme.Desk.Side.button)
        case .settings: SettingsButton(size: Theme.Desk.Side.button)
        case .search: SearchPlaceButton()
        case .newProject: NewProjectPlaceButton()
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Places")
  }
}

/// Home (⌘0): pressed while Home shows (and Team doesn't).
struct HomePlaceButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    SideButton(glyph: AnyView(HouseGlyph().stroke(style: StrokeStyle(lineWidth: 1.3, lineJoin: .round)).frame(width: 15, height: 15)),
               on: model.homeShown && !model.team.isOpen, help: PlaceButton.home.help, label: PlaceButton.home.label) { model.toggleHome() }
  }
}

/// Search (⌘K): the palette.
struct SearchPlaceButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    SideButton(symbol: "magnifyingglass", on: model.paletteOpen, help: PlaceButton.search.help, label: PlaceButton.search.label) { model.togglePalette() }
  }
}

/// + (⇧⌘N): Home with the composer focused.
struct NewProjectPlaceButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    SideButton(symbol: "plus", help: PlaceButton.newProject.help, label: PlaceButton.newProject.label) { model.openNewProject() }
  }
}

/// The tab bar where the layout puts it: in the title bar's band (above) or along the window's bottom (below). Show on
/// hover keeps it out of the window until the pointer comes to its edge (above: anywhere in the band; below: the
/// bottom 6 pt, so reaching for a message box doesn't bring it up), and takes it away 0.3 s after the pointer leaves.
/// It is the same view in every layout and state: moving it or hiding it rebuilds nothing.
struct TabBarHost: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let edge: TabsEdge
  /// Show on hover (never under VoiceOver: the bar is always there for it).
  let hover: Bool
  /// The tabs show (not the sidebar): only then does the pointer bring the bar in.
  let active: Bool
  @State private var pointer = false
  var body: some View {
    let h = Theme.Desk.titleBar
    // The project menu drops from the bar: it doesn't lose the bar under it.
    let shown = !hover || pointer || model.menuOpen
    let zone = edge == .above || shown ? h : TabBarMetrics.hotEdge
    return ZStack(alignment: edge == .above ? .top : .bottom) {
      if hover && active {
        HoverZone { inside in pointer = inside }.frame(height: zone).accessibilityHidden(true)
      }
      // Out of the window by an offset, not hidden: SwiftUI would take its AppKit views (the tabs' scroll view) out of
      // the window and put them back. Reduce Motion fades it instead.
      TitleBar(edge: edge)
        .offset(y: shown || reduceMotion ? 0 : (edge == .above ? -h : h))
        .opacity(shown || !reduceMotion ? 1 : 0)
        .allowsHitTesting(shown)
        .animation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.18), value: shown)
    }
    .frame(height: h, alignment: edge == .above ? .top : .bottom)
  }
}

enum TabBarMetrics {
  /// Show on hover, below: how close to the window's bottom the pointer brings the bar up.
  static let hotEdge: CGFloat = 6
  /// Show on hover: how long the bar (or the sidebar) stays once the pointer leaves it.
  static let concealDelay: Double = 0.3
}

/// Where the pointer is, without taking any click: a tracking area over its frame, and no hit-testing, so the window
/// still drags from the band and a click goes to what is under it. `inside` turns false 0.3 s after the pointer leaves
/// (back in sooner: it never turned).
struct HoverZone: NSViewRepresentable {
  let inside: (Bool) -> Void
  func makeNSView(context: Context) -> Zone { Zone() }
  func updateNSView(_ v: Zone, context: Context) { v.inside = inside }

  final class Zone: NSView {
    var inside: ((Bool) -> Void)?
    private var area: NSTrackingArea?
    private var leave: DispatchWorkItem?
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override func updateTrackingAreas() {
      super.updateTrackingAreas()
      if let area { removeTrackingArea(area) }
      let a = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeInKeyWindow, .inVisibleRect], owner: self, userInfo: nil)
      addTrackingArea(a)
      area = a
    }
    override func mouseEntered(with event: NSEvent) {
      leave?.cancel(); leave = nil
      inside?(true)
    }
    override func mouseExited(with event: NSEvent) {
      leave?.cancel()
      let w = DispatchWorkItem { [weak self] in self?.inside?(false) }
      leave = w
      DispatchQueue.main.asyncAfter(deadline: .now() + TabBarMetrics.concealDelay, execute: w)
    }
  }
}
#endif
