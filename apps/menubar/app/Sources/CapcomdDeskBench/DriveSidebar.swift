import AppKit
import SwiftUI
import PerfLoopProbe
import CapcomdStore
import CapcomdDesk
import DeskBenchKit

/// The folding rail and the Rex-style sidebar (design/desktop/rex): fold/open, selecting rows with the mouse and the
/// keyboard, a thread item arriving while it is open, and a long sidebar scrolled. Each leaves the window folded, as it
/// found it. Their checks read the real window: the views in it, the model, and what is drawn (`ink`), so a blank or
/// broken sidebar or pane fails instead of passing as fast.
extension Drive {
  /// Views that belong to the sidebar and the rail.
  static let sidebarViews: Set<String> = ["Sidebar", "SidebarList", "SectionHeading", "ProjectLabel", "AgentRow", "Rail"]
  /// Views of the reel (kept under the opened window): a toggle must not re-render them.
  static let reelViews: Set<String> = ["Reel", "Column", "ColumnHead", "ColumnThread", "EntryRow", "CrewTab", "OpenGroup"]

  // MARK: sidebar-toggle

  /// Opens and folds the sidebar `toggles` times, as ⌃⌘S does (not animated; `animated=1`: as the button does, 0.25 s
  /// spring). Latency: the toggle to the frame that shows it.
  func sidebarToggle() async -> ([StepResult], [Check]) {
    await rewind()
    await foldSidebar()
    let reelFrame = reelFrameInWindow()
    var steps: [StepResult] = []
    var reelBodies = 0, opensShown = true, foldsShown = true, paneRight = true
    var failures: [String] = []
    var inkNotes: [String] = []
    var ink = true
    let animated = params["animated"] == "1"
    for i in 0..<int("toggles", 8) {
      let opening = i % 2 == 0
      let m = h.begin("toggle#\(i) \(opening ? "open" : "fold")")
      let t = h.now()
      if animated { withAnimation(.spring(duration: 0.25, bounce: 0)) { h.model.setSidebar(open: opening) } } else { h.model.setSidebar(open: opening) }
      let shown = await h.nextCommit()
      // The step is the toggle's work: the frame that shows it and whatever follows within 250 ms (300 more while it
      // animates). The bench's own checks (walking the window's views) run after the step closes.
      await h.sleep(ms: animated ? 550 : 250)
      let end = h.now()
      let bs = h.bodies(in: t...end)
      reelBodies += bs.filter { Self.reelViews.contains($0.view) }.count
      let reelIds = Set(bs.filter { Self.reelViews.contains($0.view) }.compactMap(\.id))
      steps.append(h.end(m, latencyMs: shown - t, notes: ["\(bs.count) bodies: " + Dictionary(grouping: bs, by: \.view).mapValues(\.count).sorted { $0.value > $1.value }.map { "\($0.key)×\($0.value)" }.joined(separator: " "),
                                                         "reel bodies' agents: \(reelIds.sorted().joined(separator: ",").ifEmpty("none"))"]))
      await h.sleep(ms: 60)   // the checks below in an awakening of their own, never in the step's last stretch
      // The structural state, once the change has landed.
      _ = await settle { opening ? paneView() != nil : paneView() == nil }
      if opening {
        let pane = paneView()
        let shownNow = pane != nil && h.model.nav.sidebarOpen
        let rightNow = pane?.agent == h.model.paneAgent && h.model.paneAgent != nil
        if !shownNow || !rightNow { failures.append("toggle#\(i): open \(h.model.nav.sidebarOpen), pane \(pane?.agent ?? "none"), model \(h.model.paneAgent ?? "none")") }
        opensShown = opensShown && shownNow
        paneRight = paneRight && rightNow
      } else {
        foldsShown = foldsShown && paneView() == nil && !h.model.nav.sidebarOpen
      }
      // What is drawn after each open, once its step is closed (the picture costs a frame or more): the sidebar and the
      // pane are kept built and only shown, so a blank one would otherwise pass.
      if opening {
        let (side, body) = inkOpened()
        inkNotes.append("drawn: sidebar \(Stats.round(side * 100, 1)) %, pane \(Stats.round(body * 100, 1)) %")
        ink = ink && side > 0.02 && body > 0.02
      }
      await h.sleep(ms: 250)
    }
    await foldSidebar()
    let reelAfter = reelFrameInWindow()
    return (steps, [
      Check("opened", opensShown, failures.joined(separator: "; ").ifEmpty("every open showed the sidebar and the pane")),
      Check("pane-agent", paneRight, failures.joined(separator: "; ").ifEmpty("the pane showed the model's pane agent every time")),
      Check("folded", foldsShown, "every fold removed the sidebar and the pane"),
      Check("reel-untouched", reelBodies == 0 && reelFrame == reelAfter, "reel bodies during toggles: \(reelBodies); reel frame \(reelFrame.map { "\($0)" } ?? "-") → \(reelAfter.map { "\($0)" } ?? "-")"),
      Check("drawn", ink, inkNotes.joined(separator: "; ")),
    ])
  }

