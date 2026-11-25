#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// A question an agent asked and stopped on (capability agents.ask), docked at its column's foot above its message box
/// (DurableAsked-v3, which wins on measurements): who asked whom, the question, then what waits on it (or that its work
/// is saved), the numbered options with the recommended one tagged and its reason under it (one muted line, two then
/// "more"), "Something else…" (the box below takes a free answer), and Answer ↵. Keys 1…n pick an option and Return
/// answers, only while its column has focus and no text field takes the keys (`DeskModel.returnApproves`), as the
/// decision bar's Return. Asked of an agent, the card is neutral and says the agent may answer; asked of you, the
/// column's amber ring says so. Once answered it goes, and the thread keeps its one line (AnsweredLine).
///
/// The same card, not a copy, is what another agent's thread shows for the question (QuestionLine): in a popover from
/// its line's Answer, or in place of the line in the run's root thread when the question is the user's.
struct QuestionCard: View {
  /// Where the card is: docked at the asker's column foot, in a thread in place of a line (the root's, for you), or in
  /// the popover from a line's Answer (`done` closes it once answered, or when Something else… hands over to the box).
  enum Placement {
    case docked, inline
    case popover(done: () -> Void)
    var isPopover: Bool { if case .popover = self { return true }; return false }
  }
  @Environment(DeskModel.self) private var model
  @Environment(\.deskPane) private var inPane
  @Environment(\.needsReel) private var inNeeds
  @Environment(\.paneState) private var pane
  let card: QuestionCardModel
  let focused: Bool
  var placement: Placement = .docked
  /// The option picked (0: the recommended one, first); `options.count`: Something else….
  @State private var picked = 0
  @State private var whyOpen = false

  var body: some View {
    DeskProbe.body("QuestionCard", id: card.askerId)
    let expanded = inPane && pane?.expanded == true
    // In a popover the card has the keys to itself while it is up.
    let keys = !card.sending && (placement.isPopover || focused && model.returnApproves && (model.needs.isOpen ? inNeeds : !inNeeds && model.nav.sidebarOpen == inPane))
    return VStack(alignment: .leading, spacing: 6) {
      who
      Text(verbatim: card.question.plain).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.AskCard.t1)
        .lineSpacing(5).fixedSize(horizontal: false, vertical: true)
      if let h = card.holds {
        (Text(verbatim: "Waiting on this: ").foregroundStyle(Theme.AskCard.t3) + Text(verbatim: h.plain).foregroundStyle(Theme.AskCard.t2))
          .font(.system(size: 12)).lineSpacing(4).fixedSize(horizontal: false, vertical: true)
      } else {
        Text(verbatim: QuestionCardModel.saved).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t2).lineSpacing(4)
          .fixedSize(horizontal: false, vertical: true)
      }
      VStack(alignment: .leading, spacing: 4) {
        ForEach(Array(card.options.enumerated()), id: \.offset) { i, o in
          option(i, label: o.label.plain, recommended: o.recommended, muted: false)
          if o.recommended, let w = card.why { why(w.plain) }
        }
        option(card.options.count, label: "Something else…", recommended: false, muted: true)
      }
      .padding(.top, 6)
      HStack(spacing: 8) {
        if let h = card.hint { Text(verbatim: h).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3).lineLimit(2) }
        Spacer(minLength: 0)
        Button(action: answer) {
          HStack(spacing: 6) { Text("Answer"); Text("↵").font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.12))) }
        }
        .buttonStyle(DeskButton(kind: .primary))
        .keyboardShortcut(keys ? .defaultAction : nil)
        .disabled(card.sending).opacity(card.sending ? 0.5 : 1)
      }
      .padding(.top, 8)
    }
    // Keys 1…n (and n+1, Something else…) pick an option.
    .background {
      if keys {
        ForEach(0...min(card.options.count, 8), id: \.self) { i in
          Button("") { picked = i }.keyboardShortcut(KeyEquivalent(Character("\(i + 1)")), modifiers: []).frame(width: 0, height: 0).opacity(0)
            .accessibilityHidden(true)
        }
      }
    }
    .padding(.horizontal, 16).padding(.vertical, 14)
    .frame(maxWidth: inPane && !placement.isPopover ? (expanded ? PaneMetrics.reading : Theme.Desk.paneReading) : .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Theme.AskCard.card))
    .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.AskCard.line, lineWidth: 0.5))
    .modifier(CardPlacement(placement: placement, expanded: expanded, inPane: inPane))
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Question from \(card.askerName)")
  }

  /// "request limiter  worker · asked planner", with its bot.
  private var who: some View {
    HStack(spacing: 6) {
      if let b = model.agent(card.askerId)?.bot { BotAvatar(traits: b, size: .xs).frame(width: 16, height: 16) }
      Text(verbatim: card.askerName).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.AskCard.t1).lineLimit(1)
      Text(verbatim: card.whoLine).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3).lineLimit(1)
    }
    .padding(.bottom, 2)
  }

  /// One option: its key, its words, "Recommended" on the advised one; the picked one is lit.
  private func option(_ i: Int, label: String, recommended: Bool, muted: Bool) -> some View {
    let sel = picked == i
    return Button { picked = i; if muted { somethingElse() } } label: {
      HStack(spacing: 10) {
        Text(verbatim: "\(i + 1)").font(.system(size: 11, weight: .medium).monospacedDigit()).foregroundStyle(Theme.AskCard.t2)
          .frame(minWidth: 18, minHeight: 18).background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Theme.AskCard.kbdFill))
        Text(verbatim: label).font(.system(size: 13)).foregroundStyle(muted ? Theme.AskCard.t3 : Theme.AskCard.t1).lineLimit(1).truncationMode(.tail)
        Spacer(minLength: 0)
        if recommended {
          Text("Recommended").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.AskCard.t2)
            .padding(.horizontal, 6).frame(height: 18).background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.AskCard.kbdFill))
        }
      }
      .padding(.horizontal, 10).frame(height: 40)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(sel ? Theme.AskCard.selected : .clear))
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(sel ? Theme.AskCard.strong : Theme.AskCard.line, lineWidth: 0.5))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(recommended ? "\(label), recommended" : label)
    .accessibilityHint(card.why.flatMap { recommended ? $0.plain : nil } ?? "")
    .accessibilityAddTraits(sel ? .isSelected : [])
  }

  /// The recommended option's reason: one muted line under it, two lines then "more".
  private func why(_ text: String) -> some View {
    HStack(alignment: .lastTextBaseline, spacing: 6) {
      Text(verbatim: text).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t2).lineSpacing(5)
        .lineLimit(whyOpen ? nil : 2).frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
      if !whyOpen && text.count > 120 {
        Button("more") { whyOpen = true }.buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3)
          .accessibilityLabel("Show the whole reason")
      }
    }
    .padding(.leading, 38).padding(.trailing, 10).padding(.top, 2).padding(.bottom, 4)
    .accessibilityHidden(true)
  }

  /// Answer with the picked option; Something else… hands over to the message box below (its message is the answer).
  private func answer() {
    guard picked < card.options.count else { somethingElse(); return }
    model.answer(card, with: card.options[picked].label.plain)
    if case .popover(let done) = placement { done() }
  }
  private func somethingElse() {
    if case .popover(let done) = placement { done() }
    model.focusBox(card.askerId)
  }
}

