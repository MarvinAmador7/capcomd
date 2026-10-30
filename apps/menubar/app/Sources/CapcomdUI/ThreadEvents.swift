#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdBot

// Thread rows built from events (older daemons, steers, messages between agents), the task row, and the operator's
// own bubbles: shared by the menu bar and the desktop app. Navigation and bots go through the ThreadHost.

/// Untrusted text with `[REDACTED]` markers dimmed. Every piece is still `Text(verbatim:)`: no markdown, no links.
package struct RedactableText: View {
  package let text: UntrustedText
  package init(text: UntrustedText) { self.text = text }
  package var body: some View {
    text.segments.reduce(Text(verbatim: "")) { acc, seg in
      switch seg {
      case .text(let s): return acc + Text(verbatim: s)
      case .redacted: return acc + Text(verbatim: "[REDACTED]").foregroundStyle(.tertiary)
      }
    }
  }
}

/// SPEC §4.5 agent thread (thread-panel-v2): header, then the agent's thread (the daemon's structured items, harness #59,
/// with your steers between them; against an older daemon, the event-built lines), then the composer. Agent text is
/// never markdown, links or actions beyond what the daemon classified (ThreadContent.swift).
/// The agent's task, folded by default like a thought: "› Task" and its first line; a click shows all of it.
package struct TaskRow: View {
  package let task: UntrustedText
  package init(task: UntrustedText) { self.task = task }
  @State private var open = false

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: {   // snaps: the panel resizes to fit (SPEC §7)
        HStack(spacing: Theme.Content.thinkGap) {
          Chevron(open: open)
          Text("Task")
          if !open { RedactableText(text: UntrustedText(task.firstLine)).foregroundStyle(Theme.Content.taskPreviewText).lineLimit(1) }
        }
        .font(Theme.Content.thinkFont).foregroundStyle(Theme.Content.thinkText)
        .frame(height: Theme.Content.thinkHeight).contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(open ? "Task, shown" : "Task: \(task.firstLine)").accessibilityHint(open ? "Hides the task" : "Shows the whole task")
      if open {
        RedactableText(text: task).font(Theme.Content.thoughtFont).foregroundStyle(Theme.Content.thoughtText)
          .lineSpacing(Theme.Content.thoughtSpacing).textSelection(.enabled)
          .padding(.leading, Theme.Content.thoughtIndent)
          .overlay(alignment: .leading) { Rectangle().fill(Theme.Content.thoughtRule).frame(width: 1) }
          .padding(Theme.Content.thoughtMargin)
          .transition(.opacity)
      }
    }
    .padding(.bottom, Theme.Content.proseBottom)
  }
}

package struct ThreadItemView: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let agentId: String
  package let item: ThreadItem
  package init(runId: String, agentId: String, item: ThreadItem) { self.runId = runId; self.agentId = agentId; self.item = item }
  package var body: some View {
    switch item.kind {
    case .status(let s):
      Text(verbatim: s).font(Theme.chip).foregroundStyle(.tertiary)
    case .notice(let kind, let detail):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "wrench").foregroundStyle(.secondary).font(.system(size: 11))
        Text(verbatim: kind).font(Theme.monoTime).foregroundStyle(.tertiary)
        RedactableText(text: detail).font(Theme.body)
      }
    case .checkpoint(let reason, let files):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary).font(.system(size: 11))
        RedactableText(text: reason).font(Theme.body)
        if let f = files { Text(verbatim: "\(f) files").font(Theme.monoTime).foregroundStyle(.tertiary) }
      }
    case .steer(let bytes):
      HStack { Spacer()
        Text(verbatim: bytes.map { "Message sent (\($0) bytes)" } ?? "Message sent").font(Theme.body)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.07)))
      }
    case .message(let from, _, let text, _) where from == "operator" && text != nil:
      SteerBubble(runId: runId, text: text!.plain)   // the operator's own words, right-aligned (.me)
    case .message(let from, let to, let text, let attachment):
      let outgoing = from == agentId
      HStack { if outgoing { Spacer() }
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
          Text(verbatim: outgoing ? "to \(to)" : "from \(from)").font(Theme.monoTime).foregroundStyle(.tertiary)
          if let t = text { RedactableText(text: t).font(Theme.body).textSelection(.enabled) }
          if let a = attachment { Text(verbatim: a.label).font(Theme.chip).foregroundStyle(.tertiary) }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(outgoing ? 0.07 : 0.04)))
        if !outgoing { Spacer() }
      }
    case .handoff(let childId, let name, let summary, let artifacts):
      Button { host?.host.openAgent(runId: runId, agentId: childId) } label: {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            Text(verbatim: name).font(Theme.body.weight(.semibold))
            Text("handed back").font(Theme.chip).foregroundStyle(.tertiary)
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
          }
          if let s = summary { RedactableText(text: s).font(Theme.body).foregroundStyle(.primary.opacity(0.88)).multilineTextAlignment(.leading) }
          if !artifacts.isEmpty {
            HStack(spacing: 4) { ForEach(artifacts, id: \.self) { Chip(text: $0.plain) } }
          }
        }
        .padding(Theme.cardPadding)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.cardFill))
      }
      .buttonStyle(.plain)
    }
  }
}

