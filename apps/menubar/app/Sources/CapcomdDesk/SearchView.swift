#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// Search ⌘K's content (design/desktop/rex/CommandK.dc.html; the board wins on measurements): the query field, the
// results by group, one quiet key legend. Native on purpose (the owner turned down a web-kit look): no field box, sentence
// case headers, a full-width accent selection, shortcuts as plain glyphs, one icon column, 4/8 pt spacing.

/// The board's measurements.
enum SearchMetrics {
  static let maxWidth: CGFloat = 640, radius: CGFloat = 18, top: CGFloat = 92, gutter: CGFloat = 16
  static let queryHeight: CGFloat = 56, queryPadding: CGFloat = 20, queryGap: CGFloat = 12
  static let header: CGFloat = 28, row: CGFloat = 32, rowRadius: CGFloat = 8, rowPadding: CGFloat = 10, rowGap: CGFloat = 10
  static let icon: CGFloat = 20, listTop: CGFloat = 4, listBottom: CGFloat = 8, listSide: CGFloat = 8
  static let footer: CGFloat = 32, maxList: CGFloat = 480
  static let minHeight = queryHeight + 0.5 + footer
  /// The title keeps up to this share of the row; the subtitle truncates first.
  static let titleShare: CGFloat = 0.68
  static func width(for window: CGFloat) -> CGFloat { min(maxWidth, max(320, window - gutter * 2)) }

  /// The list's height for these results: fixed rows, so it is known without laying them out.
  static func listHeight(_ sections: [SearchSection], query: String) -> CGFloat {
    if sections.isEmpty { return query.allSatisfy(\.isWhitespace) ? 0 : row + listTop + listBottom }
    let h = sections.reduce(listTop + listBottom) { $0 + header + row * CGFloat($1.hits.count) }
    return min(h, maxList)
  }
}

/// The board's colours (CommandK `.pal`), over the system's dark vibrancy.
enum SearchColors {
  /// Over the vibrancy: the board's ground (rgba(44,44,48,.64) over a blurred reel ≈ #1F1F22) comes out at ≈ #262628, so the
  /// secondary text keeps 5.8:1 whatever the reel shows under it (the vibrancy alone measured #484848–#696969 there).
  static let tint = Color(red: 24 / 255, green: 24 / 255, blue: 27 / 255).opacity(0.72)
  static let text = Color.white.opacity(0.92)
  /// rgba(235,235,245,.62): secondary text, ≥ 4.5:1 on the panel.
  static let secondary = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.62)
  static let tertiary = Color(red: 235 / 255, green: 235 / 255, blue: 245 / 255).opacity(0.6)
  static let separator = Color.white.opacity(0.12), footerLine = Color.white.opacity(0.10), ring = Color.white.opacity(0.16)
  static let onSelection = Color.white, onSelectionSecondary = Color.white.opacity(0.88), hint = Color.white.opacity(0.85)

  /// The system accent, darkened only as far as white text (and 88 % white for the subtitle) needs to clear 4.5:1 on it.
  /// The default blue comes out at the board's #0058D0.
  @MainActor static var selection: Color {
    let accent = NSColor.controlAccentColor.usingColorSpace(.sRGB) ?? NSColor(srgbRed: 0.04, green: 0.52, blue: 1, alpha: 1)
    let key = [accent.redComponent, accent.greenComponent, accent.blueComponent]
    if let c = cache, c.key == key { return c.color }
    var (r, g, b) = (Double(key[0]), Double(key[1]), Double(key[2]))
    func lum(_ r: Double, _ g: Double, _ b: Double) -> Double {
      func ch(_ v: Double) -> Double { v <= 0.04045 ? v / 12.92 : pow((v + 0.055) / 1.055, 2.4) }
      return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
    }
    for _ in 0..<40 {
      // The subtitle: 88 % white over the selection.
      let sub = lum(0.88 + 0.12 * r, 0.88 + 0.12 * g, 0.88 + 0.12 * b), bg = lum(r, g, b)
      if (sub + 0.05) / (bg + 0.05) >= 4.5 { break }
      r *= 0.95; g *= 0.95; b *= 0.95
    }
    let color = Color(.sRGB, red: r, green: g, blue: b)
    cache = (key, color)
    return color
  }
  @MainActor private static var cache: (key: [CGFloat], color: Color)?
}

