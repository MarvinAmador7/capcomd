#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdBot
import CapcomdUI

/// The open project's agents as full-height columns in tree order (Reel). Snaps to a column edge; neighbours peek at
/// both sides.
///
/// The reel is an AppKit scroll view and each column its own SwiftUI hosting view (ReelView). Scrolling then moves a
/// layer and nothing else (SPEC §1): in a SwiftUI ScrollView every scroll frame dirtied the whole reel's view graph
/// (16 columns of threads) and most frames were late. Columns are not lazy: each is built once and kept, and its thread
/// is built ahead of time (DeskModel's warm set).
struct ReelHost: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("Reel")
    return ReelRepresentable(model: model, columns: model.columns, request: model.reelRequest)
  }
}

struct ReelRepresentable: NSViewRepresentable {
  let model: DeskModel
  let columns: [String]
  let request: ReelRequest?
  func makeNSView(context: Context) -> ReelView { ReelView(model: model) }
  /// The reel takes the space it's given. Without this SwiftUI measures it through Auto Layout, which solves every
  /// column's hosting view on each update of the window (two thirds of a step's main thread).
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: ReelView, context: Context) -> CGSize? {
    proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
  }
  func updateNSView(_ v: ReelView, context: Context) {
    v.show(columns)
    if let request { v.perform(request) }
  }
}

/// The reel's AppKit side: the scroll view, a hosting view per column laid out on the column pitch, snapping, and the
/// leading column reported to the model only when it changes. Slides run in the render server (`slide`).
final class ReelView: NSView, ReelColumnViews {
  private let model: DeskModel
  private let scroll = SnapScrollView()
  private let doc = Flipped()
  private var hosts: [String: NSView] = [:]
  private var order: [String] = []
  private var across = 0, pitch: CGFloat = 0, width: CGFloat = 0
  /// The leading column, as the scroll offset last put it.
  private var at = 0
  private var served = -1
  private var pending: ReelRequest?
  private var gestures = 0, slides = 0
  /// Runtime knobs (DeskKnobs), read once: how a slide moves the reel, and how many far columns each frame builds.
  private let clipSlide = DeskKnobs.reelSlide.value == .clip
  private let perFrame = DeskKnobs.buildPerFrame.value
  /// `desk.layout`, `desk.column` (LAYOUT.md): the frame engine and its geometry, hiding far columns at rest, and
  /// AppKit columns.
  private let layoutMode = DeskKnobs.deskLayout.value
  private let nativeColumns = DeskKnobs.deskColumn.value == .native
  private var geometry = ReelGeometry()
  /// `reel.columns=park`: built columns away from the screen, in `parking` (hidden, never scrolled), and the blank
  /// stand-ins that hold their place in the document.
  private let parkColumns = DeskKnobs.reelColumns.value == .park
  private let parking = Flipped()
  private var standIns: [String: NSView] = [:]
  /// `reel.columns=reuse`: the slots, the column each shows (nil: free), the draft memory they share, the columns a
  /// move in flight needs, and the placeholder layer under them.
  private let reuseColumns = DeskKnobs.reelColumns.value == .reuse
  private var slots: [NativeColumnView] = []
  private var slotColumn: [Int?] = []
  private let slotMemory = SlotMemory()
  private var moveNeeds: Set<Int> = []
  private var lastDirection = 1
  private let placeholder = CAReplicatorLayer()
  /// `reel.cache=bitmap`: the columns' bitmaps by agent (dropped when the agent's content changes or you touch the
  /// column), the overlay a slide moves them in, and the slide in flight.
  private let bitmapCache = DeskKnobs.reelCache.value == .bitmap
  private var bitmaps: [String: CGImage] = [:]
  private let overlay = BitmapOverlay()
  private var cached: (serial: Int, from: CGFloat, to: CGFloat, base: CGPoint)?
  private var cachedSerial = 0
  private var touchMonitor: Any?
  /// Whether columns away from the screen are hidden or parked while the reel rests.
  private var windowing: Bool { layoutMode == .framesHide || parkColumns }

