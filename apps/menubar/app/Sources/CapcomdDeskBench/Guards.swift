import AppKit
import Foundation
import CapcomdDesk
import DeskBenchKit

/// The correctness guards a run was asked for (DeskBenchKit/Guards.swift, C6), judged after each rep once the
/// scenario has settled, outside the rep's measured steps: `built-within` from the probe's bodies and the reel's views,
/// and the snapshot that `snapshot-diff` compares (the comparison itself is pairwise: `snapdiff`, run by the champion's
/// binary). Nothing here runs unless guards were asked for, so a plain `run` times exactly as before.
@MainActor enum GuardPhase {
  static var config = GuardConfig(env: ProcessInfo.processInfo.environment)

  /// Called by Runner after rep `rep`'s result is built. `label` is the run's `--variant` (ab's A or B): its files go
  /// in that subdirectory of the artifacts directory.
  static func after(rep: Int, scenario: String, steps: [StepResult], h: Harness, label: String?) async -> [GuardResult]? {
    let c = config
    guard c.active else { return nil }
    guard let last = steps.last, h.window != nil else {
      return [GuardResult(name: Guards.builtWithin, pass: false, detail: "the scenario made no step (or has no window): nothing to judge")]
    }
    // Settle: the window at rest after the scenario's last step: the main thread quiet (no stretch over 4 ms of CPU)
    // for 300 ms, settle being the end of the last busy stretch, and never before the step's own settle point (the reel
    // at rest, the frame that showed the change). The step's point alone is too early: a project opens heads first and
    // warms its threads after, over a second or more, and that is the window, not a cheat.
    let stepSettle = last.atMs + (last.settleMs ?? last.latencyMs ?? last.durationMs)
    let quiet = await h.waitQuiet(quietMs: 300, maxCpuMs: 4, timeoutMs: 8000)
    let lastBusy = h.stretches.last { $0.cpu > 4 }.map { $0.at + $0.dur } ?? stepSettle
    let settleAt = quiet == nil ? h.now() : max(stepSettle, lastBusy)
    let limit = c.value("built-within.ms")
    let until = settleAt + limit + 50
    if h.now() < until { await h.sleep(ms: until - h.now()) }
    _ = await h.nextCommit()
    let cols = onScreen(h)
    var out: [GuardResult] = []
    if c.wants(Guards.builtWithin) {
      let bodies = h.bodies.filter { $0.t >= h.columnsSince }.map { BuiltWithin.Body(t: $0.t, view: $0.view, id: $0.id) }
      var g = BuiltWithin.evaluate(columns: cols.filter { !$0.partial }.map(\.column), bodies: bodies, since: h.columnsSince, settleAt: settleAt, limitMs: limit)
      g.detail += " [settled \(Stats.round(settleAt - stepSettle, 1)) ms after the last step's own settle point\(quiet == nil ? ", never quiet within 8 s" : ""); checked \(Stats.round(h.now() - settleAt, 1)) ms after settle]"
      out.append(g)
    }
    if c.wants(Guards.snapshotDiff) {
      guard let base = c.dir else {
        out.append(GuardResult(name: Guards.snapshotDiff, pass: false, detail: "no artifacts directory (--artifacts DIR or PERFLOOP_ARTIFACTS) for the snapshot"))
        return out
      }
      let dir = label.map { base.appendingPathComponent($0) } ?? base
      let name = "\(scenario)-rep\(rep).settled"
      var files: [String] = []
      if let p = png(h, dir.appendingPathComponent("\(name).png")) { files.append(p) }
      if let l = layout(h, cols: cols, scenario: scenario), (try? JSONOut.encode(l).write(to: dir.appendingPathComponent("\(name).layout.json"), atomically: true, encoding: .utf8)) != nil {
        files.append(dir.appendingPathComponent("\(name).layout.json").path)
      }
      // A second picture 1.1 s later: what changed by itself in between (the system-drawn clocks tick every second)
      // is masked when the champion's and the candidate's pictures are compared.
      await h.sleep(ms: 1100)
      _ = await h.nextCommit()
      if let p = png(h, dir.appendingPathComponent("\(name).later.png")) { files.append(p) }
      out.append(GuardResult(name: Guards.snapshotDiff, pass: files.count == 3,
                             detail: files.count == 3 ? "captured after settle; compared with the champion's by the runner (deskbench snapdiff)" : "couldn't write the snapshot into \(dir.path)",
                             artifacts: files))
    }
    return out
  }

  struct Shown { var column: BuiltWithin.Column; var rectInWindow: CGRect?; var threadInWindow: CGRect? = nil; var partial = false }

