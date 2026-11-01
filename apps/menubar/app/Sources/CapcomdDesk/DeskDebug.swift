#if canImport(SwiftUI) && os(macOS) && (DEBUG || DESK_PROBE)
import AppKit

/// Development only: with CAPCOMD_DESK_SNAPSHOT=<dir>, the window draws itself into <dir>/window.png and lists its
/// scroll views' geometry in <dir>/scrolls.txt every 2 s. Its own window needs no screen-recording permission.
/// With CAPCOMD_DESK_AUTOSCROLL=<seconds>, it clicks through the reel as a crew tab does (animated), to the last column
/// and back (or first ↔ last with CAPCOMD_DESK_AUTOSCROLL_ENDS=1), every <seconds>, for Instruments. Release builds get it with -Xswiftc -DDESK_PROBE.
/// With CAPCOMD_DESK_BODIES=<file>, it counts view bodies (DeskProbe) and appends one line per autoscroll tick: what
/// the app itself evaluated for that step, to check the bench's hosts against the real one.
/// With CAPCOMD_DESK_RECORD_GESTURE=<file>, it records swipes on the reel (GestureTap).
@MainActor package enum DeskDebug {
  final class BodyCounter: DeskProbeSink {
    var counts: [String: Int] = [:]
    func body(_ view: StaticString) { counts["\(view)", default: 0] += 1 }
    func body(_ view: StaticString, id: String) { counts["\(view)", default: 0] += 1 }
    func event(_ name: StaticString, _ value: Int) {}
    func flush(to url: URL, tick: Int) {
      let line = "tick \(tick) active \(NSApp.isActive) key \(NSApp.keyWindow != nil): "
        + counts.sorted { $0.value > $1.value }.map { "\($0.key)×\($0.value)" }.joined(separator: " ") + "\n"
      counts = [:]
      if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
      else { try? Data(line.utf8).write(to: url) }
    }
  }

  package static func start(_ model: DeskModel) {
    // CAPCOMD_DESK_RECORD_GESTURE=<file>: each swipe on the reel (scroll deltas, phases, times; nothing else) to <file>,
    // the next ones to <name>-2.json, … (perfloop.gesture/1, for `deskbench run swipe --gesture <file>`).
    if let path = ProcessInfo.processInfo.environment["CAPCOMD_DESK_RECORD_GESTURE"], !path.isEmpty {
      GestureTap.record(to: URL(fileURLWithPath: (path as NSString).expandingTildeInPath)) { r in
        let line: String
        switch r {
        case .success(let (url, g)): line = "capcomd: recorded gesture \(g.name) (\(g.events.count) events, \(Int(g.durationMs)) ms) → \(url.path)\n"
        case .failure(let e): line = "capcomd: couldn't write the gesture: \(e)\n"
        }
        FileHandle.standardError.write(Data(line.utf8))
      }
    }
    let counter = ProcessInfo.processInfo.environment["CAPCOMD_DESK_BODIES"].map { (BodyCounter(), URL(fileURLWithPath: $0)) }
    if let counter { DeskProbe.sink = counter.0 }
    if let s = ProcessInfo.processInfo.environment["CAPCOMD_DESK_AUTOSCROLL"].flatMap(Double.init) {
      var step = 1, tick = 0
      Timer.scheduledTimer(withTimeInterval: s, repeats: true) { _ in
        MainActor.assumeIsolated {
          if let counter { counter.0.flush(to: counter.1, tick: tick); tick += 1 }
          let cols = model.columns
          guard cols.count > model.across else { return }
          let at = model.reelPosition.flatMap { cols.firstIndex(of: $0) } ?? 0
          if at + model.across >= cols.count { step = -1 } else if at == 0 { step = 1 }
          // CAPCOMD_DESK_AUTOSCROLL_ENDS=1: first ↔ last column, the longest jump there is.
          let ends = ProcessInfo.processInfo.environment["CAPCOMD_DESK_AUTOSCROLL_ENDS"] == "1"
          let target = ends ? (at == 0 ? cols.count - 1 : 0) : step > 0 ? min(cols.count - 1, at + model.across) : max(0, at - 1)
          model.scroll(to: cols[target])
        }
      }
    }
    if let dir = ProcessInfo.processInfo.environment["CAPCOMD_DESK_CONTROL"], !dir.isEmpty {
      let d = URL(fileURLWithPath: dir)
      Timer.scheduledTimer(withTimeInterval: 0.5, repeats: true) { _ in MainActor.assumeIsolated { control(model, d) } }
    }
    guard let dir = ProcessInfo.processInfo.environment["CAPCOMD_DESK_SNAPSHOT"], !dir.isEmpty else { return }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
      MainActor.assumeIsolated { snapshot(into: URL(fileURLWithPath: dir)) }
    }
  }

  /// CAPCOMD_DESK_CONTROL=<dir>: drives the window without touching the screen, for checks against a live daemon. Each
  /// half second it runs the lines of <dir>/cmd (then deletes it) and writes the model's state to <dir>/state.txt.
  /// Lines: `project N`, `agent N`, `focus ±1`, `scroll <agentId>`, `follow on|off`, `steer <agentId> <text>`,
  /// `decide <approvalId> approve|deny`, `goal open|confirm|cancel|keep` (the goal card's buttons), `swipe <dx>` (a two-finger swipe of dx points handed to the reel's scroll
  /// view, as deskbench's swipes are; negative scrolls toward later columns), `snap <name>` (the window, now, into <dir>/<name>.png), `key <char|return|escape|left|right> [cmd] [ctrl] [shift]` (a key event handed to
  /// this app's own window and menu, never posted to the system).
  static func control(_ model: DeskModel, _ dir: URL) {
    let cmd = dir.appendingPathComponent("cmd")
    if let text = try? String(contentsOf: cmd, encoding: .utf8) {
      try? FileManager.default.removeItem(at: cmd)
      for line in text.split(separator: "\n") {
        let w = line.split(separator: " ", maxSplits: 2).map(String.init)
        switch w.first {
        case "project": if let n = w.dropFirst().first.flatMap(Int.init) { model.goToProject(n - 1) }
        case "agent": if let n = w.dropFirst().first.flatMap(Int.init) { model.goToAgent(n - 1) }
        case "focus": if let n = w.dropFirst().first.flatMap(Int.init) { model.moveFocus(n) }
        case "scroll": if w.count > 1 { model.scroll(to: w[1]) }
        case "follow": model.follow = w.dropFirst().first == "on"
        case "steer": if w.count > 2 { model.steer(agentId: w[1], body: w[2]) }
        case "decide": if w.count > 2 { model.decide(w[1], w[2] == "deny" ? .deny : .approve) }
        case "key": key(w.dropFirst().joined(separator: " "))
        case "snap": if w.count > 1 { snapshot(into: dir, name: w[1]) }
        case "swipe": if let dx = w.dropFirst().first.flatMap(Double.init) { swipe(dx) }
        case "goal": goal(model, w.dropFirst().first ?? "")
        default: break
        }
      }
    }
    try? state(model).write(to: dir.appendingPathComponent("state.txt"), atomically: true, encoding: .utf8)
  }

  /// `goal open|confirm|cancel|keep`: the open run's goal card buttons, as a click on them would.
  static func goal(_ model: DeskModel, _ what: String) {
    guard let run = model.openRunId, let card = model.store.goalCard(runId: run) else { return }
    switch what {
    case "open": model.openPullRequest(card)
    case "confirm": model.confirmPullRequest(run)
    case "cancel": model.cancelGoalAction(run)
    case "keep": model.keepBranch(run)
    default: break
    }
  }

  static func swipe(_ dx: Double) {
    guard let win = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }) else { return }
    func find(_ v: NSView) -> SnapScrollView? { (v as? SnapScrollView) ?? v.subviews.lazy.compactMap(find).first }
    guard let root = win.contentView?.superview ?? win.contentView, let sv = find(root) else { return }
    let steps = 12, t0 = ProcessInfo.processInfo.systemUptime
    for n in 0...(steps + 1) {
      let phase: Int64 = n == 0 ? 1 : n <= steps ? 2 : 4   // CGScrollPhase: began, changed, ended
      let d = n == 0 || n > steps ? 0 : Int32(dx / Double(steps))
      guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: d, wheel3: 0) else { return }
      cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: Double(d))
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: Double(d))
      cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      cg.timestamp = CGEventTimestamp((t0 + Double(n) * 0.012) * 1e9)
      if let e = NSEvent(cgEvent: cg) { sv.scrollWheel(with: e) }
    }
  }

  static func key(_ spec: String) {
    let w = spec.split(separator: " ").map(String.init)
    guard let k = w.first, let win = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }) else { return }
    var flags: NSEvent.ModifierFlags = []
    if w.contains("cmd") { flags.insert(.command) }; if w.contains("ctrl") { flags.insert(.control) }; if w.contains("shift") { flags.insert(.shift) }
    let (chars, code): (String, UInt16) = switch k {
    case "return": ("\r", 36); case "escape": ("\u{1b}", 53)
    case "left": (String(UnicodeScalar(NSLeftArrowFunctionKey)!), 123); case "right": (String(UnicodeScalar(NSRightArrowFunctionKey)!), 124)
    default: (k, [ "1": 18, "2": 19, "3": 20, "4": 21, "5": 23, "6": 22, "7": 26, "8": 28, "9": 25 ][k] ?? 0)
    }
    if k == "left" || k == "right" { flags.insert([.function, .numericPad]) }
    guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags, timestamp: ProcessInfo.processInfo.systemUptime,
                                   windowNumber: win.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                   isARepeat: false, keyCode: code) else { return }
    // As AppKit routes a key: the window's key equivalents (SwiftUI's shortcuts), then the main menu, then the responder chain.
    if win.performKeyEquivalent(with: e) { return }
    if NSApp.mainMenu?.performKeyEquivalent(with: e) == true { return }
    win.firstResponder?.keyDown(with: e)
  }

  static func state(_ model: DeskModel) -> String {
    let s = model.store
    var out = ["link \(model.link) unreachable \(s.daemonUnreachable) unauthorized \(s.unauthorized) follow \(model.follow) across \(model.across)",
               "open \(model.openProjectId ?? "-") run \(model.openRunId ?? "-") position \(model.reelPosition ?? "-") focused \(model.focusedAgent ?? "-")"]
    for (n, d) in model.decks.enumerated() {
      out.append("deck \(n + 1) \(d.id == model.openProjectId ? "*" : " ") \(d.title) run \(d.runId) running \(d.isRunning) asking \(d.askingName ?? "-") agents \(d.agentIds.count)")
    }
    for id in model.columns {
      guard let a = model.agent(id) else { out.append("col \(id) (no slice)"); continue }
      let h = a.header, t = model.peekThread(id)
      out.append("col \(id) \(h.name) \(h.suffix ?? "") \(h.status) warm \(a.warm) seen \(a.onScreen) focus \(a.focused) ask \(a.approval?.id ?? "-") "
        + "spawned \(h.spawnedAtMs) store \(s.threadEntries(agentId: id).count) shown \(t.map { "\($0.entries.count)" } ?? "-") "
        + "pending \(t.map { $0.pending.map { "\($0.state)" }.joined(separator: ",") } ?? "-")")
    }
    for a in s.pendingApprovals { out.append("approval \(a.id) run \(a.runId ?? "-") agent \(a.agentId ?? "-") \(a.decision)") }
    if let run = model.openRunId, let g = s.goalCard(runId: run) {
      out.append("goal \(g.title) \(g.phase) stopped \(g.stopped) docks \(g.docks) loading \(g.loading) openPR \(g.openPR) confirm \(g.confirm ?? "-") outcome \(g.outcome.map { "\($0)" } ?? "-")")
    }
    return out.joined(separator: "\n") + "\n"
  }

  static func snapshot(into dir: URL, name: String = "window") {
    guard let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }),
          let frame = w.contentView?.superview ?? w.contentView,
          let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
    frame.layoutSubtreeIfNeeded()   // an occluded window gets no display passes: catch up before drawing it
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
    var lines = ["window \(w.frame.size) contentLayoutRect \(w.contentLayoutRect) visible \(w.occlusionState.contains(.visible)) key \(w.isKeyWindow)"]
    func walk(_ v: NSView) {
      if let s = v as? NSScrollView {
        let f = s.convert(s.bounds, to: nil)
        lines.append("scroll \(f) insets \(s.contentInsets) auto \(s.automaticallyAdjustsContentInsets) "
          + "doc \(s.documentView?.frame.size ?? .zero) clip \(s.contentView.bounds)")
      }
      v.subviews.forEach(walk)
    }
    walk(frame)
    try? lines.joined(separator: "\n").write(to: dir.appendingPathComponent("scrolls.txt"), atomically: true, encoding: .utf8)
  }
}
#endif
