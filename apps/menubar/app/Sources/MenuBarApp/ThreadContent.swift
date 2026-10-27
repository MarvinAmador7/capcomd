#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdBot

/// SPEC §4.5 thread content from the daemon's blocks/1 tree (thread-panel-v2, thread-states). Every string is agent-written
/// plain text: it goes into `Text(verbatim:)` or a plain `AttributedString(_:)` (never markdown), links act only on the
/// daemon's classification (LinkAction), and media loads through the daemon or, for remote media, only on a click.

/// Internal link URLs: a click on an agent or run link navigates; web links carry their own (checked http/https) URL.
enum ThreadLinkURL {
  static let scheme = "capcomd-thread"
  static func make(_ a: LinkAction) -> URL? {
    switch a {
    case .web(let u): return u
    case .agent(let id): return URL(string: "\(scheme)://agent/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
    case .run(let id): return URL(string: "\(scheme)://run/\(id.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? "")")
    case .file, .artifact, .none: return nil
    }
  }
}

/// Inline nodes → one AttributedString. Only typed attributes are set; the text is never parsed.
enum InlineText {
  static func make(_ xs: [Inline], font: Font, code: Font = Theme.Content.codeInlineFont) -> AttributedString {
    var out = AttributedString()
    for x in xs { out += piece(x, font: font, code: code, bold: false, italic: false, strike: false) }
    return out
  }
  static func piece(_ x: Inline, font: Font, code: Font, bold: Bool, italic: Bool, strike: Bool) -> AttributedString {
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
struct BlocksView: View {
  let runId: String
  let agentId: String
  let blocks: [Block]
  var font: Font = Theme.Content.proseFont
  var color: Color = Theme.Content.proseText
  var spacing: CGFloat = Theme.Content.proseSpacing
  /// Space under a paragraph: list items sit tight (`li` margins are 1 pt).
  var paragraphBottom: CGFloat = Theme.Content.proseBottom
  /// Margin already above the first block (the previous item's bottom margin). Vertical margins collapse as in the
  /// mockups' CSS: a heading sits max(that, 14) below what precedes it, not their sum.
  var leadingMargin: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(blocks.enumerated()), id: \.offset) { n, b in block(b, above: n == 0 ? leadingMargin : Self.bottomMargin(blocks[n - 1])) }
    }
  }

  /// The bottom margin each block leaves (what a following heading collapses with).
  static func bottomMargin(_ b: Block) -> CGFloat {
    switch b {
    case .code: Theme.Content.codeBottom
    case .table: Theme.Content.tableBottom
    case .rule: Theme.Content.ruleMargin
    case .heading: Theme.Content.headingBottom
    default: Theme.Content.proseBottom
    }
  }

  @ViewBuilder func block(_ b: Block, above: CGFloat) -> some View {
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

  func prose(_ k: [Inline]) -> some View {
    Text(InlineText.make(k, font: font)).foregroundStyle(color).lineSpacing(spacing).tint(Theme.Content.link)
      .textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
  }

  @ViewBuilder func marker(ordered: Bool, n: Int, checked: Bool?) -> some View {
    if let checked {
      Image(systemName: checked ? "checkmark.square" : "square").font(.system(size: 11)).foregroundStyle(checked ? Theme.accent : Theme.Content.listMarker)
    } else {
      Text(verbatim: ordered ? "\(n)." : "•").font(font).foregroundStyle(Theme.Content.listMarker)
    }
  }
}

struct CodeBlock: View {
  let lang: String?
  let text: String
  let truncatedLines: Int?
  @State private var copied = false

