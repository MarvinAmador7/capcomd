#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import ServiceManagement
import CapcomdStore

/// Settings › General (Main.dc.html, GeneralLight.dc.html; States: capcomd isn't running).
struct GeneralPane: View {
  @Environment(AppModel.self) private var model
  @State private var tokenSheet = false
  @State private var confirmStop = false
  @State private var loginStatus: SMAppService.Status = .notRegistered
  @State private var loginError: String?
  @State private var notificationsDenied = false

  var body: some View {
    let connection = model.connection
    Form {
      Section {
        statusRow(connection)
        keepRunningRow(connection)
      } header: {
        Text("capcomd")
      } footer: {
        capcomdFoot(connection)
      }

      Section("Menu bar") {
        openAtLoginRow
        LabeledContent {
          HStack(spacing: Theme.Settings.rowGap) {
            BotFacePreview(face: model.menuBarFace)
            Toggle("Bot faces", isOn: Binding(get: { model.botFaces }, set: { model.botFaces = $0 }))
              .labelsHidden().toggleStyle(.switch)
          }
        } label: {
          Text("Bot faces")
          Text("The menu bar bot naps when nothing runs and raises a hand when something needs you.")
        }
      }

      Section {
        Toggle(isOn: Binding(get: { model.gitignoreCapcomd }, set: { model.gitignoreCapcomd = $0 })) {
          Text("Keep .capcomd/ out of git")
          Text("Adds ") + Text(verbatim: ".capcomd/").font(Theme.Settings.footMono) + Text(" to the project's .gitignore when you set it up. Off: commit it, so everyone who works on the project shares the setup.")
        }
        .toggleStyle(.switch)
        .disabled(!model.gitignoreSupported)
        .accessibilityLabel("Keep .capcomd out of git")
      } header: {
        Text("New projects")
      } footer: {
        // Until capcomd takes it with a setup, the switch is off and says so.
        Foot(verbatim: model.gitignoreSupported ? "Applies to projects you set up from now on." : "Applies to projects you set up from now on. Update capcomd to use this.")
      }

      Section {
        Toggle(isOn: Binding(get: { model.notifyApprovals }, set: { model.notifyApprovals = $0 })) {
          Text("Approval requests")
          Text("Approve or deny a merge from the notification.")
        }
        .accessibilityLabel("Notify for approval requests")
        Toggle(isOn: Binding(get: { model.notifyRunFinished }, set: { model.notifyRunFinished = $0 })) {
          Text("Finished runs")
          Text("Including runs that failed or were stopped.")
        }
        .accessibilityLabel("Notify when a run finishes")
      } header: {
        Text("Notifications")
      } footer: {
        notificationsFoot
      }
      .toggleStyle(.switch)
      .disabled(!Notifier.available)
    }
    .formStyle(.grouped)
    .sheet(isPresented: $tokenSheet) { TokenSheet(afterReset: false) }
    .alert("Stop keeping capcomd running?", isPresented: $confirmStop) {
      Button("Turn Off", role: .destructive) {
        model.handOff(HandOffKey.service, command: model.serviceInfo?.uninstallCommand ?? SettingsRows.serviceUninstall, baseline: "\(model.serviceState)")
      }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("capcomd stops now, and so does any run in progress. It won't start at login until you turn this on again.")
    }
    .task {
      readLoginStatus()
      notificationsDenied = await NotificationPermission.denied()
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      readLoginStatus()
      Task { notificationsDenied = await NotificationPermission.denied() }
    }
  }

  // MARK: capcomd

