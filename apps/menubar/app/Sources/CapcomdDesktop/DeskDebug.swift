#if canImport(SwiftUI) && os(macOS) && DEBUG
import AppKit

/// Development only: with CAPCOMD_DESK_SNAPSHOT=<dir>, the window draws itself into <dir>/window.png and lists its
/// scroll views' geometry in <dir>/scrolls.txt every 2 s. Its own window needs no screen-recording permission.
@MainActor enum DeskDebug {
  static func start() {
    guard let dir = ProcessInfo.processInfo.environment["CAPCOMD_DESK_SNAPSHOT"], !dir.isEmpty else { return }
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
      MainActor.assumeIsolated { snapshot(into: URL(fileURLWithPath: dir)) }
    }
  }

  static func snapshot(into dir: URL) {
    guard let w = NSApp.windows.first(where: { $0.isVisible && $0.contentView != nil }),
          let frame = w.contentView?.superview ?? w.contentView,
          let rep = frame.bitmapImageRepForCachingDisplay(in: frame.bounds) else { return }
    frame.cacheDisplay(in: frame.bounds, to: rep)
    try? rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("window.png"))
    var lines = ["window \(w.frame.size) contentLayoutRect \(w.contentLayoutRect)"]
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
