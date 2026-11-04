#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import QuartzCore
import CapcomdOnboarding

// The intro and the welcome screen's bot, in Core Animation (design/onboarding/onboarding.dc.html). Every keyframe is
// CapcomdOnboarding's (the prototype's CSS as data), handed to the render server as CAKeyframeAnimations with a timing
// function per segment, so nothing runs on the main thread while it plays: the backdrop's circle, the margins' traces,
// the bot (scan line, CRT, power-on, blink, laptop, typing, the lift), the comets, the sparks and the 34 heads.
// Sprites are one-pixel-per-cell images scaled with nearest-neighbour filtering at whole points per cell.

/// The window's 1200×760 canvas under the SwiftUI screens.
@MainActor final class IntroCanvasView: NSView {
  nonisolated static let size = CGSize(width: Scenery.window.width, height: Scenery.window.height)
  private let backdrop = CALayer(), circle = CAShapeLayer(), chrome = CALayer()
  private var hero: CALayer?, pour: CALayer?, laptop: CALayer?
  /// The clock the current welcome screen's animations started on (layer time).
  private var t0: CFTimeInterval = 0
  /// The intro is playing (or played) on this canvas.
  private(set) var playing = false

  override init(frame: NSRect) {
    super.init(frame: frame)
    let root = CALayer()
    root.frame = CGRect(origin: .zero, size: Self.size)
    layer = root
    wantsLayer = true
    // The window's ground: a circle of 1000 about the centre, clipped to the window's rounded rectangle; the intro grows
    // it from nothing. (Clipping, not a mask, so CALayer.render draws it as it shows, for the debug snapshots.)
    backdrop.frame = root.bounds
    backdrop.cornerRadius = 12
    backdrop.masksToBounds = true
    circle.frame = root.bounds
    circle.path = CGPath(ellipseIn: CGRect(x: 600 - 1000, y: 380 - 1000, width: 2000, height: 2000), transform: nil)
    circle.fillColor = CGColor(srgbRed: 7 / 255, green: 7 / 255, blue: 11 / 255, alpha: 1)
    backdrop.addSublayer(circle)
    root.addSublayer(backdrop)
    chrome.frame = root.bounds
    root.addSublayer(chrome)
    buildTraces()
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isOpaque: Bool { false }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }   // the screens above take the clicks

  private var now: CFTimeInterval { layer!.convertTime(CACurrentMediaTime(), from: nil) }

  /// y from the top (as the prototype measures) to this canvas's bottom-left origin.
  static func y(_ top: Double, _ h: Double, in height: Double = Double(size.height)) -> CGFloat { CGFloat(height - top - h) }

  // MARK: The scenery

  /// The margins' circuit traces and rings, one layer per trace (its pixels share the twinkle).
  private func buildTraces() {
    let (pix, rings) = Scenery.traces()
    var groups: [Double: CALayer] = [:]
    func group(_ d: Double) -> CALayer {
      if let g = groups[d] { return g }
      let g = CALayer(); g.frame = chrome.bounds; g.opacity = 0.28
      let a = Self.animation("opacity", Scenery.twinkle(delay: d), t0: now, fills: false)
      g.add(a, forKey: "twinkle")
      chrome.addSublayer(g); groups[d] = g
      return g
    }
    for p in pix {
      let l = CALayer()
      l.frame = CGRect(x: CGFloat(p.x), y: Self.y(Double(p.y), 4), width: 4, height: 4)
      l.backgroundColor = p.color.cg
      group(p.delay).addSublayer(l)
    }
    for r in rings {
      let l = CALayer()
      l.frame = CGRect(x: CGFloat(r.x), y: Self.y(Double(r.y), 10), width: 10, height: 10)
      l.borderColor = r.color.cg; l.borderWidth = 2
      // .bgring and .bgpix both twinkle with the same keys (the ring's resting .3 is the pixel's .28, near enough).
      group(r.delay).addSublayer(l)
    }
  }

  // MARK: The welcome screen

