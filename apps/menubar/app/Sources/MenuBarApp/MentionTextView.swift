#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdBot
import CapcomdStore

/// The thread composer's text (SPEC §4.6): an NSTextView in which an @ mention is one inline pill, the agent's bot and
/// its name, that the caret steps over and Delete removes whole. SwiftUI's TextEditor can't hold views, hence AppKit.
/// `text` mirrors the content as plain text with U+FFFC for each pill and `beforeCaret` the part before the caret (where
/// the @ or / token being typed lives); `body()` spells pills as their handles.
@MainActor final class ComposerText {
  typealias Mention = SteerMentions.Mention
  fileprivate weak var view: ComposerNSTextView?

  func focus() { if let v = view { v.window?.makeFirstResponder(v) } }
  func unfocus() { if let v = view, v.window?.firstResponder === v { v.window?.makeFirstResponder(nil) } }

  /// Types `s` at the caret, as if the user had.
  func insert(_ s: String) { replace(view?.selectedRange() ?? NSRange(location: 0, length: 0), with: NSAttributedString(string: s, attributes: ComposerNSTextView.base)) }

  /// Replaces the `length` characters before the caret (the typed "@que") with a pill and a space, or with nothing.
  func replaceTokenBeforeCaret(length: Int, with mention: Mention?, label: String = "", bot: BotTraits? = nil) {
    guard let v = view else { return }
    let caret = v.selectedRange().location, n = min(length, caret)
    let pill = NSMutableAttributedString()
    if let mention {
      pill.append(NSAttributedString(attachment: MentionAttachment(mention, label: label, bot: bot)))
      pill.append(NSAttributedString(string: " "))
      pill.addAttributes(ComposerNSTextView.base, range: NSRange(location: 0, length: pill.length))
    }
    replace(NSRange(location: caret - n, length: n), with: pill)
  }

  func clear() { guard let v = view else { return }; replace(NSRange(location: 0, length: v.textStorage?.length ?? 0), with: NSAttributedString()) }

  /// What the agent reads: pills become their handles ("@worker-4423"); SteerMentions adds the line naming them.
  func body() -> String {
    guard let s = view?.textStorage else { return "" }
    var out = ""
    s.enumerateAttribute(.attachment, in: NSRange(location: 0, length: s.length)) { value, range, _ in
      if let m = value as? MentionAttachment { out += m.mention.handle } else { out += (s.string as NSString).substring(with: range) }
    }
    return out
  }

  /// The agents the pills point at, in order, once each.
  func mentions() -> [Mention] {
    guard let s = view?.textStorage else { return [] }
    var out: [Mention] = []
    s.enumerateAttribute(.attachment, in: NSRange(location: 0, length: s.length)) { value, _, _ in
      if let m = (value as? MentionAttachment)?.mention, !out.contains(m) { out.append(m) }
    }
    return out
  }

  private func replace(_ range: NSRange, with s: NSAttributedString) {
    guard let v = view, let storage = v.textStorage, v.shouldChangeText(in: range, replacementString: s.string) else { return }
    storage.replaceCharacters(in: range, with: s)
    v.setSelectedRange(NSRange(location: range.location + s.length, length: 0))
    v.typingAttributes = ComposerNSTextView.base
    v.didChangeText()
  }
}

/// A mention pill: a capsule with the bot (14 pt, pixel-exact) and the bot's name. The composer and your sent bubbles
/// draw the same one.
@MainActor enum MentionPill {
  static func image(label: String, bot: BotTraits?) -> NSImage {
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
  static func baseline(textSize size: CGFloat) -> CGFloat { ((NSFont.systemFont(ofSize: size).capHeight - Theme.Thread.pillHeight) / 2).rounded() }
}

/// One mention in the composer's text: the pill as a single character, carrying who it points at.
final class MentionAttachment: NSTextAttachment {
  let mention: ComposerText.Mention

  @MainActor init(_ mention: ComposerText.Mention, label: String, bot: BotTraits?) {
    self.mention = mention
    super.init(data: nil, ofType: nil)
    let img = MentionPill.image(label: label, bot: bot)
    image = img
    bounds = CGRect(x: 0, y: MentionPill.baseline(textSize: Theme.Thread.inputFontSize), width: img.size.width, height: img.size.height)
  }

  required init?(coder: NSCoder) { fatalError("not coded") }
}

final class ComposerNSTextView: NSTextView {
  var onFocus: ((Bool) -> Void)?
  var onCommand: ((ComposerTextView.Command) -> Bool)?

  @MainActor static var base: [NSAttributedString.Key: Any] {
    let p = NSMutableParagraphStyle(); p.lineSpacing = Theme.Thread.lineSpacing
    return [.font: NSFont.systemFont(ofSize: Theme.Thread.inputFontSize), .foregroundColor: NSColor(Theme.Thread.inputText), .paragraphStyle: p]
  }

