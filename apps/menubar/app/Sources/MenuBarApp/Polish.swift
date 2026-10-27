#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdBot

/// A 1 pt ordered dither in brand orange: every other point lit. The footer hairlines (Polish board, item 5).
struct DitherLine: View {
  @Environment(\.colorSchemeContrast) private var contrast
  var body: some View {
    if contrast == .increased { Rectangle().fill(Theme.Craft.contrastStroke).frame(height: 1).accessibilityHidden(true) } else { dots }
  }
  private var dots: some View {
    Canvas { ctx, size in
      var x: CGFloat = 0
      while x < size.width { ctx.fill(Path(CGRect(x: x, y: 0, width: 1, height: 1)), with: .color(Theme.Polish.dither)); x += 2 }
    }
    .frame(height: 1)
    .accessibilityHidden(true)
  }
}

/// The CAPCOMD wordmark drawn from the bot catalog's 4×5 pixel glyphs, at whole points per cell (Polish board, item 7).
struct PixelWordmark: View {
  var text = "CAPCOMD"
  var cell = Theme.Polish.wordmarkCell
  var body: some View {
    let glyphs = text.uppercased().map { BotCatalog.standard.glyphs[String($0)] ?? [] }
    let advance = (4 + Theme.Polish.wordmarkGap) * cell
    Canvas { ctx, _ in
      for (i, g) in glyphs.enumerated() {
        for (y, row) in g.enumerated() {
          for (x, ch) in row.enumerated() where ch == "#" {
            ctx.fill(Path(CGRect(x: CGFloat(i) * advance + CGFloat(x) * cell, y: CGFloat(y) * cell, width: cell, height: cell)), with: .color(Theme.Polish.brand))
          }
        }
      }
    }
    .frame(width: CGFloat(glyphs.count) * advance - Theme.Polish.wordmarkGap * cell, height: 5 * cell)
    .accessibilityLabel(text)
  }
}

/// Where a bot's visor is, in cells, and the colour its eyes shine: the visor glow is centred there, not on the
/// avatar's box (Polish board, item 2).
@MainActor enum BotVisor {
  struct Key: Hashable { let traits: BotTraits; let size: BotSize }
  private static var cache: [Key: (CGPoint, Color)?] = [:]
  static func glow(_ t: BotTraits, size: BotSize) -> (center: CGPoint, color: Color)? {
    let k = Key(traits: t, size: size)
    if let hit = cache[k] { return hit.map { (center: $0.0, color: $0.1) } }
    var out: (CGPoint, Color)?
    if let g = try? botGrid(t, size: size, catalog: .standard), let screen = try? BotCatalog.standard.part(.screen, t.screen),
       let hex = (size == .xs ? screen.colorsXs?["E"] : nil) ?? screen.colors?["E"], let color = Color(hex: hex) {
      var x0 = g.w, y0 = g.h, x1 = -1, y1 = -1
      for y in 0..<g.h { for x in 0..<g.w where g.px[y * g.w + x] != -1 && !g.mask[x, y] {   // opaque but cut from the mask: the visor
        x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y)
      } }
      if x1 >= 0 { out = (CGPoint(x: CGFloat(x0 + x1 + 1) / 2, y: CGFloat(y0 + y1 + 1) / 2), color) }
    }
    cache[k] = out
    return out.map { (center: $0.0, color: $0.1) }
  }
}

extension Color {
  /// "#RRGGBB" → Color.
  init?(hex: String) {
    let h = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    guard h.count == 6, let v = UInt32(h, radix: 16) else { return nil }
    self.init(red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255)
  }
}

/// ✦ beside a run that just finished, fading out by opacity only within 300 ms (Polish board, item 8). Not shown with
/// Reduce Motion, nor for runs that ended a while ago (opening the panel later shows no sparkle).
struct FinishSparkle: View {
  let endedAtMs: Int?
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var visible = true
  @State private var bounce = 0
  var body: some View {
    let fresh = endedAtMs.map { Double(Int(Date().timeIntervalSince1970 * 1000) - $0) / 1000 < Theme.Polish.sparkleWithin } ?? false
    if fresh && !reduceMotion {
      Image(systemName: "sparkle").font(.system(size: Theme.Polish.sparkle, weight: .semibold)).foregroundStyle(Theme.accent)
        .symbolEffect(.bounce, value: bounce)   // one system bounce; macOS drops it with Reduce Motion
        .opacity(visible ? 1 : 0)
        .onAppear { bounce += 1; withAnimation(.easeOut(duration: Theme.Polish.sparkleFade).delay(0.4)) { visible = false } }
        .accessibilityHidden(true)
    }
  }
}
#endif
