import Foundation

// CSS keyframes as data: a value at key times, with the timing function each segment starts with (a keyframe's own
// `animation-timing-function`, else the animation's). The window turns a Track into a CAKeyframeAnimation (values,
// keyTimes, one timing function per segment); the tests and Reduce Motion read it with `value(at:)`.

/// A timing function: CSS cubic-bezier(), steps(n) (jump-end) or linear.
public enum Curve: Hashable, Sendable {
  case bezier(Double, Double, Double, Double)
  case steps(Int)
  case linear

  public static let ease = Curve.bezier(0.25, 0.1, 0.25, 1)
  public static let easeInOut = Curve.bezier(0.42, 0, 0.58, 1)
  /// The prototype's three: --ease-out, --ease-expo (arrivals), --ease-io (travel).
  public static let out = Curve.bezier(0.22, 1, 0.36, 1)
  public static let expo = Curve.bezier(0.16, 1, 0.3, 1)
  public static let inOut = Curve.bezier(0.76, 0, 0.24, 1)

  /// Progress through the segment (0…1) to eased progress.
  public func apply(_ p: Double) -> Double {
    let x = min(1, max(0, p))
    switch self {
    case .linear: return x
    case .steps(let n): return x >= 1 ? 1 : (x * Double(n)).rounded(.down) / Double(n)
    case .bezier(let x1, let y1, let x2, let y2):
      if x <= 0 { return 0 }
      if x >= 1 { return 1 }
      // Solve bx(t) = x (Newton, then bisection), then by(t).
      func b(_ t: Double, _ a: Double, _ c: Double) -> Double { let u = 1 - t; return 3 * u * u * t * a + 3 * u * t * t * c + t * t * t }
      func db(_ t: Double, _ a: Double, _ c: Double) -> Double { let u = 1 - t; return 3 * u * u * a + 6 * u * t * (c - a) + 3 * t * t * (1 - c) }
      var t = x
      for _ in 0..<8 {
        let e = b(t, x1, x2) - x, d = db(t, x1, x2)
        if abs(e) < 1e-7 { return b(t, y1, y2) }
        if abs(d) < 1e-6 { break }
        t -= e / d
      }
      var lo = 0.0, hi = 1.0
      t = x
      for _ in 0..<60 {
        let v = b(t, x1, x2)
        if abs(v - x) < 1e-7 { break }
        if v < x { lo = t } else { hi = t }
        t = (lo + hi) / 2
      }
      return b(t, y1, y2)
    }
  }
}

/// One animated value: keys (time 0…1 of the animation, value) and the curve each segment starts with.
public struct Track: Hashable, Sendable {
  public var times: [Double]
  public var values: [Double]
  /// One per segment (times.count - 1).
  public var curves: [Curve]
  public init(_ keys: [(Double, Double)], curves: [Curve]) {
    times = keys.map(\.0); values = keys.map(\.1); self.curves = curves
    precondition(curves.count == max(0, keys.count - 1), "a curve per segment")
  }
  /// Two keys, one curve.
  public init(from a: Double, to b: Double, _ c: Curve) { self.init([(0, a), (1, b)], curves: [c]) }
  /// The same curve on every segment.
  public init(_ keys: [(Double, Double)], all c: Curve) { self.init(keys, curves: Array(repeating: c, count: max(0, keys.count - 1))) }

  /// The value at progress `p` (0…1) of one iteration.
  public func value(at p: Double) -> Double {
    guard let first = values.first else { return 0 }
    if p <= times[0] { return first }
    for i in 0..<(times.count - 1) where p <= times[i + 1] {
      let span = times[i + 1] - times[i]
      let local = span > 0 ? (p - times[i]) / span : 1
      return values[i] + (values[i + 1] - values[i]) * curves[i].apply(local)
    }
    return values[values.count - 1]
  }
  public var start: Double { values.first ?? 0 }
  public var end: Double { values.last ?? 0 }
}

/// A track played on a clock: CSS's duration, delay, iteration count and `both` fill (before its delay it holds the
/// first key, after its last iteration the last).
public struct Timed: Hashable, Sendable {
  public var track: Track
  public var duration: Double
  public var delay: Double
  /// .infinity repeats forever.
  public var repeats: Double
  /// Holds the first key before the delay and the last after the end (`both`); without it the base value shows then.
  public var fills: Bool
  public init(_ track: Track, duration: Double, delay: Double = 0, repeats: Double = 1, fills: Bool = true) {
    self.track = track; self.duration = duration; self.delay = delay; self.repeats = repeats; self.fills = fills
  }
  public var end: Double { repeats.isInfinite ? .infinity : delay + duration * repeats }

  /// The value `t` seconds after the clock started, or `base` while the animation doesn't apply (no fill).
  public func value(at t: Double, base: Double) -> Double {
    if t < delay { return fills ? track.start : base }
    let local = (t - delay) / duration
    if local >= repeats { return fills ? track.value(at: repeats - repeats.rounded(.down) == 0 ? 1 : repeats - repeats.rounded(.down)) : base }
    return track.value(at: local - local.rounded(.down))
  }
}
