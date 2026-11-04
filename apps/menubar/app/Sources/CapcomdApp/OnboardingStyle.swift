#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CoreText
import CapcomdOnboarding

// The onboarding's house style (design/onboarding/onboarding.dc.html): one display face and one text face, five
// sizes, square corners, flat colours, cards set apart by a tone step, motion that arrives with expo-out. Only the
// onboarding draws with these; the rest of the app keeps stock macOS controls.

/// CapcomdStore has a Step (a run's) and SwiftUI a Link: the onboarding's own, by name.
typealias OnboardStep = CapcomdOnboarding.Step
typealias OnboardLink = CapcomdOnboarding.Link

enum OnboardFonts {
  /// Registers the bundled faces for this process (once, at launch): League Spartan, Figtree, Geist Mono.
  static func register() {
    guard !registered else { return }
    registered = true
    for name in ["LeagueSpartan", "Figtree", "GeistMono"] {
      guard let url = folder?.appendingPathComponent("\(name).ttf") else { continue }
      CTFontManagerRegisterFontsForURL(url as CFURL, .process, nil)
    }
  }
  nonisolated(unsafe) private static var registered = false

  /// Fonts/ in this target's resource bundle: inside the app (Contents/Resources), or next to a `swift run` binary.
  /// Looked for by hand rather than with Bundle.module, which stops the app when it can't find its bundle.
  static var folder: URL? {
    let name = "CapcomdApp_CapcomdApp.bundle"
    let places = [Bundle.main.resourceURL, Bundle.main.bundleURL, Bundle.main.executableURL?.deletingLastPathComponent()].compactMap { $0 }
    for p in places {
      let fonts = p.appendingPathComponent(name).appendingPathComponent("Fonts")
      if FileManager.default.fileExists(atPath: fonts.path) { return fonts }
      // A bundle with a Resources folder of its own (how Xcode lays out a macOS bundle).
      let nested = p.appendingPathComponent(name).appendingPathComponent("Contents/Resources/Fonts")
      if FileManager.default.fileExists(atPath: nested.path) { return nested }
    }
    return nil
  }

  /// A variable face at `weight` (its wght axis), or the system font when it isn't there.
  static func font(_ family: String, size: CGFloat, weight: CGFloat) -> NSFont {
    let wght = NSFontDescriptor.AttributeName(rawValue: kCTFontVariationAttribute as String)
    let d = NSFontDescriptor(fontAttributes: [.family: family]).addingAttributes([wght: [0x7767_6874: weight]])
    if let f = NSFont(descriptor: d, size: size), f.familyName == family { return f }
    return .systemFont(ofSize: size, weight: weight >= 650 ? .bold : weight >= 550 ? .semibold : weight >= 450 ? .medium : .regular)
  }
}

/// The five sizes (64 / 32 / 19 / 16 / 13), the display face's tracking and leading, and the mono for the brew command.
enum OnboardType {
  static let display = "League Spartan", text = "Figtree", mono = "Geist Mono"
  /// League Spartan 700, tracking -0.04 em (the 32 pt titles take 60 % of it, as the prototype's .disp2).
  static func display(_ size: CGFloat) -> Font { Font(OnboardFonts.font(display, size: size, weight: 700)) }
  static func tracking(_ size: CGFloat) -> CGFloat { size == 64 ? -0.04 * size : -0.024 * size }
  static func text(_ size: CGFloat, _ weight: CGFloat = 400) -> Font { Font(OnboardFonts.font(text, size: size, weight: weight)) }
  static let code = Font(OnboardFonts.font(mono, size: 13, weight: 500))
}

/// The prototype's colours.
enum OnboardColor {
  static func hex(_ v: UInt32, _ a: Double = 1) -> Color {
    Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: a)
  }
  static let ground = hex(0x07070B)
  static let text = hex(0xF2F2F7), soft = hex(0xE4E4EA), quiet = hex(0xC4C4CC), secondary = hex(0xA1A1AA), muted = hex(0x8B8B95)
  static let placeholder = hex(0x7D7D88)
  static let orange = hex(0xFF8A1F), orangeHover = hex(0xFFA04A), orangeText = hex(0x140A00), amber = hex(0xFFB15C), peach = hex(0xFFD3A0)
  static let disabledFill = hex(0x2A1C10), disabledText = hex(0x8F6E4E)
  static let purple = hex(0x7C4DDB), lilac = hex(0xB795FF), lavender = hex(0xC9B0FF)
  static let cyan = hex(0x63F5F2), green = hex(0x30D158), greenText = hex(0x5BE07C)
  static let warn = hex(0xFFB020), warnText = hex(0xFFC75A), red = hex(0xFF6B5E)
  static let node = hex(0x34343F), dot = hex(0x2A2A35), panel = hex(0x121219), lineOff = hex(0x34343F)
  /// Cards and fields: a tone step over the ground, a little more on hover.
  static let card = Color.white.opacity(0.045), cardHover = Color.white.opacity(0.075)
  static let picked = hex(0xFF8A1F, 0.13)
}

