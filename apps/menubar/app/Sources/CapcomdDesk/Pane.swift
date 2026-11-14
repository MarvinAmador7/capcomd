#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// The opened window (RexMain): the sidebar over the window's left 248 pt and, beside it, one agent's pane. The title bar
// goes; the pane's 44 pt header is the top line. The reel stays built underneath at its own size (folding shows it as
// it was, and a toggle never reflows it); the pane is an AppKit column (NativeColumnView, `.pane`) with the reel's own
// thread, message box and decision.

/// What the window shows while the sidebar is open. Nothing is built until the first open; from then on it stays built
/// and a toggle only shows or hides it. It lives in AppKit views of its own (`OpenedLayerView`): SwiftUI takes a view at
/// opacity 0 out of the window's view tree, so hiding it with SwiftUI re-added every AppKit-backed view on each open (the
/// pane, the scroll views, the text fields), and each addition recomputed the window's key-view loop over the reel too.
/// `isHidden` and a Core Animation transform keep them in place.
struct OpenedLayer: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.openSettings) private var openSettings
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.threadHost) private var threadHost
  var body: some View {
    if model.nav.everOpened {
      let open = model.nav.sidebarOpen
      // Folded, the panes keep what they show (nothing here is read, so a reel focus change doesn't re-render this).
      let deck = open ? PaneDeckInput(runId: model.openRunId, layout: model.panes, shown: model.panesShown, expanded: model.nav.expanded) : nil
      OpenedLayerHost(model: model, open: open, deck: deck, reduceMotion: reduceMotion,
                      openSettings: { openSettings() }, threadHost: threadHost)
    }
  }
}

struct OpenedLayerHost: NSViewRepresentable {
  let model: DeskModel
  let open: Bool
  let deck: PaneDeckInput?
  let reduceMotion: Bool
  let openSettings: () -> Void
  let threadHost: ThreadHostBox?
  func makeNSView(context: Context) -> OpenedLayerView {
    OpenedLayerView(model: model, openSettings: openSettings, threadHost: threadHost, open: open)
  }
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: OpenedLayerView, context: Context) -> CGSize? {
    proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
  }
  /// A click on the sidebar button, a pane's expand button or its ×, animates (its transaction has an animation); the
  /// keyboard doesn't.
  func updateNSView(_ v: OpenedLayerView, context: Context) {
    let animated = context.transaction.animation != nil && !context.transaction.disablesAnimations
    if let deck { v.set(deck: deck, animated: animated, reduceMotion: reduceMotion) }
    v.set(open: open, animated: animated, reduceMotion: reduceMotion)
  }
}

/// The opened window's AppKit side: the sidebar (248 pt) and the main area beside it, each laid out by frame. The main
/// area is Home, the Needs you reel or the unreachable notice (`PaneArea`, a hosting view) under the panes
/// (`PaneDeckView`, AppKit: one reel column per pane). Shown and hidden with `isHidden`; opening by a click slides the
/// sidebar in by transform and fades the main area in (0.25 s, ease-out, no bounce; Reduce Motion: a 0.15 s
/// crossfade), folding the reverse. Expanded, the main area takes the whole window and the sidebar hides. Nothing is
/// laid out by an animation: the frames are final from the start.
final class OpenedLayerView: NSView {
  private let sidebar: NSHostingView<AnyView>
  private let main = Flipped()
  private let pane: NSHostingView<AnyView>
  private let deck: PaneDeckView
  private var open: Bool
  private var expanded = false
  private var placed: (size: CGSize, expanded: Bool)?
  /// Bumped per toggle: a fold's completion doesn't hide a layer that was opened again meanwhile.
  private var serial = 0

