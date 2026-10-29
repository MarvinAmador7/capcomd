// Traits → a pixel grid at one detail level, ported from botGrid in packages/bot-avatar/src/engine.ts. Shading and
// layout are integer maths, so the grid matches the TypeScript engine cell for cell (fixtures/golden/bots.json).

/// A rendered bot: w×h cells in raster order, each -1 (empty) or an index into `palette` (hex "#RRGGBB" or
/// "#RRGGBBAA"; the palette is in first-use order, so the output is canonical).
public struct BotGrid: Sendable, Hashable {
  public var w: Int
  public var h: Int
  public var palette: [String]
  public var px: [Int]
  /// The 1-bit template mask: every opaque cell except the visor (the screen, its bezel and the blush on it), so the
  /// eyes and mouth stand inside a cut-out visor. The ground shadow (translucent) is not in it. For menu bar faces and
  /// tinted or clear widgets.
  public var mask: BotMask
  /// Cells that fell outside the canvas (always 0 for catalog parts; tests check).
  public var clipped: Int
  /// Face cells (eyes, mouth, blush) that missed the visor (always 0; tests check).
  public var offVisor: Int

  /// Rows of characters: "." empty, then 0-9a-z indexing the palette (the golden files' format).
  public var rows: [String] {
    let digits = Array("0123456789abcdefghijklmnopqrstuvwxyz")
    return (0..<h).map { y in
      String((0..<w).map { x -> Character in
        let v = px[y * w + x]
        return v < 0 ? "." : v < digits.count ? digits[v] : "?"
      })
    }
  }

  /// Straight (not premultiplied) RGBA bytes, 4 per cell in raster order; empty cells are 0,0,0,0.
  public func rgba() -> [UInt8] {
    let colours = palette.map(parseHexColor)
    var out = [UInt8](repeating: 0, count: w * h * 4)
    for (i, v) in px.enumerated() where v >= 0 {
      let c = colours[v]
      out[i * 4] = c.0; out[i * 4 + 1] = c.1; out[i * 4 + 2] = c.2; out[i * 4 + 3] = c.3
    }
    return out
  }
}

/// A 1-bit image: `bits[y * w + x]` is true where the cell is opaque.
public struct BotMask: Sendable, Hashable {
  public var w: Int
  public var h: Int
  public var bits: [Bool]

  public init(w: Int, h: Int, bits: [Bool]) {
    precondition(bits.count == w * h, "CapcomdBot: mask needs w×h bits")
    self.w = w; self.h = h; self.bits = bits
  }

  /// From rows of "#" (opaque) and "." (clear), all the same width.
  public init(rows: [String]) {
    let cells = rows.map { Array($0.utf8) }
    let w = cells.first?.count ?? 0
    precondition(cells.allSatisfy { $0.count == w }, "CapcomdBot: mask rows differ in width")
    self.init(w: w, h: cells.count, bits: cells.flatMap { $0.map { $0 == UInt8(ascii: "#") } })
  }

  /// Rows of "#" (opaque) and "." (clear).
  public var rows: [String] {
    (0..<h).map { y in String((0..<w).map { bits[y * w + $0] ? "#" : "." }) }
  }

  public subscript(x: Int, y: Int) -> Bool { bits[y * w + x] }
}

/// "#RRGGBB" or "#RRGGBBAA" → (r, g, b, a); anything else is transparent black.
func parseHexColor(_ hex: String) -> (UInt8, UInt8, UInt8, UInt8) {
  let s = Array(hex.utf8.dropFirst())
  guard hex.hasPrefix("#"), s.count == 6 || s.count == 8 else { return (0, 0, 0, 0) }
  func byte(_ i: Int) -> UInt8 {
    func nib(_ c: UInt8) -> UInt8 {
      switch c {
      case UInt8(ascii: "0")...UInt8(ascii: "9"): c - UInt8(ascii: "0")
      case UInt8(ascii: "a")...UInt8(ascii: "f"): c - UInt8(ascii: "a") + 10
      case UInt8(ascii: "A")...UInt8(ascii: "F"): c - UInt8(ascii: "A") + 10
      default: 0
      }
    }
    return nib(s[i]) << 4 | nib(s[i + 1])
  }
  return (byte(0), byte(2), byte(4), s.count == 8 ? byte(6) : 255)
}

/// Light comes from the top left. Integer maths only: 0 (highlight), 1 (base) or 2 (shade). `lx, ly` are the cell in
/// its sprite (w×h), `x, y` the cell on the canvas.
func tone(_ lx: Int, _ ly: Int, _ w: Int, _ h: Int, _ x: Int, _ y: Int, _ style: DitherStyle, _ bayer: [[Int]]) -> Int {
  // lx, ly ≥ 0, so Swift's truncating division is JavaScript's Math.floor here.
  let ny = h > 1 ? (ly * 16) / (h - 1) : 8
  let nx = w > 1 ? (lx * 16) / (w - 1) : 8
  let L = 2 * ny + nx // 0 (top left) .. 48 (bottom right)
  let t = bayer[y & 3][x & 3]
  let even = (x + y) & 1 == 0
  let hi: Bool, sh: Bool
  switch style {
  case .flat: hi = L <= 5; sh = L >= 40
  case .checker: hi = L <= 4 || (L <= 9 && even); sh = L >= 42 || (L >= 34 && even)
  case .bayer: hi = L < 11 && (11 - L) * 16 > t * 11; sh = L > 31 && (L - 31) * 16 > t * 13
  case .scan: hi = L <= 6 && y & 1 == 0; sh = L >= 44 || (L >= 35 && y & 1 == 1)
  }
  return hi ? 0 : sh ? 2 : 1
}

