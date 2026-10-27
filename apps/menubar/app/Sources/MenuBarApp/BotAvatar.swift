#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdBot

/// Bot avatars (brand direction B, apps/menubar/design/brand): drawn from the engine's pixel grid into a bitmap and
/// shown with no interpolation, at a whole number of points per cell, so they stay crisp at 1x and 2x.
@MainActor
enum BotImages {
  struct Key: Hashable { let traits: BotTraits; let size: BotSize }
  private static var cache: [Key: NSImage] = [:]

  /// One device pixel per cell; the view scales it by a whole factor with `.interpolation(.none)`.
  static func image(_ traits: BotTraits, size: BotSize) -> NSImage? {
    let key = Key(traits: traits, size: size)
    if let hit = cache[key] { return hit }
    guard let grid = try? botGrid(traits, size: size, catalog: .standard), let cg = cgImage(rgba: grid.rgba(), w: grid.w, h: grid.h) else { return nil }
    let img = NSImage(cgImage: cg, size: NSSize(width: grid.w, height: grid.h))
    if cache.count > 512 { cache.removeAll() }
    cache[key] = img
    return img
  }

  /// A 1-bit mask as a template image (opaque where set), `cell` points per cell, drawn at 2 device pixels per point.
  static func template(_ mask: BotMask, cell: CGFloat = 1) -> NSImage {
    let scale = 2, w = mask.w * scale, h = mask.h * scale
    var px = [UInt8](repeating: 0, count: w * h * 4)
    for y in 0..<h { for x in 0..<w where mask[x / scale, y / scale] { px[(y * w + x) * 4 + 3] = 255 } }
    let img = NSImage(size: NSSize(width: CGFloat(mask.w) * cell, height: CGFloat(mask.h) * cell))
    if let cg = cgImage(rgba: px, w: w, h: h) { img.addRepresentation(NSBitmapImageRep(cgImage: cg)) }
    img.isTemplate = true
    return img
  }

  private static func cgImage(rgba: [UInt8], w: Int, h: Int) -> CGImage? {
    guard let provider = CGDataProvider(data: Data(rgba) as CFData) else { return nil }
    return CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: CGColorSpaceCreateDeviceRGB(),
                   bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: false,
                   intent: .defaultIntent)
  }
}

/// An agent's bot at one of the three sizes: xs 14 pt (tree rows, mentions), small 24 pt (thread header, handoff),
/// full 64 pt (moments). Decorative next to text that already names the agent.
struct BotAvatar: View {
  let traits: BotTraits?
  let size: BotSize
  /// Points per cell: xs 14 and small 24 at 1, full 32 at 2 (64 pt).
  var cell: CGFloat = 1

  var body: some View {
    let side = CGFloat(Self.cells(size)) * cell
    Group {
      if let traits, let img = BotImages.image(traits, size: size) {
        Image(nsImage: img).interpolation(.none).resizable().frame(width: side, height: side)
      } else {
        Color.clear.frame(width: side, height: side)
      }
    }
    .accessibilityHidden(true)
  }

  static func cells(_ s: BotSize) -> Int { switch s { case .xs: 14; case .small: 24; case .full: 32 } }
}
#endif
