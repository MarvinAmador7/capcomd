#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdBot

/// SPEC §4.5 thread content from the daemon's blocks/1 tree (thread-panel-v2, thread-states). Every string is agent-written
/// plain text: it goes into `Text(verbatim:)` or a plain `AttributedString(_:)` (never markdown), links act only on the
/// daemon's classification (LinkAction), and media loads through the daemon or, for remote media, only on a click.

/// What thread views need from the app showing them, so the same views serve the menu bar and the desktop app. Each
/// host decides how narrowly its reads are observed: the desktop reads per-agent slices, so a row re-renders only when
/// what it shows changed.
@MainActor package protocol ThreadHost: AnyObject {
  func bot(runId: String, agentId: String) -> BotTraits?
  func agentProvider(runId: String, agentId: String) -> Provider?
  /// The agent's role as the tree names it ("worker").
  func role(runId: String, agentId: String) -> String?
  func media(_ key: MediaKey) -> Fetched<Data>?
  func loadMedia(_ key: MediaKey) async
  /// A click on a handoff or an agent link: show that agent.
  func openAgent(runId: String, agentId: String)
}

/// The host, compared by identity so re-applying the same one never invalidates the views that read it.
package struct ThreadHostBox: Equatable {
  package let host: any ThreadHost
  package init(host: any ThreadHost) { self.host = host }
  package static func == (a: Self, b: Self) -> Bool { a.host === b.host }
}
private struct ThreadHostKey: EnvironmentKey { static let defaultValue: ThreadHostBox? = nil }
extension EnvironmentValues {
  package var threadHost: ThreadHostBox? { get { self[ThreadHostKey.self] } set { self[ThreadHostKey.self] = newValue } }
}

