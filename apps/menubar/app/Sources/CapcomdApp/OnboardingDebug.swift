#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import QuartzCore
import CapcomdStore
import CapcomdOnboarding

/// Development only (DEBUG or DESK_PROBE builds): drives the onboarding without touching the screen, as DeskDebug drives
/// the window. With CAPCOMD_ONBOARDING_CONTROL=<dir>, every quarter second it runs the lines of <dir>/cmd (then deletes
/// it) and writes the onboarding's state to <dir>/state.txt. Lines: `show [welcome|boot] [intro]`, `primary` (the
/// primary button), `back`, `skip`, `copy`, `checkagain`, `missing` (the no-CLI state, for a look), `login on|off`, `place docker|boxd`, `signin claude|codex`,
/// `pick N` (the N-th project), `goal <text>`, `chip N`, `open` (Open capcomd), `close`, `reset` (forget it was seen),
/// `key return` (a Return handed to the window), `snap <name>` (the window, as it shows now, into <dir>/<name>.png).
/// CAPCOMD_ONBOARDING_SNAPS="0.5,1.2,…" snaps the intro at those seconds (intro-<s>.png); the frame count of each intro
/// goes to state.txt (`frames …`).
@MainActor enum OnboardingDebug {
  private static var started = false, snapsScheduled = false
  static func attach(_ c: OnboardingController) {
    #if DEBUG || DESK_PROBE
    guard let dir = ProcessInfo.processInfo.environment["CAPCOMD_ONBOARDING_CONTROL"], !dir.isEmpty else { return }
    let d = URL(fileURLWithPath: dir)
    if !snapsScheduled, let snaps = ProcessInfo.processInfo.environment["CAPCOMD_ONBOARDING_SNAPS"], c.model?.intro == .playing {
      snapsScheduled = true   // the first intro only: a replay is for measuring, undisturbed
      for s in snaps.split(separator: ",").compactMap({ Double($0.trimmingCharacters(in: .whitespaces)) }) {
        DispatchQueue.main.asyncAfter(deadline: .now() + s) { snapshot(c, into: d, name: String(format: "intro-%.2f", s)) }
      }
    }
    guard !started else { return }
    started = true
    Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { _ in MainActor.assumeIsolated { control(c, d) } }
    #endif
  }

  #if DEBUG || DESK_PROBE
  static func control(_ c: OnboardingController, _ dir: URL) {
    let cmd = dir.appendingPathComponent("cmd")
    if let text = try? String(contentsOf: cmd, encoding: .utf8) {
      try? FileManager.default.removeItem(at: cmd)
      for line in text.split(separator: "\n").map(String.init) {
        let w = line.split(separator: " ").map(String.init)
        let m = c.model
        switch w.first {
        case "show":
          let step: OnboardStep = w.contains("boot") ? .boot : .welcome
          if c.window == nil { c.show(step: step, intro: w.contains("intro")) }
        case "primary": m?.primary()
        case "back": m?.back()
        case "skip": m?.skip()
        case "copy": m?.copyInstall()
        case "checkagain": m?.checkAgain()
        case "missing": m?.debugShowMissingCLI()   // the no-CLI state, drawn without hiding the CLI
        case "login": m?.setAtLogin(w.dropFirst().first == "on")
        case "place": if let p = w.dropFirst().first { m?.pickPlace(p) }
        case "signin": if let p = w.dropFirst().first { m?.startSignIn(p) }
        case "pick": if let n = w.dropFirst().first.flatMap(Int.init), let m, m.repos.indices.contains(n - 1) { let p = m.repos[n - 1].path; Task { await m.pick(p) } }
        case "goal": m?.setGoal(String(line.dropFirst(5)))
        case "chip": if let n = w.dropFirst().first.flatMap(Int.init), Launch.suggestions.indices.contains(n - 1) { m?.setGoal(Launch.suggestions[n - 1]) }
        case "open": m?.open()
        case "close": c.window?.performClose(nil)
        case "reset": Record().write { UserDefaults.standard.set($1, forKey: $0) }
        case "key": if w.dropFirst().first == "return" { key(c.window, "\r", 36) }
        case "snap": if w.count > 1 { snapshot(c, into: dir, name: w[1]) }
        default: break
        }
      }
    }
    try? state(c).write(to: dir.appendingPathComponent("state.txt"), atomically: true, encoding: .utf8)
  }

