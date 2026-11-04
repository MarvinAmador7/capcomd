import Foundation
import PerfLoopProbe

// Gestures for `swipe` (design/perf-loop CAPABILITIES.md C9): where a gesture comes from, the synthetic ones the bench
// ships, and how a result's smoothness is summed up, compared and judged. The recorder, the file format and the meter
// are PerfLoop's (PerfLoopProbe: Gestures.swift, Smoothness.swift); the replay is CapcomdDeskBench/Swipe.swift.

public enum Gestures {
  /// `synthetic:NAME` is one of `synthetic` (no file needed: a copied bench binary has them); anything else is a path.
  public static let syntheticPrefix = "synthetic:"

  /// The synthetic gestures, made from the `fling` driver's curves (Drive.swift): fingers down for 6 frames of growing
  /// motion then lifted, the momentum decaying 4 % a frame; and a slow drag with no momentum. 120 Hz, whole points (what
  /// a CGEvent can carry). No hand made them: they test the pipeline, not feel. Apps/menubar/app/Gestures has them as files.
  public static let synthetic: [Gesture] = [
    flick(name: "synthetic-flick-forward", sign: -1, velocity: 2400),
    flick(name: "synthetic-flick-back", sign: 1, velocity: 2400),
    drag(name: "synthetic-drag-forward", sign: -1, ptPerFrame: 4, frames: 48),
  ]

  /// How `--gesture` names a synthetic one: `synthetic:flick-forward`.
  public static func spec(_ g: Gesture) -> String { syntheticPrefix + (g.name.hasPrefix("synthetic-") ? String(g.name.dropFirst("synthetic-".count)) : g.name) }

  public static func named(_ s: String) -> Gesture? {
    let n = s.hasPrefix(syntheticPrefix) ? String(s.dropFirst(syntheticPrefix.count)) : s
    return synthetic.first { $0.name == n || $0.name == "synthetic-" + n }
  }

  /// A gesture from `synthetic:NAME` or a file (`~` expanded); an error says what was wrong.
  public static func load(_ spec: String) -> Result<Gesture, GestureError> {
    if spec.hasPrefix(syntheticPrefix) {
      guard let g = named(spec) else { return .failure(GestureError("no synthetic gesture '\(spec)'; there are: " + synthetic.map(Gestures.spec).joined(separator: ", "))) }
      return .success(g)
    }
    let url = URL(fileURLWithPath: (spec as NSString).expandingTildeInPath)
    do {
      let g = try Gesture.read(url)
      let p = g.problems
      return p.isEmpty ? .success(g) : .failure(GestureError("\(spec): " + p.joined(separator: "; ")))
    } catch let e as DecodingError { return .failure(GestureError("\(spec): not a perfloop.gesture/1 file (\(e))")) }
    catch { return .failure(GestureError("\(spec): \(error.localizedDescription)")) }
  }

  static let frameMs = 1000.0 / 120

  /// Whole points out of a fractional curve, the rounding carried over so the sum stays within half a point.
  static func whole(_ xs: [Double]) -> [Double] {
    var acc = 0.0, sent = 0.0
    return xs.map { x in acc += x; let d = acc.rounded() - sent; sent += d; return d }
  }

  /// `fling`'s swipe: began, 6 frames growing to v/120 a frame, ended, then momentum from v decaying 4 % a frame to 20 pt/s.
  public static func flick(name: String, sign: Double, velocity v0: Double) -> Gesture {
    let finger = whole((1...6).map { k in sign * v0 / 120 * Double(k) / 6 })
    var vs: [Double] = [v0], v = v0
    while v > 20 { v *= 0.96; vs.append(v) }
    let momentum = whole(vs.map { sign * $0 / 120 })
    var es: [Gesture.Event] = [Gesture.Event(t: 0, dx: 0, phase: .mayBegin), Gesture.Event(t: frameMs, dx: 0, phase: .began)]
    for (k, d) in finger.enumerated() { es.append(Gesture.Event(t: Double(k + 2) * frameMs, dx: d, phase: .changed)) }
    var t = Double(finger.count + 2) * frameMs
    es.append(Gesture.Event(t: t, dx: 0, phase: .ended))
    for (k, d) in momentum.enumerated() { t += frameMs; es.append(Gesture.Event(t: t, dx: d, phase: .none, momentum: k == 0 ? .began : .changed)) }
    t += frameMs; es.append(Gesture.Event(t: t, dx: 0, phase: .none, momentum: .ended))
    return Gesture(name: name, device: "trackpad", hz: 120, synthetic: true,
                   source: "deskbench fling curve: 6 frames to \(Int(v0)) pt/s \(sign < 0 ? "forward" : "back"), momentum −4 %/frame to 20 pt/s, 120 Hz", events: round(es))
  }

  /// A slow, steady drag: ramps up over 6 frames, holds `ptPerFrame`, ramps down over 6, lifted without momentum.
  public static func drag(name: String, sign: Double, ptPerFrame p: Double, frames n: Int) -> Gesture {
    let ramp = 6
    let curve = (0..<n).map { k -> Double in
      let up = min(1, Double(k + 1) / Double(ramp)), down = min(1, Double(n - k) / Double(ramp))
      return sign * p * min(up, down)
    }
    var es: [Gesture.Event] = [Gesture.Event(t: 0, dx: 0, phase: .mayBegin), Gesture.Event(t: frameMs, dx: 0, phase: .began)]
    for (k, d) in whole(curve).enumerated() { es.append(Gesture.Event(t: Double(k + 2) * frameMs, dx: d, phase: .changed)) }
    es.append(Gesture.Event(t: Double(n + 2) * frameMs, dx: 0, phase: .ended))
    return Gesture(name: name, device: "trackpad", hz: 120, synthetic: true,
                   source: "deskbench drag: \(Int(p * 120)) pt/s \(sign < 0 ? "forward" : "back") for \(n) frames, ramped over 6 at each end, no momentum, 120 Hz", events: round(es))
  }

