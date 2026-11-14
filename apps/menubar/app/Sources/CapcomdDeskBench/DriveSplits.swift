import AppKit
import SwiftUI
import CapcomdStore
import CapcomdDesk
import DeskBenchKit

/// Splits and expand in the opened window (design/desktop/rex RexSplit, RexExpanded; SPEC §2.1): ⌘D / ⇧⌘D / ⌘W,
/// focus moving between panes, a thread item arriving in one split, ⇧⌘↩ and Esc, and switching agents while expanded.
/// Keys are posted to the app's own event queue (the scene host has the app's menu, so ⌘D goes through View › Split
/// Right as a person's would; a window built by hand calls what the item calls). Checks read the real window: the pane
/// views in it (DeskPaneProbe), their frames, their thread's scroll view, and what is drawn in each pane. Each rep starts
/// from one pane and ends with its scenario's panes on screen, for the snapshot guard.
extension Drive {
  static let paneViews: Set<String> = ["PaneHead", "Pane", "PaneThread", "PaneEntryRow", "PaneComposer"]

  struct PaneSeen { let view: NSView; let agent: String; let id: Int; let focused: Bool; let expanded: Bool; let frame: CGRect }

  /// The pane views in the window that show (not hidden), left to right, top to bottom.
  func panesShown() -> [PaneSeen] {
    var out: [PaneSeen] = []
    h.walk(h.window.contentView!) { v in
      if let p = v as? DeskPaneProbe, p.isPane, !v.isHiddenOrHasHiddenAncestor {
        out.append(PaneSeen(view: v, agent: p.shownAgent, id: p.paneId, focused: p.paneFocused, expanded: p.paneExpanded, frame: v.convert(v.bounds, to: nil).integral))
      }
    }
    return out.sorted { ($0.frame.minX, -$0.frame.maxY) < ($1.frame.minX, -$1.frame.maxY) }
  }

  /// A pane's thread: the tallest vertical scroll view inside it.
  func threadScroll(in v: NSView) -> NSScrollView? {
    var best: NSScrollView?
    h.walk(v) { s in
      guard let sv = s as? NSScrollView, let d = sv.documentView, sv.bounds.height > 100 else { return }
      if best == nil || d.frame.height > best!.documentView!.frame.height { best = sv }
    }
    return best
  }

  /// How far the thread is from its foot, in points (0: at the bottom).
  func fromFoot(_ sv: NSScrollView) -> CGFloat {
    let d = sv.documentView!.frame.height, b = sv.contentView.bounds
    return sv.contentView.isFlipped ? d - b.maxY : b.minY
  }

  /// One pane, the opened window at rest, the reel at its first column: what every rep starts from.
  func onePane() async {
    await rewind()
    await openSidebar()
    if h.model.nav.expanded { h.model.collapsePane() }
    while h.model.panes.count > 1 { h.model.closePane(h.model.panes.slots.last!.id) }
    if let first = h.model.columns.first { h.model.selectRow(id: first) }
    _ = await h.nextCommit()
    _ = await settle { panesShown().count == 1 }
    await h.sleep(ms: 200)
    _ = await h.waitQuiet(timeoutMs: 3000)
  }

  /// A shortcut as the app gets it: posted to its event queue (the menu's key equivalent), or the item's own call.
  func shortcut(_ chars: String, code: UInt16, mods: NSEvent.ModifierFlags, fallback: () -> Void) {
    if h.sceneHosted { post(chars, code: code, mods: mods, to: h.window) } else { fallback() }
  }
  func splitKey(down: Bool) {
    guard h.sceneHosted, down else { return shortcut("d", code: 2, mods: .command) { h.model.split(down: down) } }
    // ⇧⌘D as the keyboard makes it (the layout gives its characters), matched by the window and then the main menu, as
    // AppKit routes a key equivalent. Posted to the queue, an in-process ⇧⌘-letter event never reached SwiftUI's menu
    // items (⇧⌘F neither), while the menu matches the same event when asked (DESKBENCH.md, splits).
    guard let cg = CGEvent(keyboardEventSource: nil, virtualKey: 2, keyDown: true) else { return }
    cg.flags = [.maskCommand, .maskShift]
    guard let e = NSEvent(cgEvent: cg) else { return }
    if !h.window.performKeyEquivalent(with: e) { _ = NSApp.mainMenu?.performKeyEquivalent(with: e) }
  }
  func closeKey() { shortcut("w", code: 13, mods: .command) { h.model.foldShortcut() } }
  func expandKey() { shortcut("\r", code: 36, mods: [.command, .shift]) { h.model.toggleExpand() } }
  func escKey() { shortcut("\u{1b}", code: 53, mods: []) { h.model.collapsePane() } }
  func ctrlArrow(_ by: Int) {
    let c = String(UnicodeScalar(by > 0 ? NSRightArrowFunctionKey : NSLeftArrowFunctionKey)!)
    shortcut(c, code: by > 0 ? 124 : 123, mods: [.control, .function, .numericPad]) { h.model.moveFocus(by) }
  }

