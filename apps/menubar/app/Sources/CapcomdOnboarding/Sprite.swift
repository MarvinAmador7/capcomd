import Foundation

// The onboarding's bot (design/onboarding/onboarding.dc.html: ROWS, PAL, SCREEN, sprite(), head(), laptop()), pixel for
// pixel. This is the onboarding's own 16×16 sprite, not the generated bots of CapcomdBot's catalog: one fixed bot in two
// colourways, drawn at whole points per cell. CapcomdOnboardingTests reads the rows from the HTML and compares.

/// An sRGB colour as the prototype writes it ("#F28A26").
public struct RGB: Hashable, Sendable, CustomStringConvertible {
  public var r: UInt8, g: UInt8, b: UInt8
  public init(_ r: UInt8, _ g: UInt8, _ b: UInt8) { self.r = r; self.g = g; self.b = b }
  public init(hex: String) {
    let s = hex.hasPrefix("#") ? String(hex.dropFirst()) : hex
    let v = UInt32(s, radix: 16) ?? 0
    self.init(UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF))
  }
  public var description: String { String(format: "#%02X%02X%02X", r, g, b) }
}

/// One filled cell of a sprite.
public struct Cell: Hashable, Sendable {
  public var x: Int, y: Int, color: RGB
  public init(x: Int, y: Int, color: RGB) { self.x = x; self.y = y; self.color = color }
}

/// A sprite: its size in cells and its filled cells (in the prototype's order, later cells over earlier ones).
public struct PixelGrid: Hashable, Sendable {
  public var width: Int, height: Int
  public var cells: [Cell]
  public init(width: Int, height: Int, cells: [Cell]) { self.width = width; self.height = height; self.cells = cells }
}

public enum Sprite {
  public enum Colorway: String, CaseIterable, Sendable { case orange, purple }
  /// `smile` is the resting face; `happy` turns the eyes into ^ ^ (and has nothing to blink).
  public enum Mood: String, CaseIterable, Sendable { case smile, happy }

  /// The prototype's ROWS: A antenna, b/B body shade/body, H highlight, V screen, E eyes, M mouth, K cheeks, G ears,
  /// P feet.
  public static let rows: [String] = [
    ".......AA.......",
    ".......bb.......",
    ".....BBBBBB.....",
    "...BBHHBBBBBB...",
    "..BHHBBBBBBBBB..",
    "..BVVVVVVVVVVB..",
    ".GBVEVVVVVVEVBG.",
    ".GBVEVVVVVVEVBG.",
    ".GBKVVMVVMVVKBG.",
    "..BVVVVMMVVVVB..",
    "..bBBBBBBBBBBb..",
    "...bbbbbbbbbb...",
    "....BHBBBBBB....",
    "...BBPPKKPPBB...",
    "...bBBBBBBBBb...",
    "....bbb..bbb....",
  ]
  public static let palettes: [Colorway: [Character: RGB]] = [
    .orange: ["B": RGB(hex: "#F28A26"), "b": RGB(hex: "#B85D12"), "H": RGB(hex: "#FFC07A"), "A": RGB(hex: "#FFB15C"), "G": RGB(hex: "#C9620E"), "P": RGB(hex: "#7A3606")],
    .purple: ["B": RGB(hex: "#9B6BFF"), "b": RGB(hex: "#6644CC"), "H": RGB(hex: "#C9B0FF"), "A": RGB(hex: "#B795FF"), "G": RGB(hex: "#F28A26"), "P": RGB(hex: "#5232A8")],
  ]
  public static let screen: [Character: RGB] = ["V": RGB(hex: "#0C0C16"), "E": RGB(hex: "#63F5F2"), "M": RGB(hex: "#63F5F2"), "K": RGB(hex: "#F07AC8")]

  static func palette(_ c: Colorway) -> [Character: RGB] { screen.merging(palettes[c]!) { _, p in p } }

  /// The letter grid for a mood (happy swaps the eyes' lower row for ^ ^).
  public static func grid(_ mood: Mood) -> [[Character]] {
    var g = rows.map { Array($0) }
    if mood == .happy {
      g[7][4] = "V"; g[7][11] = "V"
      g[7][3] = "E"; g[7][5] = "E"; g[7][10] = "E"; g[7][12] = "E"
    }
    return g
  }

