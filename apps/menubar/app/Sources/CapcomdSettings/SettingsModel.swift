#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import ServiceManagement
import UserNotifications
import CapcomdStore
import CapcomdUI
import CapcomdBot
import CapcomdDesk

/// What the Settings window needs from the app besides the store (the app passes its own; the bench a quiet one).
@MainActor package struct SettingsHost {
  /// Notifications can be posted (a bundled app; a `swift run` binary can't).
  package var notificationsAvailable: Bool
  /// Settings › General › Show Onboarding Again.
  package var showOnboarding: () -> Void
  /// Closes the menu bar panel (it would stay on top of the window).
  package var closePanel: () -> Void
  /// Asks for a project folder (Runs › Project › Choose Folder…).
  package var chooseFolder: (_ prompt: String) async -> String?
  /// The app's presence changed (Show app icon): the Dock icon and the menu bar item follow.
  package var presenceChanged: () -> Void

  package init(notificationsAvailable: Bool, showOnboarding: @escaping () -> Void, closePanel: @escaping () -> Void,
               chooseFolder: @escaping (String) async -> String?, presenceChanged: @escaping () -> Void) {
    self.notificationsAvailable = notificationsAvailable; self.showOnboarding = showOnboarding; self.closePanel = closePanel
    self.chooseFolder = chooseFolder; self.presenceChanged = presenceChanged
  }
  /// The bench's: nothing outside the window.
  package static var quiet: SettingsHost { SettingsHost(notificationsAvailable: false, showOnboarding: {}, closePanel: {}, chooseFolder: { _ in nil }, presenceChanged: {}) }
}