  /// Builds the welcome screen's bot: with the intro (`intro`), or settled in place with his loops (`still`: Reduce
  /// Motion, nothing moves).
  func showWelcome(intro: Bool, still: Bool) {
    hideWelcome()
    t0 = now
    playing = intro
    CATransaction.begin(); CATransaction.setDisableActions(true)
    if intro {
      // x and y apart (a uniform transform.scale also scales z, which CALayer.render skips as 3D).
      circle.add(Self.animation("transform.scale.x", Intro.backdrop, t0: t0, map: { max(0.0001, $0 / 1000) }), forKey: "open")
      circle.add(Self.animation("transform.scale.y", Intro.backdrop, t0: t0, map: { max(0.0001, $0 / 1000) }), forKey: "open.y")
      chrome.opacity = 1
      chrome.add(Self.animation("opacity", Intro.chrome, t0: t0), forKey: "in")
    } else {
      settle()
    }
    let h = buildHero(intro: intro, still: still)
    if intro {
      let p = buildPour()
      layer!.insertSublayer(p, below: h)
      pour = p
    }
    CATransaction.commit()
  }

  /// Leaving the welcome screen: his layers go.
  func hideWelcome() {
    hero?.removeFromSuperlayer(); hero = nil
    pour?.removeFromSuperlayer(); pour = nil
    laptop = nil
  }

  /// The intro's props (laptop, sparks, heads) are taken away at 5.9 s.
  func dropProps() {
    pour?.removeFromSuperlayer(); pour = nil
    laptop?.removeFromSuperlayer(); laptop = nil
  }

  /// The backdrop without the intro (a later screen, or after it played).
  func settle() {
    circle.removeAnimation(forKey: "open"); circle.removeAnimation(forKey: "open.y")
    chrome.removeAnimation(forKey: "in"); chrome.opacity = 1
  }

