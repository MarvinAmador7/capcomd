#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// The window: the title bar over the reel, or what's needed before there is one.
struct RootView: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    VStack(spacing: 0) {
      TitleBar()
      switch model.link {
      case .connecting: Color.clear
      case .needsToken: TokenView()
      case .ready:
        if model.openRunId == nil { EmptyReel() } else { Reel() }
      }
    }
    .background(Theme.Desk.ground)
    .ignoresSafeArea(.container, edges: .top)
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
