import AppKit
import SwiftUI
import QuartzCore
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopProbe

/// One rep's desktop window: the fixture loaded into a store, the app's own model and window content (CapcomdDesk), and
/// PerfLoopHost's `Run` around it (the window, the clock, the steps, the guards). Made fresh for every rep, so every rep
/// starts from the same state, as perfloop's runner measures (one rep per process). The window is the bench app's
/// `Window` scene (BenchApp.swift: the app's commands, so its shortcuts go through the real menu bar), adopted by the
/// rep and showing this rep's desk (`DeskStage`).
///
/// The views report their bodies and the reel its phases to `DeskProbe`; the desk forwards both to PerfLoopProbe's
/// `Probe` (what the rep records: bodies per step and stretch, causes) and keeps its own log with times on the rep's
/// clock, for the checks that ask which views ran between two moments (isolation) and for the `built-within` guard.
@MainActor final class Desk: DeskProbeSink {
  let run: HostRun
  let world: World
  let store: CapcomdStore
  let model: DeskModel
  let thread: FixtureThread
  /// The Team fixture's daemon (its profile routes), on the `team` fixture only.
  let teamDaemon: TeamFixtureDaemon?
  var bodies: [(t: Double, view: String, id: String?)] = []
  var events: [(t: Double, name: String, value: Int)] = []
  /// Sequence numbers for events the scenarios make up (asks, decisions): never reused, the store drops duplicate ids.
  var liveSeq = 900_000
  /// When the open project's columns were last made anew (a project switch, a fresh window): `built-within` counts a
  /// column's bodies from here.
  var columnsSince = 0.0
  func nextSeq() -> Int { liveSeq += 1; return liveSeq }

  /// The rep's desk on the fixture `run` was given (`--fixture`: a listed name, `NAME@k=v`, or `file:PATH`).
  init(_ run: HostRun) throws {
    self.run = run
    guard let w = Desk.world(run.fixture.name) else { throw DeskError(Fixtures.problem(run.fixture.name) ?? "unknown fixture '\(run.fixture.name)'") }
    world = w
    thread = FixtureThread(w)
    // The Team fixture's store has a daemon with the profile routes (and only that one: every other fixture has none).
    teamDaemon = w.spec.team == true ? TeamFixtureDaemon() : nil
    store = CapcomdStore(daemonInfo: teamDaemon, thread: thread, clientId: "deskbench")
    w.load(into: store)
    model = DeskModel(store: store)
    DeskProbe.sink = self
    Desk.current = self
    run.atClose { DeskProbe.sink = nil; Desk.current = nil }
  }

  /// The rep's desk, until its window closes (after the guards have judged it).
  static var current: Desk?

  /// Generated worlds are made once per process (the generator is seeded: same name, same bytes); each rep loads its
  /// own copy into a fresh store.
  static var worlds: [String: World] = [:]
  static func world(_ name: String) -> World? {
    if let w = worlds[name] { return w }
    let w = Fixtures.make(name)
    worlds[name] = w
    return w
  }

  /// Adopts the scene's window as the rep's (`run.show(window:)`: activated, at `size`, drawing and at rest), then puts
  /// this rep's desk in it and waits until it has drawn and come to rest. The desk goes in after the window is up: an
  /// app that isn't active yet holds SwiftUI's updates back.
  func show(size: CGSize? = nil) async throws {
    let w = try await run.appWindow { DeskBenchApp.isScene($0) }
    try await run.show(window: w, size: size ?? Desk.size(run))
    w.contentMinSize = DeskWindowContent.minSize
    columnsSince = run.now
    DeskStage.shared.model = model
    guard await run.wait(timeoutMs: 5000, { [unowned self] in bodies.contains { $0.view == "RootView" } }) else {
      throw DeskError("the scene's window didn't show the rep's desk within 5 s")
    }
    _ = await nextCommit()
    await quiet(quietMs: 100, timeoutMs: 3000)
  }

