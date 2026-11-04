import Foundation

// What's behind the screens (design/onboarding/onboarding.dc.html): the circuit traces in the window's margins
// (makeBg, seeded 11) and the five comets behind the bot on the welcome screen.

public struct TracePixel: Hashable, Sendable {
  public var x: Int, y: Int
  public var color: RGB
  /// The twinkle's delay (s): every trace twinkles together.
  public var delay: Double
}

public enum Scenery {
  /// The window the prototype draws (points).
  public static let window = (width: 1200, height: 760)

  /// 4×4 trace pixels and the 10×10 rings at each trace's ends (their top-left corners), with the twinkle's delay.
  public static func traces() -> (pixels: [TracePixel], rings: [TracePixel]) {
    var rng = Mulberry32(seed: 11)
    let cols = ["#7C4DDB", "#7C4DDB", "#7C4DDB", "#E07A1F", "#B4506A"].map { RGB(hex: $0) }
    func inCenter(_ x: Int, _ y: Int) -> Bool { x > 220 && x < 980 && y > 84 && y < 700 }
    let dirs = [(1, 0), (0, 1), (1, 1), (1, -1), (-1, 0), (0, -1), (-1, 1)]
    var pix: [TracePixel] = [], rings: [TracePixel] = []
    var made = 0, tries = 0
    while made < 18 && tries < 600 {
      tries += 1
      var x = 16 + Int((rng.next() * 144).rounded(.down)) * 8, y = 56 + Int((rng.next() * 86).rounded(.down)) * 8
      let c = cols[Int((rng.next() * Double(cols.count)).rounded(.down))], d = fixed(rng.next() * 7, 2)
      if inCenter(x, y) { continue }
      var pts = [(x, y)]
      let segs = 2 + Int((rng.next() * 2).rounded(.down))
      var ok = true
      var s = 0
      while s < segs && ok {
        let dir = dirs[Int((rng.next() * Double(dirs.count)).rounded(.down))], n = 3 + Int((rng.next() * 5).rounded(.down))
        for _ in 0..<n {
          x += dir.0 * 8; y += dir.1 * 8
          if x < 12 || x > 1184 || y < 50 || y > 744 || inCenter(x, y) { ok = false; break }
          pts.append((x, y))
        }
        s += 1
      }
      if !ok { continue }
      let dashed = rng.next() < 0.5
      for (i, pt) in pts.enumerated() {
        if i == 0 || i == pts.count - 1 { continue }
        if dashed && i % 3 == 2 { continue }
        pix.append(TracePixel(x: pt.0, y: pt.1, color: c, delay: d))
      }
      rings.append(TracePixel(x: pts[0].0 - 3, y: pts[0].1 - 3, color: c, delay: d))
      rings.append(TracePixel(x: pts[pts.count - 1].0 - 3, y: pts[pts.count - 1].1 - 3, color: c, delay: d))
      made += 1
    }
    let plus = [(0, -1), (-1, 0), (0, 0), (1, 0), (0, 1)]
    for _ in 0..<9 {
      var cx = 0, cy = 0, t = 0
      repeat { cx = 20 + Int((rng.next() * 144).rounded(.down)) * 8; cy = 60 + Int((rng.next() * 84).rounded(.down)) * 8; t += 1 } while inCenter(cx, cy) && t < 60
      if inCenter(cx, cy) { continue }
      let c = cols[Int((rng.next() * Double(cols.count)).rounded(.down))], d = fixed(rng.next() * 7, 2)
      for o in plus { pix.append(TracePixel(x: cx + o.0 * 4, y: cy + o.1 * 4, color: c, delay: d)) }
    }
    return (pix, rings)
  }

  /// The twinkle every trace pixel and ring plays: 7 s, opacity .16 → .55 → .16, ease-in-out, forever.
  public static func twinkle(delay: Double) -> Timed {
    Timed(Track([(0, 0.16), (0.5, 0.55), (1, 0.16)], all: .easeInOut), duration: 7, delay: delay, repeats: .infinity)
  }
}

/// A comet: a pixel head and a four-pixel tail crossing once a cycle, down and to the left behind him.
public struct Comet: Hashable, Sendable {
  /// Where it starts, in the comets' 552×330 box (whose top-left is 180 left of and 70 above the bot's box).
  public var x: Double, y: Double
  /// Degrees (clockwise, as CSS rotates).
  public var rotation: Double
  /// How far it travels along its heading.
  public var length: Double
  /// Seconds per crossing, and before the first.
  public var cycle: Double, delay: Double
  public var color: RGB

  public static let all: [Comet] = [
    Comet(x: 520, y: 18, rotation: 158, length: 300, cycle: 11, delay: 1.2, color: RGB(hex: "#63F5F2")),
    Comet(x: 430, y: 4, rotation: 162, length: 250, cycle: 14, delay: 4.6, color: RGB(hex: "#B795FF")),
    Comet(x: 548, y: 120, rotation: 155, length: 280, cycle: 12.5, delay: 7.9, color: RGB(hex: "#FFB15C")),
    Comet(x: 360, y: 30, rotation: 165, length: 220, cycle: 15, delay: 10.4, color: RGB(hex: "#63F5F2")),
    Comet(x: 500, y: 70, rotation: 160, length: 260, cycle: 9.5, delay: 13.1, color: RGB(hex: "#B795FF")),
  ]
  /// The box the comets live in, from the bot's top-left; the whole layer is at 60 %.
  public static let box = (x: -180.0, y: -70.0, width: 552.0, height: 330.0, opacity: 0.6)
  /// The tail's opacities, tip last (the head is near-white).
  public static let tail: [Double] = [0.14, 0.26, 0.42, 0.66]
  public static let head = RGB(hex: "#F2F2F7")

  /// Along its heading: it crosses in the first 34 % of a cycle, then waits off.
  public var travel: Timed { Timed(Track([(0, 0), (0.34, length), (1, length)], all: .linear), duration: cycle, delay: delay, repeats: .infinity) }
  public var opacity: Timed {
    Timed(Track([(0, 0), (0.04, 0.75), (0.28, 0.75), (0.34, 0), (1, 0)], all: .linear), duration: cycle, delay: delay, repeats: .infinity)
  }
  /// Where its head is and how visible, `t` seconds after the screen appeared (in the box's coordinates).
  public func state(at t: Double) -> (x: Double, y: Double, opacity: Double) {
    let d = travel.value(at: t, base: 0), a = rotation * .pi / 180
    return (x + d * cos(a), y + d * sin(a), opacity.value(at: t, base: 0))
  }
}
