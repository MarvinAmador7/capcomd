#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdBot
import CapcomdDesk

/// The capcomd app: one Dock app with the window (CapcomdDesk's `DeskWindowContent`, the same views the bench hosts),
/// the menu bar item and its panel, and Settings. Both surfaces share one session (the token, pairing with the CLI,
/// starting the daemon) and each keeps its own store, so the panel and the window can each have a run open.
@main
struct CapcomdApp: App {
  @NSApplicationDelegateAdaptor private var delegate: AppDelegate
  @State private var session: AppSession
  @State private var desk: DeskModel
  @State private var model: AppModel

  init() {
    // "capcomd" in the menu bar and its About/Hide/Quit items, also when run without a bundle (whose name would be the
    // executable's).
    ProcessInfo.processInfo.processName = "capcomd"
    Preferences.migrate()
    let s = AppSession()
    let d = DeskModel(session: s)
    let m = AppModel.live(session: s)
    // A click on a goal branch notice opens the run in the window, on its planner's column.
    ApprovalNotifications.onOpenRun = { [weak d] rid in d?.openRun(rid); MainWindow.show() }
    _session = State(initialValue: s); _desk = State(initialValue: d); _model = State(initialValue: m)
    s.begin()
  }

  var body: some Scene {
    Window("capcomd", id: MainWindow.id) {
      DeskWindowContent(model: desk)
        #if DEBUG || DESK_PROBE
        .task { DeskDebug.start(desk) }
        #endif
    }
    .defaultSize(width: DeskWindowContent.defaultSize.width, height: DeskWindowContent.defaultSize.height)
    .windowStyle(.hiddenTitleBar)
    .commands { DeskCommands(model: desk) }

    MenuBarExtra {
      PanelView().environment(model).environment(\.threadHost, ThreadHostBox(host: model))
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

/// The window, from places that aren't a view (the Dock icon, a notification, the panel's Open button).
@MainActor enum MainWindow {
  static let id = "main"
  /// Set by the first view that has SwiftUI's openWindow (the menu bar label, always drawn).
  static var opener: OpenWindowAction?
  static func show() {
    NSApp.activate()
    if let w = NSApp.windows.first(where: { $0.identifier?.rawValue == id || $0.identifier?.rawValue.hasPrefix("\(id)-") == true }) {
      w.makeKeyAndOrderFront(nil)
    } else {
      opener?(id: id)
    }
  }
}

/// A regular Dock app that stays in the menu bar when its window closes; the Dock icon brings the window back.
final class AppDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.regular)   // `swift run` starts with .prohibited; the bundle is .regular anyway
    NSApp.activate()
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
  @Environment(\.openWindow) private var openWindow
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
    .onAppear { MainWindow.opener = openWindow }
  }
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