/// What the Settings window reads and does (design/desktop/settings). The rows' data and its mapping live in
/// CapcomdStore (Settings.swift, SettingsNav.swift, tested); this is the window's model and its glue to AppKit:
/// Terminal, login items, notification settings, the desk's layout.
@Observable @MainActor
package final class SettingsModel {
  @ObservationIgnored package private(set) var store: CapcomdStore
  /// The token, pairing and daemon start (nil in the bench: connected as its store is).
  @ObservationIgnored package let session: AppSession?
  @ObservationIgnored package var host: SettingsHost
  /// The window's desk, for Interface › Layout and Follow (nil in the bench).
  @ObservationIgnored package weak var desk: DeskModel?
  package private(set) var revision = 0
  /// Rows waiting on Terminal (shared with the onboarding, through AppModel).
  package var handOffs = HandOffs()
  /// Where the pane is, with Back and Forward.
  package var nav = SettingsNav()
  /// The search field's text; results replace the sidebar's list while it has any.
  package var query = ""
  /// The card a search result rang, for a second.
  package var ringed: String?

  package init(store: CapcomdStore, session: AppSession?, host: SettingsHost) {
    self.store = store; self.session = session; self.host = host
  }

  /// A new store (a new token): Settings reads it from now on.
  package func attach(_ s: CapcomdStore) { store = s; bump() }
  /// The store changed: every computed row reads `revision`, so SwiftUI redraws what changed.
  package func bump() { revision &+= 1 }

  // MARK: navigation

  package func go(_ route: SettingsRoute) { nav.go(route); query = "" }
  package func goBack() { nav.goBack() }
  package func goForward() { nav.goForward() }

  /// Opens a search result: its page, and its card ringed for a second.
  package func open(_ r: SettingsSearch.Result) {
    go(r.entry.route)
    ring(r.entry.card)
  }
  package func ring(_ card: String) {
    ringed = card
    Task { [weak self] in
      try? await Task.sleep(for: .seconds(1.2))
      if self?.ringed == card { self?.ringed = nil }
    }
  }

  /// Search over every row, the logins and the places the store holds.
  package var searchEntries: [SettingsSearch.Entry] {
    _ = revision
    let providers = SettingsRows.providers.map { (id: $0, name: PlaceNames.provider($0)) }
    let places = store.runOptions.sandboxes.map { (name: $0.name, title: placeTitle($0.name)) }
    return SettingsSearch.entries(providers: providers, places: places, boxd: store.runOptions.sandboxes.contains { $0.name == "boxd" })
  }
  package var results: [SettingsSearch.Result] { SettingsSearch.results(query, in: searchEntries) }

  // MARK: connection

  /// The Keychain read is still out (macOS may be asking whether this build can read the token).
  package var tokenPending: Bool { session?.token == .reading }
  /// No token yet: pairing, or it couldn't (no CLI, or it failed).
  package var tokenMissing: Bool {
    guard let s = session else { return false }
    switch s.token { case .pairing, .needsCLI, .failed: return true; default: return false }
  }
  package var connection: ConnectionState {
    _ = revision
    return .of(tokenPending: tokenPending, tokenMissing: tokenMissing, unauthorized: store.unauthorized,
               unreachable: store.daemonUnreachable, version: store.daemonVersion)
  }
  package var daemonVersion: String? { _ = revision; return store.daemonVersion }
  package var versionSkew: VersionSkew? { _ = revision; return session?.skew(daemon: store.daemonVersion) }
  package var tokenFromEnvironment: Bool { session?.tokenFromEnvironment ?? false }
  package var cliFound: Bool { session?.cli != nil }
  package func submitToken(_ raw: String) -> Bool { session?.submit(pasted: raw) ?? false }

  // MARK: General

  package var serviceInfo: ServiceInfo? { _ = revision; return store.service?.value }
  package var serviceState: ServiceState { _ = revision; return SettingsRows.service(store.service) }
  /// The daemon has no `GET /v1/service` (older capcomd): the row is hidden.
  package var serviceUnsupported: Bool { _ = revision; return store.service == .unavailable(.unsupported) }
  package var gitignoreCapcomd: Bool {
    get { _ = revision; return store.prefs.gitignoreCapcomd }
    set { store.prefs.gitignoreCapcomd = newValue; bump() }
  }
  package var gitignoreSupported: Bool { _ = revision; return store.projectGitSupported }
  package var botFaces: Bool {
    get { _ = revision; return store.prefs.botFaces }
    set { store.prefs.botFaces = newValue; bump() }
  }
  package var menuBarMark: MenuBarMark {
    get { _ = revision; return MenuBarMark(stored: store.prefs.menuBarMark) }
    set { store.prefs.menuBarMark = newValue == .dome ? nil : newValue.rawValue; bump() }
  }
  package var dockIcon: AppIconStyle {
    get { _ = revision; return AppIconStyle(stored: store.prefs.dockIcon) }
    set { store.prefs.dockIcon = newValue == .orange ? nil : newValue.rawValue; bump(); DockIcon.apply(newValue) }
  }
  /// Show app icon: the two stored switches as one choice.
  package var showAppIcon: Presence.ShowAppIcon {
    get { _ = revision; return Presence.ShowAppIcon(keepInDock: AppPresence.keepInDock, showInMenuBar: AppPresence.showInMenuBar) }
    set {
      UserDefaults.standard.set(newValue.keepInDock, forKey: AppPresence.keepInDockKey)
      UserDefaults.standard.set(newValue.showInMenuBar, forKey: AppPresence.showInMenuBarKey)
      bump(); host.presenceChanged()
    }
  }

  // MARK: Notifications

  package var notifyApprovals: Bool {
    get { _ = revision; return store.prefs.notifyApprovals }
    set { store.prefs.notifyApprovals = newValue; bump() }
  }
  package var notifyRunFinished: Bool {
    get { _ = revision; return store.prefs.notifyRunFinished }
    set { store.prefs.notifyRunFinished = newValue; bump() }
  }
  package var notifyUsageLimits: Bool {
    get { _ = revision; return store.prefs.notifyUsageLimits }
    set { store.prefs.notifyUsageLimits = newValue; bump() }
  }
  package var badgeAppIcon: Bool {
    get { _ = revision; return store.prefs.badgeAppIcon }
    set { store.prefs.badgeAppIcon = newValue; bump(); DockBadge.update(store) }
  }

  // MARK: Interface

  /// Layout: the sidebar (opened) or the reel (folded), the value ⌃⌘S stores.
  package var sidebarLayout: Bool {
    get { _ = revision; return desk?.nav.sidebarOpen ?? UserDefaults.standard.bool(forKey: "desk.sidebarOpen") }
    set {
      if let desk { desk.setSidebar(open: newValue) } else { UserDefaults.standard.set(newValue, forKey: "desk.sidebarOpen") }
      bump()
    }
  }
  package var columnsAcross: InterfacePrefs.Columns {
    get { _ = revision; return InterfacePrefs.Columns(stored: UserDefaults.standard.integer(forKey: InterfacePrefs.columnsKey)) }
    set { UserDefaults.standard.set(newValue.stored, forKey: InterfacePrefs.columnsKey); bump(); DeskPrefs.changed() }
  }
  package var crewTabs: InterfacePrefs.CrewTabs {
    get { _ = revision; return InterfacePrefs.CrewTabs(stored: UserDefaults.standard.string(forKey: InterfacePrefs.crewTabsKey)) }
    set { UserDefaults.standard.set(newValue.rawValue, forKey: InterfacePrefs.crewTabsKey); bump(); DeskPrefs.changed() }
  }
  /// Follow asks and failures: the value Follow starts with; changing it here changes the open window's too.
  package var followAtLaunch: Bool {
    get { _ = revision; return InterfacePrefs.followAtLaunch(UserDefaults.standard.object(forKey: InterfacePrefs.followKey)) }
    set { UserDefaults.standard.set(newValue, forKey: InterfacePrefs.followKey); desk?.follow = newValue; bump() }
  }

  // MARK: Accounts

  package var accountPlaces: [String] { _ = revision; return SettingsRows.accountPlaces(store.runOptions, store.logins?.value) }
  package var loginRows: [LoginRow] {
    _ = revision
    return SettingsRows.logins(store.logins, options: store.runOptions, capabilities: store.capabilities, places: accountPlaces)
  }
  package var boxdKey: BoxdKeyState { _ = revision; return SettingsRows.boxdKey(store.runOptions) }
  /// The login new runs need and don't have: the default driver's AI where new runs go (Accounts' amber count, and the
  /// one prominent Log In…).
  package var neededLogin: LoginRow? {
    _ = revision
    let provider = store.startDriver?.provider ?? "claude"
    guard let place = store.defaultPlace?.name else { return nil }
    return loginRows.first { $0.provider == provider && $0.sandbox == place && $0.state == .notLoggedIn }
  }

  // MARK: Runs

  package var hasRunOptions: Bool { _ = revision; return store.capabilities.contains(Capability.runsOptions) && !store.runOptions.sandboxes.isEmpty }
  package var sandboxes: [SandboxInfo] { _ = revision; return store.runOptions.sandboxes }
  package var defaultPlace: SandboxInfo? { _ = revision; return store.defaultPlace }
  package func setDefaultPlace(_ name: String) { store.setDefaultPlace(name); bump() }
  package var startRepo: String? {
    get { _ = revision; return store.prefs.startRepo }
    set { store.prefs.startRepo = newValue; bump(); let s = store; Task { await s.refreshRunOptions() } }
  }
  package var startDriver: DriverInfo? { _ = revision; return store.startDriver }
  package func pickDriver(_ provider: String) { store.pickDriver(provider); bump() }
  package var startEffort: String? { _ = revision; return store.startEffort }
  package func pickEffort(_ effort: String?) { store.pickEffort(effort); bump() }
  package var modelMenu: ModelMenu { _ = revision; return store.modelMenu }
  package func pickModel(_ o: ModelMenu.Option) { if o.enabled { store.pickModel(o.model, driver: o.provider); bump() } }
  /// The drivers as they stand in the default place (Runs › Driven by).
  package var defaultPlaceDrivers: [DriverInfo] { _ = revision; return store.runOptions.drivers(in: store.defaultPlace?.name) }
  /// One per place agents run, in the daemon's order; nil when it can't say.
  package var environmentRows: [EnvironmentRow]? {
    _ = revision
    var places = store.runOptions.sandboxes.map(\.name)
    if places.isEmpty { places = store.environments?.value?.map(\.sandbox) ?? [] }
    return SettingsRows.environments(store.environments, places: places)
  }
  package var environmentsUnsupported: Bool { _ = revision; return store.environments == .unavailable(.unsupported) }
  package func placeTitle(_ name: String) -> String {
    descriptor(name)?.label ?? PlaceNames.title(name, label: store.runOptions.sandboxes.first { $0.name == name }?.label)
  }

  // Place pages (ADR-021)
  package var sandboxDescriptors: [SandboxDescriptor] { _ = revision; return store.capabilities.contains(Capability.sandboxes) ? store.sandboxList?.value ?? [] : [] }
  /// nil on daemons without `sandboxes`: the place is shown as before, by name.
  package func descriptor(_ name: String) -> SandboxDescriptor? {
    _ = revision
    guard store.capabilities.contains(Capability.sandboxes) else { return nil }
    return store.sandboxDescriptor(name)
  }
  package func sandboxDetail(_ name: String) -> SandboxDetail? { _ = revision; return store.sandboxDetails[name]?.value }
  package var resourcesSupported: Bool { _ = revision; return store.capabilities.contains(Capability.sandboxesResources) }
  package func sandboxResources(_ name: String) -> Fetched<ResourcePage>? { _ = revision; return store.sandboxResources[name] }
  package var loginList: [LoginInfo] { _ = revision; return store.logins?.value ?? [] }
  package func refreshSandbox(_ name: String) async {
    guard !tokenPending, !tokenMissing else { return }
    await store.refreshSandbox(name)
    bump()
  }
  package func terminalCommand(sandbox: String, resource: String) async -> TerminalCommand { await store.terminalCommand(sandbox: sandbox, resource: resource) }
  package func machineRows(_ name: String) -> [MachineRow] { _ = revision; return store.machineRows(name) }
  package func machineDeletion(_ name: String, _ id: String) -> MachineDeletion? { _ = revision; return store.machineDeletion(sandbox: name, id: id) }
  package func deleteMachine(_ name: String, _ id: String) {
    let s = store
    Task { await s.deleteMachine(sandbox: name, id: id); bump() }
  }
  package func fieldControl(_ sandbox: String, _ field: SandboxField) -> FieldControl { _ = revision; return store.fieldControl(sandbox: sandbox, field) }
  package func changeSetting(_ sandbox: String, id: String, to value: String) {
    let s = store
    Task { await s.changeSetting(sandbox: sandbox, id: id, to: value); bump() }
  }

  // MARK: reading and Terminal

  /// Reads everything Settings shows once (the window polls this while it is open), then ends the Terminal hand-offs
  /// whose rows changed.
  package func refreshSettings() async {
    guard !tokenPending, !tokenMissing else { return }
    await store.refreshSettings()
    bump()
    settleHandOffs()
  }

  /// Opens Terminal with `command` (from the daemon, so checked first) and shows "Waiting for Terminal…" on the row
  /// `key` until what it shows (`baseline`) changes.
  @discardableResult
  package func handOff(_ key: String, command: String, baseline: String) -> Bool {
    try? FileManager.default.removeItem(at: TerminalLauncher.marker(key))
    guard TerminalLauncher.run(command, name: key) else { return false }
    handOffs.start(key, command: command, baseline: baseline)
    Task { try? await Task.sleep(for: .seconds(1)); await refreshSettings() }
    return true
  }
  package func cancelHandOff(_ key: String) { handOffs.cancel(key) }

  package func settleHandOffs() {
    var now: [String: String] = [:]
    for r in loginRows { now[HandOffKey.login(r)] = r.fingerprint }
    for e in environmentRows ?? [] { now[HandOffKey.environment(e.sandbox)] = e.fingerprint }
    now[HandOffKey.service] = "\(serviceState)"
    now[HandOffKey.boxdKey] = "\(boxdKey)"
    for p in store.runOptions.sandboxes { if let d = descriptor(p.name) { now[HandOffKey.placeSetup(p.name)] = SandboxRows.status(d, place: p).fingerprint } }
    now[HandOffKey.start] = "\(connection.live)"
    // Scripts touch a marker when they end (TerminalLauncher.run): a re-login that changes nothing still ends the wait.
    let finished = Set(handOffs.open.keys.filter { FileManager.default.fileExists(atPath: TerminalLauncher.marker($0).path) })
    for k in finished { try? FileManager.default.removeItem(at: TerminalLauncher.marker(k)) }
    handOffs.settle(current: now, finished: finished, terminalRunning: TerminalLauncher.terminalRunning)
  }

  /// Reset…: the app pairs again with the CLI, which revokes the old token; both surfaces reconnect with the new one.
  /// Without the CLI, Terminal does it and the sheet takes the token: `true` then (show the sheet).
  package func resetToken() -> Bool {
    if let s = session, s.cli != nil { s.pair(); return false }
    return TerminalLauncher.resetToken()
  }
}

