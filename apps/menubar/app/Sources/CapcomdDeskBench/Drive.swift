import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdDesk
import DeskBenchKit

/// How each scenario is driven. Each returns the steps of one repetition plus its checks; `Runner` wraps them in
/// repetitions, noise sampling and the verdict.
@MainActor struct Drive {
  let h: Harness
  var params: [String: String]
  var world: World
  var fixtureRunId: String { world.openRunId ?? world.runIds[0] }

  func int(_ k: String, _ d: Int) -> Int { params[k].flatMap(Int.init) ?? d }

  /// The reel at its first column, not animated, settled.
  func rewind() async {
    guard let first = h.model.columns.first else { return }
    h.model.scroll(to: first, animated: false)
    _ = await h.nextCommit()
    await h.sleep(ms: 120)
  }

  // MARK: open

  /// One window shown on the filled store; latency to the first committed frame. Rep 0 is the cold one (fonts, Metal,
  /// SwiftUI's first graph); the process-launch number lives in the result's params.
  func open(rep: Int, size: CGSize, activate: Bool) async -> ([StepResult], [Check]) {
    if h.window != nil { h.closeWindow() }
    let t = h.now()
    h.showWindow(size: size, activate: activate)
    let m = h.begin("open#\(rep)")
    let committed = await h.nextCommit()
    let onScreen = await h.waitOnScreen()
    // The columns must be in that frame: the store was full before the window existed.
    let cols = h.model.columns.count
    await h.sleep(ms: 400)   // let warming run so its stretches are in the step, not in the next one
    let shown = min(committed, onScreen ?? committed)
    let onScreenText: String = onScreen.map { String(Stats.round($0 - t, 1)) } ?? "never"
    let timing = "first commit completed at \(Stats.round(committed - t, 1)) ms; on screen (WindowServer) at \(onScreenText) ms"
    let step = h.end(m, latencyMs: shown - t, notes: [rep == 0 ? "cold: first window of the process" : "warm", "\(cols) columns at first frame", timing])
    return ([step], [Check("columns-at-first-frame", cols > 0, "\(cols) columns in the first frame")])
  }

  // MARK: switch

  func switchProjects() async -> ([StepResult], [Check]) {
    let decks = h.model.decks
    guard decks.count >= 2 else { return ([], [Check("two-projects", false, "the fixture has one project")]) }
    var steps: [StepResult] = []; var ok = true
    let n = int("switches", 6)
    for i in 0..<n {
      let target = decks[(i + 1) % 2]
      let m = h.begin("switch#\(i)→\(target.title.prefix(18))")
      let t = h.now()
      h.model.open(project: target.id)
      let shown = await h.nextCommit()
      let landed = h.model.openProjectId == target.id && !h.model.columns.isEmpty
      ok = ok && landed
      await h.sleep(ms: 250)
      steps.append(h.end(m, latencyMs: shown - t, notes: ["\(h.model.columns.count) columns"]))
    }
    return (steps, [Check("switched", ok, "the open project and its columns changed on every switch")])
  }

  // MARK: scrolls

  func step() async -> ([StepResult], [Check]) {
    await rewind()
    let cols = h.model.columns
    var steps: [StepResult] = []; var smooth = true; var landedAll = true
    var dir = 1
    for i in 0..<int("steps", 8) {
      let at = h.model.reelPosition.flatMap { cols.firstIndex(of: $0) } ?? 0
      if at + h.model.across >= cols.count { dir = -1 } else if at == 0 { dir = 1 }
      let target = dir > 0 ? min(cols.count - 1, at + h.model.across) : max(0, at - h.model.across)
      let m = h.begin("step#\(i) \(at)→\(target)")
      let t = h.now()
      h.model.scroll(to: cols[target])
      let (started, settled) = await h.waitReelSettled(since: t)
      let s = h.end(m, settleMs: settled.map { $0 - t }, notes: started == nil ? ["the reel never reported moving"] : [])
      smooth = smooth && s.frames.late == 0
      landedAll = landedAll && h.model.onScreen.contains(cols[target])
      steps.append(s)
      await h.sleep(ms: 150)
    }
    return (steps, [Check("landed", landedAll, "every step ended with the target column on screen")])
  }

