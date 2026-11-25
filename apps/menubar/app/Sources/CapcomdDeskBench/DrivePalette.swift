import AppKit
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// Search ⌘K's scenarios (`palette-first`, `palette-open`, `palette-type`, `palette-keys`), on a fixture with hundreds of searchable items
/// (`search`: 60 projects, ~200 agents, asks, the commands). ⌘K is pressed through the app's menu bar (`run.press`:
/// Project › Search…); every key after that is real input on the app's own event queue (`run.type`, `run.key`), to
/// whatever has the keyboard: the palette's field editor, its key handling. Each step's latency is to the first frame
/// after what the key did held; checks read the UI's own state, and the palette is an ink region (its own panel with
/// `search.host=panel`, its own hosting view in the window otherwise, drawn alone).
@MainActor struct Palette {
  let d: Desk
  var run: HostRun { d.run }
  var model: DeskModel { d.model }

  /// The panel showing now, if any (knob search.host=panel).
  var panel: SearchPanel? { SearchPanelController.shown.flatMap { $0.isVisible ? $0 : nil } }
  var inPanel: Bool { DeskKnobs.searchHost.value == .panel }
  /// The palette shows: its panel, or (in the window) the model says so.
  var shown: Bool { inPanel ? panel != nil : model.paletteOpen }

  /// The palette as an ink region: the panel's content, or in the window the palette's own hosting view drawn by
  /// itself (`drawnAlone`: its ink is its own, not the reel's behind it).
  func region() -> InkRegion {
    if inPanel { return .find("palette") { [self] in panel?.contentView } }
    return InkRegion.find("palette") { [d] in
      var found: NSView?
      d.walk(d.content) { if found == nil, $0 is SearchOverlayHost, !$0.isHiddenOrHasHiddenAncestor { found = $0 } }
      return found
    }.drawnAlone()
  }

  /// ⌘K through the menu bar (Project › Search…), and the frame that shows the palette with its results.
  func open(_ name: String) async {
    if model.paletteOpen { model.closePalette(); _ = await d.nextCommit() }
    // The keys after it reach the palette only while the window has the keyboard: start from there.
    if !d.window.isKeyWindow { d.window.makeKeyAndOrderFront(nil); _ = await d.nextCommit() }
    await run.press("⌘K", expect: "Search…", name: name, timeoutMs: 3000, until: { model.paletteOpen && shown })
    await run.ink([region()], after: name)
  }

  /// A key on the app's queue, and the frame after what it did (`done`) held.
  func key(_ key: HostRun.Key, modifiers: NSEvent.ModifierFlags = [], name: String, done: @escaping () -> Bool) async {
    await run.key(key, modifiers: modifiers, name: name, timeoutMs: 3000, until: done)
  }
  func esc(_ name: String) async { await key(.escape, name: name) { !model.paletteOpen } }
  func arrow(_ name: String, down: Bool) async {
    let want = max(0, min(model.paletteShown.count - 1, model.paletteSelection + (down ? 1 : -1)))
    await key(down ? .down : .up, name: name) { model.paletteSelection == want }
  }
  func enter(_ name: String, split: Bool) async { await key(.return, modifiers: split ? .command : [], name: name) { !model.paletteOpen } }

  /// Types `text` one character at a time into whatever has the keyboard (the palette's field): a step per key.
  func type(_ text: String, prefix: String) async {
    let start = model.paletteQuery
    for (i, c) in text.enumerated() {
      let want = start + String(text.prefix(i + 1))
      await run.type(String(c), name: "\(prefix)#\(i) '\(c)'", timeoutMs: 3000, until: { model.paletteQuery == want })
    }
  }