  /// A window of its own for `open` (`run.open` makes it inside the measured step): a hosting view of the app's window
  /// content, with no sizing options (the bench sizes the window; DESKBENCH_SIZING=1 keeps NSHostingView's defaults, as
  /// the app's scene has them, to compare).
  func makeHosting() -> NSView {
    let h = NSHostingView(rootView: DeskWindowContent(model: model))
    if ProcessInfo.processInfo.environment["DESKBENCH_SIZING"] == nil { h.sizingOptions = [] }
    return h
  }

  /// `--set size=WxH` (default 1440×900, the app's default window).
  static func size(_ run: HostRun) -> CGSize {
    let p = (run.param("size") ?? "").lowercased().split(separator: "x").compactMap { Double($0) }
    return p.count == 2 ? CGSize(width: p[0], height: p[1]) : DeskWindowContent.defaultSize
  }

  var window: NSWindow { run.window! }
  var content: NSView { window.contentView! }

  // MARK: the probe

  func body(_ view: StaticString) { bodies.append((run.now, view.description, nil)); Probe.body(view) }
  func body(_ view: StaticString, id: String) { bodies.append((run.now, view.description, id)); Probe.body(view, id: id) }
  func event(_ name: StaticString, _ value: Int) { events.append((run.now, name.description, value)); Probe.event(name, value) }

  /// Bodies between two times on the rep's clock.
  func bodies(in range: ClosedRange<Double>) -> [(view: String, id: String?)] {
    bodies.filter { range.contains($0.t) }.map { ($0.view, $0.id) }
  }

  /// Bodies by view, `Column×17 CrewTab×4`, heaviest first.
  static func summary(_ bs: [(view: String, id: String?)]) -> String {
    Dictionary(grouping: bs, by: \.view).mapValues(\.count).sorted { $0.value > $1.value }.map { "\($0.key)×\($0.value)" }.joined(separator: " ")
  }

  // MARK: waiting

  /// Resolves when the Core Animation commit that follows the current run-loop turn has gone out. Returns the time.
  func nextCommit() async -> Double {
    await withCheckedContinuation { (c: CheckedContinuation<Double, Never>) in
      CATransaction.begin()
      CATransaction.setCompletionBlock { MainActor.assumeIsolated { c.resume(returning: self.run.now) } }
      CATransaction.commit()
    }
  }

  func sleep(ms: Double) async { await run.sleep(ms: ms) }

  /// The window at rest: no main-thread stretch over 2 ms for `quietMs` (the app's warming done), up to `timeoutMs`.
  @discardableResult
  func quiet(quietMs: Double = 300, timeoutMs: Double = 5000) async -> Bool { await run.settle(quietMs: quietMs, timeoutMs: timeoutMs) }

  /// The reel at its first column, not animated, at rest: the columns built and the threads warmed, so the first step
  /// starts from the same state as the others.
  func rewind() async {
    guard let first = model.columns.first else { return }
    model.scroll(to: first, animated: false)
    _ = await nextCommit()
    await quiet()
  }

  /// After `since`: the reel started moving (phase 1), then stopped. `moving` says whether it still moves (the project
  /// reel's by default). Returns when it started and when it came to rest, nil when it never did.
  func reelSettled(since: Double, timeoutMs: Double = 2500, moving: (() -> Bool)? = nil) async -> (started: Double?, settled: Double?) {
    let moving = moving ?? { self.model.reelMoving }
    let began = await run.wait(timeoutMs: 600) { self.events.contains { $0.name == "reel.phase" && $0.value == 1 && $0.t >= since } }
    guard began else { return (nil, nil) }
    let start = events.first { $0.name == "reel.phase" && $0.value == 1 && $0.t >= since }?.t
    let last = { self.events.last { $0.name == "reel.phase" } }
    let ended = await run.wait(timeoutMs: timeoutMs) { !moving() && (last()?.value ?? 1) == 0 && (last()?.t ?? 0) >= (start ?? since) }
    return (start, ended ? last()?.t : nil)
  }

  // MARK: views

  func walk(_ v: NSView, _ f: (NSView) -> Void) { f(v); v.subviews.forEach { walk($0, f) } }

