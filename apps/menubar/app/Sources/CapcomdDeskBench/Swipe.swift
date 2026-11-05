import AppKit
import QuartzCore
import CapcomdDesk
import DeskBenchKit
import PerfLoopProbe

/// `swipe` (design/perf-loop CAPABILITIES.md C9): a recorded gesture's scroll-wheel events, stamped with their recorded
/// times and delivered at those times through the window's event dispatch, from the main run loop, in this process only
/// (nothing is posted to the system). The reel's own routing, AppKit's gesture handling and the reel's snapping run as
/// under a hand; the smoothness meter (PerfLoopProbe) compares where the document layer showed at each display tick
/// with where the fingers put it.
extension Drive {
  func swipe() async -> ([StepResult], [Check]) {
    await rewind()
    guard let sv = h.reelScrollView() else { return ([], [Check("reel-scroll-view", false, "no horizontal NSScrollView found under the window")]) }
    let specs = (params["gesture"] ?? "synthetic:flick-forward").split(separator: ",").map { String($0).trimmingCharacters(in: .whitespaces) }
    var gestures: [Gesture] = []
    for s in specs {
      switch Gestures.load(s) {
      case .success(let g): gestures.append(g)
      case .failure(let e): return ([], [Check("gesture", false, e.description)])
      }
    }
    let stamps = GestureReplay.Stamps(rawValue: params["timestamps"] ?? "recorded")
    guard let stamps else { return ([], [Check("gesture", false, "timestamps=\(params["timestamps"] ?? ""): one of recorded, delivery, zero")]) }
    let route = GestureReplay.Route(rawValue: params["deliver"] ?? "window")
    guard let route else { return ([], [Check("gesture", false, "deliver=\(params["deliver"] ?? ""): one of window, view")]) }
    AppKitScrollTrace.installIfAsked()
    let cols = h.model.columns
    let from: Int = params["from"].flatMap(Int.init) ?? max(0, (cols.count - h.model.across) / 2)
    guard cols.indices.contains(from) else { return ([], [Check("gesture", false, "from=\(from): the fixture has \(cols.count) columns")]) }
    let views = sv.documentView!.subviews.map(\.frame.minX).sorted()
    let pitch = views.count == cols.count && views.count > 1 ? Double(views[1] - views[0]) : Double(sv.documentView!.frame.width) / Double(max(1, cols.count))
    var steps: [StepResult] = []; var snapped = true; var faithful = true; var fidelity: [String] = []
    for i in 0..<int("swipes", 4) {
      let g = gestures[i % gestures.count]
      // From the same column every time, at rest: the gesture has room on both sides, away from the rubber band.
      h.model.scroll(to: cols[from], animated: false)
      _ = await h.nextCommit()
      _ = await h.waitQuiet(quietMs: 150)
      let m = h.begin("swipe#\(i) \(g.name)")
      let t = h.now()
      let replay = GestureReplay(sv: sv, window: h.window, gesture: g, stamps: stamps, route: route)
      replay.blockMs = params["inject-block-ms"].flatMap(Double.init) ?? 0
      async let done: Void = replay.run()
      let (_, settled) = await h.waitReelSettled(since: t, timeoutMs: max(2500, g.durationMs + 1500))
      await done
      // The reel may still be moving when the last momentum event lands (the reel swallows momentum, so it shouldn't).
      if h.model.reelMoving { _ = await h.waitReelSettled(since: h.now(), timeoutMs: 1500) }
      // AppKit's own deceleration can carry the clip view on after the reel's slide ended (DESKBENCH.md, Recorded
      // gestures): at rest is when its offset stopped changing.
      var lastX = sv.contentView.bounds.origin.x, lastMove = h.now()
      let restWait = h.now()
      while h.now() - lastMove < 150, h.now() - restWait < 2000 {
        await h.sleep(ms: 16)
        if sv.contentView.bounds.origin.x != lastX { lastX = sv.contentView.bounds.origin.x; lastMove = h.now() }
      }
      _ = await h.nextCommit()
      replay.stop()
      let settledAt = settled.map { h.t0 + max($0, lastMove) / 1000 }
      var s = h.end(m, settleMs: settled.map { $0 - t }, notes: replay.notes())
      s.smoothness = replay.smoothness(settled: settledAt)
      let x = Double(sv.contentView.bounds.origin.x) + Double(sv.contentInsets.left)
      let off = abs(x / pitch - (x / pitch).rounded()) * pitch
      snapped = snapped && off < 2
      s.notes.append("rest offset from a column edge: \(Stats.round(off, 1)) pt")
      if let p = replay.unfaithful() { faithful = false; fidelity.append("\(s.name): \(p)") }
      steps.append(s)
      await h.sleep(ms: 250)
    }
    return (steps, [Check("snapped", snapped, "the reel rested on a column edge after every swipe"),
                    Check("gesture", faithful, faithful ? "every event replayed with its recorded phases and deltas (whole points, the rounding carried)" : fidelity.joined(separator: "; "))])
  }
}