private let dot = UInt8(ascii: ".")
private let keyV = UInt8(ascii: "V")
private let keyS = UInt8(ascii: "S")
private let faceKeys: Set<UInt8> = [UInt8(ascii: "E"), UInt8(ascii: "e"), UInt8(ascii: "M"), UInt8(ascii: "K")]

private struct Painter {
  let W: Int, H: Int
  let frame: BotFrame
  let pal: [String: String]
  let k: [String: String]
  let scr: [String: String]
  let style: DitherStyle
  let bayer: [[Int]]
  var px: [Int]
  /// 0 empty, 1 bot, 2 ground shadow.
  var kind: [UInt8]
  var onVisor: [Bool]
  /// Cells the template mask cuts out (the visor and what tints it).
  var cut: [Bool]
  var palette: [String] = []
  var paletteIndex: [String: Int] = [:]
  var clipped = 0, offVisor = 0

  init(frame: BotFrame, pal: [String: String], constants: [String: String], screen: [String: String], style: DitherStyle, bayer: [[Int]]) {
    W = frame.w; H = frame.h; self.frame = frame; self.pal = pal; k = constants; scr = screen; self.style = style; self.bayer = bayer
    px = [Int](repeating: -1, count: W * H); kind = [UInt8](repeating: 0, count: W * H)
    onVisor = [Bool](repeating: false, count: W * H); cut = onVisor
  }

  mutating func idx(_ hex: String) -> Int {
    if let i = paletteIndex[hex] { return i }
    palette.append(hex); paletteIndex[hex] = palette.count - 1
    return palette.count - 1
  }

  func color(_ key: UInt8, _ lx: Int, _ ly: Int, _ w: Int, _ h: Int, _ x: Int, _ y: Int) throws -> String {
    func tn() -> Int { tone(lx, ly, w, h, x, y, style, bayer) }
    func get(_ d: [String: String], _ name: String) throws -> String {
      guard let v = d[name] else { throw BotError.unknownColor(name) }
      return v
    }
    switch key {
    case UInt8(ascii: "B"): return try get(pal, "body\(tn())")
    case UInt8(ascii: "b"): return try get(pal, "body2")
    case UInt8(ascii: "H"): return try get(pal, "body0")
    case UInt8(ascii: "A"): return try get(pal, "accent\(tn())")
    case UInt8(ascii: "a"): return try get(pal, "accent2")
    case UInt8(ascii: "T"): return try get(pal, "trim0")
    case UInt8(ascii: "t"): return try get(pal, "trim1")
    case UInt8(ascii: "P"): return try get(pal, "deep")
    case UInt8(ascii: "L"): return try get(pal, "plateInk")
    case UInt8(ascii: "G"): return try get(k, "metal\(tn())")
    case UInt8(ascii: "g"): return try get(k, "metal2")
    case UInt8(ascii: "W"): return try get(k, "white")
    case UInt8(ascii: "I"): return try get(k, "ink")
    case UInt8(ascii: "F"): return try get(k, "flame")
    case UInt8(ascii: "S"): return try get(k, "shadow")
    default:
      let name = String(UnicodeScalar(key))
      guard let v = scr[name] else { throw BotError.unknownPixelKey(name) }
      return v
    }
  }

  /// Draw `a` with its anchor on `at` (mirrored: flipped left-right, anchor flipped too). Returns its origin.
  /// `face` marks eyes, mouth and blush (checked against the visor); `tint` marks cells the template mask cuts out.
  @discardableResult
  mutating func draw(_ a: BotArt?, _ at: BotPoint, mirror: Bool = false, face: Bool = false, tint: Bool = false) throws -> BotPoint {
    guard let a, let first = a.cells.first else { return at }
    let w = first.count, h = a.cells.count
    let an = a.anchor ?? BotPoint(0, 0)
    let ox = at.x - (mirror ? w - an.x : an.x), oy = at.y - an.y
    func cell(_ q: Int, _ s: Int) -> UInt8? {
      guard s >= 0, s < h, q >= 0, q < a.cells[s].count else { return nil }
      return a.cells[s][q]
    }
    for r in 0..<h {
      for c in 0..<w {
        let sc = mirror ? w - 1 - c : c
        guard let key = cell(sc, r), key != dot else { continue }
        let x = ox + c, y = oy + r
        if x < 0 || y < 0 || x >= W || y >= H { clipped += 1; continue }
        let i = y * W + x
        if face && faceKeys.contains(key) && !onVisor[i] { offVisor += 1 }
        onVisor[i] = key == keyV || (face && onVisor[i])
        // A screen with a rim colour draws the visor's border cells in it (a bezel) on small and full, so light
        // screens still read as screens.
        let rim = key == keyV && scr["v"] != nil && frame.outline
          && [(sc - 1, r), (sc + 1, r), (sc, r - 1), (sc, r + 1)].contains { cell($0.0, $0.1) != keyV }
        let hex = try rim ? scr["v"]! : color(key, c, r, w, h, x, y)
        let v = idx(hex)
        px[i] = v
        kind[i] = key == keyS ? 2 : 1
        cut[i] = key == keyV || tint
      }
    }
    return BotPoint(ox, oy)
  }
}

