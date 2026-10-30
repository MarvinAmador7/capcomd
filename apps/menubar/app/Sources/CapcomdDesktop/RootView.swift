#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// The window: the title bar over the reel, or what's needed before there is one.
///
/// The content stays inside the safe area (below the toolbar's 52 pt) and the title bar is drawn into that band from
/// outside it. Ignoring the safe area for the whole stack instead hands the band to the reel's scroll view as a content
/// inset: its content becomes 52 pt taller than the view and the window scrolls vertically.
struct RootView: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    Group {
      switch model.link {
      case .connecting: Color.clear
      case .needsToken: TokenView()
      case .ready:
        if model.openRunId == nil { EmptyReel() } else if #available(macOS 15, *) { ReelHost(model: model) } else { OldMacOS() }
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .overlay(alignment: .top) { TitleBar().alignmentGuide(.top) { $0[.bottom] } }
    .background { Theme.Desk.ground.ignoresSafeArea() }
  }
}

/// The reel scrolls with macOS 15's scroll geometry; the menu bar app still covers macOS 14.
struct OldMacOS: View {
  var body: some View {
    Text("The capcomd window needs macOS 15 or later. The menu bar app works on this Mac.")
      .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
      .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// No projects yet: the brand moment, nothing to load.
struct EmptyReel: View {
  var body: some View {
    VStack(spacing: 14) {
      PixelWordmark()
      Text("Nothing running. Start a project from the menu bar or with capcomd run.")
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