  private func buildHero(intro: Bool, still: Bool) -> CALayer {
    let cell = CGFloat(WelcomeLayout.heroCell), side = CGFloat(WelcomeLayout.heroSide)
    let dy = WelcomeLayout.liftOffset
    // The lift group: his box and the shadow 24 under it, scaled about its bottom centre.
    let lift = CALayer()
    lift.anchorPoint = CGPoint(x: 0.5, y: 0)
    lift.bounds = CGRect(x: 0, y: 0, width: side, height: side + 24)
    lift.position = CGPoint(x: WelcomeLayout.heroLeft + Double(side) / 2, y: Self.y(WelcomeLayout.heroTop, Double(side) + 24))
    layer!.addSublayer(lift)
    hero = lift
    if intro {
      let l = Intro.lift(dy: dy)
      lift.add(Self.animation("transform.translation.y", l.y, t0: t0, map: { -$0 }), forKey: "lift.y")
      lift.add(Self.animation("transform.scale.x", l.scaleX, t0: t0), forKey: "lift.sx")
      lift.add(Self.animation("transform.scale.y", l.scaleY, t0: t0), forKey: "lift.sy")
    }

    // The comets behind him (chrome: hidden with Reduce Motion).
    if !still {
      let b = Comet.box
      let box = CALayer()
      box.frame = CGRect(x: b.x, y: Double(side) + 24 - b.y - b.height, width: b.width, height: b.height)
      box.opacity = Float(b.opacity)
      if intro { box.add(Self.animation("opacity", Intro.chrome, t0: t0, map: { $0 * b.opacity }), forKey: "in") }
      for c in Comet.all {
        let origin = CALayer()
        origin.frame = CGRect(x: c.x, y: b.height - c.y, width: 0, height: 0)
        origin.setAffineTransform(CGAffineTransform(rotationAngle: CGFloat(-c.rotation * .pi / 180)))
        let strip = CALayer()
        strip.frame = CGRect(x: 0, y: -2, width: 28, height: 4)
        strip.opacity = 0
        for (i, a) in (Comet.tail + [1]).enumerated() {
          let px = CALayer()
          px.frame = CGRect(x: CGFloat(i) * 6, y: 0, width: 4, height: 4)
          px.backgroundColor = i == 4 ? Comet.head.cg : c.color.cg
          px.opacity = Float(a)
          strip.addSublayer(px)
        }
        strip.add(Self.animation("transform.translation.x", c.travel, t0: t0), forKey: "travel")
        strip.add(Self.animation("opacity", c.opacity, t0: t0), forKey: "fade")
        origin.addSublayer(strip)
        box.addSublayer(origin)
      }
      lift.addSublayer(box)
    }

    // The shadow under him.
    let shadow = CALayer()
    shadow.frame = CGRect(x: (side - 120) / 2, y: 0, width: 120, height: 8)
    shadow.backgroundColor = CGColor(srgbRed: 0x1A / 255, green: 0x1A / 255, blue: 0x24 / 255, alpha: 1)
    shadow.opacity = still ? 0.5 : 1
    if intro { shadow.add(Self.animation("opacity", Intro.shadowIn, t0: t0), forKey: "in") }
    if !still {
      let from = intro ? Intro.windowOpens : 0
      shadow.add(Self.animation("transform.scale.x", Self.later(Intro.shadowScale, from), t0: t0, fills: false), forKey: "pulse.s")
      shadow.add(Self.animation("opacity", Self.later(Intro.shadowOpacity, from), t0: t0, fills: false), forKey: "pulse.o")
    }
    lift.addSublayer(shadow)

    // bob › tap › (mat: body, face cover, lids), the signal, the laptop.
    let bob = CALayer()
    bob.frame = CGRect(x: 0, y: 24, width: side, height: side)
    if !still { bob.add(Self.animation("transform.translation.y", Self.later(Intro.bob, intro ? Intro.windowOpens : 0), t0: t0, fills: false, map: { -$0 }), forKey: "bob") }
    lift.addSublayer(bob)
    let tap = CALayer()
    tap.frame = bob.bounds
    if intro { tap.add(Self.animation("transform.translation.y", Intro.tap, t0: t0, fills: false, map: { -$0 }), forKey: "tap") }
    bob.addSublayer(tap)

    let mat = CALayer()
    mat.frame = tap.bounds
    func sprite(_ g: PixelGrid) -> CALayer {
      let l = CALayer()
      l.frame = CGRect(x: 0, y: 0, width: CGFloat(g.width) * cell, height: CGFloat(g.height) * cell)
      l.contents = PixelImages.image(g)
      l.magnificationFilter = .nearest; l.minificationFilter = .nearest
      return l
    }
    mat.addSublayer(sprite(Sprite.body(.orange)))
    if intro {
      let face = sprite(Sprite.faceOff(.orange))
      face.opacity = 0
      face.add(Self.animation("opacity", Intro.faceCover, t0: t0), forKey: "poweron")
      mat.addSublayer(face)
      // The CRT opening: his box clipped to a band about its middle line that grows to the whole box.
      mat.masksToBounds = true
      let crt = Self.animation("bounds.size.height", Intro.crt, t0: t0, map: { $0 * Double(side) })
      let shift = Self.animation("bounds.origin.y", Intro.crt, t0: t0, map: { (1 - $0) * Double(side) / 2 })
      mat.add(crt, forKey: "crt.h"); mat.add(shift, forKey: "crt.y")
    }
    let lids = sprite(Sprite.lids(.orange))
    lids.opacity = 0
    if intro { lids.add(Self.animation("opacity", Intro.firstBlink, t0: t0), forKey: "first") }
    if !still { lids.add(Self.animation("opacity", Self.later(Intro.blink, intro ? Intro.windowOpens : 0), t0: t0, fills: false), forKey: "blink") }
    mat.addSublayer(lids)
    tap.addSublayer(mat)

    if intro {
      // The signal pixel, then the scan line, 90 down his box.
      let sig = CALayer()
      sig.frame = CGRect(x: 0, y: Self.y(Intro.scanLineTop, Intro.scanLineHeight, in: Double(side)), width: side, height: CGFloat(Intro.scanLineHeight))
      sig.opacity = 0
      sig.add(Self.animation("opacity", Intro.signal, t0: t0), forKey: "sigon")
      let bar = CALayer()
      bar.frame = sig.bounds
      bar.backgroundColor = RGB(hex: "#63F5F2").cg
      bar.add(Self.animation("transform.scale.x", Intro.scanLine, t0: t0), forKey: "line")
      sig.addSublayer(bar)
      tap.addSublayer(sig)

      // The laptop: pulled up, typed on (the lid jitters), put away when the window opens.
      let lap = Sprite.laptop(), lc = CGFloat(Intro.laptopCell)
      let holder = CALayer()
      holder.frame = CGRect(x: Intro.laptopOrigin.x, y: Self.y(Intro.laptopOrigin.y, Double(lap.height) * Double(lc), in: Double(side)),
                            width: CGFloat(lap.width) * lc, height: CGFloat(lap.height) * lc)
      holder.opacity = 0
      holder.add(Self.animation("transform.translation.y", Intro.laptopPullY, t0: t0, map: { -$0 }), forKey: "pull.y")
      holder.add(Self.animation("opacity", Intro.laptopPullOpacity, t0: t0), forKey: "pull.o")
      // Forwards only: before 3.7 s the pull is what shows (in CSS the away animation doesn't exist until then).
      holder.add(Self.animation("transform.translation.y", Intro.laptopAwayY, t0: t0, forwardsOnly: true, map: { -$0 }), forKey: "away.y")
      holder.add(Self.animation("opacity", Intro.laptopAwayOpacity, t0: t0, forwardsOnly: true), forKey: "away.o")
      let lid = CALayer()
      lid.frame = holder.bounds
      lid.contents = PixelImages.image(lap); lid.magnificationFilter = .nearest
      lid.add(Self.animation("transform.translation.y", Intro.lidJitter, t0: t0, fills: false, map: { -$0 }), forKey: "jitter")
      holder.addSublayer(lid)
      tap.addSublayer(holder)
      laptop = holder
    }
    return lift
  }

