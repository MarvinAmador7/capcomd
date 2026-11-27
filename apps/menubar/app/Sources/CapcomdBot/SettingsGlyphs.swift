// The Settings window's section icons (design/desktop/settings/SettingsWindow.dc.html, the sidebar): mission control
// in 1-bit, 14×14 cells each, drawn in white on a gradient squircle. Runs' flame and About's panels are a second layer
// in their own colour. Fixed art, not generated; the rows are the boards' SVG paths, cell for cell.

/// A Settings page's icon: its glyph's layers (white first) and its squircle's two-stop vertical gradient.
public struct SettingsGlyph: Sendable, Hashable {
  /// One colour of the glyph: "#RRGGBB" and 14 rows of "#" (lit) and "." (clear).
  public struct Layer: Sendable, Hashable {
    public var color: String
    public var rows: [String]
    public var mask: BotMask { BotMask(rows: rows) }
  }
  public var layers: [Layer]
  /// The squircle's gradient, top to bottom ("#RRGGBB").
  public var top: String, bottom: String

  public static let side = 14

  /// General: a gear, graphite.
  public static let general = SettingsGlyph(layers: [Layer(color: "#ffffff", rows: [
    "..............",
    "......##......",
    "...#..##..#...",
    "..###.##.###..",
    "...########...",
    "...###..###...",
    ".####....####.",
    ".####....####.",
    "...###..###...",
    "...########...",
    "..###.##.###..",
    "...#..##..#...",
    "......##......",
    "..............",
  ])], top: "#a7adb8", bottom: "#4a4f59")

  /// Notifications: a comms antenna, red.
  public static let notifications = SettingsGlyph(layers: [Layer(color: "#ffffff", rows: [
    "..............",
    ".#..........#.",
    "#..#......#..#",
    "#.#...##...#.#",
    "#.#..####..#.#",
    "#..#..##..#..#",
    ".#....##....#.",
    "......##......",
    ".....####.....",
    ".....#..#.....",
    "....##..##....",
    "....#....#....",
    "...##....##...",
    "..............",
  ])], top: "#ff8a63", bottom: "#dd3524")

  /// Interface: a console window, blue.
  public static let interface = SettingsGlyph(layers: [Layer(color: "#ffffff", rows: [
    "..............",
    "..............",
    ".############.",
    ".############.",
    ".##.#........#",
    ".##.#.######.#",
    ".##.#........#",
    ".##.#.####...#",
    ".##.#........#",
    ".##.#.#####..#",
    ".##.#........#",
    ".############.",
    "..............",
    "..............",
  ])], top: "#56b0ff", bottom: "#0f55d0")

  /// Shortcuts: ⌘, slate.
  public static let shortcuts = SettingsGlyph(layers: [Layer(color: "#ffffff", rows: [
    "..............",
    "..##......##..",
    ".#..#....#..#.",
    ".#..#....#..#.",
    "..##########..",
    "....#....#....",
    "....#....#....",
    "....#....#....",
    "....#....#....",
    "..##########..",
    ".#..#....#..#.",
    ".#..#....#..#.",
    "..##......##..",
    "..............",
  ])], top: "#8792a3", bottom: "#363d49")

  /// Runs: a rocket with an amber flame, indigo.
  public static let runs = SettingsGlyph(layers: [
    Layer(color: "#ffffff", rows: [
      "......##......",
      ".....####.....",
      ".....#..#.....",
      "....##..##....",
      "....######....",
      "....######....",
      "....######....",
      "...########...",
      "..##.####.##..",
      "..#..####..#..",
      "..............",
      "..............",
      "..............",
      "..............",
    ]),
    Layer(color: "#ffcf5a", rows: [
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "......##......",
      ".....#..#.....",
      "......##......",
      "..............",
    ]),
  ], top: "#4b4fc4", bottom: "#151646")

  /// Accounts: the bot head, violet.
  public static let accounts = SettingsGlyph(layers: [Layer(color: "#ffffff", rows: [
    "..............",
    "......##......",
    "......##......",
    "...########...",
    "..##########..",
    "..#........#..",
    "..#.##..##.#..",
    "..#.##..##.#..",
    "..#........#..",
    "..#..####..#..",
    "..##########..",
    "...########...",
    "..............",
    "..............",
  ])], top: "#a684ff", bottom: "#5530cf")

  /// About: a satellite with peach panels, orange.
  public static let about = SettingsGlyph(layers: [
    Layer(color: "#ffffff", rows: [
      "..............",
      "..............",
      "......##......",
      ".......#......",
      ".....####.....",
      "###..####..###",
      "#.#..####..#.#",
      "#.##########.#",
      "#.#..####..#.#",
      "###..####..###",
      ".....####.....",
      "..............",
      "..............",
      "..............",
    ]),
    Layer(color: "#ffc58f", rows: [
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
      ".#..........#.",
      ".#..........#.",
      ".#..........#.",
      "..............",
      "..............",
      "..............",
      "..............",
      "..............",
    ]),
  ], top: "#ffa850", bottom: "#e85a08")

  public static let all: [SettingsGlyph] = [general, notifications, interface, shortcuts, runs, accounts, about]
}
