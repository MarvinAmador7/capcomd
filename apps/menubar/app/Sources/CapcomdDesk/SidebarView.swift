#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// The opened sidebar (design/desktop/rex: RexMain, RexStates): 248 pt on the window's ground. Header (the traffic
// lights, the sidebar button, the Needs you hand, Search, +), Needs you pinned, Running and Finished scrolling under it,
// footer (Home; History, Settings). Fixed heights throughout; it is fixed-width, so nothing in it can resize the pane.

extension Theme.Desk {
  enum Side {
    static let row = Color(red: 0xC9 / 255, green: 0xC9 / 255, blue: 0xCF / 255)
    static let selected = Color.white.opacity(0.10), hover = Color.white.opacity(0.05)
    static let more = Color.white.opacity(0.12)
    static let badgeFill = Color(red: 0x2C / 255, green: 0x2C / 255, blue: 0x31 / 255)
    static let headFill = Color(red: 0x26 / 255, green: 0x26 / 255, blue: 0x2A / 255)
    static let hairline = Color.white.opacity(0.10)
    static let button: CGFloat = 28, buttonRadius: CGFloat = 7
    static let on = Color.white.opacity(0.09), buttonHover = Color.white.opacity(0.06)
    static let rowFont = Font.system(size: 13), wordFont = Font.system(size: 11.5)
    static let wordAsk = Font.system(size: 11.5, weight: .medium)
    static let headingFont = Font.system(size: 12, weight: .semibold), countFont = Font.system(size: 12)
    static let labelFont = Font.system(size: 11.5, weight: .semibold)
    static let calmFont = Font.system(size: 12.5)
  }
}

struct SidebarView: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("Sidebar")
    return VStack(spacing: 0) {
      SidebarHeader()
      SidebarList()
      SidebarFooter()
    }
    .padding(.horizontal, 8).padding(.bottom, 6)
    .frame(width: SidebarMetrics.width)
    .frame(maxHeight: .infinity)
    .background(Theme.Desk.ground)
    .onHover { model.sidebar.pointer(inside: $0) }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Agents by what needs you")
  }
}

// MARK: header and footer

/// The traffic lights' room, the sidebar button (where the folded title bar has it), then the hand, Search and +.
struct SidebarHeader: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    HStack(spacing: 2) {
      SidebarToggleButton(on: true)
      Spacer(minLength: 0)
      NeedsHand(style: .header)
      SideButton(symbol: "magnifyingglass", help: "Search (⌘K)", label: "Search") { model.togglePalette() }
      SideButton(symbol: "plus", help: "New project (⇧⌘N)", label: "New project") { model.openNewProject() }
    }
    .padding(.leading, SidebarMetrics.toggleX - 8).padding(.trailing, 2)
    .frame(height: SidebarMetrics.header)
  }
}

struct SidebarFooter: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    HStack(spacing: 2) {
      SideButton(glyph: AnyView(HouseGlyph().stroke(style: StrokeStyle(lineWidth: 1.3, lineJoin: .round)).frame(width: 15, height: 15)),
                 on: model.homeShown, help: "Home (⌘0)", label: "Home") { model.toggleHome() }
      Spacer(minLength: 0)
      HistoryButton(size: Theme.Desk.Side.button)
      SettingsButton(size: Theme.Desk.Side.button)
    }
    .padding(.horizontal, 2)
    .frame(height: SidebarMetrics.footer)
  }
}

/// The sidebar button: folds or opens (⌃⌘S). Pressed while the sidebar is open.
struct SidebarToggleButton: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let on: Bool
  var body: some View {
    SideButton(symbol: "sidebar.left", on: on, help: on ? "Fold the sidebar (⌃⌘S)" : "Open the sidebar (⌃⌘S)",
               label: on ? "Fold the sidebar" : "Open the sidebar", size: on ? Theme.Desk.Side.button : Theme.Desk.iconButton) {
      withAnimation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.25, bounce: 0)) { model.toggleSidebar() }
    }
  }
}