/// One gesture's replay and what was on screen meanwhile. Events go out from a main-queue timer at their recorded
/// times (the main run loop serves it, as it serves the window server's events); a display link on the scroll view
/// reads the document layer's presentation each tick; a run-loop observer after Core Animation's commit notes when
/// the last commit went out, so the meter counts only deltas that could be on screen.
@MainActor final class GestureReplay: NSObject {
  let sv: NSScrollView
  let window: NSWindow
  let gesture: Gesture
  struct Sent { var due: Double; var delivered: Double; var dx: Double; var dy: Double; var phase: Gesture.Phase; var momentum: Gesture.Phase; var precise: Bool; var finger: Bool
    /// The clip view's offset just before and after the scroll view took the event (DESKBENCH_SWIPE_TRACE).
    var before = 0.0, after = 0.0 }
  private(set) var sent: [Sent] = []
  private var ticks: [SmoothnessMeter.Tick] = []
  private var start = 0.0
  private var startOffset = 0.0, startX = 0.0
  private var lastCommit = 0.0
  private var link: CADisplayLink?
  private var observer: CFRunLoopObserver?
  private var timer: DispatchSourceTimer?
  private var next = 0
  private var carry = (dx: 0.0, dy: 0.0, sentX: 0.0, sentY: 0.0)
  private var finished: CheckedContinuation<Void, Never>?
  /// The CGEvent field an NSEvent reads its window number from (undocumented; `NSEvent(cgEvent:).window` resolves by it).
  private static let windowNumberField = CGEventField(rawValue: 51)!

  /// What each event's timestamp (`NSEvent.timestamp`) says. AppKit reads the release velocity from it: the reel's
  /// landing and AppKit's own deceleration depend on it.
  enum Stamps: String {
    /// When the hand made it: the replay's start plus its recorded time, as a trackpad's events carry the time the
    /// hardware saw them however late the main thread takes them (the default).
    case recorded
    /// When it was handed over (before 2026-11-04): a late timer firing two events together gave AppKit a release
    /// velocity of the main thread's jitter (one flick read 820 to 7000 pt/s across replays).
    case delivery
    /// 0 on every event, as `fling` sends them: AppKit then can't see a release velocity.
    case zero
  }
  let stamps: Stamps
  /// Where each event goes.
  enum Route: String {
    /// To the application (`NSApp.sendEvent`) for the reel's window, at its pointer location over the scroll view, as
    /// the window server hands a hand's events over: local event monitors run, so the reel's routing (ReelView.took)
    /// decides, as under a hand (the default). Falls back to `view` where the event's window location can't be set.
    case window
    /// Straight to the scroll view's `scrollWheel(with:)` (before 2026-11-04): the reel's routing is skipped.
    case view
  }
  let route: Route
  /// The route the events actually took (`window` falls back to `view`, once, if it can't place them).
  private(set) var routed: Route
  /// `--set inject-block-ms=N`, the meter's self-check: the main thread sleeps N ms after the middle finger event, as a
  /// slow frame would hold it. The result must show the stalls (DESKBENCH.md, swipe).
  var blockMs = 0.0
  init(sv: NSScrollView, window: NSWindow, gesture: Gesture, stamps: Stamps = .recorded, route: Route = .window) {
    self.sv = sv; self.window = window; self.gesture = gesture; self.stamps = stamps; self.route = route
    routed = route == .window && Self.setWindowLocation == nil ? .view : route
  }