  /// The results are ranked as the board says: groups in attention order, each by score, every word matched, capped.
  func rankingCheck(_ query: String) -> Check {
    let secs = model.search.sections
    let order = secs.map(\.group.rawValue)
    var why: [String] = []
    if order != order.sorted() || Set(order).count != order.count { why.append("groups out of order: \(secs.map(\.group.title))") }
    for s in secs {
      let scores = s.hits.map(\.score)
      if scores != scores.sorted(by: >) { why.append("\(s.group.title) not by score") }
      if s.hits.count > SearchIndex.groupCap { why.append("\(s.group.title) over the cap") }
    }
    // What each result shows in semibold spells what was typed, in order (one word typed here).
    let unmatched = model.paletteShown.filter { hit in
      func spelled(_ text: String, _ at: [Int]) -> String { let cs = Array(text); return String(at.compactMap { cs.indices.contains($0) ? cs[$0] : nil }) }
      let shown = spelled(hit.item.title.text, hit.titleHits) + spelled(hit.item.subtitle?.text ?? "", hit.subtitleHits)
      return shown.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) != query.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil)
    }
    if !unmatched.isEmpty { why.append("\(unmatched.count) results don't spell the query in what they mark (first: \(unmatched[0].item.title.text))") }
    let asking = Set(model.search.index.asks.compactMap(\.agentId))
    if model.paletteShown.contains(where: { $0.group == .agents && asking.contains($0.item.agentId ?? "") }) { why.append("an agent that needs you also shows under Agents") }
    return Check("ranking", why.isEmpty && !secs.isEmpty, why.isEmpty ? "\(secs.map { "\($0.group.title) \($0.hits.count)" }.joined(separator: ", ")) for \"\(query)\"" : why.joined(separator: "; "))
  }

  /// The result's target is what the window shows now: its agent focused in its run, or its project open.
  func opened(_ hit: SearchHit?) -> Bool {
    guard let hit else { return false }
    switch hit.item.action {
    case .agent(let r, let agent): return model.openRunId == r && model.focusedAgent == agent
    case .project(let r): return model.openRunId == r
    default: return !model.paletteOpen
    }
  }

  /// The desk, shown, its reel built and its threads warmed: a step measures the palette, not the window settling.
  static func make(_ run: HostRun) async throws -> Palette {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    // Snapshots end with the palette up: a child panel is drawn into them; the overlay is in the window anyway.
    run.atClose { d.model.closePalette() }
    return Palette(d: d)
  }

  // MARK: palette-first

  /// The first ⌘K after the window opens: the rep's desk shown and its warming done (the threads of the columns on
  /// screen and next to them: no main-thread stretch over 2 ms for 300 ms), then ⌘K is the first thing pressed, once.
  /// The palette has never shown in this window, so this is the open that pays for whatever the palette hasn't built
  /// yet. One measured step: the scenario's latency is that ⌘K's. The palette stays up for the snapshot.
  static func paletteFirst(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.quiet()
    run.atClose { d.model.closePalette() }
    let p = Palette(d: d)
    // AppKit's first-use work done ahead, at rest (AppKitWarmup; knob desk.prewarm): what each took, before the ⌘K.
    let warm = { (name: String) in d.events.last { $0.name == name }?.value }
    let k = DeskKnobs.prewarm.value
    let menuUs = warm("warm.menu.us"), fieldUs = warm("warm.field.us")
    let warmed = (!k.menu || menuUs != nil) && (!k.field || fieldUs != nil) && warm("warm.menu.fired") == nil && warm("warm.field.refused") == nil
    let took = { (us: Int?) in us.map { "\(Stats.round(Double($0) / 1000, 2)) ms" } ?? "not done" }
    await p.open("first")
    let groups = p.model.search.sections.map(\.group)
    let asks = p.model.search.index.asks.count
    run.regions([p.region()])
    run.record([
      Check("warmed-ahead", warmed, "desk.prewarm=\(k.rawValue): the menu's first key equivalent \(took(menuUs))\(warm("warm.menu.fired") != nil ? " (an item fired)" : "")\(warm("warm.menu.skipped").map { " (skipped: \($0 == 2 ? "an item has the key" : "no event"))" } ?? ""), the first field focus \(took(fieldUs))\(warm("warm.field.refused") != nil ? " (refused)" : ""), before ⌘K"),
      Check("shown", p.model.paletteOpen && p.shown, "palette open \(p.model.paletteOpen), shown \(p.shown)"),
      Check("items", p.model.search.index.count >= 200, "\(p.model.search.index.count) searchable items (agents, projects, asks, commands)"),
      Check("empty-search", groups.first == (asks > 0 ? .needsYou : .recent) && groups.last == .commands && groups == groups.sorted(),
            "groups \(groups.map(\.title)); \(asks) asks"),
    ])
  }

  // MARK: palette-open

  /// ⌘K repeatedly on the empty search, and Esc between: open to first frame, and what the empty search offers.
  static func paletteOpen(_ run: HostRun) async throws {
    let p = try await make(run)
    var checks: [Check] = []
    var escFailed: [Int] = []
    for i in 0..<run.int("opens", 6) {
      await p.open("open#\(i)")
      if i == 0 {
        let groups = p.model.search.sections.map(\.group)
        let asks = p.model.search.index.asks.count
        checks.append(Check("items", p.model.search.index.count >= 200, "\(p.model.search.index.count) searchable items (agents, projects, asks, commands)"))
        checks.append(Check("empty-search", groups.first == (asks > 0 ? .needsYou : .recent) && groups.last == .commands && groups == groups.sorted(),
                            "groups \(groups.map(\.title)); \(asks) asks"))
      }
      await p.esc("esc#\(i)")
      if p.model.paletteOpen || p.shown { escFailed.append(i) }
    }
    checks.append(Check("esc-closes", escFailed.isEmpty, escFailed.isEmpty ? "Esc closed the palette every time" : "the palette stayed open after Esc at open \(escFailed) (window key \(p.d.window.isKeyWindow))"))
    // At rest with the palette open, for the snapshot.
    await p.open("reopen")
    run.regions([p.region()])
    run.record(checks)
  }

  // MARK: palette-type

  /// A query typed a character at a time: each keystroke to the frame that shows its results.
  static func paletteType(_ run: HostRun) async throws {
    let p = try await make(run)
    let query = run.param("query") ?? "matchkey"
    await p.open("open")
    await p.type(query, prefix: "type")
    await run.ink([p.region()], after: "typed")
    run.regions([p.region()])
    run.record([Check("typed", p.model.paletteQuery == query, "the field holds \"\(p.model.paletteQuery)\" (typed \"\(query)\")"), p.rankingCheck(query)])
  }

  // MARK: palette-keys

  /// ↓ ↓ ↑ move the selection; ↩ opens it; ⌘↩ opens (folded, as ↩ does; opened, in a split); Esc closes.
  static func paletteKeys(_ run: HostRun) async throws {
    let p = try await make(run)
    let query = run.param("query") ?? "shard"
    var checks: [Check] = []
    await p.open("open")
    await p.type(query, prefix: "type")
    await p.arrow("down#0", down: true)
    await p.arrow("down#1", down: true)
    await p.arrow("up#0", down: false)
    let results = p.model.paletteShown
    checks.append(Check("selection", p.model.paletteSelection == 1 && results.count > 2, "selection \(p.model.paletteSelection) of \(results.count) after ↓ ↓ ↑"))
    // ↩: the selected result opens and the palette closes.
    let target = results.indices.contains(1) ? results[1] : nil
    await p.enter("return", split: false)
    checks.append(Check("return-opens", !p.model.paletteOpen && p.opened(target), "↩ on \(target.map { "\($0.item.id)" } ?? "-"): focused \(p.model.focusedAgent ?? "-"), run \(p.model.openRunId ?? "-")"))
    // ⌘↩ on the first result, folded: it opens it as ↩ does (splits are the opened window's).
    await p.open("reopen")
    await p.type(query, prefix: "retype")
    let first = p.model.paletteShown.first
    await p.enter("cmd-return", split: true)
    checks.append(Check("split-falls-back", !p.model.paletteOpen && p.opened(first), "⌘↩ on \(first.map { "\($0.item.id)" } ?? "-"): focused \(p.model.focusedAgent ?? "-"), run \(p.model.openRunId ?? "-")"))
    // Esc closes; then the palette again, at rest, for the snapshot.
    await p.open("open-esc")
    await p.esc("esc")
    checks.append(Check("esc-closes", !p.model.paletteOpen && !p.shown, "palette open \(p.model.paletteOpen), shown \(p.shown)"))
    await p.open("rest")
    await p.type(query, prefix: "rest-type")
    await run.ink([p.region()], after: "rest")
    run.regions([p.region()])
    run.record(checks)
  }
}