/// Internal link URLs: a click on an agent or run link navigates; web links carry their own (checked http/https) URL.
package enum ThreadLinkURL {
  package static let scheme = "capcomd-thread"
  package static func make(_ a: LinkAction) -> URL? {
    switch a {
    case .web(let u): return u
    case .agent(let id): return URL(string: "\(scheme)://agent/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
    case .run(let id): return URL(string: "\(scheme)://run/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
    case .file, .artifact, .none: return nil
    }
  }
}

/// Inline nodes → one AttributedString. Only typed attributes are set; the text is never parsed.
package enum InlineText {
  package static func make(_ xs: [Inline], font: Font, code: Font = Theme.Content.codeInlineFont) -> AttributedString {
    var out = AttributedString()
    for x in xs { out += piece(x, font: font, code: code, bold: false, italic: false, strike: false) }
    return out
  }
  package static func piece(_ x: Inline, font: Font, code: Font, bold: Bool, italic: Bool, strike: Bool) -> AttributedString {
    func styled(_ s: String) -> AttributedString {
      var a = AttributedString(s)
      var f = font; if bold { f = f.bold() }; if italic { f = f.italic() }
      a.font = f; if strike { a.strikethroughStyle = .single }
      return a
    }
    switch x {
    case .text(let s): return styled(s)
    case .lineBreak: return AttributedString("\n")
    case .unknown(let s): return styled(s ?? "")
    case .strong(let k): return k.reduce(into: AttributedString()) { $0 += piece($1, font: font, code: code, bold: true, italic: italic, strike: strike) }
    case .em(let k): return k.reduce(into: AttributedString()) { $0 += piece($1, font: font, code: code, bold: bold, italic: true, strike: strike) }
    case .strike(let k): return k.reduce(into: AttributedString()) { $0 += piece($1, font: font, code: code, bold: bold, italic: italic, strike: true) }
    case .code(let s):
      var a = AttributedString("\u{2009}\(s)\u{2009}")   // thin spaces stand in for .icd's 4 pt side padding
      a.font = code; a.foregroundColor = Theme.Content.codeInlineText; a.backgroundColor = Theme.Content.codeInlineFill
      return a
    case .link(let l):
      switch l.action {
      case .web, .agent, .run:
        var a = styled(l.text); a.link = ThreadLinkURL.make(l.action); a.foregroundColor = Theme.Content.link
        if let d = l.destination {   // the real destination, never just the link's own words
          var t = AttributedString(" \(d)"); t.font = Theme.Content.truncatedFont; t.foregroundColor = Theme.Content.linkDetail
          a += t
        }
        return a
      case .file, .artifact:
        var a = AttributedString(l.text); a.font = code; a.foregroundColor = Theme.Content.pathText
        return a
      case .none: return styled(l.text)
      }
    }
  }
}

/// A run of blocks: prose, lists, code, tables, quotes, rules, media.
/// Keeps prose to a reading column narrower than the thread, centred: the desktop's expanded pane keeps prose to 800 pt
/// while code, tables, diffs and tool results take the thread's whole width (1060 pt). `width` is handed down by the
/// thread's rows (`proseWidth`; nil everywhere else, where nothing changes); `wide` content keeps the full width.
package struct ProseColumn: ViewModifier {
  let width: CGFloat?
  package var wide = false
  package init(_ width: CGFloat?, wide: Bool = false) { self.width = width; self.wide = wide }
  package func body(content: Content) -> some View {
    if let width, !wide {
      content.frame(maxWidth: width, alignment: .leading).frame(maxWidth: .infinity)
    } else {
      content
    }
  }
}

package struct BlocksView: View {
  package let runId: String
  package let agentId: String
  package let blocks: [Block]
  package var font: Font = Theme.Content.proseFont
  package var color: Color = Theme.Content.proseText
  package var spacing: CGFloat = Theme.Content.proseSpacing
  /// Space under a paragraph: list items sit tight (`li` margins are 1 pt).
  package var paragraphBottom: CGFloat = Theme.Content.proseBottom
  /// Margin already above the first block (the previous item's bottom margin). Vertical margins collapse as in the
  /// mockups' CSS: a heading sits max(that, 14) below what precedes it, not their sum.
  package var leadingMargin: CGFloat = 0
  /// The reading column when the thread is wider (ProseColumn); nil for nested blocks and everywhere but an expanded pane.
  package var proseWidth: CGFloat? = nil
  package init(runId: String, agentId: String, blocks: [Block], font: Font = Theme.Content.proseFont, color: Color = Theme.Content.proseText, spacing: CGFloat = Theme.Content.proseSpacing, paragraphBottom: CGFloat = Theme.Content.proseBottom, leadingMargin: CGFloat = 0, proseWidth: CGFloat? = nil) { self.runId = runId; self.agentId = agentId; self.blocks = blocks; self.font = font; self.color = color; self.spacing = spacing; self.paragraphBottom = paragraphBottom; self.leadingMargin = leadingMargin; self.proseWidth = proseWidth }

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { n, b in
        block(b, above: n == 0 ? leadingMargin : Self.bottomMargin(blocks[n - 1])).modifier(ProseColumn(proseWidth, wide: Self.isWide(b)))
      }
    }
  }

  /// Code and tables run wider than the prose where the thread has room (`proseWidth`).
  package static func isWide(_ b: Block) -> Bool { switch b { case .code, .table: true; default: false } }

  /// The bottom margin each block leaves (what a following heading collapses with).
  package static func bottomMargin(_ b: Block) -> CGFloat {
    switch b {
    case .code: Theme.Content.codeBottom
    case .table: Theme.Content.tableBottom
    case .rule: Theme.Content.ruleMargin
    case .heading: Theme.Content.headingBottom
    default: Theme.Content.proseBottom
    }
  }

  @ViewBuilder package func block(_ b: Block, above: CGFloat) -> some View {
    switch b {
    case .paragraph(let k):
      prose(k).padding(.bottom, paragraphBottom)
    case .heading(_, let k):
      Text(InlineText.make(k, font: Theme.Content.headingFont)).foregroundStyle(Theme.Content.headingText).textSelection(.enabled)
        .padding(.top, max(0, Theme.Content.headingTop - above)).padding(.bottom, Theme.Content.headingBottom)
    case .list(let ordered, let start, let items):
      VStack(alignment: .leading, spacing: Theme.Content.listItemGap) {
        ForEach(Array(items.enumerated()), id: \.offset) { n, item in
          HStack(alignment: .firstTextBaseline, spacing: Theme.Content.markerGap) {
            marker(ordered: ordered, n: (start ?? 1) + n, checked: item.checked).frame(width: Theme.Content.listIndent, alignment: ordered ? .leading : .center)
            BlocksView(runId: runId, agentId: agentId, blocks: item.blocks, font: font, color: color, spacing: spacing, paragraphBottom: 0)
              .opacity(item.checked == true ? 0.6 : 1)
          }
        }
      }
      .padding(.bottom, Theme.Content.proseBottom)
    case .code(let lang, let text, let cut):
      CodeBlock(lang: lang, text: text, truncatedLines: cut)
    case .table(let t):
      TableBlock(table: t)
    case .quote(let inner):
      BlocksView(runId: runId, agentId: agentId, blocks: inner, font: Theme.Content.thoughtFont, color: Theme.Content.thoughtText, spacing: Theme.Content.thoughtSpacing)
        .padding(.leading, Theme.Content.thoughtIndent)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.Content.thoughtRule).frame(width: 1) }
        .padding(.bottom, Theme.Content.proseBottom)
    case .rule:
      Rectangle().fill(Theme.Content.ruleColor).frame(height: 0.5).padding(.vertical, Theme.Content.ruleMargin)
    case .media(let m):
      MediaBlockView(runId: runId, agentId: agentId, media: m).padding(.bottom, Theme.Content.proseBottom)
    case .open(let s):
      Text(verbatim: s).font(font).foregroundStyle(color).lineSpacing(spacing).padding(.bottom, Theme.Content.proseBottom)
    case .unknown(let s):
      if let s, !s.isEmpty { Text(verbatim: s).font(font).foregroundStyle(color).lineSpacing(spacing).padding(.bottom, Theme.Content.proseBottom) }
    }
  }

  package func prose(_ k: [Inline]) -> some View {
    Text(InlineText.make(k, font: font)).foregroundStyle(color).lineSpacing(spacing).tint(Theme.Content.link)
      .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder package func marker(ordered: Bool, n: Int, checked: Bool?) -> some View {
    if let checked {
      Image(systemName: checked ? "checkmark.square" : "square").font(.system(size: 11)).foregroundStyle(checked ? Theme.accent : Theme.Content.listMarker)
    } else {
      Text(verbatim: ordered ? "\(n)." : "•").font(font).foregroundStyle(Theme.Content.listMarker)
    }
  }
}

