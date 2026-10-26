#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdLive
import CapcomdClient

@main
struct CapcomdMenuBarApp: App {
  @State private var model = AppModel.live()
  var body: some Scene {
    MenuBarExtra {
      PanelView().environment(model)
    } label: {
      MenuBarLabel(badge: model.badgeCount)
    }
    .menuBarExtraStyle(.window)
  }
}

/// capcomd mark; amber dot + number only when approvals are pending (SPEC §4.1: the one allowed number).
struct MenuBarLabel: View {
  let badge: Int
  var body: some View {
    HStack(spacing: 2) {
      Image(systemName: "point.3.connected.trianglepath.dotted")
      if badge > 0 {
        Image(systemName: "circle.fill").foregroundStyle(Theme.amber).font(.system(size: 6))
        Text(verbatim: "\(badge)").monospacedDigit()
      }
    }
    .accessibilityLabel(badge > 0 ? "capcomd, \(badge) approvals pending" : "capcomd")
  }
}
#else
// Linux / non-SwiftUI build: the views are macOS-only. This keeps `swift build` green for the store and live targets.
@main enum CapcomdMenuBarStub { static func main() { print("CapcomdMenuBar requires macOS 14+ (SwiftUI).") } }
#endif