  /// The whole bot.
  public static func body(_ c: Colorway, _ mood: Mood = .smile) -> PixelGrid {
    let pal = palette(c), g = grid(mood)
    var cells: [Cell] = []
    for (y, r) in g.enumerated() { for (x, k) in r.enumerated() { if let col = pal[k] { cells.append(Cell(x: x, y: y, color: col)) } } }
    return PixelGrid(width: 16, height: 16, cells: cells)
  }

  /// The blink: the eyes' top row in the screen colour (none for happy).
  public static func lids(_ c: Colorway, _ mood: Mood = .smile) -> PixelGrid {
    let v = palette(c)["V"]!
    return PixelGrid(width: 16, height: 16, cells: mood == .happy ? [] : [Cell(x: 4, y: 6, color: v), Cell(x: 11, y: 6, color: v)])
  }

  /// The face switched off: every eye, mouth and cheek cell in the screen colour (the intro's power-on).
  public static func faceOff(_ c: Colorway, _ mood: Mood = .smile) -> PixelGrid {
    let v = palette(c)["V"]!, g = grid(mood)
    var cells: [Cell] = []
    for (y, r) in g.enumerated() { for (x, k) in r.enumerated() where k == "E" || k == "M" || k == "K" { cells.append(Cell(x: x, y: y, color: v)) } }
    return PixelGrid(width: 16, height: 16, cells: cells)
  }

  /// A mini head for the pour: the top twelve rows, columns 1–14.
  public static func head(_ c: Colorway) -> PixelGrid {
    let pal = palette(c)
    var cells: [Cell] = []
    for (y, r) in rows.prefix(12).enumerated() {
      for (x, k) in r.enumerated() where x >= 1 && x <= 14 { if let col = pal[k] { cells.append(Cell(x: x - 1, y: y, color: col)) } }
    }
    return PixelGrid(width: 14, height: 12, cells: cells)
  }

  /// The laptop he types on: a 26×14 lid with the bot mark, on a 30-cell base.
  public static func laptop() -> PixelGrid {
    let mark = [".MMMM.", "MMMMMM", "MeMMeM", "MMMMMM", ".MMMM."].map { Array($0) }
    var cells: [Cell] = []
    let edge = RGB(hex: "#4A4A5E"), fill = RGB(hex: "#2A2A38"), orange = RGB(hex: "#F28A26")
    for y in 0..<14 {
      for x in 2..<28 {
        let isEdge = y == 0 || y == 13 || x == 2 || x == 27
        let mx = x - 12, my = y - 4
        let m: Character = my >= 0 && my < 5 && mx >= 0 && mx < 6 ? mark[my][mx] : "."
        cells.append(Cell(x: x, y: y, color: isEdge ? edge : m == "M" ? orange : fill))
      }
    }
    for x in 0..<30 { cells.append(Cell(x: x, y: 14, color: RGB(hex: "#5A5A70"))) }
    for x in 1..<29 { cells.append(Cell(x: x, y: 15, color: RGB(hex: "#3A3A4A"))) }
    return PixelGrid(width: 30, height: 16, cells: cells)
  }
}

/// The prototype's seeded generator (mulberry32), bit for bit, so the pour and the background land where they do there.
public struct Mulberry32: Sendable {
  var a: Int32
  public init(seed: Int32) { a = seed }
  public mutating func next() -> Double {
    a = a &+ 0x6D2B79F5
    var t = imul(a ^ Int32(bitPattern: UInt32(bitPattern: a) >> 15), 1 | a)
    t = (t &+ imul(t ^ Int32(bitPattern: UInt32(bitPattern: t) >> 7), 61 | t)) ^ t
    return Double(UInt32(bitPattern: t ^ Int32(bitPattern: UInt32(bitPattern: t) >> 14))) / 4294967296
  }
  private func imul(_ x: Int32, _ y: Int32) -> Int32 { Int32(truncatingIfNeeded: Int64(x) &* Int64(y)) }
}

/// JavaScript's Math.round (halves round up, toward +∞).
@inline(__always) func jsRound(_ v: Double) -> Int { Int((v + 0.5).rounded(.down)) }
