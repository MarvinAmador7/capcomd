#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// The Settings window's measurements and colours (design/desktop/settings: the boards' CSS, `.st-*` and the desk's
/// `.sb`, `.row`, `.pane` in affect-tokens.css). Dark only, as the desk.
package enum ST {
  static func hex(_ v: UInt32, _ a: Double = 1) -> Color {
    Color(.sRGB, red: Double((v >> 16) & 0xFF) / 255, green: Double((v >> 8) & 0xFF) / 255, blue: Double(v & 0xFF) / 255, opacity: a)
  }
  // The window (.win 880 × 660; taller by dragging), its ground and the pane inset 8 from the right, top and bottom.
  package static let width: CGFloat = 880, height: CGFloat = 660
  static let page = hex(0x0C0C0D), panel = hex(0x121213), panelStroke = Color.white.opacity(0.10), panelRadius: CGFloat = 10
  static let paneInset: CGFloat = 8
  // Text (--t1 … --t4).
  static let t1 = Color.white.opacity(0.9), t2 = Color.white.opacity(0.62), t3 = Color.white.opacity(0.46), t4 = Color.white.opacity(0.3)
  static let accent = hex(0x0A84FF), link = hex(0x4EA1FF)
  // The sidebar (.sb 248, 0 8 6 inside; .sbh 52 tall with the traffic lights).
  package static let sidebar: CGFloat = 248
  static let sidebarPadding: CGFloat = 8, sidebarHeader: CGFloat = 52
  static let search: CGFloat = 28, searchRadius: CGFloat = 7, searchFill = Color.white.opacity(0.06), searchStroke = Color.white.opacity(0.08)
  static let searchBottom: CGFloat = 10
  static let who: CGFloat = 44, whoMark: CGFloat = 28, whoGap: CGFloat = 10
  static let groupGap: CGFloat = 10
  static let row: CGFloat = 28, rowRadius: CGFloat = 7, rowGap: CGFloat = 8, rowSelected = Color.white.opacity(0.08), rowHover = Color.white.opacity(0.04)
  static let rowFont = Font.system(size: 13)
  static let whoName = Font.system(size: 13, weight: .medium), whoStatus = Font.system(size: 11.5)
  static let resultPage = Font.system(size: 11.5)
  static let count = hex(0xFFB020), countText = hex(0x1D1D1F), countFont = Font.system(size: 10, weight: .semibold).monospacedDigit()
  // Section icons (.st-ic): a 22 pt squircle, 6 pt corners, a 14 × 14 glyph at 1 pt per cell.
  package static let icon: CGFloat = 22, iconRadius: CGFloat = 6
  // The toolbar (.st-tb 44 tall, 12 in, 12 between): Back and Forward in a 28 pt capsule, 30 pt each; the title 15/600.
  static let toolbar: CGFloat = 44, toolbarPadding: CGFloat = 12
  static let navHeight: CGFloat = 28, navButton: CGFloat = 30, navFill = Color.white.opacity(0.06), navStroke = Color.white.opacity(0.10)
  static let title = Font.system(size: 15, weight: .semibold)
  // The page (.st-bd: 6 20 24 inside, 20 between groups; .st-sec: 6 under its heading).
  static let bodyTop: CGFloat = 6, bodySide: CGFloat = 20, bodyBottom: CGFloat = 24, sectionGap: CGFloat = 20, headingGap: CGFloat = 6
  static let heading = Font.system(size: 13, weight: .semibold)
  // Cards and rows (.st-card 10 pt corners; .st-r ≥ 40 tall, 7 12 inside, 12 between, hairlines 12 in).
  static let cardRadius: CGFloat = 10, cardFill = Color.white.opacity(0.05), cardStroke = Color.white.opacity(0.09)
  static let rowMin: CGFloat = 40, rowPadV: CGFloat = 7, rowPadH: CGFloat = 12, valueGap: CGFloat = 12, hair = Color.white.opacity(0.08)
  static let shortcutRow: CGFloat = 32
  static let label = Font.system(size: 13), sub = Font.system(size: 11), value = Font.system(size: 13)
  static let mono = Font.system(size: 11, design: .monospaced)
  // Footnotes (.st-fn 11/15, an ⓘ before).
  static let foot = Font.system(size: 11), footMono = Font.system(size: 10.5, design: .monospaced)
  // Status dots (.st-dot 8 pt): green, orange, red, the empty ring.
  static let dot: CGFloat = 8, ok = hex(0x30D158), warn = hex(0xFF9F0A), bad = hex(0xFF453A), ring = hex(0x8E8E93)
  // The Default badge (.st-def).
  static let badgeFont = Font.system(size: 11, weight: .medium), badgeText = hex(0x4EA1FF), badgeFill = hex(0x0A84FF, 0.16)
  // App Icon (.st-ai): tiles 84 × 58 on a blue wallpaper, 10 pt corners, ringed 2 pt out by a 2 pt accent ring.
  package static let appIconTile: CGFloat = 44
  static let tileWidth: CGFloat = 84, tileHeight: CGFloat = 58, tileRadius: CGFloat = 10, tileGap: CGFloat = 8, tileLabelGap: CGFloat = 6
  static let tileLabel = Font.system(size: 12), tileLabelOn = Font.system(size: 12, weight: .semibold), groupLabel = Font.system(size: 12)
  static let wallpaper = LinearGradient(stops: [.init(color: hex(0x1F56AD), location: 0), .init(color: hex(0x10306B), location: 0.55),
                                                 .init(color: hex(0x1B4A98), location: 1)], startPoint: .topLeading, endPoint: .bottomTrailing)
  // Layout tiles (.st-th 124 × 78, 8 pt corners, a 3 pt accent ring when chosen).
  static let layoutWidth: CGFloat = 124, layoutHeight: CGFloat = 78
  // The status page's hero (.st-hero, .st-hmk 56; the name 17/600).
  static let hero: CGFloat = 56, heroName = Font.system(size: 17, weight: .semibold), heroStatus = Font.system(size: 12)
  static let poll: Double = 5
}

