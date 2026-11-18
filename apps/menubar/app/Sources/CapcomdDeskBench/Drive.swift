import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit
import PerfLoopProbe

/// The reel's scenarios (DeskBenchKit/Scenarios.swift): what a user does to the desktop window, driven through the
/// model's own entry points (as the title bar calls them) and real input on the app's own event queue (PerfLoopHost:
/// `run.type`, `run.swipe`). Each measured thing is a `run.step`; each scenario's main view is an ink region, judged
/// after the steps that should leave it drawn, and a region of its snapshots.
@MainActor enum Drive {
  // MARK: open

  /// The window's content shown on a filled store; latency to the first frame with the reel in it. The window itself
  /// is up first (PerfLoopHost's clock runs on it), its content arrives in the step. Rep 0 is the cold one (fonts,
  /// Metal, SwiftUI's first graph) when one process runs several reps.
  static func open(_ run: HostRun) async throws {
    let d = try Desk(run)
    let ground = NSView()
    ground.wantsLayer = true
    try await run.show(view: ground, size: Desk.size(run), title: "capcomd (bench)")
    run.window?.contentMinSize = DeskWindowContent.minSize
    run.regions([d.reelRegion])
    let t = run.now
    d.columnsSince = t
    await run.step("open#\(run.rep)", until: { d.bodies.contains { $0.view == "Reel" } && d.reelScrollView() != nil }, ink: [d.reelRegion]) {
      d.hosting.frame = ground.bounds
      d.hosting.autoresizingMask = [.width, .height]
      ground.addSubview(d.hosting)
    }
    let cols = d.model.columns.count
    run.record([Check("columns-at-first-frame", cols > 0, "\(cols) columns in the first frame")])
  }

  // MARK: switch

  static func switchProjects(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    let decks = d.model.decks
    guard decks.count >= 2 else { return run.record([Check("two-projects", false, "the fixture has one project"), Check("switched", false, "nothing to switch to")]) }
    var ok = true
    await d.quiet()
    for i in 0..<run.int("switches", 6) {
      let target = decks[(i + 1) % 2]
      await run.step("switch#\(i)→\(target.title.prefix(18))", until: { d.model.openProjectId == target.id && !d.model.columns.isEmpty }, ink: [d.reelRegion]) {
        d.columnsSince = run.now
        d.model.open(project: target.id)
      }
      ok = ok && d.model.openProjectId == target.id && !d.model.columns.isEmpty
    }
    run.record([Check("two-projects", true, "\(decks.count) projects"), Check("switched", ok, "the open project and its columns changed on every switch")])
  }

  // MARK: scrolls

  /// Until the reel has moved (from `since`) and come to rest, or 600 ms passed with no move.
  static func reelCycle(_ d: Desk, since: @escaping () -> Double, moving: (() -> Bool)? = nil) -> () -> Bool {
    let moving = moving ?? { d.model.reelMoving }
    return {
      let t = since()
      guard let start = d.events.first(where: { $0.name == "reel.phase" && $0.value == 1 && $0.t >= t }) else { return d.run.now - t > 600 }
      let last = d.events.last { $0.name == "reel.phase" }
      return !moving() && last?.value == 0 && (last?.t ?? 0) >= start.t
    }
  }

  static func step(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    let cols = d.model.columns
    var landed = true, dir = 1, still: [String] = []
    for i in 0..<run.int("steps", 8) {
      let at = d.model.reelPosition.flatMap { cols.firstIndex(of: $0) } ?? 0
      if at + d.model.across >= cols.count { dir = -1 } else if at == 0 { dir = 1 }
      let target = dir > 0 ? min(cols.count - 1, at + d.model.across) : max(0, at - d.model.across)
      var t = 0.0
      await run.step("step#\(i) \(at)→\(target)", until: reelCycle(d, since: { t }), ink: [d.reelRegion]) { t = run.now; d.model.scroll(to: cols[target]) }
      if !d.events.contains(where: { $0.name == "reel.phase" && $0.value == 1 && $0.t >= t }) { still.append("step#\(i)") }
      landed = landed && d.model.onScreen.contains(cols[target])
    }
    if !still.isEmpty { run.note("the reel never reported moving in \(still.joined(separator: ", "))") }
    run.record([Check("landed", landed, "every step ended with the target column on screen")])
  }

