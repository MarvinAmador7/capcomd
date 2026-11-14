#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdUI

/// Everything inside the window: the root view on its model, the thread host, the chrome and the dark scheme. The app
/// puts it in its `Window`; the bench puts the same view in an NSWindow it makes by hand, so both measure the same thing.
package struct DeskWindowContent: View {
  package static let defaultSize = CGSize(width: 1440, height: 900)
  package static let minSize = CGSize(width: 720, height: 480)
  let model: DeskModel
  package init(model: DeskModel) { self.model = model }
  package var body: some View {
    RootView()
      .environment(model)
      // The thread renderer reads bots, media and navigation through the model's narrowly observed slices.
      .environment(\.threadHost, ThreadHostBox(host: model))
      .frame(minWidth: Self.minSize.width, minHeight: Self.minSize.height)
      .background(WindowChrome())
      .preferredColorScheme(.dark)
  }
}

/// Keyboard (SPEC §4): ⌘0 Home, ⌘1–9 projects, ⌃1–9 agents, ⌃← ⌃→ the neighbour column, ⇧⌘N Home with the composer
/// focused, ⌘K search, and the project menu's ⌘L, ⌥⌘P and ⌘W. None of these animate. An item whose action the open
/// project doesn't have does nothing (⌘W also leaves Home for the open project, and removes a finished project from the
/// title bar).
package struct DeskCommands: Commands {
  let model: DeskModel
  package init(model: DeskModel) { self.model = model }
  package var body: some Commands {
    // File: New Project, and ⌘W folds instead of closing the window (the window's own Close is replaced). The items stay
    // enabled with fixed titles: Commands don't follow the model's changes, so an item that does nothing now does nothing.
    CommandGroup(replacing: .newItem) {
      Button("New Project") { model.openNewProject() }.keyboardShortcut("n", modifiers: [.command, .shift])
    }
    CommandGroup(replacing: .saveItem) {
      Button("Fold into the Title Bar") { model.foldShortcut() }.keyboardShortcut("w", modifiers: .command)
    }
    CommandMenu("Project") {
      Button("Search…") { model.togglePalette() }.keyboardShortcut("k", modifiers: .command)
      Divider()
      Button("Message the Planner…") { model.messagePlannerShortcut() }.keyboardShortcut("l", modifiers: .command)
      Button("Pause or Resume Project") { model.pauseShortcut() }.keyboardShortcut("p", modifiers: [.command, .option])
      Button("Stop Project…") { if let i = model.menuItem("stop") { model.perform(i) } }
      Divider()
      Button("Copy Run ID") { if let i = model.menuItem("copy") { model.perform(i) } }
    }
    NeedsYouCommands(model: model)
    CommandMenu("Go") {
      Button("Home") { model.toggleHome() }.keyboardShortcut("0", modifiers: .command)
      Divider()
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
      WindowChrome.apply(to: w)
    }
  }
  /// The same chrome on a window made by hand (the bench's).
  package static func apply(to w: NSWindow) {
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
#endif
