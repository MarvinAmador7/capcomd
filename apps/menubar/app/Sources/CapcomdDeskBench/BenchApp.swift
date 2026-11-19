import SwiftUI
import AppKit
import CapcomdDesk

/// The bench as a SwiftUI app, as the desktop app is (PerfLoop's ADAPTER.md §3b: `bench.attach()` from the `App`'s
/// `init`): a `Window` scene in the app's style with the app's own commands (`DeskCommands`), so a scenario's ⌘K, ⌘D,
/// ⇧⌘D, ⌘W, ⇧⌘↩, ⌘J and ⌃← ⌃→ go through the real menu bar (`run.press`). Each rep adopts the scene's window
/// (`Desk.show`) and puts its own desk in it (`DeskStage`); the commands act on that desk's model. `main.swift` answers
/// the verbs that open no window before this starts.
struct DeskBenchApp: App {
  static let windowID = "bench"
  /// The command line as `prepare()` made it (main.swift), for `bench.attach`.
  static var argv: [String] = []

  init() { bench.attach(Self.argv) }

  var body: some Scene {
    Window("capcomd (bench)", id: Self.windowID) { DeskStageView() }
      .defaultSize(width: DeskWindowContent.defaultSize.width, height: DeskWindowContent.defaultSize.height)
      .windowStyle(.hiddenTitleBar)
      .commands { DeskCommands(current: { DeskStage.shared.model }) }
  }

  /// The scene's window (SwiftUI names it after the scene's id).
  static func isScene(_ w: NSWindow) -> Bool {
    let id = w.identifier?.rawValue ?? ""
    return id == windowID || id.hasPrefix("\(windowID)-")
  }
}

/// What the scene's window shows: the current rep's desk (nothing before the first rep puts one there). A new rep's desk
/// is a new view tree (`id`), as a new window's would be.
@MainActor @Observable final class DeskStage {
  static let shared = DeskStage()
  var model: DeskModel?
}

struct DeskStageView: View {
  var body: some View {
    if let m = DeskStage.shared.model {
      DeskWindowContent(model: m).id(ObjectIdentifier(m))
    } else {
      Color.black.frame(minWidth: DeskWindowContent.minSize.width, minHeight: DeskWindowContent.minSize.height)
    }
  }
}
