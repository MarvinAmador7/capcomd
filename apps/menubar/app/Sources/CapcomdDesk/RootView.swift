#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// The window: the tab bar with the reel, or the sidebar with the pane (the layout: DeskLayout.swift), or what's needed
/// before there is one.
///
/// The content stays inside the safe area (below the toolbar's 52 pt) and the tab bar, above, is drawn into that band
/// from outside it. Ignoring the safe area for the whole stack instead hands the band to the reel's scroll view as a
/// content inset: its content becomes 52 pt taller than the view and the window scrolls vertically. Below, the bar takes
/// the window's bottom 52 pt from the reel (with Show on hover it goes over the reel instead, which keeps the height).
package struct RootView: View {
  @Environment(DeskModel.self) private var model
  package init() {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
  package var body: some View {
    DeskProbe.body("RootView")
    let np = model.newProject
    let opened = model.nav.sidebarOpen
    let needs = model.needs.isOpen   // the Needs you reel takes the main area (NeedsYou.swift); opened, the pane's place
    let reel = np == nil && !needs
    let edge = model.nav.tabsEdge
    let hover = model.nav.tabsBehavior == .hover && !voiceOver
    // Below and always shown, the bar has the window's bottom band; with Show on hover it goes over the reel.
    let bottom = edge == .below && !hover ? Theme.Desk.titleBar : 0
    return Group {
      switch model.link {
      case .connecting, .needsToken: ConnectView()
      case .ready:
        // Tabs: the reel under the tab bar (no rail: its places are in the bar). Opened, `OpenedLayer` covers it, and
        // it stays as it was.
        ZStack {
          // The reel stays built under Home, so leaving Home for the open project shows it at once (SPEC §1).
          if model.openRunId != nil {
            ReelHost().opacity(reel ? 1 : 0).allowsHitTesting(reel).accessibilityHidden(!reel)
          }
          if needs && !opened { NeedsReelScreen() }
          if model.openRunId == nil && model.unreachable && model.decks.isEmpty { Unreachable() }
          else if let np, !opened { HomeView(np: np).transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8))) }
        }
        .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.3, bounce: 0), value: np == nil)
        .padding(.bottom, bottom)
        .accessibilityHidden(opened)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay(alignment: edge == .above ? .top : .bottom) {
      // Opened, the opened layer covers it (and the reel): neither is hidden or changed, so a toggle touches neither
      // (SwiftUI would take a hidden view's AppKit views out of the window and put them back). Above, it sits in the
      // band (its bottom on the content's top); below, on the window's bottom. The same view either way.
      TabBarHost(edge: edge, hover: hover, active: !opened)
        .alignmentGuide(.top) { $0[.bottom] }
        .accessibilityHidden(opened)
    }
    // Opened: the sidebar and the pane, into the title bar's band (the pane's header is the top line).
    .overlay { if model.link == .ready { OpenedLayer().ignoresSafeArea(.container, edges: .top) } }
    .overlay(alignment: .bottom) { if model.link == .ready { VersionNotice().padding(.bottom, opened ? 0 : bottom) } }
    .background { SidebarAlias() }
    .overlayPreferenceValue(ProjectGroupBounds.self) { a in
      DeskOverlays(group: a).allowsHitTesting(model.menuOpen || model.paletteOpen)
    }
    .alert("Stop this project?", isPresented: Binding(get: { model.stopAsked }, set: { if !$0 { model.cancelStop() } })) {
      Button("Stop Project", role: .destructive) { model.confirmStop() }
      Button("Cancel", role: .cancel) { model.cancelStop() }
    } message: {
      Text("It cancels every agent in it.")
    }
    .background { Theme.Desk.ground.ignoresSafeArea() }
  }
}

/// ⌘\, the sidebar's second key (View › Toggle Sidebar has ⌃⌘S): a button no one sees, so the menu lists one key.
struct SidebarAlias: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    Button("") { model.toggleSidebar() }
      .keyboardShortcut("\\", modifiers: .command)
      .opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
  }
}
#endif
