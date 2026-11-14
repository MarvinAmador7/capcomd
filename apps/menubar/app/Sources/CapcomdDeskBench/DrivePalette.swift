import AppKit
import CapcomdStore
import CapcomdDesk
import DeskBenchKit

/// Search ⌘K's scenarios (`palette-open`, `palette-type`, `palette-keys`), on a fixture with hundreds of searchable items
/// (the `search` fixture: 60 projects, ~200 agents, asks, the commands). They drive the real palette: the model's
/// ⌘K, then key events handed to the palette's own panel (its field editor gets the characters; ↑ ↓ ↩ ⌘↩ Esc go
/// through the panel's key handling), nothing posted to the system. Each step's latency is to the first frame that shows
/// the change; checks read the UI's own state (the panel, the results, the selection, what opened).
extension Drive {
  /// The panel showing now, if any (knob search.host=panel).
  var panel: SearchPanel? { SearchPanelController.shown.flatMap { $0.isVisible ? $0 : nil } }
  var inPanel: Bool { DeskKnobs.searchHost.value == .panel }
  /// The palette shows: its panel, or (in the window) the model says so.
  var shown: Bool { inPanel ? panel != nil : h.model.paletteOpen }
  /// Where a key goes: the panel (it is key), else the desk window, whose first responder is the palette's field.
  var keyWindow: NSWindow? { inPanel ? panel : (h.model.paletteOpen ? h.window : nil) }