  var body: some View {
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

  static func highlighted(_ code: String, lang: String?) -> AttributedString {
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

struct TableBlock: View {
  let table: CapcomdThread.Table
  var body: some View {
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
  func alignment(_ c: Int) -> Alignment {
    switch c < table.align.count ? table.align[c] : nil { case .right?: .trailing; case .center?: .center; default: .leading }
  }
  func cell(_ k: [Inline], col: Int, font: Font) -> some View {
    Text(InlineText.make(k, font: font, code: Theme.Content.tdMono)).tint(Theme.Content.link).textSelection(.enabled)
      .multilineTextAlignment(alignment(col) == .trailing ? .trailing : .leading)
  }
}

/// Attachment and workspace images load through the daemon (png, jpeg, gif, webp only). Remote media and anything
/// that isn't an image show as a chip: a remote image loads only when clicked, and nothing else ever loads.
struct MediaBlockView: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String
  let media: Media
  @State private var remote: NSImage?
  @State private var remoteFailed = false

  var key: MediaKey? {
    guard media.kind == .image else { return nil }
    switch media.source {
    case .attachment(let id): return .attachment(runId: runId, id: id)
    case .workspace(let p): return .workspace(runId: runId, agentId: agentId, path: p)
    case .remote, .unknown: return nil
    }
  }

  var body: some View {
    if let key {
      switch model.media(key) {
      case .loaded(let d)?:
        if let img = NSImage(data: d) { picture(img) } else { chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: "couldn't be shown") }
      case .unavailable?: chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: "unavailable")
      case .loading?: chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: nil)
      case nil:
        chip(icon: "photo", text: media.alt.isEmpty ? "Image" : media.alt, note: nil).task { await model.loadMedia(key) }
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

  var icon: String { switch media.kind { case .image: "photo"; case .video: "film"; case .audio: "waveform"; case .file: "doc" } }
  var sourceNote: String? { if case .workspace(let p) = media.source { return p }; return nil }

  func picture(_ img: NSImage) -> some View {
    // Never larger than the image itself; scaled down to the column and the 180 pt cap.
    Image(nsImage: img).resizable().aspectRatio(contentMode: .fit)
      .frame(maxWidth: img.size.width, maxHeight: min(img.size.height, Theme.Content.mediaMaxHeight))
      .frame(maxWidth: .infinity, alignment: .leading)
      .clipShape(RoundedRectangle(cornerRadius: Theme.Content.mediaRadius, style: .continuous))
      .accessibilityLabel(media.alt.isEmpty ? "Image" : media.alt)
  }

  func chip(icon: String, text: String, note: String?) -> some View {
    HStack(spacing: Theme.Content.artGap) {
      Image(systemName: icon)
      Text(verbatim: text).lineLimit(1)
      if let note { Text(verbatim: note).foregroundStyle(Theme.Content.truncatedText).lineLimit(1) }
    }
    .font(Theme.Content.artFont).foregroundStyle(Theme.Content.artText).padding(Theme.Content.artPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.artRadius, style: .continuous).fill(Theme.Content.artFill))
  }

  /// Explicit click only: an ephemeral session, no cookies, http(s) only, at most 5 MB, raster images only.
  func loadRemote(_ s: String) async {
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
struct ThreadItemRow: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String
  let item: CapcomdThread.Item
  let next: CapcomdThread.Item?
  /// Bottom margin of the entry above (0 under a tool or thinking row): headings collapse with it.
  var above: CGFloat = 0

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      switch item.kind {
      case "say", "result":
        // A reviewer's message that ends in its verdict JSON: the prose, then the verdict as a card.
        if let tail = item.verdictTail {
          if !tail.prose.isEmpty { BlocksView(runId: runId, agentId: agentId, blocks: tail.prose, leadingMargin: above) }
          VerdictCard(runId: runId, agentId: agentId, verdict: tail.verdict)
        } else { blocks }
      case "thinking": ThinkingRow(runId: runId, agentId: agentId, item: item, seconds: item.thinkingSeconds(next: next))
      case "tool": ToolCallRow(item: item)
      case "plan":
        Text("Plan").font(Theme.Content.headingFont).foregroundStyle(Theme.Content.headingText)
          .padding(.top, max(0, Theme.Content.headingTop - above)).padding(.bottom, Theme.Content.headingBottom)
        blocks
      case "error":
        HStack(alignment: .firstTextBaseline, spacing: Theme.Content.toolGap) {
          Image(systemName: "xmark.circle").font(.system(size: 11))
          Text(verbatim: item.error?.message ?? item.text).textSelection(.enabled)
        }
        .font(Theme.Content.errorFont).foregroundStyle(Theme.Content.errorText).padding(.bottom, Theme.Content.proseBottom)
      case "handoff": HandoffCard(runId: runId, item: item)
      default:
        Text(verbatim: item.text).font(Theme.Content.otherFont).foregroundStyle(Theme.Content.otherText).padding(.bottom, Theme.Content.proseBottom)
      }
      if let t = item.truncated, t.blocks > 0 {
        Text("\(t.blocks) more \(t.blocks == 1 ? "block" : "blocks") not shown").font(Theme.Content.truncatedFont).foregroundStyle(Theme.Content.truncatedText)
          .padding(.bottom, Theme.Content.proseBottom)
      }
    }
  }

  /// A format this client doesn't know has no blocks: its plain text.
  @ViewBuilder var blocks: some View {
    if item.blocks.isEmpty {
      Text(verbatim: item.text).font(Theme.Content.proseFont).foregroundStyle(Theme.Content.proseText).lineSpacing(Theme.Content.proseSpacing)
        .textSelection(.enabled).padding(.bottom, Theme.Content.proseBottom)
    } else {
      BlocksView(runId: runId, agentId: agentId, blocks: item.blocks, leadingMargin: above)
    }
  }

  /// What this item leaves under itself: tool and thinking rows have no margin; prose ends with its last block's.
  static func bottomMargin(_ i: CapcomdThread.Item) -> CGFloat {
    switch i.kind {
    case "tool", "thinking": 0
    case "handoff": Theme.Content.handoffBottom
    default: i.blocks.last.map(BlocksView.bottomMargin) ?? Theme.Content.proseBottom
    }
  }
}

/// `.thk` / `.thb`: folded to "Thought for 8s"; a click unfolds the reasoning under a hairline.
struct ThinkingRow: View {
  let runId: String
  let agentId: String
  let item: CapcomdThread.Item
  let seconds: Int?
  @State private var open = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withAnimation(Theme.Motion.ease(reduceMotion)) { open.toggle() } } label: {
        HStack(spacing: Theme.Content.thinkGap) {
          Chevron(open: open)
          Text(verbatim: label)
        }
        .font(Theme.Content.thinkFont).foregroundStyle(Theme.Content.thinkText)
        .frame(height: Theme.Content.thinkHeight).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(item.redacted).accessibilityLabel(label)
      if open && !item.redacted {
        BlocksView(runId: runId, agentId: agentId, blocks: item.blocks, font: Theme.Content.thoughtFont, color: Theme.Content.thoughtText, spacing: Theme.Content.thoughtSpacing)
          .padding(.leading, Theme.Content.thoughtIndent)
          .overlay(alignment: .leading) { Rectangle().fill(Theme.Content.thoughtRule).frame(width: 1) }
          .padding(Theme.Content.thoughtMargin)
          .transition(.opacity)
      }
    }
  }

