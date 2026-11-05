#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

// Over the window: the open project's menu (ReelMenu), dropped from its name, and the ⌘K palette. One surface for both:
// the board's menu (#232326, 13 pt corners, 30 pt rows). A click outside closes either; Esc too.

/// The open project's group in the title bar, for the menu to drop from.
struct ProjectGroupBounds: PreferenceKey {
  static let defaultValue: Anchor<CGRect>? = nil
  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

/// What's over the window: a quiet scrim over the reel (a click on it closes), then the menu or the palette.
struct DeskOverlays: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let group: Anchor<CGRect>?
  var body: some View {
    let open = model.menuOpen || model.paletteOpen
    GeometryReader { g in
      ZStack(alignment: .topLeading) {
        if open {
          Theme.Desk.Surface.scrim
            .contentShape(Rectangle())
            .onTapGesture { model.closeMenu(); model.closePalette() }
            .transition(.opacity)
            .accessibilityHidden(true)
        }
        if model.menuOpen, let menu = model.projectMenu {
          let r = group.map { g[$0] } ?? CGRect(x: 0, y: -8, width: 0, height: 0)
          ProjectMenuView(menu: menu)
            .offset(x: max(8, r.minX), y: max(4, r.maxY + 6))
            .transition(Self.drop(reduceMotion))
        }
        if model.paletteOpen {
          PaletteView()
            .frame(width: Theme.Desk.Surface.paletteWidth)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, 40)
            .transition(Self.drop(reduceMotion))
        }
      }
      .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
    }
    .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.2, bounce: 0), value: model.menuOpen)
    .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.2, bounce: 0), value: model.paletteOpen)
  }

  /// Transform and opacity only; a crossfade with Reduce Motion.
  static func drop(_ reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98, anchor: .top)).combined(with: .offset(y: -4))
  }
}

/// The menu: the goal, its repos and where it runs, then the actions the daemon and the app have.
struct ProjectMenuView: View {
  @Environment(DeskModel.self) private var model
  let menu: ProjectMenu
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 8) {
        Text(verbatim: menu.goal).font(Theme.Desk.Surface.goalFont).foregroundStyle(Theme.Desk.text)
          .lineSpacing(2).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
        if !menu.repos.isEmpty {
          FlowRow(spacing: 4) {
            ForEach(menu.repos, id: \.self) { r in
              Text(verbatim: r).font(Theme.Desk.Surface.chipFont).foregroundStyle(Theme.Desk.secondary)
                .padding(.horizontal, 7).frame(height: 20)
                .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.Desk.Surface.chipFill))
            }
          }
        }
        if let line = Self.placeLine(menu) {
          HStack(spacing: 6) {
            if let p = Place(sandbox: menu.sandbox) { Image(systemName: p.symbol).font(.system(size: 11)) }
            Text(verbatim: line)
          }
          .font(Theme.Desk.Surface.placeFont).foregroundStyle(Theme.Desk.secondary)
        }
        if case .failed(let why) = menu.control {
          Text(verbatim: why).font(Theme.Desk.Surface.placeFont).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 10).padding(.top, 8).padding(.bottom, 10)
      ForEach(Array(menu.sections.enumerated()), id: \.offset) { _, section in
        SurfaceDivider()
        ForEach(section, id: \.self) { item in
          MenuRow(icon: Self.icon(item), title: item.title, shortcut: item.shortcut, red: item == .stop, busy: Self.busy(item, menu.control)) {
            Self.trailing(item)
          } action: { model.perform(item) }
        }
      }
    }
    .padding(Theme.Desk.Surface.padding)
    .frame(width: Theme.Desk.Surface.width, alignment: .leading)
    .modifier(SurfaceChrome())
    .background {
      Button("Close") { model.closeMenu() }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
    }
    .accessibilityElement(children: .contain).accessibilityLabel("Project menu")
  }

  /// "Cloud · boxd · 6 agents · started 21:30".
  static func placeLine(_ m: ProjectMenu) -> String? {
    var parts: [String] = []
    if let p = Place(sandbox: m.sandbox) { parts.append(p.word) }
    if let s = m.sandbox { parts.append(s == "docker" ? "Docker" : s == "fake-host" ? "fake host" : s) }
    parts.append("\(m.agents) \(m.agents == 1 ? "agent" : "agents")")
    if let t = m.startedAtMs { parts.append("started " + Date(timeIntervalSince1970: Double(t) / 1000).formatted(date: .omitted, time: .shortened)) }
    return parts.joined(separator: " · ")
  }

  static func icon(_ i: ProjectMenu.Item) -> String {
    switch i {
    case .messagePlanner: "bubble.left"
    case .changes: "doc.badge.plus"
    case .pause: "pause"
    case .resume: "play"
    case .stop: "stop"
    case .fold: "chevron.down"
    case .remove: "eye.slash"
    case .copyRunId: "doc.on.doc"
    }
  }

  static func busy(_ i: ProjectMenu.Item, _ c: ControlState) -> Bool {
    guard case .submitting(let a) = c else { return false }
    switch i { case .pause: return a == .pause; case .resume: return a == .resume; case .stop: return a == .cancel; default: return false }
  }

  @ViewBuilder static func trailing(_ i: ProjectMenu.Item) -> some View {
    switch i {
    case .changes(let added, let removed, let files, _):
      if added != nil || removed != nil {
        HStack(spacing: 4) {
          Text(verbatim: "+\(added ?? 0)").foregroundStyle(Theme.green)
          Text(verbatim: "−\(removed ?? 0)").foregroundStyle(Theme.red)
        }
        .font(.system(size: 12, design: .monospaced))
      }
      Spacer(minLength: 8)
      if let f = files { Text(verbatim: "\(f) \(f == 1 ? "file" : "files")").font(Theme.Desk.Surface.keyFont).foregroundStyle(Theme.Desk.tertiary) }
    case .copyRunId(let short):
      Spacer(minLength: 8)
      Text(verbatim: short).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.Desk.tertiary)
    default:
      Spacer(minLength: 8)
    }
  }
}

