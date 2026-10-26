#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// First launch (no Keychain item for service "capcomd") or after a 401: paste the daemon token.
struct TokenPrompt: View {
  @Environment(AppModel.self) private var model
  @State private var token = ""
  @State private var failed = false
  let rejected: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text("Connect to capcomd").font(Theme.panelTitle)
      Text(rejected ? "capcomd rejected the saved token. Paste a new one." : "Paste the token from `capcomd token`.")
        .font(Theme.body).foregroundStyle(.secondary)
      SecureField("Token", text: $token).textFieldStyle(.roundedBorder).onSubmit(save)
      if failed { Text("Couldn’t save the token to the Keychain.").font(Theme.chip).foregroundStyle(.secondary) }
      HStack { Spacer(); Button("Connect", action: save).keyboardShortcut(.defaultAction).disabled(token.isEmpty) }
    }
    .padding(Theme.inset)
  }

  private func save() { failed = !model.submitToken(token); if !failed { token = "" } }
}

/// Untrusted text with `[REDACTED]` markers dimmed. Every piece is still `Text(verbatim:)`: no markdown, no links.
struct RedactableText: View {
  let text: UntrustedText
  var body: some View {
    text.segments.reduce(Text(verbatim: "")) { acc, seg in
      switch seg {
      case .text(let s): return acc + Text(verbatim: s)
      case .redacted: return acc + Text(verbatim: "[REDACTED]").foregroundStyle(.tertiary)
      }
    }
  }
}
#endif
