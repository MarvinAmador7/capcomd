import AppKit
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// The Needs you reel's scenarios (DeskBenchKit/Scenarios.swift, `needs-*`), on the `needs5` / `needs20` fixtures.
/// Answers arrive as the daemon sends them after a decision (`approval.decided`, `agent.resumed`); each rep starts with
/// every fixture ask asking and the reel closed. The reel is the scenarios' ink region.
@MainActor enum NeedsDrive {
  /// The fixture's asks asking, any other answered, the reel closed and the window at rest.
  static func reset(_ d: Desk) async {
    if d.model.needs.isOpen { d.model.closeNeedsReel() }
    let asking = Set(d.store.needsAsks().map(\.agentId))
    let mine = Set(d.world.askFrames.map(\.agentId))
    for a in d.store.needsAsks() where !mine.contains(a.agentId) { answer(d, a) }
    for f in d.world.askFrames where !asking.contains(f.agentId) {
      let seq = d.nextSeq()
      d.store.receive(.event(f.envelope(seq: seq, approvalId: f.approvalId.map { "\($0)-r\(seq)" })), scope: f.runId)
    }
    _ = await d.nextCommit()
    await d.quiet(quietMs: 150, timeoutMs: 3000)
  }

  /// What the daemon sends once an ask is answered: the approval decided, or the paused agents running again.
  static func answer(_ d: Desk, _ a: NeedsAsk) {
    switch a.kind {
    case .approval(let ap):
      let f = Fixtures.decidedFrame(runId: a.runId, approvalId: ap.id, seq: d.nextSeq())
      d.store.receive(.event(f.envelope), scope: f.scope)
    case .limit(let l):
      for id in l.agentIds {
        let seq = d.nextSeq()
        d.store.receive(.event(Envelope(id: "res-\(seq)", scope: a.runId, seq: seq, entity: id, type: "agent.resumed", epochMs: Int(Date().timeIntervalSince1970 * 1000),
                                        projectId: nil, runId: a.runId, agentId: id, data: [:])), scope: a.runId)
      }
    }
  }

  static func make(_ run: HostRun) async throws -> Desk {
    let d = try Desk(run)
    try await d.show()
    await reset(d)
    return d
  }

  /// Opens the reel outside a measured step and lets it settle (its columns built, their threads read).
  static func openSettled(_ d: Desk) async {
    d.columnsSince = d.run.now
    d.model.openNeedsReel()
    _ = await d.run.wait(timeoutMs: 2000) { d.reel(.needs) != nil }
    await d.quiet(quietMs: 200, timeoutMs: 4000)
  }

  // MARK: needs-open

  static func needsOpen(_ run: HostRun) async throws {
    let d = try await make(run)
    var ordered = true, shown = true, detail: [String] = []
    for i in 0..<run.int("opens", 3) {
      await reset(d)
      let expected = d.store.needsAsks().map(\.agentId)
      var t = 0.0
      // The first frame after the reel's view took the columns (its `needs.shown` probe event).
      await run.step("needs-open#\(i) \(expected.count) asks", until: { d.events.contains { $0.name == "needs.shown" && $0.value == expected.count && $0.t >= t } }, ink: [d.needsRegion]) {
        t = run.now
        d.columnsSince = t
        d.model.openNeedsReel()
      }
      let cols = d.model.needs.columns
      let reel = d.reel(.needs)
      if cols != expected { ordered = false; detail.append("open#\(i): columns \(cols) vs asks oldest first \(expected)") }
      if reel?.columnCount != expected.count || d.model.needs.reelPosition != expected.first {
        shown = false; detail.append("open#\(i): the reel has \(reel?.columnCount ?? -1) columns, leading \(d.model.needs.reelPosition ?? "-")")
      }
    }
    run.regions([d.needsRegion])
    run.record([Check("ordered", ordered, ordered ? "the columns were every ask, oldest first, every time" : detail.joined(separator: "; ")),
                Check("columns-shown", shown, shown ? "the reel had a column per ask, the oldest leading" : detail.joined(separator: "; "))])
  }

  // MARK: needs-answer

