#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

// Over the window: the open project's menu (ReelMenu), dropped from its name (the board's menu: #232326, 13 pt corners,
// 30 pt rows), and the scrim under Search ⌘K (its panel is SearchPanel.swift). A click outside closes either; Esc too.

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
        // Search ⌘K: in the window (SearchView), or its own panel over it (SearchPanel.swift; knob search.host).
        if DeskKnobs.searchHost.value == .panel {
          SearchPanelHost(open: model.paletteOpen).frame(width: 0, height: 0).accessibilityHidden(true)
        } else if model.paletteOpen || model.paletteEverOpened {
          // Built once it has shown, then hidden while closed (`SearchOverlayHost.show`): ⌘K again shows a view that is
          // already there instead of making a hosting view, its field and its list each time.
          SearchOverlaySlot(width: SearchMetrics.width(for: g.size.width), open: model.paletteOpen)
            .frame(maxWidth: .infinity, alignment: .center)
            .padding(.top, SearchMetrics.top - Theme.Desk.titleBar)
            .opacity(model.paletteOpen ? 1 : 0)
        }
      }
      .frame(width: g.size.width, height: g.size.height, alignment: .topLeading)
    }
    .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.2, bounce: 0), value: model.menuOpen)
    // The scrim under Search ⌘K: at once from the keyboard (SPEC §4), a short fade otherwise.
    .animation(model.paletteByKey ? nil : reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.18), value: model.paletteOpen)
    .background(PaletteFocusReturn(model: model, open: model.paletteOpen).frame(width: 0, height: 0).accessibilityHidden(true))
  }

  /// Transform and opacity only; a crossfade with Reduce Motion.
  static func drop(_ reduceMotion: Bool) -> AnyTransition {
    reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.98, anchor: .top)).combined(with: .offset(y: -4))
  }
}

/// Search ⌘K in the window, at its height for the results it shows (fixed rows: known without laying them out). Its
/// own view, so only it follows the results as they change.
struct SearchOverlaySlot: View {
  @Environment(DeskModel.self) private var model
  let width: CGFloat
  let open: Bool
  var body: some View {
    let s = model.search
    SearchOverlay(model: model, open: open)
      .frame(width: width, height: SearchMetrics.queryHeight + 0.5 + SearchMetrics.listHeight(s.sections, query: s.query) + SearchMetrics.footer)
  }
}

/// Search ⌘K in the window, drawn in a hosting view of its own (`SearchOverlayHost`), as its panel is: a view that is
/// the palette and nothing else, which the bench finds and judges by itself (its ink drawn alone, not through to the
/// reel behind it). Its shadow reaches past it (the view doesn't clip).
struct SearchOverlay: NSViewRepresentable {
  let model: DeskModel
  let open: Bool
  func makeNSView(context: Context) -> SearchOverlayHost {
    let h = SearchOverlayHost(rootView: SearchOverlayRoot(model: model))
    h.sizingOptions = []
    h.clipsToBounds = false
    return h
  }
  func updateNSView(_ h: SearchOverlayHost, context: Context) {
    if h.rootView.model !== model { h.rootView = SearchOverlayRoot(model: model) }
    h.show(open, fading: context.transaction.animation != nil)
  }
}

/// The palette's content in its own hosting view: SearchView on the model (a hosting view starts a new environment).
package struct SearchOverlayRoot: View {
  let model: DeskModel
  package var body: some View { SearchView(onHeight: { _ in }, inWindow: true).environment(model) }
}