  init(model: DeskModel, openSettings: @escaping () -> Void, threadHost: ThreadHostBox?, open: Bool) {
    func root<V: View>(_ v: V) -> AnyView {
      AnyView(v.environment(model).environment(\.threadHost, threadHost ?? ThreadHostBox(host: model))
        .environment(\.deskOpenSettings, DeskSettingsOpener(open: openSettings)).preferredColorScheme(.dark))
    }
    sidebar = NSHostingView(rootView: root(SidebarView()))
    pane = NSHostingView(rootView: root(PaneArea()))
    deck = PaneDeckView(model: model)
    self.open = open
    super.init(frame: .zero)
    wantsLayer = true
    main.wantsLayer = true
    for h in [pane, sidebar] {
      h.safeAreaRegions = []
      h.sizingOptions = []
      h.wantsLayer = true
    }
    main.addSubview(pane)
    main.addSubview(deck)
    addSubview(main)
    addSubview(sidebar)
    isHidden = !open
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    guard placed.map({ $0.size != bounds.size || $0.expanded != expanded }) ?? true else { return }
    placed = (bounds.size, expanded)
    let w = SidebarMetrics.width
    sidebar.frame = CGRect(x: 0, y: 0, width: w, height: bounds.height)
    sidebar.isHidden = expanded
    main.frame = expanded ? bounds : CGRect(x: w, y: 0, width: max(0, bounds.width - w), height: bounds.height)
    pane.frame = main.bounds
    deck.frame = main.bounds
  }

  /// The panes: what they show, and whether the focused one has the window. Expanding (or collapsing) lays the window
  /// out once, at its final frames; a click fades the sidebar back in on the way out.
  func set(deck d: PaneDeckInput, animated: Bool, reduceMotion: Bool) {
    deck.update(d, animated: animated, reduceMotion: reduceMotion)
    guard d.expanded != expanded else { return }
    expanded = d.expanded
    needsLayout = true
    layoutSubtreeIfNeeded()
    if !expanded, animated {
      sidebar.layer?.add(Self.anim("opacity", from: 0, to: 1, duration: reduceMotion ? 0.15 : 0.2), forKey: "fade")
    }
  }

  func set(open o: Bool, animated: Bool, reduceMotion: Bool) {
    guard o != open else { return }
    open = o
    serial += 1
    let s = serial
    sidebar.layer?.removeAllAnimations(); main.layer?.removeAllAnimations(); layer?.removeAllAnimations()
    guard animated else { isHidden = !o; return }
    if o { isHidden = false }
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      guard let self, self.serial == s else { return }
      if !self.open { self.isHidden = true }
      self.sidebar.layer?.removeAllAnimations(); self.main.layer?.removeAllAnimations(); self.layer?.removeAllAnimations()
    }
    if reduceMotion {
      layer?.add(Self.anim("opacity", from: o ? 0 : 1, to: o ? 1 : 0, duration: 0.15), forKey: "fade")
    } else {
      let w = Double(SidebarMetrics.width)
      sidebar.layer?.add(Self.anim("transform.translation.x", from: o ? -w : 0, to: o ? 0 : -w, duration: 0.25), forKey: "slide")
      main.layer?.add(Self.anim("opacity", from: o ? 0 : 1, to: o ? 1 : 0, duration: 0.25), forKey: "fade")
    }
    CATransaction.commit()
  }

  /// Transform or opacity only, ease-out, held at its end until the completion block tidies up.
  static func anim(_ key: String, from: Any, to: Any, duration: Double, hold: Bool = true) -> CABasicAnimation {
    let a = CABasicAnimation(keyPath: key)
    a.fromValue = from; a.toValue = to; a.duration = duration
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    if hold { a.fillMode = .both; a.isRemovedOnCompletion = false }
    return a
  }

  final class Flipped: NSView { override var isFlipped: Bool { true } }
}

/// What the panes show: the open run, its panes, whether they have the main area (not Home, not the Needs you reel),
/// and whether the focused one has the window.
struct PaneDeckInput: Equatable {
  var runId: String?
  var layout = PaneLayout()
  var shown = false
  var expanded = false
}

/// The panes (RexSplit): one reel column (`NativeColumnView`, pane style) per pane, laid out by frame: 8 pt from the
/// top, right and bottom, 8 pt apart; columns share the width, a column's panes its height. A pane keeps its view while
/// its agent changes (a row, ⌃1–9, the palette reconfigure it, as the reel's slots are), and a view closed is kept for
/// the next split. Expanded, the focused pane's view takes the whole area and the others hide: no view is made or
/// rebuilt, so the thread keeps its rows and its scroll position.
final class PaneDeckView: NSView {
  private let model: DeskModel
  private final class Slot {
    let view: NativeColumnView
    let state: PaneState
    var paneId: Int
    init(view: NativeColumnView, state: PaneState, paneId: Int) { self.view = view; self.state = state; self.paneId = paneId }
  }
  private var slots: [Slot] = []
  /// Views of closed panes, kept for the next split (out of the window, so their trees are empty).
  private var pool: [Slot] = []
  private var input = PaneDeckInput()
  private var placed: (size: CGSize, input: PaneDeckInput)?
  /// The expand or collapse a click asked to animate, run once the frames are final.
  private var pendingMotion: (expanding: Bool, reduceMotion: Bool)?

