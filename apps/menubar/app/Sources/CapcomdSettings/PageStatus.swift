#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// capcomd, the status row's page (SettingsSections.dc.html "the status row"; States: capcomd isn't running): the mark,
/// whether capcomd runs and its version, Start capcomd or Connect when it can't be reached, then Service (keep it
/// running) and This app (its token).
struct StatusPage: View {
  @Environment(SettingsModel.self) private var model
  @State private var confirmStop = false
  @State private var confirmReset = false
  @State private var sheet: TokenSheet.Kind?

  var body: some View {
    let c = model.connection
    SPage {
      hero(c)
      if !model.serviceUnsupported || c == .unreachable {
        SGroup("Service", id: "status.service") { serviceRow(c) } foot: {
          if let w = model.handOffs.waiting(HandOffKey.start) ?? model.handOffs.waiting(HandOffKey.service) { OpenedFoot(command: w.command) }
        }
      } else if c.live {
        SFoot(Text("To keep capcomd running after you close Terminal, run ") + Text(verbatim: SettingsRows.serviceInstall).font(ST.footMono) + Text("."))
      }
      SGroup("This app", id: "status.app") { tokenRow(c) } foot: { EmptyView() }
    }
    .alert("Stop keeping capcomd running?", isPresented: $confirmStop) {
      Button("Turn Off", role: .destructive) {
        model.handOff(HandOffKey.service, command: model.serviceInfo?.uninstallCommand ?? SettingsRows.serviceUninstall, baseline: "\(model.serviceState)")
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("capcomd stops now, and so does any run in progress. It won't start at login until you turn this on again.")
    }
    .alert("Reset the app token?", isPresented: $confirmReset) {
      Button("Reset", role: .destructive) { if model.resetToken() { sheet = .afterReset } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This app gets a new token, and the old one stops working at once. Anything else using it needs the new one.")
    }
    .dialogIcon(BotImages.scaled(BrandBot.happy, size: .full, cell: 2).map { Image(nsImage: $0) })
    .sheet(item: $sheet) { TokenSheet(afterReset: $0 == .afterReset) }
  }

  /// The mark on its disc, "capcomd", the status line, and the one thing to do when it isn't running or connected.
  @ViewBuilder private func hero(_ c: ConnectionState) -> some View {
    VStack(spacing: 6) {
      Image(nsImage: MarkImages.image(.working, mark: model.menuBarMark)).renderingMode(.template).resizable().interpolation(.none)
        .frame(width: 32, height: 32).foregroundStyle(ST.t1)
        .frame(width: ST.hero, height: ST.hero)
        .background(Circle().fill(ST.hex(0x2C2C31)))
        .overlay(Circle().strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .accessibilityHidden(true)
      Text("capcomd").font(ST.heroName).foregroundStyle(ST.t1).padding(.top, 4)
      HStack(spacing: 6) {
        if waitingToStart(c) { ProgressView().controlSize(.mini) } else { StatusDot(kind: StatusRow.dot(c)) }
        Text(verbatim: statusLine(c)).multilineTextAlignment(.center)
      }
      .font(ST.heroStatus).foregroundStyle(ST.t3)
      actions(c).padding(.top, 6)
    }
    .frame(maxWidth: .infinity)
    .padding(.top, 10).padding(.bottom, 4)
    .accessibilityElement(children: .contain)
  }

  private func waitingToStart(_ c: ConnectionState) -> Bool {
    guard c == .unreachable else { return false }
    let start = model.session?.start
    return model.handOffs.waiting(HandOffKey.start) != nil || start == .starting || start == .started
  }

  private func statusLine(_ c: ConnectionState) -> String {
    switch c {
    case .connected(let v): return v.map { "Running · \($0)" } ?? "Running"
    case .unreachable:
      if waitingToStart(c) { return "Starting capcomd…" }
      if case .failed(let why)? = model.session?.start { return why }
      return "Can't reach capcomd · trying again every few seconds"
    case .waitingForKeychain: return "Waiting for Keychain access…"
    case .noToken:
      if case .failed(let why)? = model.session?.token { return why }
      return model.session?.token == .pairing ? "Connecting…" : "This app needs a token from capcomd"
    case .rejected: return "capcomd rejected this app's token"
    }
  }

  @ViewBuilder private func actions(_ c: ConnectionState) -> some View {
    switch c {
    case .unreachable:
      if model.cliFound, let s = model.session {
        Button("Start capcomd") { s.startDaemon() }.prominent().disabled(waitingToStart(c))
          .accessibilityHint("Starts capcomd now and at every login.")
      } else if model.session != nil {
        Button("Start capcomd") {
          model.handOff(HandOffKey.start, command: model.serviceInfo?.installCommand ?? SettingsRows.serviceInstall, baseline: "false")
        }
        .prominent()
        .accessibilityHint("Opens Terminal to start capcomd as a background service.")
      }
    case .noToken, .rejected:
      HStack(spacing: 8) { ConnectButtons(sheet: $sheet) }
    default:
      EmptyView()
    }
  }

  /// The background service (`GET /v1/service`). Turning it on or off happens in Terminal; the row waits for it.
  @ViewBuilder private func serviceRow(_ c: ConnectionState) -> some View {
    let waiting = model.handOffs.waiting(HandOffKey.service) != nil
    let state = model.serviceState
    let install = model.serviceInfo?.installCommand ?? SettingsRows.serviceInstall
    SRow("Keep capcomd running") {
      if waiting {
        WaitingValue()
        Button("Show Terminal") { TerminalLauncher.showTerminal() }
      } else if c == .unreachable && state != .on {
        Button("Turn On…") { model.handOff(HandOffKey.service, command: install, baseline: "\(state)") }
      } else {
        SSwitch(title: "Keep capcomd running", isOn: Binding(get: { state == .on }, set: { on in
          if on { model.handOff(HandOffKey.service, command: install, baseline: "\(state)") } else { confirmStop = true }
        }))
        .disabled(state == .unknown || !c.live)
      }
    }
  }

  @ViewBuilder private func tokenRow(_ c: ConnectionState) -> some View {
    SRow("App token") {
      switch c {
      case .waitingForKeychain: WaitingValue(text: "Waiting for Keychain access…")
      case .noToken:
        if model.session?.token == .pairing { WaitingValue(text: "Connecting…") } else { StatusValue(nil, "Not set") }
      case .rejected:
        StatusValue(.bad, "Refused")
      default:
        if model.tokenFromEnvironment {
          StatusValue(nil, "From CAPCOMD_TOKEN")
        } else {
          StatusValue(nil, "Saved in your keychain")
          Button("Reset…") { confirmReset = true }.disabled(!c.live)
        }
      }
    }
  }
}

/// No token, or a rejected one: Connect (pair with the CLI) when it's installed, and Paste Token… either way.
struct ConnectButtons: View {
  @Environment(SettingsModel.self) private var model
  @Binding var sheet: TokenSheet.Kind?
  var body: some View {
    if model.cliFound, let s = model.session {
      Button("Connect") { s.pair() }.prominent().disabled(s.token == .pairing)
      Button("Paste Token…") { sheet = .paste }
    } else {
      Button("Paste Token…") { sheet = .paste }.prominent()
    }
  }
}

/// Paste a token (no token yet, rejected, or after Reset…): the existing replace-token flow in a sheet.
struct TokenSheet: View {
  enum Kind: Identifiable { case paste, afterReset; var id: Self { self } }
  @Environment(SettingsModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var token = ""
  @State private var failed = false
  /// After Reset…: Terminal is making the new token.
  let afterReset: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 10) {
      Text(afterReset ? "Paste the new token" : "Paste a token").font(.headline)
      Text(afterReset ? "Copy the token Terminal shows and paste it here."
                      : "In Terminal, run `\(FirstRun.pairCommand)` and paste the token it prints.")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      SecureField("Token", text: $token).textFieldStyle(.roundedBorder).onSubmit(save)
      if failed { Text("Couldn’t save the token to the Keychain.").foregroundStyle(.secondary) }
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Connect", action: save).keyboardShortcut(.defaultAction).disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(20)
    .frame(width: 380)
  }

  private func save() {
    failed = !model.submitToken(token)
    if !failed { token = ""; dismiss() }
  }
}

/// About (SettingsSections.dc.html, About): the identity moment. The happy bot and the pixel wordmark, the versions,
/// links, licence; one centred column.
struct AboutPage: View {
  @Environment(SettingsModel.self) private var model
  @Environment(\.openURL) private var openURL
  var body: some View {
    VStack(spacing: 0) {
      Spacer(minLength: 0)
      BotAvatar(traits: BrandBot.happy, size: .full, cell: 4)
        .accessibilityElement(children: .ignore).accessibilityLabel("\(BrandBot.name), the capcomd bot, smiling").accessibilityAddTraits(.isImage)
      PixelWordmark(cell: 6).padding(.top, 18)
      Text("Agent orchestration for your Mac").font(.system(size: 13)).foregroundStyle(ST.t2).padding(.top, 12)
      Text(verbatim: "App \(AppInfo.version) · " + (model.daemonVersion.map { "capcomd \($0)" } ?? "capcomd isn't connected"))
        .font(.system(size: 11)).foregroundStyle(ST.t3).padding(.top, 6)
        .textSelection(.enabled)
      HStack(spacing: 8) {
        Button("GitHub") { openURL(AppInfo.repo) }
        Button("Changelog") { openURL(AppInfo.changelog) }
        Button("Report an Issue…") { openURL(AppInfo.newIssue) }
      }
      .padding(.top, 22)
      Text("MIT License").font(.system(size: 11)).foregroundStyle(ST.t4).padding(.top, 18)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 24).padding(.bottom, 28)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .accessibilityElement(children: .contain)
  }
}

extension BotImages {
  /// The bot as an image `cell` points per cell, drawn without interpolation (an alert's icon).
  static func scaled(_ traits: BotTraits, size: BotSize, cell: CGFloat) -> NSImage? {
    guard let base = image(traits, size: size) else { return nil }
    let side = CGFloat(BotAvatar.cells(size)) * cell
    return NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      NSGraphicsContext.current?.imageInterpolation = .none
      base.draw(in: rect)
      return true
    }
  }
}
#endif
