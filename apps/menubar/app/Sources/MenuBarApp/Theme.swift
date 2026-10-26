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
  /// Agent tree geometry (tree-card-v3.html `.gd`, `.cv`, `.ic`): a 16 pt guide per level, a 12 pt chevron column,
  /// then the 16 pt icon with 2/6 margins. Anything indented "to the name column" uses `nameInset`.
  enum Tree {
    static let indent: CGFloat = 16, chevron: CGFloat = 12, icon: CGFloat = 16
    static let iconLeading: CGFloat = 2, iconTrailing: CGFloat = 6
    static func nameInset(_ depth: Int) -> CGFloat { CGFloat(depth) * indent + chevron + iconLeading + icon + iconTrailing }
    /// Live activity under a running agent's row (not in the mockup; sized like the row's repo chip `.rc`).
    static let activityFont = Font.system(size: 11.5)
    static let activityText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.5)
    static let activityHeight: CGFloat = 16, activityTop: CGFloat = -4, activityBottom: CGFloat = 4
    // Rows (.tr 26 pt, 12.5 pt; .cur running; .dimr queued), guides (.gd), suffix (.sfx), folder chip (.rc), status (.stt).
    static let rowHeight: CGFloat = 26
    static let nameFont = Font.system(size: 12.5)
    static let nameRunningFont = Font.system(size: 12.5, weight: .medium)
    static let nameText = Color.white.opacity(0.78)
    static let nameRunning = Color.white
    static let nameQueued = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.42)
    static let suffixFont = Font.system(size: 10.5, design: .monospaced)
    static let suffixText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.32)
    static let suffixLeading: CGFloat = 6
    static let chipFont = Font.system(size: 11)
    static let chipIcon = Font.system(size: 9)
    static let chipText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.5)
    static let chipGap: CGFloat = 3, chipLeading: CGFloat = 8
    static let statusColumn: CGFloat = 14, statusLeading: CGFloat = 8
    static let chevronFont = Font.system(size: 9, weight: .semibold)
    static let chevronText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.35)
    /// Profile glyphs on the mockups' 14 pt outline grid (agent-icons.png, tree-card-v3.png): SF Symbols differ in
    /// natural size, so each gets the point size that lands it at the mockup's ~11–12 pt (measured on 2× captures).
    static func iconSize(_ k: ProfileKind) -> CGFloat {
      switch k { case .planner: 12; case .lead: 11.5; case .worker: 9; case .critic: 10.5; case .other: 11 }
    }
    static let iconBox: CGFloat = 14, iconDot: CGFloat = 3
    static let guide = Color.white.opacity(0.18), guideWidth: CGFloat = 0.5
    static let guideX: CGFloat = 7.5, guideElbowY: CGFloat = 13, guideArm: CGFloat = 7   // .gd:before/:after
  }
  /// Approval inline under the waiting agent (tree-card-v3.html `.apx`, `.q`, `.cmd`, `.btn`).
  enum Approval {
    static let leadingExtra: CGFloat = 2                     // .apx sits 2 pt right of the name column
    static let top: CGFloat = 2, bottom: CGFloat = 8
    static let questionFont = Font.system(size: 12, weight: .medium)
    static let questionText = Color.white
    static let questionBottom: CGFloat = 3
    static let branchFont = Font.system(size: 12, design: .monospaced)
    static let branchText = Color.white.opacity(0.6)
    static let branchBottom: CGFloat = 8
    static let buttonHeight: CGFloat = 27, buttonRadius: CGFloat = 7, buttonGap: CGFloat = 8
    static let buttonFont = Font.system(size: 12.5, weight: .medium)
    static let denyFill = Color.white.opacity(0.10)
    static let buttonText = Color.white
    static let disabledOpacity: Double = 0.5
    static let statusFont = Font.system(size: 11.5)
    static let appearRise: CGFloat = 4                       // SPEC §7: fade + 4 pt rise
  }
  /// A finished project's one-line row under the Active cards (tree-card-v3.html / v5-a-final.html `.done`).
  enum Finished {
    static let gap: CGFloat = 8
    static let paddingVertical: CGFloat = 9, paddingHorizontal: CGFloat = 12
    /// `.done` opens with an empty span, so the flex gap indents the title 8 pt past the cards' text.
    static let titleIndent: CGFloat = 8
    static let titleFont = Font.system(size: 13)
    static let titleText = Color.white.opacity(0.70)
    static let trailingFont = Font.system(size: 12)
    static let trailingText = Color.white.opacity(0.40)
    /// The most recent few: the panel is for what's happening, not history.
    static let maxRows = 3
  }
  /// Run drill-down (view-activity.html / view-trace.html / drill-collapsed.html / drill-a2-files-iconsA.html).
  enum Drill {
    static let padding: CGFloat = 10                                   // .panel padding
    // Header (.hdr padding 2 4 10, gap 8)
    static let headerPadding = EdgeInsets(top: 2, leading: 4, bottom: 10, trailing: 4)
    static let headerGap: CGFloat = 8
    static let backSize: CGFloat = 24, backRadius: CGFloat = 6
    static let backFill = Color.white.opacity(0.07)
    static let backIcon = Font.system(size: 11, weight: .semibold)
    static let crumbFont = Font.system(size: 11.5)
    static let crumbText = Color.white.opacity(0.45)
    static let titleFont = Font.system(size: 15, weight: .semibold)
    static let titleTracking: CGFloat = -0.15, titleTop: CGFloat = 1
    static let switchFont = Font.system(size: 11.5, weight: .medium)
    static let switchGap: CGFloat = 5, switchTrailing: CGFloat = 10
    static let switchOn = Color.white
    static let switchOff = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.3)
    static let timerFont = Font.system(size: 13, design: .monospaced)
    static let timerText = Color.white.opacity(0.85)
    // Step bar (.bar margin 0 4 4, gap 3, 3 tall)
    static let barGap: CGFloat = 3, barHeight: CGFloat = 3, barRadius: CGFloat = 1.5
    static let barPadding = EdgeInsets(top: 0, leading: 4, bottom: 4, trailing: 4)
    static let barDone = Theme.accent
    static let barCurrent = Theme.accent.opacity(0.45)
    static let barQueued = Color.white.opacity(0.12)
    // Activity (.reg 172, .ph, .ar)
    static let regionTop: CGFloat = 10, regionHeight: CGFloat = 172   // .reg margin-top 14 collapses with the bar's 4: 14 under the bar
    static let phaseFont = Font.system(size: 10.5, weight: .semibold)
    static let phaseText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.3)
    static let phaseHeight: CGFloat = 14
    static let rowHeight: CGFloat = 18, rowGap: CGFloat = 8, rowPadding: CGFloat = 4, iconColumn: CGFloat = 16
    static let rowFont = Font.system(size: 12)
    static let rowNowFont = Font.system(size: 12, weight: .medium)
    static let rowText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.78)
    static let rowQueued = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.32)
    static let rowFailed = Color(red: 1, green: 0x69 / 255, blue: 0x61 / 255).opacity(0.8)
    static let iconFont = Font.system(size: 12)                       // 14 pt outline glyph
    static let iconText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.45)
    static let timeFont = Font.system(size: 10.5, design: .monospaced)
    static let timeText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.38)
    static let timeGap: CGFloat = 6
    static let statusFont = Font.system(size: 11)
    // Collapsed strip (.strip, .si2, .pdv, .cvx)
    static let stripTop: CGFloat = 8, stripHeight: CGFloat = 30, stripRadius: CGFloat = 8   // .strip margin-top 12 collapses with the bar's 4
    static let stripFill = Color.white.opacity(0.04)
    static let stripPadding: CGFloat = 6, cellGap: CGFloat = 2
    static let cell: CGFloat = 24, cellRadius: CGFloat = 6
    static let cellNow = Theme.accent.opacity(0.16)
    static let cellHover = Color.white.opacity(0.10)
    static let dividerWidth: CGFloat = 1, dividerHeight: CGFloat = 12, dividerMargin: CGFloat = 6
    static let divider = Color.white.opacity(0.14)
    static let chevronColumn: CGFloat = 30
    static let chevronDivider = Color.white.opacity(0.08)
    static let edgeFade: CGFloat = 24
    // Trace (.sp, .trk, .pill)
    static let traceTop: CGFloat = 10, traceFade: CGFloat = 30
    static let spanHeight: CGFloat = 22, spanGap: CGFloat = 7, nameColumn: CGFloat = 132, durationColumn: CGFloat = 58
    static let spanText = Color.white.opacity(0.75)
    static let spanIndent: CGFloat = 14
    static let foldFont = Font.system(size: 9)
    static let foldOpacity: Double = 0.45, foldOpenOpacity: Double = 0.6, foldTrailing: CGFloat = 5
    static let laneHeight: CGFloat = 6
    static let laneFill = Color.white.opacity(0.28)
    static let laneRing = Theme.accent.opacity(0.22), laneRingWidth: CGFloat = 3
    static let laneMin: CGFloat = 4
    static let durationFont = Font.system(size: 11, design: .monospaced)
    static let durationText = Color.white.opacity(0.45)
    static let durationNow = Color.white.opacity(0.85)
    static let pillFont = Font.system(size: 11.5, weight: .medium)
    static let pillHeight: CGFloat = 22, pillBottom: CGFloat = 6
    static let pillPadding = EdgeInsets(top: 0, leading: 8, bottom: 0, trailing: 10)
    // Log | Files (.seg, .pane, .tail, .f)
    static let segWidth: CGFloat = 150, segRadius: CGFloat = 7, segInset: CGFloat = 2
    static let segPadding = EdgeInsets(top: 12, leading: 4, bottom: 8, trailing: 0)
    static let segFill = Color.white.opacity(0.08)
    static let segFont = Font.system(size: 11.5, weight: .medium)
    static let segItemHeight: CGFloat = 20, segItemRadius: CGFloat = 5
    static let segOff = Color.white.opacity(0.6)
    static let segOnFill = Color.white.opacity(0.2)
    static let paneHeight: CGFloat = 94
    static let tailHeight: CGFloat = 84                                // .tail: 4 lines × 17 + 8/8 padding
    static let tailFont = Font.system(size: 11, design: .monospaced)
    static let tailLine: CGFloat = 17
    static let tailPadding = EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
    static let tailRadius: CGFloat = 8
    static let tailFill = Color.black.opacity(0.18)
    static let tailText = Color.white.opacity(0.55)
    static let tailTime = Color.white.opacity(0.30), tailTimeGap: CGFloat = 8
    static let tailLast = Color.white.opacity(0.85)
    static let tailFade: CGFloat = 14
    static let fileHeight: CGFloat = 22, fileGap: CGFloat = 7, fileIcon: CGFloat = 14
    static let fileFont = Font.system(size: 12, design: .monospaced)
    static let fileText = Color.white.opacity(0.75)
    static let fileCountFont = Font.system(size: 11, design: .monospaced)
    static let emptyFont = Font.system(size: 11.5)
    static let emptyText = Color.white.opacity(0.4)
    // Footer (.acts, .ab)
    static let footerPadding = EdgeInsets(top: 10, leading: 12, bottom: 10, trailing: 12)
    static let footerTop: CGFloat = 10, footerGap: CGFloat = 8
    static let actionHeight: CGFloat = 26, actionPadding: CGFloat = 12, actionRadius: CGFloat = 7
    static let actionFont = Font.system(size: 12.5, weight: .medium)
    static let actionFill = Color.white.opacity(0.10)
    static let actionText = Color.white
    static let terminalText = Color.white.opacity(0.75), terminalPadding: CGFloat = 4
    // The bar under .acts is the panel footer's (Theme.Footer: .bar material, 0.5 pt white 10 % border-top).
    static let stopConfirmFill = Theme.red.opacity(0.22)
    static let stopConfirmSeconds: Double = 4
    static let errorFont = Font.system(size: 11.5)
    /// While the drill-down is open, its REST parts refresh this often.
    static let refreshSeconds: Double = 2
  }
  /// Panel footer (v5-a-final.html `.ft`): full-bleed bar over a `.bar` material, so the list scrolling under it blurs
  /// instead of showing through, with a hairline on top.
  enum Footer {
    static let paddingVertical: CGFloat = 10, paddingHorizontal: CGFloat = 16
    static let font = Font.system(size: 12.5)
    static let monoFont = Font.system(size: 12.5, design: .monospaced)
    static let text = Theme.Card.titleText                   // inherits the panel's #F2F2F7
    static let hintText = Color.white.opacity(0.40)          // .ft .h
    static let divider = Color.white.opacity(0.10)
    static let dividerHeight: CGFloat = 0.5
    static let material: Material = .bar
  }
  /// Inputs (v5-a-final `.in`; input-*.html / thread-input.html `.box`, `.box.f`, `.ta`, `.snd`, `.hint`).
  enum Composer {
    // The panel's "Start a project…" field (.in, .kbd)
    static let panelHeight: CGFloat = 36, panelRadius: CGFloat = 9, panelPadding: CGFloat = 10, panelGap: CGFloat = 8
    static let panelFont = Font.system(size: 13.5)
    static let fill = Color.white.opacity(0.07)
    static let focusedFill = Color.white.opacity(0.10)
    static let focusedStroke = Color.white.opacity(0.18), focusedStrokeWidth: CGFloat = 0.5
    static let ring = Theme.accent.opacity(0.28), ringWidth: CGFloat = 3.5
    static let placeholder = Color.white.opacity(0.40)
    static let text = Color.white
    static let plusIcon = Font.system(size: 12, weight: .medium)
    static let plusText = Color.white.opacity(0.45)
    static let kbdFont = Font.system(size: 11.5)
    static let kbdText = Color.white.opacity(0.40)
    static let kbdStroke = Color.white.opacity(0.20), kbdRadius: CGFloat = 5
    static let kbdPadding = EdgeInsets(top: 1, leading: 5, bottom: 1, trailing: 5)
    // The thread input box (.box)
    static let boxRadius: CGFloat = 10
    static let boxPadding = EdgeInsets(top: 9, leading: 10, bottom: 8, trailing: 10)
    static let boxFont = Font.system(size: 13.5), boxLine: CGFloat = 19, boxMaxLines = 4   // .ta max-height 76
    static let mention = Theme.accent
    static let send: CGFloat = 24, sendIdle = Color.white.opacity(0.10), sendIcon = Font.system(size: 11, weight: .bold)
    static let sendGap: CGFloat = 6
    static let hintFont = Font.system(size: 10.5)
    static let hintText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.34)
    static let hintPadding = EdgeInsets(top: 5, leading: 30, bottom: 0, trailing: 4), hintGap: CGFloat = 10
    static let errorFont = Font.system(size: 11.5)
    static let sectionTop: CGFloat = 0                       // .in sits at the list padding; .sec adds 14 below it
  }
  /// Panel height follows its content (measured mockups, border to border: list 535.5–576, run view 295.5–439.5, thread 624.5 pt).
  enum Panel {
    static let maxHeight: CGFloat = 640          // the tallest approved panel (thread-panel-v2, 624.5) fits
    static let minHeight: CGFloat = 200          // an empty or loading screen doesn't collapse
    static let screenMargin: CGFloat = 48        // never taller than the screen's visible frame minus this
    static let initialHeight: CGFloat = 520      // until the first measurement lands
  }
  /// Motion: transform and opacity only, ease-out, under 300 ms; Reduce Motion drops the transform.
  enum Motion {
    static let pressScale: CGFloat = 0.97
    static let pressedOpacity: Double = 0.75                 // Reduce Motion stand-in for the press scale
    static let fast = Animation.easeOut(duration: 0.12)
    static let standard = Animation.easeOut(duration: 0.2)
    static let reduced = Animation.easeOut(duration: 0.15)   // crossfade
    static func ease(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : standard }
    /// Drill-down / thread push and back (SPEC §7: 0.25 s).
    static let pushDuration: Double = 0.25
    static func push(_ reduceMotion: Bool) -> Animation { reduceMotion ? reduced : .easeOut(duration: pushDuration) }
  }

  static let panelTitle = Font.system(size: 15, weight: .semibold)
  static let body = Font.system(size: 13)
  static let chip = Font.system(size: 11)
  static let monoTime = Font.system(size: 10.5, design: .monospaced)

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
      if kind.hasCentreDot { Circle().frame(width: Theme.Tree.iconDot, height: Theme.Tree.iconDot) }
    }
    .font(.system(size: Theme.Tree.iconSize(kind)))
    .foregroundStyle(Theme.color(tint))
    .frame(width: Theme.Tree.iconBox, height: Theme.Tree.iconBox)
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
  func makeBody(configuration: Configuration) -> some View {
    configuration.label.contentShape(Rectangle()).modifier(PressFeedback(isPressed: configuration.isPressed))
  }
}

/// The press scale (or Reduce Motion dim) shared by every custom button style.
struct PressFeedback: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let isPressed: Bool
  func body(content: Content) -> some View {
    content
      .scaleEffect(isPressed && !reduceMotion ? Theme.Motion.pressScale : 1)
      .opacity(isPressed && reduceMotion ? Theme.Motion.pressedOpacity : 1)
      .animation(Theme.Motion.fast, value: isPressed)
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
