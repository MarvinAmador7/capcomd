#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §6 tokens; where a mockup in design/ measures differently, its HTML value wins (noted per token).
/// System blue is the single accent.
enum Theme {
  /// #0A84FF, fixed: `Color.accentColor` turns graphite whenever the menu bar app isn't the active app.
  static let accent = Color(red: 0x0A / 255, green: 0x84 / 255, blue: 1.0)
  static let accentTint = accent.opacity(0.16)
  static let amber = Color(red: 1.0, green: 0xB0 / 255, blue: 0x20 / 255)      // #FFB020, approvals only
  static let red = Color(red: 1.0, green: 0x69 / 255, blue: 0x61 / 255)        // #FF6961, failures only
  static let green = Color(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255)
  static let cardFill = Color.white.opacity(0.06)
  static let hairline = Color.white.opacity(0.10)

  static let panelWidth: CGFloat = 380, panelRadius: CGFloat = 16, inset: CGFloat = 16
  static let cardRadius: CGFloat = 11, cardPadding: CGFloat = 12, cardGap: CGFloat = 8
  static let treeRow: CGFloat = 26, activityRow: CGFloat = 18, activityRegion: CGFloat = 172
  static let stripHeight: CGFloat = 30, stripCell: CGFloat = 24

  /// Project list and cards, measured from tree-card-v3.html (`.panel`, `.sec`, `.card`, `.chips`, `.tree`).
  enum Card {
    static let listPadding: CGFloat = 10                     // .panel padding (SPEC's 16 inset is for pushed views)
    static let sectionTop: CGFloat = 14, sectionLeading: CGFloat = 6, sectionBottom: CGFloat = 6
    static let sectionFont = Font.system(size: 11, weight: .semibold)
    static let sectionText = Color.white.opacity(0.45)
    static let titleFont = Font.system(size: 14, weight: .semibold)   // mockup 14; SPEC §6 says 13
    static let titleTracking: CGFloat = -0.14                         // -0.01em
    static let titleText = Color(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF7 / 255)
    static let paddingTop: CGFloat = 12, paddingHorizontal: CGFloat = 12, paddingBottom: CGFloat = 6
    static let approvalFill = Theme.amber.opacity(0.08)
    static let approvalStroke = Theme.amber.opacity(0.35)
    static let stroke: CGFloat = 0.5
    static let chipsTop: CGFloat = 7, chipGap: CGFloat = 5
    static let maxChips = 3                                  // then a "+n" chip (v5-a-final)
    static let treeTop: CGFloat = 8, treeBleed: CGFloat = 4, treeInnerTop: CGFloat = 4
    static let divider = Color.white.opacity(0.08)
  }
  /// Folder chip under a card title (`.chip`).
  enum ScopeChip {
    static let font = Font.system(size: 11.5)
    static let text = Color.white.opacity(0.60)
    static let fill = Color.white.opacity(0.07)
    static let radius: CGFloat = 5, paddingHorizontal: CGFloat = 6, paddingVertical: CGFloat = 2
    static let iconGap: CGFloat = 4, iconSize: CGFloat = 9.5, iconOpacity: Double = 0.6   // 12×10 folder outline
  }
  /// Motion: transform and opacity only, ease-out, under 300 ms; Reduce Motion drops the transform.
  enum Motion {
    static let pressScale: CGFloat = 0.97
    static let pressedOpacity: Double = 0.75                 // Reduce Motion stand-in for the press scale
    static let fast = Animation.easeOut(duration: 0.12)
    static let standard = Animation.easeOut(duration: 0.2)
    static let reduced = Animation.easeOut(duration: 0.15)   // crossfade
    static func ease(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : standard }
  }

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

/// Press feedback for mouse presses: 0.97 scale, or a dim under Reduce Motion. Keyboard activation never sets
/// `isPressed`, so keyboard-initiated actions stay unanimated.
struct PressableStyle: ButtonStyle {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .contentShape(Rectangle())
      .scaleEffect(configuration.isPressed && !reduceMotion ? Theme.Motion.pressScale : 1)
      .opacity(configuration.isPressed && reduceMotion ? Theme.Motion.pressedOpacity : 1)
      .animation(Theme.Motion.fast, value: configuration.isPressed)
  }
}

/// Folder chip for a project scope (repo or sub-path); `+n` overflow uses the same chip without the icon.
struct ScopeChip: View {
  let text: String
  var folder = true
  var body: some View {
    HStack(spacing: Theme.ScopeChip.iconGap) {
      if folder {
        Image(systemName: "folder").font(.system(size: Theme.ScopeChip.iconSize)).opacity(Theme.ScopeChip.iconOpacity)
      }
      Text(verbatim: text).font(Theme.ScopeChip.font).lineLimit(1)
    }
    .foregroundStyle(Theme.ScopeChip.text)
    .padding(.horizontal, Theme.ScopeChip.paddingHorizontal).padding(.vertical, Theme.ScopeChip.paddingVertical)
    .background(RoundedRectangle(cornerRadius: Theme.ScopeChip.radius).fill(Theme.ScopeChip.fill))
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
