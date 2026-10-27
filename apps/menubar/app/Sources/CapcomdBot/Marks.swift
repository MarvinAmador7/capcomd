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

/// The mark's faces for the daemon's state.
public enum MenuBarFace: CaseIterable, Sendable {
  /// Nothing running: sleepy eyes.
  case idle
  /// Agents working: eyes open (the mark itself).
  case working
  /// An approval is waiting: eyes open and a mitt raised at the top right.
  case approval

  /// 16 rows of "#" (opaque) and "." (clear).
  public var rows: [String] {
    var r = menuBarMark
    switch self {
    case .idle:
      r[6] = ".##..........##."
      r[7] = ".##.###..###.##."
    case .working:
      break
    case .approval:
      r[0] = ".............##."
      r[1] = ".............##."
    }
    return r
  }

  public var mask: BotMask { BotMask(rows: rows) }
}
