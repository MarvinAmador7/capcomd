// Fixed identity marks (not generated): the menu bar icon. 1-bit, drawn as a template image ("#" opaque, "." clear),
// so macOS tints it for light and dark menu bars and for the highlighted state. The mark never animates: each face is
// a separate still image.

/// The 16×16 menu bar mark (approved: variant A, the dome with no antenna): the brand dome head with a visor cut out of
/// it, two eyes and a smile. `MENU_BAR_MARK` in packages/bot-avatar/src/marks.ts.
public let menuBarMark: [String] = [
  "................",
  "................",
  "....########....",
  "..############..",
  ".##############.",
  ".###........###.",
  ".##..##..##..##.",
  ".##..##..##..##.",
  ".##..........##.",
  ".##...####...##.",
  ".###........###.",
  ".##############.",
  "..############..",
  "...##########...",
  "................",
  "................",
]

/// The Antenna mark (Settings › General › App Icon): the dome with a two-cell antenna on top. `ANTENNA_MARK` in
/// packages/bot-avatar/src/marks.ts.
public let antennaMark: [String] = {
  var r = menuBarMark
  r[0] = ".......##......."
  r[1] = ".......##......."
  return r
}()

/// The Ring mark (Settings › General › App Icon): the original capcomd ring with its centre dot. `RING_MARK` in
/// packages/bot-avatar/src/marks.ts.
public let ringMark: [String] = [
  "................",
  ".....######.....",
  "...##########...",
  "..###......###..",
  ".###........###.",
  ".##..........##.",
  ".##....##....##.",
  ".##...####...##.",
  ".##...####...##.",
  ".##....##....##.",
  ".##..........##.",
  ".###........###.",
  "..###......###..",
  "...##########...",
  ".....######.....",
  "................",
]

/// Which mark the menu bar shows (Settings › General › App Icon › Menu bar). Dome is the approved mark and the default.
public enum MenuBarMark: String, CaseIterable, Sendable {
  case dome, antenna, ring

  /// The mark with its eyes open: 16 rows of "#" (opaque) and "." (clear).
  public var rows: [String] {
    switch self { case .dome: menuBarMark; case .antenna: antennaMark; case .ring: ringMark }
  }
  public var title: String {
    switch self { case .dome: "Dome"; case .antenna: "Antenna"; case .ring: "Ring" }
  }
  /// A stored value, else the default (Dome).
  public init(stored: String?) { self = stored.flatMap(MenuBarMark.init(rawValue:)) ?? .dome }
}

/// The mark's faces for the daemon's state.
public enum MenuBarFace: CaseIterable, Sendable {
  /// Nothing running: sleepy eyes.
  case idle
  /// Agents working: eyes open (the mark itself).
  case working
  /// An approval is waiting: eyes open and a mitt raised at the top right.
  case approval

  /// The Dome mark's face: 16 rows of "#" (opaque) and "." (clear).
  public var rows: [String] { rows(.dome) }

  /// This face on `mark`. The dome marks close their eyes to a line when idle; the Ring's centre dot shrinks to a bar.
  /// Every mark raises the same mitt at the top right for an approval (the antenna stays: it is in the middle).
  public func rows(_ mark: MenuBarMark) -> [String] {
    var r = mark.rows
    switch self {
    case .idle:
      switch mark {
      case .dome, .antenna:
        r[6] = ".##..........##."
        r[7] = ".##.###..###.##."
      case .ring:
        r[6] = ".##..........##."
        r[9] = ".##..........##."
      }
    case .working:
      break
    case .approval:
      r[0] = Self.mitt(r[0])
      r[1] = Self.mitt(r[1])
    }
    return r
  }

  public func mask(_ mark: MenuBarMark) -> BotMask { BotMask(rows: rows(mark)) }

  /// A row with the mitt's two cells (columns 13 and 14) set.
  private static func mitt(_ row: String) -> String {
    var c = Array(row)
    c[13] = "#"; c[14] = "#"
    return String(c)
  }

  public var mask: BotMask { BotMask(rows: rows) }
}

/// The capcomd bot (About, the reset-token alert): the brand's orange primary bot, the mascot for moments that belong to
/// no agent (`MASCOT` in design/tools/genbrand.ts, hand-picked parts, not generated from a seed). The About board names
/// it Axel.
public enum BrandBot {
  public static let name = "Axel"
  public static let mascot = BotTraits(seed: "capcomd", role: .other, name: name, parts: [
    .palette: "orange", .antenna: "ball", .accessory: "none", .head: "dome", .ears: "disc", .screen: "night", .eyes: "ovals",
    .mouth: "smile", .blush: "on", .torso: "round", .plate: "logo", .pose: "float", .legs: "boots", .dither: "checker",
  ])
  /// Smiling, as on the About board.
  public static var happy: BotTraits { (try? withOverrides(mascot, mood: .happy)) ?? mascot }
}