/// The Needs you hand (SF hand.raised, AttentionIcon): the normal icon colour with the amber count beside it (header) or
/// as a badge (rail) while anything needs you; grey with no count at zero. A click opens the Needs you reel.
struct NeedsHand: View {
  enum Style { case header, rail }
  @Environment(DeskModel.self) private var model
  let style: Style
  var body: some View {
    let n = model.sidebar.needsCount
    let label = n > 0 ? "Needs you: \(n). Open them as a reel" : "Nothing needs you"
    return Button { model.openNeedsReel() } label: {
      switch style {
      case .header:
        HStack(spacing: 4) {
          Image(systemName: "hand.raised").font(.system(size: 14))
          if n > 0 { Text(verbatim: "\(n)").font(.system(size: 12, weight: .bold)).monospacedDigit().foregroundStyle(Theme.amber) }
        }
        .foregroundStyle(n > 0 ? Theme.Desk.text : Theme.Desk.tertiary)
        .padding(.leading, n > 0 ? 5 : 0).padding(.trailing, n > 0 ? 7 : 0)
        .frame(minWidth: Theme.Desk.Side.button, minHeight: Theme.Desk.Side.button)
        .contentShape(Rectangle())
      case .rail:
        Image(systemName: "hand.raised").font(.system(size: 15))
          .foregroundStyle(n > 0 ? Theme.Desk.text : Theme.Desk.tertiary)
          .frame(width: RailMetrics.button, height: RailMetrics.button)
          .overlay(alignment: .topTrailing) { if n > 0 { CountBadge(n: n).offset(x: 0, y: 1) } }
          .contentShape(Rectangle())
      }
    }
    .buttonStyle(SideButtonStyle(radius: style == .rail ? RailMetrics.radius : Theme.Desk.Side.buttonRadius))
    .help(n > 0 ? "Needs you (\(n))" : "Nothing needs you")
    .accessibilityLabel(label)
  }
}

/// The amber count on the rail's hand (NavC `.badge`).
struct CountBadge: View {
  let n: Int
  var body: some View {
    Text(verbatim: n > 99 ? "99+" : "\(n)").font(.system(size: 10, weight: .bold)).monospacedDigit()
      .foregroundStyle(Color(red: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255))
      .padding(.horizontal, 4).frame(minWidth: 15, minHeight: 15)
      .background(Capsule().fill(Theme.amber))
      .background(Capsule().stroke(Theme.Desk.ground, lineWidth: 4))
      .fixedSize()
  }
}

/// History: no screen yet, so it's there but disabled (RexNotes keeps its place in the footer and the rail).
struct HistoryButton: View {
  let size: CGFloat
  var body: some View {
    Button {} label: {
      Image(systemName: "clock.arrow.circlepath").font(.system(size: 14)).foregroundStyle(Theme.Desk.tertiary)
        .frame(width: size, height: size)
    }
    .buttonStyle(SideButtonStyle(radius: size > 30 ? RailMetrics.radius : Theme.Desk.Side.buttonRadius))
    .disabled(true).opacity(0.5)
    .help("History (not built yet)")
    .accessibilityLabel("History, not available yet")
  }
}

/// Settings: the app's Settings window (⌘,).
struct SettingsButton: View {
  @Environment(\.openSettings) private var openSettings
  let size: CGFloat
  var body: some View {
    Button { openSettings() } label: {
      Image(systemName: "gearshape").font(.system(size: 14)).foregroundStyle(Theme.Desk.tertiary)
        .frame(width: size, height: size)
    }
    .buttonStyle(SideButtonStyle(radius: size > 30 ? RailMetrics.radius : Theme.Desk.Side.buttonRadius))
    .help("Settings (⌘,)")
    .accessibilityLabel("Settings")
  }
}

