#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdUI

/// A column as an AppKit view (`desk.column=native`; design note: LAYOUT.md). Its layer is the column's frame: fill,
/// continuous corner, clip and stroke. Inside it, by frame, two hosting views: the head (`ColumnHead`, 40 pt) and the
/// body (thread, then the message box or the decision). The stroke follows focus and asks through observation, so a
/// focus change (every step) sets a layer border instead of re-rendering `Column` and laying out its whole SwiftUI
/// tree, thread included. Text, selection and accessibility stay SwiftUI's: the head and the body are the views the
/// SwiftUI column was made of.
final class NativeColumnView: NSView {
  /// The agent it shows. A reel slot (`reel.columns=reuse`) is configured with another as the reel moves.
  private(set) var agentId: String
  private let model: DeskModel
  /// Per-agent state a slot hands from one agent to the next (the message box's draft), when it is a slot.
  private let memory: SlotMemory?
  /// A reel column, or the opened window's one pane (PaneHead, 44 pt; no focus ring: the pane is the focus).
  private let style: ColumnStyle
  private let head: NSHostingView<AnyView>
  private let body: NSHostingView<AnyView>
  /// The size the head and body were placed for (and whether expanded): placing is skipped until it changes. And the
  /// agent they showed then ("" once the views start anew: another agent, another run, out of the window).
  private var placed: (size: CGSize, expanded: Bool)?
  private var placedAgent = ""
  private var stroke: StrokeKey?
  /// The pane it is (pane style): focus among splits, expanded. Nil in the reel.
  private let pane: PaneState?
  /// The stroke, drawn over the head and body as SwiftUI's `strokeBorder` draws it: the same continuous rounded
  /// rectangle, inset by half the line (a layer border antialiases its corners differently).
  private let edge = StrokeView()
  /// In the Needs you reel: no amber ring (every column there asks).
  private let needs: Bool