/// Expo out for arrivals, in-out for travel.
enum OnboardMotion {
  static func expo(_ d: Double) -> Animation { .timingCurve(0.16, 1, 0.3, 1, duration: d) }
  static func out(_ d: Double) -> Animation { .timingCurve(0.22, 1, 0.36, 1, duration: d) }
  static func inOut(_ d: Double) -> Animation { .timingCurve(0.76, 0, 0.24, 1, duration: d) }
}

// MARK: Buttons

/// The orange button: dark text, square, a press scale. Get started, Continue and Launch crew are the default action.
struct OnboardPrimaryStyle: ButtonStyle {
  var height: CGFloat = 44, padding: CGFloat = 22
  func makeBody(configuration: Configuration) -> some View { Look(configuration: configuration, height: height, padding: padding) }
  private struct Look: View {
    let configuration: Configuration
    let height: CGFloat, padding: CGFloat
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hover = false
    var body: some View {
      configuration.label
        .font(OnboardType.text(16, 600))
        .foregroundStyle(enabled ? OnboardColor.orangeText : OnboardColor.disabledText)
        .padding(.horizontal, padding).frame(height: height)
        .background(enabled ? (hover ? OnboardColor.orangeHover : OnboardColor.orange) : OnboardColor.disabledFill)
        .contentShape(Rectangle())
        .scaleEffect(configuration.isPressed && enabled && !reduceMotion ? 0.97 : 1)
        .animation(reduceMotion ? nil : OnboardMotion.out(0.14), value: configuration.isPressed)
        .animation(.easeOut(duration: 0.18), value: hover)
        .onHover { hover = $0 }
    }
  }
}

/// The quiet button (Back, Copy, Check again, Sign in): a white tone step.
struct OnboardGhostStyle: ButtonStyle {
  var height: CGFloat = 44, padding: CGFloat = 22, size: CGFloat = 16
  func makeBody(configuration: Configuration) -> some View { Look(configuration: configuration, height: height, padding: padding, size: size) }
  private struct Look: View {
    let configuration: Configuration
    let height: CGFloat, padding: CGFloat, size: CGFloat
    @Environment(\.isEnabled) private var enabled
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var hover = false
    var body: some View {
      configuration.label
        .font(OnboardType.text(size, 600)).foregroundStyle(OnboardColor.soft)
        .padding(.horizontal, padding).frame(height: height)
        .background(Color.white.opacity(hover && enabled ? 0.13 : 0.08))
        .contentShape(Rectangle())
        .opacity(enabled ? 1 : 0.4)
        .scaleEffect(configuration.isPressed && enabled && !reduceMotion ? 0.97 : 1)
        .animation(reduceMotion ? nil : OnboardMotion.out(0.14), value: configuration.isPressed)
        .onHover { hover = $0 }
    }
  }
}

/// A text button (Skip for now, Give the crew a goal).
struct OnboardLinkStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View { Look(configuration: configuration) }
  private struct Look: View {
    let configuration: Configuration
    @State private var hover = false
    var body: some View {
      configuration.label.font(OnboardType.text(16, 500)).foregroundStyle(hover ? OnboardColor.text : OnboardColor.quiet)
        .padding(8).contentShape(Rectangle())
        .animation(.easeOut(duration: 0.18), value: hover).onHover { hover = $0 }
    }
  }
}