  init(model: DeskModel) {
    self.model = model
    super.init(frame: .zero)
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.drawsBackground = false
    scroll.automaticallyAdjustsContentInsets = false
    scroll.verticalScrollElasticity = .none
    scroll.horizontalScrollElasticity = .allowed
    doc.wantsLayer = true
    scroll.documentView = doc
    scroll.reel = self
    scroll.contentView.postsBoundsChangedNotifications = true
    addSubview(scroll)
    if parkColumns { parking.isHidden = true; addSubview(parking, positioned: .below, relativeTo: scroll) }
    if bitmapCache { startBitmapCache() }
    NotificationCenter.default.addObserver(self, selector: #selector(scrolled), name: NSView.boundsDidChangeNotification, object: scroll.contentView)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override var intrinsicContentSize: NSSize { NSSize(width: NSView.noIntrinsicMetric, height: NSView.noIntrinsicMetric) }

  /// The open project's columns: a hosting view each, kept while its agent stays in the run. Only the columns on
  /// screen and one each side are built at once; the rest show a blank column until they're built, one per idle turn
  /// of the run loop, nearest first (a project with 17 agents took ~200 ms to its first frame building them all).
  func show(_ ids: [String]) {
    guard ids != order else { return }
    if reuseColumns { return showSlots(ids) }
    for id in Set(hosts.keys).subtracting(ids) { hosts.removeValue(forKey: id)?.removeFromSuperview() }
    for id in Set(blanks.keys).subtracting(ids) { blanks.removeValue(forKey: id)?.removeFromSuperview() }
    for id in Set(standIns.keys).subtracting(ids) { standIns.removeValue(forKey: id)?.removeFromSuperview() }
    order = ids
    at = min(at, max(0, ids.count - 1))
    for id in ids where hosts[id] == nil && blanks[id] == nil {
      let b = Self.blank()
      doc.addSubview(b)
      blanks[id] = b
    }
    needsLayout = true
    buildSoon()
  }

  private var blanks: [String: NSView] = [:]
  private var building = false

  /// A column before it is built: its fill and corner, nothing else.
  private static func blank() -> NSView {
    let b = NSView()
    b.wantsLayer = true
    b.layer?.backgroundColor = NSColor(Theme.Desk.column).cgColor
    b.layer?.cornerRadius = Theme.Desk.columnRadius
    b.layer?.cornerCurve = .continuous
    return b
  }

  /// Builds column `i`'s hosting view in place of its blank.
  private func build(_ i: Int) {
    guard !reuseColumns, order.indices.contains(i), hosts[order[i]] == nil else { return }
    let id = order[i]
    let h: NSView
    if nativeColumns {
      h = NativeColumnView(agentId: id, model: model)
    } else {
      let hv = NSHostingView(rootView: AnyView(Column(agentId: id)
        .environment(model).environment(\.threadHost, ThreadHostBox(host: model)).preferredColorScheme(.dark)))
      hv.safeAreaRegions = []
      hv.sizingOptions = []   // the reel sets its frame; nothing to measure
      h = hv
    }
    h.frame = blanks[id]?.frame ?? frame(of: i)
    hosts[id] = h
    let away = windowing && gestures + slides == 0 && near(at).map { !$0.contains(i) } ?? false
    if !(away && parkColumns) { doc.addSubview(h) }
    blanks.removeValue(forKey: id)?.removeFromSuperview()
    if away { put(away: id, at: i) }
  }

  /// The columns that must exist now: those on screen and one each side.
  private func buildAround(_ i: Int) {
    guard !order.isEmpty, across > 0 else { return }
    for j in max(0, i - 1)...min(order.count - 1, i + across) { build(j) }
    if windowing { reveal(near(i)) }
    if reuseColumns { assignSlots(around: i) }
  }

  /// The rest, one per turn of the run loop (`build.perFrame`) while the reel stands still, nearest the leading column
  /// first.
  private func buildSoon() {
    guard !building, !blanks.isEmpty else { return }
    building = true
    DispatchQueue.main.async { [weak self] in
      guard let self else { return }
      self.building = false
      guard self.across > 0 else { return self.buildSoon() }   // not laid out yet
      for _ in 0..<self.perFrame {
        guard !self.model.reelMoving, let next = self.order.indices.filter({ self.hosts[self.order[$0]] == nil }).min(by: { abs($0 - self.at) < abs($1 - self.at) }) else { break }
        self.build(next)
      }
      if !self.blanks.isEmpty {
        // Yield to the next frame before the next column: the run loop handles input and display in between.
        DispatchQueue.main.asyncAfter(deadline: .now() + .milliseconds(16)) { [weak self] in self?.buildSoon() }
      }
    }
  }

  private func frame(of i: Int) -> CGRect {
    CGRect(x: Theme.Desk.peek + Theme.Desk.gap + CGFloat(i) * pitch, y: 0, width: width, height: max(0, bounds.height - Theme.Desk.gap))
  }

  override func layout() {
    super.layout()
    if bitmapCache, overlay.frame != bounds { overlay.frame = bounds; bitmaps = [:] }
    if layoutMode != .auto { return framesLayout() }
    scroll.frame = bounds
    let gap = Theme.Desk.gap, inset = Theme.Desk.peek + gap
    let n = Theme.Desk.columnsAcross(bounds.width)
    let w = max(320, (bounds.width - 2 * inset - CGFloat(n - 1) * gap) / CGFloat(n))
    let moved = w + gap != pitch
    across = n; width = w; pitch = w + gap
    for (i, id) in order.enumerated() { (hosts[id] ?? blanks[id])?.frame = frame(of: i) }
    if !standIns.isEmpty { for (i, id) in order.enumerated() { standIns[id]?.frame = frame(of: i) } }
    doc.frame = CGRect(x: 0, y: 0, width: max(bounds.width, 2 * inset + CGFloat(order.count) * pitch - gap), height: bounds.height)
    if moved { jump(to: at) }   // a new width keeps the same leading column
    if model.across != n { DispatchQueue.main.async { [model] in if model.across != n { model.across = n } } }
    if let p = pending, bounds.width > 0 { pending = nil; perform(p) }
    buildAround(at)
    if reuseColumns { placeSlots() }
  }

  /// A crew tab, a shortcut or Follow asked for a column.
  func perform(_ r: ReelRequest) {
    guard r.serial != served else { return }
    guard bounds.width > 0, pitch > 0 else { pending = r; return }
    served = r.serial
    let i = r.agentId.flatMap { order.firstIndex(of: $0) } ?? 0
    guard r.animated else { jump(to: i); return }
    // A long jump would slide every column it passes past the screen. Cut to one column short, then slide the last.
    if abs(i - at) > across { slide(to: i, from: x(i < at ? i + 1 : i - 1)) } else { slide(to: i) }
  }

  private func x(_ i: Int) -> CGFloat { min(max(0, CGFloat(i) * pitch), max(0, doc.frame.width - bounds.width)) }

  private func jump(to i: Int) {
    stopSlide()
    scroll.contentView.setBoundsOrigin(NSPoint(x: x(i), y: 0))
    scrolled()
    if windowing { rest() }
  }

  // MARK: desk.layout=frames

  /// The frame engine's layout pass (ReelLayout.swift): measure the geometry, and place the columns only when it
  /// changed (a width, the column count, the backing scale); otherwise a layout pass of the reel moves nothing.
  private func framesLayout() {
    if scroll.frame != bounds { scroll.frame = bounds }
    let g = ReelGeometry.measure(bounds: bounds.size, count: order.count, scale: window?.backingScaleFactor ?? 2)
    if g != geometry {
      let moved = g.pitch != pitch
      geometry = g; across = g.across; width = g.width; pitch = g.pitch
      for (i, id) in order.enumerated() { (hosts[id] ?? blanks[id])?.frame = g.frame(of: i); standIns[id]?.frame = g.frame(of: i) }
      doc.frame = CGRect(x: 0, y: 0, width: g.documentWidth, height: bounds.height)
      if moved { jump(to: at) }   // a new width keeps the same leading column
    }
    let n = across
    if model.across != n { DispatchQueue.main.async { [model] in if model.across != n { model.across = n } } }
    if let p = pending, bounds.width > 0 { pending = nil; perform(p) }
    buildAround(at)
    if reuseColumns { placeSlots() }
  }

  // MARK: windowing (desk.layout=frames-hide, reel.columns=park)

  /// The columns on screen with column `i` leading, and one each side: those a move may show.
  private func near(_ i: Int) -> ClosedRange<Int>? {
    guard !order.isEmpty, across > 0 else { return nil }
    let lo = max(0, min(i, order.count - 1) - 1), hi = min(order.count - 1, i + across)
    return lo <= hi ? lo...hi : nil
  }

  /// Brings the built columns in `r` back before a move shows them: unhidden, or out of parking into the document.
  private func reveal(_ r: ClosedRange<Int>?) {
    guard let r else { return }
    for i in r {
      let id = order[i]
      guard let v = hosts[id] else { continue }
      if parkColumns {
        guard let s = standIns.removeValue(forKey: id) else { continue }
        v.frame = s.frame
        doc.addSubview(v)
        s.removeFromSuperview()
      } else if v.isHidden {
        v.isHidden = false
        // A hosting view doesn't render while hidden; shown again it waits for something to invalidate it. Lay it
        // out now, before the move shows it.
        v.needsLayout = true
        v.layoutSubtreeIfNeeded()
      }
    }
  }

  /// Column `i`, away from the screen: hidden (frames-hide) or parked with a blank stand-in in the document (park).
  private func put(away id: String, at i: Int) {
    guard let v = hosts[id] else { return }
    if parkColumns {
      guard standIns[id] == nil else { return }
      let s = Self.blank()
      s.frame = v.superview === doc ? v.frame : frame(of: i)
      doc.addSubview(s)
      standIns[id] = s
      parking.addSubview(v)   // keeps its size: back in the document it needs no new layout
    } else if !v.isHidden { v.isHidden = true }
  }

  /// The reel at rest: only the columns on screen and one each side stay in view. A hidden subtree is skipped by
  /// AppKit's per-frame passes (tracking areas, display); a parked one is also not moved by a scroll, so SwiftUI
  /// doesn't re-place it. Their SwiftUI content keeps updating either way.
  private func rest() {
    guard gestures + slides == 0, let r = near(at) else { return }
    for (i, id) in order.enumerated() where hosts[id] != nil {
      if r.contains(i) { reveal(i...i) } else { put(away: id, at: i) }
    }
  }

  /// Slides to column `i` in the render server: the scroll offset moves to the target at once (one update for the
  /// columns, which then don't move again) and the document layer is animated from where it showed. Scrolling the
  /// clip view frame by frame made every column's hosting view update its graph each frame (~20 ms a frame).
  fileprivate func slide(to i: Int, from start: CGFloat? = nil) {
    if reuseColumns { prepareSlots(to: i, from: start) }
    if clipSlide { return clipViewSlide(to: i, from: start) }
    let from = start ?? shownOffset(), to = x(i)
    if bitmapCache, bitmapSlide(to: i, from: from, toX: to) { return }
    buildAround(i)
    stopSlide()
    scroll.contentView.setBoundsOrigin(NSPoint(x: to, y: 0))
    scrolled()
    guard abs(to - from) > 0.5, let layer = doc.layer else { return }
    slides += 1; moving()
    let a = CABasicAnimation(keyPath: "position.x")
    a.isAdditive = true
    a.fromValue = to - from   // where the old offset showed the document, relative to where it now is
    a.toValue = 0
    a.duration = 0.35
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      MainActor.assumeIsolated { guard let self else { return }; self.slides -= 1; self.moving() }
    }
    layer.add(a, forKey: "slide")
    CATransaction.commit()
  }

  /// The offset on screen: the scroll offset less what a slide in flight still has to go.
  private func shownOffset() -> CGFloat {
    if let c = cached { return cachedShown(c) }
    let o = scroll.contentView.bounds.origin.x
    guard let l = doc.layer, l.animation(forKey: "slide") != nil, let p = l.presentation() else { return o }
    return o - (p.position.x - l.position.x)
  }

  /// Ends a slide where it shows now (a new slide or a swipe takes over from there).
  private func stopSlide() {
    if cached != nil { return stopBitmapSlide() }
    if clipSlide { return stopClipViewSlide() }
    guard let l = doc.layer, l.animation(forKey: "slide") != nil else { return }
    let shown = shownOffset()
    l.removeAnimation(forKey: "slide")   // its completion block still runs and balances `slides`
    scroll.contentView.setBoundsOrigin(NSPoint(x: shown, y: 0))
  }

  // MARK: reel.slide=clip

  /// The slide in flight with `reel.slide=clip`, by serial: a completion that isn't the current one's is stale.
  private var clipSerial = 0, clipInFlight = false

  /// `reel.slide=clip`: the clip view's own animation (NSClipView's animator), the bounds moving frame by frame, as the
  /// reel slid before the render-server slide. Kept as a knob so the loop can measure that decision again.
  private func clipViewSlide(to i: Int, from start: CGFloat?) {
    let to = x(i)
    buildAround(i)
    stopClipViewSlide(settle: false)   // the new slide takes over: the reel doesn't report a stop in between
    if let start { scroll.contentView.setBoundsOrigin(NSPoint(x: start, y: 0)); scrolled() }
    guard abs(to - scroll.contentView.bounds.origin.x) > 0.5 else { return moving() }
    clipSerial += 1; clipInFlight = true
    let serial = clipSerial
    slides += 1; moving()
    NSAnimationContext.runAnimationGroup({ ctx in
      ctx.duration = 0.35
      ctx.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
      scroll.contentView.animator().setBoundsOrigin(NSPoint(x: to, y: 0))
    }, completionHandler: { [weak self] in
      MainActor.assumeIsolated {
        guard let self, self.clipInFlight, self.clipSerial == serial else { return }
        self.clipInFlight = false; self.slides -= 1
        self.scroll.reflectScrolledClipView(self.scroll.contentView)
        self.moving()
      }
    })
  }

  /// Ends a clip-view slide where it is now: a zero-length animation to the current offset replaces the one in flight.
  private func stopClipViewSlide(settle: Bool = true) {
    guard clipInFlight else { return }
    clipInFlight = false; slides -= 1
    let now = scroll.contentView.bounds.origin
    NSAnimationContext.runAnimationGroup { ctx in
      ctx.duration = 0
      scroll.contentView.animator().setBoundsOrigin(now)
    }
    if settle { moving() }
  }

  /// A swipe began: it takes over from a slide in flight.
  fileprivate func gestureBegan() {
    gestures = 1
    if layoutMode == .framesHide, !order.isEmpty { reveal(0...(order.count - 1)) }   // the fingers may go anywhere
    // (park: the columns come out of parking as the leading column changes, `scrolled` → `buildAround`)
    stopSlide()
    moving()
  }

  /// A swipe ended: land on the column edge nearest where its momentum would have stopped, at most a screen away.
  fileprivate func gestureEnded(velocity v: CGFloat) {
    gestures = 0
    guard pitch > 0, !order.isEmpty else { moving(); return }
    let now = scroll.contentView.bounds.origin.x
    let projected = now - v * 0.3   // the content follows the fingers: a leftward swipe (v < 0) scrolls right
    let start = Int((now / pitch).rounded())
    var i = Int((projected / pitch).rounded())
    i = min(max(i, start - across, 0), min(start + across, order.count - 1))
    slide(to: i)
  }

  /// A mouse wheel (no gesture phases): settle on the nearest column once the wheel stops.
  fileprivate func wheelStopped() {
    guard pitch > 0 else { return }
    slide(to: Int((scroll.contentView.bounds.origin.x / pitch).rounded()))
  }

  private func moving() {
    let m = gestures + slides > 0
    if !m, windowing { rest() }
    if !m, reuseColumns { slotsAtRest() }
    guard model.reelMoving != m else { return }
    model.reelMoving = m
    DeskProbe.event("reel.phase", m ? 1 : 0)
  }

  @objc private func scrolled() {
    guard pitch > 0, !order.isEmpty else { return }
    let i = min(max(0, Int((scroll.contentView.bounds.origin.x / pitch).rounded())), order.count - 1)
    guard i != at else { return }
    at = i
    buildAround(i)
    DeskProbe.event("reel.position", i)
    model.reelScrolled(toIndex: i)
  }

  // MARK: reel.columns=reuse

  /// How many slots: two screens and one column each side, so a step (one screen) shows real columns all the way.
  private var slotCount: Int { min(order.count, 2 * max(1, across) + 2) }

  /// A new project's columns: every slot is free (the next assignment configures them), the placeholder covers all.
  private func showSlots(_ ids: [String]) {
    order = ids
    at = min(at, max(0, ids.count - 1))
    slotColumn = slotColumn.map { _ in nil }
    for s in slots { s.forget() }
    moveNeeds = []
    needsLayout = true
  }

  /// Makes the slots that are missing (the first layout, or a wider window). They are added once and never removed.
  private func ensureSlots() {
    while slots.count < slotCount, let first = order.first {
      let s = NativeColumnView(agentId: first, model: model, memory: slotMemory)
      s.frame = CGRect(x: -2 * max(width, 320), y: 0, width: width, height: max(0, bounds.height - Theme.Desk.gap))
      doc.addSubview(s)
      slots.append(s)
      slotColumn.append(nil)
    }
  }

  /// Gives every column in `needed` a slot, nearest `at` first: a slot already showing that agent if one is free, else
  /// any free slot, configured in place. Slots whose column isn't needed are freed first; a free slot keeps its agent
  /// (it may be wanted again) and waits off the document's edge.
  private func assign(_ needed: Set<Int>) {
    guard !order.isEmpty, across > 0 else { return }
    ensureSlots()
    let want = needed.filter { order.indices.contains($0) }
    for k in slots.indices where slotColumn[k].map({ !want.contains($0) }) ?? false { slotColumn[k] = nil }
    let shown = Set(slotColumn.compactMap { $0 })
    for j in want.subtracting(shown).sorted(by: { abs($0 - at) < abs($1 - at) }) {
      guard let k = slots.indices.first(where: { slotColumn[$0] == nil && slots[$0].agentId == order[j] })
              ?? slots.indices.first(where: { slotColumn[$0] == nil }) else { break }
      slotColumn[k] = j
      slots[k].configure(order[j])
      slots[k].frame = frame(of: j)
    }
    for k in slots.indices where slotColumn[k] == nil && slots[k].frame.minX >= 0 {
      slots[k].frame.origin.x = -2 * max(width, 320)
    }
  }

  /// The columns near column `i` (on screen and one each side), plus those a move in flight still shows.
  private func assignSlots(around i: Int) {
    var need = moveNeeds
    if let r = near(i) { need.formUnion(r) }
    assign(need)
  }

  /// Before a slide starts: the columns it passes get their slots now, not during its frames.
  private func prepareSlots(to i: Int, from start: CGFloat?) {
    let from = start.map { pitch > 0 ? Int(($0 / pitch).rounded()) : at } ?? at
    if i != from { lastDirection = i > from ? 1 : -1 }
    moveNeeds = Set(near(from) ?? 0...0).union(near(i) ?? 0...0).union(near(at) ?? 0...0)
    assign(moveNeeds)
  }

  /// At rest: the move's columns are let go, and the spare slots prefetch the next screen in the direction of travel,
  /// a turn later (off the frame that ended the move).
  private func slotsAtRest() {
    moveNeeds = []
    DispatchQueue.main.async { [weak self] in
      guard let self, self.gestures + self.slides == 0, let r = self.near(self.at) else { return }
      var need = Set(r)
      if let ahead = self.near(self.at + self.lastDirection * self.across) { need.formUnion(ahead) }
      self.assign(need)
    }
  }

  /// After a layout: the slots on their columns' frames and the placeholder (one replicated layer, no views) under
  /// every column.
  private func placeSlots() {
    for k in slots.indices { if let j = slotColumn[k], order.indices.contains(j) { slots[k].frame = frame(of: j) } }
    guard let l = doc.layer else { return }
    if placeholder.superlayer == nil {
      let cell = CALayer()
      cell.backgroundColor = NSColor(Theme.Desk.column).cgColor
      cell.cornerRadius = Theme.Desk.columnRadius
      cell.cornerCurve = .continuous
      placeholder.addSublayer(cell)
      l.insertSublayer(placeholder, at: 0)
    }
    CATransaction.begin(); CATransaction.setDisableActions(true)
    placeholder.frame = l.bounds
    placeholder.instanceCount = order.count
    placeholder.instanceTransform = CATransform3DMakeTranslation(pitch, 0, 0)
    placeholder.sublayers?.first?.frame = frame(of: 0)
    CATransaction.commit()
  }

  // MARK: reel.cache=bitmap

  private func startBitmapCache() {
    overlay.isHidden = true
    addSubview(overlay)   // above the scroll view
    // A column you touch (click, scroll its thread, type in it) may look different without the model changing: its
    // bitmap goes.
    touchMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .leftMouseUp, .scrollWheel, .keyDown]) { [weak self] e in
      MainActor.assumeIsolated {
        guard let self, e.window === self.window, !self.bitmaps.isEmpty else { return }
        if e.type == .keyDown { if let f = self.model.focusedAgent { self.bitmaps[f] = nil } ; return }
        let p = self.doc.convert(e.locationInWindow, from: nil)
        if let j = self.order.indices.first(where: { self.frame(of: $0).contains(p) }) { self.bitmaps[self.order[j]] = nil }
      }
      return e
    }
  }

  /// Column `j` drawn once into a bitmap, kept until its agent's content changes (observed) or it is touched.
  private func bitmap(_ j: Int) -> CGImage? {
    let id = order[j]
    if let b = bitmaps[id] { return b }
    guard let v = columnView(at: j), v.superview === doc, !v.isHidden, v.bounds.width > 0,
          let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { return nil }
    v.layoutSubtreeIfNeeded()   // a slot configured just now has not been laid out yet
    v.cacheDisplay(in: v.bounds, to: rep)
    guard let img = rep.cgImage else { return nil }
    bitmaps[id] = img
    withObservationTracking { [weak self] in
      guard let self, let a = self.model.agent(id) else { return }
      _ = (a.header, a.bot, a.approval, a.focused, a.warm)
      let t = self.model.thread(id)
      _ = (t.entries, t.pending, t.unavailable)
      _ = self.model.mediaSlice.items.count
    } onChange: { [weak self] in
      RunLoop.main.perform { MainActor.assumeIsolated { _ = self?.bitmaps.removeValue(forKey: id) } }
    }
    return img
  }

  /// A slide of bitmaps: the columns it shows, as they are now, in the overlay at the offset the reel shows; the
  /// overlay's content slides in the render server, and the reel's offset moves under it when the slide ends. The
  /// leading column is reported at once, as a live slide does. A column whose content changes mid-slide shows its
  /// bitmap until the slide ends, then its live view.
  private func bitmapSlide(to i: Int, from: CGFloat, toX to: CGFloat) -> Bool {
    guard pitch > 0, abs(to - from) > 0.5, let content = overlay.content else { return false }
    stopSlide()
    let fromIndex = Int((from / pitch).rounded())
    let cols = Set(near(fromIndex) ?? 0...0).union(near(i) ?? 0...0).filter { order.indices.contains($0) }
    let h = overlay.bounds.height, scale = window?.backingScaleFactor ?? 2
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    content.sublayers = nil
    content.frame = overlay.bounds
    for j in cols.sorted() {
      let f = frame(of: j), l = CALayer()
      l.frame = CGRect(x: f.minX - from, y: h - f.maxY, width: f.width, height: f.height)   // the overlay isn't flipped
      if let img = bitmap(j) {
        l.contents = img; l.contentsScale = scale; l.contentsGravity = .resize
      } else {
        l.backgroundColor = NSColor(Theme.Desk.column).cgColor; l.cornerRadius = Theme.Desk.columnRadius; l.cornerCurve = .continuous
      }
      content.addSublayer(l)
    }
    overlay.isHidden = false
    let base = content.position
    content.position.x = base.x - (to - from)
    CATransaction.commit()
    cachedSerial += 1
    let serial = cachedSerial
    cached = (serial, from, to, base)
    if i != at { at = i; buildAround(i); DeskProbe.event("reel.position", i); model.reelScrolled(toIndex: i) }
    slides += 1; moving()
    let a = CABasicAnimation(keyPath: "position.x")
    a.isAdditive = true
    a.fromValue = to - from
    a.toValue = 0
    a.duration = 0.35
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      MainActor.assumeIsolated { guard let self, self.cached?.serial == serial else { return }; self.endBitmapSlide(at: to) }
    }
    content.add(a, forKey: "slide")
    CATransaction.commit()
    return true
  }

  /// Where a bitmap slide in flight shows the document.
  private func cachedShown(_ c: (serial: Int, from: CGFloat, to: CGFloat, base: CGPoint)) -> CGFloat {
    guard let content = overlay.content, let p = content.presentation() else { return c.to }
    return c.from + (c.base.x - p.position.x)
  }

  /// The slide is over (or taken over at `offset`): the reel moves there under the overlay, and the overlay goes a turn
  /// later, once the live columns have been drawn at their new place.
  private func endBitmapSlide(at offset: CGFloat) {
    cached = nil
    overlay.content?.removeAnimation(forKey: "slide")
    scroll.contentView.setBoundsOrigin(NSPoint(x: offset, y: 0))
    scrolled()
    slides -= 1
    DispatchQueue.main.async { [weak self] in
      guard let self, self.cached == nil else { return }
      CATransaction.begin(); CATransaction.setDisableActions(true)
      self.overlay.isHidden = true
      self.overlay.content?.sublayers = nil
      CATransaction.commit()
    }
    moving()
  }

  private func stopBitmapSlide() {
    guard let c = cached else { return }
    endBitmapSlide(at: cachedShown(c))
  }

  // MARK: ReelColumnViews (the bench's guards and drivers)

  var columnCount: Int { order.count }
  func columnFrame(at i: Int) -> CGRect { frame(of: i) }
  func columnView(at i: Int) -> NSView? {
    guard order.indices.contains(i) else { return nil }
    if reuseColumns { return slotColumn.firstIndex(of: i).map { slots[$0] } }
    let id = order[i]
    return hosts[id].flatMap { $0.superview === doc ? $0 : nil } ?? standIns[id] ?? blanks[id]
  }

  final class Flipped: NSView { override var isFlipped: Bool { true } }

  /// `reel.cache=bitmap`: the layer a slide moves bitmaps in, above the reel; never hit.
  final class BitmapOverlay: NSView {
    private(set) var content: CALayer?
    override init(frame: CGRect) {
      super.init(frame: frame)
      wantsLayer = true
      let c = CALayer()
      layer?.addSublayer(c)
      content = c
    }
    required init?(coder: NSCoder) { fatalError() }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
  }
}