  /// A click as the app gets one: mouse-down and -up posted to its own event queue (in-process), so the window hands it
  /// out as it would a person's, gesture recognisers included. `p` is in points from the content's top left.
  func postClick(at p: CGPoint) {
    let w = h.window!
    let loc = NSPoint(x: p.x, y: w.contentView!.bounds.height - p.y)
    for type in [NSEvent.EventType.leftMouseDown, .leftMouseUp] {
      if let e = NSEvent.mouseEvent(with: type, location: loc, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                                    context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) {
        NSApp.postEvent(e, atStart: false)
      }
    }
  }

  /// One latency step: `act`, until `done` holds, to the frame that shows it; the step's work and 250 ms after.
  func paneStep(_ name: String, _ act: () -> Void, done: @escaping () -> Bool) async -> (StepResult, Bool) {
    if !h.window.isKeyWindow { h.window.makeKeyAndOrderFront(nil); _ = await h.nextCommit() }
    let m = h.begin(name)
    let t = h.now()
    act()
    let ok = await h.wait(timeoutMs: 2000, done)
    let shown = await h.nextCommit()
    await h.sleep(ms: 250)
    let end = h.now()
    let bs = h.bodies(in: t...end)
    let step = h.end(m, latencyMs: shown - t, notes: ["\(bs.count) bodies: " + Dictionary(grouping: bs, by: \.view).mapValues(\.count).sorted { $0.value > $1.value }.map { "\($0.key)×\($0.value)" }.joined(separator: " ")]
                                                    + (ok ? [] : ["not shown within 2 s"]))
    await h.sleep(ms: 60)   // the checks after it in an awakening of their own
    return (step, ok)
  }