  init(model: DeskModel) {
    self.model = model
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor(Theme.Desk.ground).cgColor
    isHidden = true
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }

  func update(_ i: PaneDeckInput, animated: Bool, reduceMotion: Bool) {
    guard i != input else { return }
    let old = input
    input = i
    // Another run: the model made new slices, so every view starts anew, even for an agent id it showed before.
    if i.runId != old.runId { for s in slots { s.view.forget() } }
    let want = i.layout.slots
    var free = slots.filter { s in !want.contains { $0.id == s.paneId } }
    var next: [Slot] = []
    for w in want {
      let s: Slot
      if let kept = slots.first(where: { $0.paneId == w.id }) { s = kept }
      else if let f = free.popLast() ?? pool.popLast() { s = f }
      else {
        let st = PaneState(id: w.id)
        s = Slot(view: NativeColumnView(agentId: w.agent, model: model, style: .pane, pane: st), state: st, paneId: w.id)
      }
      s.paneId = w.id
      s.view.configure(w.agent)
      if s.view.superview !== self { addSubview(s.view) }
      next.append(s)
    }
    for s in free {
      s.view.removeFromSuperview()
      s.paneId = -1
      if pool.count < 2 { pool.append(s) }
    }
    slots = next
    let split = want.count > 1
    for s in slots {
      let focused = s.paneId == i.layout.focused
      s.state.set(id: s.paneId, focused: focused, split: split, expanded: i.expanded && focused)
    }
    if isHidden == i.shown { isHidden = !i.shown }
    if animated, old.expanded != i.expanded, i.shown { pendingMotion = (i.expanded, reduceMotion) }
    needsLayout = true
  }

  override func layout() {
    super.layout()
    guard placed.map({ $0.size != bounds.size || $0.input != input }) ?? true else { return }
    placed = (bounds.size, input)
    if !input.expanded, model.paneArea != bounds.size { model.paneArea = bounds.size }
    let focused = slots.first { $0.paneId == input.layout.focused }
    if input.expanded, let f = focused {
      for s in slots where s !== f { if !s.view.isHidden { s.view.isHidden = true } }
      if f.view.isHidden { f.view.isHidden = false }
      if f.view.frame != bounds { f.view.frame = bounds }
    } else {
      let m = PaneMetrics.inset
      let area = CGRect(x: 0, y: m, width: max(0, bounds.width - m), height: max(0, bounds.height - 2 * m))
      let frames = input.layout.frames(in: area, gap: PaneMetrics.gap)
      for s in slots {
        if s.view.isHidden { s.view.isHidden = false }
        if let r = frames[s.paneId], s.view.frame != r { s.view.frame = r }
      }
    }
    if let m = pendingMotion { pendingMotion = nil; play(expanding: m.expanding, reduceMotion: m.reduceMotion) }
  }

  /// A click's expand: the pane comes up from a 0.98 scale and fades in (0.22 s, ease-out); its collapse: the panes fade
  /// back in (0.2 s). Reduce Motion: a 0.15 s fade. Transform and opacity only, on the views' own layers.
  private func play(expanding: Bool, reduceMotion: Bool) {
    let shown = slots.filter { !$0.view.isHidden }
    for s in shown {
      guard let l = s.view.layer else { continue }
      l.removeAnimation(forKey: "pane.fade"); l.removeAnimation(forKey: "pane.scale")
      l.add(OpenedLayerView.anim("opacity", from: 0, to: 1, duration: reduceMotion ? 0.15 : expanding ? 0.22 : 0.2, hold: false), forKey: "pane.fade")
      if expanding, !reduceMotion {
        let k: CGFloat = 0.98, b = s.view.bounds
        let from = CATransform3DConcat(CATransform3DMakeScale(k, k, 1), CATransform3DMakeTranslation(b.width * (1 - k) / 2, b.height * (1 - k) / 2, 0))
        l.add(OpenedLayerView.anim("transform", from: NSValue(caTransform3D: from), to: NSValue(caTransform3D: CATransform3DIdentity), duration: 0.22, hold: false), forKey: "pane.scale")
      }
    }
  }
}