package struct CodeBlock: View {
  package let lang: String?
  package let text: String
  package let truncatedLines: Int?
  package init(lang: String?, text: String, truncatedLines: Int?) { self.lang = lang; self.text = text; self.truncatedLines = truncatedLines }
  @State private var copied = false

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        Text(verbatim: lang ?? "")
        Spacer()
        Button(copied ? "Copied" : "Copy") {
          NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string); copied = true
        }
        .buttonStyle(.plain).accessibilityLabel("Copy code")
      }
      .font(Theme.Content.codeBarFont).foregroundStyle(Theme.Content.codeBarText).padding(Theme.Content.codeBarPadding)
      ScrollView(.horizontal, showsIndicators: false) {
        Text(Self.highlighted(text, lang: lang)).font(Theme.Content.codeFont).foregroundStyle(Theme.Content.codeText)
          .lineSpacing(Theme.Content.codeSpacing).fixedSize().textSelection(.enabled).padding(Theme.Content.codePadding)
      }
      if let n = truncatedLines {
        Text("\(n) more \(n == 1 ? "line" : "lines") not shown").font(Theme.Content.truncatedFont).foregroundStyle(Theme.Content.truncatedText)
          .padding(.horizontal, Theme.Content.codePadding.leading).padding(.bottom, Theme.Content.codePadding.bottom)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Theme.Content.codeRadius, style: .continuous).fill(Theme.Content.codeFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.Content.codeRadius, style: .continuous).strokeBorder(Theme.Content.codeStroke, lineWidth: 0.5))
    .padding(.bottom, Theme.Content.codeBottom)
  }

  package static func highlighted(_ code: String, lang: String?) -> AttributedString {
    var out = AttributedString()
    for t in Highlight.tokens(code, lang: lang) {
      var a = AttributedString(t.text)
      switch t.kind {
      case .keyword: a.foregroundColor = Theme.Content.keyword
      case .string: a.foregroundColor = Theme.Content.string
      case .comment: a.foregroundColor = Theme.Content.comment
      case .number: a.foregroundColor = Theme.Content.number
      case .plain: break
      }
      out += a
    }
    return out
  }
}

package struct TableBlock: View {
  package let table: CapcomdThread.Table
  package init(table: CapcomdThread.Table) { self.table = table }
  package var body: some View {
    let cols = max(table.header.count, table.rows.map(\.count).max() ?? 0)
    VStack(alignment: .leading, spacing: 0) {
      Grid(alignment: .leading, horizontalSpacing: 0, verticalSpacing: 0) {
        GridRow {
          ForEach(0..<cols, id: \.self) { c in
            cell(c < table.header.count ? table.header[c] : [], col: c, font: Theme.Content.thFont)
              .foregroundStyle(Theme.Content.thText).padding(Theme.Content.thPadding)
              .frame(maxWidth: .infinity, alignment: alignment(c))
              .overlay(alignment: .bottom) { Rectangle().fill(Theme.Content.thRule).frame(height: 0.5) }
          }
        }
        ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
          GridRow {
            ForEach(0..<cols, id: \.self) { c in
              cell(c < row.count ? row[c] : [], col: c, font: Theme.Content.tableFont)
                .foregroundStyle(Theme.Content.tableText).padding(Theme.Content.tdPadding)
                .frame(maxWidth: .infinity, alignment: alignment(c))
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.Content.tdRule).frame(height: 0.5) }
            }
          }
        }
      }
      let more = [table.truncatedRows.map { "\($0) more \($0 == 1 ? "row" : "rows")" }, table.truncatedCols.map { "\($0) more \($0 == 1 ? "column" : "columns")" }].compactMap { $0 }
      if !more.isEmpty {
        Text(verbatim: more.joined(separator: " · ") + " not shown").font(Theme.Content.truncatedFont).foregroundStyle(Theme.Content.truncatedText).padding(.top, 4)
      }
    }
    .padding(.bottom, Theme.Content.tableBottom)
  }
  package func alignment(_ c: Int) -> Alignment {
    switch c < table.align.count ? table.align[c] : nil { case .right?: .trailing; case .center?: .center; default: .leading }
  }
  package func cell(_ k: [Inline], col: Int, font: Font) -> some View {
    Text(InlineText.make(k, font: font, code: Theme.Content.tdMono)).tint(Theme.Content.link).textSelection(.enabled)
      .multilineTextAlignment(alignment(col) == .trailing ? .trailing : .leading)
  }
}

