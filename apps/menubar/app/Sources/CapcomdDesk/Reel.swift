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
final class ReelView: NSView {
  private let model: DeskModel
  private let scroll = SnapScrollView()
  private let doc = Flipped()
  private var hosts: [String: NSHostingView<AnyView>] = [:]
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
    for id in Set(hosts.keys).subtracting(ids) { hosts.removeValue(forKey: id)?.removeFromSuperview() }
    for id in Set(blanks.keys).subtracting(ids) { blanks.removeValue(forKey: id)?.removeFromSuperview() }
    order = ids
    at = min(at, max(0, ids.count - 1))
    for id in ids where hosts[id] == nil && blanks[id] == nil {
      let b = NSView()
      b.wantsLayer = true
      b.layer?.backgroundColor = NSColor(Theme.Desk.column).cgColor
      b.layer?.cornerRadius = Theme.Desk.columnRadius
      b.layer?.cornerCurve = .continuous
      doc.addSubview(b)
      blanks[id] = b
    }
    needsLayout = true
    buildSoon()
  }

  private var blanks: [String: NSView] = [:]
  private var building = false

  /// Builds column `i`'s hosting view in place of its blank.
  private func build(_ i: Int) {
    guard order.indices.contains(i), hosts[order[i]] == nil else { return }
    let id = order[i]
    let h = NSHostingView(rootView: AnyView(Column(agentId: id)
      .environment(model).environment(\.threadHost, ThreadHostBox(host: model)).preferredColorScheme(.dark)))
    h.safeAreaRegions = []
    h.sizingOptions = []   // the reel sets its frame; nothing to measure
    h.frame = blanks[id]?.frame ?? frame(of: i)
    doc.addSubview(h)
    hosts[id] = h
    blanks.removeValue(forKey: id)?.removeFromSuperview()
  }

  /// The columns that must exist now: those on screen and one each side.
  private func buildAround(_ i: Int) {
    guard !order.isEmpty, across > 0 else { return }
    for j in max(0, i - 1)...min(order.count - 1, i + across) { build(j) }
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
    scroll.frame = bounds
    let gap = Theme.Desk.gap, inset = Theme.Desk.peek + gap
    let n = Theme.Desk.columnsAcross(bounds.width)
    let w = max(320, (bounds.width - 2 * inset - CGFloat(n - 1) * gap) / CGFloat(n))
    let moved = w + gap != pitch
    across = n; width = w; pitch = w + gap
    for (i, id) in order.enumerated() { (hosts[id] ?? blanks[id])?.frame = frame(of: i) }
    doc.frame = CGRect(x: 0, y: 0, width: max(bounds.width, 2 * inset + CGFloat(order.count) * pitch - gap), height: bounds.height)
    if moved { jump(to: at) }   // a new width keeps the same leading column
    if model.across != n { DispatchQueue.main.async { [model] in if model.across != n { model.across = n } } }
    if let p = pending, bounds.width > 0 { pending = nil; perform(p) }
    buildAround(at)
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
  }

  /// Slides to column `i` in the render server: the scroll offset moves to the target at once (one update for the
  /// columns, which then don't move again) and the document layer is animated from where it showed. Scrolling the
  /// clip view frame by frame made every column's hosting view update its graph each frame (~20 ms a frame).
  fileprivate func slide(to i: Int, from start: CGFloat? = nil) {
    if clipSlide { return clipViewSlide(to: i, from: start) }
    let from = start ?? shownOffset(), to = x(i)
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
    let o = scroll.contentView.bounds.origin.x
    guard let l = doc.layer, l.animation(forKey: "slide") != nil, let p = l.presentation() else { return o }
    return o - (p.position.x - l.position.x)
  }

  /// Ends a slide where it shows now (a new slide or a swipe takes over from there).
  private func stopSlide() {
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

  final class Flipped: NSView { override var isFlipped: Bool { true } }
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
        if let ap = a.approval { DecisionBar(approval: ap) } else { ColumnComposer(agentId: agentId, name: a.header.name) }
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
      if h.status == .running {
        Text(Date(timeIntervalSince1970: Double(h.spawnedAtMs) / 1000), style: .timer)
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
  }
  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.steer(agentId: agentId, body: text); draft = ""
  }
}

/// The decision an agent waits on, docked at its column's foot: the question, then View diff · Deny · Approve ↩.
struct DecisionBar: View {
  @Environment(DeskModel.self) private var model
  let approval: PendingApproval
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
        .keyboardShortcut(.defaultAction)
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
