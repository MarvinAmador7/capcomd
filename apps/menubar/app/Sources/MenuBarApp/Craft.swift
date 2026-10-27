#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import UserNotifications
import CapcomdBot

/// The control layer's surface (canvas "Materials" board): Liquid Glass on macOS 26+, tinted for the one prominent
/// action, and the flat fill or material on macOS 14–15. Content (panel, cards, tree, thread) never uses it, and
/// neither do the bots. With Reduce Transparency the system draws glass opaque; the fallback goes solid too.
struct ControlSurface<S: Shape, F: ShapeStyle>: View {
  let shape: S
  let fallback: F
  var tint: Color? = nil
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

  var body: some View {
    if #available(macOS 26, *) {
      Color.clear.glassEffect(tint.map { Glass.regular.tint($0).interactive() } ?? Glass.regular.interactive(), in: shape)
    } else if reduceTransparency {
      shape.fill(Theme.Craft.solidControl)
    } else {
      shape.fill(fallback)
    }
  }
}

/// One trackpad "level change" when a decision is clicked (Craft board, item 7): only for a mouse click, never for
/// the keyboard, never on hover.
enum Haptics {
  @MainActor static func decided() {
    guard let e = NSApp.currentEvent, [.leftMouseUp, .leftMouseDown].contains(e.type) else { return }
    NSHapticFeedbackManager.defaultPerformer.perform(.levelChange, performanceTime: .now)
  }
}

/// Approval notifications carry the waiting agent's bot and Approve / Deny actions (Craft board, item 4). The bot is
/// drawn at 4× with no interpolation into a PNG the notification attaches.
@MainActor
enum ApprovalNotifications {
  nonisolated static let category = "capcomd.approval"
  nonisolated static let approve = "capcomd.approve", deny = "capcomd.deny"
  /// Decisions picked in a notification go here (set by AppModel).
  static var onDecision: ((String, Bool) -> Void)?
  private static let delegate = Delegate()

  static func register() {
    let c = UNUserNotificationCenter.current()
    let actions = [UNNotificationAction(identifier: deny, title: "Deny", options: []),
                   UNNotificationAction(identifier: approve, title: "Approve", options: [.authenticationRequired])]
    c.setNotificationCategories([UNNotificationCategory(identifier: category, actions: actions, intentIdentifiers: [], options: [])])
    c.delegate = delegate
  }

  /// A PNG of the bot at `scale` device pixels per cell, in the caches directory (the attachment is moved by the system).
  static func botAttachment(_ traits: BotTraits, id: String, scale: Int = 4) -> UNNotificationAttachment? {
    guard let grid = try? botGrid(traits, size: .small, catalog: .standard) else { return nil }
    let w = grid.w * scale, h = grid.h * scale, src = grid.rgba()
    var px = [UInt8](repeating: 0, count: w * h * 4)
    for y in 0..<h { for x in 0..<w { let s = ((y / scale) * grid.w + x / scale) * 4, d = (y * w + x) * 4; for k in 0..<4 { px[d + k] = src[s + k] } } }
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                     isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: w * 4, bitsPerPixel: 32),
          let data = rep.bitmapData else { return nil }
    px.withUnsafeBytes { data.update(from: $0.bindMemory(to: UInt8.self).baseAddress!, count: px.count) }
    guard let png = rep.representation(using: .png, properties: [:]) else { return nil }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-bot-\(id).png")
    guard (try? png.write(to: url)) != nil else { return nil }
    return try? UNNotificationAttachment(identifier: "bot", url: url, options: nil)
  }

  final class Delegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
      let id = response.notification.request.content.userInfo["approvalId"] as? String
      let action = response.actionIdentifier
      guard let id, action == ApprovalNotifications.approve || action == ApprovalNotifications.deny else { return }
      await MainActor.run { ApprovalNotifications.onDecision?(id, action == ApprovalNotifications.approve) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
      [.banner, .sound]
    }
  }
}
#endif
