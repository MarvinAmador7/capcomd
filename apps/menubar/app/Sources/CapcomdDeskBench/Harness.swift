import AppKit
import SwiftUI
import QuartzCore
import os
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopProbe

/// The desktop window hosted in this process on a fixture, with the instruments around it: a display link for frame
/// timing, the stretch clock's run-loop observers for main-thread stretches (StretchClock.swift), the views' probe for body counts, signposts for Instruments.
/// Everything is driven in-process (the model's own entry points, events sent to our own window); nothing is posted to
/// the system, so the owner's Mac is never clicked into.
@MainActor final class Harness: DeskProbeSink {
  let world: World
  let store: CapcomdStore
  let model: DeskModel
  let thread: FixtureThread
  var window: NSWindow!
  var hosting: NSHostingView<DeskWindowContent>!
  var fixtureLoadMs = 0.0
  var activity: NSObjectProtocol?
  let signposter = OSSignposter(subsystem: "dev.capcomd.deskbench", category: .pointsOfInterest)
  let log = Logger(subsystem: "dev.capcomd.deskbench", category: "harness")

  // Samples. Times are ms since the harness was made (CACurrentMediaTime, the display link's clock).
  let t0 = CACurrentMediaTime()
  var ticks: [Double] = []
  /// Main-thread stretches, from the clock (the same edges the sampler uses).
  lazy var clock = StretchClock(t0: t0)
  var stretches: [StretchClock.Entry] { clock.entries }
  var bodies: [(t: Double, view: String, id: String?)] = []
  /// The model's mutation records (`Mutations`, CAPABILITIES.md C7) and the bodies charged to them: each step's and
  /// long stretch's `causes`. Turns end where stretches close.
  lazy var causes = CauseRecorder { [unowned self] in now() }
  var events: [(t: Double, name: String, value: Int)] = []
  var link: CADisplayLink?
  var waiters: [(id: Int, check: () -> Bool, resume: () -> Void)] = []
  var waiterSerial = 0
  var nominalHz: Double = 60
  /// Main-thread stacks inside long stretches (Sampler.swift); nil with `--sampler off`.
  var sampler: MainThreadSampler?
  /// Sequence numbers for events the scenarios make up (asks, decisions): never reused, the store drops duplicate ids.
  var liveSeq = 900_000
  /// When the open project's columns were last made anew (a project switch, a fresh window): the guards count a
  /// column's bodies from here (Guards.swift).
  var columnsSince = 0.0
  func nextSeq() -> Int { liveSeq += 1; return liveSeq }

  init(world w: World) {
    world = w
    let start = CACurrentMediaTime()
    thread = FixtureThread(w)
    store = CapcomdStore(thread: thread, clientId: "deskbench")
    w.load(into: store)
    model = DeskModel(store: store)
    fixtureLoadMs = (CACurrentMediaTime() - start) * 1000
    DeskProbe.sink = self
    Mutations.sink = causes
  }

  func now() -> Double { (CACurrentMediaTime() - t0) * 1000 }

  // MARK: window

  /// The harness the SwiftUI scene host shows (`--host scene`): made before the app launches, so the scene's first
  /// frame already has the fixture in it.
  static var current: Harness?
  /// Whether the window comes from the SwiftUI `Window` scene (the app's own machinery) or is made by hand.
  var sceneHosted = false

