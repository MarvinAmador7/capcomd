#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// Team (design/desktop/team: CrewProfile, CrewStates inset 3). The boards win on any measurement; the colours are the
/// app's own where the boards' canvas tokens name the same thing (t1–t4 are Theme.Affect's, the pane is the reel's).
extension Theme.Desk {
  enum Team {
    static func hex(_ v: UInt32) -> Color { Theme.Desk.Home.hex(v) }
    // The roster: the sidebar's lines (28 pt rows, 24 pt labels), its bot in an 18 pt box (`.av`), the role word.
    static let rowBot: CGFloat = 18
    static let allProjects = "square.3.layers.3d"
    static let projectGlyph = "folder"
    // The pane: the reel's pane (11 pt corners, the column's fill and ring), its 44 pt header.
    static let headerBot: CGFloat = 24
    // The body (`.cw-col`): a 680 pt column, 36 pt above, 40 pt below; the bottom fades (`.cw-sc` mask from 88 %).
    static let column: CGFloat = 680, top: CGFloat = 36, bottom: CGFloat = 40, gutter: CGFloat = 24, fadeFrom = 0.88
    // Who it is (`.cw-hd`): the 64 pt bot (14 pt corners, its 44 pt face), 16 pt to the title (22/30 medium).
    static let botBox: CGFloat = 64, botRadius: CGFloat = 14, botCell: CGFloat = 1.375, headerGap: CGFloat = 16
    static let surface = hex(0x1C1C1E), botRing = Color.white.opacity(0.10), botHover = Color.white.opacity(0.20)
    static let title = Font.system(size: 22, weight: .medium), titleLine: CGFloat = 30, titlePad: CGFloat = 6, titleRadius: CGFloat = 6
    static let titleRing = Color.white.opacity(0.14)
    // The launcher: Home's composer, 22 pt under the title.
    static let launcherTop: CGFloat = 22
    // The sheet under it (`.cw-sheet`): tucked 14 pt under the card, 10 pt in from its sides, 18/16/6 inside.
    static let sheetFill = hex(0x151517), sheetRing = Color.white.opacity(0.08), sheetRadius: CGFloat = 14
    static let sheetTuck: CGFloat = 14, sheetInset: CGFloat = 10
    static let sheetPadding = EdgeInsets(top: 18, leading: 16, bottom: 6, trailing: 16)
    // SOUL.md (`.cw-soul`): a 24 pt header (11.5 pt mono, t3), two 13/20 lines that fade out, 8 pt under.
    static let soulHeader: CGFloat = 24, soulFont = Font.system(size: 11.5, design: .monospaced)
    static let soulText = Font.system(size: 13), soulSpacing: CGFloat = 4.5, soulLines: CGFloat = 40, soulBottom: CGFloat = 8
    static let soulFadeFrom = 0.5, soulEditorMin: CGFloat = 160, soulEditorMax: CGFloat = 420
    static let smallButton: CGFloat = 24, smallButtonRadius: CGFloat = 5, smallIcon = Font.system(size: 11)
    // The settings row (`.cw-tgb`, the thread's tool group): 40 pt, a hairline on top, its tiles, the summary at 12.5 pt.
    static let settingsRow: CGFloat = 40, settingsGap: CGFloat = 10, summaryFont = Font.system(size: 12.5)
    static let line = Color.white.opacity(0.08), tileIcon = Font.system(size: 10.5, weight: .medium), tileMark: CGFloat = 10, chevron = Font.system(size: 10, weight: .semibold)
    // Its rows opened (CrewStates inset 3, `.cs-g`, `.cs-r`): a card, 40 pt rows at 6/12, hairlines between.
    static let rowsTop: CGFloat = 4, rowsBottom: CGFloat = 10
    static let fieldRow: CGFloat = 40, fieldPadding = EdgeInsets(top: 6, leading: 12, bottom: 6, trailing: 12), fieldGap: CGFloat = 10
    static let label = Font.system(size: 13), caption = Font.system(size: 12)
    // Its controls: a pop-up (`.cs-pop`) and a stepper (`.cs-num`): 24 pt, 5 pt corners, the segment fill, 12 pt.
    static let control: CGFloat = 24, controlRadius: CGFloat = 5, seg = hex(0x2C2C2F), controlFont = Font.system(size: 12)
    static let controlPadding = EdgeInsets(top: 0, leading: 10, bottom: 0, trailing: 6), stepWidth: CGFloat = 20
    static let stepRule = Color.white.opacity(0.10), fieldWidth: CGFloat = 260
    static let tag = Color.white.opacity(0.06), tagHeight: CGFloat = 22
    // Recent work (`.cw-s`): 28 pt above, an 11 pt header (medium, 0.04 em), its rows' card 8 pt under.
    static let sectionTop: CGFloat = 28, sectionGap: CGFloat = 8, sectionFont = Font.system(size: 11, weight: .medium), sectionTracking: CGFloat = 0.44
    static let workFont = Font.system(size: 13), workMeta = Font.system(size: 12)
    // The foot (`.cw-foot`): 24 pt above, 12 pt t3, its ghost buttons (`.btn.sm.ghost`).
    static let footTop: CGFloat = 24, footFont = Font.system(size: 12), footMono = Font.system(size: 12, design: .monospaced)
    static let ghostFont = Font.system(size: 12, weight: .medium), ghostPadding: CGFloat = 8, ghostHover = Color.white.opacity(0.06)
    /// The settings row opening and SOUL.md opening: ease-out, under 300 ms, transform and opacity.
    static let open = Animation.easeOut(duration: 0.2)
  }
}
#endif
