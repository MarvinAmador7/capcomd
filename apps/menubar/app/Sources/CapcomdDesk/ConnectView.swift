#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// Before the window is connected: how the app is getting there (AppSession), and the one thing to do when it can't
/// by itself. Pasting a token stays as a fallback under every state.
struct ConnectView: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    if let session = model.session { ConnectSteps(session: session) } else { Color.clear }
  }
}

private struct ConnectSteps: View {
  @Environment(DeskModel.self) private var model
  let session: AppSession
  @State private var pasting = false

  var body: some View {
    VStack(alignment: .leading, spacing: 12) {
      switch session.token {
      case .reading:
        // Usually instant: said only when macOS is holding the read on its prompt.
        if slow { Waiting(title: "Waiting for Keychain access…", detail: "If macOS asks whether capcomd can use its token, choose Always Allow.") }
      case .pairing, .ready:
        Waiting(title: "Connecting to capcomd…", detail: nil)
      case .needsCLI:
        Title("Install the capcomd command line tool")
        Detail("The app runs capcomd for you, but needs it installed. In Terminal, run:")
        CommandLine(FirstRun.installCommand)
        HStack(spacing: 8) {
          Button("Check Again") { session.recheck() }.keyboardShortcut(.defaultAction).disabled(session.lookingForCLI)
          if session.lookingForCLI { ProgressView().controlSize(.small) }
        }
      case .failed(let why):
        Title("Couldn't connect")
        Detail(why)
        Button("Try Again") { session.pair() }.keyboardShortcut(.defaultAction)
      case .rejected:
        Title("capcomd didn't accept this app's token")
        Detail("Connect again to make it a new one.")
        Button("Connect") { session.pair() }.keyboardShortcut(.defaultAction)
      }
      if session.token != .reading && session.token != .pairing && session.current == nil {
        Divider().padding(.vertical, 4)
        if pasting { PasteToken() } else {
          Button("Paste a token instead…") { pasting = true }.buttonStyle(.link).font(Theme.Desk.meta)
        }
      }
    }
    .frame(width: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
    .task { try? await Task.sleep(for: .milliseconds(700)); slow = true }
  }
  @State private var slow = false
}

private struct Waiting: View {
  let title: String
  let detail: String?
  var body: some View {
    HStack(spacing: 10) {
      ProgressView().controlSize(.small)
      Title(title)
    }
    if let detail { Detail(detail) }
  }
}

private struct Title: View {
  let text: String
  init(_ t: String) { text = t }
  var body: some View { Text(verbatim: text).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.Desk.text) }
}

private struct Detail: View {
  let text: String
  init(_ t: String) { text = t }
  var body: some View {
    Text(verbatim: text).font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary).fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }
}

/// A command to copy into Terminal.
private struct CommandLine: View {
  let command: String
  init(_ c: String) { command = c }
  var body: some View {
    HStack(spacing: 8) {
      Text(verbatim: command).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.text).textSelection(.enabled)
        .padding(.horizontal, 8).padding(.vertical, 5)
        .background(RoundedRectangle(cornerRadius: 6).fill(Color.white.opacity(0.06)))
      Button("Copy") { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(command, forType: .string) }
    }
  }
}

/// The fallback: a token made in Terminal, pasted here.
private struct PasteToken: View {
  @Environment(DeskModel.self) private var model
  @State private var token = ""
  @State private var failed = false
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Detail("In Terminal, run this and paste the token it prints:")
      CommandLine(FirstRun.pairCommand)
      HStack(spacing: 8) {
        SecureField("Token", text: $token).textFieldStyle(.roundedBorder).onSubmit(save)
        Button("Connect", action: save).disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
      if failed { Text("Couldn't save the token to the Keychain.").font(Theme.Desk.meta).foregroundStyle(Theme.red) }
    }
  }
  private func save() { failed = !model.submit(token: token); if !failed { token = "" } }
}

/// The daemon can't be reached and nothing has been read from it: say so, and start it when the app can.
struct Unreachable: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    VStack(spacing: 10) {
      Text("Can't reach capcomd").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.Desk.text)
      if let session = model.session { StartDaemon(session: session) } else {
        Text("Start it with capcomd serve. This window connects as soon as it's up.").font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
      }
    }
    .frame(width: 420).frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

private struct StartDaemon: View {
  let session: AppSession
  var body: some View {
    switch session.start {
    case .starting, .started:
      HStack(spacing: 8) { ProgressView().controlSize(.small); Text("Starting capcomd…").font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary) }
    case .idle, .failed:
      if session.cli != nil {
        Text("Start it now and whenever you log in. This window connects as soon as it's up.")
          .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        if case .failed(let why) = session.start {
          Text(verbatim: why).font(Theme.Desk.meta).foregroundStyle(Theme.amber).multilineTextAlignment(.center).textSelection(.enabled)
            .fixedSize(horizontal: false, vertical: true)
        }
        Button("Start capcomd") { session.startDaemon() }.keyboardShortcut(.defaultAction)
      } else if session.lookingForCLI {
        ProgressView().controlSize(.small)
      } else {
        Text("Install the capcomd command line tool, then start it here. In Terminal, run:")
          .font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary).multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        CommandLine(FirstRun.installCommand)
        Button("Check Again") { Task { await session.locate(again: true) } }
      }
    }
  }
}

/// The app and the daemon are versions apart that matter: a line at the bottom of the window, with Restart when that
/// fixes it.
struct VersionNotice: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    if let session = model.session, let skew = session.skew(daemon: model.daemonVersion), !model.unreachable {
      HStack(spacing: 10) {
        Image(systemName: "exclamationmark.circle").foregroundStyle(Theme.amber)
        Text(verbatim: skew.message).font(Theme.Desk.meta).foregroundStyle(Theme.Desk.text).textSelection(.enabled)
        if case .daemonOlder(_, _, true) = skew {
          if session.start == .starting { ProgressView().controlSize(.small) } else {
            Button("Restart capcomd") { session.startDaemon() }.controlSize(.small)
          }
        }
      }
      .padding(.horizontal, 12).padding(.vertical, 7)
      .background(Capsule().fill(Theme.Desk.column).overlay(Capsule().strokeBorder(Theme.Desk.columnStroke)))
      .padding(.bottom, 12)
    }
  }
}
#endif