  /// `CGEventSetWindowLocation` (SkyLight, not in the SDK): where an event addressed to a window lands in it. An
  /// NSEvent made from a CGEvent with a window number takes its `locationInWindow` from this, not from the screen
  /// location. Looked up at run time; without it the replay goes to the view.
  private static let setWindowLocation: (@convention(c) (CGEvent, CGPoint) -> Void)? = {
    guard let sym = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGEventSetWindowLocation") else { return nil }
    return unsafeBitCast(sym, to: (@convention(c) (CGEvent, CGPoint) -> Void).self)
  }()

  /// Where the document showed along x in the scroll view's layer, from the presentation tree (a slide in the render
  /// server included). Falls back to the clip view's offset when the views have no layers.
  func docX() -> Double {
    guard let dl = sv.documentView?.layer, let sl = sv.layer else { return -Double(sv.contentView.bounds.origin.x) }
    let p = dl.presentation() ?? dl, s = sl.presentation() ?? sl
    return Double(p.convert(CGPoint.zero, to: s).x)
  }
  /// The content offset shown now: the start's offset moved by however far the document layer has moved since.
  func shown() -> Double { startOffset + (startX - docX()) }

  func run() async {
    startOffset = Double(sv.contentView.bounds.origin.x); startX = docX()
    start = CACurrentMediaTime() + 0.02   // the first event a frame from now: the display link and observer are in place
    lastCommit = CACurrentMediaTime()
    let obs = CFRunLoopObserverCreateWithHandler(nil, CFRunLoopActivity.beforeWaiting.rawValue | CFRunLoopActivity.exit.rawValue, true, 2_100_000) { [weak self] _, _ in
      MainActor.assumeIsolated { self?.lastCommit = CACurrentMediaTime() }   // after Core Animation's commit (order 2 000 000)
    }
    CFRunLoopAddObserver(CFRunLoopGetMain(), obs, .commonModes)
    observer = obs
    let l = sv.displayLink(target: self, selector: #selector(tick(_:)))
    let hz = Float(window.screen?.maximumFramesPerSecond ?? 60)
    l.preferredFrameRateRange = CAFrameRateRange(minimum: hz, maximum: hz, preferred: hz)
    l.add(to: .main, forMode: .common)
    link = l
    await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
      finished = c
      let t = DispatchSource.makeTimerSource(flags: .strict, queue: .main)
      t.setEventHandler { [weak self] in MainActor.assumeIsolated { self?.fire() } }
      timer = t
      schedule()
      t.resume()
    }
  }

  private func schedule() {
    guard next < gesture.events.count else { timer?.cancel(); timer = nil; finished?.resume(); finished = nil; return }
    let due = start + gesture.events[next].t / 1000
    timer?.schedule(deadline: .now() + max(0, due - CACurrentMediaTime()), leeway: .nanoseconds(0))
  }

  private func fire() {
    let now = CACurrentMediaTime()
    while next < gesture.events.count, start + gesture.events[next].t / 1000 <= now + 0.0002 { deliver(gesture.events[next]); next += 1 }
    schedule()
  }

  @objc func tick(_ l: CADisplayLink) {
    ticks.append(SmoothnessMeter.Tick(t: CACurrentMediaTime(), committed: lastCommit, shown: shown()))
    if trace != nil { tickOffsets.append(Double(sv.contentView.bounds.origin.x)) }
  }