  /// The columns the reel shows: its document's views, left to right, those in the visible part (`partial` when less
  /// than half of one shows), mapped to the model's columns by position (one view per column: a hosting view, an
  /// AppKit column holding hosting views, or the blank before it is built), each with its thread's scroll view.
  static func onScreen(_ h: Harness) -> [Shown] {
    let ids = h.model.columns
    func col(_ id: String, view: String?) -> BuiltWithin.Column {
      BuiltWithin.Column(id: id, expectsRows: !(h.world.threads[id] ?? []).isEmpty, warm: h.model.agent(id)?.warm, view: view)
    }
    guard let sv = h.reelScrollView(), let doc = sv.documentView else {
      return ids.filter(h.model.onScreen.contains).map { Shown(column: col($0, view: "missing"), rectInWindow: nil) }
    }
    let views = doc.subviews.sorted { $0.frame.minX < $1.frame.minX }
    guard views.count == ids.count else {
      return ids.filter(h.model.onScreen.contains).map { Shown(column: col($0, view: nil), rectInWindow: nil) }
    }
    let visible = sv.documentVisibleRect
    var out: [Shown] = []
    for (v, id) in zip(views, ids) {
      let part = v.frame.intersection(visible)
      guard !part.isNull, part.width >= 1 else { continue }
      // Its content: the view itself when it is a hosting view (a SwiftUI column), else the hosting views inside it (an
      // AppKit column, desk.column=native). The reel's blank placeholder has none; a hidden view shows nothing.
      var hosting: [NSView] = []
      h.walk(v) { x in if String(describing: type(of: x)).contains("HostingView") { hosting.append(x) } }
      let kind: String
      if hosting.isEmpty { kind = "placeholder" }
      else if v.isHidden || v.alphaValue == 0 { kind = "hidden" }
      else { kind = hosting.allSatisfy { $0.subviews.isEmpty && ($0.layer?.sublayers ?? []).isEmpty } ? "empty" : "hosting" }
      // The thread: the biggest vertical scroll view inside the column, clipped to what shows.
      var thread: CGRect?
      h.walk(v) { x in
        guard let s = x as? NSScrollView, s.frame.height > 60 else { return }
        let r = s.convert(s.bounds, to: nil).intersection(doc.convert(part, to: nil))
        if !r.isNull, r.width * r.height > (thread.map { $0.width * $0.height } ?? 0) { thread = r }
      }
      out.append(Shown(column: col(id, view: kind), rectInWindow: doc.convert(part, to: nil), threadInWindow: thread, partial: part.width < v.frame.width / 2))
    }
    return out
  }

  /// The window drawn by itself into a PNG (no screen-recording permission), as `snapshot` does.
  static func png(_ h: Harness, _ url: URL) -> String? {
    guard let frame = h.window.contentView?.superview ?? h.window.contentView, let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return nil }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
    guard (try? rep.representation(using: .png, properties: [:])?.write(to: url)) != nil else { return nil }
    return url.path
  }

  /// Where the columns are in the PNG: pixels, top-left origin.
  static func layout(_ h: Harness, cols: [Shown], scenario: String) -> SnapshotLayout? {
    guard let frame = h.window.contentView?.superview ?? h.window.contentView else { return nil }
    let scale = h.window.backingScaleFactor, H = frame.bounds.height
    func px(_ r: CGRect) -> [Int] { [r.minX * scale, (H - r.maxY) * scale, r.width * scale, r.height * scale].map { Int($0.rounded()) } }
    let cs = cols.compactMap { s -> SnapshotLayout.Col? in
      guard let r = s.rectInWindow else { return nil }
      return SnapshotLayout.Col(id: s.column.id, rect: px(r), thread: s.threadInWindow.map(px), partial: s.partial ? true : nil)
    }
    return SnapshotLayout(scenario: scenario, scale: scale, widthPx: Int((frame.bounds.width * scale).rounded()), heightPx: Int((H * scale).rounded()), columns: cs,
                          at: ISO8601DateFormatter().string(from: Date()))
  }
}