struct SearchView: View {
  @Environment(DeskModel.self) private var model
  let onHeight: (CGFloat) -> Void
  @FocusState private var focused: Bool

  var body: some View {
    DeskProbe.body("SearchView")
    let s = model.search
    let sections = s.sections, query = s.query
    let list = SearchMetrics.listHeight(sections, query: query)
    let height = SearchMetrics.queryHeight + 0.5 + list + SearchMetrics.footer
    return VStack(spacing: 0) {
      SearchField(focused: $focused)
      Rectangle().fill(SearchColors.separator).frame(height: 0.5)
      if !sections.isEmpty {
        SearchList(height: list)
      } else if list > 0 {
        Text("No results").font(.system(size: 13)).foregroundStyle(SearchColors.secondary)
          .padding(.horizontal, SearchMetrics.listSide + SearchMetrics.rowPadding)
          .frame(maxWidth: .infinity, minHeight: list, alignment: .leading)
      }
      Text(verbatim: "↑↓ to move · ↩ to open · ⌘↩ to open in a split · esc to close")
        .font(.system(size: 11)).foregroundStyle(SearchColors.tertiary)
        .padding(.horizontal, SearchMetrics.queryPadding)
        .frame(maxWidth: .infinity, minHeight: SearchMetrics.footer, maxHeight: SearchMetrics.footer, alignment: .leading)
        .overlay(alignment: .top) { Rectangle().fill(SearchColors.footerLine).frame(height: 0.5) }
        .accessibilityLabel("Up and down arrows move, Return opens, Command Return opens in a split, Escape closes")
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .background(SearchColors.tint)
    .overlay(RoundedRectangle(cornerRadius: SearchMetrics.radius, style: .continuous).strokeBorder(SearchColors.ring, lineWidth: 0.5))
    .clipShape(RoundedRectangle(cornerRadius: SearchMetrics.radius, style: .continuous))
    .environment(\.colorScheme, .dark)
    .onChange(of: height, initial: true) { _, h in onHeight(h) }
    .onAppear { focused = true }
    .onChange(of: model.paletteOpen) { _, open in if open { focused = true } }
    .accessibilityElement(children: .contain).accessibilityLabel("Search")
  }
}

/// The query: a 22 pt field with no box, after the magnifying glass.
private struct SearchField: View {
  @Environment(DeskModel.self) private var model
  var focused: FocusState<Bool>.Binding
  var body: some View {
    let binding = Binding(get: { model.paletteQuery }, set: { model.paletteQuery = $0 })
    HStack(spacing: SearchMetrics.queryGap) {
      Image(systemName: "magnifyingglass").font(.system(size: 18, weight: .regular)).foregroundStyle(SearchColors.tertiary)
        .frame(width: 20).accessibilityHidden(true)
      // The placeholder is drawn here: a field's own prompt takes the system's placeholder colour, under 4.5:1 here.
      TextField("", text: binding)
        .textFieldStyle(.plain)
        .font(.system(size: 22)).tracking(-0.22)
        .foregroundStyle(Color.white)
        .focused(focused)
        .background(alignment: .leading) {
          if model.paletteQuery.isEmpty {
            Text("Search…").font(.system(size: 22)).tracking(-0.22).foregroundStyle(SearchColors.tertiary)
              .allowsHitTesting(false).accessibilityHidden(true)
          }
        }
        .accessibilityLabel("Search agents, projects and commands")
    }
    .padding(.horizontal, SearchMetrics.queryPadding)
    .frame(height: SearchMetrics.queryHeight)
  }
}

/// The results: fixed-height rows in a lazy stack, scrolled to keep the selection in view (never animated).
private struct SearchList: View {
  @Environment(DeskModel.self) private var model
  let height: CGFloat
  var body: some View {
    let s = model.search
    let rows = s.rows, sel = s.selection
    let _ = s.sections   // observed: the rows change with it
    ScrollViewReader { proxy in
      ScrollView(.vertical) {
        LazyVStack(spacing: 0) {
          ForEach(rows) { r in
            if let g = r.header {
              Text(verbatim: g.title).font(.system(size: 11, weight: .semibold)).foregroundStyle(SearchColors.secondary)
                .padding(.horizontal, SearchMetrics.rowPadding).padding(.bottom, 6)
                .frame(maxWidth: .infinity, minHeight: SearchMetrics.header, maxHeight: SearchMetrics.header, alignment: .bottomLeading)
                .accessibilityAddTraits(.isHeader)
            } else if let hit = r.hit {
              SearchRowView(hit: hit, selected: r.index == sel, bot: Self.bot(model, hit.item.icon)) { split in
                model.selectPalette(r.index)
                model.runPaletteSelection(split: split)
              }
              .id(r.id)
            }
          }
        }
        .padding(.horizontal, SearchMetrics.listSide)
        .padding(.top, SearchMetrics.listTop).padding(.bottom, SearchMetrics.listBottom)
      }
      .scrollIndicators(.automatic)
      .frame(height: height)
      .onChange(of: sel) { _, n in if s.hits.indices.contains(n) { proxy.scrollTo(s.hits[n].id) } }
      .onChange(of: s.sections) { _, _ in if let first = rows.first { proxy.scrollTo(first.id, anchor: .top) } }
    }
  }

