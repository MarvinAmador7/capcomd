import AppKit
import SwiftUI
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// Splits and expand in the opened window (design/desktop/rex RexSplit, RexExpanded; SPEC §2.1): ⌘D / ⇧⌘D / ⌘W,
/// focus moving between panes, a thread item arriving in one split, ⇧⌘↩ and Esc, and switching agents while expanded.
/// The shortcuts are the app's menu items (DeskCommands, a SwiftUI `Commands`), pressed through the bench app's real menu
/// bar (`run.press`, which records the item that fired); clicks are real (`run.click`). Checks read the real window: the pane views in it (DeskPaneProbe), their frames, their thread's
/// scroll view; each pane's thread is an ink region. Each rep starts from one pane and ends with its scenario's panes
/// on screen, for the snapshot.
@MainActor enum DriveSplits {
  static let paneViews: Set<String> = ["PaneHead", "Pane", "PaneThread", "PaneEntryRow", "PaneComposer"]

  /// How far the thread is from its foot, in points (0: at the bottom).
  static func fromFoot(_ sv: NSScrollView) -> CGFloat {
    let d = sv.documentView!.frame.height, b = sv.contentView.bounds
    return sv.contentView.isFlipped ? d - b.maxY : b.minY
  }

  /// One pane, the opened window at rest, the reel at its first column: what every rep starts from.
  static func onePane(_ run: HostRun) async throws -> Desk {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    await DriveSidebar.openSidebar(d)
    if d.model.nav.expanded { d.model.collapsePane() }
    while d.model.panes.count > 1 { d.model.closePane(d.model.panes.slots.last!.id) }
    if let first = d.model.columns.first { d.model.selectRow(id: first) }
    _ = await run.wait(timeoutMs: 2000) { d.panesShown().count == 1 }
    await d.quiet(timeoutMs: 3000)
    return d
  }

  /// Splits `downs` (false: right, true: down) outside any step, and waits for the panes and rest.
  static func split(_ d: Desk, _ downs: [Bool]) async {
    let n = d.panesShown().count + downs.count
    for down in downs { d.model.split(down: down) }
    _ = await d.run.wait(timeoutMs: 2000) { d.panesShown().count == n }
    await d.quiet(timeoutMs: 3000)
  }

  /// What a step does: keys pressed through the menu bar (the item they must fire), a key no menu item has (Esc: the
  /// window's own key handling), or a call into the model where no key does it (a pick from Search's results).
  enum Act {
    case press(String, item: String)
    case key(HostRun.Key)
    case call(() -> Void)
  }

  /// One latency step: `act`, until `done` holds, to the frame after it; the panes' threads judged for ink after it.
  static func paneStep(_ d: Desk, _ name: String, panes: Int, _ act: Act, done: @escaping () -> Bool) async -> Bool {
    if !d.window.isKeyWindow { d.window.makeKeyAndOrderFront(nil); _ = await d.nextCommit() }
    switch act {
    case .press(let keys, let item): await d.run.press(keys, expect: item, name: name, timeoutMs: 3000, until: done)
    case .key(let k): await d.run.key(k, name: name, timeoutMs: 3000, until: done)
    case .call(let f): await d.run.step(name, timeoutMs: 3000, until: done) { f() }
    }
    let ok = done()
    // A pane that now shows an agent whose thread isn't read yet is blank until its first page lands: judge the ink
    // once the threads have rows (or 2 s on).
    await d.threadsDrawn(name)
    await d.run.ink(d.paneRegions(panes), after: name)
    return ok
  }

  /// The panes on screen are the model's, in its order, with the focus where the model has it.
  static func panesMatch(_ d: Desk) -> (Bool, String) {
    let seen = d.panesShown()
    let want = d.model.nav.expanded ? [d.model.panes.focusedAgent ?? ""] : d.model.panes.agents
    let ok = seen.map(\.agent) == want && seen.filter(\.focused).map(\.agent) == [d.model.panes.focusedAgent ?? "?"]
    return (ok, "shown \(seen.map { "\($0.agent)\($0.focused ? "*" : "")" }.joined(separator: ",")), model \(want.joined(separator: ",")) focused \(d.model.panes.focusedAgent ?? "-")")
  }

