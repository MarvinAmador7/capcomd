#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import ServiceManagement
import UserNotifications
import CapcomdStore
import CapcomdBot

/// What the Settings window reads and does (design/settings/*.dc.html). The rows' data and its mapping live in
/// CapcomdStore (Settings.swift, tested); this is the glue to AppKit: Terminal, login items, notification settings.
extension AppModel {
  var connection: ConnectionState {
    _ = revision
    return .of(tokenPending: tokenPending, tokenMissing: tokenMissing, unauthorized: store.unauthorized,
               unreachable: store.daemonUnreachable, version: store.daemonVersion)
  }
  var daemonVersion: String? { _ = revision; return store.daemonVersion }
  var hasRunOptions: Bool { _ = revision; return store.capabilities.contains(Capability.runsOptions) && !store.runOptions.sandboxes.isEmpty }

  // General
  var serviceInfo: ServiceInfo? { _ = revision; return store.service?.value }
  var serviceState: ServiceState { _ = revision; return SettingsRows.service(store.service) }
  /// The daemon has no `GET /v1/service` (older capcomd): the row is hidden.
  var serviceUnsupported: Bool { _ = revision; return store.service == .unavailable(.unsupported) }
  var notifyApprovals: Bool {
    get { _ = revision; return store.prefs.notifyApprovals }
    set { store.prefs.notifyApprovals = newValue; bump() }
  }
  var notifyRunFinished: Bool {
    get { _ = revision; return store.prefs.notifyRunFinished }
    set { store.prefs.notifyRunFinished = newValue; bump() }
  }
  var botFaces: Bool {
    get { _ = revision; return store.prefs.botFaces }
    set { store.prefs.botFaces = newValue; bump() }
  }

  // Accounts
  var accountPlaces: [String] { _ = revision; return SettingsRows.accountPlaces(store.runOptions, store.logins?.value) }
  var loginRows: [LoginRow] {
    _ = revision
    return SettingsRows.logins(store.logins, options: store.runOptions, capabilities: store.capabilities, places: accountPlaces)
  }
  var boxdKey: BoxdKeyState { _ = revision; return SettingsRows.boxdKey(store.runOptions) }

  // Runs
  var defaultPlace: SandboxInfo? { _ = revision; return store.defaultPlace }
  func setDefaultPlace(_ name: String) { store.setDefaultPlace(name) }
  /// The drivers as they stand in the default place (Settings › Runs › Driven by).
  var defaultPlaceDrivers: [DriverInfo] { _ = revision; return store.runOptions.drivers(in: store.defaultPlace?.name) }
  /// One per place agents run, in the daemon's order; nil when it can't say (the rows are hidden).
  var environmentRows: [EnvironmentRow]? {
    _ = revision
    var places = store.runOptions.sandboxes.map(\.name)
    if places.isEmpty { places = store.environments?.value?.map(\.sandbox) ?? [] }
    return SettingsRows.environments(store.environments, places: places)
  }
  var environmentsUnsupported: Bool { _ = revision; return store.environments == .unavailable(.unsupported) }

  // Place details (ADR-021 phase 1; SettingsPlaceDetails.swift)
  /// The daemon describes its places (`sandboxes`): sections use the descriptors and offer Details….
  var hasSandboxes: Bool { _ = revision; return store.capabilities.contains(Capability.sandboxes) && store.sandboxList?.value != nil }
  var sandboxDescriptors: [SandboxDescriptor] { _ = revision; return store.capabilities.contains(Capability.sandboxes) ? store.sandboxList?.value ?? [] : [] }
  /// nil on daemons without `sandboxes`: the place is shown as before, by name.
  func descriptor(_ name: String) -> SandboxDescriptor? {
    _ = revision
    guard store.capabilities.contains(Capability.sandboxes) else { return nil }
    return store.sandboxDescriptor(name)
  }
  func sandboxDetail(_ name: String) -> SandboxDetail? { _ = revision; return store.sandboxDetails[name]?.value }
  /// The daemon lists machines (`sandboxes.resources`).
  var resourcesSupported: Bool { _ = revision; return store.capabilities.contains(Capability.sandboxesResources) }
  func sandboxResources(_ name: String) -> Fetched<ResourcePage>? { _ = revision; return store.sandboxResources[name] }
  /// Settings can be changed from the app (`sandboxes.settings`, phase 2). Phase 1 shows them read-only.
  var sandboxSettingsEditable: Bool { false }
  var loginList: [LoginInfo] { _ = revision; return store.logins?.value ?? [] }
  func refreshSandbox(_ name: String) async {
    guard !tokenPending, !tokenMissing else { return }
    await store.refreshSandbox(name)
  }
  func terminalCommand(sandbox: String, resource: String) async -> TerminalCommand { await store.terminalCommand(sandbox: sandbox, resource: resource) }