/// The reel's scroll view: it follows the fingers during a swipe and hands the landing to the reel instead of the
/// system's momentum, so it always comes to rest on a column edge.
final class SnapScrollView: NSScrollView {
  weak var reel: ReelView?
  private var swallowMomentum = false
  private var samples: [(t: TimeInterval, dx: CGFloat)] = []
  private var wheelTimer: Timer?

  override func scrollWheel(with e: NSEvent) {
    GestureTap.scrollWheel(e)   // nil unless a gesture recording was asked for (GestureTap.swift)
    guard let reel else { return super.scrollWheel(with: e) }
    if !e.momentumPhase.isEmpty {
      // The system's momentum after a swipe: the reel already chose where to land.
      if swallowMomentum { if e.momentumPhase.contains(.ended) || e.momentumPhase.contains(.cancelled) { swallowMomentum = false }; return }
      return super.scrollWheel(with: e)
    }
    if e.phase.isEmpty {
      super.scrollWheel(with: e)
      wheelTimer?.invalidate()
      wheelTimer = Timer.scheduledTimer(withTimeInterval: 0.12, repeats: false) { [weak reel] _ in MainActor.assumeIsolated { reel?.wheelStopped() } }
      return
    }
    if e.phase.contains(.began) { swallowMomentum = false; samples = []; reel.gestureBegan() }
    super.scrollWheel(with: e)
    if e.phase.contains(.changed) {
      samples.append((e.timestamp, e.scrollingDeltaX))
      samples.removeAll { e.timestamp - $0.t > 0.08 }
    }
    if e.phase.contains(.ended) || e.phase.contains(.cancelled) {
      let span = max(samples.last.map { $0.t } ?? 0, 0) - (samples.first?.t ?? 0)
      let v = samples.isEmpty ? 0 : samples.reduce(0) { $0 + $1.dx } / CGFloat(max(span, 1.0 / 120))
      samples = []
      swallowMomentum = true
      reel.gestureEnded(velocity: v)
    }
  }
}

