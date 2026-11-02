#if canImport(SwiftUI) && os(macOS)
import AppKit
import PerfLoopProbe

/// The reel's opt-in gesture recorder (design/perf-loop CAPABILITIES.md C9): with a recorder attached, the reel's scroll
/// view hands each scroll-wheel event's deltas, phases and time to it (`perfloop.gesture/1`: nothing else, no text,
/// no window contents). Nothing attaches one in the app as it ships: the hook is one load of a nil and a branch per
/// scroll event, so behaviour and cost are as before. Dev builds attach one with CAPCOMD_DESK_RECORD_GESTURE=FILE
/// (DeskDebug.start); the bench's `record-gesture` attaches its own.
@MainActor package enum GestureTap {
  package static var recorder: GestureRecorder?
  private static var timer: Timer?

  /// The scroll view's hook (SnapScrollView.scrollWheel).
  @inline(__always) static func scrollWheel(_ e: NSEvent) { if let r = recorder { record(r, e) } }

  static func record(_ r: GestureRecorder, _ e: NSEvent) {
    r.record(t: e.timestamp, dx: Double(e.scrollingDeltaX), dy: Double(e.scrollingDeltaY), phase: e.phase.rawValue, momentum: e.momentumPhase.rawValue,
             precise: e.hasPreciseScrollingDeltas)
    timer?.invalidate(); timer = nil
    // Nothing else arrives to end a gesture whose momentum never came: wake up at its deadline.
    guard let d = r.deadline else { return }
    let t = Timer(timeInterval: max(0, d - ProcessInfo.processInfo.systemUptime) + 0.01, repeats: false) { _ in
      MainActor.assumeIsolated { r.idle(at: ProcessInfo.processInfo.systemUptime) }
    }
    RunLoop.main.add(t, forMode: .common)
    timer = t
  }

  /// Records every finished gesture: the first to `url`, the next ones beside it as NAME-2.json, NAME-3.json, …
  /// `wrote` hears of each file written (or the error).
  @discardableResult
  package static func record(to url: URL, name: String? = nil, device: String? = nil, wrote: @escaping (Result<(URL, Gesture), Error>) -> Void = { _ in }) -> GestureRecorder {
    let base = url.deletingPathExtension().lastPathComponent
    let r = GestureRecorder(name: name ?? base, device: device) { g, n in
      let dest = n == 1 ? url : url.deletingLastPathComponent().appendingPathComponent("\(base)-\(n).json")
      do {
        try FileManager.default.createDirectory(at: dest.deletingLastPathComponent(), withIntermediateDirectories: true)
        try g.encoded().write(to: dest, options: .atomic)
        wrote(.success((dest, g)))
      } catch { wrote(.failure(error)) }
    }
    recorder = r
    return r
  }

  /// Ends the open gesture (written if anything moved) and detaches the recorder.
  package static func stop() {
    timer?.invalidate(); timer = nil
    recorder?.finish()
    recorder = nil
  }
}
#endif
