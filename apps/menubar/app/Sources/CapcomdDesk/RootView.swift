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
      case .connecting: Color.clear
      case .needsToken: TokenView()
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

/// The daemon can't be reached and nothing has been read from it: say so, rather than "nothing running".
struct Unreachable: View {
  var body: some View {
    VStack(spacing: 8) {
      Text("Can't reach capcomd").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.Desk.text)
      Text("Start it with capcomd serve, or from the menu bar app. This window connects as soon as it's up.")
        .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// The daemon needs a token: the same one the menu bar app uses (one Keychain item).
struct TokenView: View {
  @Environment(DeskModel.self) private var model
  @State private var token = ""
  @State private var failed = false
  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      Text("Connect to capcomd").font(.system(size: 15, weight: .semibold))
      if model.tokenRejected {
        Text("capcomd didn't accept the token this app has. Paste a new one.").font(Theme.Desk.label).foregroundStyle(Theme.amber)
      }
      Text("In Terminal, run `capcomd clients add desktop --scopes read,steer,approve` and paste the token it prints.")
        .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary).fixedSize(horizontal: false, vertical: true)
      HStack(spacing: 8) {
        SecureField("Token", text: $token).textFieldStyle(.roundedBorder).onSubmit(save)
        Button("Connect", action: save).keyboardShortcut(.defaultAction).disabled(token.isEmpty)
      }
      if failed { Text("Couldn't save the token to the Keychain.").font(Theme.Desk.meta).foregroundStyle(Theme.red) }
    }
    .frame(width: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
  private func save() { failed = !model.submit(token: token); if !failed { token = "" } }
}
#endif
