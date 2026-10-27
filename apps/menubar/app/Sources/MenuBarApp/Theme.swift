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
    static let threadRefreshSeconds: Double = 15                      // live frames carry the thread; this re-read covers a dropped stream
    static let backSize: CGFloat = 24   // a round back button, like the composer's round controls
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
    // Times line up row to row ("now" … "10m ago").
    static let timeColumn: CGFloat = 46
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
    static let radius: CGFloat = 26              // Composer board: our own container, continuous corners
    static let stroke = Color.white.opacity(0.16)
  }
  /// Agent thread input and steers (thread-panel-v2.html `.ib`, `.strm`, `.me`; skills-picker.html `.skp`, `.sk`;
  /// input-mention.html `.mpop`, `.mi`; input-with-skill.html `.chip`).
  enum Thread {
    static let inputPadding = EdgeInsets(top: 7, leading: 8, bottom: 6, trailing: 6)
    static let inputMargin = EdgeInsets(top: 8, leading: 4, bottom: 0, trailing: 4)
    static let inputRadius: CGFloat = 10, inputGap: CGFloat = 6
    static let inputFontSize: CGFloat = 15, inputLine: CGFloat = 21, inputMaxLines = 6, inputInset: CGFloat = 2   // Composer v2: 15 pt
    static let inputFont = Font.system(size: inputFontSize)
    // An @ mention in the text: an 18 pt capsule with the bot and its name (MentionAttachment).
    static let pillHeight: CGFloat = 18, pillFontSize: CGFloat = 13, pillLeading: CGFloat = 3, pillGap: CGFloat = 4, pillTrailing: CGFloat = 8
    static let pillFill = Color.white.opacity(0.12), pillStroke = Color.white.opacity(0.16), pillText = Color.white.opacity(0.92)
    static let lineSpacing: CGFloat = 3                    // 15 pt SF lines to 21 pt
    static let inputText = Color.white.opacity(0.92)
    static let inputPlaceholder = Color.white.opacity(0.38)
    static let button: CGFloat = 22, plusRadius: CGFloat = 6
    static let stopFill = Color.white.opacity(0.88), stopSquare: CGFloat = 7
    // Writing row (.strm)
    static let writingFont = Font.system(size: 11)
    static let writingText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.45)
    static let writingPadding = EdgeInsets(top: 0, leading: 6, bottom: 6, trailing: 4), writingGap: CGFloat = 6
    static let dot: CGFloat = 3, dotGap: CGFloat = 2, dotOpacities: [Double] = [0.9, 0.55, 0.3]
    // Steer bubble (.me)
    static let bubbleFill = Color.white.opacity(0.10)
    static let bubbleFontSize: CGFloat = 13
    static let bubbleFont = Font.system(size: bubbleFontSize), bubbleText = Color.white.opacity(0.90)
    static let bubblePadding = EdgeInsets(top: 6, leading: 11, bottom: 6, trailing: 11)
    static let bubbleRadius: CGFloat = 13, bubbleTail: CGFloat = 4, bubbleMaxWidth: CGFloat = 0.76
    static let bubbleMargin = EdgeInsets(top: 6, leading: 0, bottom: 10, trailing: 0)
    static let bubbleSendingOpacity: Double = 0.6
    static let bubbleNoteFont = Font.system(size: 11)
    // Popovers (.skp / .mpop)
    static let popFill = Color(red: 40 / 255, green: 44 / 255, blue: 54 / 255)   // opaque: the lists float over the thread
    static let popStroke = Color.white.opacity(0.14), popRadius: CGFloat = 10, popPadding: CGFloat = 4
    static let popMargin = EdgeInsets(top: 0, leading: 4, bottom: 6, trailing: 4)
    static let popShadow = Color.black.opacity(0.4), popShadowRadius: CGFloat = 15, popShadowY: CGFloat = 10
    static let popHeaderFont = Font.system(size: 10.5, weight: .semibold)
    static let popHeaderText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.38)
    static let popHeaderPadding = EdgeInsets(top: 4, leading: 8, bottom: 3, trailing: 8)
    static let rowRadius: CGFloat = 6, rowHighlight = Theme.accent
    static let skillPadding = EdgeInsets(top: 5, leading: 8, bottom: 5, trailing: 8), skillGap: CGFloat = 8
    static let skillName = Font.system(size: 11.5, design: .monospaced), skillNameText = Color.white.opacity(0.9)
    static let skillSource = Font.system(size: 10.5)
    static let skillSourceText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.36)
    static let skillDesc = Font.system(size: 11)
    static let skillDescText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.5)
    static let skillMatch = Color(red: 0x40 / 255, green: 0x9C / 255, blue: 1)
    static let skillDescOn = Color.white.opacity(0.75)
    static let emptyFont = Font.system(size: 12)
    static let emptyText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.45)
    static let emptyPadding = EdgeInsets(top: 10, leading: 8, bottom: 9, trailing: 8)
    static let footFont = Font.system(size: 10)
    static let footText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.32)
    static let footPadding = EdgeInsets(top: 5, leading: 8, bottom: 2, trailing: 8), footGap: CGFloat = 10, footDivider = Color.white.opacity(0.07)
    static let mentionHeight: CGFloat = 28, mentionFont = Font.system(size: 12.5), mentionText = Color.white.opacity(0.85)
    static let mentionSuffix = Font.system(size: 10.5, design: .monospaced)
    static let mentionSuffixText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.35)
    static let mentionStatus = Font.system(size: 11)
    static let mentionStatusText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.4)
    static let onHighlightSecondary = Color.white.opacity(0.7)
    static let popMaxRows = 6
    // Picked skill chip (.chip in input-with-skill)
    static let chipHeight: CGFloat = 20, chipRadius: CGFloat = 6, chipGap: CGFloat = 4
    static let chipPadding = EdgeInsets(top: 0, leading: 6, bottom: 0, trailing: 5)
    static let chipFill = Theme.accent.opacity(0.16)
    static let chipText = Color(red: 0x8C / 255, green: 0xC4 / 255, blue: 1)
    static let chipFont = Font.system(size: 11, design: .monospaced)
    static let chipClose: CGFloat = 14, chipCloseFill = Color.white.opacity(0.08)
  }
  /// Thread content (thread-panel-v2.html / thread-states.html `.th` and its blocks). Line spacing is the CSS line height
  /// minus the font's own (SF 13 ≈ 15.5, SF 12 ≈ 14.3, SF 12.5 ≈ 15, SF Mono 11.5 ≈ 13.7, SF Mono 10.5 ≈ 12.5).
  enum Content {
    static let label = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255)
    static let padding = EdgeInsets(top: 10, leading: 14, bottom: 0, trailing: 14)   // .th: 16 inside the panel's 10, less its 12 bleed
    static let fade: CGFloat = 24
    static let topFade: CGFloat = 14  // the thread softens under the header instead of cutting off (the top padding at rest)
    // Prose (.p, .h, ul.l, .icd)
    static let proseFont = Font.system(size: 13), proseText = Color.white.opacity(0.86), proseSpacing: CGFloat = 3.5, proseBottom: CGFloat = 9
    static let headingFont = Font.system(size: 13, weight: .semibold), headingText = Color.white
    static let headingTop: CGFloat = 14, headingBottom: CGFloat = 5
    static let listIndent: CGFloat = 16, listItemGap: CGFloat = 2, listMarker = label.opacity(0.4), markerGap: CGFloat = 2
    static let codeInlineFont = Font.system(size: 11.5, design: .monospaced), codeInlineFill = Color.white.opacity(0.08), codeInlineText = Color.white.opacity(0.9)
    static let link = Color(red: 0x40 / 255, green: 0x9C / 255, blue: 1), linkDetail = label.opacity(0.4)
    static let pathText = Color.white.opacity(0.9)
    // Code block (.pre, .bar2, pre)
    static let codeFill = Color.black.opacity(0.28), codeStroke = Color.white.opacity(0.08), codeRadius: CGFloat = 8, codeBottom: CGFloat = 10
    static let codeBarFont = Font.system(size: 10.5), codeBarText = label.opacity(0.4)
    static let codeBarPadding = EdgeInsets(top: 5, leading: 10, bottom: 0, trailing: 10)
    static let codeFont = Font.system(size: 11.5, design: .monospaced), codeText = Color.white.opacity(0.85), codeSpacing: CGFloat = 3.3
    static let codePadding = EdgeInsets(top: 4, leading: 10, bottom: 9, trailing: 10)
    static let keyword = Color(red: 0x7C / 255, green: 0xB7 / 255, blue: 1), string = Color(red: 0xA8 / 255, green: 0xD4 / 255, blue: 0xA0 / 255)
    static let comment = label.opacity(0.36), number = Color(red: 0xE3 / 255, green: 0xB7 / 255, blue: 0x7A / 255)
    // Table (table.t)
    static let tableFont = Font.system(size: 12), tableText = Color.white.opacity(0.85), tableBottom: CGFloat = 10
    static let thFont = Font.system(size: 11, weight: .semibold), thText = label.opacity(0.55), thPadding = EdgeInsets(top: 3, leading: 6, bottom: 3, trailing: 6)
    static let thRule = Color.white.opacity(0.14), tdRule = Color.white.opacity(0.06), tdPadding = EdgeInsets(top: 4, leading: 6, bottom: 4, trailing: 6)
    static let tdMono = Font.system(size: 11, design: .monospaced)
    // Tool call (.tc, .tx)
    static let toolHeight: CGFloat = 26, toolGap: CGFloat = 8, toolIcon: CGFloat = 16, toolChevron: CGFloat = 10, toolRadius: CGFloat = 6, toolInset: CGFloat = 6
    static let toolFont = Font.system(size: 12.5), toolText = label.opacity(0.7), toolHover = Color.white.opacity(0.05)
    static let toolDuration = Font.system(size: 10.5, design: .monospaced), toolDurationText = label.opacity(0.4)
    static let detailFill = Color.black.opacity(0.22), detailRadius: CGFloat = 7, detailPadding = EdgeInsets(top: 7, leading: 9, bottom: 7, trailing: 9)
    static let detailMargin = EdgeInsets(top: 0, leading: 24, bottom: 8, trailing: 0)
    static let detailFont = Font.system(size: 10.5, design: .monospaced), detailText = label.opacity(0.7), detailSpacing: CGFloat = 2.5
    static let detailLabel = Font.system(size: 10, weight: .semibold), detailLabelText = label.opacity(0.38), detailLabelGap: CGFloat = 2, detailSectionGap: CGFloat = 6
    static let detailMaxLines = 40
    // Thinking (.thk, .thb)
    static let thinkHeight: CGFloat = 24, thinkGap: CGFloat = 6, thinkFont = Font.system(size: 12), thinkText = label.opacity(0.42)
    static let thoughtMargin = EdgeInsets(top: 0, leading: 6, bottom: 9, trailing: 0), thoughtIndent: CGFloat = 12, thoughtRule = Color.white.opacity(0.12)
    static let thoughtFont = Font.system(size: 12), thoughtText = label.opacity(0.55), thoughtSpacing: CGFloat = 2.7
    // Handoff card (.ho, .art)
    static let handoffFill = Color.white.opacity(0.05), handoffStroke = Color.white.opacity(0.10), handoffRadius: CGFloat = 10
    static let handoffPadding = EdgeInsets(top: 9, leading: 10, bottom: 9, trailing: 10), handoffBottom: CGFloat = 10, handoffGap: CGFloat = 7
    static let handoffName = Font.system(size: 12.5, weight: .medium), handoffSuffix = Font.system(size: 10.5, design: .monospaced), handoffSuffixText = label.opacity(0.32)
    static let handoffNote = Font.system(size: 11), handoffNoteText = label.opacity(0.45)
    static let handoffSummary = Font.system(size: 12.5), handoffSummaryText = Color.white.opacity(0.8), handoffSummarySpacing: CGFloat = 3
    static let handoffSummaryMargin = EdgeInsets(top: 5, leading: 0, bottom: 7, trailing: 0)
    static let artFont = Font.system(size: 10.5, design: .monospaced), artText = label.opacity(0.6), artFill = Color.white.opacity(0.07)
    static let artRadius: CGFloat = 5, artPadding = EdgeInsets(top: 2, leading: 6, bottom: 2, trailing: 6), artGap: CGFloat = 4
    // The agent's task above its thread, folded like a thought; its first line trails the label, quieter.
    static let taskPreviewText = label.opacity(0.32)
    // Reviewer verdict card: the handoff card's surface; a seal and "Passed review" / "Didn't pass review", then reasons.
    static let verdictIcon = Font.system(size: 13), verdictGap: CGFloat = 6, verdictReasonGap: CGFloat = 4, verdictBullet = label.opacity(0.35)
    // Diff card (.df, .fh, .ln2)
    static let diffFill = Color.black.opacity(0.25), diffStroke = Color.white.opacity(0.08), diffRadius: CGFloat = 8, diffBottom: CGFloat = 10
    static let diffHeaderFont = Font.system(size: 11, design: .monospaced), diffHeaderText = Color.white.opacity(0.8)
    static let diffHeaderPadding = EdgeInsets(top: 6, leading: 10, bottom: 6, trailing: 10), diffHeaderGap: CGFloat = 7, diffHeaderRule = Color.white.opacity(0.07)
    static let diffAdded = Color(red: 0x30 / 255, green: 0xD1 / 255, blue: 0x58 / 255), diffRemoved = Color(red: 1, green: 0x69 / 255, blue: 0x61 / 255)
    static let diffFont = Font.system(size: 11, design: .monospaced), diffLine: CGFloat = 16, diffPadding: CGFloat = 10, diffMarker: CGFloat = 12
    static let diffContext = label.opacity(0.6), diffMarkerText = label.opacity(0.4)
    static let diffAddedFill = diffAdded.opacity(0.10), diffAddedText = Color.white.opacity(0.9)
    static let diffRemovedFill = diffRemoved.opacity(0.10), diffRemovedText = Color.white.opacity(0.75)
    static let diffGapText = label.opacity(0.35), diffFailedOpacity: Double = 0.6
    // Error, other, quote, rule, media
    static let errorText = Color(red: 1, green: 105 / 255, blue: 97 / 255).opacity(0.85), errorFont = Font.system(size: 12.5)
    static let otherFont = Font.system(size: 12), otherText = label.opacity(0.45)
    static let ruleColor = Color.white.opacity(0.10), ruleMargin: CGFloat = 8
    static let mediaRadius: CGFloat = 8, mediaMaxHeight: CGFloat = 180, mediaStroke = Color.white.opacity(0.08)
    static let truncatedFont = Font.system(size: 11), truncatedText = label.opacity(0.4)
  }
  /// Composer v2 (canvas "Composer and container v2", after the owner's reference).
  enum Composer2 {
    static let radius: CGFloat = 20, padding = EdgeInsets(top: 12, leading: 12, bottom: 12, trailing: 12), gap: CGFloat = 12
    static let fill = Color.white.opacity(0.06), stroke = Color.white.opacity(0.12)
    static let ring = Theme.accent.opacity(0.22), ringWidth: CGFloat = 3.5
    static let projectFont = Font.system(size: 17), projectTracking: CGFloat = -0.17, textInset: CGFloat = 4
    static let threadFont = Font.system(size: 15), threadLine: CGFloat = 21
    static let chipHeight: CGFloat = 26, chipPadding: CGFloat = 9, chipGap: CGFloat = 8, chipInnerGap: CGFloat = 6
    // Local | VM switch (the reference's segmented group): the picked segment is a raised capsule.
    static let segmentOn = Color.white.opacity(0.12), segmentOnStroke = Color.white.opacity(0.18)
    static let unavailableOpacity: CGFloat = 0.55
    static let segmentWidth: CGFloat = 36, segmentIcon = Font.system(size: 13, weight: .medium)
    static let chipFont = Font.system(size: 12.5), chipMono = Font.system(size: 12, design: .monospaced)
    static let chipFill = Color.white.opacity(0.08), chipStroke = Color.white.opacity(0.14), chipX = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.55)
    static let round: CGFloat = 30, roundFill = Color.white.opacity(0.08), roundStroke = Color.white.opacity(0.16), plusFont = Font.system(size: 14, weight: .regular)
    static let pillHeight: CGFloat = 26, pillGroupFill = Color.black.opacity(0.22), pillText = Color.white.opacity(0.7), pillFont = Font.system(size: 12.5)
    static let send: CGFloat = 32, sendIcon = Font.system(size: 13, weight: .bold), sendArrowIdle: CGFloat = 0.3
    static let effortFont = Font.system(size: 11, weight: .semibold), effortText = Color.white.opacity(0.75)
    static let keyFont = Font.system(size: 11.5, weight: .medium), keyText = Color.white.opacity(0.7), keyStroke = Color.white.opacity(0.25)
    static let hintFont = Font.system(size: 11), hintText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.4)
    // Recent rows (.continue)
    static let tile: CGFloat = 34, tileRadius: CGFloat = 10, rowRadius: CGFloat = 14, rowPadding = EdgeInsets(top: 8, leading: 10, bottom: 8, trailing: 10)
    static let rowTitle = Font.system(size: 13.5, weight: .medium), rowSub = Font.system(size: 12)
    static let rowSubText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.55), rowHover = Color.white.opacity(0.07)
  }
  /// Identity moments (design/brand/moments.png): meet your team, run finished.
  /// The provider mark (ProviderMark.swift): 11 pt in tree rows, a badge disc on bots of 24 pt and up.
  enum Provider {
    static let claude = Color(red: 0xD9 / 255, green: 0x77 / 255, blue: 0x57 / 255)   // Claude's coral
    static let rowSize: CGFloat = 11, rowText = Color.white.opacity(0.45), rowLeading: CGFloat = 6, chipMark: CGFloat = 12
    static func badge(_ side: CGFloat) -> CGFloat { side >= 48 ? 18 : side >= 24 ? 12 : 0 }
    static let markRatio: CGFloat = 0.68, badgeOut: CGFloat = 0.18
    static let badgeFill = Color(white: 0.13), badgeStroke = Color.white.opacity(0.14)
  }
  enum Moments {
    static let meetWindow: Double = 6, cheerFor: Double = 2.2                   // s: a run's first seconds; the cheer
    static let maxKids = 4, maxCheer = 5
    static let leadCell: CGFloat = 2                                            // the planner at 64 pt
    static let padding: CGFloat = 8, labelTop: CGFloat = 4, traceTop: CGFloat = 4, traceHeight: CGFloat = 18, statusTop: CGFloat = 10
    static let traceWidth: CGFloat = 1, traceOpacity: Double = 0.8, memberGap: CGFloat = 2, statusGap: CGFloat = 6
    static let leadFont = Font.system(size: 12.5), memberFont = Font.system(size: 11.5)
    static let roleText = Color.white.opacity(0.85), nameText = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.45)
    static let statusFont = Font.system(size: 12.5), statusText = Color.white.opacity(0.78)
    static let rise: CGFloat = 4, stagger: Double = 0.04, memberFade: Double = 0.2, reducedFade: Double = 0.15
    static let cheerGap: CGFloat = 4, cheerPadding: CGFloat = 10, cheerBottom: CGFloat = 12, confettiCount = 26
    static let confetti: [Color] = [Theme.Polish.brand, Color(red: 0x94 / 255, green: 0x57 / 255, blue: 0xDC / 255),
                                    Color(red: 0x5E / 255, green: 0xE6 / 255, blue: 1), Color(red: 0xF7 / 255, green: 0xA3 / 255, blue: 0xDA / 255)]
  }
  /// Approved Apple craft (canvas "Craft" and "Materials" boards).
  enum Craft {
    static let solidControl = Color(red: 0x30 / 255, green: 0x31 / 255, blue: 0x3A / 255)   // Reduce Transparency, macOS 14–15
    static let solidPanel = Color(red: 0x23 / 255, green: 0x24 / 255, blue: 0x2C / 255)
    static let contrastStroke = Color.white.opacity(0.7), contrastStrokeWidth: CGFloat = 1   // Increase Contrast
  }
  /// Approved polish (canvas "Polish" board): identity in lines and light, never in text, controls or chrome.
  enum Polish {
    static let brand = Color(red: 1, green: 0x7A / 255, blue: 0x10 / 255)        // the wordmark orange
    static let dither = brand.opacity(0.45)                                      // 1 pt ordered dither, footer hairlines
    static let traceDash: [CGFloat] = [1, 1]                                     // tree guides as dotted traces
    static let traceNode: CGFloat = 3                                            // a 3×3 node where a branch splits
    static let glowSize = CGSize(width: 20, height: 14), glowOpacity: Double = 0.45
    static let blink: Double = 0.12                                              // hover blink, a sprite swap
    static let sparkle: CGFloat = 10, sparkleFade: Double = 0.3, sparkleWithin: Double = 10   // s after a run ends
    static let wordmarkCell: CGFloat = 3, wordmarkGap: CGFloat = 1               // glyph cells; gap in cells
  }
  /// The Settings window (design/settings/*.dc.html). Panes are system grouped Forms, so rows, controls, section headers
  /// and footers take the system's metrics and colours; these are the few things the boards draw themselves.
  enum Settings {
    static let width: CGFloat = 620                                   // .win width
    static let poll: Double = 5                                       // s between reads while the window is open
    static let chrome: CGFloat = 80                                   // title and tab bar, until the window says
    static let minPane: CGFloat = 200                                 // never shorter than this before scrolling
    // Status dots (`.dot`, `.empty`): system colours, so they adapt to light, dark and Increase Contrast.
    static let dot: CGFloat = 8, ringWidth: CGFloat = 1.2, valueGap: CGFloat = 6
    static let ok = Color(nsColor: .systemGreen), warn = Color(nsColor: .systemOrange), bad = Color(nsColor: .systemRed)
    static let ring = Color(nsColor: .systemGray)
    static let rowGap: CGFloat = 12                                   // .row gap: value to button
    static let footFont = Font.system(size: 11), footMono = Font.system(size: 11, design: .monospaced)
    // Section headers (`.sh`): a mark before the title, a Default badge or Make Default after it.
    static let headerGap: CGFloat = 6
    static let providerMark: CGFloat = 14, placeMark: CGFloat = 15
    static let badgeFont = Font.system(size: 11, weight: .medium)
    static let badgePaddingH: CGFloat = 7, badgePaddingV: CGFloat = 2, badgeRadius: CGFloat = 5, badgeFill: Double = 0.16
    /// `.badge` text: #4ea1ff in dark (Runs.dc.html), #0062cc in light (GeneralLight.dc.html's accent text).
    static let badgeText = Color(nsColor: NSColor(name: nil) { a in
      a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(srgbRed: 0x4E / 255, green: 0xA1 / 255, blue: 1, alpha: 1)
                                                          : NSColor(srgbRed: 0, green: 0x62 / 255, blue: 0xCC / 255, alpha: 1)
    })
    static let headerButtonFont = Font.system(size: 12)
    static let menuMark: CGFloat = 13                                 // marks inside popup menus
    // Bot faces preview: the mark on a 32 pt tile.
    static let faceTile: CGFloat = 32, faceTileRadius: CGFloat = 7, faceTileFill = Color.primary.opacity(0.06), faceMark: CGFloat = 16
    static let progressWidth: CGFloat = 150                           // `.track` while an environment builds
    static let sheetWidth: CGFloat = 380, sheetPadding: CGFloat = 20, sheetGap: CGFloat = 10
    /// About (`About.dc.html`): one centred column.
    enum About {
      static let height: CGFloat = 420                                // the board's 500 pt window less its toolbar
      static let botCell: CGFloat = 4                                 // 32 cells × 4 = 128 pt
      static let wordmarkCell: CGFloat = 6                            // 7 glyphs → 204 × 30 pt
      static let wordmarkTop: CGFloat = 18, taglineTop: CGFloat = 12, versionTop: CGFloat = 6, linksTop: CGFloat = 22
      static let linksGap: CGFloat = 8, licenseTop: CGFloat = 18
      static let paddingTop: CGFloat = 8, paddingH: CGFloat = 24, paddingBottom: CGFloat = 28
      static let taglineFont = Font.system(size: 13), smallFont = Font.system(size: 11)
    }
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
      Image(systemName: sym).symbolRenderingMode(.hierarchical).foregroundStyle(Theme.color(s.tint)).font(.system(size: 11))
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
    .background(RoundedRectangle(cornerRadius: Theme.ScopeChip.radius, style: .continuous).fill(Theme.ScopeChip.fill))
  }
}

struct Chip: View {
  let text: String
  var body: some View {
    Text(verbatim: text).font(Theme.chip).foregroundStyle(.secondary)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.white.opacity(0.07)))
  }
}
#endif