  /// Answers the focused column's ask; its column slides out, the next takes its place and the focus.
  static func answerFocused(_ d: Desk, _ i: Int, label: String) async -> (ok: (left: Bool, order: Bool, next: Bool), note: String)? {
    let needs = d.model.needs
    let before = needs.columns
    guard let target = d.model.focusedAgent.flatMap({ before.contains($0) ? $0 : nil }) ?? before.first, let ask = needs.ask(target) else { return nil }
    let lead = needs.reelPosition
    var t = 0.0
    await d.run.step("\(label)#\(i) \(ask.approval?.kind ?? "limit")", until: Drive.reelCycle(d, since: { t }, moving: { needs.reelMoving }), ink: [d.needsRegion]) {
      t = d.run.now
      answer(d, ask)
    }
    let after = needs.columns
    let idx = before.firstIndex(of: target) ?? 0
    let expectedNext = after.isEmpty ? nil : after[min(idx, after.count - 1)]
    let left = !after.contains(target)
    let order = after == before.filter { $0 != target }
    let next = d.model.focusedAgent == expectedNext && (lead == target ? needs.reelPosition == expectedNext || after.count <= needs.across : needs.reelPosition == lead)
    let note = "answered \(target) (\(before.count) → \(after.count) columns); focus \(d.model.focusedAgent ?? "-") (expected \(expectedNext ?? "-")); leading \(needs.reelPosition ?? "-")"
    return ((left, order, next), note)
  }

  static func needsAnswer(_ run: HostRun) async throws {
    let d = try await make(run)
    await openSettled(d)
    run.regions([d.needsRegion])
    let n = min(run.int("answers", 3), max(0, d.model.needs.columns.count - 1))
    let names = ["enough-asks", "left", "order-kept", "next-leads"]
    guard n > 0 else { return run.record(names.map { Check($0, false, "the fixture has \(d.model.needs.columns.count) asks; answering needs two or more") }) }
    var left = true, order = true, next = true, notes: [String] = []
    for i in 0..<n {
      guard let (ok, note) = await answerFocused(d, i, label: "needs-answer") else { break }
      left = left && ok.left; order = order && ok.order; next = next && ok.next
      if !(ok.left && ok.order && ok.next) { notes.append(note) }
    }
    let why = notes.joined(separator: "; ")
    run.record([Check("enough-asks", true, "\(n) answers"), Check("left", left, left ? "every answered column left the reel" : why),
                Check("order-kept", order, order ? "the other columns kept their order" : why),
                Check("next-leads", next, next ? "the next column took the answered one's place and its focus" : why)])
  }

  // MARK: needs-arrive

  static func needsArrive(_ run: HostRun) async throws {
    let d = try await make(run)
    await openSettled(d)
    run.regions([d.needsRegion])
    let needs = d.model.needs
    let cols = needs.columns
    guard cols.count >= 2, let reel = d.reel(.needs) else { return run.record([Check("joined-at-end", false, "fewer than two asks"), Check("unmoved", false, "fewer than two asks")]) }
    let lead = cols[1]
    needs.lead(lead)
    _ = await d.nextCommit()
    await d.quiet(quietMs: 150, timeoutMs: 2000)
    let asking = Set(d.store.needsAsks().map(\.agentId))
    let candidates = d.world.runIds.flatMap { r in (d.world.agents[r] ?? []).map { (r, $0) } }.filter { !asking.contains($0.1) }
    var atEnd = true, unmoved = true, notes: [String] = []
    for i in 0..<min(run.int("arrivals", 3), candidates.count) {
      let (runId, who) = candidates[(i * 7) % candidates.count]
      guard let li = needs.columns.firstIndex(of: lead), let v = reel.columnView(at: li) else { break }
      let x0 = v.convert(v.bounds, to: nil).minX
      let seq = d.nextSeq()
      // Odd arrivals carry an older time than every ask: they still join at the end.
      let at = i % 2 == 1 ? 1_000 : Int(Date().timeIntervalSince1970 * 1000)
      let e = Envelope(id: "arrive-\(seq)", scope: runId, seq: seq, entity: who, type: "approval.requested", epochMs: at, projectId: nil, runId: runId, agentId: who,
                       data: ["approvalId": .string("bench-arrive-\(seq)"), "kind": .string("custom"), "question": .string("Ship the backfill now or after the freeze?"),
                              "requestedBy": .object(["agentId": .string(who), "runId": .string(runId)])])
      await run.step("needs-arrive#\(i)", until: { needs.columns.last == who }, ink: [d.needsRegion]) { d.store.receive(.event(e), scope: runId) }
      let x1 = needs.columns.firstIndex(of: lead).flatMap { reel.columnView(at: $0) }.map { $0.convert($0.bounds, to: nil).minX }
      let end = needs.columns.last == who
      let still = needs.reelPosition == lead && x1.map { abs($0 - x0) < 0.5 } == true
      atEnd = atEnd && end; unmoved = unmoved && still
      if !(end && still) {
        notes.append("arrived \(who): last \(needs.columns.last ?? "-"); leading \(needs.reelPosition ?? "-") at x \(Stats.round(x0, 1)) → \(x1.map { String(Stats.round($0, 1)) } ?? "gone")")
      }
    }
    run.record([Check("joined-at-end", atEnd, atEnd ? "every new ask joined at the end" : notes.joined(separator: "; ")),
                Check("unmoved", unmoved, unmoved ? "the column being read kept its place in the window" : notes.joined(separator: "; "))])
  }

