#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import ServiceManagement
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// General (SettingsSections.dc.html, General): the version, App Icon (the Dock's look, the menu bar's mark, where the
/// app shows, its moods), Launch, New projects and Onboarding.
struct GeneralPage: View {
  @Environment(SettingsModel.self) private var model
  @State private var loginStatus: SMAppService.Status = .notRegistered
  @State private var loginError: String?

  var body: some View {
    @Bindable var model = model
    SPage {
      SGroup(id: "general.version") { versionCard } foot: { EmptyView() }

      SGroup("App Icon", id: "general.appIcon") {
        AppIconPicker()
        SRow("Show app icon") {
          Picker("Show app icon", selection: $model.showAppIcon) {
            ForEach(Presence.ShowAppIcon.allCases, id: \.self) { Text(verbatim: $0.title).tag($0) }
          }
          .labelsHidden().pickerStyle(.menu).fixedSize()
        }
        SSep()
        SToggleRow(title: "Menu bar moods", isOn: $model.botFaces)
          .disabled(model.showAppIcon == .dockOnly)
          .opacity(model.showAppIcon == .dockOnly ? 0.45 : 1)
      }

      SGroup("Launch", id: "general.launch") {
        openAtLoginRow
      } foot: {
        if !LoginItem.available { SFoot(verbatim: "Available in the capcomd app. This build runs without an app bundle.") }
        else if loginStatus == .requiresApproval { SFoot(verbatim: "Allow capcomd in System Settings › General › Login Items.") }
        else if let loginError { SFoot(verbatim: loginError) }
      }

      SGroup("New projects", id: "general.newProjects") {
        SRow {
          Text("Keep ") + Text(verbatim: ".capcomd/").font(.system(size: 12, design: .monospaced)) + Text(" out of git")
        } value: {
          SSwitch(title: "Keep .capcomd out of git", isOn: $model.gitignoreCapcomd)
        }
        .disabled(!model.gitignoreSupported)
      } foot: {
        SFoot(verbatim: model.gitignoreSupported ? "Applies to projects you set up from now on." : "Applies to projects you set up from now on. Update capcomd to use this.")
      }

      SGroup(id: "general.onboarding") {
        SRow("Onboarding") { Button("Show Onboarding Again") { model.host.showOnboarding() } }
      } foot: { EmptyView() }
    }
    .task { readLoginStatus() }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in readLoginStatus() }
  }

  /// The version (Rex's pattern): the app icon, "capcomd <version>" and how it stands with the capcomd it talks to (the
  /// app's version check: a different minor while 0.x says which to update). No update channel: the app doesn't check
  /// a registry for releases.
  @ViewBuilder private var versionCard: some View {
    let skew = model.versionSkew
    SRow {
      HStack(spacing: 12) {
        AppIconImage(side: 32)
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: "capcomd \(AppInfo.version)").font(.system(size: 13, weight: .semibold)).foregroundStyle(ST.t1)
          Text(verbatim: versionLine(skew)).font(.system(size: 11.5)).foregroundStyle(ST.t3)
            .lineLimit(2).fixedSize(horizontal: false, vertical: true)
            .textSelection(.enabled)
        }
      }
    } value: {
      if case .daemonOlder(_, _, true) = skew, model.cliFound, let s = model.session {
        Button("Restart capcomd") { s.startDaemon() }.prominent()
      }
    }
    .accessibilityIdentifier("settings-version")
  }

  private func versionLine(_ skew: VersionSkew?) -> String {
    if let skew { return skew.message }
    guard let d = model.daemonVersion else { return model.connection == .unreachable ? "capcomd isn't running" : "Not connected to capcomd" }
    if AppInfo.bundleVersion == nil { return "Development build · capcomd \(d) is running" }
    return d == AppInfo.version ? "Up to date with the capcomd that's running" : "capcomd \(d) is running"
  }

  @ViewBuilder private var openAtLoginRow: some View {
    let on = Binding(get: { loginStatus == .enabled || loginStatus == .requiresApproval }, set: { v in
      do { try LoginItem.set(v); loginError = nil } catch { loginError = error.localizedDescription }
      readLoginStatus()
    })
    if !LoginItem.available {
      SRow("Open at login") { SSwitch(title: "Open at login", isOn: .constant(false)).disabled(true) }
    } else if loginStatus == .requiresApproval {
      SRow("Open at login") {
        Button("Open Login Items…") { LoginItem.openSystemSettings() }
        SSwitch(title: "Open at login", isOn: on)
      }
    } else {
      SRow("Open at login") { SSwitch(title: "Open at login", isOn: on) }
    }
  }

  private func readLoginStatus() { if LoginItem.available { loginStatus = LoginItem.status } }
}

