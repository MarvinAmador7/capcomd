#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdDesk

/// The desktop app: one window of `DeskWindowContent` (CapcomdDesk) on a model connected to the daemon. Everything the
/// window is lives in CapcomdDesk, so the bench (CapcomdDeskBench) hosts the very same views against fixture data.
@main
struct CapcomdDesktopApp: App {
  @NSApplicationDelegateAdaptor private var delegate: DesktopDelegate
  @State private var model = DeskModel()

  /// The app is "capcomd" in the menu bar and its About/Hide/Quit items, also when run without a bundle (whose name
  /// would otherwise be the executable's, CapcomdDesktop).
  init() { ProcessInfo.processInfo.processName = "capcomd" }

  var body: some Scene {
    Window("capcomd", id: "main") {
      DeskWindowContent(model: model)
        #if DEBUG || DESK_PROBE
        .task { DeskDebug.start(model) }
        #endif
    }
    .defaultSize(width: DeskWindowContent.defaultSize.width, height: DeskWindowContent.defaultSize.height)
    .windowStyle(.hiddenTitleBar)
    .commands { DeskCommands(model: model) }
  }
}

/// A standalone app (SPEC: people may install only this one): a regular Dock app, quit when its window closes.
final class DesktopDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.regular)   // `swift run` starts with .prohibited; the bundle is .regular anyway
    NSApp.activate()
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}
#else
@main enum CapcomdDesktopStub { static func main() { print("capcomd desktop requires macOS 14+ (SwiftUI).") } }
#endif