/// Hand-off keys: one per row that can wait on Terminal.
package enum HandOffKey {
  package static func login(_ r: LoginRow) -> String { login(provider: r.provider, sandbox: r.sandbox) }
  package static func login(provider: String, sandbox: String) -> String { "login-\(provider)-\(sandbox)" }
  package static func environment(_ sandbox: String) -> String { "env-\(sandbox)" }
  package static let service = "service"
  package static let boxdKey = "boxd-key"
  /// Set Up… on a place's status row (the command its reason names).
  package static func placeSetup(_ sandbox: String) -> String { "setup-\(sandbox)" }
  package static let start = "start"
}

/// How places and AIs are named in Settings (Cloud, never VM).
package enum PlaceNames {
  package static func title(_ name: String, label: String? = nil) -> String {
    switch name { case "docker": "Local"; case "boxd": "Cloud"; default: label ?? name }
  }
  /// The kind of place, for daemons that don't describe their places.
  package static func kind(_ name: String) -> SandboxDescriptor.Kind? {
    switch name { case "docker": .local; case "boxd": .cloud; default: nil }
  }
  /// A place's provider, under its name ("Docker", "boxd").
  package static func engine(_ name: String) -> String {
    switch name { case "docker": "Docker"; default: name }
  }
  /// The Runs on popup: "Local · Docker", "Cloud · boxd".
  package static func menu(_ s: SandboxInfo) -> String {
    switch s.name { case "docker": "Local · Docker"; case "boxd": "Cloud · boxd"; default: "\(s.label) · \(s.name)" }
  }
  /// An AI by its CLI's name, as Accounts heads its logins: "Claude Code", "Codex".
  package static func provider(_ p: String) -> String { p == "claude" ? "Claude Code" : Provider(wire: p)?.displayName ?? p }
  /// Whose plan a subscription login uses.
  package static func plan(_ p: String) -> String { p == "codex" ? "ChatGPT" : "Claude" }
  /// "No boxd API key (run capcomd setup)" → "No boxd API key": the row's button is the way to fix it.
  package static func reason(_ r: String?) -> String? {
    guard let r else { return nil }
    if let i = r.range(of: " (run ") { return String(r[..<i.lowerBound]) }
    return r
  }
}