  /// The project reel's horizontal NSScrollView: the reel's own, else the widest scroll view whose document is wider
  /// than it.
  func reelScrollView() -> NSScrollView? {
    if let r = reel(.project), !r.reelScrollView.isHiddenOrHasHiddenAncestor { return r.reelScrollView }
    var best: NSScrollView?
    walk(content) { v in
      if let s = v as? NSScrollView, let d = s.documentView, d.frame.width > s.bounds.width + 1, s.bounds.width > (best?.bounds.width ?? 0), !s.isHiddenOrHasHiddenAncestor { best = s }
    }
    return best
  }

  /// The reel of `kind` (the Needs you reel only while it is open).
  func reel(_ kind: ReelKind = .project) -> ReelColumnViews? {
    var r: ReelColumnViews?
    walk(content) { if r == nil, let x = $0 as? ReelColumnViews, x.reelKind == kind { r = x } }
    return r
  }

  /// The column pitch of a reel: one view per column gives it exactly; otherwise the document's width over the columns.
  func pitch(_ sv: NSScrollView, columns: Int, reel: ReelColumnViews? = nil) -> Double {
    if let r = reel, r.columnCount > 1 {
      let p = Double(r.columnFrame(at: 1).minX - r.columnFrame(at: 0).minX)
      if p > 0 { return p }
    }
    let views = sv.documentView!.subviews.map(\.frame.minX).sorted()
    if views.count == columns, views.count > 1 { return Double(views[1] - views[0]) }
    return Double(sv.documentView!.frame.width) / Double(max(1, columns))
  }

  /// How far the reel rests from a column edge, in points.
  func restOffset(_ sv: NSScrollView, pitch: Double) -> Double {
    let x = Double(sv.contentView.bounds.origin.x) + Double(sv.contentInsets.left)
    return abs(x / pitch - (x / pitch).rounded()) * pitch
  }

