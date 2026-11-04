#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdBot
import CapcomdDesk

/// The capcomd app: the window (CapcomdDesk's `DeskWindowContent`, the same views the bench hosts), the menu bar item
/// and its panel, and Settings. They're two views of one app on one store (AppSession's): what's in focus in the window
/// is marked in the panel, and every panel row (and notification) opens the window there. The menu bar item is the
/// app's home; the Dock icon shows while a window is open (AppPresence).
@main
struct CapcomdApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var session: AppSession
  @State private var desk: DeskModel
  @State private var model: AppModel
  @AppStorage(AppPresence.keepInDockKey) private var keepInDock = false
  @AppStorage(AppPresence.showInMenuBarKey) private var showInMenuBar = true

  init() {
    // "capcomd" in the menu bar and its About/Hide/Quit items, also when run without a bundle (whose name would be the
    // executable's).
    ProcessInfo.processInfo.processName = "capcomd"
    Preferences.migrate()
    let s = AppSession()
    let d = DeskModel(session: s)
    let m = AppModel.live(session: s)
    // A panel row, a notification: the window on that run, at that agent's column.
    m.openInWindow = { [weak d] rid, aid in MainWindow.show(); d?.show(run: rid, agent: aid) }
    _session = State(initialValue: s); _desk = State(initialValue: d); _model = State(initialValue: m)
    s.begin()
  }

  /// Off only while Keep in Dock is on (the app must stay reachable); dragging the item out of the menu bar sets it.
  /// SwiftUI sets it again with the same value on scene updates: only a change is written (a write updates the scene).
  private var menuBarInserted: Binding<Bool> {
    let shown = Presence.showsInMenuBar(keepInDock: keepInDock, showInMenuBar: showInMenuBar)
    return Binding(get: { shown }, set: { on in
      guard on != shown else { return }
      showInMenuBar = on
      DispatchQueue.main.async { AppPresence.update() }
    })
  }

  var body: some Scene {
    Window("capcomd", id: MainWindow.id) {
      DeskWindowContent(model: desk)
        .modifier(CaptureOpener())   // also without the menu bar item (Keep in Dock, menu bar off)
        #if DEBUG || DESK_PROBE
        .task { DeskDebug.start(desk) }
        #endif
    }
    .defaultSize(width: DeskWindowContent.defaultSize.width, height: DeskWindowContent.defaultSize.height)
    .windowStyle(.hiddenTitleBar)
    .commands { DeskCommands(model: desk) }

    MenuBarExtra(isInserted: menuBarInserted) {
      PanelView().environment(model)
    } label: {
      MenuBarLabel(badge: model.badgeCount, face: model.menuBarFace)
    }
    .menuBarExtraStyle(.window)

    // ⌘, (the app menu's Settings…) and the composer's + menu open it (design/settings).
    Settings {
      SettingsView().environment(model)
    }
  }
}

/// The window, from places that aren't a view (the Dock icon, a notification, the panel's rows and Open button).
@MainActor enum MainWindow {
  static let id = "main"
  /// Set by the first view that has SwiftUI's openWindow (the menu bar label, always drawn).
  static var opener: OpenWindowAction?
  /// Brings back the Dock icon and ⌘-Tab, activates the app and shows the window.
  static func show() {
    AppPresence.windowOpening()
    if let w = NSApp.windows.first(where: { $0.identifier?.rawValue == id || $0.identifier?.rawValue.hasPrefix("\(id)-") == true }) {
      w.makeKeyAndOrderFront(nil)
    } else {
      opener?(id: id)
    }
  }
}

/// The Dock icon follows the windows: shown while one is open (the main window or Settings, minimized included), hidden
/// when the last closes, unless Keep in Dock (or the menu bar item is off). The rules are `Presence` (AppShell.swift).
@MainActor enum AppPresence {
  static let keepInDockKey = "capcomd.keepInDock", showInMenuBarKey = "capcomd.showInMenuBar"
  static var keepInDock: Bool { UserDefaults.standard.bool(forKey: keepInDockKey) }
  static var showInMenuBar: Bool {
    Presence.showsInMenuBar(keepInDock: keepInDock, showInMenuBar: UserDefaults.standard.object(forKey: showInMenuBarKey) as? Bool ?? true)
  }