  // MARK: split-open

  /// ⌘D (split right), ⇧⌘D (split down), then ⌘W twice, `cycles` times; ends with one split right on screen.
  static func splitOpen(_ run: HostRun) async throws {
    let d = try await onePane(run)
    var opened = true, down = true, closed = true, nextInTree = true, notes: [String] = []
    for c in 0..<run.int("cycles", 2) {
      let base = d.model.panes.agents
      let want = d.model.nextAgentForSplit()
      var ok = await paneStep(d, "split-right#\(c)", panes: base.count + 1, .press("⌘D", item: "Split Right")) { d.panesShown().count == base.count + 1 }
      let (m1, d1) = panesMatch(d)
      opened = opened && ok && m1 && d.model.panes.columns.count == 2
      nextInTree = nextInTree && d.model.panes.focusedAgent == want
      if !(ok && m1) { notes.append("⌘D#\(c): \(d1)") }
      ok = await paneStep(d, "split-down#\(c)", panes: base.count + 2, .press("⇧⌘D", item: "Split Down")) { d.panesShown().count == base.count + 2 }
      let (m2, d2) = panesMatch(d)
      let shown = d.panesShown()
      let stacked = shown.filter { abs($0.frame.minX - (shown.last?.frame.minX ?? -1)) < 1 }.count == 2
      down = down && ok && m2 && stacked && d.model.panes.columns.last?.count == 2
      if !(ok && m2 && stacked) { notes.append("⇧⌘D#\(c): \(d2), stacked \(stacked) \(shown.map { "\($0.frame)" })") }
      for k in 0..<2 {
        let n = d.panesShown().count
        ok = await paneStep(d, "close#\(c).\(k)", panes: n - 1, .press("⌘W", item: "Fold into the Title Bar")) { d.panesShown().count == n - 1 }
        let (m3, d3) = panesMatch(d)
        closed = closed && ok && m3
        if !(ok && m3) { notes.append("⌘W#\(c).\(k): \(d3)") }
      }
    }
    // The end state for the snapshot: one split right, at rest.
    _ = await paneStep(d, "rest", panes: 2, .press("⌘D", item: "Split Right")) { d.panesShown().count == 2 }
    run.regions(d.paneRegions(2))
    run.record([
      Check("split-right", opened, notes.filter { $0.hasPrefix("⌘D") }.joined(separator: "; ").ifEmpty("⌘D added a pane beside the focused one, focused, every time")),
      Check("next-in-tree", nextInTree, "the new pane showed the next agent in tree order that no pane showed"),
      Check("split-down", down, notes.filter { $0.hasPrefix("⇧⌘D") }.joined(separator: "; ").ifEmpty("⇧⌘D stacked a pane under the focused one every time")),
      Check("closed", closed, notes.filter { $0.hasPrefix("⌘W") }.joined(separator: "; ").ifEmpty("⌘W closed the focused split; its neighbour took the focus")),
    ])
  }

  // MARK: split-focus