/// Attachment and workspace images load through the daemon (png, jpeg, gif, webp only). Remote media and anything
/// that isn't an image show as a chip: a remote image loads only when clicked, and nothing else ever loads.
package struct MediaBlockView: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let agentId: String
  package let media: Media
  package init(runId: String, agentId: String, media: Media) { self.runId = runId; self.agentId = agentId; self.media = media }
  @State private var remote: NSImage?
  @State private var remoteFailed = false

  package var key: MediaKey? {
    guard media.kind == .image else { return nil }
    switch media.source {
    case .attachment(let id): return .attachment(runId: runId, id: id)
    case .workspace(let p): return .workspace(runId: runId, agentId: agentId, path: p)
    case .remote, .unknown: return nil
    }
  }

  package var body: some View {
    if let key {
      switch host?.host.media(key) {
      case .loaded(let d)?:
        if let img = NSImage(data: d) { picture(img) } else { chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: "couldn't be shown") }
      case .unavailable?: chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: "unavailable")
      case .loading?: chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: nil)
      case nil:
        chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: nil).task { await host?.host.loadMedia(key) }
      }
    } else if case .remote(let url, let host) = media.source {
      if let remote { picture(remote) }
      else if media.kind == .image {
        Button { Task { await loadRemote(url) } } label: {
          chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: remoteFailed ? "\(host) · couldn't load" : "\(host) · click to load")
        }
        .buttonStyle(.plain).help(url)
      } else {
        chip(icon: icon, text: media.alt.isEmpty ? media.kind.rawValue.capitalized : media.alt, note: host).help(url)
      }
    } else {
      chip(icon: icon, text: media.alt.isEmpty ? media.kind.rawValue.capitalized : media.alt, note: sourceNote)
    }
  }

  package var icon: String { switch media.kind { case .image: "photo"; case .video: "film"; case .audio: "waveform"; case .file: "doc" } }
  package var sourceNote: String? { if case .workspace(let p) = media.source { return p }; return nil }

  package func picture(_ img: NSImage) -> some View {
    // Never larger than the image itself; scaled down to the column and the 180 pt cap.
    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
      .frame(maxWidth: img.size.width, maxHeight: min(img.size.height, Theme.Content.mediaMaxHeight))
      .frame(maxWidth: .infinity, alignment: .leading)
      .clipShape(RoundedRectangle(cornerRadius: Theme.Content.mediaRadius, style: .continuous))
      .accessibilityLabel(media.alt.isEmpty ? "Image" : media.alt)
  }

  package func chip(icon: String, text: String, note: String?) -> some View {
    HStack(spacing: Theme.Content.artGap) {
      Image(systemName: icon)
      Text(verbatim: text).lineLimit(1)
      if let note { Text(verbatim: note).foregroundStyle(Theme.Content.truncatedText).lineLimit(1) }
    }
    .font(Theme.Content.artFont).foregroundStyle(Theme.Content.artText).padding(Theme.Content.artPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.artRadius, style: .continuous).fill(Theme.Content.artFill))
  }

  /// Explicit click only: an ephemeral session, no cookies, http(s) only, at most 5 MB, raster images only.
  package func loadRemote(_ s: String) async {
    guard let u = URL(string: s), let sc = u.scheme?.lowercased(), sc == "https" || sc == "http" else { remoteFailed = true; return }
    let cfg = URLSessionConfiguration.ephemeral; cfg.httpCookieStorage = nil; cfg.timeoutIntervalForRequest = 10
    do {
      let (data, _) = try await URLSession(configuration: cfg).data(from: u)
      guard data.count <= 5 << 20, CapcomdStore.isRasterImage(data), let img = NSImage(data: data) else { remoteFailed = true; return }
      remote = img
    } catch { remoteFailed = true }
  }
}

