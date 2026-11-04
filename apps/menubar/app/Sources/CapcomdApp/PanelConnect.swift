#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// The panel before the app is connected: what's happening in a line, and the window, where the rest is done.
struct PanelConnect: View {
  @Environment(AppModel.self) private var model
  private var session: AppSession { model.session }
  var body: some View {
    VStack(spacing: 8) {
      if session.token == .reading || session.token == .pairing { ProgressView().controlSize(.small) }
      Text(title).font(Theme.Finished.titleFont).foregroundStyle(Theme.Finished.trailingText)
      if let detail { Text(detail).font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText).multilineTextAlignment(.center) }
      if session.token != .reading && session.token != .pairing {
        Button("Open capcomd") { MenuBarPanel.close(); MainWindow.show() }.keyboardShortcut(.defaultAction)
      }
    }
    .padding(24)
  }

  private var title: String {
    switch session.token {
    case .reading: "Waiting for Keychain access…"
    case .pairing, .ready: "Connecting…"
    case .needsCLI: "capcomd needs its command line tool"
    case .failed: "Couldn't connect"
    case .rejected: "capcomd didn't accept this app's token"
    }
  }
  private var detail: String? {
    switch session.token {
    case .reading: "If macOS asks whether capcomd can use its token, choose Always Allow."
    case .failed(let why): why
    default: nil
    }
  }
}
#endif