  static func bot(_ m: DeskModel, _ icon: SearchIcon) -> BotTraits? {
    guard case .bot(let run, let agent) = icon else { return nil }
    return m.team(run)[agent]
  }
}

/// One result: icon, title (what matched in semibold), subtitle, then its status, shortcut or, selected, the keys.
struct SearchRowView: View {
  let hit: SearchHit
  let selected: Bool
  let bot: BotTraits?
  let open: (_ split: Bool) -> Void

  var body: some View {
    let item = hit.item
    let red = item.destructive && !selected
    Button { open(NSEvent.modifierFlags.contains(.command)) } label: {
      HStack(spacing: SearchMetrics.rowGap) {
        icon(item.icon, red: red).frame(width: SearchMetrics.icon, height: SearchMetrics.icon)
        TitleAndSubtitle {
          Text(Self.marked(item.title.text, hit.titleHits)).foregroundStyle(red ? Theme.red : selected ? SearchColors.onSelection : SearchColors.text)
            .lineLimit(1).truncationMode(.tail)
          if let sub = item.subtitle {
            Text(Self.marked(sub.text, hit.subtitleHits)).foregroundStyle(selected ? SearchColors.onSelectionSecondary : SearchColors.secondary)
              .lineLimit(1).truncationMode(.tail)
          }
        }
        .font(.system(size: 13))
        Spacer(minLength: 8)
        trailing(item)
      }
      .padding(.horizontal, SearchMetrics.rowPadding)
      .frame(height: SearchMetrics.row)
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: SearchMetrics.rowRadius, style: .continuous).fill(selected ? SearchColors.selection : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityLabel(Self.spoken(hit))
    .accessibilityAddTraits(selected ? [.isSelected] : [])
  }

  @ViewBuilder private func icon(_ i: SearchIcon, red: Bool) -> some View {
    let tint = red ? Theme.red : selected ? SearchColors.onSelectionSecondary : SearchColors.tertiary
    switch i {
    case .bot: BotAvatar(traits: bot, size: .xs)
    case .place(let sandbox):
      Image(systemName: Place(sandbox: sandbox)?.symbol ?? "folder").font(.system(size: 14)).foregroundStyle(tint)
    case .symbol(let name): Image(systemName: name).font(.system(size: 14)).foregroundStyle(tint)
    }
  }

  @ViewBuilder private func trailing(_ item: SearchItem) -> some View {
    let quiet = selected ? SearchColors.onSelectionSecondary : SearchColors.tertiary
    if selected, Self.opensSomething(item.action) {
      HStack(spacing: 14) { Text(verbatim: "↩ Open"); Text(verbatim: "⌘↩ Open in split") }
        .font(.system(size: 13)).foregroundStyle(SearchColors.hint)
    } else {
      switch item.trailing {
      case .none: EmptyView()
      case .status(let w): Text(verbatim: w).font(.system(size: 13)).foregroundStyle(quiet)
      case .ask(let w):
        HStack(spacing: 6) { Image(systemName: "hand.raised").font(.system(size: 12)); Text(verbatim: w) }
          .font(.system(size: 13, weight: .medium)).foregroundStyle(selected ? SearchColors.onSelection : Theme.amber)
      case .shortcut(let k): Text(verbatim: k).font(.system(size: 13).monospacedDigit()).tracking(0.26).foregroundStyle(quiet)
      case .changes(let a, let r, let f):
        HStack(spacing: 4) {
          if a != nil || r != nil { Text(verbatim: "+\(a ?? 0) −\(r ?? 0)") }
          if let f { Text(verbatim: "· \(f) \(f == 1 ? "file" : "files")") }
        }
        .font(.system(size: 13).monospacedDigit()).foregroundStyle(quiet)
      case .code(let c): Text(verbatim: c).font(.system(size: 12, design: .monospaced)).foregroundStyle(quiet)
      }
    }
  }

  static func opensSomething(_ a: SearchAction) -> Bool {
    switch a { case .agent, .project: true; default: false }
  }

  /// The title with what matched in semibold (CommandK `.hl`).
  static func marked(_ text: String, _ at: [Int]) -> AttributedString {
    guard !at.isEmpty else { return AttributedString(text) }
    let set = Set(at)
    var out = AttributedString()
    var run = "", runBold = false
    func flush() {
      guard !run.isEmpty else { return }
      var a = AttributedString(run)
      if runBold { a.font = .system(size: 13, weight: .semibold) }
      out += a; run = ""
    }
    for (i, c) in text.enumerated() {
      let b = set.contains(i)
      if b != runBold { flush(); runBold = b }
      run.append(c)
    }
    flush()
    return out
  }

  static func spoken(_ h: SearchHit) -> String {
    let i = h.item
    var parts = [i.title.text]
    if let s = i.subtitle { parts.append(s.text) }
    switch i.trailing {
    case .status(let w), .ask(let w): parts.append(w)
    case .shortcut(let k): parts.append(k)
    default: break
    }
    return parts.joined(separator: ", ")
  }
}

/// The title takes what it needs, up to 68 % of the room; the subtitle gets the rest and truncates first.
private struct TitleAndSubtitle: Layout {
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let w = proposal.width ?? .infinity
    let (a, b) = widths(w, subviews)
    let h = subviews.map { $0.sizeThatFits(.unspecified).height }.max() ?? 0
    return CGSize(width: a + (subviews.count > 1 && b > 0 ? SearchMetrics.rowGap + b : 0), height: h)
  }
  func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    let (a, b) = widths(bounds.width, subviews)
    subviews.first?.place(at: CGPoint(x: bounds.minX, y: bounds.midY), anchor: .leading, proposal: ProposedViewSize(width: a, height: bounds.height))
    if subviews.count > 1 {
      subviews[1].place(at: CGPoint(x: bounds.minX + a + SearchMetrics.rowGap, y: bounds.midY), anchor: .leading,
                        proposal: ProposedViewSize(width: max(0, b), height: bounds.height))
    }
  }
  private func widths(_ room: CGFloat, _ subviews: Subviews) -> (CGFloat, CGFloat) {
    guard let t = subviews.first else { return (0, 0) }
    let ideal = t.sizeThatFits(.unspecified).width
    guard subviews.count > 1 else { return (min(ideal, room), 0) }
    let a = min(ideal, room.isFinite ? room * SearchMetrics.titleShare : ideal)
    let rest = room.isFinite ? room - a - SearchMetrics.rowGap : subviews[1].sizeThatFits(.unspecified).width
    return (a, max(0, min(rest, subviews[1].sizeThatFits(.unspecified).width)))
  }
}
#endif