/// One structured thread item.
package struct ThreadItemRow: View {
  package let runId: String
  package let agentId: String
  package let item: CapcomdThread.Item
  package let next: CapcomdThread.Item?
  /// Bottom margin of the entry above (0 under a tool or thinking row): headings collapse with it.
  package var above: CGFloat = 0
  /// The reading column when the thread is wider than it (an expanded pane); nil everywhere else.
  package var proseWidth: CGFloat? = nil
  package init(runId: String, agentId: String, item: CapcomdThread.Item, next: CapcomdThread.Item?, above: CGFloat = 0, proseWidth: CGFloat? = nil) { self.runId = runId; self.agentId = agentId; self.item = item; self.next = next; self.above = above; self.proseWidth = proseWidth }

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch item.kind {
      case "say", "result":
        // A reviewer's message that ends in its verdict JSON: the prose, then the verdict as a card.
        if let tail = item.verdictTail {
          if !tail.prose.isEmpty { BlocksView(runId: runId, agentId: agentId, blocks: tail.prose, leadingMargin: above, proseWidth: proseWidth) }
          VerdictCard(runId: runId, agentId: agentId, verdict: tail.verdict).modifier(ProseColumn(proseWidth))
        } else { blocks }
      case "thinking": ThinkingRunRow(runId: runId, agentId: agentId, run: ThinkingRun([item], next: next)).modifier(ProseColumn(proseWidth))
      case "tool": ToolCallRow(item: item, proseWidth: proseWidth)
      case "plan":
        Text("Plan").font(Theme.Content.headingFont).foregroundStyle(Theme.Content.headingText)
          .padding(.top, max(0, Theme.Content.headingTop - above)).padding(.bottom, Theme.Content.headingBottom)
          .modifier(ProseColumn(proseWidth))
        blocks
      case "error":
        HStack(alignment: .firstTextBaseline, spacing: Theme.Content.toolGap) {
          Image(systemName: "xmark.circle").font(.system(size: 11))
          Text(verbatim: item.error?.message ?? item.text).textSelection(.enabled)
        }
        .font(Theme.Content.errorFont).foregroundStyle(Theme.Content.errorText).padding(.bottom, Theme.Content.proseBottom)
        .modifier(ProseColumn(proseWidth))
      case "handoff": HandoffCard(runId: runId, item: item).modifier(ProseColumn(proseWidth))
      default:
        Text(verbatim: item.text).font(Theme.Content.otherFont).foregroundStyle(Theme.Content.otherText).padding(.bottom, Theme.Content.proseBottom)
          .modifier(ProseColumn(proseWidth))
      }
      if let t = item.truncated, t.blocks > 0 {
        Text("\(t.blocks) more \(t.blocks == 1 ? "block" : "blocks") not shown").font(Theme.Content.truncatedFont).foregroundStyle(Theme.Content.truncatedText)
          .padding(.bottom, Theme.Content.proseBottom)
          .modifier(ProseColumn(proseWidth))
      }
    }
  }

  /// A format this client doesn't know has no blocks: its plain text.
  @ViewBuilder package var blocks: some View {
    if item.blocks.isEmpty {
      Text(verbatim: item.text).font(Theme.Content.proseFont).foregroundStyle(Theme.Content.proseText).lineSpacing(Theme.Content.proseSpacing)
        .textSelection(.enabled).padding(.bottom, Theme.Content.proseBottom)
        .modifier(ProseColumn(proseWidth))
    } else {
      BlocksView(runId: runId, agentId: agentId, blocks: item.blocks, leadingMargin: above, proseWidth: proseWidth)
    }
  }

  /// What this item leaves under itself: tool and thinking rows their 8 pt; prose ends with its last block's.
  package static func bottomMargin(_ i: CapcomdThread.Item) -> CGFloat {
    switch i.kind {
    case "tool": i.tool?.diff == nil ? Theme.Rows.bottom : Theme.Content.diffBottom
    case "thinking": Theme.Rows.bottom
    case "handoff": Theme.Content.handoffBottom
    default: i.blocks.last.map(BlocksView.bottomMargin) ?? Theme.Content.proseBottom
    }
  }
}