/// `.me`: a steer to this agent, right-aligned. Pending ones show sending (dimmed) or failed (Retry · Discard).
package struct SteerBubble: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let text: String
  package var state: PendingSteer.State? = nil
  package var onRetry: (() -> Void)? = nil
  package var onDiscard: (() -> Void)? = nil
  package init(runId: String, text: String, state: PendingSteer.State? = nil, onRetry: (() -> Void)? = nil, onDiscard: (() -> Void)? = nil) { self.runId = runId; self.text = text; self.state = state; self.onRetry = onRetry; self.onDiscard = onDiscard }
  package var body: some View {
    let sending = state == .sending
    let failure: String? = { if case .failed(let m) = state { return m }; return nil }()
    HStack {
      Spacer(minLength: 0)
      VStack(alignment: .trailing, spacing: 4) {
        shown   // what the operator typed, with its mentions as pills again
          .font(Theme.Thread.bubbleFont).foregroundStyle(Theme.Thread.bubbleText)
          .lineSpacing(Theme.Thread.lineSpacing)
          .padding(Theme.Thread.bubblePadding)
          .background(UnevenRoundedRectangle(topLeadingRadius: Theme.Thread.bubbleRadius, bottomLeadingRadius: Theme.Thread.bubbleRadius,
                                             bottomTrailingRadius: Theme.Thread.bubbleTail, topTrailingRadius: Theme.Thread.bubbleRadius)
            .fill(Theme.Thread.bubbleFill))
          .opacity(sending ? Theme.Thread.bubbleSendingOpacity : 1)
          .textSelection(.enabled)
        if let failure {
          HStack(spacing: 8) {
            Text(verbatim: failure).foregroundStyle(Theme.red)
            if let onRetry { Button("Retry", action: onRetry).buttonStyle(.plain).foregroundStyle(Theme.accent) }
            if let onDiscard { Button("Discard", action: onDiscard).buttonStyle(.plain).foregroundStyle(Theme.Thread.writingText) }
          }
          .font(Theme.Thread.bubbleNoteFont)
        }
      }
      .containerRelativeFrame(.horizontal, alignment: .trailing) { w, _ in w * Theme.Thread.bubbleMaxWidth }
    }
    .padding(Theme.Thread.bubbleMargin)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("You: \(text)" + (sending ? ", sending" : "") + (failure.map { ", not sent: \($0)" } ?? ""))
  }

  /// Hide the line naming the mentioned agents (SteerMentions) and draw each handle it names as its pill; anything
  /// else shows as typed.
  private var shown: Text {
    let (visible, mentions) = SteerMentions.parse(text)
    guard !mentions.isEmpty else { return Text(verbatim: text) }
    let agents = Dictionary(mentions.map { ($0.handle, $0.agentId) }, uniquingKeysWith: { a, _ in a })
    let handles = agents.keys.sorted { $0.count > $1.count }
    var out = Text(verbatim: ""), rest = Substring(visible)
    while !rest.isEmpty {
      let hit = handles.compactMap { h in rest.range(of: h).map { (h, $0) } }.min { $0.1.lowerBound < $1.1.lowerBound }
      guard let (h, r) = hit else { out = out + Text(verbatim: String(rest)); break }
      let id = agents[h]!
      let pill = MentionPill.image(label: host?.host.bot(runId: runId, agentId: id)?.name ?? String(h.dropFirst()), bot: host?.host.bot(runId: runId, agentId: id))
      out = out + Text(verbatim: String(rest[..<r.lowerBound]))
        + Text(Image(nsImage: pill)).baselineOffset(MentionPill.baseline(textSize: Theme.Thread.bubbleFontSize))
      rest = rest[r.upperBound...]
    }
    return out
  }

}

/// A mention pill: a capsule with the bot (14 pt, pixel-exact) and the bot's name. The composer and your sent bubbles
/// draw the same one.
@MainActor package enum MentionPill {
  package static func image(label: String, bot: BotTraits?) -> NSImage {
    let font = NSFont.systemFont(ofSize: Theme.Thread.pillFontSize, weight: .medium)
    let text = NSAttributedString(string: label, attributes: [.font: font, .foregroundColor: NSColor(Theme.Thread.pillText)])
    let botImage = bot.flatMap { BotImages.image($0, size: .xs) }
    let h = Theme.Thread.pillHeight, side = CGFloat(BotAvatar.cells(.xs))
    let lead = botImage == nil ? Theme.Thread.pillTrailing : Theme.Thread.pillLeading + side + Theme.Thread.pillGap
    let w = (lead + text.size().width + Theme.Thread.pillTrailing).rounded(.up)
    let fill = NSColor(Theme.Thread.pillFill), stroke = NSColor(Theme.Thread.pillStroke)
    let img = NSImage(size: NSSize(width: w, height: h), flipped: false) { r in
      let shape = NSBezierPath(roundedRect: r.insetBy(dx: 0.25, dy: 0.25), xRadius: h / 2, yRadius: h / 2)
      fill.setFill(); shape.fill()
      stroke.setStroke(); shape.lineWidth = 0.5; shape.stroke()
      if let botImage {
        NSGraphicsContext.current?.imageInterpolation = .none
        botImage.draw(in: NSRect(x: Theme.Thread.pillLeading, y: ((h - side) / 2).rounded(), width: side, height: side))
      }
      let ts = text.size()
      text.draw(at: NSPoint(x: lead, y: ((h - ts.height) / 2).rounded()))
      return true
    }
    img.accessibilityDescription = label
    return img
  }

  /// How far below the baseline the pill starts, centring it on the cap height of text at `size`.
  package static func baseline(textSize size: CGFloat) -> CGFloat { ((NSFont.systemFont(ofSize: size).capHeight - Theme.Thread.pillHeight) / 2).rounded() }
}
#endif
