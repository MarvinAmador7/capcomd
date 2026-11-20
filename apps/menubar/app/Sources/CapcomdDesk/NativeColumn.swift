#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
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
  /// The size the head and body were placed for (and whether expanded): placing is skipped until it changes.
  private var placed: (size: CGSize, expanded: Bool)?
  /// The thread's rows as laid out (pane style): a new box for each thread the view shows, so a thread made since the
  /// last resize has none until SwiftUI lays it out.
  private var rows: ThreadRows
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
    let r = ThreadRows()
    rows = r
    head = NSHostingView(rootView: Self.head(agentId, model, style, needs, pane))
    body = NSHostingView(rootView: Self.body(agentId, model, memory, style, needs, pane, r))
    super.init(frame: .zero)
    watch(r)
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
    let resized = placed != nil
    placed = (bounds.size, expanded)
    let h = style == .pane ? (expanded ? PaneMetrics.expandedHeader : Theme.Desk.paneHeader) : Theme.Desk.columnHeader
    // A pane resized (a split, a close, expand, collapse) keeps the reader's place in its thread: taken before the
    // re-frame, put back after it. SwiftUI's bottom anchor kept the offset from the top instead when the pane got
    // shorter, and the lazy rows of the new place were never made (a blank thread).
    let place = style == .pane && resized ? readerPlace() : nil
    head.frame = CGRect(x: 0, y: 0, width: bounds.width, height: h)
    body.frame = CGRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
    edge.frame = bounds
    edge.update()
    guard let place else { return }
    body.layoutSubtreeIfNeeded()
    switch place {
    case .foot(let foot):
      // At the foot: put back now, then once the layout is done, while no row is laid out over the view, the thread
      // scrolls to its foot row itself (SwiftUI's own scroll, as it opens: ColumnThread), and if that leaves it blank the
      // view goes to the last row laid out (`keepRowsAtFoot`). Putting the clip view at the foot alone left the pane
      // blank when the stack's estimated height moved under it (a pane halved by ⇧⌘D: 15,164 pt to 13,953, no row in
      // view). SwiftUI's bottom anchor keeps it there as the rest are measured.
      release()
      restore(place)
      let r = rows
      RunLoop.main.perform { MainActor.assumeIsolated { [weak self] in
        guard let self, self.rows === r else { return }
        self.restore(.foot(foot))
        self.keepRowsAtFoot(r, tries: 0)
      } }
    case .row:
      hold(place)
    }
  }

  /// After a resize at the foot, the thread's lazy stack sometimes keeps its document taller than the rows it has laid
  /// out (collapse, then ⇧⌘↩ again: a 10,837 pt document whose last row ends at 10,102), and the bottom anchor holds the
  /// view at the document's foot, below every row: a blank pane, with no row visible to the scroll view. SwiftUI's own
  /// scroll to the foot row doesn't help then: by the stack's estimate the foot is already in view, so nothing moves and
  /// nothing is laid out. So each turn, while no row is laid out over the view: first that scroll; then the view is put
  /// on the last row the stack laid out, which makes it lay out the rows there and correct its height, and once rows are
  /// in view SwiftUI's scroll to the foot settles it at the real foot.
  private func keepRowsAtFoot(_ r: ThreadRows, tries: Int) {
    guard rows === r, window != nil, let sv = threadScroll(), let d = sv.documentView else { return }
    if rowsLaidOutInView() {
      if tries > 0 { r.toFoot?() }
      return
    }
    guard tries < 6 else { return }
    if tries == 0 {
      r.toFoot?()
    } else if let last = r.entries.last(where: { r.live.contains($0.id) && r.frames[$0.id] != nil }), let f = r.frames[last.id] {
      let h = sv.contentView.bounds.height
      let t = min(max(0, f.maxY + Self.lastRowRoom - h), max(0, d.frame.height - h))
      sv.contentView.scroll(to: NSPoint(x: sv.contentView.bounds.minX, y: sv.contentView.isFlipped ? t : d.frame.height - h - t))
      sv.reflectScrolledClipView(sv.contentView)
    }
    DispatchQueue.main.async { [weak self] in self?.keepRowsAtFoot(r, tries: tries + 1) }
  }
  /// Below the last row when the view is put on it: about the thread's foot margin.
  static let lastRowRoom: CGFloat = 40

  // MARK: the reader's place across a resize

  /// Where the reader is in the thread: at its foot, or a row and how far into it the view's top is (`into` points of
  /// a row `height` tall then), and how far from the foot the view was (the first guess after a resize).
  enum ReaderPlace: Equatable {
    case foot(CGFloat)
    case row(id: String, into: CGFloat, height: CGFloat, foot: CGFloat)
  }

  /// The place now, from the rows as SwiftUI last laid them out. Nil when the thread hasn't been laid out (a thread made
  /// since the last resize: another agent, another run, the view back in the window), which opens at its own foot
  /// (ColumnThread, the #277 blank-pane fix), and when there is no thread.
  private func readerPlace() -> ReaderPlace? {
    guard let sv = threadScroll(), sv.documentView != nil, !rows.live.isEmpty else { return nil }
    let foot = Self.fromFoot(sv)
    if foot <= Self.nearFoot { return .foot(foot) }
    let top = Self.viewTop(sv)
    // The row at the view's top (the first that reaches below it).
    guard let (id, r) = rows.inView(top: top, bottom: top + sv.contentView.bounds.height).first(where: { $0.frame.maxY > top }) else { return nil }
    return .row(id: id, into: top - r.minY, height: r.height, foot: foot)
  }

  /// After a resize the thread's lazy stack measures its rows again at the new width, over the next layouts: its document
  /// height moves by thousands of points as measured rows replace estimates (collapsing an expanded pane, 16,469 pt to
  /// 4,142), and the rows above and below the view change size by different amounts, so neither the offset from the top
  /// nor the distance from the foot names the same content. So the row at the view's top is held there, at the same
  /// share of its height: put back each time the document, the offset or that row moves, for `holdFor` after the
  /// resize, until a hand scrolls the thread or the pane shows another thread.
  ///
  /// A reader at the foot (within `nearFoot`) isn't held: SwiftUI's bottom anchor keeps it there as the rows are
  /// measured, as it did before.
  static let nearFoot: CGFloat = 4
  private var held: (place: ReaderPlace, until: CFTimeInterval, agent: String)?
  private weak var heldScroll: NSScrollView?
  private var heldObservers: [NSObjectProtocol] = []
  private var heldWheel: Any?
  private var heldPending = false
  static let holdFor: CFTimeInterval = 1.0

  private func hold(_ place: ReaderPlace) {
    guard let sv = threadScroll(), let doc = sv.documentView else { return }
    if heldScroll !== sv { release() }
    held = (place, CACurrentMediaTime() + Self.holdFor, agentId)
    // First the distance from the foot, a close guess: the rows' frames are reported after this layout, and the stack
    // then makes the rows near the place. The row is put back exactly once it reports where it is now (`moved`).
    if case .row(_, _, _, let foot) = place { restore(.foot(foot)) } else { restore(place) }
    if heldObservers.isEmpty {
      heldScroll = sv
      doc.postsFrameChangedNotifications = true
      sv.contentView.postsBoundsChangedNotifications = true
      let nc = NotificationCenter.default
      // Posted inside SwiftUI's layout: the place is put back once that layout is done (the run loop's next blocks).
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

  /// The rows tell the hold when the held row moves in the thread (rows above it measured).
  private func watch(_ r: ThreadRows) {
    r.moved = { [weak self] id in
      guard let self, case .row(let held, _, _, _)? = self.held?.place, held == id else { return }
      self.keepHeldSoon()
    }
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
    restore(h.place)
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
  /// The view's top in the thread's content (from the content's top, as the rows' frames are).
  private static func viewTop(_ sv: NSScrollView) -> CGFloat {
    let d = sv.documentView?.frame.height ?? 0, b = sv.contentView.bounds
    return sv.contentView.isFlipped ? b.minY : d - b.maxY
  }
  private func restore(_ place: ReaderPlace) {
    guard let sv = threadScroll(), let d = sv.documentView else { return }
    let b = sv.contentView.bounds
    let top: CGFloat
    switch place {
    case .foot(let foot):
      top = d.frame.height - b.height - foot
    case .row(let id, let into, let height, _):
      // The row isn't built (the re-frame put the view elsewhere): SwiftUI brings it to the top and makes it; once it
      // reports its frame (`moved`), the place is set exactly.
      guard rows.live.contains(id), let r = rows.frames[id] else { rows.toRow?(id); return }
      // Inside the row: the same share of its new height (its text reflowed at the new width); above it, in points.
      top = r.minY + (into >= 0 && into < height && height > 0 ? into / height * r.height : into)
    }
    let t = min(max(0, top), max(0, d.frame.height - b.height))
    let y = sv.contentView.isFlipped ? t : d.frame.height - b.height - t
    guard abs(b.minY - y) > 0.5 else { return }
    sv.contentView.scroll(to: NSPoint(x: b.minX, y: y))
    sv.reflectScrolledClipView(sv.contentView)
  }

  /// Whether rows of the thread are laid out over the view (any row's frame, not only the visible ones'): none after a
  /// resize means the lazy stack made no row for the new place.
  private func rowsLaidOutInView() -> Bool {
    guard let sv = threadScroll() else { return false }
    let top = Self.viewTop(sv)
    return !rows.inView(top: top, bottom: top + sv.contentView.bounds.height, visibleOnly: false).isEmpty
  }

  /// The rows in view now (at least 2 pt of each), top to bottom, by entry id: what the reader sees.
  package var rowsInView: [String] {
    guard style == .pane, let sv = threadScroll(), sv.documentView != nil else { return [] }
    let top = Self.viewTop(sv), bottom = top + sv.contentView.bounds.height
    return rows.inView(top: top, bottom: bottom).filter { $0.frame.maxY > top + 2 && $0.frame.minY < bottom - 2 }.map(\.id)
  }

  private static func head(_ id: String, _ model: DeskModel, _ style: ColumnStyle, _ needs: Bool = false, _ pane: PaneState? = nil) -> AnyView {
    style == .pane ? AnyView(PaneHeadHost(agentId: id).id(id).environment(model).environment(\.paneState, pane).preferredColorScheme(.dark))
                   : AnyView(ColumnHeadHost(agentId: id).id(id).environment(model).environment(\.needsReel, needs).preferredColorScheme(.dark))
  }
  /// The body, identified by its agent: a slot configured with another agent starts its views (and their state) anew;
  /// what must follow the agent is in `memory`.
  private static func body(_ id: String, _ model: DeskModel, _ memory: SlotMemory?, _ style: ColumnStyle, _ needs: Bool, _ pane: PaneState?,
                           _ rows: ThreadRows) -> AnyView {
    AnyView(ColumnBody(agentId: id).id(id).environment(model).environment(\.threadHost, ThreadHostBox(host: model))
      .environment(\.slotMemory, memory).environment(\.deskPane, style == .pane).environment(\.needsReel, needs)
      .environment(\.paneState, pane).environment(\.threadRows, style == .pane ? rows : nil).preferredColorScheme(.dark))
  }

  /// A slot shows another agent: its head and body get that agent's views, its stroke that agent's state. Nothing is
  /// removed, added or moved: the reel sets the slot's frame.
  func configure(_ id: String) {
    guard id != agentId else { return }
    agentId = id
    thread = nil
    release()
    rows = ThreadRows()
    watch(rows)
    head.rootView = Self.head(id, model, style, needs, pane)
    body.rootView = Self.body(id, model, memory, style, needs, pane, rows)
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
    rows = ThreadRows()
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
  func forget() { agentId = "" }

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
  /// The thread's rows in view, top to bottom, by entry id (pane style; empty in the reel).
  var rowsInView: [String] { get }
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

/// A pane's thread rows as SwiftUI laid them out: each row's frame in the thread's content (`space`), by entry id, and
/// which rows are built now (`live`; a row out of the lazy stack's reach keeps its last frame, a guess). Written by the
/// rows (`RowFrame`) as they are laid out, read by the pane to keep the reader's place by row across a resize. One box
/// per thread a pane shows.
@MainActor final class ThreadRows {
  static let space = "capcomd.thread.content"
  private(set) var frames: [String: CGRect] = [:]
  private(set) var live: Set<String> = []
  /// Called with a row's id when its frame changes or it is built.
  var moved: ((String) -> Void)?
  /// SwiftUI's own scrolls (set by the thread as it appears): to the foot row, and a row's top to the view's top (it
  /// makes the row and those around it when the row isn't built).
  var toFoot: (() -> Void)?
  var toRow: ((String) -> Void)?
  func set(_ id: String, _ r: CGRect) {
    let made = live.insert(id).inserted
    guard made || frames[id] != r else { return }
    frames[id] = r
    moved?(id)
  }
  func drop(_ id: String) { live.remove(id) }
  /// The thread's entries in order (set by the thread as it renders).
  var entries: [ThreadEntry] = []
  /// The rows SwiftUI's scroll view says are in view (macOS 15 and later; nil before).
  var visible: Set<String>?

  /// The rows laid out over `top..<bottom` now, top to bottom. A lazy stack can keep a row it no longer places, with the
  /// frame it last had, so only the rows the scroll view says are visible count (macOS 15), and of those only a run of
  /// rows in the thread's order whose frames follow one another (the stack has no spacing): of the runs, the one that
  /// covers most of the range.
  func inView(top: CGFloat, bottom: CGFloat, visibleOnly: Bool = true) -> [(id: String, frame: CGRect)] {
    var index: [String: Int] = [:]
    for (i, e) in entries.enumerated() { index[e.id] = i }
    let rows = (visibleOnly ? live.intersection(visible ?? live) : live).compactMap { id -> (i: Int, id: String, frame: CGRect)? in
      guard let i = index[id], let f = frames[id], f.maxY > top, f.minY < bottom else { return nil }
      return (i, id, f)
    }.sorted { $0.i < $1.i }
    var runs: [[(i: Int, id: String, frame: CGRect)]] = []
    for r in rows {
      if let last = runs.last?.last, abs(r.frame.minY - last.frame.maxY) < 1 { runs[runs.count - 1].append(r) } else { runs.append([r]) }
    }
    func cover(_ run: [(i: Int, id: String, frame: CGRect)]) -> CGFloat {
      run.reduce(0) { $0 + max(0, min($1.frame.maxY, bottom) - max($1.frame.minY, top)) }
    }
    return (runs.max { cover($0) < cover($1) } ?? []).map { ($0.id, $0.frame) }
  }
}

/// A thread row's frame, kept in the pane's `ThreadRows` (in the reel, nothing).
struct RowFrame: ViewModifier {
  let id: String
  let rows: ThreadRows?
  func body(content: Content) -> some View {
    if let rows {
      // A geometry reader, not `onGeometryChange`: a row has to report its frame as it is made, too (a row made again
      // where it was before reports no change).
      content
        .background(GeometryReader { g in
          let f = g.frame(in: .named(ThreadRows.space))
          Color.clear.onChange(of: f, initial: true) { _, f in rows.set(id, f) }
        })
        .onDisappear { rows.drop(id) }
    } else {
      content
    }
  }
}

/// The rows in view, as the thread's scroll view says (macOS 15 and later), kept in the pane's `ThreadRows`.
struct VisibleRows: ViewModifier {
  let rows: ThreadRows?
  func body(content: Content) -> some View {
    if let rows, #available(macOS 15, *) {
      content.onScrollTargetVisibilityChange(idType: String.self, threshold: 0.001) { rows.visible = Set($0) }
    } else {
      content
    }
  }
}

extension EnvironmentValues {
  /// The pane's thread rows box; nil in the reel.
  @Entry var threadRows: ThreadRows? = nil
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
