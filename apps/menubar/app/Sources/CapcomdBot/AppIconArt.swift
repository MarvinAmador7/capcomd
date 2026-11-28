// The Dock icon's three looks (Settings › General › App Icon › Dock): Orange (the build's own icon), Night (an orange
// dome on dark) and Mono (a dark dome on light). Drawn the way apps/menubar/scripts/gen-icon.ts draws the build's icon:
// Apple's 824/1024 rounded square with a vertical gradient and a soft shadow, the dome mark centred on it in whole
// pixels per cell (crisp at every size) with a one-cell pixel shadow under it. Foundation only: RGBA bytes out.

import Foundation

/// A Dock icon look and its colours ("#RRGGBB").
public enum AppIconStyle: String, CaseIterable, Sendable {
  case orange, night, mono

  public var title: String {
    switch self { case .orange: "Orange"; case .night: "Night"; case .mono: "Mono" }
  }
  /// A stored value, else the default (Orange).
  public init(stored: String?) { self = stored.flatMap(AppIconStyle.init(rawValue:)) ?? .orange }

  /// The square's gradient, top to bottom; the mark; the mark's one-cell shadow.
  public var top: String { switch self { case .orange: "#FF8A2E"; case .night: "#26262A"; case .mono: "#F4F4F6" } }
  public var bottom: String { switch self { case .orange: "#F26A0C"; case .night: "#141416"; case .mono: "#D9D9DE" } }
  public var ink: String { switch self { case .orange: "#FFFFFF"; case .night: "#FF8A2A"; case .mono: "#151517" } }
  public var drop: String { switch self { case .orange: "#B8480A"; case .night: "#000000"; case .mono: "#B4B4BC" } }
}

public enum AppIconArt {
  /// The icon `size` pixels square as straight RGBA, 4 bytes per pixel in raster order (gen-icon.ts `renderIcon`).
  public static func rgba(size: Int, style: AppIconStyle, mark rows: [String] = menuBarMark) -> [UInt8] {
    var px = [UInt8](repeating: 0, count: size * size * 4)
    let mark = Cells(rows)
    let top = rgb(style.top), bottom = rgb(style.bottom), ink = rgb(style.ink), drop = rgb(style.drop)
    let s = Double(size)
    var inset = Int((Double(size * 100) / 1024).rounded())
    var cell = max(1, Int(floor((Double(size - 2 * inset) * 0.68) / Double(mark.w))))
    if mark.w * cell + 2 > size - 2 * inset { inset = max(0, (size - mark.w * cell - 2) / 2) }
    let side = Double(size - 2 * inset), radius = side * 0.225, origin = Double(inset)
    let shadow = size >= 64, blur = s * 0.022, lift = s * 0.01

    func put(_ i: Int, _ c: (Double, Double, Double), _ a: Double) {
      let da = Double(px[i + 3]) / 255, oa = a + da * (1 - a)
      guard oa > 0 else { return }
      let cs = [c.0, c.1, c.2]
      for k in 0..<3 { px[i + k] = UInt8(max(0, min(255, ((cs[k] * a + Double(px[i + k]) * da * (1 - a)) / oa).rounded()))) }
      px[i + 3] = UInt8(max(0, min(255, (oa * 255).rounded())))
    }

    for y in 0..<size {
      for x in 0..<size {
        let i = (y * size + x) * 4
        if shadow {
          let d = distance(Double(x) + 0.5, Double(y) + 0.5 - lift, origin, side, radius)
          if d < blur * 6 { put(i, (0, 0, 0), 0.28 * exp(-max(0, d) / blur)) }
        }
        var cover = 0
        for sy in 0..<4 { for sx in 0..<4 where distance(Double(x) + (Double(sx) + 0.5) / 4, Double(y) + (Double(sy) + 0.5) / 4, origin, side, radius) <= 0 { cover += 1 } }
        if cover == 0 { continue }
        let t = min(1, max(0, (Double(y) - origin) / side))
        put(i, ((top.0 + (bottom.0 - top.0) * t).rounded(), (top.1 + (bottom.1 - top.1) * t).rounded(), (top.2 + (bottom.2 - top.2) * t).rounded()), Double(cover) / 16)
      }
    }

    let mx = inset + (Int(side) - mark.w * cell) / 2, my = inset + (Int(side) - mark.h * cell) / 2
    func paint(_ oy: Int, _ c: (Double, Double, Double)) {
      for cy in 0..<mark.h { for cx in 0..<mark.w where mark.on(cx, cy) {
        for yy in 0..<cell { for xx in 0..<cell {
          let X = mx + cx * cell + xx, Y = my + oy + cy * cell + yy
          if X >= 0, Y >= 0, X < size, Y < size { put((Y * size + X) * 4, c, 1) }
        } }
      } }
    }
    if cell >= 2 { paint(cell, drop) }
    paint(0, ink)
    return px
  }

  /// Signed distance from (px, py) to the rounded square at `origin` (negative inside).
  static func distance(_ px: Double, _ py: Double, _ origin: Double, _ side: Double, _ r: Double) -> Double {
    let c = origin + side / 2, half = side / 2 - r
    let qx = abs(px - c) - half, qy = abs(py - c) - half
    return hypot(max(qx, 0), max(qy, 0)) + min(max(qx, qy), 0) - r
  }

  static func rgb(_ hex: String) -> (Double, Double, Double) {
    let c = parseHexColor(hex)
    return (Double(c.0), Double(c.1), Double(c.2))
  }

  /// The mark's lit cells, cropped to their bounding box.
  struct Cells {
    let w: Int, h: Int
    private let rows: [[UInt8]], x0: Int, y0: Int
    init(_ source: [String]) {
      let r = source.map { Array($0.utf8) }
      let hash = UInt8(ascii: "#")
      let ys = r.indices.filter { r[$0].contains(hash) }
      let xs = r.flatMap { row in row.indices.filter { row[$0] == hash } }
      x0 = xs.min() ?? 0; y0 = ys.min() ?? 0
      w = (xs.max() ?? -1) - x0 + 1; h = (ys.max() ?? -1) - y0 + 1
      rows = r
    }
    func on(_ x: Int, _ y: Int) -> Bool {
      let yy = y + y0, xx = x + x0
      return yy < rows.count && xx < rows[yy].count && rows[yy][xx] == UInt8(ascii: "#")
    }
  }
}
