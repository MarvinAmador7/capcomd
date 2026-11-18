import AppKit
import SwiftUI
import PerfLoopProbe
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// The folding rail and the Rex-style sidebar (design/desktop/rex): fold/open, selecting rows with real clicks and keys
/// (PerfLoopHost's `run.click` and `run.key`, on the app's own event queue), a thread item arriving while it is open,
/// and a long sidebar scrolled. Each leaves the window folded, as it found it, except where the snapshot wants it open.
/// The sidebar's list and the pane's thread are ink regions: a blank sidebar or pane fails instead of passing as fast.
@MainActor enum DriveSidebar {
  /// Views that belong to the sidebar and the rail.
  static let sidebarViews: Set<String> = ["Sidebar", "SidebarList", "SectionHeading", "ProjectLabel", "AgentRow", "Rail"]
  /// Views of the reel (kept under the opened window): a toggle must not re-render them.
  static let reelViews: Set<String> = ["Reel", "Column", "ColumnHead", "ColumnThread", "EntryRow", "CrewTab", "OpenGroup"]
  static let paneViews: Set<String> = ["PaneHead", "PaneArea", "Pane", "PaneThread", "PaneEntryRow", "PaneComposer"]

  static func openSidebar(_ d: Desk) async {
    if !d.model.nav.sidebarOpen { d.model.setSidebar(open: true) }
    _ = await d.run.wait(timeoutMs: 2000) { d.paneView() != nil }
    await d.quiet(timeoutMs: 3000)
  }
  static func foldSidebar(_ d: Desk) async {
    if d.model.nav.sidebarOpen { d.model.setSidebar(open: false) }
    _ = await d.run.wait(timeoutMs: 2000) { d.paneView() == nil }
    await d.quiet(quietMs: 150, timeoutMs: 2000)
  }

  static func reelFrameInWindow(_ d: Desk) -> CGRect? {
    guard let sv = d.reelScrollView() else { return nil }
    return sv.convert(sv.bounds, to: nil).integral
  }

  // MARK: sidebar-toggle

  /// Opens and folds the sidebar `toggles` times, as ⌃⌘S does (its menu item's action; `animated=1`: as the button
  /// does, a 0.25 s spring). Latency: the toggle to the first frame after the pane is in (or out of) the window.
  static func sidebarToggle(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    await foldSidebar(d)
    let reelFrame = reelFrameInWindow(d)
    var reelBodies = 0, opensShown = true, foldsShown = true, paneRight = true
    var failures: [String] = []
    let animated = run.param("animated") == "1"
    for i in 0..<run.int("toggles", 8) {
      let opening = i % 2 == 0
      let t = run.now
      await run.step("toggle#\(i) \(opening ? "open" : "fold")", until: { opening ? d.paneView() != nil : d.paneView() == nil },
                     ink: opening ? [d.sidebarRegion, d.paneRegion] : [d.reelRegion]) {
        if animated { withAnimation(.spring(duration: 0.25, bounce: 0)) { d.model.setSidebar(open: opening) } } else { d.model.setSidebar(open: opening) }
      }
      reelBodies += d.bodies(in: t...run.now).filter { reelViews.contains($0.view) }.count
      if opening {
        let pane = d.paneView()
        let shownNow = pane != nil && d.model.nav.sidebarOpen
        let rightNow = pane?.agent == d.model.paneAgent && d.model.paneAgent != nil
        if !shownNow || !rightNow { failures.append("toggle#\(i): open \(d.model.nav.sidebarOpen), pane \(pane?.agent ?? "none"), model \(d.model.paneAgent ?? "none")") }
        opensShown = opensShown && shownNow
        paneRight = paneRight && rightNow
      } else {
        foldsShown = foldsShown && d.paneView() == nil && !d.model.nav.sidebarOpen
      }
    }
    await foldSidebar(d)
    let reelAfter = reelFrameInWindow(d)
    run.regions([d.reelRegion])
    run.record([
      Check("opened", opensShown, failures.joined(separator: "; ").ifEmpty("every open showed the sidebar and the pane")),
      Check("pane-agent", paneRight, failures.joined(separator: "; ").ifEmpty("the pane showed the model's pane agent every time")),
      Check("folded", foldsShown, "every fold removed the sidebar and the pane"),
      Check("reel-untouched", reelBodies == 0 && reelFrame == reelAfter, "reel bodies during toggles: \(reelBodies); reel frame \(reelFrame.map { "\($0)" } ?? "-") → \(reelAfter.map { "\($0)" } ?? "-")"),
    ])
  }

  // MARK: sidebar-select