/// `deskbench snapdiff A.png B.png`: the champion's snapshot (A) against the candidate's (B), headless. Beside each
/// PNG it reads `<name>.later.png` (the same window 1.1 s later: what moved by itself is masked) and
/// `<name>.layout.json` (where the columns were). Prints the guard record; exit 0 within tolerance, 3 over it.
enum SnapDiff {
  static func run(_ files: [String], params: [String], diffOut: String?, json: Bool) -> Int32 {
    guard files.count == 2 else { err("usage: deskbench snapdiff A.png B.png [--guard-param snapshot-diff.tolerance=0.005] [--diff-out DIFF.png] [--json]"); return Int32(ExitCode.usage) }
    let c = GuardConfig(env: [:], params: params)
    let a = URL(fileURLWithPath: files[0]), b = URL(fileURLWithPath: files[1])
    guard let ia = load(a), let ib = load(b) else { err("deskbench: couldn't read \(load(a) == nil ? a.path : b.path) as a PNG"); return Int32(ExitCode.harness) }
    let threshold = Int(c.value("snapshot-diff.threshold"))
    let la = layout(a), lb = layout(b)
    let scale = la?.scale ?? 2
    var mask: [Bool]?
    for (img, url) in [(ia, a), (ib, b)] {
      guard let later = load(sibling(url, ".later.png")) else { continue }
      let m = SnapshotDiff.unstable(img, later, threshold: threshold)
      mask = mask.map { zip($0, m).map { $0 || $1 } } ?? m
    }
    if let m = mask {
      mask = SnapshotDiff.dilate(m, width: ia.width, height: ia.height, rx: Int(c.value("snapshot-diff.maskPt") * scale), ry: Int(3 * scale))
    }
    let r = SnapshotDiff.compare(ia, ib, mask: mask, columns: la?.columns ?? [], columnsB: lb?.columns, tolerance: c.value("snapshot-diff.tolerance"),
                                 columnTolerance: c.value("snapshot-diff.columnTolerance"), bboxPx: Int(c.value("snapshot-diff.bboxPt") * scale),
                                 threadInkMin: c.value("snapshot-diff.threadInkMin"), threshold: threshold)
    var artifacts = [a.path, b.path]
    if let d = diffOut, write(SnapshotDiff.picture(ia, ib, mask: mask, threshold: threshold), to: URL(fileURLWithPath: d)) { artifacts.append(d) }
    var g = SnapshotDiff.guardResult(r, artifacts: artifacts)
    if la == nil { g.detail += " (no layout beside \(a.lastPathComponent): columns not checked)" }
    if mask == nil { g.detail += " (no .later.png: nothing masked)" }
    struct Out: Codable { var schema = "deskbench.snapdiff/1"; var `guard`: GuardResult; var report: SnapshotDiff.Report }
    out(json ? JSONOut.encode(Out(guard: g, report: r)) : "snapshot-diff: \(g.pass ? "PASS" : "OVER TOLERANCE (needs review)") \(g.detail)"
        + r.columns.map { "\n  \($0.id): \(Stats.round($0.ratio * 100, 3)) %\($0.why.map { " ✗ " + $0 } ?? "")" }.joined())
    return Int32(g.pass ? ExitCode.ok : ExitCode.budget)
  }

  static func sibling(_ png: URL, _ suffix: String) -> URL {
    png.deletingLastPathComponent().appendingPathComponent(png.deletingPathExtension().lastPathComponent + suffix)
  }
  static func layout(_ png: URL) -> SnapshotLayout? {
    (try? Data(contentsOf: sibling(png, ".layout.json"))).flatMap { try? JSONOut.decode(SnapshotLayout.self, from: $0) }
  }

  /// A PNG as 8-bit RGBA, drawn into one known format (so two files encoded differently compare by their pixels).
  static func load(_ url: URL) -> RGBAImage? {
    guard let data = try? Data(contentsOf: url), let rep = NSBitmapImageRep(data: data), let cg = rep.cgImage else { return nil }
    let w = cg.width, h = cg.height
    var px = [UInt8](repeating: 0, count: w * h * 4)
    let ok = px.withUnsafeMutableBytes { buf -> Bool in
      guard let ctx = CGContext(data: buf.baseAddress, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
      ctx.draw(cg, in: CGRect(x: 0, y: 0, width: w, height: h))
      return true
    }
    return ok ? RGBAImage(width: w, height: h, pixels: px) : nil
  }

  static func write(_ img: RGBAImage, to url: URL) -> Bool {
    var px = img.pixels
    let rep = px.withUnsafeMutableBufferPointer { buf -> NSBitmapImageRep? in
      var planes: UnsafeMutablePointer<UInt8>? = buf.baseAddress
      return NSBitmapImageRep(bitmapDataPlanes: &planes, pixelsWide: img.width, pixelsHigh: img.height, bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                              colorSpaceName: .deviceRGB, bytesPerRow: img.width * 4, bitsPerPixel: 32)?.copy() as? NSBitmapImageRep
    }
    guard let data = rep?.representation(using: .png, properties: [:]) else { return false }
    return (try? data.write(to: url)) != nil
  }
}
