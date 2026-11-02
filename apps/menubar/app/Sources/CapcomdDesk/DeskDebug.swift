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
    guard let dir = ProcessInfo.processInfo.environment["CAPCOMD_DESK_SNAPSHOT"], !dir.isEmpty else { return }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
      MainActor.assumeIsolated { snapshot(into: URL(fileURLWithPath: dir)) }
    }
  }

  static func snapshot(into dir: URL) {
    guard let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }),
          let frame = w.contentView?.superview ?? w.contentView,
          let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
    frame.layoutSubtreeIfNeeded()   // an occluded window gets no display passes: catch up before drawing it
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("window.png"))
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