  static func jump(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    let cols = d.model.columns
    guard cols.count > d.model.across else { return run.record([Check("enough-columns", false, "the fixture fits on one screen; nothing to jump"), Check("landed", false, "no jump")]) }
    var landed = true
    for i in 0..<run.int("jumps", 6) {
      let target = i % 2 == 0 ? cols.count - 1 : 0
      var t = 0.0
      await run.step("jump#\(i)→\(target)", until: reelCycle(d, since: { t }), ink: [d.reelRegion]) { t = run.now; d.model.scroll(to: cols[target]) }
      landed = landed && d.model.onScreen.contains(cols[target])
    }
    run.record([Check("enough-columns", true, "\(cols.count) columns, \(d.model.across) across"), Check("landed", landed, "every jump ended with the target column on screen")])
  }

  /// A synthetic swipe with momentum (`fling`'s curve: 6 frames to `velocity` pt/s, momentum −4 %/frame), every event
  /// stamped 0 as the old fling sent them (AppKit can't read a release velocity then), replayed into the reel's scroll
  /// view by PerfLoopHost's gesture replay. `swipe` is the faithful one.
  static func fling(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    guard let sv = d.reelScrollView() else { return run.record([Check("reel-scroll-view", false, "no horizontal NSScrollView found under the window"), Check("snapped", false, "no reel")]) }
    let v = Double(run.int("velocity", 2400))
    let forward = SyntheticGestures.flick(name: "fling-forward", axis: .x, sign: -1, velocity: v), back = SyntheticGestures.flick(name: "fling-back", axis: .x, sign: 1, velocity: v)
    let pitch = d.pitch(sv, columns: d.model.columns.count, reel: d.reel())
    var snapped = true, offs: [Double] = []
    for i in 0..<run.int("flings", 6) {
      await run.swipe(i % 2 == 0 ? forward : back, in: sv, name: "fling#\(i) \(i % 2 == 0 ? "→" : "←")", timestamps: false)
      await d.quiet(quietMs: 150, timeoutMs: 2000)
      let off = d.restOffset(sv, pitch: pitch)
      offs.append(Stats.round(off, 1)); snapped = snapped && off < 2
    }
    await run.ink([d.reelRegion], after: "flings")
    run.record([Check("reel-scroll-view", true, "the reel's scroll view"), Check("snapped", snapped, "the reel rested on a column edge after every fling (off by \(offs) pt)")])
  }

  /// A recorded gesture (or a synthetic one) replayed into a reel's scroll view at its recorded times, `swipes` times
  /// from the same column (`from`; the middle by default). `needs`: the Needs you reel (open) instead of the project's.
  static func swipe(_ run: HostRun, d: Desk? = nil, needs: Bool = false) async throws {
    let d = try d ?? Desk(run)
    if run.window == nil { try await d.show() }
    run.regions([needs ? d.needsRegion : d.reelRegion])
    if !needs { await d.rewind() }
    let checks = ["reel-scroll-view", "gesture", "snapped"]
    func fail(_ name: String, _ why: String) { run.record(checks.map { Check($0, false, $0 == name ? why : "not run: \(why)") }) }
    guard let sv = needs ? d.reel(.needs)?.reelScrollView : d.reelScrollView() else { return fail("reel-scroll-view", "no horizontal NSScrollView found under the window") }
    var gestures: [ReplayGesture] = []
    for s in (run.param("gesture") ?? "synthetic:flick-forward").split(separator: ",").map({ String($0).trimmingCharacters(in: .whitespaces) }) {
      do { gestures.append(try SyntheticGestures.load(s)) } catch { return fail("gesture", "\(error)") }
    }
    let stamps = run.param("timestamps") ?? "recorded"
    guard stamps == "recorded" || stamps == "zero" else { return fail("gesture", "timestamps=\(stamps): one of recorded, zero") }
    AppKitScrollTrace.installIfAsked()
    let cols = needs ? d.model.needs.columns : d.model.columns
    let across = needs ? d.model.needs.across : d.model.across
    let from = run.param("from").flatMap(Int.init) ?? max(0, (cols.count - across) / 2)
    guard cols.indices.contains(from) else { return fail("gesture", "from=\(from): the fixture has \(cols.count) columns") }
    let pitch = d.pitch(sv, columns: cols.count, reel: needs ? d.reel(.needs) : d.reel())
    var snapped = true, offs: [Double] = []
    var faithful = true
    for i in 0..<run.int("swipes", 4) {
      let g = gestures[i % gestures.count]
      // From the same column every time, at rest: the gesture has room on both sides, away from the rubber band.
      if needs { d.model.needs.lead(cols[from]) } else { d.model.scroll(to: cols[from], animated: false) }
      _ = await d.nextCommit()
      await d.quiet(quietMs: 150, timeoutMs: 3000)
      let r = await run.swipe(g, in: sv, name: "swipe#\(i) \(g.name)", timestamps: stamps == "recorded")
      faithful = faithful && !r.notes.contains { $0.hasPrefix("replay not faithful") }
      await d.quiet(quietMs: 150, timeoutMs: 2000)
      let off = d.restOffset(sv, pitch: pitch)
      offs.append(Stats.round(off, 1)); snapped = snapped && off < 2
    }
    await run.ink([needs ? d.needsRegion : d.reelRegion], after: "swipes")
    // PerfLoopHost's replay records a failed `gesture` check itself when an event didn't go out as recorded.
    run.record([Check("reel-scroll-view", true, "the reel's scroll view"), Check("snapped", snapped, "the reel rested on a column edge after every swipe (off by \(offs) pt)")]
               + (faithful ? [Check("gesture", true, "every event replayed with its recorded phases and deltas")] : []))
  }

