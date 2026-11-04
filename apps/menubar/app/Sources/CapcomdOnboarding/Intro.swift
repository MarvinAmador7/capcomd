import Foundation

// The intro (design/onboarding/onboarding.dc.html, the `.intro` rules and introTimers): the CAPCOM comes on the air on
// the desktop itself. A signal pixel, a scan line, the screen opening on him, his face powering on with one flicker and
// one blink; he pulls out a laptop and types, a crew of heads pours out of it, and at 3.7 s the window opens as a circle
// growing from him while heads still fall. Then the lift: he crouches, launches past his place and settles onto it as
// the title rises. Every value here is the prototype's; t = 0 is the intro's first frame, in seconds.

public enum Intro {
  /// The window opens (the backdrop's circle starts growing, the lift starts, the laptop goes).
  public static let windowOpens = 3.7
  /// The laptop, sparks and heads are taken away.
  public static let propsGone = 5.9

  // Signal and scan line (the line is 12 high, 90 down the bot; the pixel is 1/16 of the line, at its centre).
  public static let signal = Timed(Track([(0, 0), (0.05, 1), (0.1, 0.2), (0.15, 1), (0.8, 1), (1, 0)], all: .linear), duration: 1.15)
  public static let scanLine = Timed(Track(from: 0.0625, to: 1, .expo), duration: 0.5, delay: 0.32)
  public static let scanLineTop = 90.0, scanLineHeight = 12.0
  /// The CRT opening: the bot shown from his middle line out (a vertical scale of the reveal, 0…1).
  public static let crt = Timed(Track(from: 0, to: 1, .expo), duration: 0.7, delay: 0.8)
  /// The face's cover (its cells in the screen colour): on, one flicker, off for good.
  public static let faceCover = Timed(Track([(0, 1), (0.78, 1), (0.81, 0), (0.84, 1), (0.87, 0), (1, 0)], all: .ease), duration: 1.6)
  public static let firstBlink = Timed(Track([(0, 0), (0.3, 1), (0.7, 1), (1, 0)], all: .ease), duration: 0.24, delay: 1.6)
  public static let shadowIn = Timed(Track(from: 0, to: 1, .ease), duration: 0.6, delay: 1)

  // The laptop: pulled up from 72 below, then put away when the window opens.
  public static let laptopOrigin = (x: 6.0, y: 118.0)
  public static let laptopCell = 6
  public static let laptopPullY = Timed(Track(from: 72, to: 0, .expo), duration: 0.55, delay: 1.75)
  public static let laptopPullOpacity = Timed(Track(from: 0, to: 1, .expo), duration: 0.55, delay: 1.75)
  public static let laptopAwayCurve = Curve.bezier(0.55, 0.055, 0.675, 0.19)
  public static let laptopAwayY = Timed(Track(from: 0, to: 64, laptopAwayCurve), duration: 0.35, delay: windowOpens)
  public static let laptopAwayOpacity = Timed(Track(from: 1, to: 0, laptopAwayCurve), duration: 0.35, delay: windowOpens)
  /// Typing: the lid jitters 2 down, he taps 3 down (CSS steps(2) on each half; no fill).
  public static let lidJitter = Timed(Track([(0, 0), (0.5, 2), (1, 0)], all: .steps(2)), duration: 0.1, delay: 2.25, repeats: 9, fills: false)
  public static let tap = Timed(Track([(0, 0), (0.5, 3), (1, 0)], all: .steps(2)), duration: 0.12, delay: 2.25, repeats: 8, fills: false)

  // The window.
  /// The backdrop's circle radius (from 0 to 1000, past the window's corners, expo out), from the window's centre.
  public static let backdrop = Timed(Track(from: 0, to: 1000, .expo), duration: 1.1, delay: windowOpens)
  /// The chrome (traces, title bar, comets, step dots) fades in after.
  public static let chrome = Timed(Track(from: 0, to: 1, .ease), duration: 0.8, delay: windowOpens + 0.35)

  /// The lift: from `dy` below his place (the window's centre), a crouch, a launch past his mark with a stretch, a
  /// settle. The bot's own overshoot is the only one in the app. Scaled about his bottom centre.
  public static func lift(dy: Double) -> (y: Timed, scaleX: Timed, scaleY: Timed) {
    let t = [0, 0.13, 0.56, 0.78, 1.0]
    let curves: [Curve] = [.bezier(0.45, 0, 0.55, 1), .bezier(0.12, 0.75, 0.25, 1), .bezier(0.45, 0, 0.55, 1), .bezier(0.45, 0, 0.55, 1)]
    func timed(_ v: [Double]) -> Timed { Timed(Track(Array(zip(t, v)), curves: curves), duration: 1.2, delay: windowOpens) }
    return (timed([dy, dy + 14, -12, 3, 0]), timed([1, 1.05, 0.97, 1.012, 1]), timed([1, 0.94, 1.04, 0.99, 1]))
  }

  /// When the welcome title and lines come in, from the window opening (after an intro) or from the screen appearing.
  public static func welcomeDelays(afterIntro: Bool) -> (title: Double, sub: Double, cta: Double) {
    afterIntro ? (0.5, 0.68, 0.8) : (0.2, 0.34, 0.46)
  }

  // Loops every bot plays once it's on screen.
  /// Up 10 and back, 3.2 s, in-out.
  public static let bob = Timed(Track([(0, 0), (0.5, -10), (1, 0)], all: .inOut), duration: 3.2, repeats: .infinity)
  /// The lids, for a moment every 4.6 s.
  public static let blink = Timed(Track([(0, 0), (0.91, 0), (0.93, 1), (0.97, 1), (1, 0)], all: .ease), duration: 4.6, repeats: .infinity)
  /// The shadow under him breathes with the bob.
  public static let shadowScale = Timed(Track([(0, 1), (0.5, 0.82), (1, 1)], all: .inOut), duration: 3.2, repeats: .infinity)
  public static let shadowOpacity = Timed(Track([(0, 0.5), (0.5, 0.3), (1, 0.5)], all: .inOut), duration: 3.2, repeats: .infinity)
}

/// The welcome screen's layout in the 1200×760 window (the prototype's flex column, worked out): his box is 192 square
/// (12 points a cell) with the shadow 16 under it, the title 40 under that.
public enum WelcomeLayout {
  public static let heroCell = 12
  public static let heroSide = 16.0 * Double(heroCell)
  public static let titleSize = 64.0, titleLeading = 0.92, subSize = 19.0, subLeading = 1.5, ctaHeight = 52.0
  /// Height of the column: bot, shadow (16 + 8), title (40 + one line + 0.08 em), sub (18 + one line), button (36 + 52).
  public static var columnHeight: Double {
    heroSide + 24 + 40 + titleSize * titleLeading + 0.08 * titleSize + 18 + subSize * subLeading + 36 + ctaHeight
  }
  /// The column is centred in the 720 under the title bar, less 40 at its foot.
  public static var heroTop: Double { (40 + (720 - 40 - columnHeight) / 2).rounded() }
  public static var heroLeft: Double { (1200 - heroSide) / 2 }
  /// How far below his place he waits during the intro: his centre on the window's centre (380).
  public static var liftOffset: Double { (380 - (heroTop + heroSide / 2)).rounded() }
}