  /// Reads everything Settings shows once (the window polls this while it is open), then ends the Terminal hand-offs
  /// whose rows changed.
  func refreshSettings() async {
    guard !tokenPending, !tokenMissing else { return }
    await store.refreshSettings()
    settleHandOffs()
  }

  /// Opens Terminal with `command` (from the daemon, so checked first) and shows "Waiting for Terminal…" on the row
  /// `key` until what it shows (`baseline`) changes.
  @discardableResult
  func handOff(_ key: String, command: String, baseline: String) -> Bool {
    try? FileManager.default.removeItem(at: TerminalLauncher.marker(key))
    guard TerminalLauncher.run(command, name: key) else { return false }
    handOffs.start(key, command: command, baseline: baseline)
    Task { try? await Task.sleep(for: .seconds(1)); await refreshSettings() }
    return true
  }
  func cancelHandOff(_ key: String) { handOffs.cancel(key) }

  func settleHandOffs() {
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

  /// Reset…: Terminal revokes this app's old token(s) and makes a new one; the sheet takes it.
  func resetToken() -> Bool { TerminalLauncher.resetToken() }
}

/// Hand-off keys: one per row that can wait on Terminal.
enum HandOffKey {
  static func login(_ r: LoginRow) -> String { "login-\(r.provider)-\(r.sandbox)" }
  static func environment(_ sandbox: String) -> String { "env-\(sandbox)" }
  static let service = "service"
  static let boxdKey = "boxd-key"
  /// Set Up… on a place's status row (the command its reason names).
  static func placeSetup(_ sandbox: String) -> String { "setup-\(sandbox)" }
  static let start = "start"
}

/// How places and AIs are named in Settings (Cloud, never VM).
enum PlaceNames {
  static func title(_ name: String, label: String? = nil) -> String {
    switch name { case "docker": "Local"; case "boxd": "Cloud"; default: label ?? name }
  }
  /// The row sub-line in Accounts (`.sub`).
  static func detail(_ name: String) -> String {
    switch name { case "docker": "Docker on this Mac"; case "boxd": "boxd machines"; default: name }
  }
  /// The Runs on popup: "Local · Docker", "Cloud · boxd".
  static func menu(_ s: SandboxInfo) -> String {
    switch s.name { case "docker": "Local · Docker"; case "boxd": "Cloud · boxd"; default: "\(s.label) · \(s.name)" }
  }
  /// The status row's label in a place's section.
  static func engine(_ name: String) -> String {
    switch name { case "docker": "Docker"; default: name }
  }
  static func provider(_ p: String) -> String { Provider(wire: p)?.displayName ?? p }
  /// Whose plan a subscription login uses.
  static func plan(_ p: String) -> String { p == "codex" ? "ChatGPT" : "Claude" }
  /// "No boxd API key (run capcomd setup)" → "No boxd API key": the row's button is the way to fix it.
  static func reason(_ r: String?) -> String? {
    guard let r else { return nil }
    if let i = r.range(of: " (run ") { return String(r[..<i.lowerBound]) }
    return r
  }
}

extension TerminalLauncher {
  /// Opens Terminal running `command` through a throwaway .command file (no Automation permission needed), then a
  /// line saying whether it worked. Only plain capcomd commands are run (SettingsRows.isSafeCommand).
  @discardableResult
  static func run(_ command: String, name: String) -> Bool {
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
  static func shell(_ command: String, name: String) -> Bool {
    guard SettingsRows.isSafeCommand(command) else { NSSound.beep(); return false }
    return script(name: name, command)
  }

  /// Reset…: revokes the active clients named "menubar" (the name `capcomd clients add menubar` gives this app's
  /// token), then makes a new one to paste into Settings. `capcomd clients list` has no token hashes, so the app's own
  /// client is found by that name.
  static func resetToken() -> Bool {
    script(name: "reset-token", """
      echo "Resetting the menu bar app's capcomd token."
      old=$(capcomd clients list | /usr/bin/osascript -l JavaScript -e 'ObjC.import("Foundation"); const d = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile; JSON.parse($.NSString.alloc.initWithDataEncoding(d, $.NSUTF8StringEncoding).js).filter(c => c.name === "menubar" && !c.revokedAt).map(c => c.id).join(" ")')
      for id in ${=old}; do capcomd clients revoke "$id" > /dev/null && echo "Revoked the old token ($id)."; done
      capcomd clients add menubar --scopes read,steer,approve,configure || exit 1
      echo
      echo "Copy the token above (between the quotes) and paste it into capcomd Settings."
      """)
  }

  /// The file a hand-off's script touches when it ends.
  static func marker(_ name: String) -> URL { FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-\(safeName(name)).done") }
  private static func safeName(_ name: String) -> String {
    let s = String(name.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    return s.isEmpty ? "settings" : s
  }

  private static func script(name: String, _ body: String) -> Bool {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-\(safeName(name)).command")
    do {
      try "#!/bin/zsh -l\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
      NSWorkspace.shared.open(url)
      return true
    } catch { NSSound.beep(); return false }
  }

  static let terminalId = "com.apple.Terminal"
  static var terminalRunning: Bool { !NSRunningApplication.runningApplications(withBundleIdentifier: terminalId).isEmpty }
  /// Show Terminal / Show Log: brings Terminal's windows forward.
  static func showTerminal() {
    if let app = NSRunningApplication.runningApplications(withBundleIdentifier: terminalId).first { app.activate() }
  }
}

/// Open at login: the app itself as a login item (SMAppService). Only a bundled .app can register; a `swift run`
/// binary gets the toggle disabled with a sub-line instead of an error.
enum LoginItem {
  static var available: Bool { Bundle.main.bundleURL.pathExtension == "app" && Bundle.main.bundleIdentifier != nil }
  static var status: SMAppService.Status { SMAppService.mainApp.status }
  static func set(_ on: Bool) throws { if on { try SMAppService.mainApp.register() } else { try SMAppService.mainApp.unregister() } }
  static func openSystemSettings() { SMAppService.openSystemSettingsLoginItems() }
}

/// Notification permission, read each time the General pane shows (System Settings can change it).
enum NotificationPermission {
  static func denied() async -> Bool {
    guard Notifier.available else { return false }
    return await UNUserNotificationCenter.current().notificationSettings().authorizationStatus == .denied
  }
  static let settingsURL = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension")!
}

enum AppInfo {
  /// The app's version: its bundle's, else (a `swift run` build) the release this source belongs to.
  static var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? fallbackVersion }
  static let fallbackVersion = "0.6.0"
  static let repo = URL(string: "https://github.com/MarvinAmador7/capcomd")!
  static let changelog = URL(string: "https://github.com/MarvinAmador7/capcomd/blob/main/CHANGELOG.md")!
  static let newIssue = URL(string: "https://github.com/MarvinAmador7/capcomd/issues/new")!
}

/// The Settings window of a menu bar (accessory) app. An accessory app can't become the active app on current macOS,
/// so its window would open behind the frontmost app and draw every control inactive. While Settings is open the app
/// is a regular app (a Dock icon, as Apple's own menu bar apps do), and goes back to an accessory when it closes.
@MainActor enum SettingsWindow {
  private static var window: NSWindow?
  private static var closeObserver: NSObjectProtocol?

  /// Settings… in the panel: close the panel (it would stay on top), become a regular app, open the window.
  static func open(_ openSettings: OpenSettingsAction) {
    closePanel()
    becomeRegular()
    openSettings()
    DispatchQueue.main.async { if let window { bringFront(window) } }
  }

  /// The Settings view found its window (⌘, or Settings…): regular app, window in front, accessory again on close.
  static func attach(_ w: NSWindow) {
    closePanel()
    becomeRegular()
    if window !== w {
      if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
      window = w
      closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { _ in
        MainActor.assumeIsolated {
          NSApp.setActivationPolicy(.accessory)
          if let o = closeObserver { NotificationCenter.default.removeObserver(o) }
          closeObserver = nil; window = nil
        }
      }
    }
    DispatchQueue.main.async { bringFront(w) }
  }

  private static func becomeRegular() {
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
  }
  private static func bringFront(_ w: NSWindow) {
    NSApp.activate()
    w.makeKeyAndOrderFront(nil)
    w.orderFrontRegardless()
  }
  /// The MenuBarExtra's panel (its window class is SwiftUI's MenuBarExtraWindow), not the detached thread readers.
  private static func closePanel() {
    for w in NSApp.windows where w.isVisible && String(describing: type(of: w)).contains("MenuBarExtra") { w.close() }
  }

  /// The tallest a pane gets before it scrolls: the screen's visible height (no menu bar, no Dock) less the window's
  /// title and tab bar.
  static var maxPaneHeight: CGFloat {
    let screen = (window?.screen ?? NSScreen.main)?.visibleFrame.height ?? 800
    let chrome = window.map { $0.frame.height - $0.contentLayoutRect.height } ?? Theme.Settings.chrome
    return max(Theme.Settings.minPane, screen - chrome)
  }

  /// Fits the window to the pane's height, top edge fixed, without animating (layout snaps, SPEC §7), inside the
  /// screen's visible frame: a window that would run under the Dock moves up first; only a pane taller than the whole
  /// visible height is capped (and scrolls, PaneFit).
  static func fit(paneHeight h: CGFloat) {
    guard let w = window else { return }
    let chrome = w.frame.height - w.contentLayoutRect.height
    let f = WindowFit.fitted(w.frame, height: (h + chrome).rounded(), visible: (w.screen ?? NSScreen.main)?.visibleFrame)
    guard f != w.frame else { return }
    w.setFrame(f, display: true, animate: false)
  }
}

/// Hands the view's window to `found` once it is in one.
struct WindowReader: NSViewRepresentable {
  let found: (NSWindow) -> Void
  func makeNSView(context: Context) -> NSView { Reader(found: found) }
  func updateNSView(_ v: NSView, context: Context) {}
  final class Reader: NSView {
    let found: (NSWindow) -> Void
    init(found: @escaping (NSWindow) -> Void) { self.found = found; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let window { let f = found; DispatchQueue.main.async { f(window) } }
    }
  }
}

/// A pane as tall as its content (the window fits it), up to the screen; past that it scrolls.
struct PaneFit: ViewModifier {
  @State private var overflow = false
  func body(content: Content) -> some View {
    let cap = SettingsWindow.maxPaneHeight
    Group {
      if overflow {
        content.frame(height: cap)
      } else {
        content.scrollDisabled(true).fixedSize(horizontal: false, vertical: true)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
      if !overflow && h > cap + 0.5 { overflow = true }
      SettingsWindow.fit(paneHeight: min(h, cap))
    }
    .onAppear { overflow = false }
  }
}
extension View {
  /// Settings panes: the window fits the pane (PaneFit).
  func paneFit() -> some View { modifier(PaneFit()) }
  /// A sheet's form: as tall as its content, up to the screen's visible height less `reserve` (SheetFit).
  func sheetFit(reserve: CGFloat) -> some View { modifier(SheetFit(reserve: reserve)) }
}

/// PaneFit for a sheet: the form is as tall as its content (a Form's own ideal height is small), and scrolls once it
/// would be taller than the screen's visible height under the window's toolbar, less the sheet's own bar (`reserve`).
struct SheetFit: ViewModifier {
  let reserve: CGFloat
  @State private var overflow = false
  func body(content: Content) -> some View {
    let cap = SettingsWindow.maxPaneHeight - reserve
    Group {
      if overflow {
        content.frame(height: cap)
      } else {
        content.scrollDisabled(true).fixedSize(horizontal: false, vertical: true)
      }
    }
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in
      if !overflow && h > cap + 0.5 { overflow = true }
    }
  }
}

/// Marks drawn from SVG paths as images, for popup menus (which take images, not shapes). Template images are tinted
/// by the menu; a `color` keeps the brand's (Claude's coral).
@MainActor enum MenuMarks {
  private static var cache: [String: NSImage] = [:]
  static func image(_ key: String, path: Path, viewBox: CGFloat, size: CGFloat, color: NSColor? = nil) -> NSImage {
    let k = "\(key)-\(size)-\(color?.description ?? "t")"
    if let hit = cache[k] { return hit }
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      let s = rect.width / viewBox
      let p = path.applying(CGAffineTransform(scaleX: s, y: s))
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.addPath(p.cgPath)
      ctx.setFillColor((color ?? .black).cgColor)
      ctx.fillPath()
      return true
    }
    img.isTemplate = color == nil
    cache[k] = img
    return img
  }
  static func provider(_ p: Provider) -> Image {
    switch p {
    case .claude: Image(nsImage: image("claude", path: ProviderMarks.claude, viewBox: 24, size: Theme.Settings.menuMark, color: NSColor(Theme.Provider.claude)))
    case .codex: Image(systemName: "circle.hexagongrid.fill")
    }
  }
  /// A place's mark by its id (PlaceMarks): bundled marks, else a glyph by kind.
  static func place(_ mark: String, kind: SandboxDescriptor.Kind? = nil) -> Image {
    switch PlaceMarks.glyph(mark, kind: kind) {
    case .path(let id, let path): Image(nsImage: image(id, path: path, viewBox: 24, size: Theme.Settings.menuMark))
    case .symbol(let s): Image(systemName: s)
    }
  }
}
#endif