/// A row of the menu or the palette: icon, title, what follows it, the shortcut.
struct MenuRow<Trailing: View>: View {
  var icon: String? = nil
  let title: String
  var detail: String? = nil
  var shortcut: String? = nil
  var red = false
  var busy = false
  var selected = false
  @ViewBuilder let trailing: () -> Trailing
  let action: () -> Void
  @State private var hover = false
  var body: some View {
    Button(action: action) {
      HStack(spacing: Theme.Desk.Surface.rowGap) {
        if let icon {
          Image(systemName: icon).font(.system(size: 12.5)).foregroundStyle(red ? Theme.red : Theme.Desk.secondary)
            .frame(width: Theme.Desk.Surface.icon)
        }
        Text(verbatim: title).font(Theme.Desk.Surface.rowFont).foregroundStyle(red ? Theme.red : Theme.Desk.text).lineLimit(1)
        if let detail { Text(verbatim: detail).font(Theme.Desk.Surface.rowFont).foregroundStyle(Theme.Desk.tertiary).lineLimit(1) }
        trailing()
        if busy { ProgressView().controlSize(.mini) }
        if let shortcut { Text(verbatim: shortcut).font(Theme.Desk.Surface.keyFont).foregroundStyle(Theme.Desk.tertiary) }
      }
      .padding(.horizontal, Theme.Desk.Surface.rowPadding)
      .frame(height: Theme.Desk.Surface.rowHeight)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Theme.Desk.Surface.rowRadius, style: .continuous)
        .fill(selected ? Theme.Desk.Surface.selected : hover ? Theme.Desk.Surface.hover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(busy)
    .onHover { hover = $0 }
    .accessibilityLabel([title, detail].compactMap { $0 }.joined(separator: ", "))
  }
}
extension MenuRow where Trailing == Spacer {
  init(icon: String? = nil, title: String, detail: String? = nil, shortcut: String? = nil, selected: Bool = false, action: @escaping () -> Void) {
    self.init(icon: icon, title: title, detail: detail, shortcut: shortcut, selected: selected, trailing: { Spacer(minLength: 8) }, action: action)
  }
}

struct SurfaceDivider: View {
  var body: some View { Rectangle().fill(Theme.Desk.Surface.divider).frame(height: 0.5).padding(.horizontal, 6).padding(.vertical, 5) }
}

struct SurfaceChrome: ViewModifier {
  func body(content: Content) -> some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Desk.Surface.radius, style: .continuous)
    content
      .background(shape.fill(Theme.Desk.Surface.fill))
      .overlay(shape.strokeBorder(Theme.Desk.Surface.stroke, lineWidth: 0.5))
      .shadow(color: .black.opacity(0.5), radius: 20, y: 18)
  }
}

