import AppKit
import Foundation
import CapcomdDesk
import DeskBenchKit
import PerfLoopProbe

/// `deskbench record-gesture`: the bench window on a fixture, at its middle column, recording the owner's swipes on the
/// reel (GestureTap: deltas, phases, times; nothing else) until enough gestures ended or the time ran out. The files are
/// `perfloop.gesture/1`, for `run swipe --gesture FILE`. Only a hand on the trackpad makes events here: nothing is sent.
@MainActor enum RecordGesture {
  static let usage = """
  usage: deskbench record-gesture [--name NAME] [--out FILE] [--count N] [--timeout S] [--fixture F] [--size WxH]
                                  [--device NAME] [--allow-in-repo] [--json]
    Opens the bench window and records your swipes on the reel (two fingers on the trackpad, over the columns).
    --name     the gesture's name (default: the file's name, else "gesture")
    --out      default: \(Gestures.defaultDirectory.path)/NAME.json; more than one gesture: NAME-2.json, … beside it
               (never inside a git checkout: a recording of your hand stays out of the repo, unless --allow-in-repo)
    --count    gestures to record before it stops (default 1)
    --timeout  seconds to wait for them (default 60)
    --device   what to call the device (default: trackpad when the deltas are precise with phases, else mouse)
  """

  /// Where the recording goes, or why not there. Checked before the window shows (main.swift: a refused --out opens none).
  static func destination(_ args: Args) -> Result<URL, GestureError> {
    let name = args.one("name") ?? "gesture"
    let dest = args.one("out").map { URL(fileURLWithPath: ($0 as NSString).expandingTildeInPath) } ?? Gestures.defaultDirectory.appendingPathComponent("\(name).json")
    if let repo = Capture.checkout(containing: dest), !args.has("allow-in-repo") {
      return .failure(GestureError("\(dest.path) is inside the git checkout \(repo.path): a recording of a hand stays out of the repo (--out elsewhere, or --allow-in-repo if the owner says so)"))
    }
    return .success(dest)
  }

  /// How far the reel's offset is from the nearest column edge, in pt.
  static func restOffset(_ h: Harness) -> Double? {
    guard let sv = h.reelScrollView(), let doc = sv.documentView else { return nil }
    let xs = doc.subviews.map(\.frame.minX).sorted()
    guard xs.count > 1 else { return nil }
    let pitch = Double(xs[1] - xs[0]), x = Double(sv.contentView.bounds.origin.x) + Double(sv.contentInsets.left)
    return abs(x / pitch - (x / pitch).rounded()) * pitch
  }