/// A square icon button of the sidebar (RexMain `.ib`: 28 pt, 7 pt corners, tertiary; pressed `.on`).
struct SideButton: View {
  var symbol: String? = nil
  var glyph: AnyView? = nil
  var on = false
  let help: String
  let label: String
  var size: CGFloat = Theme.Desk.Side.button
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Group {
        if let glyph { glyph } else if let symbol { Image(systemName: symbol).font(.system(size: 14)) }
      }
      .foregroundStyle(on ? Theme.Desk.text : Theme.Desk.tertiary)
      .frame(width: size, height: size)
      .background(RoundedRectangle(cornerRadius: size > 30 ? 8 : Theme.Desk.Side.buttonRadius, style: .continuous).fill(on ? Theme.Desk.Side.on : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(SideButtonStyle(radius: size > 30 ? 8 : Theme.Desk.Side.buttonRadius))
    .help(help)
    .accessibilityLabel(label)
    .accessibilityAddTraits(on ? .isSelected : [])
  }
}

/// A hover wash (`.ib.hov`) and the shared press feedback; no motion beyond it.
struct SideButtonStyle: ButtonStyle {
  let radius: CGFloat
  func makeBody(configuration: Configuration) -> some View { Hovering(radius: radius, label: configuration.label, pressed: configuration.isPressed) }
  struct Hovering<L: View>: View {
    let radius: CGFloat
    let label: L
    let pressed: Bool
    @State private var hover = false
    @Environment(\.isEnabled) private var enabled
    var body: some View {
      label
        .background(RoundedRectangle(cornerRadius: radius, style: .continuous).fill(hover && enabled ? Theme.Desk.Side.buttonHover : .clear))
        .onHover { hover = $0 }
        .modifier(PressFeedback(isPressed: pressed))
    }
  }
}

// MARK: the list

/// Needs you, pinned; then Running and Finished in a scroll view of their own (scrolling it touches no pane). A view per
/// line, each Equatable: a change re-renders the lines that changed.
struct SidebarList: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @FocusState private var focused: Bool
  var body: some View {
    DeskProbe.body("SidebarList")
    let lines = model.sidebarLines
    let selected = model.selectedAgent
    let cursor = focused ? model.nav.cursor : nil
    return VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(lines.pinned) { l in
          SidebarLineView(line: l, selected: selected, cursor: cursor).equatable()
            .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
        }
      }
      .padding(.bottom, lines.overflow ? 8 : 0)
      .overlay(alignment: .bottom) { if lines.overflow { Theme.Desk.Side.hairline.frame(height: 0.5) } }
      ScrollView(.vertical) {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(lines.list) { l in
            SidebarLineView(line: l, selected: selected, cursor: cursor).equatable()
              .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: 6)))
          }
        }
        .padding(.top, lines.overflow ? -8 : 0)
        .padding(.bottom, 8)
      }
      .scrollIndicators(.automatic)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    // A row moves only when the daemon moves it (an ask arrives: it leaves Running for Needs you), 0.2 s opacity and a
    // 6 pt slide; folding, selecting and the keyboard never animate.
    .animation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.2), value: model.sidebar.content)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { h in if model.nav.listHeight != h { model.nav.listHeight = h } }
    .focusable()
    .focusEffectDisabled()
    .focused($focused)
    .onKeyPress(.upArrow) { model.moveSidebarCursor(-1); return .handled }
    .onKeyPress(.downArrow) { model.moveSidebarCursor(1); return .handled }
    .onKeyPress(.rightArrow) { model.sidebarUnfold(true); return .handled }
    .onKeyPress(.leftArrow) { model.sidebarUnfold(false); return .handled }
    .onKeyPress(.return) { model.sidebarReturn(); return .handled }
    .task(id: model.nav.listFocus) { if model.nav.listFocus > 0 { focused = true } }
  }
}

/// One line. Equatable on what it draws, so the list's update re-renders only lines whose content, selection or cursor
/// changed.
struct SidebarLineView: View, Equatable {
  let line: SidebarLine
  let selected: String?
  let cursor: SidebarKey?
  static func == (a: Self, b: Self) -> Bool {
    a.line == b.line && a.isSelected == b.isSelected && a.hasCursor == b.hasCursor
  }
  var isSelected: Bool { if case .row(let r, _) = line { return r.id == selected }; return false }
  var hasCursor: Bool { line.key != nil && line.key == cursor }
  var body: some View {
    switch line {
    case .heading(let s, let n, let first): SectionHeading(section: s, count: n, first: first, cursor: hasCursor)
    case .calm(let t, _):
      Text(verbatim: t).font(Theme.Desk.Side.calmFont).foregroundStyle(Theme.Desk.tertiary)
        .padding(.horizontal, 8).padding(.top, 2).padding(.bottom, 6)
        .frame(maxWidth: .infinity, minHeight: SidebarMetrics.calm, maxHeight: SidebarMetrics.calm, alignment: .topLeading)
    case .label(let g, let s, let folded): ProjectLabel(group: g, section: s, folded: folded, cursor: hasCursor)
    case .row(let r, let s): AgentRow(row: r, section: s, selected: isSelected, cursor: hasCursor)
    case .newProject: NewProjectRow()
    }
  }
}