  /// The sparks and the heads, from the laptop's lid.
  private func buildPour() -> CALayer {
    let root = CALayer()
    root.frame = layer!.bounds
    let (heads, sparks) = Pour.make()
    let ox = CGFloat(Pour.origin.x), oy = Self.y(Double(Pour.origin.y), 0)
    for s in sparks {
      let l = CALayer()
      l.frame = CGRect(x: ox + CGFloat(s.x), y: oy - 6, width: 6, height: 6)
      l.backgroundColor = RGB(hex: "#63F5F2").cg
      l.opacity = 0
      l.add(Self.animation("transform.translation.y", s.rise, t0: t0, map: { -$0 }), forKey: "rise")
      l.add(Self.animation("opacity", s.opacity, t0: t0), forKey: "fade")
      root.addSublayer(l)
    }
    for h in heads {
      let grid = Sprite.head(h.colorway), c = CGFloat(h.cell)
      // .mh (x), .mhy (y, opacity), .mhr (turning about the head's centre), as the prototype nests them.
      let mx = CALayer(); mx.frame = CGRect(x: ox, y: oy, width: 0, height: 0)
      mx.add(Self.animation("transform.translation.x", h.x, t0: t0), forKey: "x")
      let my = CALayer(); my.frame = mx.bounds
      my.opacity = 0
      my.add(Self.animation("transform.translation.y", h.y, t0: t0, map: { -$0 }), forKey: "y")
      my.add(Self.animation("opacity", h.opacity, t0: t0), forKey: "o")
      let mr = CALayer()
      mr.bounds = CGRect(x: 0, y: 0, width: CGFloat(grid.width) * c, height: CGFloat(grid.height) * c)
      mr.position = .zero
      mr.contents = PixelImages.image(grid); mr.magnificationFilter = .nearest
      mr.add(Self.animation("transform.rotation.z", h.spin, t0: t0, map: { -$0 * .pi / 180 }), forKey: "r")
      my.addSublayer(mr); mx.addSublayer(my); root.addSublayer(mx)
    }
    return root
  }

  // MARK: Keyframes → Core Animation

  /// A loop that starts `at` seconds in (the bob, the blink once the window is open).
  static func later(_ t: Timed, _ at: Double) -> Timed { var t = t; t.delay += at; return t }