  /// A key as the app receives one: posted to its own event queue (in-process; nothing goes to the system), so the run
  /// loop hands it out as input (key equivalents and the menu first, then the key window), `NSApp.currentEvent`
  /// included.
  func post(_ chars: String, code: UInt16, mods: NSEvent.ModifierFlags = [], to w: NSWindow?) {
    guard let w, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                         windowNumber: w.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                         isARepeat: false, keyCode: code) else { return }
    NSApp.postEvent(e, atStart: false)
  }

  /// ⌘K as the app gets it (the menu's Search… item: the scene host has the app's commands; a window built by hand has no
  /// menu, so there it is the model's call the item makes), and the frame that shows the palette with its results.
  func openPalette(_ name: String) async -> StepResult {
    if h.model.paletteOpen { h.model.closePalette(); _ = await h.nextCommit() }
    // ⌘K reaches the window only while it has the keyboard: start from there (a busy Mac can leave the bench's window
    // not key yet, and a key then goes nowhere).
    if !h.window.isKeyWindow { h.window.makeKeyAndOrderFront(nil); _ = await h.nextCommit() }
    let m = h.begin(name)
    let t = h.now()
    if h.sceneHosted { post("k", code: 40, mods: .command, to: h.window) } else { h.model.togglePalette() }
    let ok = await h.wait(timeoutMs: 2000) { self.h.model.paletteOpen && self.shown }
    let shown = await h.nextCommit()
    let notes = ["\(h.model.search.index.count) items indexed in \(Stats.round(h.model.search.lastIndexMs, 2)) ms", "\(h.model.paletteShown.count) results"] + (ok ? [] : ["the palette didn't show within 2 s"])
    return h.end(m, latencyMs: shown - t, notes: notes)
  }

  /// One key, and the frame that shows what it did (`done`: the key has been handled).
  func key(_ name: String, chars: String, code: UInt16, mods: NSEvent.ModifierFlags = [], done: @escaping () -> Bool) async -> StepResult {
    let m = h.begin(name)
    let t = h.now()
    post(chars, code: code, mods: mods, to: keyWindow)
    let ok = await h.wait(timeoutMs: 2000, done)
    let shown = await h.nextCommit()
    return h.end(m, latencyMs: shown - t, notes: ["query \"\(h.model.paletteQuery)\" → \(h.model.paletteShown.count) results in \(Stats.round(h.model.search.lastQueryMs, 3)) ms"] + (ok ? [] : ["the key had no effect within 2 s"]))
  }
  func esc(_ name: String) async -> StepResult { await key(name, chars: "\u{1b}", code: 53) { !self.h.model.paletteOpen } }
  func arrow(_ name: String, down: Bool) async -> StepResult {
    let want = max(0, min(h.model.paletteShown.count - 1, h.model.paletteSelection + (down ? 1 : -1)))
    return await key(name, chars: String(UnicodeScalar(down ? NSDownArrowFunctionKey : NSUpArrowFunctionKey)!), code: down ? 125 : 126, mods: [.function, .numericPad]) {
      self.h.model.paletteSelection == want
    }
  }
  func enter(_ name: String, split: Bool) async -> StepResult {
    await key(name, chars: "\r", code: 36, mods: split ? .command : []) { !self.h.model.paletteOpen }
  }

  /// Types `text` one character at a time into the palette's field.
  func type(_ text: String, prefix: String) async -> [StepResult] {
    var out: [StepResult] = []
    let start = h.model.paletteQuery
    for (i, c) in text.enumerated() {
      let want = start + String(text.prefix(i + 1))
      out.append(await key("\(prefix)#\(i) '\(c)'", chars: String(c), code: 0) { self.h.model.paletteQuery == want })
    }
    return out
  }

  /// The results are ranked as the board says: groups in attention order, each by score, every word matched, capped.
  func rankingCheck(_ query: String) -> Check {
    let secs = h.model.search.sections
    let order = secs.map(\.group.rawValue)
    var why: [String] = []
    if order != order.sorted() || Set(order).count != order.count { why.append("groups out of order: \(secs.map(\.group.title))") }
    for s in secs {
      let scores = s.hits.map(\.score)
      if scores != scores.sorted(by: >) { why.append("\(s.group.title) not by score") }
      if s.hits.count > SearchIndex.groupCap { why.append("\(s.group.title) over the cap") }
    }
    // What each result shows in semibold spells what was typed, in order (one word typed here).
    let unmatched = h.model.paletteShown.filter { hit in
      func spelled(_ text: String, _ at: [Int]) -> String { let cs = Array(text); return String(at.compactMap { cs.indices.contains($0) ? cs[$0] : nil }) }
      let shown = spelled(hit.item.title.text, hit.titleHits) + spelled(hit.item.subtitle?.text ?? "", hit.subtitleHits)
      return shown.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) != query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
    if !unmatched.isEmpty { why.append("\(unmatched.count) results don't spell the query in what they mark (first: \(unmatched[0].item.title.text))") }
    let asking = Set(h.model.search.index.asks.compactMap(\.agentId))
    if h.model.paletteShown.contains(where: { $0.group == .agents && asking.contains($0.item.agentId ?? "") }) { why.append("an agent that needs you also shows under Agents") }
    return Check("ranking", why.isEmpty && !secs.isEmpty, why.isEmpty ? "\(secs.map { "\($0.group.title) \($0.hits.count)" }.joined(separator: ", ")) for \"\(query)\"" : why.joined(separator: "; "))
  }

  /// The panel draws its rows: ink in its own picture (a blank panel is fast and wrong), and the field has the query.
  func drawnCheck() -> Check {
    // The panel's own picture, or (in the window) the palette's place in the window's picture.
    let rows = h.model.paletteShown.count
    let height = SearchMetrics.queryHeight + 0.5 + SearchMetrics.listHeight(h.model.search.sections, query: h.model.paletteQuery) + SearchMetrics.footer
    let v: NSView?, rect: NSRect
    if inPanel {
      v = panel?.contentView; rect = v?.bounds ?? .zero
    } else {
      v = h.window.contentView?.superview ?? h.window.contentView
      let b = v?.bounds ?? .zero, w = SearchMetrics.width(for: b.width)
      rect = NSRect(x: (b.width - w) / 2, y: b.height - SearchMetrics.top - height, width: w, height: height)
    }
    guard shown, let v, rect.width > 0, let rep = v.bitmapImageRepForCachingDisplay(in: rect) else {
      return Check("panel-drawn", false, "the palette isn't on screen")
    }
    v.cacheDisplay(in: rect, to: rep)
    var ink = 0, n = 0
    let stepX = max(1, rep.pixelsWide / 160), stepY = max(1, rep.pixelsHigh / 120)
    for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
      for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
        n += 1
        if let c = rep.colorAt(x: x, y: y), c.brightnessComponent > 0.5 { ink += 1 }
      }
    }
    let share = Double(ink) / Double(max(n, 1))
    return Check("panel-drawn", share > 0.005 && rows > 0 && rect.height > 120,
                 "\(Stats.round(share * 100, 2)) % of the palette is text; \(rows) results; \(inPanel ? "panel" : "in the window") \(Int(rect.width))×\(Int(rect.height)) pt")
  }

  // MARK: palette-open

  /// ⌘K repeatedly on the empty search, and Esc between: open to first frame, and what the empty search offers.
  func paletteOpen() async -> ([StepResult], [Check]) {
    var steps: [StepResult] = [], checks: [Check] = []
    var escOK = true
    var escFailed: [Int] = []
    for i in 0..<int("opens", 6) {
      steps.append(await openPalette("open#\(i)"))
      if i == 0 {
        let groups = h.model.search.sections.map(\.group)
        let asks = h.model.search.index.asks.count
        checks.append(Check("items", h.model.search.index.count >= 200, "\(h.model.search.index.count) searchable items (agents, projects, asks, commands)"))
        checks.append(Check("empty-search", groups.first == (asks > 0 ? .needsYou : .recent) && groups.last == .commands && groups == groups.sorted(),
                            "groups \(groups.map(\.title)); \(asks) asks"))
        checks.append(drawnCheck())
      }
      steps.append(await esc("esc#\(i)"))
      if h.model.paletteOpen || shown { escOK = false; escFailed.append(i) }
      await h.sleep(ms: 120)
    }
    checks.append(Check("esc-closes", escOK, escOK ? "Esc closed the palette and its panel every time" : "the palette stayed open after Esc at open \(escFailed) (window key \(h.window.isKeyWindow))"))
    // At rest with the palette open, for the snapshot guard.
    _ = await openPalette("reopen")
    return (steps, checks)
  }

  // MARK: palette-type

  /// A query typed a character at a time: each keystroke to the frame that shows its results.
  func paletteType() async -> ([StepResult], [Check]) {
    let query = params["query"] ?? "matchkey"
    var steps = [await openPalette("open")]
    steps += await type(query, prefix: "type")
    let typed = h.model.paletteQuery == query
    let checks = [Check("typed", typed, "the field holds \"\(h.model.paletteQuery)\" (typed \"\(query)\")"), rankingCheck(query), drawnCheck()]
    return (steps, checks)
  }

  // MARK: palette-keys

  /// ↓ ↓ ↑ move the selection; ↩ opens it; ⌘↩ opens (until splits, as ↩ does); Esc closes.
  func paletteKeys() async -> ([StepResult], [Check]) {
    let query = params["query"] ?? "shard"
    var steps: [StepResult] = [], checks: [Check] = []
    steps.append(await openPalette("open"))
    steps += await type(query, prefix: "type")
    steps.append(await arrow("down#0", down: true))
    steps.append(await arrow("down#1", down: true))
    steps.append(await arrow("up#0", down: false))
    let results = h.model.paletteShown
    checks.append(Check("selection", h.model.paletteSelection == 1 && results.count > 2, "selection \(h.model.paletteSelection) of \(results.count) after ↓ ↓ ↑"))
    // ↩: the selected result opens and the palette closes.
    let target = results.indices.contains(1) ? results[1] : nil
    steps.append(await enter("return", split: false))
    checks.append(Check("return-opens", !h.model.paletteOpen && opened(target), "↩ on \(target.map { "\($0.item.id)" } ?? "-"): focused \(h.model.focusedAgent ?? "-"), run \(h.model.openRunId ?? "-")"))
    // ⌘↩ on the first result: no splits yet, so it opens it as ↩ does.
    steps.append(await openPalette("reopen"))
    steps += await type(query, prefix: "retype")
    let first = h.model.paletteShown.first
    steps.append(await enter("cmd-return", split: true))
    checks.append(Check("split-falls-back", !h.model.paletteOpen && opened(first), "⌘↩ on \(first.map { "\($0.item.id)" } ?? "-"): focused \(h.model.focusedAgent ?? "-"), run \(h.model.openRunId ?? "-")"))
    // Esc closes; then the palette again, at rest, for the snapshot guard.
    steps.append(await openPalette("open-esc"))
    steps.append(await esc("esc"))
    checks.append(Check("esc-closes", !h.model.paletteOpen && !self.shown, "palette open \(h.model.paletteOpen), shown \(self.shown)"))
    steps.append(await openPalette("rest"))
    steps += await type(query, prefix: "rest-type")
    checks.append(drawnCheck())
    return (steps, checks)
  }

  /// The result's target is what the window shows now: its agent focused in its run, or its project open.
  func opened(_ hit: SearchHit?) -> Bool {
    guard let hit else { return false }
    switch hit.item.action {
    case .agent(let run, let agent): return h.model.openRunId == run && h.model.focusedAgent == agent
    case .project(let run): return h.model.openRunId == run
    default: return !h.model.paletteOpen
    }
  }
}