/// One agent: header, thread, and its message box (or the decision it waits on, docked at its foot).
struct Column: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    let _ = DeskProbe.body("Column", id: agentId)
    if let a = model.agent(agentId) {
      let asks = a.approval != nil, focused = a.focused
      VStack(spacing: 0) {
        ColumnHead(slice: a)
        if a.warm {
          ColumnThread(runId: a.header.runId, agentId: agentId, thread: model.thread(agentId))
            .task(id: agentId) { await model.keepThreadFresh(agentId: agentId) }
        } else {
          Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if let ap = a.approval { DecisionBar(approval: ap, focused: focused) } else { ColumnComposer(agentId: agentId, name: a.header.name) }
      }
      .background(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).fill(Theme.Desk.column))
      .overlay(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous)
        .strokeBorder(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke, lineWidth: asks || focused ? 1 : 0.5))
      .clipShape(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous))
      .geometryGroup()
      .contentShape(Rectangle())
      .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}

/// The column's header: bot, profile, its id suffix, bot name, state, place, and the system-drawn clock.
struct ColumnHead: View {
  let slice: AgentSlice
  var body: some View {
    DeskProbe.body("ColumnHead", id: slice.id)
    let h = slice.header
    return HStack(spacing: 8) {
      ProvidedBot(traits: slice.bot, size: .xs, cell: 1.5, provider: h.provider)
      Text(verbatim: h.name).font(Theme.Desk.name).foregroundStyle(Theme.Desk.text)
      if let s = h.suffix { Text(verbatim: s).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary) }
      if let n = slice.bot?.name { Text(verbatim: n).font(Theme.Desk.label).foregroundStyle(Theme.Desk.tertiary) }
      Text(verbatim: "· " + Self.state(h, asks: slice.approval != nil)).font(Theme.Desk.meta)
        .foregroundStyle(slice.approval != nil ? Theme.amber : h.status == .failed ? Theme.red : Theme.Desk.secondary)
      Spacer(minLength: 0)
      if let r = h.repo { Text(verbatim: r).font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary).lineLimit(1) }
      if h.status == .running, let start = h.startedAtMs {
        Text(Date(timeIntervalSince1970: Double(start) / 1000), style: .timer)
          .font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary).monospacedDigit()
      }
    }
    .lineLimit(1)
    .padding(.horizontal, 12)
    .frame(height: Theme.Desk.columnHeader)
    .accessibilityElement(children: .combine)
  }
  static func state(_ h: ColumnHeader, asks: Bool) -> String {
    if asks { return "waiting on you" }
    switch h.status {
    case .running: return "working"; case .pending: return "queued"; case .done: return "done"
    case .failed: return "failed"; case .paused: return "paused"; case .cancelled: return "stopped"
    case .handedOff: return "handed back"; case .unknown: return "starting"
    }
  }
}