  static func key(_ w: NSWindow?, _ chars: String, _ code: UInt16) {
    guard let w, let e = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: ProcessInfo.processInfo.systemUptime,
                                          windowNumber: w.windowNumber, context: nil, characters: chars, charactersIgnoringModifiers: chars,
                                          isARepeat: false, keyCode: code) else { return }
    if w.performKeyEquivalent(with: e) { return }
    w.firstResponder?.keyDown(with: e)
  }

  static func state(_ c: OnboardingController) -> String {
    let r = c.record
    var out = ["record seen \(r.seen) finished \(r.finished) window \(c.window != nil) holdsMain \(OnboardingController.holdsMainWindow)"]
    guard let m = c.model else { return out.joined(separator: "\n") + "\n" }
    let f = m.flow, b = f.boot
    out.append("step \(f.step) intro \(m.intro) primary \(f.primary?.label ?? "-") enabled \(f.primaryEnabled) back \(f.backEnabled)")
    out.append("boot stage \(b.stage) missing \(b.cliMissing) atLogin \(b.atLogin) version \(b.version ?? "-") path \(b.path ?? "-") failure \(b.failure.map { "\($0.stage): \($0.message)" } ?? "-") bubble \"\(b.bubble)\"")
    for i in 0..<3 { out.append("row \(i + 1) \(b.row(i)) \"\(b.label(i))\" \(b.detail(i).map { "\"\($0)\"" } ?? "-")") }
    out.append("token \(m.session.token) cli \(m.session.cli ?? "-") start \(m.session.start)")
    out.append("place \(f.place) docker \(m.place("docker").map { "\($0.available) \($0.reason ?? "-")" } ?? "-") boxd \(m.place("boxd").map { "\($0.available) \($0.reason ?? "-")" } ?? "-")")
    for p in ["claude", "codex"] { out.append("login \(p) \(m.signIn(p)) \(m.login(p).map { "\($0.state) \($0.command)" } ?? "-")") }
    out.append("project \(f.project ?? "-") ready \(f.projectReady) checking \(m.projectChecking) setup \(m.setupScreen.map { "\($0.phase) \($0.header)" } ?? "-") startRepo \(m.app.startRepo ?? "-")")
    for (i, repo) in m.repos.enumerated() { out.append("repo \(i + 1) \(repo.name) \(repo.path) \(repo.branch ?? "-") known \(repo.known)") }
    out.append("goal \"\(f.goal)\" run \(f.runId ?? "-") failure \(f.launchFailure ?? "-") planner \(m.planner.map { "\($0.name): \($0.status)" } ?? "-")")
    for (i, w) in m.workers.enumerated() { out.append("worker \(i + 1) \(w.name): \(w.status) lands \(m.arrival(i))ms") }
    if let fr = m.framesReport { out.append(fr) }
    return out.joined(separator: "\n") + "\n"
  }

  /// The window as it shows: the canvas's layers as they are now (presentation values), the SwiftUI screens over them,
  /// and the window's buttons.
  static func snapshot(_ c: OnboardingController, into dir: URL, name: String) {
    guard let w = c.window, let root = w.contentView else { return }
    let scale = w.backingScaleFactor, size = root.bounds.size
    guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale), pixelsHigh: Int(size.height * scale), bitsPerSample: 8,
                                     samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
          let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return }
    rep.size = size
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = ctx
    let cg = ctx.cgContext
    cg.clear(CGRect(x: 0, y: 0, width: size.width * scale, height: size.height * scale))
    cg.scaleBy(x: scale, y: scale)
    cg.interpolationQuality = .none   // the sprites are nearest-neighbour on screen too
    let canvas = c.model?.canvas
    if let layer = canvas?.layer { (layer.presentation() ?? layer).render(in: cg) }
    // The screens without the canvas (it's inside the hosting view), then the window's buttons.
    canvas?.isHidden = true
    root.layoutSubtreeIfNeeded()
    for v in root.subviews {
      guard v.alphaValue > 0.01, let r = v.bitmapImageRepForCachingDisplay(in: v.bounds) else { continue }
      v.cacheDisplay(in: v.bounds, to: r)
      r.draw(in: v.frame, from: .zero, operation: .sourceOver, fraction: v.alphaValue, respectFlipped: true, hints: nil)
    }
    canvas?.isHidden = false
    NSGraphicsContext.restoreGraphicsState()
    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png"))
  }
  #endif
}
#endif
