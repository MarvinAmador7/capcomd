#if canImport(SwiftUI) && os(macOS) && (DEBUG || DESK_PROBE)
import AppKit

/// Development only: with CAPCOMD_DESK_SNAPSHOT=<dir>, the window draws itself into <dir>/window.png and lists its
/// scroll views' geometry in <dir>/scrolls.txt every 2 s. Its own window needs no screen-recording permission.
/// With CAPCOMD_DESK_AUTOSCROLL=<seconds>, it clicks through the reel as a crew tab does (animated), to the last column
/// and back (or first ↔ last with CAPCOMD_DESK_AUTOSCROLL_ENDS=1), every <seconds>, for Instruments. Release builds get it with -Xswiftc -DDESK_PROBE.
@MainActor enum DeskDebug {
  static func start(_ model: DeskModel) {
    if let s = ProcessInfo.processInfo.environment["CAPCOMD_DESK_AUTOSCROLL"].flatMap(Double.init) {
      var step = 1
      Timer.scheduledTimer(withTimeInterval: s, repeats: true) { _ in
        MainActor.assumeIsolated {
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