/// The card's margins where it is: docked, its column's inset above the box; in a thread, the thread's own; in a
/// popover, the popover's.
private struct CardPlacement: ViewModifier {
  let placement: QuestionCard.Placement
  let expanded: Bool
  let inPane: Bool
  func body(content: Content) -> some View {
    switch placement {
    case .docked: content.padding(.horizontal, expanded ? 20 : 12).padding(.top, 4).padding(.bottom, inPane ? 8 : 0).frame(maxWidth: .infinity)
    case .inline: content.frame(maxWidth: .infinity, alignment: .leading)
    case .popover: content.padding(10)
    }
  }
}

/// Another agent's question in this thread (QuestionLine, capability agents.ask): its compact line, whose Answer opens
/// the asker's card in a popover anchored to the line (the same card, answering the same way: the user's answer wins);
/// in the run's root thread, when the question is the user's, the card itself in the line's place.
struct QuestionLineRow: View {
  @Environment(DeskModel.self) private var model
  let runId: String
  let agentId: String
  let line: QuestionLine
  let proseWidth: CGFloat?
  @State private var open = false

  var body: some View {
    DeskProbe.body("QuestionLineRow", id: agentId)
    return Group {
      if line.forYou, let card = line.card {
        QuestionCard(card: card, focused: model.agent(agentId)?.focused ?? false, placement: .inline)
          .padding(.bottom, Theme.Content.proseBottom)
      } else {
        QuestionLineView(runId: runId, line: line) {
          if let card = line.card {
            Button("Answer") { open = true }
              .buttonStyle(DeskButton(kind: .outline)).disabled(card.sending).opacity(card.sending ? 0.5 : 1)
              .help("Answer \(card.askerName)'s question: your answer wins")
          }
        }
        .popover(isPresented: $open, arrowEdge: .bottom) {
          if let card = line.card {
            QuestionCard(card: card, focused: true, placement: .popover(done: { open = false }))
              .environment(model).environment(\.deskPane, false).environment(\.needsReel, false)
              .frame(width: 432)
          }
        }
        // Answered anywhere else, the popover goes with the open line.
        .onChange(of: line.isOpen) { _, o in if !o { open = false } }
      }
    }
    .modifier(ProseColumn(proseWidth))
  }
}
#endif