/// `.tr`: a 16 pt muted icon, the tool's name in mono, what it was about at 62 %, and on the right its status (a running
/// arc, a done tick, "Failed", "Not allowed": only that word and glyph take colour) and its time. A click shows its
/// Arguments and Result. An edit with a diff is its diff card.
package struct ToolCallRow: View {
  package let item: CapcomdThread.Item
  /// Expanded pane: the summary line keeps to the reading column, the result (the log) and a diff run wide.
  package var proseWidth: CGFloat? = nil
  /// A call inside an open group: no space under it (the group's rows sit together).
  package var inGroup = false
  package init(item: CapcomdThread.Item, proseWidth: CGFloat? = nil, inGroup: Bool = false) { self.item = item; self.proseWidth = proseWidth; self.inGroup = inGroup }
  @State private var open = false
  @State private var hover = false
  /// It was running when this row first drew: when it finishes here, its tick pops.
  @State private var sawRunning = false

  package var body: some View {
    if let tool = item.tool, let diff = tool.diff {
      DiffCard(diff: diff, failed: tool.isError, open: $open) { detail(tool) }
    } else { row }
  }

  package var row: some View {
    let tool = item.tool, status = item.toolStatus
    let name = tool?.displayName ?? "tool", what = tool?.detail ?? item.text
    return VStack(alignment: .leading, spacing: 0) {
      Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: {   // snaps: the panel resizes to fit (SPEC §7)
        HStack(spacing: Theme.Rows.gap) {
          Image(systemName: ToolIcon.symbol(tool)).font(Theme.Rows.iconFont).foregroundStyle(Theme.Rows.iconText)
            .frame(width: Theme.Rows.icon, height: Theme.Rows.icon)
          Text(verbatim: name).font(Theme.Rows.name)
            .foregroundStyle(status == .notAllowed ? Theme.Rows.nameRefusedText : Theme.Rows.nameText).fixedSize()
          Text(verbatim: what).font(Theme.Rows.detail).foregroundStyle(Theme.Rows.detailText)
            .lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
          ToolStatusView(status: status, duration: item.durationMs.map { callDuration(ms: $0) }, finishedNow: sawRunning && status == .done)
            .padding(.leading, Theme.Rows.statusLead)
        }
        .frame(height: Theme.Rows.height).padding(.horizontal, Theme.Rows.hoverInset)
        .background(RoundedRectangle(cornerRadius: Theme.Rows.hoverRadius, style: .continuous).fill(hover ? Theme.Rows.hover : .clear))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain).onHover { hover = $0 }
      .padding(.horizontal, -Theme.Rows.hoverInset)
      .accessibilityLabel(Self.spoken(name: name, what: what, status: status))
      .modifier(ProseColumn(proseWidth))
      if open, let tool { detail(tool).modifier(RiseIn()) }
    }
    .padding(.bottom, inGroup ? 0 : Theme.Rows.bottom)
    .onAppear { if item.open { sawRunning = true } }
  }

  package static func spoken(name: String, what: String, status: ToolStatus) -> String {
    let s: String = switch status { case .running: "running"; case .done: "done"; case .failed: "failed"; case .notAllowed: "not allowed" }
    return "\(name) \(what), \(s)"
  }

  package func detail(_ t: CapcomdThread.Item.Tool) -> some View {
    VStack(alignment: .leading, spacing: 0) {
      if let a = t.args, !a.isEmpty { section("Arguments", a, first: true) }
      if let o = t.output, !o.isEmpty { section("Result", o, first: t.args?.isEmpty ?? true) }
      else if item.open { section("Result", "Running…", first: t.args?.isEmpty ?? true) }
      if !t.files.isEmpty {
        Text("Files").font(Theme.Content.detailLabel).foregroundStyle(Theme.Content.detailLabelText)
          .padding(.top, Theme.Content.detailSectionGap).padding(.bottom, Theme.Content.detailLabelGap)
        ForEach(Array(t.files.enumerated()), id: \.offset) { _, f in Text(verbatim: f.path ?? f.text) }
      }
    }
    .font(Theme.Content.detailFont).foregroundStyle(Theme.Content.detailText).lineSpacing(Theme.Content.detailSpacing)
    .frame(maxWidth: .infinity, alignment: .leading).padding(Theme.Content.detailPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.detailRadius, style: .continuous).fill(Theme.Content.detailFill))
    .padding(Theme.Content.detailMargin)
  }

  package func section(_ label: String, _ text: String, first: Bool) -> some View {
    VStack(alignment: .leading, spacing: Theme.Content.detailLabelGap) {
      Text(label).font(Theme.Content.detailLabel).foregroundStyle(Theme.Content.detailLabelText)
      Text(verbatim: Self.clip(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, first ? 0 : Theme.Content.detailSectionGap)
  }

  /// Long results keep their last lines (the daemon keeps the end too).
  package static func clip(_ s: String) -> String {
    let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count > Theme.Content.detailMaxLines else { return s }
    return "… \(lines.count - Theme.Content.detailMaxLines) earlier lines\n" + lines.suffix(Theme.Content.detailMaxLines).joined(separator: "\n")
  }
}

/// `.df`: an edit as a diff card: pencil · path · `+n −n`, then its first lines (context, removed red, added green; `@`
/// gaps as a faint hunk header). A click on the header shows the call's arguments and result. A failed edit is dimmed.
package struct DiffCard<Detail: View>: View {
  package let diff: CapcomdThread.Item.Diff
  package let failed: Bool
  @Binding var open: Bool
  @ViewBuilder package let detail: () -> Detail

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: {   // snaps: the panel resizes to fit (SPEC §7)
          HStack(spacing: Theme.Content.diffHeaderGap) {
            Image(systemName: "square.and.pencil").font(.system(size: 10)).foregroundStyle(Theme.Content.label.opacity(0.6))
            Text(verbatim: diff.path ?? "a file outside the workspace").lineLimit(1).truncationMode(.middle)
            if failed { Text("didn't apply").foregroundStyle(Theme.Content.errorText) }
            Spacer(minLength: 0)
            HStack(spacing: 4) {
              Text(verbatim: "+\(diff.added)").foregroundStyle(Theme.Content.diffAdded)
              Text(verbatim: "−\(diff.removed)").foregroundStyle(Theme.Content.diffRemoved)
            }
          }
          .font(Theme.Content.diffHeaderFont).foregroundStyle(Theme.Content.diffHeaderText)
          .padding(Theme.Content.diffHeaderPadding).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Edit \(diff.path ?? "file"), \(diff.added) added, \(diff.removed) removed")
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.Content.diffHeaderRule).frame(height: 0.5) }
        ForEach(Array(diff.lines.enumerated()), id: \.offset) { _, l in line(l) }
        if let n = diff.truncatedLines {
          Text("\(n) more \(n == 1 ? "line" : "lines")").font(Theme.Content.truncatedFont).foregroundStyle(Theme.Content.truncatedText)
            .padding(.horizontal, Theme.Content.diffPadding).padding(.vertical, 4)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      .background(RoundedRectangle(cornerRadius: Theme.Content.diffRadius, style: .continuous).fill(Theme.Content.diffFill))
      .overlay(RoundedRectangle(cornerRadius: Theme.Content.diffRadius, style: .continuous).strokeBorder(Theme.Content.diffStroke, lineWidth: 0.5))
      .clipShape(RoundedRectangle(cornerRadius: Theme.Content.diffRadius, style: .continuous))
      .opacity(failed ? Theme.Content.diffFailedOpacity : 1)
      .padding(.bottom, open ? 6 : Theme.Content.diffBottom)
      if open { detail().transition(.opacity) }
    }
  }

  @ViewBuilder package func line(_ l: CapcomdThread.Item.Diff.Line) -> some View {
    switch l.op {
    case .gap:
      Text(verbatim: l.text.isEmpty ? "⋯" : l.text).font(Theme.Content.diffFont).foregroundStyle(Theme.Content.diffGapText)
        .lineLimit(1).frame(height: Theme.Content.diffLine).padding(.horizontal, Theme.Content.diffPadding)
    default:
      let (mark, text, fill): (String, Color, Color) = switch l.op {
        case .added: ("+", Theme.Content.diffAddedText, Theme.Content.diffAddedFill)
        case .removed: ("−", Theme.Content.diffRemovedText, Theme.Content.diffRemovedFill)
        default: (" ", Theme.Content.diffContext, .clear)
      }
      HStack(spacing: 0) {
        Text(verbatim: mark).foregroundStyle(Theme.Content.diffMarkerText).frame(width: Theme.Content.diffMarker, alignment: .leading)
        Text(verbatim: l.text).foregroundStyle(text).lineLimit(1).truncationMode(.tail)
      }
      .font(Theme.Content.diffFont).frame(maxWidth: .infinity, minHeight: Theme.Content.diffLine, alignment: .leading)
      .padding(.horizontal, Theme.Content.diffPadding).background(fill)
    }
  }
}

