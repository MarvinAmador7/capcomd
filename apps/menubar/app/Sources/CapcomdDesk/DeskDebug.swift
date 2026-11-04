#if canImport(SwiftUI) && os(macOS) && (DEBUG || DESK_PROBE)
import AppKit
import CapcomdStore

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
    // CAPCOMD_DESK_THREAD_LOG=<file>: one line each time a column's thread entries change (the first, empty, when its
    // thread opens): milliseconds of uptime, the agent, how many entries, and the last one's id. For time-to-latest.
    if let path = ProcessInfo.processInfo.environment["CAPCOMD_DESK_THREAD_LOG"], !path.isEmpty {
      let url = URL(fileURLWithPath: (path as NSString).expandingTildeInPath)
      ThreadSlice.trace = { id, entries in
        let line = "\(Int(ProcessInfo.processInfo.systemUptime * 1000)) \(id) \(entries.count) \(entries.last?.id ?? "-")\n"
        if let h = try? FileHandle(forWritingTo: url) { h.seekToEndOfFile(); h.write(Data(line.utf8)); try? h.close() }
        else { try? Data(line.utf8).write(to: url) }
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
  /// `decide <approvalId> approve|deny`, `goal open|confirm|cancel|keep` (the goal card's buttons), `openrun <runId>` (a click on its notification), `swipe <dx>` (a two-finger swipe of dx points handed to the reel's scroll
  /// view, as deskbench's swipes are; negative scrolls toward later columns), `snap <name>` (the window, now, into <dir>/<name>.png), `key <char|return|escape|delete|left|right> [cmd] [ctrl] [shift]` (a key event handed to
  /// this app's own window and menu, never posted to the system), `rename <N|agentId> tab|header` (a double-click on
  /// that agent's tab or header: its rename field opens), `type <text>` (the text typed into the focused field, as key
  /// events handed to this window; select it all first with `key a cmd`).
  /// The new project column (ReelNew): `new` (as + or ⇧⌘N), `new close`, `draft <text>` (the goal field's text),
  /// `folder <path>|default` (a folder picked, as Choose Project Folder… would, or Use the Default Project),
  /// `base <branch>`, `branch <name>` (the goal branch field), `setup <setUp|setUpAndStart|initializeGit|publish|
  /// tryAgain|cancel>` (a button of the folder's setup), `escape` (Esc in the goal field), `start` (Return). The project
  /// menu (ReelMenu): `menu` (a click on the name), `menu <message|changes|pause|resume|stop|fold|remove|copy>` (that
  /// item), `menu confirm|cancel` (the Stop question). The palette: `palette [query]` (⌘K, with that query typed),
  /// `palette up|down|run|close`. `menus` writes the main menu's items and their shortcuts to <dir>/menus.txt.
  /// The app outside the window: `choose` (Choose Project Folder…: the Open panel), `openpanel cancel`, `close` (the
  /// window's close button); state.txt lists the app's activation and its windows front to back. Controls by place:
  /// `hit <label|@X,Y>` (which view a click there lands on, into <dir>/hit.txt), `click <label|@X,Y>` (a mouse-down and
  /// -up handed to this window), `press <label>` (an accessibility press), `ax` (the accessibility tree, into ax.txt;
  /// empty until an assistive app has asked). @X,Y is in points from the window's top left. A menu a click or press
  /// opens is written to <dir>/menu.txt, and <dir>/menucmd (`pick <title prefix>` or `cancel`) acts in it.
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
        case "vscroll": if w.count > 2, let n = Int(w[1]), let dy = Double(w[2]) { vscroll(column: n - 1, dy) }
        case "goal": goal(model, w.dropFirst().first ?? "")
        case "openrun": if w.count > 1 { model.openRun(w[1]) }   // as a click on its notification
        case "rename":
          guard w.count > 1 else { break }
          let id = Int(w[1]).flatMap { n in model.columns.indices.contains(n - 1) ? model.columns[n - 1] : nil } ?? w[1]
          model.beginRename(id, at: w.dropFirst(2).first == "header" ? .header : .tab)
        case "type": type(String(line.dropFirst(5)))
        case "new": if w.dropFirst().first == "close" { model.closeNewProject() } else { model.openNewProject() }
        case "draft": model.typeGoal(String(line.dropFirst(6)))
        case "folder":
          let path = String(line.dropFirst(7))
          if path == "default" { model.useDefaultProject() } else if !path.isEmpty { Task { await model.pickFolder(path) } }
        case "base": if w.count > 1 { model.pickBase(w[1]) }
        case "branch": model.typeBranch(String(line.dropFirst(7)))
        case "setup":
          if w.dropFirst().first == "cancel" { model.cancelSetup() } else if let a = setupAction(w.dropFirst().first ?? "") { model.setupAction(a) }
        case "escape": model.newProjectEscape()   // Esc in the goal field
        case "start": Task { await model.startNewProject() }
        case "menu":
          switch w.dropFirst().first {
          case nil: model.toggleMenu()
          case "confirm"?: model.confirmStop()
          case "cancel"?: model.cancelStop()
          case let name?: if let i = model.menuItem(name) { model.perform(i) }
          }
        case "palette":
          switch w.dropFirst().first {
          case "up"?: model.movePaletteSelection(-1)
          case "down"?: model.movePaletteSelection(1)
          case "run"?: model.runPaletteSelection()
          case "close"?: model.closePalette()
          default: model.togglePalette(query: String(line.dropFirst(8)))
          }
        case "menus": menus(into: dir)
        case "choose": model.chooseProjectFolder()   // + › Choose Project Folder…, the folder chip, Choose Another…
        case "openpanel": if w.dropFirst().first == "cancel" { for case let p as NSOpenPanel in NSApp.windows where p.isVisible { p.cancel(nil) } }
        case "ax": ax(into: dir)
        case "press": if w.count > 1 { press(String(line.dropFirst(6)), dir) }
        case "hit": if w.count > 1 { hit(String(line.dropFirst(4)), dir) }
        case "click": if w.count > 1 { click(String(line.dropFirst(6)), dir) }
        case "close": deskWindow?.performClose(nil)   // the window's close button
        default: break
        }
      }
    }
    try? state(model).write(to: dir.appendingPathComponent("state.txt"), atomically: true, encoding: .utf8)
  }

  // MARK: the window's own controls, through accessibility (in this process; nothing is posted to the system)

  /// `ax`: the window's accessibility tree, one element per line (role, label, frame), into <dir>/ax.txt.
  static func ax(into dir: URL) {
    guard let root = deskWindow?.contentView else { return }
    var out: [String] = []
    func walk(_ e: Any, _ depth: Int) {
      guard depth < 40, let el = e as? NSAccessibilityProtocol else { return }
      let o = e as AnyObject
      let role = (o.accessibilityRole?() ?? nil)?.rawValue ?? "?"
      let label = (o.accessibilityLabel?() ?? nil) ?? ""
      let title = (o.accessibilityTitle?() ?? nil) ?? ""
      out.append(String(repeating: " ", count: depth) + "\(role) \"\(label)\" \"\(title)\" \(el.accessibilityFrame())")
      for c in (o.accessibilityChildren?() ?? nil) ?? [] { walk(c, depth + 1) }
    }
    walk(root, 0)
    try? (out.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("ax.txt"), atomically: true, encoding: .utf8)
  }

  /// `press <label>`: presses the window's first control whose accessibility label starts with <label>, as VoiceOver
  /// would. A menu it opens is tracked here: its items go to <dir>/menu.txt, and `<dir>/menucmd` (read while the menu is
  /// open) picks one: `pick <title prefix>` or `cancel`.
  static func press(_ label: String, _ dir: URL) {
    guard let target = element(label) else {
      try? "press: nothing labelled \(label)\n".write(to: dir.appendingPathComponent("menu.txt"), atomically: true, encoding: .utf8)
      return
    }
    trackMenus(dir)
    DispatchQueue.main.async { _ = target.accessibilityPerformPress?() }
  }

  /// The window's first accessibility element whose label starts with `label`.
  static func element(_ label: String) -> AnyObject? {
    guard let root = deskWindow?.contentView else { return nil }
    func find(_ e: Any, _ depth: Int) -> AnyObject? {
      guard depth < 40 else { return nil }
      let o = e as AnyObject
      if let l = o.accessibilityLabel?() ?? nil, l.hasPrefix(label) { return o }
      for c in (o.accessibilityChildren?() ?? nil) ?? [] { if let f = find(c, depth + 1) { return f } }
      return nil
    }
    return find(root, 0)
  }

  /// The middle of `label`'s element, in the window's coordinates.
  /// `label` may instead be `@X,Y`: that point, in points from the window's top left (as a `snap` shows it, halved on 2x).
  static func center(_ label: String) -> NSPoint? {
    guard let w = deskWindow else { return nil }
    if label.hasPrefix("@") {
      let xy = label.dropFirst().split(separator: ",").compactMap { Double($0) }
      guard xy.count == 2 else { return nil }
      return NSPoint(x: xy[0], y: w.frame.height - xy[1])
    }
    guard let el = element(label) as? NSAccessibilityProtocol else { return nil }
    let f = w.convertFromScreen(el.accessibilityFrame())
    return NSPoint(x: f.midX, y: f.midY)
  }

  /// `hit <label>`: which view a click in the middle of `label`'s element lands on (as AppKit hit-tests a mouse-down),
  /// into <dir>/hit.txt.
  static func hit(_ label: String, _ dir: URL) {
    var line = "hit \(label): "
    if let w = deskWindow, let p = center(label), let frame = w.contentView?.superview {
      var chain: [String] = []
      var v = frame.hitTest(frame.convert(p, from: nil))
      while let x = v, chain.count < 12 { chain.append(String(describing: Swift.type(of: x))); v = x.superview }
      line += "at \(p) → " + chain.joined(separator: " < ")
    } else { line += "not found" }
    try? (line + "\n").write(to: dir.appendingPathComponent("hit.txt"), atomically: true, encoding: .utf8)
  }

  /// `click <label>`: a mouse-down and -up in the middle of `label`'s element, handed to this window (never posted to
  /// the system), as a click there would arrive. A menu it opens is tracked as `press` tracks one.
  static func click(_ label: String, _ dir: URL) {
    guard let w = deskWindow, let p = center(label) else { return }
    trackMenus(dir)
    func event(_ type: NSEvent.EventType) -> NSEvent? {
      NSEvent.mouseEvent(with: type, location: p, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: w.windowNumber,
                         context: nil, eventNumber: 0, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0)
    }
    DispatchQueue.main.async {
      if let d = event(.leftMouseDown) { w.sendEvent(d) }
      if let u = event(.leftMouseUp) { w.sendEvent(u) }
    }
  }

  private static var menuObserver: NSObjectProtocol?
  private static var menuTimer: Timer?
  private static weak var tracked: NSMenu?
  static func trackMenus(_ dir: URL) {
    guard menuObserver == nil else { return }
    menuObserver = NotificationCenter.default.addObserver(forName: NSMenu.didBeginTrackingNotification, object: nil, queue: nil) { n in
      MainActor.assumeIsolated {
        guard let m = n.object as? NSMenu, m.supermenu == nil, m !== NSApp.mainMenu else { return }
        tracked = m
        let items = m.items.map { i in i.isSeparatorItem ? "---" : "\(i.state == .on ? "✓" : " ") \(i.title)\(i.isEnabled ? "" : " (disabled)")" }
        try? (items.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("menu.txt"), atomically: true, encoding: .utf8)
      }
    }
    // A menu runs its own event loop: this timer runs in it too (common modes), which the control file's doesn't.
    let t = Timer(timeInterval: 0.25, repeats: true) { _ in
      MainActor.assumeIsolated {
        let f = dir.appendingPathComponent("menucmd")
        guard let m = tracked, let text = try? String(contentsOf: f, encoding: .utf8) else { return }
        try? FileManager.default.removeItem(at: f)
        let cmd = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if cmd.hasPrefix("pick "), let i = m.items.firstIndex(where: { $0.title.hasPrefix(String(cmd.dropFirst(5))) }) {
          m.cancelTrackingWithoutAnimation()
          m.performActionForItem(at: i)
        } else { m.cancelTrackingWithoutAnimation() }
        tracked = nil
      }
    }
    RunLoop.main.add(t, forMode: .common)
    menuTimer = t
  }

  static func setupAction(_ name: String) -> SetupAction? {
    switch name {
    case "setUp": .setUp; case "setUpAndStart": .setUpAndStart; case "initializeGit": .initializeGit; case "publish": .publish
    case "tryAgain": .tryAgain; default: nil
    }
  }

  /// The main menu's items with their key equivalents, one per line: to check the shortcuts don't collide.
  static func menus(into dir: URL) {
    var out: [String] = []
    func walk(_ m: NSMenu, _ path: String) {
      for i in m.items where !i.isSeparatorItem {
        let mods = i.keyEquivalentModifierMask
        let key = i.keyEquivalent.isEmpty ? "" : (mods.contains(.control) ? "⌃" : "") + (mods.contains(.option) ? "⌥" : "")
          + (mods.contains(.shift) ? "⇧" : "") + (mods.contains(.command) ? "⌘" : "") + i.keyEquivalent.uppercased()
        out.append("\(path)\(i.title)\t\(key)\(i.isEnabled ? "" : "\t(disabled)")")
        if let sub = i.submenu { walk(sub, "\(path)\(i.title) › ") }
      }
    }
    if let m = NSApp.mainMenu { walk(m, "") }
    try? (out.joined(separator: "\n") + "\n").write(to: dir.appendingPathComponent("menus.txt"), atomically: true, encoding: .utf8)
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

  /// The desk's window: the app also has the menu bar's status item and panel (and, in development, the panel's
  /// off-screen host), so it's the visible one with the `main` id, else the first visible on-screen one.
  static var deskWindow: NSWindow? {
    let shown = NSApp.windows.filter { $0.isVisible && $0.contentView != nil && $0.frame.minX > -10_000 }
    return shown.first { $0.identifier?.rawValue.hasPrefix("main") == true }
      ?? shown.first { w in
        let kind = String(describing: Swift.type(of: w))
        return !kind.contains("StatusBar") && !kind.contains("MenuBarExtra")
      }
  }

  static func swipe(_ dx: Double) {
    guard let win = deskWindow else { return }
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

  /// `vscroll N dy`: a two-finger scroll of dy points handed to the thread of the N-th column on screen (from the left;
  /// positive scrolls up, toward older messages), as `swipe` hands one to the reel.
  static func vscroll(column n: Int, _ dy: Double) {
    guard let win = deskWindow,
          let root = win.contentView?.superview ?? win.contentView else { return }
    var found: [NSScrollView] = []
    func walk(_ v: NSView) {
      if let s = v as? NSScrollView, !(s is SnapScrollView), s.frame.height > 200 { found.append(s) }
      v.subviews.forEach(walk)
    }
    walk(root)
    let threads = found.sorted { $0.convert($0.bounds, to: nil).minX < $1.convert($1.bounds, to: nil).minX }
    guard threads.indices.contains(n) else { return }
    let sv = threads[n], steps = 12, t0 = ProcessInfo.processInfo.systemUptime
    for k in 0...(steps + 1) {
      let phase: Int64 = k == 0 ? 1 : k <= steps ? 2 : 4
      let d = k == 0 || k > steps ? 0 : Int32(dy / Double(steps))
      guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: d, wheel2: 0, wheel3: 0) else { return }
      cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
      cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis1, value: Double(d))
      cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: Double(d))
      cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
      cg.timestamp = CGEventTimestamp((t0 + Double(k) * 0.012) * 1e9)
      if let e = NSEvent(cgEvent: cg) { sv.scrollWheel(with: e) }
    }
  }

  static func key(_ spec: String) {
    let w = spec.split(separator: " ").map(String.init)
    guard let k = w.first, let win = deskWindow else { return }
    var flags: NSEvent.ModifierFlags = []
    if w.contains("cmd") { flags.insert(.command) }; if w.contains("ctrl") { flags.insert(.control) }; if w.contains("shift") { flags.insert(.shift) }
    let (chars, code): (String, UInt16) = switch k {
    case "return": ("\r", 36); case "escape": ("\u{1b}", 53); case "delete": ("\u{7f}", 51)
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

  /// Types `text` into this window's focused field, one key event per character (never posted to the system).
  static func type(_ text: String) {
    guard let win = deskWindow else { return }
    for ch in text {
      let s = String(ch)
      guard let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                     windowNumber: win.windowNumber, context: nil, characters: s, charactersIgnoringModifiers: s,
                                     isARepeat: false, keyCode: 0) else { continue }
      win.firstResponder?.keyDown(with: e)
    }
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
      out.append("col \(id) \(h.name) title \(h.title.map { "\"\($0)\"" } ?? "-") tab \"\(h.tabLabel)\" user \(h.userTitled) renaming \(a.renaming.map { "\($0)" } ?? "-") failed \(a.renameFailure ?? "-") \(h.suffix ?? "") \(h.status) warm \(a.warm) seen \(a.onScreen) focus \(a.focused) ask \(a.approval?.id ?? "-") "
        + "spawned \(h.spawnedAtMs) store \(s.threadEntries(agentId: id).count) shown \(t.map { "\($0.entries.count)" } ?? "-") "
        + "pending \(t.map { $0.pending.map { "\($0.state)" }.joined(separator: ",") } ?? "-") "
        + "top \(t?.top.map(String.init) ?? "-") earlier \(t?.loadingEarlier == true ? "loading" : "-") unavailable \(t?.unavailable.map { "\($0)" } ?? "-") "
        + "last \(t?.entries.last?.id ?? "-")")
    }
    for a in s.pendingApprovals { out.append("approval \(a.id) run \(a.runId ?? "-") agent \(a.agentId ?? "-") \(a.decision)") }
    out.append("folded \(model.folded) hidden \(model.hidden.keys.sorted().joined(separator: ",")) returnApproves \(model.returnApproves) typing \(model.typingIn ?? "-") stopAsked \(model.stopAsked)")
    if let np = model.newProject {
      let f = np.form, g = f.goalSetup
      out.append("new \(f.phase) bot \(np.name) smiling \(f.smiling) goal \"\(f.goal)\" canStart \(model.newProjectCanStart) escCloses \(f.escCloses) refusal \(f.refusal ?? "-") field \(f.refusedField ?? "-")")
      out.append("new repo \(s.prefs.startRepo ?? "-") branches \(model.newProjectBranches) base \(g.base ?? "-") goalBranch \(g.goalBranch.isEmpty ? "-" : g.goalBranch) baseLine \(f.baseLine?.text ?? "-") branchLine \(f.branchLine?.text ?? "-")")
      out.append("new place \(s.startSandbox?.name ?? "-") driver \(s.startDriver?.provider ?? "-") effort \(s.startEffort ?? "-") setup \(model.newProjectSetup().map { "\($0.phase) \($0.header)" } ?? (model.setupFlow.isOpen ? "loading" : "-"))")
    }
    if model.menuOpen || model.openRunId != nil, let m = model.projectMenu {
      out.append("menu open \(model.menuOpen) items \(m.items.map(\.name).joined(separator: ",")) control \(m.control)")
    }
    // The app's activation and its windows, front to back: for the Open panel (`choose`).
    out.append("app active \(NSApp.isActive) policy \(NSApp.activationPolicy().rawValue) key \(NSApp.keyWindow.map { String(describing: Swift.type(of: $0)) } ?? "-")")
    for w in NSApp.windows.filter(\.isVisible).sorted(by: { $0.orderedIndex < $1.orderedIndex }) {
      out.append("window \(Swift.type(of: w)) level \(w.level.rawValue) key \(w.isKeyWindow) main \(w.isMainWindow) onScreen \(w.occlusionState.contains(.visible)) \(w is NSOpenPanel ? "OPENPANEL" : "")")
    }
    if model.paletteOpen {
      out.append("palette \"\(model.paletteQuery)\" selection \(model.paletteSelection): " + model.paletteShown.map(\.title).joined(separator: " | "))
    }
    if let run = model.openRunId, let g = s.goalCard(runId: run) {
      out.append("goal \(g.title) \(g.phase) stopped \(g.stopped) docks \(g.docks) loading \(g.loading) openPR \(g.openPR) confirm \(g.confirm ?? "-") outcome \(g.outcome.map { "\($0)" } ?? "-")")
    }
    return out.joined(separator: "\n") + "\n"
  }

  static func snapshot(into dir: URL, name: String = "window") {
    guard let w = deskWindow,
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