  /// With the sidebar open: rows clicked (`run.click`, a mouse-down and -up on the app's queue at the row), then ↓ ↓ and
  /// Return (`run.key`) with the list holding the keyboard. Each pick must show that agent in the pane.
  static func sidebarSelect(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    await openSidebar(d)
    var clicked = true, keyed = true
    var notes: [String] = []
    // Mouse: rows in view, spread over the list. A pick can fold or unfold projects (the selected one never folds), so
    // the rows are laid out again before each click.
    let picks = run.int("clicks", 6)
    var clickedCount = 0
    for i in 0..<picks {
      let targets = rowTargets(d)
      guard !targets.isEmpty else { break }
      let t = targets[(i * max(1, targets.count / picks)) % targets.count]
      clickedCount += 1
      let p = CGPoint(x: 120, y: d.content.bounds.height - t.y)   // AppKit's window coordinates: from the bottom
      await run.click(at: p, name: "click#\(i) \(t.row.title)", until: { d.paneView()?.agent == t.row.id })
      await d.threadsDrawn()
      await run.ink([d.sidebarRegion, d.paneRegion], after: "click#\(i)")
      let ok = d.model.paneAgent == t.row.id && d.paneView()?.agent == t.row.id
      if !ok { notes.append("click on \(t.row.title) at y \(Int(t.y)): pane shows \(d.model.paneAgent ?? "-")") }
      clicked = clicked && ok
    }
    // Keyboard: the list takes the keyboard (as opening the sidebar gives it), ↓ ↓ then Return.
    await foldSidebar(d)
    await openSidebar(d)
    for i in 0..<run.int("keys", 4) {
      let before = d.model.nav.cursor
      for k in 0..<2 {
        let was = d.model.nav.cursor
        await run.key(.down, name: "key#\(i) down#\(k)", until: { d.model.nav.cursor != was })
      }
      let cursor = d.model.nav.cursor
      var want: String?
      if case .agent(let id)? = cursor { want = id }
      await run.key(.return, name: "key#\(i) return", until: { want == nil || d.paneView()?.agent == want })
      await d.threadsDrawn()
      await run.ink([d.paneRegion], after: "key#\(i) return")
      var ok = cursor != nil && cursor != before
      if let id = want { ok = ok && d.model.paneAgent == id && d.paneView()?.agent == id }
      if !ok { notes.append("keys: cursor \(before.map { "\($0)" } ?? "-") → \(cursor.map { "\($0)" } ?? "-"), pane \(d.model.paneAgent ?? "-")") }
      keyed = keyed && ok
    }
    // Ends open, for the snapshot: the sidebar and the pane are its regions.
    run.regions([d.sidebarRegion, d.paneRegion])
    run.record([
      Check("clicked", clicked && clickedCount > 0, notes.filter { $0.hasPrefix("click") }.joined(separator: "; ").ifEmpty("every clicked row showed in the pane (\(clickedCount) clicks)")),
      Check("keyboard", keyed, notes.filter { $0.hasPrefix("keys") }.joined(separator: "; ").ifEmpty("↓ ↓ Return showed the cursor's agent every time")),
    ])
  }

  // MARK: sidebar-burst