/// The thread: rows from the shared renderer, newest at the bottom. Rows are Equatable, so a new or changed item
/// re-renders that row only.
struct ColumnThread: View {
  let runId: String
  let agentId: String
  let thread: ThreadSlice
  var body: some View {
    DeskProbe.body("ColumnThread", id: agentId)
    let entries = thread.entries
    return ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(entries.enumerated()), id: \.element.id) { n, e in
          EntryRow(runId: runId, agentId: agentId, entry: e, above: n == 0 ? 0 : Self.bottomMargin(entries[n - 1])).equatable()
        }
        if case .failed(let why)? = thread.unavailable {
          Text(verbatim: "Couldn't load the thread (\(why))").font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary)
        }
        ForEach(thread.pending) { p in SteerBubble(runId: runId, text: p.body, state: p.state) }
      }
      .padding(Theme.Desk.bodyPadding)
    }
    .defaultScrollAnchor(.bottom)
    .scrollIndicators(.never)
  }
  static func bottomMargin(_ e: ThreadEntry) -> CGFloat {
    switch e { case .item(let i, _): ThreadItemRow.bottomMargin(i); case .event: Theme.Content.proseBottom }
  }
}

struct EntryRow: View, Equatable {
  let runId: String
  let agentId: String
  let entry: ThreadEntry
  let above: CGFloat
  var body: some View {
    let _ = DeskProbe.body("EntryRow", id: agentId)
    switch entry {
    case .item(let i, let next): ThreadItemRow(runId: runId, agentId: agentId, item: i, next: next, above: above)
    case .event(let ev): ThreadItemView(runId: runId, agentId: agentId, item: ev).padding(.bottom, Theme.Content.proseBottom)
    }
  }
}

