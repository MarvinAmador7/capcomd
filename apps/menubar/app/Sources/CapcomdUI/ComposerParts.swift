#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

// The composer's small parts, shared by the menu bar's composer (StartProjectField, ThreadComposer) and the desktop's
// new project column (CapcomdDesk): context chips, the white send, effort bars and keycaps.

/// A context chip: icon or bot, text, an optional ×.
package struct Chip2<Leading: View>: View {
  let leading: Leading
  let text: String
  var mono = false
  var tint: Color? = nil
  /// A dropdown chip: a small chevron after the text.
  var chevron = false
  let onRemove: (() -> Void)?
  /// Shown after the text, before the chevron (the driver chip's effort bars).
  var trailing: AnyView? = nil
  package init(leading: Leading, text: String, mono: Bool = false, tint: Color? = nil, chevron: Bool = false, onRemove: (() -> Void)?, trailing: AnyView? = nil) {
    self.leading = leading; self.text = text; self.mono = mono; self.tint = tint; self.chevron = chevron; self.onRemove = onRemove; self.trailing = trailing
  }
  package var body: some View {
    HStack(spacing: Theme.Composer2.chipInnerGap) {
      leading
      Text(verbatim: text).font(mono ? Theme.Composer2.chipMono : Theme.Composer2.chipFont).lineLimit(1)
      if let trailing { trailing }
      if chevron { Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Composer2.chipX) }
      if let onRemove {
        Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Composer2.chipX) }
          .buttonStyle(.plain).accessibilityLabel("Remove \(text)")
      }
    }
    .foregroundStyle(tint ?? .white)
    .padding(.horizontal, Theme.Composer2.chipPadding).frame(height: Theme.Composer2.chipHeight)
    .background(Capsule().fill(tint.map { $0.opacity(0.16) } ?? Theme.Composer2.chipFill))
    .overlay(Capsule().strokeBorder(tint == nil ? Theme.Composer2.chipStroke : .clear, lineWidth: 0.5))
  }
}
extension Chip2 where Leading == AnyView {
  package init(icon: String, text: String, mono: Bool = false, tint: Color? = nil, onRemove: (() -> Void)?) {
    self.init(leading: AnyView(Image(systemName: icon).font(.system(size: 11))), text: text, mono: mono, tint: tint, chevron: false, onRemove: onRemove)
  }
}

/// The white round send (Composer board); the stop square while the agent works; dim when there's nothing to send.
package struct SendCircle: View {
  let ready: Bool
  let stop: Bool
  let label: String
  var size = Theme.Composer2.send
  let action: () -> Void
  package init(ready: Bool, stop: Bool, label: String, size: CGFloat = Theme.Composer2.send, action: @escaping () -> Void) {
    self.ready = ready; self.stop = stop; self.label = label; self.size = size; self.action = action
  }
  package var body: some View {
    Button(action: action) {
      ZStack {
        // Always a white surface (owner's call); with nothing to send only the arrow dims.
        Circle().fill(Color.white)
        if stop { RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Color.black).frame(width: 9, height: 9) }
        else { Image(systemName: "arrow.up").font(Theme.Composer2.sendIcon).foregroundStyle(Color.black.opacity(ready ? 1 : Theme.Composer2.sendArrowIdle)) }
      }
      .frame(width: size, height: size)
      .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
    }
    .buttonStyle(PressableStyle())
    .disabled(!(ready || stop))
    .accessibilityLabel(label)
  }
}

/// Reasoning effort as signal bars (owner's pick, after the reference's "Deep" control): `cellularbars` filled to the
/// level's place among the driver's levels, so 4 levels fill 1–4 bars and 3 levels 2–4.
package struct EffortBars: View {
  let level: Int
  let of: Int
  package init(level: Int, of: Int) { self.level = level; self.of = of }
  package var body: some View {
    Image(systemName: "cellularbars", variableValue: Self.value(level, of: of))
      .font(Theme.Composer2.effortFont).foregroundStyle(Theme.Composer2.effortText)
      .accessibilityHidden(true)
  }
  /// The bar fill for level `i` of `n` (lowest first), spread over four bars: the top level fills all four; with more
  /// than four levels the top two share four bars (Claude's xhigh and max).
  package static func value(_ i: Int, of n: Int) -> Double { n <= 1 ? 1 : Double(max(1, Int((Double(i + 1) * 4 / Double(n)).rounded(.up)))) / 4 }
  package static func title(_ level: String) -> String {
    switch level { case "xhigh": "Extra high"; case "max": "Max"; default: level.prefix(1).uppercased() + level.dropFirst() }
  }
  /// The stored pick for "let the CLI choose".
  package static let auto = UIPreferences.autoEffort
}

/// A keycap (⌘K, ⌥, Space).
package struct KeyCap: View {
  let text: String
  package init(text: String) { self.text = text }
  package var body: some View {
    Text(verbatim: text).font(Theme.Composer2.keyFont).foregroundStyle(Theme.Composer2.keyText)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.Composer2.keyStroke, lineWidth: 0.5))
  }
}
#endif
