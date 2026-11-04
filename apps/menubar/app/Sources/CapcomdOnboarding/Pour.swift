import Foundation

// The intro's crew pour (makePour in design/onboarding/onboarding.dc.html): 34 mini heads thrown out of the laptop on
// ballistic arcs, and the sparks while he types. Seeded as the prototype is (mulberry32, seed 29), so every launch and
// every test sees the same heads in the same places. Times are seconds from the intro's start.

public struct MiniHead: Hashable, Sendable {
  public var index: Int
  public var colorway: Sprite.Colorway
  /// Points per cell (2, 3 or 4).
  public var cell: Int
  /// Horizontal travel; the rise (negative: up) at 42 % of the flight; where it ends below the start.
  public var dx: Int, up: Int, fall: Int
  /// Degrees turned over the flight.
  public var rotation: Int
  public var delay: Double, duration: Double
  /// The head's top-left from the pour's origin (centring it on the laptop's lid).
  public var offset: (x: Int, y: Int) { (-7 * cell, -6 * cell) }

  public static func == (a: MiniHead, b: MiniHead) -> Bool {
    a.index == b.index && a.colorway == b.colorway && a.cell == b.cell && a.dx == b.dx && a.up == b.up && a.fall == b.fall
      && a.rotation == b.rotation && a.delay == b.delay && a.duration == b.duration
  }
  public func hash(into h: inout Hasher) { h.combine(index) }

  /// x: constant speed.
  public var x: Timed { Timed(Track(from: 0, to: Double(dx), .linear), duration: duration, delay: delay) }
  /// y: from 24 below the lid up to `up` easing out, then down to `fall` easing in, the way a thrown thing falls.
  public var y: Timed {
    Timed(Track([(0, 24), (0.42, Double(up)), (1, Double(fall))], curves: [.bezier(0.2, 0.7, 0.35, 1), .bezier(0.6, 0, 0.85, 0.45)]),
          duration: duration, delay: delay)
  }
  /// In over the first 6 %, out over the last 14 %.
  public var opacity: Timed {
    Timed(Track([(0, 0), (0.06, 1), (0.86, 1), (1, 0)], curves: [.bezier(0.2, 0.7, 0.35, 1), .ease, .ease]), duration: duration, delay: delay)
  }
  /// Degrees, constant speed.
  public var spin: Timed { Timed(Track(from: 0, to: Double(rotation), .linear), duration: duration, delay: delay) }
}

public struct Spark: Hashable, Sendable {
  /// From the pour's origin; rises 36 and fades.
  public var x: Int
  public var delay: Double
  public var rise: Timed { Timed(Track(from: 0, to: -36, Curve.out), duration: 0.4, delay: delay) }
  public var opacity: Timed { Timed(Track([(0, 0), (0.15, 1), (1, 0)], all: .out), duration: 0.4, delay: delay) }
}

public enum Pour {
  public static let count = 34
  /// Where the heads leave from: the laptop's lid, in the 1200×760 window (the welcome screen's 600, 366 below the
  /// 40 pt title bar).
  public static let origin = (x: 600, y: 406)

  public static func make() -> (heads: [MiniHead], sparks: [Spark]) {
    var rng = Mulberry32(seed: 29)
    var heads: [MiniHead] = []
    for i in 0..<count {
      let colorway: Sprite.Colorway = i % 3 == 1 ? .orange : .purple
      let cell = [2, 3, 3, 4][Int((rng.next() * 4).rounded(.down))]
      let side = i % 2 == 0 ? -1.0 : 1.0
      let dx = jsRound(side * (60 + rng.next() * 500))
      let up = -jsRound(150 + rng.next() * 300)
      let fall = jsRound(180 + rng.next() * 360)
      let rot = jsRound((rng.next() - 0.5) * 70)
      let delay = fixed(2.7 + Double(i) * 0.034, 3)
      let dur = fixed(1.3 + rng.next() * 0.6, 2)
      heads.append(MiniHead(index: i, colorway: colorway, cell: cell, dx: dx, up: up, fall: fall, rotation: rot, delay: delay, duration: dur))
    }
    var sparks: [Spark] = []
    for i in 0..<9 { sparks.append(Spark(x: jsRound(-54 + rng.next() * 102), delay: fixed(2.25 + Double(i) * 0.1, 2))) }
    return (heads, sparks)
  }

  /// When the last head has landed (the intro's props go at 5.9 s).
  public static func lastLanding(_ heads: [MiniHead]) -> Double { heads.map { $0.delay + $0.duration }.max() ?? 0 }
}

/// Number.prototype.toFixed, as a value.
func fixed(_ v: Double, _ digits: Int) -> Double {
  let s = String(format: "%.\(digits)f", v)
  return Double(s) ?? v
}