  /// DESKBENCH_SWIPE_TRACE=FILE: every event and tick of every replay appended to FILE as JSON lines, raw (times in s
  /// since the replay's start), to see what AppKit did with them.
  let trace = ProcessInfo.processInfo.environment["DESKBENCH_SWIPE_TRACE"]
  private var tickOffsets: [Double] = []
  func writeTrace() {
    guard let path = trace else { return }
    var lines: [String] = []
    func r(_ x: Double) -> Double { (x * 10000).rounded() / 10000 }
    for e in sent { lines.append("{\"kind\":\"event\",\"due\":\(r(e.due - start)),\"delivered\":\(r(e.delivered - start)),\"dx\":\(e.dx),\"phase\":\"\(e.phase.rawValue)\",\"momentum\":\"\(e.momentum.rawValue)\",\"before\":\(e.before),\"after\":\(e.after)}") }
    for (i, k) in ticks.enumerated() { lines.append("{\"kind\":\"tick\",\"t\":\(r(k.t - start)),\"committed\":\(r(k.committed - start)),\"shown\":\(r(k.shown)),\"clip\":\(i < tickOffsets.count ? tickOffsets[i] : -1)}") }
    lines.append("{\"kind\":\"end\",\"gesture\":\"\(gesture.name)\",\"startOffset\":\(startOffset)}")
    let data = Data((lines.joined(separator: "\n") + "\n").utf8)
    if let h = FileHandle(forWritingAtPath: path) { h.seekToEndOfFile(); h.write(data); try? h.close() } else { FileManager.default.createFile(atPath: path, contents: data) }
  }

  func stop() {
    writeTrace()
    link?.invalidate(); link = nil
    if let o = observer { CFRunLoopRemoveObserver(CFRunLoopGetMain(), o, .commonModes); observer = nil }
    timer?.cancel(); timer = nil
  }