/// What Settings finishes in Terminal: a throwaway .command file (no Automation permission needed).
package enum TerminalLauncher {
  /// Opens Terminal running `command` through a throwaway .command file, then a line saying whether it worked. Only
  /// plain capcomd commands are run (SettingsRows.isSafeCommand).
  @discardableResult
  package static func run(_ command: String, name: String) -> Bool {
    guard SettingsRows.isSafeCommand(command) else { NSSound.beep(); return false }
    return script(name: name, """
      \(command)
      rc=$?
      touch '\(marker(name).path)'
      echo
      if [ $rc -eq 0 ]; then echo "Done. capcomd Settings updates by itself; you can close this window."; else echo "That didn't work (exit $rc)."; fi
      """)
  }

  /// Open in Terminal: a shell in a machine, through the daemon's `terminalCommand`. Only a plain capcomd command runs
  /// (SettingsRows.isSafeCommand); the app never builds one.
  @discardableResult
  package static func shell(_ command: String, name: String) -> Bool {
    guard SettingsRows.isSafeCommand(command) else { NSSound.beep(); return false }
    return script(name: name, command)
  }

  /// Reset… when the app can't run the CLI itself: Terminal pairs the app again (which revokes the token it paired
  /// before) and shows the new token to paste into Settings.
  package static func resetToken() -> Bool {
    script(name: "reset-token", """
      echo "Resetting the capcomd app's token."
      \(FirstRun.pairCommand) || exit 1
      echo
      echo "Copy the token above and paste it into capcomd Settings."
      """)
  }

  /// The file a hand-off's script touches when it ends.
  package static func marker(_ name: String) -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-\(safeName(name)).done") }
  private static func safeName(_ name: String) -> String {
    let s = String(name.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    return s.isEmpty ? "settings" : s
  }

  package static func script(name: String, _ body: String) -> Bool {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-\(safeName(name)).command")
    do {
      try "#!/bin/zsh -l\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
      NSWorkspace.shared.open(url)
      return true
    } catch { NSSound.beep(); return false }
  }

  package static let terminalId = "com.apple.Terminal"
  package static var terminalRunning: Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: terminalId).isEmpty }
  /// Show Terminal / Show Log: brings Terminal's windows forward.
  package static func showTerminal() {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: terminalId).first { app.activate() }
  }
}

/// Open at login: the app itself as a login item (SMAppService). Only a bundled .app can register; a `swift run`
/// binary gets the switch disabled with a footnote instead of an error.
package enum LoginItem {
  package static var available: Bool { Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil }
  package static var status: SMAppService.Status { SMAppService.mainApp.status }
  package static func set(_ on: Bool) throws { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
  package static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Notification permission, read each time Notifications shows (System Settings can change it).
package enum NotificationPermission {
  package static func denied(available: Bool) async -> Bool {
    guard available else { return false }
    return await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .denied
  }
  package static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
}
#endif