  /// Three panes; ⌃→ ⌃← and real clicks move the focus between them. Only the panes whose focus changed re-render
  /// their heads; no thread renders and no pane view is made.
  static func splitFocus(_ run: HostRun) async throws {
    let d = try await onePane(run)
    await split(d, [false, false])
    let views = d.panesShown().map { ObjectIdentifier($0.view) }
    var moved = true, notes: [String] = []
    var threadBodies: [(view: String, id: String?)] = []
    for (i, by) in [-1, -1, 1, 1].enumerated() {
      let want = d.model.panes.neighbour(by)?.agent
      let t = run.now
      let ok = await paneStep(d, "ctrl-\(by > 0 ? "right" : "left")#\(i)", panes: 3, .press(by > 0 ? "⌃→" : "⌃←", item: by > 0 ? "Next Agent" : "Previous Agent")) {
        d.panesShown().first(where: \.focused)?.agent == want
      }
      threadBodies += d.bodies(in: t...run.now).filter { $0.view == "PaneThread" || $0.view == "PaneEntryRow" }
      let (m, dd) = panesMatch(d)
      moved = moved && ok && m
      if !(ok && m) { notes.append("key#\(i): \(dd)") }
    }
    // A click in another pane's thread, as a person focuses it: a real mouse-down and -up on the app's queue.
    for i in 0..<run.int("clicks", 2) {
      guard let target = d.panesShown().first(where: { !$0.focused }) else { break }
      let t = run.now
      await run.click(at: CGPoint(x: target.frame.midX, y: target.frame.midY), ink: d.paneRegions(3), name: "click#\(i)", timeoutMs: 3000,
                      until: { d.model.panes.focusedAgent == target.agent })
      threadBodies += d.bodies(in: t...run.now).filter { $0.view == "PaneThread" || $0.view == "PaneEntryRow" }
      let ok = d.model.panes.focusedAgent == target.agent
      let (m, dd) = panesMatch(d)
      moved = moved && ok && m
      if !(ok && m) { notes.append("click#\(i): \(dd)") }
    }
    let same = d.panesShown().map { ObjectIdentifier($0.view) } == views
    run.regions(d.paneRegions(3))
    run.record([
      Check("focus-moved", moved, notes.joined(separator: "; ").ifEmpty("⌃← ⌃→ and clicks moved the focus to the pane, its header and ring with it")),
      Check("no-thread-render", threadBodies.isEmpty, "thread bodies while the focus moved: \(threadBodies.isEmpty ? "none" : Desk.summary(threadBodies))"),
      Check("views-kept", same, "the three pane views stayed the same objects"),
    ])
  }

  // MARK: split-burst