  var label: String {
    if item.open { return "Thinking…" }
    let base = seconds.map { "Thought for \($0)s" } ?? "Thought"
    return item.redacted ? "\(base) · hidden by the CLI" : base
  }
}

/// `.tc` / `.tx`: icon · summary · mono duration · chevron; a click shows Arguments and Result.
struct ToolCallRow: View {
  let item: CapcomdThread.Item
  @State private var open = false
  @State private var hover = false
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    if let tool = item.tool, let diff = tool.diff {
      DiffCard(diff: diff, failed: tool.isError, open: $open) { detail(tool) }
    } else { row }
  }

  /// A shell command reads as one (`>_`), whatever it runs, since the row shows the command itself; capcomd's own
  /// commands (spawn, wait, verify, merge…) and other tools keep their kind's icon.
  private func toolSymbol(_ tool: CapcomdThread.Item.Tool?) -> String {
    let shell: Set<String> = ["Bash", "BashOutput", "KillShell", "KillBash", "command_execution"]
    let capcomd: Set<String> = ["spawn", "wait", "message", "verify", "merge", "report", "delegate"]
    if let tool, shell.contains(tool.name), !capcomd.contains(tool.kind) { return "terminal" }
    return StepKind(activityKind: tool?.kind).symbol
  }

  var row: some View {
    let tool = item.tool
    return VStack(alignment: .leading, spacing: 0) {
      Button { withAnimation(Theme.Motion.ease(reduceMotion)) { open.toggle() } } label: {
        HStack(spacing: Theme.Content.toolGap) {
          Image(systemName: toolSymbol(tool)).font(.system(size: 11))
            .foregroundStyle(tool?.isError == true ? Theme.red : item.open ? Theme.accent : Theme.Content.label.opacity(0.6))
            .frame(width: Theme.Content.toolIcon)
          Text(verbatim: tool?.summary ?? item.text).lineLimit(1).truncationMode(.tail).frame(maxWidth: .infinity, alignment: .leading)
          if item.open {
            Image(systemName: "smallcircle.filled.circle").font(.system(size: 10)).foregroundStyle(Theme.accent).accessibilityLabel("Running")
          } else if let d = item.durationMs {
            Text(verbatim: callDuration(ms: d)).font(Theme.Content.toolDuration).foregroundStyle(Theme.Content.toolDurationText)
          }
          Chevron(open: open).frame(width: Theme.Content.toolChevron)
        }
        .font(Theme.Content.toolFont).foregroundStyle(tool?.isError == true ? Theme.Content.errorText : Theme.Content.toolText)
        .frame(height: Theme.Content.toolHeight).padding(.horizontal, Theme.Content.toolInset)
        .background(RoundedRectangle(cornerRadius: Theme.Content.toolRadius, style: .continuous).fill(hover ? Theme.Content.toolHover : .clear))
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain).onHover { hover = $0 }
      .padding(.horizontal, -Theme.Content.toolInset)
      .accessibilityLabel(tool?.summary ?? item.text)
      if open, let tool { detail(tool).transition(.opacity) }
    }
  }

  func detail(_ t: CapcomdThread.Item.Tool) -> some View {
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

  func section(_ label: String, _ text: String, first: Bool) -> some View {
    VStack(alignment: .leading, spacing: Theme.Content.detailLabelGap) {
      Text(label).font(Theme.Content.detailLabel).foregroundStyle(Theme.Content.detailLabelText)
      Text(verbatim: Self.clip(text)).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
    }
    .padding(.top, first ? 0 : Theme.Content.detailSectionGap)
  }

  /// Long results keep their last lines (the daemon keeps the end too).
  static func clip(_ s: String) -> String {
    let lines = s.split(separator: "\n", omittingEmptySubsequences: false)
    guard lines.count > Theme.Content.detailMaxLines else { return s }
    return "… \(lines.count - Theme.Content.detailMaxLines) earlier lines\n" + lines.suffix(Theme.Content.detailMaxLines).joined(separator: "\n")
  }
}