/// The column's message box: plain text to this agent. The draft is the field's own state; nothing else re-renders
/// while you type.
struct ColumnComposer: View {
  @Environment(DeskModel.self) private var model
  /// A reused reel slot's memory (reel.columns=reuse): the draft is kept there per agent. nil in a kept column.
  @Environment(\.slotMemory) private var memory
  let agentId: String
  let name: String
  @State private var draft = ""
  var body: some View {
    DeskProbe.body("ColumnComposer", id: agentId)
    return HStack(spacing: 8) {
      TextField("Tell \(name)…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(1...5)
        .onSubmit(send)
      if !draft.isEmpty {
        Button(action: send) {
          Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold)).foregroundStyle(Color(white: 0.11))
            .frame(width: 24, height: 24).background(Circle().fill(Theme.Desk.text))
        }
        .buttonStyle(PressableStyle()).accessibilityLabel("Send")
      }
    }
    .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
    .frame(minHeight: Theme.Desk.composerHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.composerRadius, style: .continuous).fill(Theme.Desk.composerFill))
    .padding([.horizontal, .bottom], 12)
    .modifier(SlotDraft(memory: memory, agentId: agentId, draft: $draft))
  }
  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.steer(agentId: agentId, body: text); draft = ""
  }
}

/// In a reused slot, the draft is restored when the agent's box appears and saved as it changes; in a kept column
/// (no memory) it adds nothing.
struct SlotDraft: ViewModifier {
  let memory: SlotMemory?
  let agentId: String
  @Binding var draft: String
  func body(content: Content) -> some View {
    if let memory {
      content
        .onAppear { if draft.isEmpty, let d = memory.drafts[agentId] { draft = d } }
        .onChange(of: draft) { _, d in memory.drafts[agentId] = d.isEmpty ? nil : d }
    } else {
      content
    }
  }
}