/// App Icon's tiles (.st-ai): Dock (Orange, Night, Mono) and Menu bar (Dome, Antenna, Ring), each 84 × 58 on a blue
/// wallpaper, labelled below, the chosen one ringed.
struct AppIconPicker: View {
  @Environment(SettingsModel.self) private var model
  var body: some View {
    // Two groups of three 84 pt tiles and the divider fill the card's 560 pt exactly: 8 between, so nothing is squeezed.
    HStack(alignment: .top, spacing: 8) {
      group("Dock") {
        ForEach(AppIconStyle.allCases, id: \.self) { s in
          IconTile(title: s.title, on: model.dockIcon == s, group: "Dock icon") {
            if let img = AppIconImages.tile(s) { Image(nsImage: img).interpolation(.none) }
          } pick: { model.dockIcon = s }
        }
      }
      Rectangle().fill(Color.white.opacity(0.14)).frame(width: 0.5, height: 76).padding(.top, 24).padding(.horizontal, 2)
      group("Menu bar") {
        ForEach(MenuBarMark.allCases, id: \.self) { m in
          IconTile(title: m.title, on: model.menuBarMark == m, group: "Menu bar icon") {
            // 16 cells at 1.5 pt: whole device pixels at 2× (the board's 22 px would split cells).
            Image(nsImage: MarkImages.image(.working, mark: m)).renderingMode(.template).resizable().interpolation(.none)
              .frame(width: 24, height: 24).foregroundStyle(.white)
          } pick: { model.menuBarMark = m }
        }
      }
    }
    .padding(.top, 10).padding(.horizontal, 12).padding(.bottom, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .overlay(alignment: .bottom) { Rectangle().fill(ST.hair).frame(height: 0.5) }
  }

  private func group<C: View>(_ title: String, @ViewBuilder _ tiles: () -> C) -> some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: title).font(ST.groupLabel).foregroundStyle(ST.t2).padding(.leading, 2)
      HStack(alignment: .top, spacing: ST.tileGap) { tiles() }
        .accessibilityElement(children: .contain).accessibilityLabel(title == "Dock" ? "Dock icon" : "Menu bar icon")
    }
    .fixedSize()
  }
}

/// One icon tile: the art on the wallpaper, its name under it; a radio button.
struct IconTile<Art: View>: View {
  let title: String
  let on: Bool
  let group: String
  @ViewBuilder let art: Art
  let pick: () -> Void
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ST.tileRadius, style: .continuous)
    VStack(spacing: ST.tileLabelGap) {
      Button(action: pick) {
        art
          .frame(width: ST.tileWidth, height: ST.tileHeight)
          .background(shape.fill(ST.wallpaper))
          .overlay(shape.strokeBorder(Color.white.opacity(0.14), lineWidth: 0.5))
          .overlay(shape.inset(by: -3).stroke(ST.accent, lineWidth: 2).opacity(on ? 1 : 0))
          .contentShape(shape)
      }
      .buttonStyle(.plain)
      Text(verbatim: title).font(on ? ST.tileLabelOn : ST.tileLabel).foregroundStyle(on ? ST.t1 : ST.t2).lineLimit(1).fixedSize()
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(group): \(title)")
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    .accessibilityAction { pick() }
  }
}
#endif