// MARK: page parts

/// A page: its groups 20 apart, 6 20 24 inside, scrolling when taller than the window.
struct SPage<Content: View>: View {
  @ViewBuilder let content: Content
  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: ST.sectionGap) { content }
        .padding(.top, ST.bodyTop).padding(.horizontal, ST.bodySide).padding(.bottom, ST.bodyBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
    .scrollIndicators(.automatic)
  }
}

/// A group: its bold heading (optional), the card, its footnotes.
struct SGroup<Heading: View, Content: View, Foot: View>: View {
  let id: String
  @ViewBuilder let heading: Heading
  @ViewBuilder let content: Content
  @ViewBuilder let foot: Foot
  var body: some View {
    VStack(alignment: .leading, spacing: ST.headingGap) {
      heading.font(ST.heading).foregroundStyle(ST.t1).padding(.horizontal, 2)
      SCard(id: id) { content }
      foot
    }
  }
}
extension SGroup where Heading == EmptyView {
  init(id: String, @ViewBuilder content: () -> Content, @ViewBuilder foot: () -> Foot) { self.id = id; heading = EmptyView(); self.content = content(); self.foot = foot() }
}
extension SGroup where Foot == EmptyView {
  init(id: String, @ViewBuilder heading: () -> Heading, @ViewBuilder content: () -> Content) { self.id = id; self.heading = heading(); self.content = content(); foot = EmptyView() }
}
extension SGroup where Heading == Text, Foot == EmptyView {
  init(_ title: String, id: String, @ViewBuilder content: () -> Content) { self.id = id; heading = Text(verbatim: title); self.content = content(); foot = EmptyView() }
}
extension SGroup where Heading == Text {
  init(_ title: String, id: String, @ViewBuilder content: () -> Content, @ViewBuilder foot: () -> Foot) { self.id = id; heading = Text(verbatim: title); self.content = content(); self.foot = foot() }
}