  override func becomeFirstResponder() -> Bool { let ok = super.becomeFirstResponder(); if ok { onFocus?(true) }; return ok }
  override func resignFirstResponder() -> Bool { let ok = super.resignFirstResponder(); if ok { onFocus?(false) }; return ok }
  // Pills come only from the mention list; anything pasted or dropped arrives as plain text.
  override func paste(_ sender: Any?) { pasteAsPlainText(sender) }
  override var readablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }
  override var acceptableDragTypes: [NSPasteboard.PasteboardType] { [.string] }
}

struct ComposerTextView: NSViewRepresentable {
  enum Command { case send, up, down, tab, escape }
  @Binding var text: String
  @Binding var beforeCaret: String
  @Binding var focused: Bool
  let controller: ComposerText
  let accessibilityLabel: String
  /// Return true when the composer handled the key; false lets the text view do its default.
  let onCommand: (Command) -> Bool

  func makeCoordinator() -> Coordinator { Coordinator(self) }

  func makeNSView(context: Context) -> NSScrollView {
    let scroll = NSScrollView()
    scroll.drawsBackground = false
    scroll.hasVerticalScroller = false
    scroll.hasHorizontalScroller = false
    scroll.verticalScrollElasticity = .none
    let tv = ComposerNSTextView(usingTextLayoutManager: false)
    tv.isRichText = true   // attachments; paste stays plain (above)
    tv.importsGraphics = false
    tv.usesFontPanel = false
    tv.allowsUndo = true
    tv.drawsBackground = false
    tv.textContainerInset = NSSize(width: 0, height: Theme.Thread.inputInset)
    tv.textContainer?.lineFragmentPadding = 0
    tv.textContainer?.widthTracksTextView = true
    tv.isVerticallyResizable = true
    tv.isHorizontallyResizable = false
    tv.autoresizingMask = [.width]
    tv.isAutomaticQuoteSubstitutionEnabled = false
    tv.isAutomaticDashSubstitutionEnabled = false
    tv.typingAttributes = ComposerNSTextView.base
    tv.defaultParagraphStyle = ComposerNSTextView.base[.paragraphStyle] as? NSParagraphStyle
    tv.insertionPointColor = .white
    tv.delegate = context.coordinator
    tv.onFocus = { f in DispatchQueue.main.async { if context.coordinator.parent.focused != f { context.coordinator.parent.focused = f } } }
    tv.onCommand = { context.coordinator.parent.onCommand($0) }
    tv.setAccessibilityLabel(accessibilityLabel)
    scroll.documentView = tv
    controller.view = tv
    return scroll
  }

  func updateNSView(_ scroll: NSScrollView, context: Context) {
    context.coordinator.parent = self
    guard let tv = scroll.documentView as? ComposerNSTextView else { return }
    controller.view = tv
    tv.isEditable = context.environment.isEnabled
    tv.setAccessibilityLabel(accessibilityLabel)
  }

  /// 1…6 lines tall for the width offered; past that the text scrolls.
  func sizeThatFits(_ proposal: ProposedViewSize, nsView scroll: NSScrollView, context: Context) -> CGSize? {
    _ = text   // re-measure on every edit
    guard let tv = scroll.documentView as? NSTextView, let lm = tv.layoutManager, let tc = tv.textContainer else { return nil }
    let width = proposal.width ?? scroll.frame.width
    tc.containerSize = NSSize(width: width, height: .greatestFiniteMagnitude)
    lm.ensureLayout(for: tc)
    let inset = Theme.Thread.inputInset * 2
    let used = lm.usedRect(for: tc).height + inset
    let line = Theme.Thread.inputLine
    return CGSize(width: width, height: min(max(used, line + inset), line * CGFloat(Theme.Thread.inputMaxLines) + inset).rounded(.up))
  }

  @MainActor final class Coordinator: NSObject, NSTextViewDelegate {
    var parent: ComposerTextView
    init(_ parent: ComposerTextView) { self.parent = parent }

    func textDidChange(_ n: Notification) {
      guard let tv = n.object as? NSTextView else { return }
      parent.text = tv.string
      publishCaret(tv)
    }
    func textViewDidChangeSelection(_ n: Notification) { if let tv = n.object as? NSTextView { publishCaret(tv) } }
    private func publishCaret(_ tv: NSTextView) {
      let s = tv.string as NSString, before = s.substring(to: min(tv.selectedRange().location, s.length))
      if parent.beforeCaret != before { parent.beforeCaret = before }
    }

    func textView(_ tv: NSTextView, doCommandBy sel: Selector) -> Bool {
      switch sel {
      case #selector(NSResponder.insertNewline(_:)):
        if NSApp.currentEvent?.modifierFlags.contains(.shift) == true { return false }   // ⇧Return: a new line
        return parent.onCommand(.send)
      case #selector(NSResponder.moveUp(_:)): return parent.onCommand(.up)
      case #selector(NSResponder.moveDown(_:)): return parent.onCommand(.down)
      case #selector(NSResponder.insertTab(_:)): return parent.onCommand(.tab)
      case #selector(NSResponder.cancelOperation(_:)): return parent.onCommand(.escape)
      default: return false   // ⌥Return (insertNewlineIgnoringFieldEditor) adds a line too
      }
    }
  }
}
#endif