  static func round(_ es: [Gesture.Event]) -> [Gesture.Event] { es.map { var e = $0; e.t = Stats.round(e.t, 3); return e } }
}

public struct GestureError: Error, CustomStringConvertible, Sendable {
  public var description: String
  public init(_ s: String) { description = s }
}

extension Smoothness {
  /// A rep's smoothness from its gestures' (steps'): the worst gesture's error, every stall, the median jerk. nil when
  /// no step measured one (every scenario but `swipe`).
  public static func rep(_ steps: [StepResult]) -> Smoothness? {
    let xs = steps.compactMap(\.smoothness)
    guard !xs.isEmpty else { return nil }
    let err = xs.compactMap(\.positionErrorP95Pt), jerk = xs.compactMap(\.jerkP95)
    return Smoothness(positionErrorP95Pt: err.max(), stalls: xs.reduce(0) { $0 + $1.stalls }, jerkP95: jerk.isEmpty ? nil : Stats.round(Stats.median(jerk), 2),
                      positionErrorMaxPt: xs.compactMap(\.positionErrorMaxPt).max(), latencyFrames: xs.compactMap(\.latencyFrames).max(), trackingTicks: xs.reduce(0) { $0 + $1.trackingTicks }, ticks: xs.reduce(0) { $0 + $1.ticks })
  }

  /// The comparison rows (`Comparison`): the error and the stalls are guards: content that stops following the fingers
  /// is what a user sees at once, and on a quiet main thread both sit at their floor (0 pt, 0 stalls), so a band of
  /// 0.5 pt and one stall a rep is wide enough. Jerk is information: it differentiates three times, swings with the
  /// display link's jitter, and its band isn't known yet (real recordings will tell).
  static func comparisonRows(_ a: [RepResult], _ b: [RepResult], row: (String, (RepResult) -> Double?, Double, Double) -> Regression) -> [Regression] {
    func both(_ pick: (RepResult) -> Double?) -> Bool { !a.compactMap(pick).isEmpty && !b.compactMap(pick).isEmpty }
    var rows: [Regression] = []
    for (name, pick, pct, abs, role) in [("positionErrorP95Pt", { (r: RepResult) in r.smoothness?.positionErrorP95Pt }, 25.0, 0.5, "guard"),
                                         ("stalls", { (r: RepResult) in r.smoothness.map { Double($0.stalls) } }, 25, 1, "guard"),
                                         ("jerkP95", { (r: RepResult) in r.smoothness?.jerkP95 }, 25, 0.5, "info")] where both(pick) {
      var r = row(name, pick, pct, abs); r.role = role; rows.append(r)
    }
    return rows
  }

  /// The budget's part (`Budgets.evaluate`): the content follows the fingers within a point (p95) without a stall.
  public static let budgetErrorPt = 1.0
  static func budgetReasons(_ s: Summary) -> [String] {
    guard let m = s.smoothness else { return [] }
    var r: [String] = []
    if let e = m.positionErrorP95Pt, e.median > budgetErrorPt { r.append("the content was \(e.median) pt from the fingers (p95, median of reps; max \(e.max)): over the \(budgetErrorPt.clean) pt budget") }
    if m.stalls.median > 0 { r.append("\(m.stalls.median) stall(s) per rep (median; max \(m.stalls.max)): the fingers moved and the content didn't") }
    return r
  }
}

/// Medians across reps of each rep's smoothness (`Summary.smoothness`).
public struct SmoothnessSummary: Codable, Sendable, Equatable {
  public var positionErrorP95Pt: Dist?
  public var stalls: Dist
  public var jerkP95: Dist?
  public init?(reps rs: [RepResult]) {
    let xs = rs.compactMap(\.smoothness)
    guard !xs.isEmpty else { return nil }
    let e = xs.compactMap(\.positionErrorP95Pt), j = xs.compactMap(\.jerkP95)
    positionErrorP95Pt = e.isEmpty ? nil : Dist(e); stalls = Dist(xs.map { Double($0.stalls) }); jerkP95 = j.isEmpty ? nil : Dist(j)
  }
}

extension Gestures {
  /// Where `record-gesture` writes unless told otherwise: `${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/gestures`, the
  /// store's folder `perfloop gestures list` reads. Recordings of a real hand stay out of the repo.
  public static var defaultDirectory: URL {
    let env = ProcessInfo.processInfo.environment
    let home = env["PERFLOOP_HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".perfloop")
    return home.appendingPathComponent("capcomd-desktop").appendingPathComponent("gestures")
  }

  /// One line about a gesture: what `record-gesture` and `explain` print.
  public static func line(_ g: Gesture) -> String {
    let f = g.fingerTravel, m = g.momentumTravel
    return "\(g.name): \(g.events.count) events over \(Int(g.durationMs)) ms\(g.hz.map { " at \($0.clean) Hz" } ?? ""), \(g.device)\(g.synthetic == true ? ", synthetic" : ""); "
      + "fingers \(Stats.round(f.dx, 1)), \(Stats.round(f.dy, 1)) pt; momentum \(Stats.round(m.dx, 1)), \(Stats.round(m.dy, 1)) pt"
  }
}