  /// Three panes; thread items for one pane's agent at `itemsPerSecond`: that pane's thread renders, the other panes
  /// and the sidebar don't.
  static func splitBurst(_ run: HostRun) async throws {
    let d = try await onePane(run)
    await split(d, [false, true])
    var w = d.world
    w.lastSeq = max(w.lastSeq, d.liveSeq)
    let runId = d.model.openRunId ?? d.world.openRunId ?? d.world.runIds[0]
    let shown = d.model.panes.agents
    let target = shown[1], others = Set(shown).subtracting([target])
    let rate = max(1, run.int("itemsPerSecond", 20)), secs = max(1, run.int("seconds", 3))
    let assigned = d.model.sidebar.assignments
    var start = 0.0, end = 0.0, sent = 0
    await run.step("split-burst \(rate)/s", timeoutMs: 20_000, ink: d.paneRegions(3)) {
      start = run.now
      while sent < rate * secs {
        let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1) in a split pane.")
        let f = Fixtures.liveFrame(runId: runId, item: item)
        d.store.receive(.event(f.envelope), scope: f.scope)
        sent += 1
        await run.sleep(ms: 1000 / Double(rate))
      }
      _ = await d.nextCommit()
      end = run.now
    }
    let bs = d.bodies(in: start...end)
    let own = bs.filter { ($0.view == "PaneThread" || $0.view == "PaneEntryRow") && $0.id == target }.count
    let leaked = bs.filter { paneViews.contains($0.view) && $0.id.map(others.contains) == true }
    let side = bs.filter { DriveSidebar.sidebarViews.contains($0.view) }
    d.liveSeq = max(d.liveSeq, w.lastSeq)
    let assignments = d.model.sidebar.assignments - assigned
    run.regions(d.paneRegions(3))
    run.record([
      Check("delivered-pane", own >= sent / 2, "the target pane's thread evaluated \(own) bodies for \(sent) items"),
      Check("isolation-panes", leaked.isEmpty, "other panes' bodies: \(leaked.isEmpty ? "none" : Desk.summary(leaked))"),
      Check("isolation-sidebar", side.isEmpty && assignments == 0, "sidebar bodies \(side.count); sidebar slice assigned \(assignments) times"),
    ])
  }

  // MARK: pane-expand

  /// Two panes, the focused one's thread scrolled up from its foot; ⇧⌘↩ (through the menu bar) gives it the window, Esc
  /// (a real key: the expanded pane's arrows-in takes it) gives it back, `toggles` times. Expanded: that pane's view fills the window, the sidebar and the other pane hide. Back: the same
  /// panes in the same frames, the thread at the same distance from its foot, the same views (nothing rebuilt).
  static func paneExpand(_ run: HostRun) async throws {
    let d = try await onePane(run)
    await split(d, [false])
    let names = ["thread", "expanded", "collapsed-same", "scroll-kept", "no-rebuild"]
    guard let focused = d.panesShown().first(where: \.focused), let sv = d.threadScroll(in: focused.view) else {
      return run.record(names.map { Check($0, false, "no focused pane or no thread scroll view in it") })
    }
    // Up from the foot by a screen or what the thread has.
    let room = max(0, sv.documentView!.frame.height - sv.contentView.bounds.height)
    let up = min(room, sv.contentView.bounds.height * 0.8)
    if up > 0 {
      let b = sv.contentView.bounds
      sv.contentView.scroll(to: NSPoint(x: 0, y: sv.contentView.isFlipped ? b.minY - up : b.minY + up)); sv.reflectScrolledClipView(sv.contentView)
      _ = await d.nextCommit()
      await d.quiet(quietMs: 150, timeoutMs: 2000)
    }
    let foot = fromFoot(sv)
    let before = d.panesShown().map { ($0.agent, $0.frame) }
    let views = d.panesShown().map { ObjectIdentifier($0.view) }
    let full = d.content.convert(d.content.bounds, to: nil).integral
    var expandedOK = true, back = true, kept = true, same = true, notes: [String] = []
    var threadBodies = 0
    for i in 0..<run.int("toggles", 4) {
      var t = run.now
      var ok = await paneStep(d, "expand#\(i)", panes: 1, .press("⇧⌘↩", item: "Expand Pane")) { d.panesShown().count == 1 && d.panesShown().first?.frame == full }
      threadBodies += d.bodies(in: t...run.now).filter { $0.view == "PaneThread" }.count
      let e = d.panesShown()
      let ex = ok && e.count == 1 && e[0].expanded && e[0].frame == full && d.sidebarScrollView(scrollable: false) == nil
        && ObjectIdentifier(e[0].view) == views[before.firstIndex { $0.0 == focused.agent } ?? 0]
      expandedOK = expandedOK && ex
      if !ex { notes.append("expand#\(i): \(e.map { "\($0.agent) \($0.frame) expanded \($0.expanded)" }), sidebar \(d.sidebarScrollView(scrollable: false) != nil)") }
      t = run.now
      ok = await paneStep(d, "esc#\(i)", panes: 2, .key(.escape)) { d.panesShown().count == 2 }
      threadBodies += d.bodies(in: t...run.now).filter { $0.view == "PaneThread" }.count
      let after = d.panesShown()
      let b = ok && after.map(\.agent) == before.map(\.0) && after.map(\.frame) == before.map(\.1) && !d.model.nav.expanded
      back = back && b
      if !b { notes.append("esc#\(i): \(after.map { "\($0.agent) \($0.frame)" }) vs \(before.map { "\($0.0) \($0.1)" })") }
      let sv2 = d.threadScroll(in: after.first { $0.agent == focused.agent }?.view ?? focused.view)
      let k = sv2 === sv && abs(fromFoot(sv) - foot) <= 2
      kept = kept && k
      if !k { notes.append("scroll#\(i): \(Stats.round(foot, 1)) → \(Stats.round(Double(sv2.map(fromFoot) ?? -1), 1)) pt from the foot; same scroll view \(sv2 === sv)") }
      same = same && after.map { ObjectIdentifier($0.view) } == views
    }
    // The end state for the snapshot: expanded, at rest.
    _ = await paneStep(d, "rest", panes: 1, .press("⇧⌘↩", item: "Expand Pane")) { d.panesShown().count == 1 }
    run.regions(d.paneRegions(1))
    run.record([
      Check("thread", true, "the focused pane's thread, \(Stats.round(up, 1)) pt up from its foot"),
      Check("expanded", expandedOK, notes.filter { $0.hasPrefix("expand") }.joined(separator: "; ").ifEmpty("⇧⌘↩ gave the focused pane the whole window, sidebar and other pane hidden")),
      Check("collapsed-same", back, notes.filter { $0.hasPrefix("esc") }.joined(separator: "; ").ifEmpty("Esc brought back the same panes in the same frames")),
      Check("scroll-kept", kept && up > 0, notes.filter { $0.hasPrefix("scroll") }.joined(separator: "; ").ifEmpty("the thread kept its place \(Stats.round(foot, 1)) pt from its foot (scrolled up \(Stats.round(up, 1)) pt)")),
      Check("no-rebuild", same, "the pane views stayed the same objects; PaneThread bodies over all toggles: \(threadBodies)"),
    ])
  }

  // MARK: expand-switch

  /// Expanded, other agents picked as the palette's ↩ picks them (`show(run:agent:)`): it stays expanded and the pane
  /// shows each one; ⌘K opens over it and closes.
  static func expandSwitch(_ run: HostRun) async throws {
    let d = try await onePane(run)
    d.model.expandPane()
    _ = await run.wait(timeoutMs: 2000) { d.panesShown().first?.expanded == true }
    await d.quiet(timeoutMs: 3000)
    let full = d.content.convert(d.content.bounds, to: nil).integral
    let cols = d.model.columns
    var stayed = true, notes: [String] = []
    for i in 0..<run.int("switches", 4) {
      let target = cols[(i * 3 + 2) % cols.count]
      let runId = d.model.openRunId!
      let ok = await paneStep(d, "switch#\(i)", panes: 1, .call { d.model.show(run: runId, agent: target) }) { d.panesShown().first?.agent == target }
      let p = d.panesShown()
      let good = ok && d.model.nav.expanded && p.count == 1 && p[0].agent == target && p[0].expanded && p[0].frame == full
      stayed = stayed && good
      if !good { notes.append("switch#\(i) to \(target): \(p.map { "\($0.agent) \($0.frame) expanded \($0.expanded)" }), model expanded \(d.model.nav.expanded)") }
    }
    // ⌘K over the expanded pane (through the menu bar), and Esc (a real key: the palette's own key handling). Esc gives
    // the keyboard back to the pane the palette opened over (the check `focus palette-esc`, written in this PR).
    let paneView = d.paneView()?.view
    let ok1 = await paneStep(d, "palette", panes: 1, .press("⌘K", item: "Search…")) { d.model.paletteOpen }
    await run.key(.escape, expectFocus: paneView.map { FocusTarget.view($0) } ?? .identifier("the expanded pane"), name: "palette-esc", timeoutMs: 3000,
                  until: { !d.model.paletteOpen })
    let ok2 = !d.model.paletteOpen
    run.regions(d.paneRegions(1))
    run.record([
      Check("stays-expanded", stayed, notes.joined(separator: "; ").ifEmpty("every pick showed in the expanded pane, still expanded")),
      Check("palette-over", ok1 && ok2 && d.model.nav.expanded, "⌘K opened \(ok1) and Esc closed \(ok2) over the expanded pane; still expanded \(d.model.nav.expanded)"),
    ])
  }
}