/// The in-window palette's hosting view (the bench's ink region `palette`, DESKBENCH.md).
package final class SearchOverlayHost: NSHostingView<SearchOverlayRoot> {
  private var hiding: DispatchWorkItem?

  /// Open: shown. Closed: hidden, after the fade when the close fades (a click outside). The field gives up the keyboard
  /// first: AppKit hands a hidden first responder's keyboard to the next key view, and the palette gives it back to
  /// what had it before (`PaletteFocusReturn`).
  func show(_ open: Bool, fading: Bool) {
    hiding?.cancel(); hiding = nil
    if open { if isHidden { isHidden = false }; return }
    guard !isHidden else { return }
    if let w = window, let v = PaletteFocusReturn.Keeper.owner(w.firstResponder), v.isDescendant(of: self) { w.makeFirstResponder(nil) }
    guard fading else { isHidden = true; return }
    let work = DispatchWorkItem { [weak self] in self?.isHidden = true }
    hiding = work
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.25, execute: work)
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

/// A row of the menu: icon, title, what follows it, the shortcut.
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

/// Search ⌘K dismissed (Esc, a click outside, ⌘K again) gives the keyboard back to what had it before it opened: a
/// pane's or a column's message box, the sidebar's list, a field. SwiftUI otherwise leaves it with the closed field's
/// editor (keys typed next went nowhere) or with nobody. When that view is gone or hidden (the pane shows another
/// agent, the sidebar folded), or nothing had the keyboard, the pane you are in takes it (folded: the focused column).
/// A result opened (↩, ⌘↩, a click) leaves the keyboard where the opened place puts it.
struct PaletteFocusReturn: NSViewRepresentable {
  let model: DeskModel
  let open: Bool
  func makeNSView(context: Context) -> Keeper { Keeper(model: model) }
  func updateNSView(_ v: Keeper, context: Context) { v.set(open: open) }

  final class Keeper: NSView {
    private let model: DeskModel
    private var open = false
    /// What had the keyboard when the palette opened (a field, not its shared editor), and when it closed (its field).
    private weak var before: NSView?
    private weak var during: NSView?
    init(model: DeskModel) { self.model = model; super.init(frame: .zero) }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }

    func set(open o: Bool) {
      guard o != open else { return }
      open = o
      if o {
        let had = window.flatMap { Self.owner($0.firstResponder) }
        before = had.flatMap { Self.isSearchField($0) ? nil : $0 }
      } else {
        during = window.flatMap { Self.owner($0.firstResponder) }
        // After the update that closes it.
        DispatchQueue.main.async { [weak self] in self?.giveBack() }
      }
    }

    private func giveBack() {
      guard let w = window, !open else { return }
      defer { before = nil; during = nil }
      if model.paletteOpenedResult { return }
      // Something other than the palette's field has the keyboard (something took it meanwhile): leave it there.
      if let now = Self.owner(w.firstResponder), now !== during, !Self.isSearchField(now), now.window === w, !now.isHiddenOrHasHiddenAncestor { return }
      if let b = before, b.window === w, !b.isHiddenOrHasHiddenAncestor, b.acceptsFirstResponder, w.makeFirstResponder(b) { return }
      if takeIntoPane(w) { return }
      w.makeFirstResponder(nil)   // out of the closed field, at least
    }

    /// The focused pane (opened), else the reel's focused column (folded).
    private func takeIntoPane(_ w: NSWindow) -> Bool {
      guard let root = w.contentView else { return false }
      var pane: NativeColumnView?, reel: ReelColumnViews?
      func walk(_ v: NSView) {
        guard !v.isHidden else { return }
        if let c = v as? NativeColumnView, c.isPane {
          if pane == nil || c.paneFocused { pane = c }
          return
        }
        if reel == nil, let r = v as? ReelColumnViews, r.reelKind == .project { reel = r }
        v.subviews.forEach(walk)
      }
      walk(root)
      if let pane { return pane.takeKeyboard() }
      guard !model.nav.sidebarOpen, !model.needs.isOpen, let reel, let f = model.focusedAgent, let i = model.columns.firstIndex(of: f),
            let column = reel.columnView(at: i), !column.isHiddenOrHasHiddenAncestor else { return false }
      if let c = column as? NativeColumnView { return c.takeKeyboard() }
      return w.makeFirstResponder(column)
    }

    /// The view a responder stands for: a field editor's field, else the view itself.
    static func owner(_ r: NSResponder?) -> NSView? {
      if let t = r as? NSTextView, t.isFieldEditor { return t.delegate as? NSView }
      return r as? NSView
    }
    static func isSearchField(_ v: NSView) -> Bool { (v as? NSTextField)?.accessibilityIdentifier() == SearchField.identifier }
  }
}
#endif