/// Needs you (amber, its count; grey and no count at zero), Running (a count), Finished (muted, a count, folds).
struct SectionHeading: View {
  @Environment(DeskModel.self) private var model
  let section: SidebarSection
  let count: Int
  let first: Bool
  let cursor: Bool
  @State private var hover = false
  var body: some View {
    DeskProbe.body("SectionHeading")
    let needs = section == .needs && count > 0
    let color = needs ? Theme.amber : section == .finished ? Theme.Desk.tertiary : Theme.Desk.secondary
    let title = switch section { case .needs: "Needs you"; case .running: "Running"; case .finished: "Finished" }
    let content = HStack(spacing: 6) {
      Text(verbatim: title).font(Theme.Desk.Side.headingFont).foregroundStyle(color)
      if count > 0 && !(section == .needs && count == 0) {
        Text(verbatim: "\(count)").font(Theme.Desk.Side.countFont).monospacedDigit()
          .foregroundStyle(needs ? Theme.amber.opacity(0.8) : Theme.Desk.tertiary)
      }
      if section == .finished {
        Image(systemName: model.nav.finishedOpen ? "chevron.down" : "chevron.right").font(.system(size: 9, weight: .semibold))
          .foregroundStyle(Theme.Desk.tertiary)
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 8)
    .frame(height: SidebarMetrics.heading)
    .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hover && section != .running ? Theme.Desk.Side.hover : .clear))
    .overlay(CursorRing(on: cursor))
    .contentShape(Rectangle())
    .padding(.top, first ? 2 : 16)
    return Group {
      switch section {
      case .needs:
        Button { model.openNeedsReel() } label: { content }.buttonStyle(.plain)
          .onHover { hover = $0 }
          .help(count > 0 ? "Open them as a reel" : "Nothing needs you")
          .accessibilityLabel(count > 0 ? "Needs you, \(count). Open them as a reel" : "Needs you, nothing")
      case .finished:
        Button { model.toggleFinished() } label: { content }.buttonStyle(.plain)
          .onHover { hover = $0 }
          .accessibilityLabel("Finished, \(count)")
          .accessibilityValue(model.nav.finishedOpen ? "unfolded" : "folded")
      case .running:
        content.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
      }
    }
  }
}

/// The project: a quiet label with its place icon (This Mac / boxd), once per project. Folded, one 28 pt line with a
/// chevron and its crew's heads; a click unfolds it.
struct ProjectLabel: View {
  @Environment(DeskModel.self) private var model
  let group: SidebarGroup
  let section: SidebarSection
  let folded: Bool
  let cursor: Bool
  @State private var hover = false
  var body: some View {
    DeskProbe.body("ProjectLabel")
    let place = Place(sandbox: group.sandbox)
    let line = HStack(spacing: 6) {
      if folded { Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.Desk.tertiary) }
      if let place {
        Image(systemName: place.symbol).font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.Desk.tertiary)
          .frame(width: 13).accessibilityLabel(place == .local ? "This Mac" : "boxd")
      }
      Text(verbatim: group.title).font(Theme.Desk.Side.labelFont).foregroundStyle(hover ? Theme.Desk.secondary : Theme.Desk.tertiary)
        .lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 4)
      if folded { HeadStack(bots: group.rows.prefix(3).map(\.bot)) }
    }
    .padding(.leading, 8).padding(.trailing, 6)
    .frame(height: folded ? SidebarMetrics.foldedLabel : SidebarMetrics.label)
    .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(hover && folded ? Theme.Desk.Side.hover : .clear))
    .overlay(CursorRing(on: cursor))
    .contentShape(Rectangle())
    .padding(.top, folded ? 2 : 4)
    return Group {
      if folded {
        Button { model.setProjectFolded(group.projectId, false) } label: { line }.buttonStyle(.plain)
          .onHover { hover = $0 }
          .accessibilityLabel("\(group.title), folded, \(group.rows.count) agents")
          .accessibilityHint("Unfolds it")
      } else {
        line.accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
      }
    }
  }
}

/// A folded project's heads, stacked (RexStates `.stk`).
struct HeadStack: View {
  let bots: [BotTraits?]
  var body: some View {
    HStack(spacing: -9) {
      ForEach(Array(bots.enumerated()), id: \.offset) { _, b in
        BotAvatar(traits: b, size: .xs, cell: 1)
          .frame(width: 18, height: 18)
          .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.Desk.Side.headFill))
          .background(RoundedRectangle(cornerRadius: 5, style: .continuous).stroke(Theme.Desk.ground, lineWidth: 3))
      }
    }
  }
}