  func jump() async -> ([StepResult], [Check]) {
    await rewind()
    let cols = h.model.columns
    guard cols.count > h.model.across else { return ([], [Check("enough-columns", false, "the fixture fits on one screen; nothing to jump")]) }
    var steps: [StepResult] = []; var landedAll = true
    for i in 0..<int("jumps", 6) {
      let target = i % 2 == 0 ? cols.count - 1 : 0
      let m = h.begin("jump#\(i)→\(target)")
      let t = h.now()
      h.model.scroll(to: cols[target])
      let (started, settled) = await h.waitReelSettled(since: t)
      let s = h.end(m, settleMs: settled.map { $0 - t }, notes: started == nil ? ["the reel never reported moving"] : [])
      landedAll = landedAll && h.model.onScreen.contains(cols[target])
      steps.append(s)
      await h.sleep(ms: 200)
    }
    return (steps, [Check("landed", landedAll, "every jump ended with the target column on screen")])
  }

  /// A swipe: scroll-wheel events with trackpad phases, then our own momentum tail, delivered to the reel's NSScrollView.
  /// Fidelity: the deltas and the decay are the bench's, not the trackpad driver's; AppKit's gesture handling, SwiftUI's
  /// snapping and all the per-frame work are real. See DESKBENCH.md.
  func fling() async -> ([StepResult], [Check]) {
    await rewind()
    guard let sv = h.reelScrollView() else { return ([], [Check("reel-scroll-view", false, "no horizontal NSScrollView found under the window")]) }
    var steps: [StepResult] = []; var snapped = true
    let pitch = Double(sv.documentView!.frame.width) / Double(max(1, h.model.columns.count))
    let v0 = Double(int("velocity", 2400))   // pt/s at release
    for i in 0..<int("flings", 6) {
      let sign: Double = i % 2 == 0 ? -1 : 1   // negative deltaX scrolls content left (forward)
      let m = h.begin("fling#\(i) \(sign < 0 ? "→" : "←")")
      let t = h.now()
      // The finger: 6 frames of growing motion, then release.
      send(sv, phase: .began, momentum: nil, dx: 0)
      for k in 1...6 { send(sv, phase: .changed, momentum: nil, dx: sign * v0 / 120 * Double(k) / 6); await h.sleep(ms: 8) }
      send(sv, phase: .ended, momentum: nil, dx: 0)
      // Momentum: AppKit's trackpad driver would send these; we decay the velocity by 4 % a frame until it dies.
      var v = v0
      send(sv, phase: nil, momentum: .began, dx: sign * v / 120)
      while v > 20 { await h.sleep(ms: 8); v *= 0.96; send(sv, phase: nil, momentum: .changed, dx: sign * v / 120) }
      send(sv, phase: nil, momentum: .ended, dx: 0)
      let (_, settled) = await h.waitReelSettled(since: t, timeoutMs: 1800)
      let x = Double(sv.contentView.bounds.origin.x) + Double(sv.contentInsets.left)
      let off = abs(x / pitch - (x / pitch).rounded()) * pitch
      snapped = snapped && off < 2
      steps.append(h.end(m, settleMs: settled.map { $0 - t }, notes: ["rest offset from a column edge: \(Stats.round(off, 1)) pt"]))
      await h.sleep(ms: 250)
    }
    return (steps, [Check("snapped", snapped, "the reel rested on a column edge after every fling")])
  }