/// A card in the thread (`.card`): a step above the pane, 10 pt corners, a 0.5 pt inset hairline and a 1 pt shadow.
package struct ThreadCard: ViewModifier {
  package init() {}
  package func body(content: Content) -> some View {
    let r = RoundedRectangle(cornerRadius: Theme.Affect.cardRadius, style: .continuous)
    content
      .frame(maxWidth: .infinity, alignment: .leading)
      .padding(Theme.Affect.cardPadding)
      .background(r.fill(Theme.Affect.card).shadow(color: Theme.Affect.cardShadow, radius: 1, y: 1))
      .overlay(r.strokeBorder(Theme.Affect.cardStroke, lineWidth: Theme.Affect.hairline))
  }
}

/// A reviewer's verdict (its message was `{"passed", "reasons"}`) as a card instead of raw JSON: the reviewer's bot (it
/// cheers when the work passes, makes its "oops" face when it doesn't: the face is the bot's own), the seal and "Passed
/// review" / "Didn't pass review", then each reason. The reasons are agent text, shown as plain text.
package struct VerdictCard: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let agentId: String
  package let verdict: Verdict
  package init(runId: String, agentId: String, verdict: Verdict) { self.runId = runId; self.agentId = agentId; self.verdict = verdict }
  private var face: BotTraits? {
    guard let t = host?.host.bot(runId: runId, agentId: agentId) else { return nil }
    return verdict.passed ? ((try? withOverrides(t, mood: .happy, pose: "cheer")) ?? (try? withOverrides(t, mood: .happy)) ?? t)
                          : ((try? withOverrides(t, mood: .oops)) ?? t)
  }
  package var body: some View {
    VStack(alignment: .leading, spacing: Theme.Affect.cardGap) {
      HStack(spacing: Theme.Rows.whoGap) {
        if let face { BotAvatar(traits: face, size: .xs).frame(width: Theme.Rows.whoBot, height: Theme.Rows.whoBot).accessibilityHidden(true) }
        VerdictLine(verdict: verdict)
      }
      if !verdict.reasons.isEmpty { ReasonsList(reasons: verdict.reasons) }
    }
    .modifier(ThreadCard())
    .padding(.bottom, Theme.Content.handoffBottom)
    .accessibilityElement(children: .combine)
  }
}