  @ViewBuilder private func statusRow(_ c: ConnectionState) -> some View {
    switch c {
    case .connected(let version):
      LabeledContent("Status") { StatusValue(.ok, version.map { "Connected · capcomd \($0)" } ?? "Connected") }
    case .unreachable:
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          if model.handOffs.waiting(HandOffKey.start) != nil { WaitingValue() } else { StatusValue(.bad, "Can't reach capcomd") }
          Button("Start capcomd") {
            model.handOff(HandOffKey.start, command: model.serviceInfo?.installCommand ?? SettingsRows.serviceInstall, baseline: "false")
          }
          .prominent()
          .accessibilityHint("Opens Terminal to start capcomd as a background service.")
        }
      } label: {
        Text("Status")
        Text("Trying again every few seconds.")
      }
    case .waitingForKeychain:
      LabeledContent("Status") { WaitingValue(text: "Waiting for Keychain access…") }
    case .noToken:
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          StatusValue(.empty, "Not connected")
          Button("Paste Token…") { tokenSheet = true }.prominent()
        }
      } label: {
        Text("Status")
        Text("This app needs a token from capcomd.")
      }
    case .rejected:
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          StatusValue(.bad, "capcomd rejected this app's token")
          Button("Paste Token…") { tokenSheet = true }.prominent()
        }
      } label: {
        Text("Status")
      }
    }
  }

  /// The background service (`GET /v1/service`). Turning it on or off happens in Terminal; the row waits for it.
  @ViewBuilder private func keepRunningRow(_ c: ConnectionState) -> some View {
    let waiting = model.handOffs.waiting(HandOffKey.service) != nil
    let state = model.serviceState
    let install = model.serviceInfo?.installCommand ?? SettingsRows.serviceInstall
    if c == .unreachable && state != .on {
      // capcomd isn't answering: offer the service as the way to keep it up (States board).
      LabeledContent {
        if waiting { WaitingValue() } else {
          Button("Turn On…") { model.handOff(HandOffKey.service, command: install, baseline: "\(state)") }
        }
      } label: {
        Text("Keep capcomd running")
        Text("Off: capcomd stops when you close the Terminal it runs in.")
      }
    } else if !model.serviceUnsupported {
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          if waiting {
            WaitingValue()
            Button("Show Terminal") { TerminalLauncher.showTerminal() }
          } else {
            Toggle("Keep capcomd running", isOn: Binding(get: { state == .on }, set: { on in
              if on { model.handOff(HandOffKey.service, command: install, baseline: "\(state)") } else { confirmStop = true }
            }))
            .labelsHidden().toggleStyle(.switch)
            .disabled(state == .unknown || !c.live)
          }
        }
      } label: {
        Text("Keep capcomd running")
        Text("Starts it at login and restarts it if it stops, so agents keep working after you close Terminal.")
      }
    }
  }

  @ViewBuilder private func capcomdFoot(_ c: ConnectionState) -> some View {
    VStack(alignment: .leading, spacing: 4) {
      if c == .unreachable {
        Foot(verbatim: "Rows that need capcomd (logins, environments) say so until it's back.")
      } else if c.live && model.serviceUnsupported {
        Foot(Text("To keep capcomd running after you close Terminal, run ") + Text(verbatim: SettingsRows.serviceInstall).font(Theme.Settings.footMono) + Text("."))
      }
      if let w = model.handOffs.waiting(HandOffKey.start) ?? model.handOffs.waiting(HandOffKey.service) { OpenedFoot(command: w.command) }
    }
  }

  // MARK: Menu bar

  @ViewBuilder private var openAtLoginRow: some View {
    let on = Binding(get: { loginStatus == .enabled || loginStatus == .requiresApproval }, set: { v in
      do { try LoginItem.set(v); loginError = nil } catch { loginError = error.localizedDescription }
      readLoginStatus()
    })
    if !LoginItem.available {
      Toggle(isOn: .constant(false)) {
        Text("Open at login")
        Text("Available in the capcomd app. This build runs without an app bundle.")
      }
      .toggleStyle(.switch).disabled(true)
    } else if loginStatus == .requiresApproval {
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          Button("Open Login Items…") { LoginItem.openSystemSettings() }
          Toggle("Open at login", isOn: on).labelsHidden().toggleStyle(.switch)
        }
      } label: {
        Text("Open at login")
        Text("Allow capcomd in System Settings › General › Login Items.")
      }
    } else {
      Toggle(isOn: on) {
        Text("Open at login")
        if let loginError { Text(verbatim: loginError) }
      }
      .toggleStyle(.switch)
    }
  }

  /// A footnote with a link in it (Markdown, parsed once the URL is in).
  static func linked(_ markdown: String) -> AttributedString { (try? AttributedString(markdown: markdown)) ?? AttributedString(markdown) }

  private func readLoginStatus() { if LoginItem.available { loginStatus = LoginItem.status } }

  // MARK: Notifications

  @ViewBuilder private var notificationsFoot: some View {
    if !Notifier.available {
      Foot(verbatim: "Available in the capcomd app. This build runs without an app bundle.")
    } else if notificationsDenied {
      Foot(Text(Self.linked("Notifications are off for capcomd. Turn them on in [System Settings › Notifications](\(NotificationPermission.settingsURL.absoluteString)).")))
    } else {
      Foot(Text(Self.linked("Banners and sounds follow [System Settings › Notifications](\(NotificationPermission.settingsURL.absoluteString)).")))
    }
  }
}
#endif