  func send(_ sv: NSScrollView, phase: NSEvent.Phase?, momentum: NSEvent.Phase?, dx: Double) {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: Int32(dx.rounded()), wheel3: 0) else { return }
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: dx)
    cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: dx)
    // CGScrollPhase: began 1, changed 2, ended 4, cancelled 8, mayBegin 128. CGMomentumScrollPhase: begin 1, continue 2, end 3.
    let sp: Int64 = switch phase { case .began?: 1; case .changed?: 2; case .ended?: 4; default: 0 }
    let mp: Int64 = switch momentum { case .began?: 1; case .changed?: 2; case .ended?: 3; default: 0 }
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: sp)
    cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: mp)
    let center = sv.convert(sv.bounds, to: nil).center
    let screenPoint = h.window.convertPoint(toScreen: center)
    let flipped = CGPoint(x: screenPoint.x, y: (NSScreen.screens.first?.frame.height ?? 0) - screenPoint.y)
    cg.location = flipped
    guard let ev = NSEvent(cgEvent: cg) else { return }
    sv.scrollWheel(with: ev)
  }

  // MARK: burst

  /// Items for one on-screen agent at a steady rate, standing still and then while stepping; the other columns must
  /// not evaluate a body.
  mutating func burst() async -> ([StepResult], [Check]) {
    await rewind()
    var w = world
    w.lastSeq = max(w.lastSeq, h.liveSeq)   // ids and seqs never repeat across reps (the store drops duplicates)
    let cols = h.model.columns
    let target = cols[min(1, cols.count - 1)]
    let rate = max(1, int("itemsPerSecond", 20)), secs = max(1, int("seconds", 3))
    var checks: [Check] = []; var steps: [StepResult] = []
    for (phase, moving) in [("still", false), ("scrolling", true)] {
      await rewind()
      let m = h.begin("burst-\(phase) \(rate)/s")
      let start = h.now()
      var sent = 0
      var dir = 1
      let total = rate * secs
      var nextScroll = start + 350
      while sent < total {
        let item = Fixtures.liveItem(world: &w, agentId: target, text: "Live item \(sent + 1): the join matches on lower(email) now; \(sent % 3 == 0 ? "**bold** at times" : "plain text otherwise").")
        let f = Fixtures.liveFrame(runId: fixtureRunId, item: item)
        h.store.receive(.event(f.envelope), scope: f.scope)
        sent += 1
        if moving, h.now() >= nextScroll, !h.model.reelMoving {
          let at = h.model.reelPosition.flatMap { cols.firstIndex(of: $0) } ?? 0
          if at + h.model.across >= cols.count { dir = -1 } else if at == 0 { dir = 1 }
          let to = dir > 0 ? min(cols.count - 1, at + 1) : max(0, at - 1)
          h.model.scroll(to: cols[to])
          nextScroll = h.now() + 600
        }
        await h.sleep(ms: 1000 / Double(rate))
      }
      _ = await h.nextCommit()
      let end = h.now()
      let bs = h.bodies(in: start...end)
      let outsideThread = bs.filter { ($0.view == "ColumnThread" || $0.view == "EntryRow") && $0.id != target }.count
      let others = bs.filter { ["Column", "ColumnHead", "CrewTab", "TitleBar", "OpenGroup", "FoldedDeck", "DecisionBar", "ColumnComposer"].contains($0.view) }
      let own = bs.filter { ($0.view == "ColumnThread" || $0.view == "EntryRow") && $0.id == target }.count
      var notes = ["\(sent) items; target column evaluated \(own) thread bodies; other columns' threads \(outsideThread); other views \(others.count)"]
      if moving {
        // While the reel moves, Column bodies are expected only from the step itself (none in the current design).
        notes.append("Column bodies while scrolling: \(others.filter { $0.view == "Column" }.count)")
        checks.append(Check("isolation-\(phase)", outsideThread == 0, "other columns' thread bodies during the burst: \(outsideThread)"))
      } else {
        let leaked = Dictionary(grouping: others, by: \.view).mapValues(\.count)
        checks.append(Check("isolation-\(phase)", outsideThread == 0 && others.isEmpty, "bodies outside the target thread: \(leaked.isEmpty ? "none" : leaked.description), other threads: \(outsideThread)"))
      }
      checks.append(Check("delivered-\(phase)", own >= sent, "the target thread evaluated \(own) bodies for \(sent) items"))
      steps.append(h.end(m, notes: notes))
    }
    h.liveSeq = max(h.liveSeq, w.lastSeq); world = w
    return (steps, checks)
  }

  // MARK: typing

  func typing() async -> ([StepResult], [Check]) {
    await rewind()
    _ = await h.nextCommit()
    guard let field = h.composerField() else { return ([], [Check("composer-found", false, "no composer text field on screen (an ask docks a decision bar instead)")]) }
    h.window.makeFirstResponder(field)
    _ = await h.nextCommit()
    let text = params["text"] ?? "Please normalize the emails before the join and rerun the tests."
    let m = h.begin("typing \(text.count) keys")
    let start = h.now()
    for ch in text {
      let s = String(ch)
      for kind in [NSEvent.EventType.keyDown, .keyUp] {
        if let ev = NSEvent.keyEvent(with: kind, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: h.window.windowNumber,
                                     context: nil, characters: s, charactersIgnoringModifiers: s.lowercased(), isARepeat: false, keyCode: 0) {
          h.window.sendEvent(ev)
        }
      }
      await h.sleep(ms: 30)
    }
    _ = await h.nextCommit()
    let end = h.now()
    let typed = (h.window.firstResponder as? NSTextView)?.string ?? field.stringValue
    let bs = h.bodies(in: start...end)
    let outside = bs.filter { $0.view != "ColumnComposer" }
    let leaked = Dictionary(grouping: outside, by: \.view).mapValues(\.count)
    let notes = ["typed \(typed.count)/\(text.count) characters into the field", "bodies: composer \(bs.count - outside.count), outside \(outside.count)"]
    let step = h.end(m, notes: notes)
    // Clear the draft so the next rep starts clean.
    (h.window.firstResponder as? NSTextView)?.string = ""
    field.stringValue = ""
    h.window.makeFirstResponder(nil)
    return ([step], [Check("typed", typed.count == text.count, "the field received \(typed.count) of \(text.count) characters"),
                     Check("isolation", outside.isEmpty, "bodies outside ColumnComposer while typing: \(leaked.isEmpty ? "none" : leaked.description)")])
  }

  // MARK: resize

  func resize() async -> ([StepResult], [Check]) {
    await rewind()
    var steps: [StepResult] = []; var followed = true
    let plan: [(CGFloat, Int)] = [(1100, 2), (720, 1), (1440, 3)]
    for (w, want) in plan {
      let m = h.begin("resize→\(Int(w)) (\(want) across)")
      let t = h.now()
      let f = h.window.frame
      h.window.setFrame(NSRect(x: f.origin.x, y: f.origin.y, width: w, height: f.height), display: true, animate: false)
      let shown = await h.nextCommit()
      await h.sleep(ms: 300)
      let got = h.model.across
      followed = followed && got == want
      steps.append(h.end(m, latencyMs: shown - t, notes: ["across = \(got), expected \(want)"]))
    }
    return (steps, [Check("columns-follow-width", followed, "3 → 2 → 1 → 3 columns across as the width crossed 1280 and 900")])
  }

  // MARK: follow

  func follow() async -> ([StepResult], [Check]) {
    let cols = h.model.columns
    guard cols.count > h.model.across + 1 else { return ([], [Check("enough-columns", false, "every column is already on screen")]) }
    h.model.follow = true
    var steps: [StepResult] = []; var landedAll = true
    let candidates = cols.suffix(from: h.model.across + 1).filter { h.model.agent($0)?.approval == nil }
    for i in 0..<int("asks", 4) {
      await rewind()
      let who = candidates[(candidates.count - 1 - i) % max(1, candidates.count)]
      let seq = h.nextSeq()
      let m = h.begin("follow#\(i)→\(cols.firstIndex(of: who) ?? -1)")
      let t = h.now()
      let f = Fixtures.askFrame(runId: fixtureRunId, agentId: who, approvalId: "bench-ask-\(seq)", seq: seq)
      h.store.receive(.event(f.envelope), scope: f.scope)
      let (started, settled) = await h.waitReelSettled(since: t)
      let landed = h.model.onScreen.contains(who)
      landedAll = landedAll && landed
      steps.append(h.end(m, latencyMs: started.map { $0 - t }, settleMs: settled.map { $0 - t }, notes: [landed ? "landed on the asking column" : "did not land on the asking column"]))
      // Answer the ask so the next one is new.
      let dseq = h.nextSeq()
      let done = Envelope(id: "bench-dec-\(dseq)", scope: fixtureRunId, seq: dseq, entity: who, type: "approval.decided", epochMs: Int(Date().timeIntervalSince1970 * 1000),
                          projectId: nil, runId: fixtureRunId, agentId: who, data: ["approvalId": .string("bench-ask-\(seq)"), "status": .string("approved")])
      h.store.receive(.event(done), scope: fixtureRunId)
      await h.sleep(ms: 150)
    }
    return (steps, [Check("landed", landedAll, "the reel ended on the asking column every time")])
  }
}

extension CGRect { var center: CGPoint { CGPoint(x: midX, y: midY) } }