/// A card (.st-card): rows on a faint fill with a hairline edge, ringed for a second when a search result opens it.
struct SCard<Content: View>: View {
  @Environment(SettingsModel.self) private var model
  let id: String
  @ViewBuilder let content: Content
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ST.cardRadius, style: .continuous)
    VStack(alignment: .leading, spacing: 0) { content }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(shape.fill(ST.cardFill))
      .overlay(shape.strokeBorder(ST.cardStroke, lineWidth: 0.5))
      .overlay(shape.inset(by: -2).stroke(ST.accent.opacity(0.9), lineWidth: 2).opacity(model.ringed == id ? 1 : 0))
      .overlay(shape.inset(by: -4).stroke(ST.accent.opacity(0.2), lineWidth: 4).opacity(model.ringed == id ? 1 : 0))
      .animation(.easeOut(duration: 0.2), value: model.ringed == id)
      .accessibilityElement(children: .contain)
  }
}

/// The hairline between two rows, 12 in from each side.
struct SSep: View {
  var body: some View { Rectangle().fill(ST.hair).frame(height: 0.5).padding(.horizontal, ST.rowPadH) }
}

/// A row (.st-r): the label on the left, its value and controls on the right; at least 40 tall.
struct SRow<Label: View, Value: View>: View {
  var minHeight: CGFloat = ST.rowMin
  @ViewBuilder let label: Label
  @ViewBuilder let value: Value
  var body: some View {
    HStack(spacing: ST.valueGap) {
      label.font(ST.label).foregroundStyle(ST.t1).frame(maxWidth: .infinity, alignment: .leading)
      HStack(spacing: ST.valueGap) { value }.font(ST.value).foregroundStyle(ST.t3).fixedSize(horizontal: true, vertical: false)
    }
    .padding(.vertical, ST.rowPadV).padding(.horizontal, ST.rowPadH)
    .frame(minHeight: minHeight)
    .accessibilityElement(children: .combine)
  }
}
extension SRow where Label == Text {
  init(_ title: String, minHeight: CGFloat = ST.rowMin, @ViewBuilder value: () -> Value) { self.minHeight = minHeight; label = Text(verbatim: title); self.value = value() }
}

/// A label with its quiet second line (.st-l small): "Local" over "Docker".
struct SLabel: View {
  let title: String
  var sub: String?
  var body: some View {
    VStack(alignment: .leading, spacing: 1) {
      Text(verbatim: title).font(ST.label).foregroundStyle(ST.t1)
      if let sub { Text(verbatim: sub).font(ST.sub).foregroundStyle(ST.t3).lineLimit(1).truncationMode(.tail) }
    }
  }
}

/// A switch in the accent blue.
struct SSwitch: View {
  let title: String
  @Binding var isOn: Bool
  var body: some View {
    Toggle(title, isOn: $isOn).labelsHidden().toggleStyle(SwitchLook()).accessibilityLabel(title)
  }
}

/// The board's switch (.st-sw): 38 × 22, accent blue when on (also while the window isn't key, and whatever the
/// system's accent colour), a white 18 pt knob. A click or Space flips it; VoiceOver reads it as a switch.
struct SwitchLook: ToggleStyle {
  @Environment(\.isEnabled) private var enabled
  func makeBody(configuration: Configuration) -> some View {
    let on = configuration.isOn
    Capsule()
      .fill(on ? ST.accent : Color.white.opacity(0.18))
      .frame(width: 38, height: 22)
      .overlay(alignment: on ? .trailing : .leading) {
        Circle().fill(.white).frame(width: 18, height: 18).shadow(color: .black.opacity(0.35), radius: 1, y: 1).padding(2)
      }
      .opacity(enabled ? 1 : 0.45)
      .animation(.easeOut(duration: 0.15), value: on)
      .contentShape(Capsule())
      .onTapGesture { if enabled { configuration.isOn.toggle() } }
      .accessibilityElement(children: .ignore)
      .accessibilityAddTraits(.isToggle)
      .accessibilityValue(on ? "on" : "off")
      .accessibilityAction { if enabled { configuration.isOn.toggle() } }
  }
}

/// A row with a switch.
struct SToggleRow: View {
  let title: String
  @Binding var isOn: Bool
  var body: some View { SRow(title) { SSwitch(title: title, isOn: $isOn) } }
}

