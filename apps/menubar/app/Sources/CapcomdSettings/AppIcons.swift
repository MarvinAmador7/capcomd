#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// The Dock icon follows the windows: shown while one is open (the main window or Settings, minimized included), hidden
/// when the last closes, unless Show app icon keeps it (Dock and menu bar, Dock only). The rules are `Presence`
/// (AppShell.swift); the choice is stored as the two switches it replaced.
@MainActor package enum AppPresence {
  package static let keepInDockKey = "capcomd.keepInDock", showInMenuBarKey = "capcomd.showInMenuBar"
  package static var keepInDock: Bool { UserDefaults.standard.bool(forKey: keepInDockKey) }
  package static var showInMenuBar: Bool {
    Presence.showsInMenuBar(keepInDock: keepInDock, showInMenuBar: UserDefaults.standard.object(forKey: showInMenuBarKey) as? Bool ?? true)
  }

  /// A window of the app's own: not the menu bar item, its panel or the development panel host (off screen).
  package static func counts(_ w: NSWindow) -> Bool {
    let kind = String(describing: type(of: w))
    return (w.isVisible || w.isMiniaturized) && w.canBecomeMain && w.frame.minX > -10_000
      && !kind.contains("StatusBar") && !kind.contains("MenuBarExtra")
  }

  /// Sets the activation policy for the windows open now (`closing` is on its way out).
  package static func update(closing: NSWindow? = nil) {
    let open = NSApp.windows.contains { $0 !== closing && counts($0) }
    let dock = Presence.showsInDock(windowOpen: open, keepInDock: keepInDock, showInMenuBar: showInMenuBar)
    let policy: NSApplication.ActivationPolicy = dock ? .regular : .accessory
    if NSApp.activationPolicy() != policy {
      NSApp.setActivationPolicy(policy)
      if policy == .regular { DockIcon.reapply() }   // a Dock icon shown again draws the bundle's until it is set again
    }
  }

  /// A window is about to show: be a regular app first, so it can come to the front with ⌘-Tab and the Dock icon.
  package static func windowOpening() {
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular); DockIcon.reapply() }
    NSApp.activate()
  }

  package static func observe() {
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

/// The Dock icon's look (Settings › General › App Icon › Dock). Orange is the bundle's own icon; Night and Mono are drawn
/// the way the build draws it (CapcomdBot.AppIconArt), off the main thread, and set as the application's icon.
@MainActor package enum DockIcon {
  private static var current: AppIconStyle = .orange
  private static var images: [AppIconStyle: NSImage] = [:]

  /// The stored look, at launch.
  package static func applyStored(_ prefs: UIPreferences) { apply(AppIconStyle(stored: prefs.dockIcon)) }

  package static func apply(_ style: AppIconStyle) {
    current = style
    guard style != .orange else { NSApp.applicationIconImage = nil; return }   // the bundle's
    if let i = images[style] { NSApp.applicationIconImage = i; return }
    Task.detached(priority: .userInitiated) {
      let px = 512, bytes = AppIconArt.rgba(size: px, style: style)
      await MainActor.run {
        guard let img = AppIconImages.image(bytes, px: px, points: 256) else { return }
        images[style] = img
        if current == style { NSApp.applicationIconImage = img }
      }
    }
  }
  /// The Dock shows the icon again (the app became regular): set it once more.
  package static func reapply() { if current != .orange { apply(current) } }
}

/// The Dock icon's badge (Settings › Notifications › Badge app icon): the Needs you count, or nothing.
@MainActor package enum DockBadge {
  package static func update(_ store: CapcomdStore) {
    let n = store.prefs.badgeAppIcon ? store.needsAsks().count : 0
    let label = n > 0 ? "\(n)" : nil
    if NSApp.dockTile.badgeLabel != label { NSApp.dockTile.badgeLabel = label }
  }
}

/// Images for the icon tiles and the Dock, from RGBA bytes.
@MainActor package enum AppIconImages {
  private static var tiles: [AppIconStyle: NSImage] = [:]

  /// `px` square RGBA as an image `points` wide (so @2x when px = 2 × points).
  package static func image(_ rgba: [UInt8], px: Int, points: CGFloat) -> NSImage? {
    guard let provider = CGDataProvider(data: Data(rgba) as CFData),
          let cg = CGImage(width: px, height: px, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: px * 4, space: CGColorSpaceCreateDeviceRGB(),
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: false,
                           intent: .defaultIntent) else { return nil }
    let img = NSImage(size: NSSize(width: points, height: points))
    img.addRepresentation(NSBitmapImageRep(cgImage: cg))
    return img
  }

  /// A look as the tiles show it: `Theme`'s tile size at 2 pixels per point.
  package static func tile(_ style: AppIconStyle) -> NSImage? {
    if let i = tiles[style] { return i }
    let pts = ST.appIconTile, px = Int(pts * 2)
    let i = image(AppIconArt.rgba(size: px, style: style), px: px, points: pts)
    tiles[style] = i
    return i
  }
}

/// The menu bar mark's faces on the chosen mark, built once each.
@MainActor package enum MarkImages {
  private static var images: [String: NSImage] = [:]
  package static func image(_ f: MenuBarFace, mark: MenuBarMark = .dome) -> NSImage {
    let k = "\(mark.rawValue)-\(f)"
    if let i = images[k] { return i }
    let i = BotImages.template(f.mask(mark)); images[k] = i; return i
  }
}
#endif
