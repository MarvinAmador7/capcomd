import AppKit
import CapcomdStore
import CapcomdDesk
import DeskBenchKit

/// The Needs you reel's scenarios (DeskBenchKit/Scenarios.swift, `needs-*`), on the `needs5` / `needs20` fixtures.
/// Answers arrive as the daemon sends them after a decision (`approval.decided`, `agent.resumed`); each rep starts with
/// every fixture ask asking again (fresh approval ids, the same ask times) and the reel closed.
extension Drive {
  var needs: NeedsReel { h.model.needs }

  /// The fixture's asks asking again, any other answered, the reel closed and the window at rest.
  func needsReset() async {
    if needs.isOpen { h.model.closeNeedsReel() }
    let fixture = world.askFrames
    let asking = Set(h.store.needsAsks().map(\.agentId))
    let mine = Set(fixture.map(\.agentId))
    for a in h.store.needsAsks() where !mine.contains(a.agentId) { answer(a) }
    for f in fixture where !asking.contains(f.agentId) {
      let seq = h.nextSeq()
      h.store.receive(.event(f.envelope(seq: seq, approvalId: f.approvalId.map { "\($0)-r\(seq)" })), scope: f.runId)
    }
    _ = await h.nextCommit()
    _ = await h.waitQuiet(quietMs: 150, timeoutMs: 3000)
  }

  /// What the daemon sends once an ask is answered: the approval decided, or the paused agents running again.
  func answer(_ a: NeedsAsk) {
    switch a.kind {
    case .approval(let ap):
      let f = Fixtures.decidedFrame(runId: a.runId, approvalId: ap.id, seq: h.nextSeq())
      h.store.receive(.event(f.envelope), scope: f.scope)
    case .limit(let l):
      for id in l.agentIds {
        let seq = h.nextSeq()
        h.store.receive(.event(Envelope(id: "res-\(seq)", scope: a.runId, seq: seq, entity: id, type: "agent.resumed", epochMs: Int(Date().timeIntervalSince1970 * 1000),
                                        projectId: nil, runId: a.runId, agentId: id, data: [:])), scope: a.runId)
      }
    }
  }

  /// Opens the reel outside a measured step and lets it settle (its columns built, their threads read).
  func openNeedsSettled() async {
    h.columnsSince = h.now()
    h.model.openNeedsReel()
    _ = await h.nextCommit()
    await h.sleep(ms: 200)
    _ = await h.waitQuiet(quietMs: 200, timeoutMs: 4000)
  }

  // MARK: needs-open

  func needsOpen() async -> ([StepResult], [Check]) {
    var steps: [StepResult] = []; var ordered = true, shown = true; var detail: [String] = []
    for i in 0..<int("opens", 3) {
      await needsReset()
      let expected = h.store.needsAsks().map(\.agentId)
      let m = h.begin("needs-open#\(i) \(expected.count) asks")
      let t = h.now()
      h.columnsSince = t
      h.model.openNeedsReel()
      // The first frame that shows the reel with its columns (a busy main thread can commit once before it's in).
      var committed = await h.nextCommit()
      for _ in 0..<30 where h.needsReel()?.columnCount != expected.count { committed = await h.nextCommit() }
      let cols = needs.columns
      let reel = h.needsReel()
      if cols != expected { ordered = false; detail.append("open#\(i): columns \(cols) vs asks oldest first \(expected)") }
      if reel?.columnCount != expected.count || needs.reelPosition != expected.first { shown = false; detail.append("open#\(i): the reel has \(reel?.columnCount ?? -1) columns, leading \(needs.reelPosition ?? "-")") }
      await h.sleep(ms: 300)
      steps.append(h.end(m, latencyMs: committed - t, notes: ["\(cols.count) columns in the first frame; leading \(needs.reelPosition ?? "-"); focused \(h.model.focusedAgent ?? "-")"]))
    }
    return (steps, [Check("ordered", ordered, ordered ? "the columns were every ask, oldest first, every time" : detail.joined(separator: "; ")),
                    Check("columns-shown", shown, shown ? "the reel had a column per ask, the oldest leading" : detail.joined(separator: "; "))])
  }

  // MARK: needs-answer