  /// Shows the window: the scene's, when the bench runs as a SwiftUI app (the app's own NSWindow subclass, hosting view
  /// and toolbar handling: what the app pays, the bench pays), else one made by hand with the same content view and
  /// chrome. Either way this process is activated, so SwiftUI flushes state changes promptly (in the background it can
  /// hold them for seconds).
  func showWindow(size: CGSize, activate: Bool) {
    if sceneHosted, let w = sceneWindow {
      window = w
      if w.contentView?.frame.size != size { w.setContentSize(size) }
      w.center()
      nominalHz = Double(w.screen?.maximumFramesPerSecond ?? NSScreen.main?.maximumFramesPerSecond ?? 60)
      if activate { NSApp.setActivationPolicy(.regular); NSApp.activate(ignoringOtherApps: true); w.makeKeyAndOrderFront(nil) } else { w.orderFrontRegardless() }
      activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical, .idleDisplaySleepDisabled, .suddenTerminationDisabled], reason: "deskbench scenario")
      startSampling()
      return
    }
    let rect = NSRect(origin: .zero, size: size)
    let w = NSWindow(contentRect: rect, styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    w.title = "capcomd (bench)"
    w.isReleasedWhenClosed = false
    w.contentMinSize = DeskWindowContent.minSize
    let h = NSHostingView(rootView: DeskWindowContent(model: model))
    // The scene's hosting view keeps NSHostingView's default sizing options (it sizes the window from the content); a
    // hand-made window is sized by the bench, so none are needed. DESKBENCH_SIZING=1 keeps the defaults, to compare.
    if ProcessInfo.processInfo.environment["DESKBENCH_SIZING"] == nil { h.sizingOptions = [] }
    w.contentView = h
    hosting = h; window = w
    w.center()
    nominalHz = Double(w.screen?.maximumFramesPerSecond ?? NSScreen.main?.maximumFramesPerSecond ?? 60)
    if activate { NSApp.activate(ignoringOtherApps: true) }
    activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiated, .latencyCritical, .idleDisplaySleepDisabled, .suddenTerminationDisabled], reason: "deskbench scenario")
    if activate { w.makeKeyAndOrderFront(nil) } else { w.orderFrontRegardless() }
    startSampling()
  }

  /// The scene's window, once SwiftUI has made it.
  var sceneWindow: NSWindow? { NSApp.windows.first { $0.title == BenchScene.title && !($0.contentView is NSHostingView<DeskWindowContent>) } }

  /// Waits (up to 5 s) for the scene to make its window. The bench's command starts before SwiftUI has made the
  /// scene's window; showing the window before then made a second, hand-made one in front of it, and every scene-hosted
  /// run measured both windows: two reels, every body twice, on one model.
  func sceneWindowReady() async {
    guard sceneHosted else { return }
    for _ in 0..<250 where sceneWindow == nil { await sleep(ms: 20) }
    if sceneWindow == nil { log.info("the scene's window didn't appear within 5 s; showing a hand-made window instead") }
  }

  /// Activation is asynchronous: ask again until the window is key (or give up after ~1 s) and say whether it is.
  func ensureActive(_ activate: Bool) async -> Bool {
    guard activate, let w = window else { return false }
    for _ in 0..<10 where !(w.isKeyWindow && NSApp.isActive) {
      NSApp.setActivationPolicy(.regular)
      NSApp.activate(ignoringOtherApps: true)
      NSRunningApplication.current.activate(options: [.activateIgnoringOtherApps])
      w.makeKeyAndOrderFront(nil)
      await sleep(ms: 100)
    }
    return w.isKeyWindow && NSApp.isActive
  }

  /// Hides the window. A hand-made one is torn down (its view tree would otherwise keep observing the model and
  /// double every later body count); the scene's is only ordered out.
  func closeWindow() {
    stopSampling()
    if sceneHosted { window?.orderOut(nil) } else { window?.orderOut(nil); window?.contentView = nil; window?.close() }
    window = nil; hosting = nil
  }

  /// Used by `profile`'s child and `snapshot`: the window's state, for the result.
  var hostName: String { sceneHosted ? "scene" : "window" }

  func windowState() -> WindowState? {
    guard let w = window else { return nil }
    return WindowState(appActive: NSApp.isActive, keyWindow: w.isKeyWindow, visible: w.isVisible, occluded: !w.occlusionState.contains(.visible),
                       activityAsserted: activity != nil, frame: [w.frame.origin.x, w.frame.origin.y, w.frame.width, w.frame.height], backingScale: w.backingScaleFactor)
  }

  // MARK: sampling

  func startSampling() {
    guard let v = window.contentView else { return }
    let l = v.displayLink(target: self, selector: #selector(tick(_:)))
    let hz = Float(nominalHz)
    l.preferredFrameRateRange = CAFrameRateRange(minimum: hz, maximum: hz, preferred: hz)   // hold ProMotion at its top rate
    l.add(to: .main, forMode: .common)
    link = l
    clock.closed = { [unowned self] in causes.turnEnded(); checkWaiters() }
    if SamplerConfig.current.enabled, MainThreadSampler.supported { sampler = sampler ?? MainThreadSampler(config: SamplerConfig.current); sampler?.start() }
    clock.sampler = sampler
    clock.attach()
  }

  func stopSampling() {
    link?.invalidate(); link = nil
    clock.detach()
    clock.sampler = nil
  }

  /// The calling thread's CPU time (user + system) in ms.
  nonisolated static func threadCpuMs() -> Double {
    var info = thread_basic_info()
    var count = mach_msg_type_number_t(MemoryLayout<thread_basic_info>.size / MemoryLayout<integer_t>.size)
    let r = withUnsafeMutablePointer(to: &info) { $0.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { thread_info(mach_thread_self(), thread_flavor_t(THREAD_BASIC_INFO), $0, &count) } }
    guard r == KERN_SUCCESS else { return 0 }
    return Double(info.user_time.seconds + info.system_time.seconds) * 1000 + Double(info.user_time.microseconds + info.system_time.microseconds) / 1000
  }

  @objc func tick(_ l: CADisplayLink) {
    ticks.append(now())
    checkWaiters()
  }

  nonisolated func body(_ view: StaticString) { MainActor.assumeIsolated { let t = now(), v = view.description; bodies.append((t, v, nil)); causes.body(v, at: t) } }
  nonisolated func body(_ view: StaticString, id: String) { MainActor.assumeIsolated { let t = now(), v = view.description; bodies.append((t, v, id)); causes.body(v, id: id, at: t) } }
  nonisolated func event(_ name: StaticString, _ value: Int) { MainActor.assumeIsolated { events.append((now(), name.description, value)); checkWaiters() } }

  func checkWaiters() {
    guard !waiters.isEmpty else { return }
    let ready = waiters.filter { $0.check() }
    let ids = Set(ready.map(\.id))
    waiters.removeAll { ids.contains($0.id) }
    ready.forEach { $0.resume() }
  }

  /// Waits until `check` holds (checked on every tick, event and run-loop wait) or `timeoutMs` passes. Returns whether it held.
  func wait(timeoutMs: Double, _ check: @escaping () -> Bool) async -> Bool {
    if check() { return true }
    let deadline = now() + timeoutMs
    return await withCheckedContinuation { (c: CheckedContinuation<Bool, Never>) in
      var done = false
      let resume: (Bool) -> Void = { ok in if !done { done = true; c.resume(returning: ok) } }
      waiterSerial += 1
      waiters.append((id: waiterSerial, check: { check() || self.now() > deadline }, resume: { resume(check()) }))
      DispatchQueue.main.asyncAfter(deadline: .now() + timeoutMs / 1000 + 0.01) { MainActor.assumeIsolated { self.checkWaiters(); resume(check()) } }
    }
  }

  /// Resolves when the Core Animation commit that follows the current run-loop turn has gone out: the frame that shows a
  /// state change made just before the call. Returns the time it completed.
  func nextCommit() async -> Double {
    await withCheckedContinuation { (c: CheckedContinuation<Double, Never>) in
      CATransaction.begin()
      CATransaction.setCompletionBlock { MainActor.assumeIsolated { c.resume(returning: self.now()) } }
      CATransaction.commit()
    }
  }

  func sleep(ms: Double) async { try? await Task.sleep(for: .milliseconds(Int(ms))) }

  /// The WindowServer's word that the window is on screen (CGWindowList), checked on every display tick. The first
  /// frame of a new window can be held by the server past the commit, so `open` reports this time too.
  func waitOnScreen(timeoutMs: Double = 3000) async -> Double? {
    guard let w = window else { return nil }
    let n = CGWindowID(w.windowNumber)
    func onScreen() -> Bool {
      guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] else { return false }
      return list.contains { ($0[kCGWindowNumber as String] as? CGWindowID) == n }
    }
    return await wait(timeoutMs: timeoutMs, onScreen) ? now() : nil
  }

  // MARK: steps

  struct Marker { var name: String; var at: Double; var tick: Int; var stretch: Int; var body: Int; var state: OSSignpostIntervalState; var cpu: Double; var instructions: UInt64? }

  /// A step starts. Its CPU and instructions are the main thread's own counters from here to `end` (bench measure 2):
  /// every stretch, or part of one, inside the step and nothing outside it; no other thread (the sampler's included).
  func begin(_ name: String) -> Marker {
    let id = signposter.makeSignpostID()
    let st = signposter.beginInterval("step", id: id, "\(name, privacy: .public)")
    log.debug("step begin \(name, privacy: .public)")
    // The counters last, so the step's own bookkeeping isn't in them.
    let at = now(), cpu = Self.threadCpuMs()
    return Marker(name: name, at: at, tick: ticks.count, stretch: stretches.count, body: bodies.count, state: st, cpu: cpu, instructions: ProcessCounters.threadInstructions())
  }

  func end(_ m: Marker, latencyMs: Double? = nil, settleMs: Double? = nil, notes: [String] = []) -> StepResult {
    let instructions = ProcessCounters.threadInstructions().flatMap { b in m.instructions.map { b > $0 ? Int(b - $0) : 0 } }
    let cpu = Self.threadCpuMs() - m.cpu
    signposter.endInterval("step", m.state)
    let end = now()
    let its = intervals(from: m.tick)
    let st = stretches[m.stretch...]
    var r = StepResult(name: m.name, atMs: Stats.round(m.at, 1), durationMs: Stats.round(end - m.at, 1), latencyMs: latencyMs.map { Stats.round($0, 2) }, settleMs: settleMs.map { Stats.round($0, 1) },
                       frames: FrameStats(intervalsMs: its, nominalHz: nominalHz), mainThread: MainThreadStats(stretchesMs: st.map(\.dur), cpuMs: st.map(\.cpu)),
                       bodies: count(bodies[m.body...]), notes: notes, cpuMs: Stats.round(cpu, 2), instructions: instructions.flatMap { $0 > 0 ? $0 : nil })
    r.causes = causes.causes(from: m.at, to: end)
    return r
  }

  func intervals(from tick: Int) -> [Double] {
    let ts = ticks[min(tick, ticks.count)...]
    return zip(ts.dropFirst(), ts).map { $0 - $1 }
  }

  func count<S: Sequence>(_ bs: S) -> [String: Int] where S.Element == (t: Double, view: String, id: String?) {
    var c: [String: Int] = [:]
    for b in bs { c[b.view, default: 0] += 1 }
    return c
  }

  /// Bodies between two times, by view and by (view, id).
  func bodies(in range: ClosedRange<Double>) -> [(view: String, id: String?)] {
    bodies.filter { range.contains($0.t) }.map { ($0.view, $0.id) }
  }

  /// The longest main-thread stretches since `from`, each with the bodies evaluated inside it (and its stacks, with the sampler on).
  func worstStretches(from index: Int, steps: [StepResult], limit: Int = 8) -> [Stretch] {
    if let first = stretches[index...].first { sampler?.discard(beforeStretch: first.id) }
    return stretches[index...].sorted { $0.dur > $1.dur }.prefix(limit).map { s in
      var b: [String: Int] = [:]
      for x in bodies(in: s.at...(s.at + s.dur)) { b[x.view, default: 0] += 1 }
      var w = Stretch(step: Stretch.label(at: s.at, dur: s.dur, steps: steps), atMs: Stats.round(s.at, 1), durationMs: Stats.round(s.dur, 2), cpuMs: Stats.round(s.cpu, 2), bodies: b)
      w.causes = causes.causes(from: s.at, to: s.at + s.dur)
      sampler?.annotate(&w, stretch: s.id)
      return w
    }
  }

  /// Waits until the main thread has done no stretch of more than `maxCpuMs` of CPU for `quietMs` (CPU, not wall time,
  /// so a preempted short stretch doesn't count): what building columns and warming threads leave behind when they're
  /// done. The stretch this runs in counts too: when the main thread never sleeps, the setup and these polls share one
  /// long stretch (a step once started 1 s into one). Returns how long it waited, nil when it gave up after `timeoutMs`.
  func waitQuiet(quietMs: Double = 300, maxCpuMs: Double = 4, timeoutMs: Double = 5000) async -> Double? {
    let start = now()
    while now() - start < timeoutMs {
      var lastBusy = stretches.last { $0.cpu > maxCpuMs }.map { $0.at + $0.dur } ?? 0
      if let open = clock.openCpuMs, open > maxCpuMs { lastBusy = now() }
      if now() - max(lastBusy, start) >= quietMs { return now() - start }
      await sleep(ms: 50)
    }
    return nil
  }

  /// A clean slate between reps: samples kept (indices are per rep), waiters cleared.
  func mark() -> (tick: Int, stretch: Int, body: Int) { (ticks.count, stretches.count, bodies.count) }

  /// The noise floor: the window shown, nothing happening, for `seconds`.
  func idle(seconds: Double) async -> (FrameStats, MainThreadStats) {
    let m = mark()
    await sleep(ms: seconds * 1000)
    let st = stretches[m.stretch...]
    return (FrameStats(intervalsMs: intervals(from: m.tick), nominalHz: nominalHz), MainThreadStats(stretchesMs: st.map(\.dur), cpuMs: st.map(\.cpu)))
  }

  // MARK: reel helpers

  var reelMoving: Bool { model.reelMoving }
  var lastPhaseEvent: (t: Double, value: Int)? { events.last { $0.name == "reel.phase" }.map { ($0.t, $0.value) } }

  /// Waits for the reel to start moving (phase 1) after `since`, then to stop. Returns (startedAt, settledAt).
  func waitReelSettled(since: Double, timeoutMs: Double = 2500) async -> (started: Double?, settled: Double?) {
    let began = await wait(timeoutMs: 600) { self.events.contains { $0.name == "reel.phase" && $0.value == 1 && $0.t >= since } }
    guard began else { return (nil, nil) }
    let start = events.first { $0.name == "reel.phase" && $0.value == 1 && $0.t >= since }?.t
    let ended = await wait(timeoutMs: timeoutMs) { !self.model.reelMoving && (self.lastPhaseEvent?.value ?? 1) == 0 && (self.lastPhaseEvent?.t ?? 0) >= (start ?? since) }
    let settled = ended ? lastPhaseEvent?.t : nil
    // One more frame so the settle itself is in the step's window.
    _ = await nextCommit()
    return (start, settled)
  }

  // MARK: views

  /// The reel's horizontal NSScrollView (the widest scroll view whose document is wider than it).
  func reelScrollView() -> NSScrollView? {
    var best: NSScrollView?
    walk(window.contentView!) { v in
      if let s = v as? NSScrollView, let d = s.documentView, d.frame.width > s.bounds.width + 1, s.bounds.width > (best?.bounds.width ?? 0) { best = s }
    }
    return best
  }

  /// A composer text field inside the on-screen part of the reel.
  func composerField(visibleOnly: Bool = true) -> NSTextField? {
    var fields: [NSTextField] = []
    walk(window.contentView!) { v in
      if let f = v as? NSTextField, (f.placeholderString ?? "").hasPrefix("Tell "), f.isEditable {
        let r = f.convert(f.bounds, to: nil)
        if !visibleOnly || window.contentView!.bounds.intersects(r) { fields.append(f) }
      }
    }
    return fields.sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }.first { $0.convert($0.bounds, to: nil).minX >= 0 }
  }

  func walk(_ v: NSView, _ f: (NSView) -> Void) { f(v); v.subviews.forEach { walk($0, f) } }

  /// The window's visible child windows (Search ⌘K's panel) drawn over its picture at their places, each drawn by
  /// itself as the window is (behind-window vibrancy doesn't draw this way; the content does).
  func drawChildWindows(into rep: NSBitmapImageRep) {
    guard let w = window, let children = w.childWindows?.filter(\.isVisible), !children.isEmpty,
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return }
    // The context draws in the picture's points (its `size`), whatever its pixels.
    let scale = rep.size.width / w.frame.width
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    for c in children {
      guard let v = c.contentView, let cr = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
      v.cacheDisplay(in: v.bounds, to: cr)
      let r = NSRect(x: (c.frame.minX - w.frame.minX) * scale, y: (c.frame.minY - w.frame.minY) * scale, width: c.frame.width * scale, height: c.frame.height * scale)
      cr.draw(in: r, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: false, hints: nil)
    }
    NSGraphicsContext.restoreGraphicsState()
  }

  // MARK: observability

  struct ViewDump: Codable {
    struct Node: Codable {
      var cls: String; var frame: [Double]; var hidden: Bool; var alpha: Double; var layer: Bool; var tag: Int?
      var scroll: Scroll?; var text: String?; var safeArea: [Double]?; var children: [Node]
    }
    struct Scroll: Codable { var documentSize: [Double]; var clipBounds: [Double]; var contentInsets: [Double]; var autoInsets: Bool; var horizontal: Bool; var vertical: Bool }
    struct Model: Codable {
      var link: String; var decks: [String]; var openProject: String?; var openRun: String?; var columns: [String]; var reelPosition: String?; var across: Int
      var onScreen: [String]; var warm: [String]; var focused: String?; var follow: Bool; var asking: [String]
    }
    var schema = "deskbench.dump/1"
    var at: String
    var window: WindowState?
    var contentLayoutRect: [Double]
    var model: Model
    var scrollViews: [Node]
    var bodies: [String: Int]
    var tree: Node
  }

  func dump() -> ViewDump {
    func rect(_ r: CGRect) -> [Double] { [r.origin.x, r.origin.y, r.width, r.height].map { Stats.round($0, 1) } }
    func node(_ v: NSView, depth: Int) -> ViewDump.Node {
      var n = ViewDump.Node(cls: String(describing: type(of: v)), frame: rect(v.convert(v.bounds, to: nil)), hidden: v.isHidden, alpha: Stats.round(v.alphaValue, 2), layer: v.layer != nil,
                            tag: v.tag == -1 ? nil : v.tag, scroll: nil, text: nil, safeArea: nil, children: [])
      if let s = v as? NSScrollView {
        let i = s.contentInsets
        n.scroll = .init(documentSize: [s.documentView?.frame.width ?? 0, s.documentView?.frame.height ?? 0].map { Stats.round($0, 1) }, clipBounds: rect(s.contentView.bounds),
                         contentInsets: [i.top, i.left, i.bottom, i.right], autoInsets: s.automaticallyAdjustsContentInsets,
                         horizontal: (s.documentView?.frame.width ?? 0) > s.contentView.bounds.width + 0.5, vertical: (s.documentView?.frame.height ?? 0) > s.contentView.bounds.height + 0.5)
      }
      if let t = v as? NSTextField { n.text = t.stringValue.isEmpty ? t.placeholderString.map { "placeholder: " + $0 } : String(t.stringValue.prefix(80)) }
      if v is NSHostingView<DeskWindowContent> || String(describing: type(of: v)).contains("Hosting") { let s = v.safeAreaInsets; n.safeArea = [s.top, s.left, s.bottom, s.right] }
      if depth < 40 { n.children = v.subviews.map { node($0, depth: depth + 1) } }
      return n
    }
    let root = window.contentView!.superview ?? window.contentView!
    let tree = node(root, depth: 0)
    var scrolls: [ViewDump.Node] = []
    func collect(_ n: ViewDump.Node) { if n.scroll != nil { var c = n; c.children = []; scrolls.append(c) }; n.children.forEach(collect) }
    collect(tree)
    let warm = model.columns.filter { model.agent($0)?.warm == true }
    let asking = model.columns.filter { model.agent($0)?.approval != nil }
    let m = ViewDump.Model(link: "\(model.link)", decks: model.decks.map(\.id), openProject: model.openProjectId, openRun: model.openRunId, columns: model.columns,
                           reelPosition: model.reelPosition, across: model.across, onScreen: model.columns.filter(model.onScreen.contains), warm: warm,
                           focused: model.focusedAgent, follow: model.follow, asking: asking)
    return ViewDump(at: ISO8601DateFormatter().string(from: Date()), window: windowState(), contentLayoutRect: rect(window.contentLayoutRect), model: m, scrollViews: scrolls,
                    bodies: count(bodies), tree: tree)
  }

  /// window.png and window.json into `dir` (prefixed with `name`): the window drawn by itself (no screen recording
  /// permission needed) and its view tree. Returns the paths written.
  func snapshot(into dir: URL, name: String) -> [String] {
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    var out: [String] = []
    let frame = window.contentView!.superview ?? window.contentView!
    if let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) {
      frame.cacheDisplay(in: frame.bounds, to: rep)
      drawChildWindows(into: rep)
      let png = dir.appendingPathComponent("\(name).png")
      if (try? rep.representation(using: .png, properties: [:])?.write(to: png)) != nil { out.append(png.path) }
    }
    let json = dir.appendingPathComponent("\(name).json")
    if (try? JSONOut.encode(dump()).write(to: json, atomically: true, encoding: .utf8)) != nil { out.append(json.path) }
    return out
  }
}