/// One agent, one 28 pt line: its catalog head with the provider badge on the corner, its own title, a word at the end
/// only when it matters. Selected: the pill. Hover or selected: •••, with the agent's daemon actions (an NSMenu). A
/// double-click renames it in the pane's header.
struct AgentRow: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let row: SidebarRow
  let section: SidebarSection
  let selected: Bool
  let cursor: Bool
  @State private var hover = false
  var body: some View {
    DeskProbe.body("AgentRow", id: row.id)
    let dim = row.tone == .dim
    let titleColor: Color = selected || hover ? Theme.Desk.text : dim ? Theme.Desk.tertiary : row.tone == .done ? Theme.Desk.secondary : Theme.Desk.Side.row
    return HStack(spacing: 0) {
      Button { model.selectRow(row) } label: {
        HStack(spacing: 8) {
          RowHead(bot: row.bot, provider: row.provider).opacity(dim ? 0.55 : 1)
          Text(verbatim: row.title).font(Theme.Desk.Side.rowFont).foregroundStyle(titleColor)
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          if let w = row.word {
            Text(verbatim: w).font(row.tone == .ask || row.tone == .error ? Theme.Desk.Side.wordAsk : Theme.Desk.Side.wordFont)
              .foregroundStyle(row.tone == .ask ? Theme.amber : row.tone == .error ? Theme.red : Theme.Desk.tertiary)
              .padding(.trailing, 4).fixedSize()
          }
        }
        .frame(height: SidebarMetrics.row)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .simultaneousGesture(TapGesture(count: 2).onEnded { model.renameRow(row) })
      if hover || selected {
        RowMore(row: row)
          .transition(.opacity.animation(reduceMotion ? nil : .easeOut(duration: 0.12)))
      }
    }
    .padding(.leading, 8 + CGFloat(row.level) * SidebarMetrics.indent).padding(.trailing, 4)
    .frame(height: SidebarMetrics.row)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? Theme.Desk.Side.selected : hover ? Theme.Desk.Side.hover : .clear))
    .overlay(CursorRing(on: cursor))
    .onHover { hover = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityLabel([row.title, row.word].compactMap { $0 }.joined(separator: ", "))
    .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    .accessibilityAction { model.selectRow(row) }
    .accessibilityAction(named: "Rename") { model.renameRow(row) }
  }
}

/// The row's head: 14 pt catalog bot in an 18 pt box, the provider's mark on its corner (RexMain `.hd`, `.pb`).
struct RowHead: View {
  let bot: BotTraits?
  let provider: Provider?
  var body: some View {
    BotAvatar(traits: bot, size: .xs, cell: 1)
      .frame(width: 18, height: 18)
      .overlay(alignment: .bottomTrailing) {
        if let provider {
          ProviderMark(provider: provider, size: 7)
            .foregroundStyle(Color(red: 0xD9 / 255, green: 0xD9 / 255, blue: 0xDF / 255))
            .frame(width: 10, height: 10)
            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).fill(Theme.Desk.Side.badgeFill))
            .background(RoundedRectangle(cornerRadius: 3, style: .continuous).stroke(Theme.Desk.ground, lineWidth: 3))
            .offset(x: 2, y: 2)
            .accessibilityLabel(provider.displayName)
        }
      }
  }
}

/// ••• : the agent's daemon actions, as a native menu.
struct RowMore: View {
  @Environment(DeskModel.self) private var model
  let row: SidebarRow
  var body: some View {
    Menu {
      ForEach(model.agentMenu(row), id: \.self) { item in
        if case .copyId = item { Divider() }
        Button { model.perform(item, on: row) } label: {
          if case .copyId(let short) = item { Text("Copy Agent ID (\(short))") } else { Text(item.title) }
        }
      }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.Desk.secondary)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .frame(width: 24, height: 20)
    .help("More for \(row.title)")
    .accessibilityLabel("More for \(row.title)")
  }
}

/// No projects yet: + as a row (⇧⌘N), as RexStates draws it.
struct NewProjectRow: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    Button { model.openNewProject() } label: {
      HStack(spacing: 8) {
        Image(systemName: "plus").font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary).frame(width: 18, height: 18)
        Text("New project").font(Theme.Desk.Side.rowFont).foregroundStyle(Theme.Desk.secondary)
        Spacer(minLength: 0)
        Text("⇧⌘N").font(Theme.Desk.Side.wordFont).foregroundStyle(Theme.Desk.tertiary).padding(.trailing, 4)
      }
      .padding(.leading, 8).padding(.trailing, 4)
      .frame(height: SidebarMetrics.row).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .padding(.top, 2)
  }
}

/// The keyboard's place in the list: the system focus ring's colour, 1 pt, only while the list has the keyboard.
struct CursorRing: View {
  let on: Bool
  var body: some View {
    RoundedRectangle(cornerRadius: 8, style: .continuous)
      .strokeBorder(on ? Color(nsColor: .keyboardFocusIndicatorColor) : .clear, lineWidth: 1)
      .allowsHitTesting(false)
  }
}
#endif