  // MARK: sidebar-select

  /// With the sidebar open: rows clicked (a mouse-down and -up handed to the window at the row), then ↓ and Return with
  /// the list holding the keyboard. Each pick must show that agent in the pane; latency: the pick to the frame.
  func sidebarSelect() async -> ([StepResult], [Check]) {
    await rewind()
    await openSidebar()
    var steps: [StepResult] = []
    var clicked = true, keyed = true
    var notes: [String] = []
    // Mouse: rows in view, spread over the list. A pick can fold or unfold projects (the selected one never folds), so
    // the rows are laid out again before each click.
    let picks = int("clicks", 6)
    var clickedCount = 0
    for i in 0..<picks {
      let targets = rowTargets()
      guard !targets.isEmpty else { break }
      let t = targets[(i * max(1, targets.count / picks)) % targets.count]
      clickedCount += 1
      let m = h.begin("click#\(i) \(t.row.title)")
      let start = h.now()
      click(at: CGPoint(x: 120, y: t.y))
      let shown = await h.nextCommit()
      await h.sleep(ms: 250)
      let step = h.end(m, latencyMs: shown - start)
      await h.sleep(ms: 60)
      _ = await settle { paneView()?.agent == t.row.id }
      let ok = h.model.paneAgent == t.row.id && paneView()?.agent == t.row.id
      if !ok { notes.append("click on \(t.row.title) at y \(Int(t.y)): pane shows \(h.model.paneAgent ?? "-")") }
      clicked = clicked && ok
      steps.append(step)
      await h.sleep(ms: 300)
    }
    // Keyboard: the list takes the keyboard (as opening the sidebar gives it), ↓ ↓ then Return.
    h.model.setSidebar(open: false); _ = await h.nextCommit()
    h.model.setSidebar(open: true); _ = await h.nextCommit(); await h.sleep(ms: 200)
    for i in 0..<int("keys", 4) {
      let before = h.model.nav.cursor
      key(125); key(125)   // ↓ ↓
      _ = await h.nextCommit()
      let cursor = h.model.nav.cursor
      let m = h.begin("key#\(i) return")
      let start = h.now()
      key(36)   // Return
      let shown = await h.nextCommit()
      await h.sleep(ms: 250)
      let step = h.end(m, latencyMs: shown - start)
      await h.sleep(ms: 60)
      if case .agent(let id)? = cursor { _ = await settle { paneView()?.agent == id } }
      var ok = cursor != nil && cursor != before
      if case .agent(let id)? = cursor { ok = ok && h.model.paneAgent == id && paneView()?.agent == id }
      if !ok { notes.append("keys: cursor \(before.map { "\($0)" } ?? "-") → \(cursor.map { "\($0)" } ?? "-"), pane \(h.model.paneAgent ?? "-")") }
      keyed = keyed && ok
      steps.append(step)
      await h.sleep(ms: 300)
    }
    await h.sleep(ms: 60)
    let (side, body) = inkOpened()
    await foldSidebar()
    return (steps, [
      Check("clicked", clicked && clickedCount > 0, notes.filter { $0.hasPrefix("click") }.joined(separator: "; ").ifEmpty("every clicked row showed in the pane (\(clickedCount) clicks)")),
      Check("keyboard", keyed, notes.filter { $0.hasPrefix("keys") }.joined(separator: "; ").ifEmpty("↓ ↓ Return showed the cursor's agent every time")),
      Check("drawn", side > 0.02 && body > 0.02, "drawn: sidebar \(Stats.round(side * 100, 1)) %, pane \(Stats.round(body * 100, 1)) %"),
    ])
  }

  // MARK: sidebar-burst