  /// A CGEvent with the recorded fields, made into an NSEvent and handed to the scroll view (as `fling` does). A CGEvent
  /// carries whole points, so fractional deltas are rounded with the remainder carried to the next event.
  private func deliver(_ e: Gesture.Event) {
    carry.dx += e.dx; carry.dy += e.dy
    let ix = carry.dx.rounded() - carry.sentX, iy = carry.dy.rounded() - carry.sentY
    carry.sentX += ix; carry.sentY += iy
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: e.precise ? .pixel : .line, wheelCount: 2, wheel1: Int32(iy), wheel2: Int32(ix), wheel3: 0) else { return }
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: e.precise ? 1 : 0)
    if e.precise {
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: iy); cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: ix)
    }
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: iy); cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: ix)
    // CGScrollPhase: began 1, changed 2, ended 4, cancelled 8, mayBegin 128. CGMomentumScrollPhase: begin 1, continue 2, end 3.
    let sp: Int64 = switch e.phase { case .began: 1; case .changed, .stationary: 2; case .ended: 4; case .cancelled: 8; case .mayBegin: 128; case .none: 0 }
    let mp: Int64 = switch e.momentum { case .began: 1; case .changed, .stationary, .mayBegin: 2; case .ended, .cancelled: 3; case .none: 0 }
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: sp)
    cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: mp)
    let now = CACurrentMediaTime()
    // NSEvent.timestamp: the reel's release velocity reads it, and AppKit's (Stamps).
    switch stamps { case .recorded: cg.timestamp = CGEventTimestamp((start + e.t / 1000) * 1e9); case .delivery: cg.timestamp = CGEventTimestamp(now * 1e9); case .zero: break }
    let center = sv.convert(sv.bounds, to: nil).center
    let p = window.convertPoint(toScreen: center)
    cg.location = CGPoint(x: p.x, y: (NSScreen.screens.first?.frame.height ?? 0) - p.y)
    if routed == .window, let place = Self.setWindowLocation {
      cg.setIntegerValueField(Self.windowNumberField, value: Int64(window.windowNumber))
      place(cg, CGPoint(x: center.x, y: window.frame.height - center.y))   // from the window's top left
    }
    guard let ev = NSEvent(cgEvent: cg) else { return }
    sent.append(Sent(due: start + e.t / 1000, delivered: now, dx: Double(ev.scrollingDeltaX), dy: Double(ev.scrollingDeltaY), phase: Gesture.Phase(rawBits: ev.phase.rawValue),
                     momentum: Gesture.Phase(rawBits: ev.momentumPhase.rawValue), precise: ev.hasPreciseScrollingDeltas, finger: e.finger, before: Double(sv.contentView.bounds.origin.x)))
    if routed == .window, ev.window === window {
      NSApp.sendEvent(ev)
    } else {
      routed = .view
      sv.scrollWheel(with: ev)
    }
    sent[sent.count - 1].after = Double(sv.contentView.bounds.origin.x)
    if blockMs > 0, e.phase == .changed, sent.filter(\.finger).count == gesture.events.filter(\.finger).count / 2 { usleep(useconds_t(blockMs * 1000)) }
  }

  /// The meter's verdict: content offset grows as −scrollingDeltaX (a leftward swipe scrolls forward).
  func smoothness(settled: Double?) -> Smoothness {
    let fingers = sent.filter(\.finger)
    let deltas = sent.map { SmoothnessMeter.Delta(due: $0.due, delivered: $0.delivered, d: -$0.dx, finger: $0.finger) }
    return SmoothnessMeter.measure(ticks: ticks, deltas: deltas, start: startOffset, fingerFrom: fingers.first?.due ?? start,
                                   fingerUntil: fingers.last?.due ?? start, settled: settled)
  }

  /// How far off the replay was: the events' delivery against their recorded times.
  func notes() -> [String] {
    let late = sent.map { ($0.delivered - $0.due) * 1000 }
    let fx = sent.filter(\.finger).reduce(0) { $0 + $1.dx }, mx = sent.filter { $0.momentum != .none }.reduce(0) { $0 + $1.dx }
    return ["\(gesture.name): \(sent.count)/\(gesture.events.count) events over \(Int(gesture.durationMs)) ms, delivered p95 \(Stats.round(Stats.percentile(late, 95), 2)) ms after due (max \(Stats.round(late.max() ?? 0, 2)) ms)",
            "fingers moved \(Stats.round(fx, 1)) pt, momentum \(Stats.round(mx, 1)) pt; \(ticks.count) display ticks read; timestamps \(stamps.rawValue), delivered to the \(routed.rawValue)"]
  }

  /// Why the replay wasn't the recording, if it wasn't: a phase the NSEvent didn't carry, or deltas that drifted.
  func unfaithful() -> String? {
    if sent.count != gesture.events.count { return "\(sent.count) of \(gesture.events.count) events delivered" }
    func norm(_ p: Gesture.Phase, momentum: Bool) -> Gesture.Phase { p == .stationary ? .changed : momentum && p == .cancelled ? .ended : momentum && p == .mayBegin ? .changed : p }
    for (s, e) in zip(sent, gesture.events) {
      if s.phase != norm(e.phase, momentum: false) || s.momentum != norm(e.momentum, momentum: true) {
        return "an event at \(e.t) ms went out as phase \(s.phase.rawValue)/\(s.momentum.rawValue), recorded \(e.phase.rawValue)/\(e.momentum.rawValue)"
      }
      if s.precise != e.precise { return "an event at \(e.t) ms went out with precise=\(s.precise)" }
    }
    let rx = gesture.events.reduce(0) { $0 + $1.dx }, sx = sent.reduce(0) { $0 + $1.dx }
    if gesture.events.allSatisfy(\.precise), abs(rx - sx) > 1 { return "the deltas summed to \(sx) pt, recorded \(rx) pt" }
    return nil
  }
}
