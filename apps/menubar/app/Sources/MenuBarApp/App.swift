#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdBot

@main
struct CapcomdMenuBarApp: App {
  @State private var model = AppModel.live()
  var body: some Scene {
    MenuBarExtra {
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
@main enum CapcomdMenuBarStub { static func main() { print("CapcomdMenuBar requires macOS 14+ (SwiftUI).") } }
#endif