extension EnvironmentValues {
  /// The app's Settings window, handed into the opened layer's own hosting views (they aren't in the app's scene).
  @Entry var deskOpenSettings: DeskSettingsOpener? = nil
}

/// The Settings action, compared as always equal (it never changes), so carrying it in the environment invalidates nothing.
struct DeskSettingsOpener: Equatable {
  let open: () -> Void
  static func == (_: Self, _: Self) -> Bool { true }
}

/// The main area under the panes: Home (+ and ⌘0 show it here, as folded; only while open, so there is one Home), the
/// Needs you reel, or the unreachable notice. While a project's panes show, it is the window's ground (the panes are
/// AppKit views over it, `PaneDeckView`).
struct PaneArea: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("PaneArea")
    let open = model.nav.sidebarOpen
    return Group {
      if open, model.needs.isOpen {
        NeedsReelScreen()   // the hand or the Needs you heading: the reel takes the pane's place
      } else if open, let np = model.newProject {
        HomeView(np: np)
      } else if open, model.openRunId == nil, model.unreachable {
        Unreachable()
      } else {
        Color.clear
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Desk.ground)
  }
}

/// The pane header's host: `PaneHead` on the agent's slice. A click focuses the pane, as anywhere in it.
struct PaneHeadHost: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) {
      PaneHead(slice: a)
        .contentShape(Rectangle())
        .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}

/// RexMain `.ph`: the head, its title (a double-click renames it), profile, short ID, status; on the right the project ·
/// place · elapsed, then the pane's controls. In a split (RexSplit) the right side is the elapsed time alone. Expanded
/// (RexExpanded `.xh`): 52 pt, in the title bar's band clear of the traffic lights, with the Needs you hand and
/// arrows-in.
struct PaneHead: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.paneState) private var pane
  let slice: AgentSlice
  var body: some View {
    DeskProbe.body("PaneHead", id: slice.id)
    let h = slice.header, asks = slice.approval != nil
    let expanded = pane?.expanded == true, split = pane?.split == true && !expanded
    let deck = model.decks.first { $0.runId == h.runId }
    let place = Place(sandbox: deck?.sandbox).map { $0 == .local ? "This Mac" : "boxd" }
    return HStack(spacing: 8) {
      BotAvatar(traits: slice.bot, size: .small, cell: 1).frame(width: 24, height: 24)
      if slice.renaming == .header {
        InlineTitleField(agentId: slice.id, font: .system(size: 13, weight: .semibold), width: Theme.Desk.headerField)
      } else {
        Text(verbatim: h.tabLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.Desk.text)
          .lineLimit(1).truncationMode(.tail).layoutPriority(1)
          .contentShape(Rectangle())
          .onTapGesture(count: 2) { if model.store.titlesSupported { model.beginRename(slice.id, at: .header) } }
          .help(slice.renameFailure.map { "Couldn't rename it: \($0)" } ?? "Double-click to rename")
      }
      Text(verbatim: h.name).font(.system(size: 13)).foregroundStyle(Theme.Desk.secondary).fixedSize()
      Text(verbatim: String(h.agentId.suffix(4))).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.Desk.tertiary).fixedSize()
      Text(verbatim: "· " + ColumnHead.state(h, asks: asks)).font(.system(size: 13))
        .foregroundStyle(asks ? Theme.amber : h.status == .failed ? Theme.red : Theme.Desk.tertiary).fixedSize()
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        if !split {
          Text(verbatim: [deck?.title, place].compactMap { $0 }.joined(separator: " · "))
            .lineLimit(1).truncationMode(.tail)
        }
        if h.status == .running, let start = h.startedAtMs {
          if !split { Text(verbatim: " · ") }
          Text(Date(timeIntervalSince1970: Double(start) / 1000), style: .timer).monospacedDigit()
        }
      }
      .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.Desk.tertiary)
      .padding(.trailing, expanded ? 8 : 6)
      PaneControls(slice: slice)
    }
    .lineLimit(1)
    .padding(.leading, expanded ? Theme.Desk.titleLeading : 14).padding(.trailing, expanded ? 12 : 8)
    .frame(height: expanded ? PaneMetrics.expandedHeader : Theme.Desk.paneHeader)
    .contentShape(Rectangle())
    .accessibilityElement(children: .contain)
  }
}

