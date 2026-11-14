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
  /// The panel showing now, if any.
  var panel: SearchPanel? { SearchPanelController.shown.flatMap { $0.isVisible ? $0 : nil } }

  /// ⌘K, as the menu runs it, and the frame that shows the panel with its results.
  func openPalette(_ name: String) async -> StepResult {
    if h.model.paletteOpen { h.model.closePalette(); _ = await h.nextCommit() }
    let m = h.begin(name)
    let t = h.now()
    h.model.togglePalette()
    // The panel is ordered in on the update that follows the model change.
    _ = await h.wait(timeoutMs: 2000) { self.panel != nil }
    let shown = await h.nextCommit()
    let notes = ["\(h.model.search.index.count) items indexed in \(Stats.round(h.model.search.lastIndexMs, 2)) ms", "\(h.model.paletteShown.count) results"]
    return h.end(m, latencyMs: shown - t, notes: notes)
  }

  /// One key handed to the panel (as AppKit would deliver it), and the frame that shows what it did.
  func key(_ name: String, chars: String, code: UInt16, mods: NSEvent.ModifierFlags = []) async -> StepResult {
    let m = h.begin(name)
    let t = h.now()
    if let p = panel, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: mods, timestamp: ProcessInfo.processInfo.systemUptime,
                                               windowNumber: p.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                               isARepeat: false, keyCode: code) {
      p.sendEvent(e)
    }
    let shown = await h.nextCommit()
    return h.end(m, latencyMs: shown - t, notes: ["query \"\(h.model.paletteQuery)\" → \(h.model.paletteShown.count) results in \(Stats.round(h.model.search.lastQueryMs, 3)) ms"])
  }

  /// Types `text` one character at a time into the panel's field.
  func type(_ text: String, prefix: String) async -> [StepResult] {
    var out: [StepResult] = []
    for (i, c) in text.enumerated() { out.append(await key("\(prefix)#\(i) '\(c)'", chars: String(c), code: 0)) }
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
    guard let p = panel, let v = p.contentView, let rep = v.bitmapImageRepForCachingDisplay(in: v.bounds) else {
      return Check("panel-drawn", false, "no palette panel on screen")
    }
    v.cacheDisplay(in: v.bounds, to: rep)
    var ink = 0, n = 0
    let stepX = max(1, rep.pixelsWide / 160), stepY = max(1, rep.pixelsHigh / 120)
    for y in stride(from: 0, to: rep.pixelsHigh, by: stepY) {
      for x in stride(from: 0, to: rep.pixelsWide, by: stepX) {
        n += 1
        if let c = rep.colorAt(x: x, y: y), c.brightnessComponent > 0.5 { ink += 1 }
      }
    }
    let share = Double(ink) / Double(max(n, 1))
    let rows = h.model.paletteShown.count
    return Check("panel-drawn", share > 0.005 && rows > 0 && p.frame.height > 120,
                 "\(Stats.round(share * 100, 2)) % of the panel is text; \(rows) results; panel \(Int(p.frame.width))×\(Int(p.frame.height)) pt, key \(p.isKeyWindow)")
  }

  // MARK: palette-open

  /// ⌘K repeatedly on the empty search, and Esc between: open to first frame, and what the empty search offers.
  func paletteOpen() async -> ([StepResult], [Check]) {
    var steps: [StepResult] = [], checks: [Check] = []
    var escOK = true
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
      let esc = await key("esc#\(i)", chars: "\u{1b}", code: 53)
      steps.append(esc)
      escOK = escOK && !h.model.paletteOpen && panel == nil
      await h.sleep(ms: 120)
    }
    checks.append(Check("esc-closes", escOK, escOK ? "Esc closed the palette and its panel every time" : "the palette or its panel stayed open after Esc"))
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
    steps.append(await key("down#0", chars: String(UnicodeScalar(NSDownArrowFunctionKey)!), code: 125, mods: [.function, .numericPad]))
    steps.append(await key("down#1", chars: String(UnicodeScalar(NSDownArrowFunctionKey)!), code: 125, mods: [.function, .numericPad]))
    steps.append(await key("up#0", chars: String(UnicodeScalar(NSUpArrowFunctionKey)!), code: 126, mods: [.function, .numericPad]))
    let shown = h.model.paletteShown
    checks.append(Check("selection", h.model.paletteSelection == 1 && shown.count > 2, "selection \(h.model.paletteSelection) of \(shown.count) after ↓ ↓ ↑"))
    // ↩: the selected result opens and the palette closes.
    let target = shown.indices.contains(1) ? shown[1] : nil
    steps.append(await key("return", chars: "\r", code: 36))
    checks.append(Check("return-opens", !h.model.paletteOpen && opened(target), "↩ on \(target.map { "\($0.item.id)" } ?? "-"): focused \(h.model.focusedAgent ?? "-"), run \(h.model.openRunId ?? "-")"))
    // ⌘↩ on the first result: no splits yet, so it opens it as ↩ does.
    steps.append(await openPalette("reopen"))
    steps += await type(query, prefix: "retype")
    let first = h.model.paletteShown.first
    steps.append(await key("cmd-return", chars: "\r", code: 36, mods: .command))
    checks.append(Check("split-falls-back", !h.model.paletteOpen && opened(first), "⌘↩ on \(first.map { "\($0.item.id)" } ?? "-"): focused \(h.model.focusedAgent ?? "-"), run \(h.model.openRunId ?? "-")"))
    // Esc closes; then the palette again, at rest, for the snapshot guard.
    steps.append(await openPalette("open-esc"))
    steps.append(await key("esc", chars: "\u{1b}", code: 53))
    checks.append(Check("esc-closes", !h.model.paletteOpen && panel == nil, "palette open \(h.model.paletteOpen), panel \(panel == nil ? "hidden" : "shown")"))
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