/// The decision an agent waits on, docked at its column's foot: the question, then View diff · Deny · Approve ↩.
/// Return approves only while its column has focus (SPEC §4): with asks in several columns, or focus elsewhere, a
/// Return must not approve one you aren't looking at. Esc is never bound.
struct DecisionBar: View {
  @Environment(DeskModel.self) private var model
  let approval: PendingApproval
  let focused: Bool
  var body: some View {
    DeskProbe.body("DecisionBar")
    let busy = approval.decision != .idle
    return VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: approval.question.plain).font(Theme.Desk.question).foregroundStyle(Theme.Desk.text)
        .fixedSize(horizontal: false, vertical: true)
      if let b = approval.branchLine { Text(verbatim: b).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.secondary) }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button("Deny") { model.decide(approval.id, .deny) }
          .buttonStyle(DeskButton(kind: .outline))
        Button { model.decide(approval.id, .approve) } label: {
          HStack(spacing: 6) { Text("Approve"); Text("↩").font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.12))) }
        }
        .buttonStyle(DeskButton(kind: .primary))
        .keyboardShortcut(focused ? .defaultAction : nil)
      }
      .disabled(busy).opacity(busy ? 0.5 : 1)
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.Desk.decisionFill)
  }
}

/// The two button looks the window uses: the inverted Approve and the outlined secondary (menu bar's Theme.Ask).
struct DeskButton: ButtonStyle {
  enum Kind { case primary, outline }
  let kind: Kind
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12.5, weight: kind == .primary ? .semibold : .medium))
      .foregroundStyle(kind == .primary ? Color(red: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255) : Theme.Desk.text)
      .padding(.horizontal, 12).frame(minWidth: kind == .primary ? 104 : 0).frame(height: 28)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(kind == .primary ? Theme.Desk.text : .clear))
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(kind == .primary ? .clear : Color.white.opacity(0.2), lineWidth: 0.5))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
#endif