/// The pane's controls, right of its header (RexSplit `.ctl`: 26 pt buttons, #7D7D85). The focused pane: split right
/// (⌘D), split down (⇧⌘D), •••, expand (⇧⌘↩). Another pane of a split: × (⌘W when focused) and expand. Expanded
/// (RexExpanded): the Needs you hand and arrows-in (Esc).
struct PaneControls: View {
  @Environment(\.paneState) private var pane
  let slice: AgentSlice
  var body: some View {
    HStack(spacing: 0) {
      if pane?.expanded == true {
        NeedsHand(style: .header)
      } else {
        PaneSplitSlot(agentId: slice.id)
        if pane?.focused ?? true { PaneMore(slice: slice) }
      }
      PaneExpandSlot(agentId: slice.id)
    }
  }
}

/// The focused pane's split right and split down; another pane's ×.
struct PaneSplitSlot: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.paneState) private var pane
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let agentId: String
  var body: some View {
    if let pane {
      if pane.focused {
        PaneButton(symbol: "rectangle.split.2x1", help: "Split right (⌘D)", label: "Split right") { model.split(down: false) }
        PaneButton(symbol: "rectangle.split.1x2", help: "Split down (⇧⌘D)", label: "Split down") { model.split(down: true) }
      } else {
        PaneButton(symbol: "xmark", help: "Close this split", label: "Close this split", size: 12) {
          withAnimation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.2)) { model.closePane(pane.id) }
        }
      }
    }
  }
}

/// Arrows-out: the pane takes the window (⇧⌘↩); expanded, arrows-in (pressed, as RexExpanded's `.ib.on`) gives it back,
/// and so does Esc unless something above takes it (the palette, the menu, a rename field, the Stop question).
struct PaneExpandSlot: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.paneState) private var pane
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let agentId: String
  var body: some View {
    if let pane {
      if pane.expanded {
        SideButton(symbol: "arrow.down.right.and.arrow.up.left", on: true, help: "Collapse pane (Esc)", label: "Collapse pane") {
          withAnimation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.2)) { model.collapsePane() }
        }
        .modifier(EscLeaves())
      } else {
        PaneButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Expand pane (⇧⌘↩)", label: "Expand pane") {
          withAnimation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.22)) { model.expandPane(pane.id) }
        }
      }
    }
  }
}

/// A pane header's icon button (RexSplit `.ph .ctl .ib`: 26 pt, 7 pt corners, #7D7D85; the hover wash).
struct PaneButton: View {
  let symbol: String
  let help: String
  let label: String
  var size: CGFloat = 13
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: size)).foregroundStyle(Theme.Desk.paneControl)
        .frame(width: 26, height: 26).contentShape(Rectangle())
    }
    .buttonStyle(SideButtonStyle(radius: Theme.Desk.Side.buttonRadius))
    .help(help)
    .accessibilityLabel(label)
  }
}

/// The pane's •••: the same daemon actions as its row's.
struct PaneMore: View {
  @Environment(DeskModel.self) private var model
  let slice: AgentSlice
  var body: some View {
    let h = slice.header
    let row = SidebarRow(id: h.agentId, runId: h.runId, projectId: model.openProjectId ?? "", title: h.tabLabel, bot: slice.bot,
                         provider: h.provider, level: 0, word: nil, tone: .plain)
    return Menu {
      ForEach(model.agentMenu(row), id: \.self) { item in
        if case .copyId = item { Divider() }
        Button { model.perform(item, on: row) } label: {
          if case .copyId(let short) = item { Text("Copy Agent ID (\(short))") } else { Text(item.title) }
        }
      }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.Desk.paneControl)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .frame(width: 26, height: 26)
    .help("More")
    .accessibilityLabel("More for \(h.tabLabel)")
  }
}
#endif
