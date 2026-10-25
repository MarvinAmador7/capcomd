#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §6 tokens. System blue is the single accent.
enum Theme {
  static let accent = Color.accentColor           // system blue #0A84FF in dark
  static let accentTint = Color.accentColor.opacity(0.16)
  static let amber = Color(red: 1.0, green: 0xB0 / 255, blue: 0x20 / 255)      // #FFB020, approvals only
  static let red = Color(red: 1.0, green: 0x69 / 255, blue: 0x61 / 255)        // #FF6961, failures only
  static let green = Color(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255)
  static let cardFill = Color.white.opacity(0.06)
  static let hairline = Color.white.opacity(0.10)

  static let panelWidth: CGFloat = 380, panelRadius: CGFloat = 16, inset: CGFloat = 16
  static let cardRadius: CGFloat = 11, cardPadding: CGFloat = 12, cardGap: CGFloat = 8
  static let treeRow: CGFloat = 26, activityRow: CGFloat = 18, activityRegion: CGFloat = 172
  static let stripHeight: CGFloat = 30, stripCell: CGFloat = 24

  static let cardTitle = Font.system(size: 13, weight: .semibold)
  static let panelTitle = Font.system(size: 15, weight: .semibold)
  static let body = Font.system(size: 13)
  static let treeRowFont = Font.system(size: 12.5)
  static let activityFont = Font.system(size: 12)
  static let chip = Font.system(size: 11)
  static let caption = Font.system(size: 10.5, weight: .semibold)
  static let monoTime = Font.system(size: 10.5, design: .monospaced)
  static let monoCode = Font.system(size: 11.5, design: .monospaced)

  static func color(_ t: Tint) -> Color {
    switch t {
    case .grey: .secondary
    case .blue: accent
    case .amber: amber
    case .red: red
    case .tertiary: Color(nsColor: .tertiaryLabelColor)
    }
  }
}

/// SPEC §7 motion with Reduce Motion paths (150 ms crossfade, no translation).
extension Animation {
  static func capcomd(_ reduceMotion: Bool, spring duration: Double = 0.35) -> Animation {
    reduceMotion ? .easeInOut(duration: 0.15) : .spring(duration: duration, bounce: 0)
  }
}
extension AnyTransition {
  static func push(_ reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .asymmetric(insertion: .move(edge: .trailing), removal: .move(edge: .leading))
  }
}

/// Profile icon: grey by default, blue running, amber on approval. "other" gets a centre dot.
struct ProfileIcon: View {
  let kind: ProfileKind
  let tint: Tint
  var body: some View {
    ZStack {
      Image(systemName: kind.symbol)
      if kind.hasCentreDot { Circle().frame(width: 3, height: 3) }
    }
    .foregroundStyle(Theme.color(tint))
    .frame(width: 14, height: 14)
    .accessibilityHidden(true)
  }
}

struct StatusMark: View {
  let status: StepStatus?
  var body: some View {
    if let s = status, let sym = s.symbol {
      Image(systemName: sym).foregroundStyle(Theme.color(s.tint)).font(.system(size: 11))
        .accessibilityLabel(String(describing: s))
    }
  }
}

struct Chip: View {
  let text: String
  var body: some View {
    Text(verbatim: text).font(Theme.chip).foregroundStyle(.secondary)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(RoundedRectangle(cornerRadius: 5).fill(Color.white.opacity(0.07)))
  }
}
#endif