/// The ⌘K palette: type to filter; ↑ ↓ move, Return runs, Esc closes.
struct PaletteView: View {
  @Environment(DeskModel.self) private var model
  @FocusState private var focused: Bool
  var body: some View {
    @Bindable var m = model
    let shown = model.paletteShown
    let sel = min(model.paletteSelection, max(0, shown.count - 1))
    return VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 8) {
        Image(systemName: "command").font(.system(size: 12.5)).foregroundStyle(Theme.Desk.tertiary).frame(width: Theme.Desk.Surface.icon)
        TextField("", text: $m.paletteQuery, prompt: Text("Type an action, a project or an agent").foregroundStyle(Theme.Desk.tertiary))
          .textFieldStyle(.plain).font(.system(size: 14)).foregroundStyle(Theme.Desk.text)
          .focused($focused)
          .onSubmit { model.runPaletteSelection() }
          .onKeyPress(.downArrow) { model.movePaletteSelection(1); return .handled }
          .onKeyPress(.upArrow) { model.movePaletteSelection(-1); return .handled }
          .onKeyPress(.escape) { model.closePalette(); return .handled }
          .accessibilityLabel("Actions")
      }
      .padding(.horizontal, Theme.Desk.Surface.rowPadding).frame(height: 38)
      SurfaceDivider()
      if shown.isEmpty {
        Text("Nothing matches").font(Theme.Desk.Surface.rowFont).foregroundStyle(Theme.Desk.tertiary)
          .padding(.horizontal, Theme.Desk.Surface.rowPadding).frame(height: Theme.Desk.Surface.rowHeight)
      } else {
        ScrollViewReader { proxy in
          ScrollView {
            VStack(spacing: 0) {
              ForEach(Array(shown.enumerated()), id: \.element.id) { n, e in
                MenuRow(icon: Self.icon(e.action), title: e.title, detail: e.detail, shortcut: e.shortcut, selected: n == sel) { model.run(e.action) }
                  .id(e.id)
              }
            }
          }
          .scrollIndicators(.never)
          .frame(maxHeight: Theme.Desk.Surface.rowHeight * 9)
          .fixedSize(horizontal: false, vertical: true)
          .onChange(of: sel) { _, n in if shown.indices.contains(n) { proxy.scrollTo(shown[n].id) } }
        }
      }
    }
    .padding(Theme.Desk.Surface.padding)
    .modifier(SurfaceChrome())
    .onAppear { focused = true }
    .accessibilityElement(children: .contain).accessibilityLabel("Actions")
  }

  static func icon(_ a: PaletteAction) -> String {
    switch a {
    case .menu(let i): ProjectMenuView.icon(i)
    case .project: "square.stack"
    case .newProject: "plus"
    case .home: "house"
    case .follow: "eye"
    case .agent: "rectangle.portrait"
    }
  }
}

/// Wraps its items onto as many lines as they need (the menu's repo chips).
struct FlowRow: Layout {
  var spacing: CGFloat
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let rows = arrange(proposal.width ?? .infinity, subviews)
    return CGSize(width: rows.map(\.width).max() ?? 0, height: rows.map(\.height).reduce(0, +) + spacing * CGFloat(max(0, rows.count - 1)))
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var y = bounds.minY
    for row in arrange(bounds.width, subviews) {
      var x = bounds.minX
      for i in row.items { let s = subviews[i].sizeThatFits(.unspecified); subviews[i].place(at: CGPoint(x: x, y: y), proposal: .init(s)); x += s.width + spacing }
      y += row.height + spacing
    }
  }
  private func arrange(_ width: CGFloat, _ subviews: Subviews) -> [(items: [Int], width: CGFloat, height: CGFloat)] {
    var rows: [(items: [Int], width: CGFloat, height: CGFloat)] = []
    for (i, v) in subviews.enumerated() {
      let s = v.sizeThatFits(.unspecified)
      if let last = rows.last, last.width + spacing + s.width <= width {
        rows[rows.count - 1] = (last.items + [i], last.width + spacing + s.width, max(last.height, s.height))
      } else { rows.append(([i], s.width, s.height)) }
    }
    return rows
  }
}
#endif