  // MARK: burst

  /// Items for one on-screen agent at a steady rate, standing still and then while stepping; the other columns must
  /// not evaluate a body.
  static func burst(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    var w = d.world
    w.lastSeq = max(w.lastSeq, d.liveSeq)
    let cols = d.model.columns
    let target = cols[min(1, cols.count - 1)]
    let rate = max(1, run.int("itemsPerSecond", 20)), secs = max(1, run.int("seconds", 3))
    let runId = d.world.openRunId ?? d.world.runIds[0]
    var checks: [Check] = []
    for (phase, moving) in [("still", false), ("scrolling", true)] {
      await d.rewind()
      var start = 0.0, end = 0.0, sent = 0
      await run.work("burst-\(phase) \(rate)/s", ink: [d.reelRegion]) {
        start = run.now
        var dir = 1
        var nextScroll = start + 350
        while sent < rate * secs {
          let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1): the join matches on lower(email) now; \(sent % 3 == 0 ? "**bold** at times" : "plain text otherwise").")
          let f = Fixtures.liveFrame(runId: runId, item: item)
          d.store.receive(.event(f.envelope), scope: f.scope)
          sent += 1
          if moving, run.now >= nextScroll, !d.model.reelMoving {
            let at = d.model.reelPosition.flatMap { cols.firstIndex(of: $0) } ?? 0
            if at + d.model.across >= cols.count { dir = -1 } else if at == 0 { dir = 1 }
            d.model.scroll(to: cols[dir > 0 ? min(cols.count - 1, at + 1) : max(0, at - 1)])
            nextScroll = run.now + 600
          }
          await run.sleep(ms: 1000 / Double(rate))
        }
        _ = await d.nextCommit()
        end = run.now
      }
      let bs = d.bodies(in: start...end)
      let outsideThread = bs.filter { ($0.view == "ColumnThread" || $0.view == "EntryRow") && $0.id != target }.count
      let others = bs.filter { ["Column", "ColumnHead", "CrewTab", "TitleBar", "OpenGroup", "FoldedDeck", "DecisionBar", "ColumnComposer"].contains($0.view) }
      let own = bs.filter { ($0.view == "ColumnThread" || $0.view == "EntryRow") && $0.id == target }.count
      if moving {
        // While the reel moves, Column bodies are expected only from the step itself (none in the current design).
        checks.append(Check("isolation-\(phase)", outsideThread == 0, "other columns' thread bodies during the burst: \(outsideThread); Column bodies while scrolling: \(others.filter { $0.view == "Column" }.count)"))
      } else {
        checks.append(Check("isolation-\(phase)", outsideThread == 0 && others.isEmpty, "bodies outside the target thread: \(others.isEmpty ? "none" : Desk.summary(others)), other threads: \(outsideThread)"))
      }
      checks.append(Check("delivered-\(phase)", own >= sent, "the target thread evaluated \(own) bodies for \(sent) items"))
    }
    d.liveSeq = max(d.liveSeq, w.lastSeq)
    run.record(checks)
  }

  // MARK: typing

  /// Typing into an on-screen composer, a key down and up per character on the app's event queue (`run.type`: the
  /// field editor gets them as from a keyboard). Only the composer may re-render.
  static func typing(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    guard let field = d.composerField() else {
      return run.record([Check("composer-found", false, "no composer text field on screen (an ask docks a decision bar instead)"), Check("typed", false, "no composer"), Check("isolation", false, "no composer")])
    }
    d.window.makeFirstResponder(field)
    _ = await d.nextCommit()
    await d.quiet(quietMs: 150, timeoutMs: 2000)
    let text = run.param("text") ?? "Please normalize the emails before the join and rerun the tests."
    let t = run.now
    await run.type(text, expectFocus: .unchanged, name: "typing \(text.count) keys", until: { ((d.window.firstResponder as? NSTextView)?.string ?? field.stringValue).count >= text.count })
    let typed = (d.window.firstResponder as? NSTextView)?.string ?? field.stringValue
    let outside = d.bodies(in: t...run.now).filter { $0.view != "ColumnComposer" }
    run.record([Check("composer-found", true, "a composer on screen"), Check("typed", typed.count == text.count, "the field received \(typed.count) of \(text.count) characters"),
                Check("isolation", outside.isEmpty, "bodies outside ColumnComposer while typing: \(outside.isEmpty ? "none" : Desk.summary(outside))")])
  }

  // MARK: resize

  static func resize(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    await d.rewind()
    var followed = true, got: [Int] = []
    for (w, want) in [(CGFloat(1100), 2), (720, 1), (1440, 3)] {
      await run.step("resize→\(Int(w)) (\(want) across)", until: { d.model.across == want }, ink: [d.reelRegion]) {
        let f = d.window.frame
        d.window.setFrame(NSRect(x: f.origin.x, y: f.origin.y, width: w, height: f.height), display: true, animate: false)
      }
      got.append(d.model.across)
      followed = followed && d.model.across == want
    }
    run.record([Check("columns-follow-width", followed, "\(got) columns across for 1100, 720, 1440 pt (want 2, 1, 3)")])
  }

  // MARK: follow

  /// An ask for a far-off agent with Follow on: the reel must go there. Latency: the ask to the first frame after the
  /// reel started moving.
  static func follow(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    run.regions([d.reelRegion])
    let cols = d.model.columns
    guard cols.count > d.model.across + 1 else { return run.record([Check("enough-columns", false, "every column is already on screen"), Check("landed", false, "nothing to follow")]) }
    d.model.follow = true
    let runId = d.world.openRunId ?? d.world.runIds[0]
    let candidates = cols.suffix(from: d.model.across + 1).filter { d.model.agent($0)?.approval == nil }
    var landed = true
    for i in 0..<run.int("asks", 4) {
      await d.rewind()
      let who = candidates[(candidates.count - 1 - i) % max(1, candidates.count)]
      let seq = d.nextSeq()
      var t = 0.0
      await run.step("follow#\(i)→\(cols.firstIndex(of: who) ?? -1)", until: { d.events.contains { $0.name == "reel.phase" && $0.value == 1 && $0.t >= t } }, ink: [d.reelRegion]) {
        t = run.now
        let f = Fixtures.askFrame(runId: runId, agentId: who, approvalId: "bench-ask-\(seq)", seq: seq)
        d.store.receive(.event(f.envelope), scope: f.scope)
      }
      _ = await d.reelSettled(since: t)
      landed = landed && d.model.onScreen.contains(who)
      // Answer the ask so the next one is new.
      let dseq = d.nextSeq()
      let done = Envelope(id: "bench-dec-\(dseq)", scope: runId, seq: dseq, entity: who, type: "approval.decided", epochMs: Int(Date().timeIntervalSince1970 * 1000),
                          projectId: nil, runId: runId, agentId: who, data: ["approvalId": .string("bench-ask-\(seq)"), "status": .string("approved")])
      d.store.receive(.event(done), scope: runId)
    }
    run.record([Check("enough-columns", true, "\(cols.count) columns"), Check("landed", landed, "the reel ended on the asking column every time")])
  }
}