  /// A composer text field inside the on-screen part of the reel.
  func composerField() -> NSTextField? {
    var fields: [NSTextField] = []
    walk(content) { v in
      if let f = v as? NSTextField, (f.placeholderString ?? "").hasPrefix("Tell "), f.isEditable, content.bounds.intersects(f.convert(f.bounds, to: nil)) { fields.append(f) }
    }
    return fields.sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }.first { $0.convert($0.bounds, to: nil).minX >= 0 }
  }

  /// The pane views that show (not hidden), left to right, top to bottom.
  struct PaneSeen { let view: NSView; let agent: String; let id: Int; let focused: Bool; let expanded: Bool; let frame: CGRect }
  func panesShown() -> [PaneSeen] {
    var out: [PaneSeen] = []
    walk(content) { v in
      if let p = v as? DeskPaneProbe, p.isPane, !v.isHiddenOrHasHiddenAncestor {
        out.append(PaneSeen(view: v, agent: p.shownAgent, id: p.paneId, focused: p.paneFocused, expanded: p.paneExpanded, frame: v.convert(v.bounds, to: nil).integral))
      }
    }
    return out.sorted { ($0.frame.minX, -$0.frame.maxY) < ($1.frame.minX, -$1.frame.maxY) }
  }

  /// The opened pane (with splits: the focused one) and the agent it shows, if one shows.
  func paneView() -> (view: NSView, agent: String)? {
    var found: (NSView, String)?
    walk(content) { v in
      if let p = v as? DeskPaneProbe, p.isPane, !v.isHiddenOrHasHiddenAncestor, found == nil || p.paneFocused { found = (v, p.shownAgent) }
    }
    return found
  }

  /// A pane's thread: the tallest vertical scroll view inside it.
  func threadScroll(in v: NSView) -> NSScrollView? {
    var best: NSScrollView?
    walk(v) { s in
      guard let sv = s as? NSScrollView, let d = sv.documentView, sv.bounds.height > 100 else { return }
      if best == nil || d.frame.height > best!.documentView!.frame.height { best = sv }
    }
    return best
  }

  /// The sidebar's list: the vertical scroll view in the window's left 248 pt.
  func sidebarScrollView(scrollable: Bool = true) -> NSScrollView? {
    var best: NSScrollView?
    walk(content) { v in
      guard let s = v as? NSScrollView, let d = s.documentView, !scrollable || d.frame.height > s.bounds.height, !s.isHiddenOrHasHiddenAncestor else { return }
      let r = s.convert(s.bounds, to: nil)
      if r.minX < 20, r.maxX <= 250, r.width > 150 { best = s }
    }
    return best
  }

  // MARK: ink regions (the main view of each scenario; PerfLoopHost's ink guard and the snapshots' regions)

  /// The project reel: its columns' scroll view.
  var reelRegion: InkRegion { .find("reel") { [unowned self] in reelScrollView() } }
  /// The Needs you reel, while it is open (`min`: its floor, for a reel left with one line, "Nothing needs you.").
  var needsRegion: InkRegion { needsRegion() }
  func needsRegion(min: Double? = nil) -> InkRegion { .find("needs-reel", min: min) { [unowned self] in reel(.needs)?.reelScrollView } }
  /// The opened window's sidebar list, and the pane's thread.
  var sidebarRegion: InkRegion { .find("sidebar") { [unowned self] in sidebarScrollView(scrollable: false) } }
  /// A thread rests at a different offset run to run (after a switch, a split), so snapshots compare its viewport by how
  /// much of it is drawn: the candidate keeps at least a fifth of the champion's ink (PerfLoop's default is half).
  var paneRegion: InkRegion { .find("pane") { [unowned self] in paneView().flatMap { threadScroll(in: $0.view) } }.comparedByInk(atLeast: Desk.threadInk) }
  static let threadInk = 0.2
  /// Waits (up to 3 s, between steps) until every pane on screen whose agent has a thread has rendered a row of it
  /// (a `PaneEntryRow` body for that agent): a pane just switched to an agent whose thread hasn't been read yet is
  /// blank until its first page lands, which the ink guard would read as a blank pane. A wait over 300 ms is noted.
  @discardableResult
  func threadsDrawn(_ label: String) async -> Double {
    let t = run.now
    let ok = await run.wait(timeoutMs: 3000) { [unowned self] in
      panesShown().allSatisfy { p in (world.threads[p.agent] ?? []).isEmpty || bodies.contains { $0.view == "PaneEntryRow" && $0.id == p.agent } }
    }
    _ = await nextCommit()
    let waited = run.now - t
    if waited > 300 || !ok { run.note("\(label): the panes' threads had rows \(ok ? "after \(Int(waited)) ms" : "not within 3 s")") }
    return waited
  }

  /// Each pane's thread, by its place (pane-1 the first, left to right, top to bottom).
  func paneRegions(_ n: Int) -> [InkRegion] {
    (0..<n).map { i in
      InkRegion.find("pane-\(i + 1)") { [unowned self] in let p = panesShown(); return p.indices.contains(i) ? threadScroll(in: p[i].view) : nil }.comparedByInk(atLeast: Desk.threadInk)
    }
  }
}

/// PerfLoopHost's `Run` (CapcomdStore has a `Run` of its own: a capcomd run).
typealias HostRun = PerfLoopHost.Run

struct DeskError: Error, CustomStringConvertible {
  var description: String
  init(_ s: String) { description = s }
}

/// A check, named as the manifest's scenarios list them; recorded with `run.check` when the scenario ends.
struct Check {
  var name: String, pass: Bool, detail: String
  init(_ name: String, _ pass: Bool, _ detail: String) { self.name = name; self.pass = pass; self.detail = detail }
}

extension HostRun {
  /// Records the scenario's checks, in the order the driver made them.
  func record(_ checks: [Check]) { for c in checks { check(c.name, c.pass, c.detail) } }
}

extension CGRect { var center: CGPoint { CGPoint(x: midX, y: midY) } }
extension String { func ifEmpty(_ s: String) -> String { isEmpty ? s : self } }
