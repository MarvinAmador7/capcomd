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
    /// The opened pane's header (RexMain `.ph`).
    static let paneHeader: CGFloat = 44
    static let headerBot: CGFloat = 20
    static let bodyPadding = EdgeInsets(top: 6, leading: 16, bottom: 12, trailing: 16)
    static let paneBodyPadding = EdgeInsets(top: 4, leading: 24, bottom: 16, trailing: 24)
    static let paneReading: CGFloat = 720
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

    // Home (Home.dc.html): the mark, the title, the composer with its lift, the model menu, the Running cards.
    enum Home {
      static func hex(_ v: UInt32, _ a: Double = 1) -> Color {
        Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: a)
      }
      static let width: CGFloat = 680, top: CGFloat = 96, bottom: CGFloat = 48, gutter: CGFloat = 16
      static let markGap: CGFloat = 22, titleGap: CGFloat = 22, subtitleGap: CGFloat = 8
      static let title = Font.system(size: 30, weight: .semibold), titleTracking: CGFloat = -0.022 * 30, titleColor = hex(0xF5F5F7)
      static let subtitle = Font.system(size: 14)
      // The composer: 16 pt corners, a .5 pt ring, a soft drop shadow, the blue focus ring.
      static let cardRadius: CGFloat = 16, cardGap: CGFloat = 6
      static let cardPadding = EdgeInsets(top: 12, leading: 12, bottom: 10, trailing: 12)
      static let cardFill = hex(0x1B1B1F), cardRing = Color.white.opacity(0.16), cardHighlight = Color.white.opacity(0.04)
      static let focusRing = hex(0x0A84FF, 0.22), focusWidth: CGFloat = 3
      static let goalFont = Font.system(size: 15), goalTracking: CGFloat = -0.005 * 15
      static let chipFont = Font.system(size: 11.5)
      static let segmentOn = hex(0x3A3A3F)
      static let toolRow: CGFloat = 32
      // The model button and its menu.
      static let drvHeight: CGFloat = 28, drvFont = Font.system(size: 12), drvHover = Color.white.opacity(0.07)
      static let barOff = Color.white.opacity(0.18)
      static let menuFill = hex(0x1F1F23), menuRing = Color.white.opacity(0.14), menuRadius: CGFloat = 10, menuPadding: CGFloat = 5
      static let menuWidth: CGFloat = 260, menuGap: CGFloat = 6
      static let menuHeader = Font.system(size: 11, weight: .semibold), menuItem = Font.system(size: 12.5), menuNote = Font.system(size: 11.5)
      static let itemHeight: CGFloat = 28, itemRadius: CGFloat = 6, itemHighlight = hex(0x0A84FF, 0.9)
      static let separator = Color.white.opacity(0.10)
      // Start and the mic.
      static let go: CGFloat = 30, goFill = hex(0xF2F2F7), goArrow = hex(0x1D1D1F)
      // Running.
      static let runningTop: CGFloat = 56, runningGap: CGFloat = 8
      static let runHeight: CGFloat = 48, runRadius: CGFloat = 11, runHover = hex(0x18181C), runRing = Color.white.opacity(0.09)
      static let askRing = hex(0xFFB020, 0.6)
      static let placeTint = hex(0xC7C7CE)
      static let runTitle = Font.system(size: 13, weight: .semibold), runPhrase = Font.system(size: 12.5)
      static let runClock = Font.system(size: 12, design: .monospaced)
      static let head: CGFloat = 22, headOverlap: CGFloat = 14, headFill = hex(0x26262A)
      static let question = Font.system(size: 13, weight: .medium)
      static let button = Font.system(size: 12.5, weight: .medium), buttonHeight: CGFloat = 28, buttonRadius: CGFloat = 7
      static let buttonRing = Color.white.opacity(0.2), approveFill = hex(0xF2F2F7), approveText = hex(0x1D1D1F)
      static let header = Font.system(size: 12.5, weight: .semibold), count = Font.system(size: 12)
    }

    // The project menu (ReelMenu). Search ⌘K has its own measurements (SearchMetrics).
    enum Surface {
      static let width: CGFloat = 360
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