  /// Answers the focused column's ask; its column slides out, the next takes its place and the focus.
  func answerFocused(_ i: Int, label: String) async -> (StepResult, ok: (left: Bool, order: Bool, next: Bool), note: String)? {
    let before = needs.columns
    guard let target = h.model.focusedAgent.flatMap({ before.contains($0) ? $0 : nil }) ?? before.first, let ask = needs.ask(target) else { return nil }
    let lead = needs.reelPosition
    let m = h.begin("\(label)#\(i) \(ask.approval?.kind ?? "limit")")
    let t = h.now()
    answer(ask)
    let (started, settled) = await h.waitReelSettled(since: t, timeoutMs: 1500) { self.needs.reelMoving }
    let after = needs.columns
    let idx = before.firstIndex(of: target) ?? 0
    let expectedNext = after.isEmpty ? nil : after[min(idx, after.count - 1)]
    let left = !after.contains(target)
    let order = after == before.filter { $0 != target }
    let next = h.model.focusedAgent == expectedNext && (lead == target ? needs.reelPosition == expectedNext || after.count <= needs.across : needs.reelPosition == lead)
    let note = "answered \(target) (\(before.count) → \(after.count) columns); focus \(h.model.focusedAgent ?? "-") (expected \(expectedNext ?? "-")); leading \(needs.reelPosition ?? "-")"
    let s = h.end(m, latencyMs: started.map { $0 - t }, settleMs: settled.map { $0 - t }, notes: [note] + (started == nil ? ["the reel never reported moving (nothing slid)"] : []))
    return (s, (left, order, next), note)
  }

  func needsAnswer() async -> ([StepResult], [Check]) {
    await needsReset()
    await openNeedsSettled()
    let n = min(int("answers", 3), max(0, needs.columns.count - 1))
    guard n > 0 else { return ([], [Check("enough-asks", false, "the fixture has \(needs.columns.count) asks; answering needs two or more")]) }
    var steps: [StepResult] = []; var left = true, order = true, next = true; var notes: [String] = []
    for i in 0..<n {
      guard let (s, ok, note) = await answerFocused(i, label: "needs-answer") else { break }
      steps.append(s); left = left && ok.left; order = order && ok.order; next = next && ok.next
      if !(ok.left && ok.order && ok.next) { notes.append(note) }
      await h.sleep(ms: 200)
    }
    let why = notes.isEmpty ? "" : notes.joined(separator: "; ")
    return (steps, [Check("enough-asks", true, "\(n) answers"), Check("left", left, left ? "every answered column left the reel" : why),
                    Check("order-kept", order, order ? "the other columns kept their order" : why),
                    Check("next-leads", next, next ? "the next column took the answered one's place and its focus" : why)])
  }

  // MARK: needs-arrive

  func needsArrive() async -> ([StepResult], [Check]) {
    await needsReset()
    await openNeedsSettled()
    let cols = needs.columns
    guard cols.count >= 2, let reel = h.needsReel() else { return ([], [Check("joined-at-end", false, "fewer than two asks")]) }
    let lead = cols[1]
    needs.lead(lead)
    _ = await h.nextCommit()
    _ = await h.waitQuiet(quietMs: 150, timeoutMs: 2000)
    let asking = Set(h.store.needsAsks().map(\.agentId))
    let candidates = world.runIds.flatMap { r in (world.agents[r] ?? []).map { (r, $0) } }.filter { !asking.contains($0.1) }
    var steps: [StepResult] = []; var atEnd = true, unmoved = true; var notes: [String] = []
    for i in 0..<min(int("arrivals", 3), candidates.count) {
      let (runId, who) = candidates[(i * 7) % candidates.count]
      guard let li = needs.columns.firstIndex(of: lead), let v = reel.columnView(at: li) else { break }
      let x0 = v.convert(v.bounds, to: nil).minX
      let seq = h.nextSeq()
      // Odd arrivals carry an older time than every ask: they still join at the end.
      let at = i % 2 == 1 ? 1_000 : Int(Date().timeIntervalSince1970 * 1000)
      let e = Envelope(id: "arrive-\(seq)", scope: runId, seq: seq, entity: who, type: "approval.requested", epochMs: at, projectId: nil, runId: runId, agentId: who,
                       data: ["approvalId": .string("bench-arrive-\(seq)"), "kind": .string("custom"), "question": .string("Ship the backfill now or after the freeze?"),
                              "requestedBy": .object(["agentId": .string(who), "runId": .string(runId)])])
      let m = h.begin("needs-arrive#\(i)")
      let t = h.now()
      h.store.receive(.event(e), scope: runId)
      let shown = await h.nextCommit()
      await h.sleep(ms: 250)
      let li2 = needs.columns.firstIndex(of: lead)
      let x1 = li2.flatMap { reel.columnView(at: $0) }.map { $0.convert($0.bounds, to: nil).minX }
      let end = needs.columns.last == who
      let still = needs.reelPosition == lead && x1.map { abs($0 - x0) < 0.5 } == true
      atEnd = atEnd && end; unmoved = unmoved && still
      let note = "arrived \(who): last \(needs.columns.last ?? "-"); leading \(needs.reelPosition ?? "-") at x \(Stats.round(x0, 1)) → \(x1.map { String(Stats.round($0, 1)) } ?? "gone")"
      if !(end && still) { notes.append(note) }
      steps.append(h.end(m, latencyMs: shown - t, notes: [note]))
    }
    return (steps, [Check("joined-at-end", atEnd, atEnd ? "every new ask joined at the end" : notes.joined(separator: "; ")),
                    Check("unmoved", unmoved, unmoved ? "the column being read kept its place in the window" : notes.joined(separator: "; "))])
  }