  // MARK: needs-step (⌘J)

  /// ⌘J's action (View › Next Ask, a menu item: the bench calls it) through the asks, in the reel and then outside it.
  static func needsStep(_ run: HostRun) async throws {
    let d = try await make(run)
    await openSettled(d)
    let needs = d.model.needs
    var inReel = true, oldest = true, notes: [String] = []
    let cols = needs.columns
    for i in 0..<cols.count {
      let at = d.model.focusedAgent.flatMap { cols.firstIndex(of: $0) } ?? -1
      let expected = cols[(at + 1) % cols.count]
      await run.step("needs-step reel#\(i)", until: { d.model.focusedAgent == expected }, ink: [d.needsRegion]) { d.model.nextAsk() }
      if d.model.focusedAgent != expected { inReel = false; notes.append("in the reel: focus \(d.model.focusedAgent ?? "-"), expected \(expected)") }
    }
    // Outside the reel: from nothing in front of you, each ask opens in turn, oldest first, then the oldest again.
    d.model.closeNeedsReel()
    d.model.focusedAgent = nil
    needs.cursor = nil
    _ = await d.nextCommit()
    await d.quiet(quietMs: 150, timeoutMs: 2000)
    let asks = d.store.needsAsks()
    for i in 0..<(asks.count + 1) {
      let a = asks[i % asks.count]
      await run.step("needs-step open#\(i)", until: { d.model.openRunId == a.runId && d.model.focusedAgent == a.agentId }, ink: [d.reelRegion]) { d.model.nextAsk() }
      if d.model.openRunId != a.runId || d.model.focusedAgent != a.agentId {
        oldest = false; notes.append("open#\(i): \(d.model.openRunId ?? "-")/\(d.model.focusedAgent ?? "-"), expected \(a.runId)/\(a.agentId)")
      }
    }
    run.regions([d.reelRegion])
    run.record([Check("in-reel", inReel, inReel ? "⌘J focused each next column in turn, round again" : notes.joined(separator: "; ")),
                Check("oldest-first", oldest, oldest ? "⌘J opened every ask in turn, oldest first, then the oldest again" : notes.joined(separator: "; "))])
  }

  // MARK: needs-empty, Esc back

  static func needsEmpty(_ run: HostRun) async throws {
    let d = try await make(run)
    let project = d.model.openProjectId, focus = d.model.focusedAgent
    // After Esc the project reel shows again: its columns were built when it opened (they stay built under the Needs
    // you reel), so `built-within` counts their bodies from then, not from when the Needs you reel opened.
    let since = d.columnsSince
    await openSettled(d)
    var i = 0
    while !d.model.needs.columns.isEmpty, i < 64 {
      guard await answerFocused(d, i, label: "needs-empty") != nil else { break }
      i += 1
    }
    _ = await run.wait(timeoutMs: 1000) { d.bodies.contains { $0.view == "NothingNeedsYou" } }
    let seen = d.bodies.contains { $0.view == "NothingNeedsYou" }
    let nothing = d.model.needs.isOpen && d.model.needs.columns.isEmpty && seen
    await run.ink([d.needsRegion], after: "answered all")
    // Esc: a real key on the app's queue (the reel's cancel shortcut takes it).
    await run.key(.escape, ink: [d.reelRegion], name: "needs-empty esc", timeoutMs: 3000, until: { !d.model.needs.isOpen })
    d.columnsSince = since
    let back = !d.model.needs.isOpen && d.model.openProjectId == project && d.model.focusedAgent == focus
    run.regions([d.reelRegion])
    run.record([Check("nothing-needs-you", nothing, "after \(i) answers: \(d.model.needs.columns.count) columns, \"Nothing needs you.\" drawn \(seen)"),
                Check("esc-back", back, back ? "Esc closed the reel; the project and the focus came back"
                                              : "after Esc: open \(d.model.needs.isOpen), project \(d.model.openProjectId ?? "-") (was \(project ?? "-")), focus \(d.model.focusedAgent ?? "-") (was \(focus ?? "-"))")])
  }

  // MARK: needs-swipe

  static func needsSwipe(_ run: HostRun) async throws {
    let d = try await make(run)
    await openSettled(d)
    try await Drive.swipe(run, d: d, needs: true)
  }
}