  /// With the sidebar open, thread items for the pane's agent and for another agent of the open project at
  /// `itemsPerSecond`: the sidebar must not render (nor its slice be assigned), the pane's thread must.
  mutating func sidebarBurst() async -> ([StepResult], [Check]) {
    await rewind()
    await openSidebar()
    var w = world
    w.lastSeq = max(w.lastSeq, h.liveSeq)
    let run = h.model.openRunId ?? fixtureRunId
    guard let pane = h.model.paneAgent, let other = h.model.columns.first(where: { $0 != pane }) else {
      await foldSidebar(); return ([], [Check("agents", false, "no pane agent or no second agent")])
    }
    let rate = max(1, int("itemsPerSecond", 20)), secs = max(1, int("seconds", 3))
    let assigned = h.model.sidebar.assignments
    let m = h.begin("sidebar-burst \(rate)/s")
    let start = h.now()
    var sent = 0
    while sent < rate * secs {
      let target = sent % 2 == 0 ? pane : other
      let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1) while the sidebar is open.")
      let f = Fixtures.liveFrame(runId: run, item: item)
      h.store.receive(.event(f.envelope), scope: f.scope)
      sent += 1
      await h.sleep(ms: 1000 / Double(rate))
    }
    _ = await h.nextCommit()
    let end = h.now()
    let bs = h.bodies(in: start...end)
    let side = bs.filter { Self.sidebarViews.contains($0.view) }
    let own = bs.filter { ($0.view == "PaneThread" || $0.view == "PaneEntryRow") && $0.id == pane }.count
    let leaked = Dictionary(grouping: side, by: \.view).mapValues(\.count)
    let step = h.end(m, notes: ["\(sent) items (half to the pane's agent); pane thread bodies \(own); sidebar bodies \(side.count)"])
    h.liveSeq = max(h.liveSeq, w.lastSeq); world = w
    let assignments = h.model.sidebar.assignments - assigned
    await foldSidebar()
    return ([step], [
      Check("isolation-sidebar", side.isEmpty && assignments == 0, "sidebar bodies: \(leaked.isEmpty ? "none" : leaked.description); sidebar slice assigned \(assignments) times"),
      Check("delivered-pane", own >= sent / 2, "the pane's thread evaluated \(own) bodies for \(sent / 2) items"),
    ])
  }

  // MARK: sidebar-scroll

  /// A long sidebar (every project unfolded by hand), scrolled down and back up with replayed trackpad gestures
  /// (`gesture`, default synthetic:scroll-down, and `gestureBack`, synthetic:scroll-up; or recordings). Scrolling moves
  /// the sidebar's own clip view: no pane body.
  func sidebarScroll() async -> ([StepResult], [Check]) {
    await rewind()
    await openSidebar()
    for d in h.model.decks { h.model.setProjectFolded(d.id, false) }
    h.model.toggleFinished()
    _ = await h.nextCommit(); await h.sleep(ms: 200)
    guard let sv = sidebarScrollView() else {
      await foldSidebar(); return ([], [Check("sidebar-scroll-view", false, "no vertical scroll view in the sidebar")])
    }
    let docH = sv.documentView?.frame.height ?? 0
    guard docH > sv.contentView.bounds.height + 40 else {
      await foldSidebar(); return ([], [Check("long-sidebar", false, "the sidebar fits (document \(Int(docH)) pt, view \(Int(sv.contentView.bounds.height)) pt): use a larger fixture")])
    }
    let down: PerfLoopProbe.Gesture, up: PerfLoopProbe.Gesture
    do {
      down = try SyntheticGestures.load(params["gesture"] ?? "synthetic:scroll-down")
      up = try SyntheticGestures.load(params["gestureBack"] ?? "synthetic:scroll-up")
    } catch { await foldSidebar(); return ([], [Check("gesture", false, "\(error)")]) }
    var steps: [StepResult] = []
    var moved = true, paneQuiet = true
    var paneBodies: [String: Int] = [:]
    for i in 0..<int("scrolls", 4) {
      let sign: Double = i % 2 == 0 ? 1 : -1   // down, then back up
      let gesture = sign > 0 ? down : up
      let y0 = sv.contentView.bounds.origin.y
      let m = h.begin("sidebar-scroll#\(i) \(sign > 0 ? "↓" : "↑")")
      let start = h.now()
      let t0 = CACurrentMediaTime()
      for e in gesture.events {
        let due = t0 + e.t / 1000
        let wait = (due - CACurrentMediaTime()) * 1000
        if wait > 0.5 { await h.sleep(ms: wait) }
        // The recorded horizontal delta, as a vertical one: negative dy scrolls content up (toward the end).
        sendVertical(sv, phase: e.phase.nsPhase, momentum: e.momentum.nsPhase, dy: e.dy)
      }
      _ = await h.nextCommit()
      await h.sleep(ms: 120)
      let end = h.now()
      let y1 = sv.contentView.bounds.origin.y
      moved = moved && (sign > 0 ? y1 > y0 : y1 < y0)   // forward (scroll-down) grows the flipped offset
      let bs = h.bodies(in: start...end).filter { ["PaneHead", "PaneArea", "Pane", "PaneThread", "PaneEntryRow", "PaneComposer"].contains($0.view) }
      for b in bs { paneBodies[b.view, default: 0] += 1 }
      paneQuiet = paneQuiet && bs.isEmpty
      steps.append(h.end(m, notes: ["sidebar scrolled \(Stats.round(y0, 1)) → \(Stats.round(y1, 1)) pt", "pane bodies \(bs.count)"]))
      await h.sleep(ms: 250)
    }
    for d in h.model.decks { h.model.setProjectFolded(d.id, true) }
    h.model.toggleFinished()
    await foldSidebar()
    return (steps, [
      Check("scrolled", moved, "every gesture moved the sidebar's scroll view the way it went (document \(Int(docH)) pt)"),
      Check("isolation-pane", paneQuiet, "pane bodies while the sidebar scrolled: \(paneBodies.isEmpty ? "none" : paneBodies.description)"),
    ])
  }

  // MARK: helpers

  /// Where each row is now, in points from the window's top: the pinned ones under the header, the rest in the list's
  /// scroll view at its current offset (only those in view).
  func rowTargets() -> [(row: SidebarRow, y: CGFloat)] {
    let lines = h.model.sidebarLines
    var targets: [(row: SidebarRow, y: CGFloat)] = []
    var y = SidebarMetricsView.header
    for l in lines.pinned {
      if case .row(let r, _) = l { targets.append((r, y + l.height - SidebarMetricsView.row / 2)) }
      y += l.height
    }
    if let sv = sidebarScrollView(scrollable: false) {
      let H = h.window.contentView!.bounds.height
      let frame = sv.convert(sv.bounds, to: nil)   // window coordinates, bottom-left origin
      let top = H - frame.maxY, bottom = H - frame.minY
      var ly = top - sv.contentView.bounds.origin.y + (lines.overflow ? -8 : 0)
      for l in lines.list {
        if case .row(let r, _) = l {
          let mid = ly + l.height - SidebarMetricsView.row / 2
          if mid > top + 10, mid < bottom - 10 { targets.append((r, mid)) }
        }
        ly += l.height
      }
    }
    return targets
  }

  /// Waits up to `commits` commits for `ok`; returns whether it held.
  func settle(commits: Int = 6, _ ok: () -> Bool) async -> Bool {
    for _ in 0..<commits { if ok() { return true }; _ = await h.nextCommit() }
    return ok()
  }

  func openSidebar() async {
    if !h.model.nav.sidebarOpen { h.model.setSidebar(open: true) }
    _ = await h.nextCommit()
    await h.sleep(ms: 300)
    _ = await h.waitQuiet(timeoutMs: 3000)
  }
  func foldSidebar() async {
    if h.model.nav.sidebarOpen { h.model.setSidebar(open: false) }
    _ = await h.nextCommit()
    await h.sleep(ms: 150)
  }

  /// The opened pane's AppKit column (NativeColumnView in its pane style) and the agent it shows, if one is in the window.
  func paneView() -> (view: NSView, agent: String)? {
    var found: (NSView, String)?
    h.walk(h.window.contentView!) { v in
      if found == nil, let p = v as? DeskPaneProbe, p.isPane, !v.isHidden { found = (v, p.shownAgent) }
    }
    return found
  }

  func reelFrameInWindow() -> CGRect? {
    guard let sv = h.reelScrollView() else { return nil }
    return sv.convert(sv.bounds, to: nil).integral
  }

  /// The sidebar's list: the vertical scroll view in the window's left 248 pt.
  func sidebarScrollView(scrollable: Bool = true) -> NSScrollView? {
    var best: NSScrollView?
    h.walk(h.window.contentView!) { v in
      guard let s = v as? NSScrollView, let d = s.documentView, !scrollable || d.frame.height > s.bounds.height, !s.isHiddenOrHasHiddenAncestor else { return }
      let r = s.convert(s.bounds, to: nil)
      if r.minX < 20, r.maxX <= 250, r.width > 150 { best = s }
    }
    return best
  }

  /// A click (mouse-down and -up) handed to the window at `p`, in points from its content's top left.
  func click(at p: CGPoint) {
    let w = h.window!
    let loc = NSPoint(x: p.x, y: w.contentView!.bounds.height - p.y)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      if let e = NSEvent.mouseEvent(with: type, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                    context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
        w.sendEvent(e)
      }
    }
  }

  /// A key (by key code: 125 ↓, 126 ↑, 36 Return) handed to the window, down and up.
  func key(_ code: UInt16) {
    let chars: String = switch code { case 125: String(UnicodeScalar(NSDownArrowFunctionKey)!); case 126: String(UnicodeScalar(NSUpArrowFunctionKey)!); default: "\r" }
    let flags: NSEvent.ModifierFlags = code == 36 ? [] : [.numericPad, .function]
    for kind in [NSEvent.EventType.keyDown, .keyUp] {
      if let ev = NSEvent.keyEvent(with: kind, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: h.window.windowNumber,
                                   context: nil, characters: chars, charactersIgnoringModifiers: chars, isARepeat: false, keyCode: code) {
        h.window.sendEvent(ev)
      }
    }
  }

  func sendVertical(_ sv: NSScrollView, phase: NSEvent.Phase?, momentum: NSEvent.Phase?, dy: Double) {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(dy.rounded()), wheel2: 0, wheel3: 0) else { return }
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: dy)
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: dy)
    let sp: Int64 = switch phase { case .began?: 1; case .changed?: 2; case .ended?: 4; case .mayBegin?: 128; default: 0 }
    let mp: Int64 = switch momentum { case .began?: 1; case .changed?: 2; case .ended?: 3; default: 0 }
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: sp)
    cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: mp)
    let center = sv.convert(sv.bounds, to: nil).center
    let screenPoint = h.window.convertPoint(toScreen: center)
    cg.location = CGPoint(x: screenPoint.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screenPoint.y)
    guard let ev = NSEvent(cgEvent: cg) else { return }
    sv.scrollWheel(with: ev)
  }

  /// How much of the sidebar (below its header) and of the pane's thread is drawn: the share of pixels that differ from
  /// the window's ground (read off the window's own picture, raw bytes, against a pixel of the ground in the sidebar's
  /// footer gap). A blank sidebar or an empty pane reads near 0. Called outside the measured steps.
  func inkOpened() -> (sidebar: Double, pane: Double) {
    let frame = h.window.contentView!.superview ?? h.window.contentView!
    guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return (0, 0) }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    guard let data = rep.bitmapData, rep.bitsPerSample == 8, rep.samplesPerPixel >= 3 else { return (0, 0) }
    let scale = Double(rep.pixelsWide) / Double(frame.bounds.width)
    let H = Double(frame.bounds.height), W = Double(frame.bounds.width)
    let bpr = rep.bytesPerRow, spp = rep.samplesPerPixel
    func px(_ x: Int, _ y: Int) -> (Int, Int, Int) {
      let o = y * bpr + x * spp
      return (Int(data[o]), Int(data[o + 1]), Int(data[o + 2]))
    }
    // The ground: the sidebar's footer, between Home and History.
    let g = px(Int(130 * scale), Int((H - 20) * scale))
    func share(_ r: CGRect) -> Double {
      var hits = 0, n = 0
      let x0 = max(0, Int(r.minX * scale)), x1 = min(rep.pixelsWide, Int(r.maxX * scale))
      let y0 = max(0, Int(r.minY * scale)), y1 = min(rep.pixelsHigh, Int(r.maxY * scale))
      guard x0 < x1, y0 < y1 else { return 0 }
      for y in stride(from: y0, to: y1, by: 2) {
        for x in stride(from: x0, to: x1, by: 2) {
          let c = px(x, y)
          n += 1
          if abs(c.0 - g.0) + abs(c.1 - g.1) + abs(c.2 - g.2) > 30 { hits += 1 }
        }
      }
      return n == 0 ? 0 : Double(hits) / Double(n)
    }
    let side = share(CGRect(x: 8, y: 52, width: 232, height: max(0, H - 52 - 40)))
    let pane = share(CGRect(x: 248 + 8 + 16, y: 8 + 44, width: max(0, W - 248 - 48), height: max(0, H - 8 - 44 - 70)))
    return (side, pane)
  }
}

/// SidebarMetrics is internal to CapcomdDesk; the bench lays rows out from the same numbers.
enum SidebarMetricsView {
  static let header: CGFloat = 52, footer: CGFloat = 40, row: CGFloat = 28
}

extension String { func ifEmpty(_ s: String) -> String { isEmpty ? s : self } }

extension PerfLoopProbe.Gesture.Phase {
  var nsPhase: NSEvent.Phase? {
    switch self { case .mayBegin: .mayBegin; case .began: .began; case .changed: .changed; case .ended: .ended; case .cancelled: .cancelled; case .stationary: .stationary; case .none: nil }
  }
}
