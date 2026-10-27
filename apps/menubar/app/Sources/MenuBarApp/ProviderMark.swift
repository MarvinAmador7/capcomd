#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// Which AI an agent runs on, as the provider's own mark (owner's decision, 2026-10-27): one colour, never altered,
/// only to say what the agent runs on. Claude's spark is simple-icons' path (CC0; the mark is Anthropic's trademark).
/// The OpenAI mark for Codex waits for the official file from openai.com/brand; until then Codex shows a neutral glyph.
enum ProviderMarks {
  /// simple-icons "claude", 24×24 viewBox.
  static let claude = SVGPath.parse("m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z")

  /// The brand colour for the badge (Claude's coral); OpenAI's mark is black or white only.
  static func badgeTint(_ p: Provider) -> Color { p == .claude ? Theme.Provider.claude : .white }
}

/// The mark at `size` points, in the current foreground style.
struct ProviderMark: View {
  let provider: Provider
  var size: CGFloat = 12
  var body: some View {
    Group {
      switch provider {
      case .claude: SVGShape(path: ProviderMarks.claude, viewBox: 24).frame(width: size, height: size)
      case .codex: Image(systemName: "circle.hexagongrid.fill").font(.system(size: size * 0.85)).frame(width: size, height: size)   // placeholder
      }
    }
    .accessibilityLabel(provider.displayName)
  }
}

/// A bot with its provider's mark on its bottom-right corner (owner's explicit exception to "nothing on the bots"):
/// a disc in the surface colour, the mark in its brand colour. Small and full sizes only; xs rows carry the mark in
/// their trailing column instead.
struct ProvidedBot: View {
  let traits: BotTraits?
  let size: BotSize
  var cell: CGFloat = 1
  let provider: Provider?
  var body: some View {
    let side = CGFloat(BotAvatar.cells(size)) * cell, disc = Theme.Provider.badge(side)
    BotAvatar(traits: traits, size: size, cell: cell)
      .overlay(alignment: .bottomTrailing) {
        if let provider, disc > 0 {
          ProviderMark(provider: provider, size: disc * Theme.Provider.markRatio)
            .foregroundStyle(ProviderMarks.badgeTint(provider))
            .frame(width: disc, height: disc)
            .background(Circle().fill(Theme.Provider.badgeFill))
            .overlay(Circle().strokeBorder(Theme.Provider.badgeStroke, lineWidth: 0.5))
            .offset(x: disc * Theme.Provider.badgeOut, y: disc * Theme.Provider.badgeOut)
            .accessibilityHidden(true)
        }
      }
  }
}

struct SVGShape: Shape {
  let path: Path
  let viewBox: CGFloat
  func path(in rect: CGRect) -> Path {
    let s = min(rect.width, rect.height) / viewBox
    return path.applying(CGAffineTransform(a: s, b: 0, c: 0, d: s, tx: rect.minX + (rect.width - viewBox * s) / 2, ty: rect.minY + (rect.height - viewBox * s) / 2))
  }
}

/// SVG path data (M L H V C S Q T Z, absolute and relative) to a Path. No arcs: the marks we draw don't use them.
enum SVGPath {
  static func parse(_ d: String) -> Path {
    var p = Path(), i = d.startIndex, cmd: Character = "M"
    var cur = CGPoint.zero, start = CGPoint.zero, lastCtrl: CGPoint? = nil, lastQuad: CGPoint? = nil
    func skip() { while i < d.endIndex, d[i] == " " || d[i] == "," || d[i] == "\n" || d[i] == "\t" { i = d.index(after: i) } }
    func number() -> CGFloat? {
      skip()
      var j = i, seenDot = false, seenExp = false
      if j < d.endIndex, d[j] == "-" || d[j] == "+" { j = d.index(after: j) }
      while j < d.endIndex {
        let c = d[j]
        if c.isNumber { j = d.index(after: j) }
        else if c == ".", !seenDot, !seenExp { seenDot = true; j = d.index(after: j) }
        else if c == "e" || c == "E", !seenExp { seenExp = true; j = d.index(after: j); if j < d.endIndex, d[j] == "-" || d[j] == "+" { j = d.index(after: j) } }
        else { break }
      }
      guard j > i, let v = Double(d[i..<j]) else { return nil }
      i = j; return CGFloat(v)
    }
    func pt(_ rel: Bool) -> CGPoint? {
      guard let x = number(), let y = number() else { return nil }
      return rel ? CGPoint(x: cur.x + x, y: cur.y + y) : CGPoint(x: x, y: y)
    }
    while true {
      skip()
      guard i < d.endIndex else { break }
      if d[i].isLetter { cmd = d[i]; i = d.index(after: i) }
      let rel = cmd.isLowercase
      switch cmd.uppercased() {
      case "M":
        guard let q = pt(rel) else { return p }
        p.move(to: q); cur = q; start = q; cmd = rel ? "l" : "L"   // further pairs are line-tos
        lastCtrl = nil; lastQuad = nil
      case "L":
        guard let q = pt(rel) else { return p }
        p.addLine(to: q); cur = q; lastCtrl = nil; lastQuad = nil
      case "H":
        guard let x = number() else { return p }
        cur = CGPoint(x: rel ? cur.x + x : x, y: cur.y); p.addLine(to: cur); lastCtrl = nil; lastQuad = nil
      case "V":
        guard let y = number() else { return p }
        cur = CGPoint(x: cur.x, y: rel ? cur.y + y : y); p.addLine(to: cur); lastCtrl = nil; lastQuad = nil
      case "C":
        guard let c1 = pt(rel), let c2 = pt(rel), let q = pt(rel) else { return p }
        p.addCurve(to: q, control1: c1, control2: c2); cur = q; lastCtrl = c2; lastQuad = nil
      case "S":
        let c1 = lastCtrl.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
        guard let c2 = pt(rel), let q = pt(rel) else { return p }
        p.addCurve(to: q, control1: c1, control2: c2); cur = q; lastCtrl = c2; lastQuad = nil
      case "Q":
        guard let c = pt(rel), let q = pt(rel) else { return p }
        p.addQuadCurve(to: q, control: c); cur = q; lastQuad = c; lastCtrl = nil
      case "T":
        let c = lastQuad.map { CGPoint(x: 2 * cur.x - $0.x, y: 2 * cur.y - $0.y) } ?? cur
        guard let q = pt(rel) else { return p }
        p.addQuadCurve(to: q, control: c); cur = q; lastQuad = c; lastCtrl = nil
      case "Z":
        p.closeSubpath(); cur = start; lastCtrl = nil; lastQuad = nil
        skip(); if i < d.endIndex, !d[i].isLetter { return p }   // Z takes no numbers
      default:
        return p   // arcs and anything else: not supported
      }
    }
    return p
  }
}
#endif
