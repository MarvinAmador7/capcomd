#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdUI

@main
struct CapcomdDesktopApp: App {
  @NSApplicationDelegateAdaptor private var delegate: DesktopDelegate
  @State private var model = DeskModel()

  var body: some Scene {
    Window("capcomd", id: "main") {
      RootView()
        .environment(model)
        // The thread renderer reads bots, media and navigation through the model's narrowly observed slices.
        .environment(\.threadHost, ThreadHostBox(host: model))
        .frame(minWidth: 720, minHeight: 480)
        .background(WindowChrome())
        .preferredColorScheme(.dark)
    }
    .defaultSize(width: 1440, height: 900)
    .windowStyle(.hiddenTitleBar)
    .commands { DeskCommands(model: model) }
  }
}

/// A standalone app (SPEC: people may install only this one): a regular Dock app, quit when its window closes.
final class DesktopDelegate: NSObject, NSApplicationDelegate {
  func applicationDidFinishLaunching(_ n: Notification) {
    NSApp.setActivationPolicy(.regular)   // `swift run` starts with .prohibited; the bundle is .regular anyway
    NSApp.activate()
    #if DEBUG
    DeskDebug.start()
    #endif
  }
  func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }
}

/// Keyboard (SPEC §4): ⌘1–9 projects, ⌃1–9 agents, ⌃← ⌃→ the neighbour column. None of these animate.
struct DeskCommands: Commands {
  let model: DeskModel
  var body: some Commands {
    CommandMenu("Go") {
      ForEach(1..<10) { n in
        Button("Project \(n)") { model.goToProject(n - 1) }.keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .command)
      }
      Divider()
      ForEach(1..<10) { n in
        Button("Agent \(n)") { model.goToAgent(n - 1) }.keyboardShortcut(KeyEquivalent(Character("\(n)")), modifiers: .control)
      }
      Divider()
      Button("Previous Agent") { model.moveFocus(-1) }.keyboardShortcut(.leftArrow, modifiers: .control)
      Button("Next Agent") { model.moveFocus(1) }.keyboardShortcut(.rightArrow, modifiers: .control)
      Divider()
      Button(model.follow ? "Stop Following" : "Follow") { model.follow.toggle() }.keyboardShortcut("f", modifiers: [.command, .shift])
    }
  }
}

/// The window's AppKit side: a transparent, full-size title bar made tall by an empty unified toolbar, so the
/// traffic lights sit centred on the SwiftUI title bar drawn underneath.
struct WindowChrome: NSViewRepresentable {
  func makeNSView(context: Context) -> NSView { Probe() }
  func updateNSView(_ v: NSView, context: Context) {}
  final class Probe: NSView {
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      guard let w = window, w.toolbar == nil else { return }
      w.titlebarAppearsTransparent = true
      w.titleVisibility = .hidden
      w.styleMask.insert(.fullSizeContentView)
      let t = NSToolbar(identifier: "capcomd.desktop")
      t.showsBaselineSeparator = false
      w.toolbar = t
      w.toolbarStyle = .unified
      w.isMovableByWindowBackground = false
      w.backgroundColor = NSColor(Theme.Desk.ground)
    }
  }
}
#else
@main enum CapcomdDesktopStub { static func main() { print("capcomd desktop requires macOS 14+ (SwiftUI).") } }
#endif