/// A suggestion under the goal.
struct OnboardChipStyle: ButtonStyle {
  func makeBody(configuration: Configuration) -> some View { Look(configuration: configuration) }
  private struct Look: View {
    let configuration: Configuration
    @State private var hover = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    var body: some View {
      configuration.label.font(OnboardType.text(16, 500)).foregroundStyle(hover ? OnboardColor.peach : OnboardColor.soft)
        .padding(.horizontal, 14).frame(height: 36)
        .background(hover ? OnboardColor.hex(0xFF8A1F, 0.18) : Color.white.opacity(0.07))
        .contentShape(Rectangle())
        .scaleEffect(configuration.isPressed && !reduceMotion ? 0.97 : 1)
        .animation(.easeOut(duration: 0.18), value: hover).onHover { hover = $0 }
    }
  }
}

/// A card you pick (where they work, a project): a tone step, an orange inset ring when picked.
struct OnboardOptionStyle: ButtonStyle {
  let picked: Bool
  func makeBody(configuration: Configuration) -> some View { Look(configuration: configuration, picked: picked) }
  private struct Look: View {
    let configuration: Configuration
    let picked: Bool
    @State private var hover = false
    var body: some View {
      configuration.label
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(picked ? OnboardColor.picked : hover ? OnboardColor.cardHover : OnboardColor.card)
        .overlay { if picked { Rectangle().strokeBorder(OnboardColor.orange, lineWidth: 2) } }
        .contentShape(Rectangle())
        .animation(.easeOut(duration: 0.18), value: hover).animation(.easeOut(duration: 0.18), value: picked)
        .onHover { hover = $0 }
    }
  }
}

/// The focus ring every onboarding control shows from the keyboard: 2 pt cyan, 2 pt out, square.
struct OnboardFocusRing: ViewModifier {
  @FocusState private var focused: Bool
  func body(content: Content) -> some View {
    content.focused($focused).focusEffectDisabled()
      .overlay { if focused { Rectangle().strokeBorder(OnboardColor.cyan, lineWidth: 2).padding(-4) } }
  }
}
extension View { func onboardFocusRing() -> some View { modifier(OnboardFocusRing()) } }

/// The square switch: "Start capcomd when I log in".
struct OnboardSwitch: View {
  let label: String
  @Binding var on: Bool
  @Environment(\.isEnabled) private var enabled
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    Button { on.toggle() } label: {
      HStack(spacing: 12) {
        ZStack(alignment: .leading) {
          Rectangle().fill(on ? OnboardColor.orange : OnboardColor.node).frame(width: 40, height: 22)
          Rectangle().fill(OnboardColor.text).frame(width: 16, height: 16).offset(x: on ? 21 : 3)
        }
        .animation(reduceMotion ? nil : OnboardMotion.out(0.24), value: on)
        Text(verbatim: label).font(OnboardType.text(16)).foregroundStyle(OnboardColor.soft)
      }
      .contentShape(Rectangle()).opacity(enabled ? 1 : 0.6)
    }
    .buttonStyle(.plain)
    .onboardFocusRing()
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(label)
    .accessibilityValue(on ? "On" : "Off")
    .accessibilityAddTraits(.isToggle)
  }
}

// MARK: Entrances

/// `.enter` / `.stag` children: up 22 and in over 0.8 s (0.7 for staggered rows), expo out, after `delay`.
struct Rise: ViewModifier {
  let delay: Double
  var duration = 0.8
  var distance: CGFloat = 22
  @State private var shown = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    content.opacity(shown || reduceMotion ? 1 : 0).offset(y: shown || reduceMotion ? 0 : distance)
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(OnboardMotion.expo(duration).delay(delay)) { shown = true }
      }
  }
}

/// A title rising out of a mask (`.enter > h2`, `.w-head`): revealed from its top down while it moves up 28.
struct MaskRise: ViewModifier {
  let delay: Double
  var duration = 0.8
  @State private var progress: CGFloat = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    let p = reduceMotion ? 1 : progress
    content
      .mask(alignment: .top) { GeometryReader { g in Rectangle().frame(height: g.size.height * p) } }
      .offset(y: 28 * (1 - p))
      .onAppear {
        guard !reduceMotion else { return }
        withAnimation(OnboardMotion.expo(duration).delay(delay)) { progress = 1 }
      }
  }
}

/// `.drop`: down 32 and in over 0.9 s, expo out.
struct Drop: ViewModifier {
  @State private var shown = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  func body(content: Content) -> some View {
    content.opacity(shown || reduceMotion ? 1 : 0).offset(y: shown || reduceMotion ? 0 : -32)
      .onAppear { if !reduceMotion { withAnimation(OnboardMotion.expo(0.9)) { shown = true } } }
  }
}