/// `.df`: an edit as a diff card: pencil · path · `+n −n`, then its first lines (context, removed red, added green; `@`
/// gaps as a faint hunk header). A click on the header shows the call's arguments and result. A failed edit is dimmed.
struct DiffCard<Detail: View>: View {
  let diff: CapcomdThread.Item.Diff
  let failed: Bool
  @Binding var open: Bool
  @ViewBuilder let detail: () -> Detail
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      VStack(alignment: .leading, spacing: 0) {
        Button { withAnimation(Theme.Motion.ease(reduceMotion)) { open.toggle() } } label: {
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

  @ViewBuilder func line(_ l: CapcomdThread.Item.Diff.Line) -> some View {
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

/// `.ho`: a child that finished: profile icon, name + suffix, "handed back", its summary and artifacts; › opens its thread.
/// A reviewer's verdict (its message was `{"passed", "reasons"}`) as a card instead of raw JSON: the reviewer's bot, a
/// green or red seal with "Passed review" / "Didn't pass review", then each reason. An identity moment: the bot cheers
/// with a happy face when the work passes (as in the run-finished moment) and makes its "oops" face when it doesn't;
/// the face is the bot's own, nothing is drawn on it. The reasons are agent text, shown as plain text.
struct VerdictCard: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String
  let verdict: Verdict
  private var face: BotTraits? {
    guard let t = model.bot(runId: runId, agentId: agentId) else { return nil }
    return verdict.passed ? ((try? withOverrides(t, mood: .happy, pose: "cheer")) ?? (try? withOverrides(t, mood: .happy)) ?? t)
                          : ((try? withOverrides(t, mood: .oops)) ?? t)
  }
  var body: some View {
    VStack(alignment: .leading, spacing: Theme.Content.verdictGap) {
      HStack(spacing: Theme.Content.handoffGap) {
        if let face { BotAvatar(traits: face, size: .small).accessibilityHidden(true) }
        Image(systemName: verdict.passed ? "checkmark.seal.fill" : "xmark.seal.fill").font(Theme.Content.verdictIcon)
          .foregroundStyle(verdict.passed ? Theme.green : Theme.red)
        Text(verdict.passed ? "Passed review" : "Didn't pass review").font(Theme.Content.handoffName).foregroundStyle(.white)
      }
      if !verdict.reasons.isEmpty {
        VStack(alignment: .leading, spacing: Theme.Content.verdictReasonGap) {
          ForEach(Array(verdict.reasons.enumerated()), id: \.offset) { _, r in
            HStack(alignment: .firstTextBaseline, spacing: Theme.Content.handoffGap) {
              Text(verbatim: "•").foregroundStyle(Theme.Content.verdictBullet).accessibilityHidden(true)
              Text(verbatim: r).foregroundStyle(Theme.Content.handoffSummaryText).textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
            }
            .font(Theme.Content.handoffSummary)
          }
        }
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(Theme.Content.handoffPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.handoffRadius, style: .continuous).fill(Theme.Content.handoffFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.Content.handoffRadius, style: .continuous).strokeBorder(Theme.Content.handoffStroke, lineWidth: 0.5))
    .padding(.bottom, Theme.Content.handoffBottom)
    .accessibilityElement(children: .combine)
  }
}

struct HandoffCard: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let item: CapcomdThread.Item

  var body: some View {
    let childId = item.child?.agentId
    let child = childId.flatMap { model.run(runId)?.agents[$0] }
    Button { if let childId { model.path.append(.thread(runId: runId, agentId: childId)) } } label: {
      VStack(alignment: .leading, spacing: 0) {
        HStack(spacing: Theme.Content.handoffGap) {
          ProvidedBot(traits: childId.flatMap { model.bot(runId: runId, agentId: $0) }, size: .small,
                      provider: childId.flatMap { model.provider(runId: runId, agentId: $0)?.provider })
          // The bot's name leads; the role joins the note ("worker · handed back").
          let role = child?.displayName ?? "Agent", name = childId.flatMap { model.botName(runId: runId, agentId: $0) }
          Text(verbatim: name ?? role).font(Theme.Content.handoffName).foregroundStyle(.white)
          let note = item.child?.status == "failed" ? "failed" : "handed back"
          Text(verbatim: name == nil ? note : "\(role) · \(note)")
            .font(Theme.Content.handoffNote).foregroundStyle(Theme.Content.handoffNoteText)
          Spacer(minLength: 0)
          Chevron(open: false)
        }
        let (summary, artifacts) = Self.split(item.blocks)
        BlocksView(runId: runId, agentId: childId ?? "", blocks: summary, font: Theme.Content.handoffSummary,
                   color: Theme.Content.handoffSummaryText, spacing: Theme.Content.handoffSummarySpacing)
          .padding(Theme.Content.handoffSummaryMargin).padding(.bottom, -Theme.Content.proseBottom)
        if !artifacts.isEmpty {
          HStack(spacing: Theme.Content.artGap) { ForEach(Array(artifacts.enumerated()), id: \.offset) { _, l in ArtifactChip(link: l) } }
        }
      }
      .multilineTextAlignment(.leading)
      .padding(Theme.Content.handoffPadding)
      .background(RoundedRectangle(cornerRadius: Theme.Content.handoffRadius, style: .continuous).fill(Theme.Content.handoffFill))
      .overlay(RoundedRectangle(cornerRadius: Theme.Content.handoffRadius, style: .continuous).strokeBorder(Theme.Content.handoffStroke, lineWidth: 0.5))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain).disabled(childId == nil)
    .padding(.bottom, Theme.Content.handoffBottom)
  }

  /// The daemon puts a handoff's artifacts last, as a list of one-link items (handoffDraft): those become `.art` chips.
  static func split(_ blocks: [Block]) -> ([Block], [CapcomdThread.Link]) {
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
struct ArtifactChip: View {
  let link: CapcomdThread.Link
  var body: some View {
    HStack(spacing: Theme.Content.artGap) {
      Image(systemName: icon).font(.system(size: 9))
      Text(verbatim: link.text).lineLimit(1).truncationMode(.middle)
    }
    .font(Theme.Content.artFont).foregroundStyle(Theme.Content.artText).padding(Theme.Content.artPadding)
    .background(RoundedRectangle(cornerRadius: Theme.Content.artRadius, style: .continuous).fill(Theme.Content.artFill))
    .help(link.destination ?? link.path ?? link.text)
  }
  var icon: String {
    switch link.target {
    case .web: "globe"; case .agent: "hexagon"; case .run: "point.3.connected.trianglepath.dotted"; case .artifact: "paperclip"
    case .file: "doc"; case .none: link.text.hasSuffix("/") ? "folder" : "doc"
    }
  }
}

/// The 9 pt chevron of `.thk` / `.tc` (32 %), turned down when open.
struct Chevron: View {
  let open: Bool
  var body: some View {
    Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.Content.label.opacity(0.32))
      .rotationEffect(.degrees(open ? 90 : 0))
  }
}
#endif
