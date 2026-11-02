#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

/// Desktop window tokens, from design/desktop (Reel, ReelStack, ReelTabs). The boards win on any measurement.
extension Theme {
  enum Desk {
    static let ground = Color(red: 0x0E / 255, green: 0x0E / 255, blue: 0x10 / 255)
    static let column = Color(red: 0x15 / 255, green: 0x15 / 255, blue: 0x18 / 255)
    static let columnStroke = Color.white.opacity(0.09)
    static let text = Color(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF7 / 255)
    static let secondary = Color(red: 0xA9 / 255, green: 0xA9 / 255, blue: 0xB1 / 255)
    static let tertiary = Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x96 / 255)

    // Title bar: the unified toolbar's height, so the traffic lights centre on it.
    static let titleBar: CGFloat = 52
    static let titleLeading: CGFloat = 84          // clear of the traffic lights
    static let groupHeight: CGFloat = 40, groupRadius: CGFloat = 12
    static let groupFill = Color.white.opacity(0.07), groupStroke = Color.white.opacity(0.12)
    static let tabHeight: CGFloat = 28, tabRadius: CGFloat = 8, tabHead: CGFloat = 20
    static let bracketFill = Color.white.opacity(0.07), bracketStroke = Color.white.opacity(0.12)
    static let deckFill = Color.white.opacity(0.05)
    static let deckHead: CGFloat = 22, deckHeadOverlap: CGFloat = 15
    static let askFill = Theme.amber.opacity(0.14), askStroke = Theme.amber.opacity(0.55)
    static let iconButton: CGFloat = 30
    /// A crew tab's title stops here and ends with "…" (titles are at most 32 characters; most fit), so a long one never
    /// pushes the strip around. The column header's title has more room.
    static let tabTitleMax: CGFloat = 150
    static let headerTitleMax: CGFloat = 240
    /// The header's rename field: room for a 32-character name without squeezing the profile, state and clock.
    static let headerField: CGFloat = 170
    static let renameStroke = Theme.accent.opacity(0.6), renameRefused = Theme.red.opacity(0.8)

    // Reel.
    static let gap: CGFloat = 10
    static let peek: CGFloat = 44
    static let columnRadius: CGFloat = 11
    static let columnHeader: CGFloat = 40
    static let headerBot: CGFloat = 20
    static let bodyPadding = EdgeInsets(top: 6, leading: 16, bottom: 12, trailing: 16)
    static let composerHeight: CGFloat = 40, composerRadius: CGFloat = 10, composerFill = Color.white.opacity(0.06)
    static let decisionFill = Color(red: 0x1F / 255, green: 0x1C / 255, blue: 0x17 / 255)
    /// The goal branch's ready card at the planner's foot: a neutral step down from the column (no board yet).
    static let goalFill = Color(red: 0x1A / 255, green: 0x1A / 255, blue: 0x1E / 255)

    // Type.
    static let name = Font.system(size: 12.5, weight: .semibold)
    static let label = Font.system(size: 12.5)
    static let meta = Font.system(size: 11.5)
    static let mono = Font.system(size: 11, design: .monospaced)
    static let question = Font.system(size: 15, weight: .semibold)
    static let goalTitle = Font.system(size: 13, weight: .semibold, design: .monospaced)

    // The new project column (ReelNew): the planner-to-be, the composer card, the dashed space for the crew.
    static let crewDash = Color.white.opacity(0.12)
    enum NewProject {
      static let botCell: CGFloat = 3.5                  // the full bot (32 cells) at 112 pt
      static let greetingGap: CGFloat = 12, greetingBottom: CGFloat = 36, shadowLift: CGFloat = 14
      static let dither = Color(red: 0x2C / 255, green: 0x2C / 255, blue: 0x31 / 255)
      static let cardMargin: CGFloat = 10, cardRadius: CGFloat = 14, cardGap: CGFloat = 6
      static let cardPadding = EdgeInsets(top: 10, leading: 10, bottom: 8, trailing: 10)
      static let cardFill = Color(red: 0x1D / 255, green: 0x1D / 255, blue: 0x21 / 255), cardStroke = Color.white.opacity(0.14)
      static let goalFont = Font.system(size: 14)
      static let chipFont = Font.system(size: 11.5)
      static let segmentOn = Color(red: 0x3A / 255, green: 0x3A / 255, blue: 0x3F / 255)
    }

    // The project menu (ReelMenu) and the ⌘K palette: one surface.
    enum Surface {
      static let width: CGFloat = 360, paletteWidth: CGFloat = 480
      static let fill = Color(red: 0x23 / 255, green: 0x23 / 255, blue: 0x26 / 255), stroke = Color.white.opacity(0.14)
      static let radius: CGFloat = 13, padding: CGFloat = 6
      static let rowHeight: CGFloat = 30, rowRadius: CGFloat = 7, rowPadding: CGFloat = 10, rowGap: CGFloat = 10
      static let rowFont = Font.system(size: 13), keyFont = Font.system(size: 12), icon: CGFloat = 15
      static let hover = Color.white.opacity(0.08), selected = Theme.accent.opacity(0.28)
      static let divider = Color.white.opacity(0.10)
      static let goalFont = Font.system(size: 13.5, weight: .semibold)
      static let chipFont = Font.system(size: 11.5), chipFill = Color.white.opacity(0.07)
      static let placeFont = Font.system(size: 11.5)
      static let scrim = Color.black.opacity(0.4)
    }

    /// Columns across: three at 1440 pt, two at 1100, one under 760 (SPEC §2).
    static func columnsAcross(_ width: CGFloat) -> Int { width >= 1280 ? 3 : width >= 900 ? 2 : 1 }
  }
}
#endif