  /// The share of each pane drawn (pixels unlike the pane's own fill), below its header. A blank pane reads near 0.
  func inkPanes() -> [Double] {
    let frame = h.window.contentView!.superview ?? h.window.contentView!
    guard let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return [] }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    guard let data = rep.bitmapData, rep.bitsPerSample == 8, rep.samplesPerPixel >= 3 else { return [] }
    let scale = Double(rep.pixelsWide) / Double(frame.bounds.width), H = Double(frame.bounds.height)
    let bpr = rep.bytesPerRow, spp = rep.samplesPerPixel
    func px(_ x: Int, _ y: Int) -> (Int, Int, Int) { let o = y * bpr + x * spp; return (Int(data[o]), Int(data[o + 1]), Int(data[o + 2])) }
    return panesShown().map { p in
      // Window coordinates (bottom-left) to the picture's rows (top-left); under the header, inside the corners.
      let f = (x: Double(p.frame.minX), top: H - Double(p.frame.maxY), w: Double(p.frame.width), h: Double(p.frame.height))
      let x0: Double = f.x + 12, y0: Double = f.top + 56, w: Double = f.w - 24, hh: Double = f.h - 126
      guard w > 20, hh > 20 else { return 0 }
      let g = px(Int((f.x + 4) * scale), Int((f.top + 50) * scale))   // the pane's fill, at its edge
      var hits = 0, n = 0
      for y in stride(from: Int(y0 * scale), to: Int((y0 + hh) * scale), by: 3) {
        for x in stride(from: Int(x0 * scale), to: Int((x0 + w) * scale), by: 3) {
          let c = px(x, y); n += 1
          if abs(c.0 - g.0) + abs(c.1 - g.1) + abs(c.2 - g.2) > 30 { hits += 1 }
        }
      }
      return n == 0 ? 0 : Double(hits) / Double(n)
    }
  }
  func inkNote(_ ink: [Double]) -> String { "drawn per pane: " + ink.map { "\(Stats.round($0 * 100, 1)) %" }.joined(separator: ", ") }

  /// The panes on screen are the model's, in its order, with the focus where the model has it.
  func panesMatch() -> (Bool, String) {
    let seen = panesShown()
    let want = h.model.nav.expanded ? [h.model.panes.focusedAgent ?? ""] : h.model.panes.agents
    let ok = seen.map(\.agent) == want && seen.filter(\.focused).map(\.agent) == [h.model.panes.focusedAgent ?? "?"]
    return (ok, "shown \(seen.map { "\($0.agent)\($0.focused ? "*" : "")" }.joined(separator: ",")), model \(want.joined(separator: ",")) focused \(h.model.panes.focusedAgent ?? "-")")
  }

  // MARK: split-open

  /// ⌘D (split right), ⇧⌘D (split down), then ⌘W twice, `cycles` times; ends with one split right on screen.
  func splitOpen() async -> ([StepResult], [Check]) {
    await onePane()
    var steps: [StepResult] = []
    var opened = true, down = true, closed = true, nextInTree = true, notes: [String] = []
    for c in 0..<int("cycles", 2) {
      let base = h.model.panes.agents
      let want = h.model.nextAgentForSplit()
      var (s, ok) = await paneStep("split-right#\(c)", { splitKey(down: false) }) { panesShown().count == base.count + 1 }
      steps.append(s)
      let (m1, d1) = panesMatch()
      opened = opened && ok && m1 && h.model.panes.columns.count == 2
      nextInTree = nextInTree && h.model.panes.focusedAgent == want
      if !(ok && m1) { notes.append("⌘D#\(c): \(d1)") }
      (s, ok) = await paneStep("split-down#\(c)", { splitKey(down: true) }) { panesShown().count == base.count + 2 }
      steps.append(s)
      let (m2, d2) = panesMatch()
      let stacked = panesShown().filter { abs($0.frame.minX - (panesShown().last?.frame.minX ?? -1)) < 1 }.count == 2
      down = down && ok && m2 && stacked && h.model.panes.columns.last?.count == 2
      if !(ok && m2 && stacked) { notes.append("⇧⌘D#\(c): \(d2), stacked \(stacked) \(panesShown().map { "\($0.frame)" })") }
      for k in 0..<2 {
        let n = panesShown().count
        (s, ok) = await paneStep("close#\(c).\(k)", { closeKey() }) { panesShown().count == n - 1 }
        steps.append(s)
        let (m3, d3) = panesMatch()
        closed = closed && ok && m3
        if !(ok && m3) { notes.append("⌘W#\(c).\(k): \(d3)") }
      }
    }
    // The end state for the snapshot guard: one split right, at rest.
    let (s, _) = await paneStep("rest", { splitKey(down: false) }) { panesShown().count == 2 }
    steps.append(s)
    await h.sleep(ms: 300)
    let ink = inkPanes()
    return (steps, [
      Check("split-right", opened, notes.filter { $0.hasPrefix("⌘D") }.joined(separator: "; ").ifEmpty("⌘D added a pane beside the focused one, focused, every time")),
      Check("next-in-tree", nextInTree, "the new pane showed the next agent in tree order that no pane showed"),
      Check("split-down", down, notes.filter { $0.hasPrefix("⇧⌘D") }.joined(separator: "; ").ifEmpty("⇧⌘D stacked a pane under the focused one every time")),
      Check("closed", closed, notes.filter { $0.hasPrefix("⌘W") }.joined(separator: "; ").ifEmpty("⌘W closed the focused split; its neighbour took the focus")),
      Check("drawn", ink.count == 2 && ink.allSatisfy { $0 > 0.01 }, inkNote(ink)),
    ])
  }

  // MARK: split-focus

  /// Three panes; ⌃→ ⌃← and clicks move the focus between them. Only the panes whose focus changed re-render their
  /// heads; no thread renders and no pane view is made.
  func splitFocus() async -> ([StepResult], [Check]) {
    await onePane()
    h.model.split(down: false); h.model.split(down: false)
    _ = await h.nextCommit(); _ = await settle { panesShown().count == 3 }
    await h.sleep(ms: 300); _ = await h.waitQuiet(timeoutMs: 3000)
    let views = panesShown().map { ObjectIdentifier($0.view) }
    var steps: [StepResult] = []
    var moved = true, quiet = true, notes: [String] = []
    var threadBodies: [String: Int] = [:]
    let moves = [-1, -1, 1, 1]
    for (i, by) in moves.enumerated() {
      let want = h.model.panes.neighbour(by)?.agent
      let t = h.now()
      let (s, ok) = await paneStep("ctrl-\(by > 0 ? "right" : "left")#\(i)", { ctrlArrow(by) }) { panesShown().first(where: \.focused)?.agent == want }
      steps.append(s)
      for b in h.bodies(in: t...h.now()) where b.view == "PaneThread" || b.view == "PaneEntryRow" { threadBodies[b.view, default: 0] += 1 }
      let (m, d) = panesMatch()
      moved = moved && ok && m
      if !(ok && m) { notes.append("key#\(i): \(d)") }
    }
    // A click in another pane's thread (a mouse-down and -up handed to the window), as a person focuses it.
    for i in 0..<int("clicks", 2) {
      guard let target = panesShown().first(where: { !$0.focused }) else { break }
      let p = CGPoint(x: target.frame.midX, y: h.window.contentView!.bounds.height - target.frame.midY)
      let t = h.now()
      let (s, ok) = await paneStep("click#\(i)", { postClick(at: p) }) { h.model.panes.focusedAgent == target.agent }
      steps.append(s)
      for b in h.bodies(in: t...h.now()) where b.view == "PaneThread" || b.view == "PaneEntryRow" { threadBodies[b.view, default: 0] += 1 }
      let (m, d) = panesMatch()
      moved = moved && ok && m
      if !(ok && m) { notes.append("click#\(i): \(d)") }
    }
    quiet = threadBodies.isEmpty
    let same = panesShown().map { ObjectIdentifier($0.view) } == views
    let ink = inkPanes()
    return (steps, [
      Check("focus-moved", moved, notes.joined(separator: "; ").ifEmpty("⌃← ⌃→ and clicks moved the focus to the pane, its header and ring with it")),
      Check("no-thread-render", quiet, "thread bodies while the focus moved: \(threadBodies.isEmpty ? "none" : threadBodies.description)"),
      Check("views-kept", same, "the three pane views stayed the same objects"),
      Check("drawn", ink.count == 3 && ink.allSatisfy { $0 > 0.01 }, inkNote(ink)),
    ])
  }

  // MARK: split-burst

  /// Three panes; thread items for one pane's agent at `itemsPerSecond`: that pane's thread renders, the other panes
  /// and the sidebar don't.
  mutating func splitBurst() async -> ([StepResult], [Check]) {
    await onePane()
    h.model.split(down: false); h.model.split(down: true)
    _ = await h.nextCommit(); _ = await settle { panesShown().count == 3 }
    await h.sleep(ms: 300); _ = await h.waitQuiet(timeoutMs: 3000)
    var w = world
    w.lastSeq = max(w.lastSeq, h.liveSeq)
    let run = h.model.openRunId ?? fixtureRunId
    let shown = h.model.panes.agents
    let target = shown[1], others = Set(shown).subtracting([target])
    let rate = max(1, int("itemsPerSecond", 20)), secs = max(1, int("seconds", 3))
    let assigned = h.model.sidebar.assignments
    let m = h.begin("split-burst \(rate)/s")
    let start = h.now()
    var sent = 0
    while sent < rate * secs {
      let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1) in a split pane.")
      let f = Fixtures.liveFrame(runId: run, item: item)
      h.store.receive(.event(f.envelope), scope: f.scope)
      sent += 1
      await h.sleep(ms: 1000 / Double(rate))
    }
    _ = await h.nextCommit()
    let end = h.now()
    let bs = h.bodies(in: start...end)
    let own = bs.filter { ($0.view == "PaneThread" || $0.view == "PaneEntryRow") && $0.id == target }.count
    let leaked = bs.filter { Self.paneViews.contains($0.view) && $0.id.map(others.contains) == true }
    let side = bs.filter { Self.sidebarViews.contains($0.view) }
    let step = h.end(m, notes: ["\(sent) items to the middle pane's agent; its thread bodies \(own); other panes' bodies \(leaked.count); sidebar bodies \(side.count)"])
    h.liveSeq = max(h.liveSeq, w.lastSeq); world = w
    let assignments = h.model.sidebar.assignments - assigned
    let ink = inkPanes()
    return ([step], [
      Check("delivered-pane", own >= sent / 2, "the target pane's thread evaluated \(own) bodies for \(sent) items"),
      Check("isolation-panes", leaked.isEmpty, "other panes' bodies: \(leaked.isEmpty ? "none" : Dictionary(grouping: leaked, by: \.view).mapValues(\.count).description)"),
      Check("isolation-sidebar", side.isEmpty && assignments == 0, "sidebar bodies \(side.count); sidebar slice assigned \(assignments) times"),
      Check("drawn", ink.count == 3 && ink.allSatisfy { $0 > 0.01 }, inkNote(ink)),
    ])
  }

  // MARK: pane-expand

  /// Two panes, the focused one's thread scrolled up from its foot; ⇧⌘↩ gives it the window, Esc gives it back,
  /// `toggles` times. Expanded: that pane's view fills the window, the sidebar and the other pane hide. Back: the same
  /// panes in the same frames, the thread at the same distance from its foot, the same views (nothing rebuilt).
  func paneExpand() async -> ([StepResult], [Check]) {
    await onePane()
    h.model.split(down: false)
    _ = await h.nextCommit(); _ = await settle { panesShown().count == 2 }
    await h.sleep(ms: 300); _ = await h.waitQuiet(timeoutMs: 3000)
    guard let focused = panesShown().first(where: \.focused), let sv = threadScroll(in: focused.view) else {
      return ([], [Check("thread", false, "no focused pane or no thread scroll view in it")])
    }
    // Up from the foot by a screen or what the thread has.
    let room = max(0, sv.documentView!.frame.height - sv.contentView.bounds.height)
    let up = min(room, sv.contentView.bounds.height * 0.8)
    if up > 0 {
      let b = sv.contentView.bounds
      let y = sv.contentView.isFlipped ? b.minY - up : b.minY + up
      sv.contentView.scroll(to: NSPoint(x: 0, y: y)); sv.reflectScrolledClipView(sv.contentView)
      _ = await h.nextCommit(); await h.sleep(ms: 200)
    }
    let foot = fromFoot(sv)
    let before = panesShown().map { ($0.agent, $0.frame) }
    let views = panesShown().map { ObjectIdentifier($0.view) }
    let full = h.window.contentView!.convert(h.window.contentView!.bounds, to: nil).integral
    var steps: [StepResult] = []
    var expandedOK = true, back = true, kept = true, same = true, notes: [String] = []
    var threadBodies = 0
    for i in 0..<int("toggles", 4) {
      var t = h.now()
      var (s, ok) = await paneStep("expand#\(i)", { expandKey() }) { panesShown().count == 1 && panesShown().first?.frame == full }
      steps.append(s)
      threadBodies += h.bodies(in: t...h.now()).filter { $0.view == "PaneThread" }.count
      let e = panesShown()
      let ex = ok && e.count == 1 && e[0].expanded && e[0].frame == full && sidebarScrollView(scrollable: false) == nil && ObjectIdentifier(e[0].view) == views[before.firstIndex { $0.0 == focused.agent } ?? 0]
      expandedOK = expandedOK && ex
      if !ex { notes.append("expand#\(i): \(e.map { "\($0.agent) \($0.frame) expanded \($0.expanded)" }), sidebar \(sidebarScrollView(scrollable: false) != nil)") }
      t = h.now()
      (s, ok) = await paneStep("esc#\(i)", { escKey() }) { panesShown().count == 2 }
      steps.append(s)
      threadBodies += h.bodies(in: t...h.now()).filter { $0.view == "PaneThread" }.count
      let after = panesShown()
      let b = ok && after.map(\.agent) == before.map(\.0) && after.map(\.frame) == before.map(\.1) && !h.model.nav.expanded
      back = back && b
      if !b { notes.append("esc#\(i): \(after.map { "\($0.agent) \($0.frame)" }) vs \(before.map { "\($0.0) \($0.1)" })") }
      let sv2 = threadScroll(in: after.first { $0.agent == focused.agent }?.view ?? focused.view)
      let k = sv2 === sv && abs(fromFoot(sv) - foot) <= 2
      kept = kept && k
      if !k { notes.append("scroll#\(i): \(Stats.round(foot, 1)) → \(Stats.round(Double(sv2.map(fromFoot) ?? -1), 1)) pt from the foot; same scroll view \(sv2 === sv)") }
      same = same && after.map { ObjectIdentifier($0.view) } == views
    }
    // The end state for the snapshot guard: expanded, at rest.
    let (s, _) = await paneStep("rest", { expandKey() }) { panesShown().count == 1 }
    steps.append(s)
    await h.sleep(ms: 300)
    let ink = inkPanes()
    return (steps, [
      Check("expanded", expandedOK, notes.filter { $0.hasPrefix("expand") }.joined(separator: "; ").ifEmpty("⇧⌘↩ gave the focused pane the whole window, sidebar and other pane hidden")),
      Check("collapsed-same", back, notes.filter { $0.hasPrefix("esc") }.joined(separator: "; ").ifEmpty("Esc brought back the same panes in the same frames")),
      Check("scroll-kept", kept && up > 0, notes.filter { $0.hasPrefix("scroll") }.joined(separator: "; ").ifEmpty("the thread kept its place \(Stats.round(foot, 1)) pt from its foot (scrolled up \(Stats.round(up, 1)) pt)")),
      Check("no-rebuild", same, "the pane views stayed the same objects; PaneThread bodies over all toggles: \(threadBodies)"),
      Check("drawn", ink.count == 1 && ink[0] > 0.01, inkNote(ink) + " (expanded)"),
    ])
  }

  // MARK: expand-switch

  /// Expanded, other agents picked as the palette's ↩ picks them (`show(run:agent:)`): it stays expanded and the pane
  /// shows each one; ⌘K opens over it and closes.
  func expandSwitch() async -> ([StepResult], [Check]) {
    await onePane()
    h.model.expandPane()
    _ = await h.nextCommit(); _ = await settle { panesShown().first?.expanded == true }
    await h.sleep(ms: 300); _ = await h.waitQuiet(timeoutMs: 3000)
    let full = h.window.contentView!.convert(h.window.contentView!.bounds, to: nil).integral
    let cols = h.model.columns
    var steps: [StepResult] = []
    var stayed = true, notes: [String] = []
    for i in 0..<int("switches", 4) {
      let target = cols[(i * 3 + 2) % cols.count]
      let run = h.model.openRunId!
      let (s, ok) = await paneStep("switch#\(i)", { h.model.show(run: run, agent: target) }) { panesShown().first?.agent == target }
      steps.append(s)
      let p = panesShown()
      let good = ok && h.model.nav.expanded && p.count == 1 && p[0].agent == target && p[0].expanded && p[0].frame == full
      stayed = stayed && good
      if !good { notes.append("switch#\(i) to \(target): \(p.map { "\($0.agent) \($0.frame) expanded \($0.expanded)" }), model expanded \(h.model.nav.expanded)") }
    }
    // ⌘K over the expanded pane, and Esc.
    let (s1, ok1) = await paneStep("palette", { if h.sceneHosted { post("k", code: 40, mods: .command, to: h.window) } else { h.model.togglePalette() } }) { h.model.paletteOpen }
    steps.append(s1)
    let (s2, ok2) = await paneStep("palette-esc", { h.model.closePalette() }) { !h.model.paletteOpen }
    steps.append(s2)
    await h.sleep(ms: 300)
    let ink = inkPanes()
    return (steps, [
      Check("stays-expanded", stayed, notes.joined(separator: "; ").ifEmpty("every pick showed in the expanded pane, still expanded")),
      Check("palette-over", ok1 && ok2 && h.model.nav.expanded, "⌘K opened \(ok1) and closed \(ok2) over the expanded pane; still expanded \(h.model.nav.expanded)"),
      Check("drawn", ink.count == 1 && ink[0] > 0.01, inkNote(ink)),
    ])
  }
}