  static func run(_ args: Args) async -> Int32 {
    if args.has("help") { out(usage); return 0 }
    let dest: URL
    switch destination(args) { case .success(let u): dest = u; case .failure(let e): err("deskbench: \(e)"); return Int32(ExitCode.refused) }
    let name = args.one("name") ?? dest.deletingPathExtension().lastPathComponent
    let count = max(1, args.one("count").flatMap(Int.init) ?? 1)
    let timeout = args.one("timeout").flatMap(Double.init) ?? 60
    let fixture = args.one("fixture") ?? "crew17"
    guard let w = Fixtures.make(fixture) else { err("deskbench: " + (Fixtures.problem(fixture) ?? "unknown fixture '\(fixture)'")); return Int32(ExitCode.usage) }
    var size = CGSize(width: 1440, height: 900)
    if let s = args.one("size") { let p = s.lowercased().split(separator: "x"); if p.count == 2, let x = Double(p[0]), let y = Double(p[1]) { size = CGSize(width: x, height: y) } }
    let h = Harness.current ?? Harness(world: w)
    h.showWindow(size: size, activate: true)
    _ = await h.nextCommit()
    _ = await h.ensureActive(true)
    await h.sleep(ms: 500)
    let cols = h.model.columns
    if !cols.isEmpty { h.model.scroll(to: cols[max(0, (cols.count - h.model.across) / 2)], animated: false); _ = await h.nextCommit() }

    AppKitScrollTrace.installIfAsked()
    var written: [(URL, Gesture)] = [], failures: [String] = []
    GestureTap.record(to: dest, name: name, device: args.one("device")) { r in
      switch r {
      case .success(let x):
        written.append(x); err("recorded \(Gestures.line(x.1)) → \(x.0.path)")
        // Enough: stop recording now. The wait below for where the reel came to rest must not record a swipe made
        // meanwhile (--count 3 wrote 4 when the last two came in quick succession).
        if written.count >= count { GestureTap.recorder = nil }
      case .failure(let e): failures.append("\(e)"); err("deskbench: couldn't write the gesture: \(e)")
      }
    }
    err("recording: swipe the reel with two fingers, over the columns (\(count) gesture\(count == 1 ? "" : "s"), up to \(Int(timeout)) s)")
    let deadline = h.now() + timeout * 1000
    var rests: [Double] = []
    while (written.count < count || rests.count < written.count) && failures.isEmpty && h.now() < deadline {
      await h.sleep(ms: 50)
      // Where the reel came to rest after each gesture: it should be a column edge (the reel snaps).
      // At rest is when the clip view's offset stopped changing for 150 ms: AppKit's own deceleration can carry it on
      // after the reel's slide ended (DESKBENCH.md, Recorded gestures).
      if rests.count < written.count, !h.model.reelMoving, let sv = h.reelScrollView() {
        var lastX = sv.contentView.bounds.origin.x, lastMove = h.now()
        let since = h.now()
        while h.now() - lastMove < 150, h.now() - since < 2000 {
          await h.sleep(ms: 16)
          if sv.contentView.bounds.origin.x != lastX { lastX = sv.contentView.bounds.origin.x; lastMove = h.now() }
        }
        if !h.model.reelMoving, let off = restOffset(h) { rests.append(off); err("  the reel came to rest \(Stats.round(off, 1)) pt from a column edge\(off < 2 ? "" : " (it should snap to one)")") }
      }
    }
    // Enough: the recorder is already detached. Out of time: keep the one in flight.
    if written.count < count { GestureTap.stop() }
    h.closeWindow()
    if args.has("json") {
      struct R: Codable { var schema = "deskbench.recorded/1"; var files: [String]; var gestures: [Gesture] }
      out(JSONOut.encode(R(files: written.map(\.0.path), gestures: written.map(\.1))))
    } else {
      for (u, g) in written { out("\(u.path)\n  \(Gestures.line(g))") }
      if let (u, _) = written.first { out("replay: deskbench run swipe --gesture \(u.path)") }
    }
    if !failures.isEmpty { return Int32(ExitCode.harness) }
    if written.isEmpty { err("deskbench: no gesture recorded within \(Int(timeout)) s (swipe with two fingers over the window's columns)"); return Int32(ExitCode.harness) }
    return 0
  }
}

/// `deskbench gestures [FILE…] [--write DIR] [--json]`, headless: the synthetic gestures `swipe` has built in, and
/// whether each FILE is a gesture it can replay. `--write DIR` writes the synthetic ones as files (apps/menubar/app/Gestures).
enum GestureList {
  static func run(_ args: Args) -> Int32 {
    let files = Array(args.positional.dropFirst())
    if let dir = args.one("write") {
      let d = URL(fileURLWithPath: (dir as NSString).expandingTildeInPath)
      do {
        try FileManager.default.createDirectory(at: d, withIntermediateDirectories: true)
        for g in Gestures.synthetic { let u = d.appendingPathComponent("\(g.name).json"); try g.encoded().write(to: u, options: .atomic); out(u.path) }
        return 0
      } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }
    }
    struct Row: Codable { var spec: String; var name: String?; var problems: [String]; var events: Int?; var durationMs: Double?; var synthetic: Bool?; var line: String? }
    var rows = Gestures.synthetic.map { Row(spec: Gestures.spec($0), name: $0.name, problems: [], events: $0.events.count, durationMs: $0.durationMs, synthetic: true, line: Gestures.line($0)) }
    for f in files {
      switch Gestures.load(f) {
      case .success(let g): rows.append(Row(spec: f, name: g.name, problems: [], events: g.events.count, durationMs: g.durationMs, synthetic: g.synthetic, line: Gestures.line(g)))
      case .failure(let e): rows.append(Row(spec: f, name: nil, problems: [e.description], events: nil, durationMs: nil, synthetic: nil, line: nil))
      }
    }
    if args.has("json") { out(JSONOut.encode(rows)) } else {
      for r in rows { out(r.problems.isEmpty ? "\(r.spec)\n  \(r.line ?? "")" : "\(r.spec): \(r.problems.joined(separator: "; "))") }
    }
    return rows.contains { !$0.problems.isEmpty } ? Int32(ExitCode.usage) : 0
  }
}