  /// A window of the app's own: not the menu bar item, its panel or the development panel host (off screen).
  static func counts(_ w: NSWindow) -> Bool {
    let kind = String(describing: type(of: w))
    return (w.isVisible || w.isMiniaturized) && w.canBecomeMain && w.frame.minX > -10_000
      && !kind.contains("StatusBar") && !kind.contains("MenuBarExtra")
  }

  /// Sets the activation policy for the windows open now (`closing` is on its way out).
  static func update(closing: NSWindow? = nil) {
    let open = NSApp.windows.contains { $0 !== closing && counts($0) }
    let dock = Presence.showsInDock(windowOpen: open, keepInDock: keepInDock, showInMenuBar: showInMenuBar)
    let policy: NSApplication.ActivationPolicy = dock ? .regular : .accessory
    if NSApp.activationPolicy() != policy { NSApp.setActivationPolicy(policy) }
  }

  /// A window is about to show: be a regular app first, so it can come to the front with ⌘-Tab and the Dock icon.
  static func windowOpening() {
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate()
  }

  static func observe() {
    let nc = NotificationCenter.default
    for name in [NSWindow.didBecomeKeyNotification, NSWindow.didBecomeMainNotification, NSWindow.didMiniaturizeNotification] {
      nc.addObserver(forName: name, object: nil, queue: .main) { _ in MainActor.assumeIsolated { update() } }
    }
    nc.addObserver(forName: NSWindow.willCloseNotification, object: nil, queue: .main) { n in
      let w = n.object as? NSWindow
      MainActor.assumeIsolated { update(closing: w) }
    }
  }
}

/// The menu bar item is the app's home: closing the last window keeps the app there (and hides the Dock icon); the Dock
/// icon, while it shows, brings the window back.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    MainActor.assumeIsolated {
      AppPresence.windowOpening()   // the window opens at launch; `swift run` starts .prohibited
      AppPresence.observe()
    }
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { false }
  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    if !hasVisibleWindows { MainActor.assumeIsolated { MainWindow.show() } }
    return true
  }
}

/// The preferences of the two apps this one replaces (the menu bar app, dev.capcomd.menubar, and the desktop app,
/// dev.capcomd.desktop), copied once into this one's, so nothing has to be chosen again. Keys already set win.
enum Preferences {
  static let oldDomains = ["dev.capcomd.menubar", "dev.capcomd.desktop"]
  static let doneKey = "capcomd.migratedFromApps"
  static func migrate(_ d: UserDefaults = .standard) {
    guard Bundle.main.bundleIdentifier != nil, !d.bool(forKey: doneKey) else { return }
    for domain in oldDomains {
      for (k, v) in d.persistentDomain(forName: domain) ?? [:] where (k.hasPrefix("capcomd.") || k.hasPrefix("desk.")) && d.object(forKey: k) == nil {
        d.set(v, forKey: k)
      }
    }
    d.set(true, forKey: doneKey)
  }
}

/// capcomd mark; amber dot + number only when approvals are pending (SPEC §4.1: the one allowed number).
struct MenuBarLabel: View {
  let badge: Int
  let face: MenuBarFace
  var body: some View {
    HStack(spacing: 2) {
      // The approved mark (the dome bot head, no antenna): a 1-bit template image, so macOS tints it for light, dark
      // and highlighted bars. Its face says what's going on; the amber dot and count stay the one number.
      Image(nsImage: MarkImages.image(face))
      if badge > 0 {
        Image(systemName: "circle.fill").foregroundStyle(Theme.amber).font(.system(size: 6))
        Text(verbatim: "\(badge)").monospacedDigit()
      }
    }
    .accessibilityLabel(badge > 0 ? "capcomd, \(badge) approvals pending" : "capcomd")
    .modifier(CaptureOpener())
  }
}

/// Keeps SwiftUI's openWindow for MainWindow.show (called from AppKit and notifications, outside any view).
struct CaptureOpener: ViewModifier {
  @Environment(\.openWindow) private var openWindow
  func body(content: Content) -> some View { content.onAppear { MainWindow.opener = openWindow } }
}
/// The three faces, built once.
@MainActor enum MarkImages {
  private static var images: [MenuBarFace: NSImage] = [:]
  static func image(_ f: MenuBarFace) -> NSImage {
    if let i = images[f] { return i }
    let i = BotImages.template(f.mask); images[f] = i; return i
  }
}
#else
// Linux / non-SwiftUI build: the views are macOS-only. This keeps `swift build` green for the store and live targets.
@main enum CapcomdAppStub { static func main() { print("capcomd requires macOS 14+ (SwiftUI).") } }
#endif