/// `.card`: a child that finished. The who line: its bot (16 pt), its name, "role · handed back" quietly, a chevron (a
/// click opens its thread). A reviewer's verdict as the seal and "Passed review" / "Didn't pass review" with its reasons;
/// else its summary as markdown blocks. The body is clamped to about three lines, fading out, with Show more; its
/// artifacts as chips. The text is selectable.
package struct HandoffCard: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let item: CapcomdThread.Item
  package init(runId: String, item: CapcomdThread.Item) { self.runId = runId; self.item = item }
  @State private var more = false
  /// The body's own height, measured unclamped: Show more only when it runs past the clamp.
  @State private var fullHeight: CGFloat = 0

  package var body: some View {
    let childId = item.child?.agentId
    let h = host?.host
    let verdict = item.handoffVerdict
    let (summary, artifacts) = Self.split(verdict?.rest ?? item.blocks)
    let clamps = fullHeight > Theme.Rows.clamp + Theme.Rows.clampSlack
    VStack(alignment: .leading, spacing: Theme.Affect.cardGap) {
      Button { if let childId { h?.openAgent(runId: runId, agentId: childId) } } label: {
        HStack(spacing: Theme.Rows.whoGap) {
          let bot = childId.flatMap { h?.bot(runId: runId, agentId: $0) }
          ProvidedBot(traits: bot, size: .xs, provider: childId.flatMap { h?.agentProvider(runId: runId, agentId: $0) })
            .frame(width: Theme.Rows.whoBot, height: Theme.Rows.whoBot)
          // The bot's name leads; the role joins the note ("worker · handed back").
          let role = childId.flatMap { h?.role(runId: runId, agentId: $0) } ?? "Agent", name = bot?.name
          Text(verbatim: name ?? role).font(Theme.Rows.whoName).foregroundStyle(Theme.Rows.whoNameText)
          let note = item.child?.status == "failed" ? "failed" : "handed back"
          Text(verbatim: name == nil ? note : "\(role) · \(note)").font(Theme.Rows.whoFont).foregroundStyle(Theme.Rows.whoText)
          Spacer(minLength: 0)
          Image(systemName: "chevron.right").font(Theme.Rows.chevron).foregroundStyle(Theme.Rows.whoChevron)
        }
        .lineLimit(1)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(childId == nil)
      .help(childId == nil ? "" : "Open its thread")
      if let v = verdict?.verdict { VerdictLine(verdict: v) }
      VStack(alignment: .leading, spacing: 0) {
        if let v = verdict?.verdict, !v.reasons.isEmpty, Self.reasonsOnly(summary, v) {
          ReasonsList(reasons: v.reasons)
        } else if !summary.isEmpty {
          BlocksView(runId: runId, agentId: childId ?? "", blocks: summary, font: Theme.Rows.cardFont,
                     color: Theme.Rows.cardText, spacing: Theme.Affect.bodySpacing)
            .padding(.bottom, -Theme.Content.proseBottom)
        }
      }
      .fixedSize(horizontal: false, vertical: true)
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { fullHeight = $0 }
      .frame(maxHeight: clamps && !more ? Theme.Rows.clamp : nil, alignment: .top)
      .clipped()
      .mask { Self.fade(clamps && !more) }
      if clamps {
        Button(more ? "Show less" : "Show more") { withTransaction(Transaction(animation: nil)) { more.toggle() } }   // snaps, as a thought unfolds
          .buttonStyle(.plain).font(Theme.Rows.more).foregroundStyle(Theme.Rows.moreText)
      }
      if !artifacts.isEmpty {
        HStack(spacing: Theme.Content.artGap) { ForEach(Array(artifacts.enumerated()), id: \.offset) { _, l in ArtifactChip(link: l) } }
      }
    }
    .multilineTextAlignment(.leading)
    .modifier(ThreadCard())
    .padding(.bottom, Theme.Content.handoffBottom)
  }

  /// The daemon writes a reviewer's reasons into the hand-back as a list after the line that says the verdict: when the
  /// summary is only that list, the reasons are drawn from the verdict itself.
  static func reasonsOnly(_ summary: [Block], _ v: Verdict) -> Bool {
    guard summary.count <= 1 else { return false }
    guard case .list(false, _, let items)? = summary.first else { return summary.isEmpty }
    return items.count == v.reasons.count
  }

  /// A clamped body fades out over its last lines (opaque to 62 %, then clear), so it reads as cut, not ended.
  @ViewBuilder static func fade(_ on: Bool) -> some View {
    if on {
      LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: Theme.Rows.clampFadeFrom), .init(color: .clear, location: 1)],
                     startPoint: .top, endPoint: .bottom)
    } else { Color.black }
  }

  /// The daemon puts a handoff's artifacts last, as a list of one-link items (handoffDraft): those become `.art` chips.
  package static func split(_ blocks: [Block]) -> ([Block], [CapcomdThread.Link]) {
    guard case .list(false, _, let items)? = blocks.last else { return (blocks, []) }
    var links: [CapcomdThread.Link] = []
    for i in items {
      guard i.checked == nil, case .paragraph(let k)? = i.blocks.first, i.blocks.count == 1, k.count == 1, case .link(let l) = k[0] else { return (blocks, []) }
      links.append(l)
    }
    return (Array(blocks.dropLast()), links)
  }
}

/// `.art`: an artifact a child handed back, as the daemon classified it (folder or file icon, mono name).
package struct ArtifactChip: View {
  package let link: CapcomdThread.Link
  package init(link: CapcomdThread.Link) { self.link = link }
  package var body: some View {
    HStack(spacing: Theme.Content.artGap) {
      Image(systemName: icon).font(.system(size: 9))
      Text(verbatim: link.text).lineLimit(1).truncationMode(.middle)
    }
    .font(Theme.Content.artFont).foregroundStyle(Theme.Content.artText).padding(Theme.Content.artPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.artRadius, style: .continuous).fill(Theme.Content.artFill))
    .help(link.destination ?? link.path ?? link.text)
  }
  package var icon: String {
    switch link.target {
    case .web: "globe"; case .agent: "hexagon"; case .run: "point.3.connected.trianglepath.dotted"; case .artifact: "paperclip"
    case .file: "doc"; case .none: link.text.hasSuffix("/") ? "folder" : "doc"
    }
  }
}

/// The 9 pt chevron of `.thk` / `.tc` (32 %), turned down when open.
package struct Chevron: View {
  package let open: Bool
  package init(open: Bool) { self.open = open }
  package var body: some View {
    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.Content.label.opacity(0.32))
      .rotationEffect(.degrees(open ? 90 : 0))
  }
}
#endif