  init(agentId: String, model: DeskModel, memory: SlotMemory? = nil, style: ColumnStyle = .reel, needs: Bool = false, pane: PaneState? = nil) {
    self.agentId = agentId
    self.model = model
    self.memory = memory
    self.style = style
    self.needs = needs
    self.pane = pane
    head = NSHostingView(rootView: Self.head(agentId, model, style, needs, pane))
    body = NSHostingView(rootView: Self.body(agentId, model, memory, style, needs, pane))
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor(Theme.Desk.column).cgColor
    layer?.cornerRadius = Theme.Desk.columnRadius
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    for h in [head, body] {
      h.safeAreaRegions = []
      h.sizingOptions = []   // placed by frame; nothing to measure
      addSubview(h)
    }
    addSubview(edge)
    observe()
  }
  required init?(coder: NSCoder) { fatalError() }
  deinit {
    heldObservers.forEach(NotificationCenter.default.removeObserver)
    if let heldWheel { NSEvent.removeMonitor(heldWheel) }
  }
  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    let expanded = pane?.expanded == true
    guard placed.map({ $0.size != bounds.size || $0.expanded != expanded }) ?? true else { return }
    // Resized while showing the same thread: a thread made since opens at its own foot (ColumnThread), not at the old
    // one's place.
    let resized = placed != nil && placedAgent == agentId
    placed = (bounds.size, expanded)
    placedAgent = agentId
    let h = style == .pane ? (expanded ? PaneMetrics.expandedHeader : Theme.Desk.paneHeader) : Theme.Desk.columnHeader
    // A pane resized (a split, a close, expand, collapse) keeps its thread where it was, measured from the foot: SwiftUI's
    // bottom anchor kept the offset from the top instead when the pane got shorter, and the lazy rows of the new place
    // were never made (a blank thread).
    let foot = style == .pane && resized ? threadScroll().map(Self.fromFoot) : nil
    head.frame = CGRect(x: 0, y: 0, width: bounds.width, height: h)
    body.frame = CGRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
    edge.frame = bounds
    edge.update()
    if let foot {
      body.layoutSubtreeIfNeeded()
      if foot > Self.nearFoot {
        hold(foot)
      } else {
        // At the foot: put back now and once more after the rows the new place needs are made; SwiftUI's bottom anchor
        // keeps it there as the rest are measured.
        release()
        restore(foot)
        RunLoop.main.perform { MainActor.assumeIsolated { [weak self] in self?.restore(foot) } }
      }
    }
  }

  // MARK: the thread's place across a resize

  /// After a resize the thread's lazy stack measures its rows again at the new width, over the next layouts: its document
  /// height moves by thousands of points as measured rows replace estimates (collapsing an expanded pane, 16,469 pt to
  /// 4,142), and SwiftUI's anchor didn't keep the reader's place through that: it ended at the foot, or far above where
  /// it was. So the distance from the foot is held: put back each time the document or the offset moves, for `holdFor`
  /// after the resize, until a hand scrolls the thread or the pane shows another thread.
  ///
  /// A reader at the foot (within `nearFoot`) isn't held: SwiftUI's bottom anchor keeps it there as the rows are
  /// measured, as it did before, and a thread opened at its foot (ColumnThread, the #277 blank-pane fix) stays SwiftUI's
  /// to place.
  static let nearFoot: CGFloat = 4
  private var held: (foot: CGFloat, until: CFTimeInterval, agent: String)?
  private weak var heldScroll: NSScrollView?
  private var heldObservers: [NSObjectProtocol] = []
  private var heldWheel: Any?
  private var heldPending = false
  static let holdFor: CFTimeInterval = 1.0

  private func hold(_ foot: CGFloat) {
    guard let sv = threadScroll(), let doc = sv.documentView else { return }
    if heldScroll !== sv { release() }
    held = (foot, CACurrentMediaTime() + Self.holdFor, agentId)
    restore(foot)
    if heldObservers.isEmpty {
      heldScroll = sv
      doc.postsFrameChangedNotifications = true
      sv.contentView.postsBoundsChangedNotifications = true
      let nc = NotificationCenter.default
      // Posted inside SwiftUI's layout: the offset is put back once that layout is done (the run loop's next blocks).
      let changed: @Sendable (Notification) -> Void = { [weak self] _ in MainActor.assumeIsolated { self?.keepHeldSoon() } }
      heldObservers = [
        nc.addObserver(forName: NSView.frameDidChangeNotification, object: doc, queue: nil, using: changed),
        nc.addObserver(forName: NSView.boundsDidChangeNotification, object: sv.contentView, queue: nil, using: changed),
        nc.addObserver(forName: NSScrollView.willStartLiveScrollNotification, object: sv, queue: nil) { [weak self] _ in
          MainActor.assumeIsolated { self?.release() }
        },
      ]
      // A mouse wheel over the thread is a hand too (it starts no live scroll).
      heldWheel = NSEvent.addLocalMonitorForEvents(matching: .scrollWheel) { [weak self] e in
        nonisolated(unsafe) let event = e   // local monitors run on the main thread
        MainActor.assumeIsolated {
          guard let self, let sv = self.heldScroll, event.window === sv.window,
                sv.bounds.contains(sv.convert(event.locationInWindow, from: nil)) else { return }
          self.release()
        }
        return e
      }
    }
    keepHeldSoon()
    DispatchQueue.main.asyncAfter(deadline: .now() + Self.holdFor + 0.05) { [weak self] in self?.keepHeld() }
  }

  /// Once per turn of the run loop, after the layout that moved the document.
  private func keepHeldSoon() {
    guard held != nil, !heldPending else { return }
    heldPending = true
    RunLoop.main.perform { MainActor.assumeIsolated { [weak self] in self?.heldPending = false; self?.keepHeld() } }
  }

  private func keepHeld() {
    guard let h = held else { return }
    guard h.agent == agentId, CACurrentMediaTime() < h.until, window != nil, let sv = heldScroll, sv === threadScroll() else { return release() }
    restore(h.foot)
  }

  private func release() {
    held = nil
    heldObservers.forEach(NotificationCenter.default.removeObserver)
    heldObservers = []
    if let w = heldWheel { NSEvent.removeMonitor(w) }
    heldWheel = nil
    heldScroll = nil
  }

  /// The thread's scroll view (the body's tallest vertical one), kept while it is in the body.
  private weak var thread: NSScrollView?
  private func threadScroll() -> NSScrollView? {
    if let t = thread, t.isDescendant(of: body) { return t }
    var best: NSScrollView?
    func walk(_ v: NSView) {
      if let sv = v as? NSScrollView, sv.documentView != nil, best == nil || sv.bounds.height > best!.bounds.height { best = sv }
      v.subviews.forEach(walk)
    }
    walk(body)
    thread = best
    return best
  }
  private static func fromFoot(_ sv: NSScrollView) -> CGFloat {
    let d = sv.documentView?.frame.height ?? 0, b = sv.contentView.bounds
    return max(0, sv.contentView.isFlipped ? d - b.maxY : b.minY)
  }
  private func restore(_ foot: CGFloat) {
    guard let sv = threadScroll(), let d = sv.documentView else { return }
    let b = sv.contentView.bounds
    let top = max(0, d.frame.height - b.height - foot)
    let y = sv.contentView.isFlipped ? top : min(foot, max(0, d.frame.height - b.height))
    guard abs(b.minY - y) > 0.5 else { return }
    sv.contentView.scroll(to: NSPoint(x: b.minX, y: y))
    sv.reflectScrolledClipView(sv.contentView)
  }

  private static func head(_ id: String, _ model: DeskModel, _ style: ColumnStyle, _ needs: Bool = false, _ pane: PaneState? = nil) -> AnyView {
    style == .pane ? AnyView(PaneHeadHost(agentId: id).id(id).environment(model).environment(\.paneState, pane).preferredColorScheme(.dark))
                   : AnyView(ColumnHeadHost(agentId: id).id(id).environment(model).environment(\.needsReel, needs).preferredColorScheme(.dark))
  }
  /// The body, identified by its agent: a slot configured with another agent starts its views (and their state) anew;
  /// what must follow the agent is in `memory`.
  private static func body(_ id: String, _ model: DeskModel, _ memory: SlotMemory?, _ style: ColumnStyle, _ needs: Bool = false, _ pane: PaneState? = nil) -> AnyView {
    AnyView(ColumnBody(agentId: id).id(id).environment(model).environment(\.threadHost, ThreadHostBox(host: model))
      .environment(\.slotMemory, memory).environment(\.deskPane, style == .pane).environment(\.needsReel, needs)
      .environment(\.paneState, pane).preferredColorScheme(.dark))
  }

  /// A slot shows another agent: its head and body get that agent's views, its stroke that agent's state. Nothing is
  /// removed, added or moved: the reel sets the slot's frame.
  func configure(_ id: String) {
    guard id != agentId else { return }
    agentId = id
    thread = nil
    release()
    head.rootView = Self.head(id, model, style, needs, pane)
    body.rootView = Self.body(id, model, memory, style, needs, pane)
    stroke = nil
    observe()
  }

  /// The opened pane leaving the window (the sidebar folds): its SwiftUI trees are emptied first, so they don't render
  /// the whole thread once more on the way out (a hosting view taken out of its window updates its environment).
  override func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    guard style == .pane, newWindow == nil, window != nil else { return }
    head.rootView = AnyView(EmptyView())
    body.rootView = AnyView(EmptyView())
    agentId = ""
    placedAgent = ""
    thread = nil
    release()
  }

  /// The keyboard comes to this column (Search ⌘K dismissed with nothing else to give it back to): its body, the thread
  /// and the message box, as a click in it does.
  func takeKeyboard() -> Bool {
    guard let w = window, !isHiddenOrHasHiddenAncestor else { return false }
    return w.makeFirstResponder(body)
  }

  /// The project changed: the model made new slices for its agents, so whatever this slot shows is stale, even an
  /// agent of the same id. The next `configure` rebuilds.
  func forget() { agentId = ""; placedAgent = "" }

  /// Bumped by each `observe`: a callback from an earlier observation (an earlier agent's) is dropped.
  private var generation = 0

  /// The stroke reads the agent's `approval` and `focused`; when either changes the column applies it again, once the
  /// change has landed (observation calls back before the set), in the same turn of the run loop.
  private func observe() {
    generation += 1
    let g = generation
    withObservationTracking { [weak self] in self?.apply() } onChange: { [weak self] in
      RunLoop.main.perform { MainActor.assumeIsolated { if let self, self.generation == g { self.observe() } } }
    }
  }

  /// What the stroke shows: an ask (amber), the focus (blue: a reel column, or the focused pane of a split), and an
  /// expanded pane has none (it is the window; its ask bar carries the amber).
  private struct StrokeKey: Equatable { var asks: Bool, focused: Bool, expanded: Bool }

  private func apply() {
    DeskProbe.body(style == .pane ? "Pane" : "Column", id: agentId)
    let a = model.agent(agentId, inNeeds: needs)
    let expanded = pane?.expanded == true
    let asks = a?.approval != nil && !needs && !expanded
    let focused = !expanded && (style == .reel ? (a?.focused ?? false) : (pane.map { $0.focused && $0.split } ?? false))
    let key = StrokeKey(asks: asks, focused: focused, expanded: expanded)
    guard stroke.map({ $0 != key }) ?? true else { return }
    if stroke?.expanded != expanded { layer?.cornerRadius = expanded ? 0 : Theme.Desk.columnRadius; needsLayout = true }
    stroke = key
    edge.color = expanded ? nil : NSColor(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke).cgColor
    edge.lineWidth = asks || focused ? 1 : 0.5
    edge.update()
  }
}