extension View {
  func rise(_ delay: Double = 0, duration: Double = 0.8) -> some View { modifier(Rise(delay: delay, duration: duration)) }
  /// The n-th child of an `.enter` group (0.09 s apart).
  func enter(_ n: Int) -> some View { modifier(Rise(delay: 0.09 * Double(n))) }
  /// The n-th child of a `.stag` group (0.24 s, then 0.07 s apart).
  func stagger(_ n: Int) -> some View { modifier(Rise(delay: 0.24 + 0.07 * Double(n), duration: 0.7)) }
  func maskRise(_ delay: Double = 0, duration: Double = 0.8) -> some View { modifier(MaskRise(delay: delay, duration: duration)) }
  func drop() -> some View { modifier(Drop()) }
}

// MARK: Pixels

/// Sprites as images one pixel per cell, drawn without interpolation at whole points per cell.
@MainActor enum PixelImages {
  private static var cache: [PixelGrid: CGImage] = [:]
  static func image(_ g: PixelGrid) -> CGImage {
    if let i = cache[g] { return i }
    var px = [UInt8](repeating: 0, count: g.width * g.height * 4)
    for c in g.cells where c.x >= 0 && c.x < g.width && c.y >= 0 && c.y < g.height {
      let o = (c.y * g.width + c.x) * 4
      px[o] = c.color.r; px[o + 1] = c.color.g; px[o + 2] = c.color.b; px[o + 3] = 255
    }
    let space = CGColorSpace(name: CGColorSpace.sRGB)!
    let provider = CGDataProvider(data: Data(px) as CFData)!
    let img = CGImage(width: g.width, height: g.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: g.width * 4, space: space,
                      bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
                      shouldInterpolate: false, intent: .defaultIntent)!
    cache[g] = img
    return img
  }
}

/// A sprite at `cell` points per cell, as rect fills (no image scaling, so nothing can smooth it).
struct PixelSprite: View {
  let grid: PixelGrid
  let cell: CGFloat
  var body: some View {
    Canvas { ctx, _ in
      for c in grid.cells {
        ctx.fill(Path(CGRect(x: CGFloat(c.x) * cell, y: CGFloat(c.y) * cell, width: cell, height: cell)), with: .color(c.color.color))
      }
    }
    .frame(width: CGFloat(grid.width) * cell, height: CGFloat(grid.height) * cell)
  }
}

/// The bot as the screens show him: bobbing, blinking now and then (none when happy), from `bobDelay` into his loop.
struct OnboardBot: View {
  let colorway: Sprite.Colorway
  let mood: Sprite.Mood
  let cell: CGFloat
  var bobDelay: Double = 0
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    TimelineView(.animation(paused: reduceMotion)) { tl in
      let t = tl.date.timeIntervalSinceReferenceDate - bobDelay
      ZStack {
        PixelSprite(grid: Sprite.body(colorway, mood), cell: cell)
        if mood == .smile && !reduceMotion { PixelSprite(grid: Sprite.lids(colorway, mood), cell: cell).opacity(Intro.blink.value(at: t, base: 0)) }
      }
      .offset(y: reduceMotion ? 0 : (Intro.bob.value(at: t, base: 0)).rounded())
    }
    .frame(width: 16 * cell, height: 16 * cell)
  }
}

/// An SVG path from the prototype at `size`, filled or stroked.
struct OnboardGlyph: View {
  let path: Path
  var size: CGFloat
  var color: Color
  var stroke: CGFloat? = nil
  var body: some View {
    Group {
      if let stroke {
        SVGShape(path: path, viewBox: 24).stroke(color, style: StrokeStyle(lineWidth: stroke * size / 24, lineCap: .round, lineJoin: .round))
      } else {
        SVGShape(path: path, viewBox: 24).fill(color)
      }
    }
    .frame(width: size, height: size)
  }
}

enum OnboardGlyphs {
  static let cloud = SVGPath.parse("M7 18h10a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.1 9.5 4.25 4.25 0 0 0 7 18z")
  static let folder = SVGPath.parse("M3 7.5A1.5 1.5 0 0 1 4.5 6h4.4l2 2.2h8.6A1.5 1.5 0 0 1 21 9.7v8.8a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z")
}
#endif
