import SwiftUI
import AppKit
import CapcomdDesk

/// The bench as a SwiftUI app (`--host scene`, the default for scenarios): one `Window` scene with the same style the
/// desktop app's `Window` has, so the NSWindow subclass, hosting view, toolbar and focus machinery are the app's own.
/// The harness (fixture, model) exists before the app launches; the scene's first frame already has the columns.
struct BenchScene: App {
  static let title = "capcomd (bench)"
  nonisolated(unsafe) static var size = DeskWindowContent.defaultSize
  var body: some Scene {
    Window(Self.title, id: "bench") {
      if let h = Harness.current { DeskWindowContent(model: h.model) } else { Color.clear }
    }
    .defaultSize(width: Self.size.width, height: Self.size.height)
    .windowStyle(.hiddenTitleBar)
    .commands { if let h = Harness.current, ProcessInfo.processInfo.environment["DESKBENCH_NO_COMMANDS"] == nil { DeskCommands(model: h.model) } }
  }
}