  // MARK: needs-step (⌘J)

  func needsStep() async -> ([StepResult], [Check]) {
    await needsReset()
    await openNeedsSettled()
    var steps: [StepResult] = []; var inReel = true, oldest = true; var notes: [String] = []
    let cols = needs.columns
    for i in 0..<cols.count {
      let at = h.model.focusedAgent.flatMap { cols.firstIndex(of: $0) } ?? -1
      let expected = cols[(at + 1) % cols.count]
      let m = h.begin("needs-step reel#\(i)")
      let t = h.now()
      h.model.nextAsk()
      let shown = await h.nextCommit()
      if h.model.focusedAgent != expected { inReel = false; notes.append("in the reel: focus \(h.model.focusedAgent ?? "-"), expected \(expected)") }
      steps.append(h.end(m, latencyMs: shown - t, notes: ["focus \(h.model.focusedAgent ?? "-")"]))
      await h.sleep(ms: 80)
    }
    // Outside the reel: from nothing in front of you, each ask opens in turn, oldest first, then the oldest again.
    h.model.closeNeedsReel()
    h.model.focusedAgent = nil
    needs.cursor = nil
    _ = await h.nextCommit()
    let asks = h.store.needsAsks()
    for i in 0..<(asks.count + 1) {
      let a = asks[i % asks.count]
      let m = h.begin("needs-step open#\(i)")
      let t = h.now()
      h.model.nextAsk()
      let shown = await h.nextCommit()
      if h.model.openRunId != a.runId || h.model.focusedAgent != a.agentId {
        oldest = false; notes.append("open#\(i): \(h.model.openRunId ?? "-")/\(h.model.focusedAgent ?? "-"), expected \(a.runId)/\(a.agentId)")
      }
      await h.sleep(ms: 150)
      steps.append(h.end(m, latencyMs: shown - t, notes: ["opened \(h.model.openRunId ?? "-") at \(h.model.focusedAgent ?? "-")"]))
    }
    return (steps, [Check("in-reel", inReel, inReel ? "⌘J focused each next column in turn, round again" : notes.joined(separator: "; ")),
                    Check("oldest-first", oldest, oldest ? "⌘J opened every ask in turn, oldest first, then the oldest again" : notes.joined(separator: "; "))])
  }

  // MARK: needs-empty, Esc back

  func needsEmpty() async -> ([StepResult], [Check]) {
    await needsReset()
    let project = h.model.openProjectId, focus = h.model.focusedAgent
    await openNeedsSettled()
    var steps: [StepResult] = []; var i = 0
    while !needs.columns.isEmpty, i < 64 {
      guard let (s, _, _) = await answerFocused(i, label: "needs-empty") else { break }
      steps.append(s); i += 1
      await h.sleep(ms: 60)
    }
    _ = await h.nextCommit()
    await h.sleep(ms: 100)
    let seen = h.bodies.suffix(400).contains { $0.view == "NothingNeedsYou" }
    let nothing = needs.isOpen && needs.columns.isEmpty && seen
    // Esc: a key event handed to this window, as AppKit routes a key (its key equivalents, then the main menu).
    let m = h.begin("needs-empty esc")
    let t = h.now()
    if let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: h.window.windowNumber,
                                context: nil, characters: "\u{1b}", charactersIgnoringModifiers: "\u{1b}", isARepeat: false, keyCode: 53) {
      if !h.window.performKeyEquivalent(with: e), NSApp.mainMenu?.performKeyEquivalent(with: e) != true { h.window.firstResponder?.keyDown(with: e) }
    }
    let shown = await h.nextCommit()
    let back = !needs.isOpen && h.model.openProjectId == project && h.model.focusedAgent == focus
    steps.append(h.end(m, latencyMs: shown - t, notes: ["open \(needs.isOpen); project \(h.model.openProjectId ?? "-"); focus \(h.model.focusedAgent ?? "-") (was \(focus ?? "-"))"]))
    return (steps, [Check("nothing-needs-you", nothing, "after \(i) answers: \(needs.columns.count) columns, \"Nothing needs you.\" drawn \(seen)"),
                    Check("esc-back", back, back ? "Esc closed the reel; the project and the focus came back" : "after Esc: open \(needs.isOpen), project \(h.model.openProjectId ?? "-") (was \(project ?? "-")), focus \(h.model.focusedAgent ?? "-") (was \(focus ?? "-"))")])
  }

  // MARK: needs-swipe

  func needsSwipe() async -> ([StepResult], [Check]) {
    await needsReset()
    await openNeedsSettled()
    return await swipe(needs: true)
  }
}