/// A footnote (.st-fn): ⓘ and one line of quiet text.
struct SFoot: View {
  let text: Text
  init(_ text: Text) { self.text = text }
  init(verbatim s: String) { text = Text(verbatim: s) }
  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 6) {
      Image(systemName: "info.circle").font(.system(size: 11)).foregroundStyle(ST.t3).accessibilityHidden(true)
      text.font(ST.foot).foregroundStyle(ST.t3).tint(ST.link).fixedSize(horizontal: false, vertical: true)
    }
    .padding(.horizontal, 2)
    .frame(maxWidth: .infinity, alignment: .leading)
  }
}

/// "Opened: `capcomd auth login claude --sandbox docker`": the command a waiting row handed to Terminal.
struct OpenedFoot: View {
  let command: String
  var body: some View {
    SFoot(Text("Opened: ") + Text(verbatim: command).font(ST.footMono)).textSelection(.enabled)
  }
}

/// A status dot (.st-dot) or the empty ring. The value's text always says the state too.
struct StatusDot: View {
  enum Kind { case ok, warn, bad, empty }
  let kind: Kind
  var side: CGFloat = ST.dot
  var body: some View {
    Group {
      switch kind {
      case .ok: Circle().fill(ST.ok)
      case .warn: Circle().fill(ST.warn)
      case .bad: Circle().fill(ST.bad)
      case .empty: Circle().strokeBorder(ST.ring, lineWidth: 1.2)
      }
    }
    .frame(width: side, height: side)
    .accessibilityHidden(true)
  }
}

/// A row's value: the dot and the text, quiet.
struct StatusValue: View {
  let kind: StatusDot.Kind?
  let text: String
  init(_ kind: StatusDot.Kind?, _ text: String) { self.kind = kind; self.text = text }
  var body: some View {
    HStack(spacing: 6) {
      if let kind { StatusDot(kind: kind) }
      Text(verbatim: text).lineLimit(1).truncationMode(.tail)
    }
    .foregroundStyle(ST.t3)
    .help(text)
  }
}

/// "Waiting for Terminal…" with the small spinner.
struct WaitingValue: View {
  var text = "Waiting for Terminal…"
  var body: some View {
    HStack(spacing: 6) {
      ProgressView().controlSize(.mini).accessibilityHidden(true)
      Text(verbatim: text)
    }
    .foregroundStyle(ST.t3)
  }
}

/// The "Default" badge (.st-def): accent text on an accent tint, a label and not a control.
struct DefaultBadge: View {
  var body: some View {
    Text("Default").font(ST.badgeFont).foregroundStyle(ST.badgeText)
      .padding(.horizontal, 7).padding(.vertical, 2)
      .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(ST.badgeFill))
      .fixedSize()
      .accessibilityAddTraits(.isStaticText)
  }
}

/// A place's symbol by its kind: a laptop for Local, a cloud for Cloud.
struct PlaceMark: View {
  let kind: SandboxDescriptor.Kind?
  var side: CGFloat = 15
  var body: some View {
    Group {
      switch PlaceMarks.kindGlyph(kind) {
      case .path(_, let path): SVGShape(path: path, viewBox: 24).frame(width: side, height: side)
      case .symbol(let s): Image(systemName: s).font(.system(size: side * 0.8)).frame(width: side, height: side)
      }
    }
    .accessibilityHidden(true)
  }
}

/// A provider's mark before its name: Claude's spark in its coral, Codex's glyph.
struct ProviderHeaderMark: View {
  let provider: String
  var body: some View {
    if let p = Provider(wire: provider) {
      ProviderMark(provider: p, size: 14)
        .foregroundStyle(p == .claude ? Theme.Provider.claude : ST.t2)
        .accessibilityHidden(true)
    }
  }
}

extension Tone {
  /// The StatusDot for a tone; `.none` draws no dot.
  var dot: StatusDot.Kind? {
    switch self { case .ok: .ok; case .warn: .warn; case .bad: .bad; case .empty: .empty; case .none: nil }
  }
}