  /// With the sidebar open, thread items for the pane's agent and for another agent of the open project at
  /// `itemsPerSecond`: the sidebar must not render (nor its slice be assigned), the pane's thread must.
  static func sidebarBurst(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    await openSidebar(d)
    var w = d.world
    w.lastSeq = max(w.lastSeq, d.liveSeq)
    let runId = d.model.openRunId ?? d.world.openRunId ?? d.world.runIds[0]
    guard let pane = d.model.paneAgent, let other = d.model.columns.first(where: { $0 != pane }) else {
      return run.record([Check("agents", false, "no pane agent or no second agent"), Check("isolation-sidebar", false, "not run"), Check("delivered-pane", false, "not run")])
    }
    let rate = max(1, run.int("itemsPerSecond", 20)), secs = max(1, run.int("seconds", 3))
    let assigned = d.model.sidebar.assignments
    var start = 0.0, end = 0.0, sent = 0
    await run.work("sidebar-burst \(rate)/s", ink: [d.sidebarRegion, d.paneRegion]) {
      start = run.now
      while sent < rate * secs {
        let target = sent % 2 == 0 ? pane : other
        let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1) while the sidebar is open.")
        let f = Fixtures.liveFrame(runId: runId, item: item)
        d.store.receive(.event(f.envelope), scope: f.scope)
        sent += 1
        await run.sleep(ms: 1000 / Double(rate))
      }
      _ = await d.nextCommit()
      end = run.now
    }
    let bs = d.bodies(in: start...end)
    let side = bs.filter { sidebarViews.contains($0.view) }
    let own = bs.filter { ($0.view == "PaneThread" || $0.view == "PaneEntryRow") && $0.id == pane }.count
    d.liveSeq = max(d.liveSeq, w.lastSeq)
    let assignments = d.model.sidebar.assignments - assigned
    run.regions([d.sidebarRegion, d.paneRegion])
    run.record([
      Check("agents", true, "pane \(pane), other \(other)"),
      Check("isolation-sidebar", side.isEmpty && assignments == 0, "sidebar bodies: \(side.isEmpty ? "none" : Desk.summary(side)); sidebar slice assigned \(assignments) times"),
      Check("delivered-pane", own >= sent / 2, "the pane's thread evaluated \(own) bodies for \(sent / 2) items"),
    ])
  }

  // MARK: sidebar-scroll

  /// A long sidebar (every project unfolded by hand), scrolled down and back up with replayed trackpad gestures
  /// (`gesture`, default synthetic:scroll-down, and `gestureBack`, synthetic:scroll-up; or recordings) into the
  /// sidebar's own scroll view. Scrolling moves the sidebar's clip view: no pane body.
  static func sidebarScroll(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    await openSidebar(d)
    let names = ["sidebar-scroll-view", "long-sidebar", "gesture", "scrolled", "isolation-pane"]
    func fail(_ name: String, _ why: String) { run.record(names.map { Check($0, false, $0 == name ? why : "not run: \(why)") }) }
    for deck in d.model.decks { d.model.setProjectFolded(deck.id, false) }
    d.model.toggleFinished()
    _ = await d.nextCommit()
    await d.quiet(timeoutMs: 3000)
    guard let sv = d.sidebarScrollView() else { return fail("sidebar-scroll-view", "no vertical scroll view in the sidebar") }
    let docH = sv.documentView?.frame.height ?? 0
    guard docH > sv.contentView.bounds.height + 40 else {
      return fail("long-sidebar", "the sidebar fits (document \(Int(docH)) pt, view \(Int(sv.contentView.bounds.height)) pt): use a larger fixture")
    }
    let down: ReplayGesture, up: ReplayGesture
    do {
      down = try SyntheticGestures.load(run.param("gesture") ?? "synthetic:scroll-down")
      up = try SyntheticGestures.load(run.param("gestureBack") ?? "synthetic:scroll-up")
    } catch { return fail("gesture", "\(error)") }
    var moved = true, faithful = true
    var paneBodies: [(view: String, id: String?)] = []
    for i in 0..<run.int("scrolls", 4) {
      let downward = i % 2 == 0   // down, then back up
      let y0 = sv.contentView.bounds.origin.y
      let t = run.now
      let r = await run.swipe(downward ? down : up, in: sv, name: "sidebar-scroll#\(i) \(downward ? "↓" : "↑")")
      faithful = faithful && !r.notes.contains { $0.hasPrefix("replay not faithful") }
      let y1 = sv.contentView.bounds.origin.y
      moved = moved && (downward ? y1 > y0 : y1 < y0)   // forward (scroll-down) grows the flipped offset
      paneBodies += d.bodies(in: t...run.now).filter { paneViews.contains($0.view) }
    }
    await run.ink([d.sidebarRegion], after: "scrolls")
    run.regions([d.sidebarRegion, d.paneRegion])
    run.record([Check("sidebar-scroll-view", true, "the sidebar's scroll view"), Check("long-sidebar", true, "document \(Int(docH)) pt")]
               + (faithful ? [Check("gesture", true, "every event replayed as recorded")] : [])
               + [Check("scrolled", moved, "every gesture moved the sidebar's scroll view the way it went (document \(Int(docH)) pt)"),
                  Check("isolation-pane", paneBodies.isEmpty, "pane bodies while the sidebar scrolled: \(paneBodies.isEmpty ? "none" : Desk.summary(paneBodies))")])
  }

  // MARK: helpers

  /// Where each row is now, in points from the window's top: the pinned ones under the header, the rest in the list's
  /// scroll view at its current offset (only those in view).
  static func rowTargets(_ d: Desk) -> [(row: SidebarRow, y: CGFloat)] {
    let lines = d.model.sidebarLines
    var targets: [(row: SidebarRow, y: CGFloat)] = []
    var y = SidebarMetricsView.header
    for l in lines.pinned {
      if case .row(let r, _) = l { targets.append((r, y + l.height - SidebarMetricsView.row / 2)) }
      y += l.height
    }
    if let sv = d.sidebarScrollView(scrollable: false) {
      let H = d.content.bounds.height
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
}

/// SidebarMetrics is internal to CapcomdDesk; the bench lays rows out from the same numbers.
enum SidebarMetricsView {
  static let header: CGFloat = 52, footer: CGFloat = 40, row: CGFloat = 28
}