/// Where a column view is: in the reel, or the opened window's pane.
enum ColumnStyle { case reel, pane }

/// What the bench reads off a column view: whether it is the opened window's pane, and which agent it shows.
@MainActor package protocol DeskPaneProbe: AnyObject {
  var isPane: Bool { get }
  var shownAgent: String { get }
  /// The pane's id, whether it has the focus, whether it has the window (pane style; -1 / false in the reel).
  var paneId: Int { get }
  var paneFocused: Bool { get }
  var paneExpanded: Bool { get }
}

extension NativeColumnView: DeskPaneProbe {
  package var isPane: Bool { style == .pane }
  package var shownAgent: String { agentId }
  package var paneId: Int { pane?.id ?? -1 }
  package var paneFocused: Bool { pane?.focused ?? false }
  package var paneExpanded: Bool { pane?.expanded ?? false }
}

extension EnvironmentValues {
  /// The view is in the opened window's pane (not the reel kept under it): its decision takes Return and its message
  /// box takes the focus only while the sidebar is open, the reel's only while it is folded.
  @Entry var deskPane = false
}

/// What follows an agent from one reel slot to the next (`reel.columns=reuse`): its message box's draft. The thread's
/// scroll position and unfolded thinking rows don't (a reconfigured slot shows the thread at its foot, folded).
@MainActor final class SlotMemory {
  var drafts: [String: String] = [:]
}