  /// `t` as a CAKeyframeAnimation on `keyPath`, started `t.delay` after `t0`. Steps curves become discrete keys.
  static func animation(_ keyPath: String, _ t: Timed, t0: CFTimeInterval, fills: Bool? = nil, forwardsOnly: Bool = false, map: (Double) -> Double = { $0 }) -> CAKeyframeAnimation {
    let a = CAKeyframeAnimation(keyPath: keyPath)
    let tr = t.track
    if tr.curves.contains(where: { if case .steps = $0 { return true }; return false }) {
      var times: [Double] = [], values: [Double] = []
      for i in 0..<(tr.times.count - 1) {
        let n: Int = { if case .steps(let n) = tr.curves[i] { return n }; return 1 }()
        for k in 0..<n {
          times.append(tr.times[i] + (tr.times[i + 1] - tr.times[i]) * Double(k) / Double(n))
          values.append(tr.values[i] + (tr.values[i + 1] - tr.values[i]) * Double(k) / Double(n))
        }
      }
      times.append(1)
      a.calculationMode = .discrete
      a.keyTimes = times.map { NSNumber(value: $0) }
      a.values = values.map { NSNumber(value: map($0)) }
    } else {
      a.keyTimes = tr.times.map { NSNumber(value: $0) }
      a.values = tr.values.map { NSNumber(value: map($0)) }
      a.timingFunctions = tr.curves.map(\.ca)
    }
    a.duration = t.duration
    a.beginTime = t0 + t.delay
    a.repeatCount = t.repeats.isInfinite ? .infinity : Float(t.repeats)
    a.fillMode = forwardsOnly ? .forwards : (fills ?? t.fills) ? .both : .removed
    a.isRemovedOnCompletion = false
    return a
  }
}

extension Curve {
  var ca: CAMediaTimingFunction {
    switch self {
    case .bezier(let a, let b, let c, let d): return CAMediaTimingFunction(controlPoints: Float(a), Float(b), Float(c), Float(d))
    case .linear, .steps: return CAMediaTimingFunction(name: .linear)
    }
  }
}

extension RGB {
  var cg: CGColor { CGColor(srgbRed: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1) }
  var color: Color { Color(.sRGB, red: Double(r) / 255, green: Double(g) / 255, blue: Double(b) / 255) }
}

/// The canvas in the SwiftUI tree, driven by the model's welcome state.
struct IntroCanvas: NSViewRepresentable {
  let model: OnboardingModel
  func makeNSView(context: Context) -> IntroCanvasView {
    let v = IntroCanvasView(frame: CGRect(origin: .zero, size: IntroCanvasView.size))
    model.canvas = v
    return v
  }
  func updateNSView(_ v: IntroCanvasView, context: Context) {}
}

/// Counts the frames the display delivers while the intro plays (a display link on the window's screen), for the
/// debug report: frames, the frame rate and the longest gap.
@MainActor final class FrameCounter: NSObject {
  private var link: CADisplayLink?
  private var times: [CFTimeInterval] = []
  private var until: CFTimeInterval = 0
  private var done: ((String) -> Void)?

  func start(on view: NSView, for seconds: Double, _ report: @escaping (String) -> Void) {
    times = []; until = CACurrentMediaTime() + seconds; done = report
    let l = view.displayLink(target: self, selector: #selector(tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
  }
  @objc private func tick(_ l: CADisplayLink) {
    times.append(l.timestamp)
    if CACurrentMediaTime() >= until { finish() }
  }
  private func finish() {
    link?.invalidate(); link = nil
    guard times.count > 2, let first = times.first, let last = times.last else { done?("frames 0"); return }
    let gaps = zip(times.dropFirst(), times).map { $0 - $1 }
    let fps = Double(times.count - 1) / (last - first)
    let longest = gaps.max() ?? 0
    let over = gaps.filter { $0 > 1.5 / 60 }.count
    done?(String(format: "frames %d seconds %.2f fps %.1f longest %.1fms over25ms %d", times.count, last - first, fps, longest * 1000, over))
    done = nil
  }
}
#endif