/// Traits → a w×h grid of palette indices at one detail level, plus its template mask. Throws for traits naming a part
/// the catalog doesn't have (traits from botTraits, botTeam, withOverrides and withPart always draw).
public func botGrid(_ traits: BotTraits, size: BotSize, catalog: BotCatalog = .standard) throws -> BotGrid {
  let fr = catalog.frame(size)
  let ch = try chosenOf(traits, catalog)
  func get(_ s: BotSlot) -> BotPart { ch.first { $0.slot == s }!.part }
  func art(_ s: BotSlot) -> BotArt? { catalog.art(get(s), size) }
  func anchor(_ a: [String: BotPoint]?, _ name: String) throws -> BotPoint {
    guard let p = a?[name] else { throw BotError.missingAnchor(name) }
    return p
  }
  let screen = get(.screen)
  var scr = screen.colors ?? [:]
  if size == .xs, let xs = screen.colorsXs { scr.merge(xs) { _, new in new } }
  let style: DitherStyle = fr.shading == "flat" ? .flat : (get(.dither).style ?? .flat)
  var p = Painter(frame: fr, pal: get(.palette).colors ?? [:], constants: catalog.constants, screen: scr, style: style, bayer: catalog.bayer4)
  let W = fr.w, H = fr.h

  // Ground shadow, legs, torso (and its plate), hands; then the head and what hangs on it.
  guard let head = art(.head) else { throw BotError.missingDrawing(slot: .head, id: traits.head) }
  let ho = fr.head, ha = head.anchors
  if fr.shadow, let ground = catalog.ground { try p.draw(ground, BotPoint(W >> 1, H)) }
  if let torso = art(.torso) {
    let to = try p.draw(torso, ho + anchor(ha, "neck"))
    let ta = torso.anchors
    if let hip = ta?["hip"] { try p.draw(art(.legs), to + hip) }
    let plate = get(.plate)
    let po = try p.draw(catalog.art(plate, size), to + anchor(ta, "plate"))
    if plate.id == "letter" && size == .full, let g = catalog.glyphs[String(traits.name.prefix(1)).uppercased()] {
      try p.draw(BotArt(rows: g.map { $0.replacingOccurrences(of: "#", with: "L") }, anchor: BotPoint(0, 0)), po + BotPoint(2, 0))
    }
    if let arms = get(.pose).arms, arms.count == 2, let armL = ta?["armL"], let armR = ta?["armR"] {
      try p.draw(arms[0], to + armL, mirror: true)
      try p.draw(arms[1], to + armR)
    }
  }
  try p.draw(head, ho)
  let ear = art(.ears)
  try p.draw(ear, ho + anchor(ha, "earL"))
  try p.draw(ear, ho + anchor(ha, "earR"), mirror: true)
  let vo = ho + (try anchor(ha, "visor"))
  for s in [BotSlot.blush, .eyes, .mouth] { try p.draw(art(s), vo, face: true, tint: s == .blush) }
  try p.draw(art(.antenna), ho + anchor(ha, "top"))
  let acc = get(.accessory)
  try p.draw(catalog.art(acc, size), ho + anchor(ha, acc.attach ?? "top"))

  var mask = [Bool](repeating: false, count: W * H)
  for i in 0..<(W * H) where p.kind[i] == 1 && !p.cut[i] { mask[i] = true }
  if fr.outline {
    let ink = p.idx(catalog.constants["ink"] ?? "#000000")
    var edge: [Int] = []
    for y in 0..<H {
      for x in 0..<W {
        let i = y * W + x
        if p.kind[i] == 1 { continue }
        if (x > 0 && p.kind[i - 1] == 1) || (x < W - 1 && p.kind[i + 1] == 1) || (y > 0 && p.kind[i - W] == 1) || (y < H - 1 && p.kind[i + W] == 1) {
          edge.append(i)
        }
      }
    }
    for i in edge { p.px[i] = ink; mask[i] = true }
  }
  // Compact the palette to the colours still present, in first-use (raster) order, so output is canonical.
  var remap: [Int: Int] = [:]
  var used: [String] = []
  for v in p.px where v >= 0 && remap[v] == nil { remap[v] = used.count; used.append(p.palette[v]) }
  return BotGrid(w: W, h: H, palette: used, px: p.px.map { $0 < 0 ? -1 : remap[$0]! }, mask: BotMask(w: W, h: H, bits: mask),
                 clipped: p.clipped, offVisor: p.offVisor)
}