extension EnvironmentValues {
  /// The reel's slot memory when the column is a reused slot; nil otherwise (the box's draft is then its own state).
  @Entry var slotMemory: SlotMemory? = nil
}

/// The column's stroke: a shape layer over the column, never hit (clicks go to what is under it).
final class StrokeView: NSView {
  var color: CGColor?
  var lineWidth: CGFloat = 0.5
  private let shape = CAShapeLayer()
  private var drawn: (CGSize, CGFloat)?
  override init(frame: CGRect) {
    super.init(frame: frame)
    wantsLayer = true
    shape.fillColor = nil
    layer?.addSublayer(shape)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func update() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shape.strokeColor = color
    shape.lineWidth = lineWidth
    if drawn.map({ $0 != (bounds.size, lineWidth) }) ?? true {
      drawn = (bounds.size, lineWidth)
      shape.frame = bounds
      let r = bounds.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
      shape.path = RoundedRectangle(cornerRadius: max(0, Theme.Desk.columnRadius - lineWidth / 2), style: .continuous).path(in: r).cgPath
    }
    CATransaction.commit()
  }
}

/// The native column's head: `ColumnHead` on the agent's slice. A click focuses the column, as anywhere in it.
struct ColumnHeadHost: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.needsReel) private var inNeeds
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId, inNeeds: inNeeds) {
      ColumnHead(slice: a)
        .contentShape(Rectangle())
        .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}

/// The native column's body: the thread (once warm), then the message box or the decision it waits on.
struct ColumnBody: View {
  @Environment(DeskModel.self) private var model
  /// The opened pane always shows its thread: it is the one thing on screen (the reel's warm set is for the reel).
  @Environment(\.deskPane) private var inPane
  @Environment(\.needsReel) private var inNeeds
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId, inNeeds: inNeeds) {
      VStack(spacing: 0) {
        if inNeeds, let p = model.needs.place(agentId) { NeedsPlaceLine(place: p) }
        if a.warm || inPane {
          ColumnThread(runId: a.header.runId, agentId: agentId, thread: model.thread(agentId))
            .task(id: agentId) { await model.keepThreadFresh(agentId: agentId) }
        } else {
          Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if let ap = a.approval { DecisionBar(approval: ap, focused: a.focused) }
        else if let l = a.limit { LimitBar(limit: l, focused: a.focused) }
        else { ColumnComposer(agentId: agentId, name: a.header.name) }
      }
      .contentShape(Rectangle())
      .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}
#endif