extension View {
  /// The one prominent action of a row (.st-btn.pri): the accent-blue bordered button.
  func prominent() -> some View { buttonStyle(.borderedProminent).tint(ST.accent) }
}

/// The section icon (.st-ic): a 22 pt squircle with a two-stop vertical gradient, a faint 1 pt checker dither, a top
/// highlight, a hairline edge and a soft shadow, holding the 1-bit glyph at 1 pt per cell (crisp at 1× and 2×).
struct SectionIcon: View {
  let glyph: SettingsGlyph
  var side: CGFloat = ST.icon
  var body: some View {
    Canvas { ctx, size in
      let r = CGRect(origin: .zero, size: size)
      let shape = Path(roundedRect: r, cornerRadius: ST.iconRadius * side / ST.icon, style: .continuous)
      ctx.fill(shape, with: .linearGradient(Gradient(colors: [color(glyph.top), color(glyph.bottom)]), startPoint: .zero, endPoint: CGPoint(x: 0, y: size.height)))
      // The dither: 1 pt cells, every other one lit a little (repeating-conic-gradient 2 px).
      ctx.drawLayer { d in
        d.clip(to: shape)
        var p = Path()
        for y in 0..<Int(size.height) { for x in 0..<Int(size.width) where (x + y) % 2 == 1 { p.addRect(CGRect(x: x, y: y, width: 1, height: 1)) } }
        d.fill(p, with: .color(.white.opacity(0.07)))
        // The top highlight and the bottom's darker edge.
        d.fill(Path(CGRect(x: 0, y: 0, width: size.width, height: 0.5)), with: .color(.white.opacity(0.42)))
        d.fill(Path(CGRect(x: 0, y: size.height - 0.5, width: size.width, height: 0.5)), with: .color(.black.opacity(0.18)))
      }
      // The hairline edge, inside the squircle.
      ctx.stroke(Path(roundedRect: r.insetBy(dx: 0.25, dy: 0.25), cornerRadius: ST.iconRadius * side / ST.icon - 0.25, style: .continuous), with: .color(.black.opacity(0.22)), lineWidth: 0.5)
      // The glyph, centred, each layer in its colour; a 1 pt shadow under the white.
      let cell = side / ST.icon, n = CGFloat(SettingsGlyph.side)
      let ox = ((size.width - n * cell) / 2).rounded(), oy = ((size.height - n * cell) / 2).rounded()
      for (i, layer) in glyph.layers.enumerated() {
        var p = Path()
        for y in 0..<layer.mask.h { for x in 0..<layer.mask.w where layer.mask[x, y] { p.addRect(CGRect(x: ox + CGFloat(x) * cell, y: oy + CGFloat(y) * cell, width: cell, height: cell)) } }
        if i == 0 { ctx.fill(p.offsetBy(dx: 0, dy: cell), with: .color(.black.opacity(0.25))) }
        ctx.fill(p, with: .color(color(layer.color)))
      }
    }
    .frame(width: side, height: side)
    .shadow(color: .black.opacity(0.4), radius: 0.75, x: 0, y: 1)
    .accessibilityHidden(true)
  }
  private func color(_ hex: String) -> Color {
    let v = UInt32(hex.dropFirst(), radix: 16) ?? 0
    return ST.hex(v)
  }
}

extension SettingsPage {
  /// Its sidebar icon (the status row shows the app icon instead).
  var glyph: SettingsGlyph? {
    switch self {
    case .status: nil; case .general: .general; case .notifications: .notifications; case .interface: .interface
    case .shortcuts: .shortcuts; case .runs: .runs; case .accounts: .accounts; case .about: .about
    }
  }
}

/// The app's icon at a size (the Orange look, as the bundle has it), for the status row and the version card.
struct AppIconImage: View {
  var side: CGFloat
  var body: some View {
    Group {
      if let img = AppIconImages.tile(.orange) { Image(nsImage: img).resizable().interpolation(.high) } else { Color.clear }
    }
    .frame(width: side, height: side)
    .accessibilityHidden(true)
  }
}
#endif
