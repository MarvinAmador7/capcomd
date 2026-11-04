#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// The window: the title bar over the reel, or what's needed before there is one.
///
/// The content stays inside the safe area (below the toolbar's 52 pt) and the title bar is drawn into that band from
/// outside it. Ignoring the safe area for the whole stack instead hands the band to the reel's scroll view as a content
/// inset: its content becomes 52 pt taller than the view and the window scrolls vertically.
package struct RootView: View {
  @Environment(DeskModel.self) private var model
  package init() {}
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  package var body: some View {
    DeskProbe.body("RootView")
    let np = model.newProject
    return Group {
      switch model.link {
      case .connecting, .needsToken: ConnectView()
      case .ready:
        ZStack {
          // The reel stays built under the new project column, so closing the column shows it at once (SPEC §1).
          if model.openRunId != nil {
            ReelHost().opacity(np == nil ? 1 : 0).allowsHitTesting(np == nil).accessibilityHidden(np != nil)
          } else if np == nil {
            if model.unreachable { Unreachable() }
            else if model.loaded { if model.decks.isEmpty { EmptyReel() } else { FoldedReel() } }
            else { Color.clear }   // the daemon's first snapshot is on its way: nothing to say yet
          }
          if let np { NewProjectStage(np: np).transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 8))) }
        }
        .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.3, bounce: 0), value: np == nil)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay(alignment: .bottom) { if model.link == .ready { VersionNotice() } }
    .overlay(alignment: .top) { TitleBar().alignmentGuide(.top) { $0[.bottom] } }
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

/// Every project is folded into the title bar (⌘W): nothing is open until one is picked.
struct FoldedReel: View {
  var body: some View {
    Text("Your projects are in the title bar. Pick one, or press ⌘1.")
      .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// No projects yet: the brand moment, nothing to load.
struct EmptyReel: View {
  var body: some View {
    VStack(spacing: 14) {
      PixelWordmark()
      Text("Nothing running. Start a project with + (⇧⌘N).")
        .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

#endif
