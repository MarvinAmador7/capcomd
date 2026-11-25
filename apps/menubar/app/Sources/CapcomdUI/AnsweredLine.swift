#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// A question once answered (capability agents.ask, DurableAsked-v3 `.inset .rec`): one line, "Answered · 100 req/min ·
/// 11:42", saying when the answer wasn't the recommended one, and the answerer's note under it. The answer and the note
/// are someone's words: plain text only.
package struct AnsweredLine: View {
  package let record: AnsweredQuestion
  /// The agent that answered, named; nil when a person did.
  package let byName: String?
  package init(record: AnsweredQuestion, byName: String?) { self.record = record; self.byName = byName }

  package static func clock(_ ms: Int) -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm"
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }

  package var body: some View {
    let line = record.line(name: byName, time: Self.clock(record.atMs))
    VStack(alignment: .leading, spacing: 2) {
      HStack(alignment: .center, spacing: 8) {
        Image(systemName: "checkmark").font(.system(size: 7.5, weight: .bold)).foregroundStyle(Color(red: 0x4F / 255, green: 0xB0 / 255, blue: 0xFE / 255))
          .frame(width: 16, height: 16).background(Circle().fill(Color(red: 0x4F / 255, green: 0xB0 / 255, blue: 0xFE / 255).opacity(0.16)))
        (Text(verbatim: "\(line.lead) · ").foregroundStyle(Theme.AskCard.t3)
          + Text(verbatim: line.answer).font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.AskCard.t1)
          + Text(verbatim: " · \(line.tail)").foregroundStyle(Theme.AskCard.t3))
          .font(.system(size: 12)).lineLimit(1).truncationMode(.middle).monospacedDigit()
      }
      .frame(minHeight: 28)
      if let n = record.noteLine(name: byName) {
        Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3).lineSpacing(3).padding(.leading, 24)
          .fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 10)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Theme.AskCard.inset))
    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.AskCard.line, lineWidth: 0.5))
    .accessibilityElement(children: .combine)
  }
}

/// A question withdrawn before it was answered (its agent was cancelled): quiet, not a failure. One muted line in the
/// answered line's place, "Withdrawn · Which limit? · 11:42", a small dash in its leading slot, every word the grey of
/// the thread's other quiet lines; why (its agent was cancelled) is the hover help, not a second line. `leading`: the
/// answered line's inset (14) in the asker's thread; 0 where the row's slot is the thread's own (another agent's line).
package struct WithdrawnLine: View {
  package let record: WithdrawnQuestion
  package var leading: CGFloat = 14
  package init(record: WithdrawnQuestion, leading: CGFloat = 14) { self.record = record; self.leading = leading }

  package var body: some View {
    let line = record.line(time: AnsweredLine.clock(record.atMs))
    HStack(alignment: .center, spacing: 8) {
      Text(verbatim: "–").font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3).frame(width: 16, height: 16).accessibilityHidden(true)
      HStack(spacing: 4) {
        Text(verbatim: "\(line.lead) · \(line.question)").lineLimit(1).truncationMode(.tail)
        Text(verbatim: "· \(line.tail)").monospacedDigit().fixedSize()
      }
      .font(.system(size: 12)).foregroundStyle(Theme.AskCard.t3)
    }
    .frame(minHeight: 28)
    .padding(.horizontal, leading)
    .frame(maxWidth: .infinity, alignment: .leading)
    .contentShape(Rectangle())
    .help(WithdrawnQuestion.why)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(line.lead): \(line.question), \(line.tail). \(WithdrawnQuestion.why)")
  }
}

/// Another agent's question in this thread (capability agents.ask; QuestionLine), or the asker's own once it is passed
/// up to you ("asked you"): one compact row in thread v2's row language, where the question reached this agent. One row
/// when it fits ("<bot> request limiter asked: Ship the limiter…? · waiting on api lead  [Answer]", an opened pane), two
/// in a narrow column (what became of it under the words): ViewThatFits decides. The asker's name opens it, as a
/// hand-back's who line does; a cut question shows whole on hover. Answered: "You answered 500 req/min — not the
/// recommendation" with the blue tick, and the note under it. Withdrawn: the quiet withdrawn line. Every string but
/// the words around them is someone's: plain text only.
package struct QuestionLineView<Accessory: View>: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let line: QuestionLine
  package let accessory: Accessory
  package init(runId: String, line: QuestionLine, @ViewBuilder accessory: () -> Accessory) { self.runId = runId; self.line = line; self.accessory = accessory() }

  /// Under the asker's name: the bot and the gap.
  private var indent: CGFloat { Theme.Rows.whoBot + Theme.Rows.gap }

  package var body: some View {
    Group {
      if case .withdrawn(let at) = line.state {
        WithdrawnLine(record: WithdrawnQuestion(questionId: line.questionId, question: "\(line.askerName) \(line.asked)", atMs: at), leading: 0)
      } else {
        VStack(alignment: .leading, spacing: 0) {
          ViewThatFits(in: .horizontal) {
            HStack(spacing: Theme.Rows.gap) {
              who
              Text(verbatim: line.asked).font(Theme.Rows.detail).foregroundStyle(Theme.Rows.detailText).lineLimit(1).fixedSize()
              Text(verbatim: "·").font(Theme.Rows.detail).foregroundStyle(Theme.Rows.statusText)
              outcome.fixedSize()
              Spacer(minLength: Theme.Rows.statusLead)
              trailing
            }
            .frame(minHeight: Theme.Rows.height)
            VStack(alignment: .leading, spacing: 0) {
              HStack(spacing: Theme.Rows.gap) {
                who
                Text(verbatim: line.asked).font(Theme.Rows.detail).foregroundStyle(Theme.Rows.detailText).lineLimit(1).truncationMode(.tail)
                  .help(line.question.plain)
                Spacer(minLength: 0)
              }
              .frame(minHeight: Theme.Rows.height)
              HStack(alignment: .center, spacing: Theme.Rows.gap) {
                outcome
                Spacer(minLength: Theme.Rows.statusLead)
                trailing
              }
              .padding(.leading, indent)
            }
          }
          if let n = line.noteLine {
            Text(verbatim: n).font(Theme.Rows.statusWord).foregroundStyle(Theme.Rows.statusText).lineSpacing(3)
              .fixedSize(horizontal: false, vertical: true).padding(.leading, indent).padding(.top, 2)
          }
        }
        .accessibilityElement(children: .contain)
        .accessibilityLabel(line.summary)
      }
    }
    .padding(.bottom, Theme.Rows.bottom)
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// The asker's bot and name: a click opens its thread.
  private var who: some View {
    let h = host?.host
    return Button { h?.openAgent(runId: runId, agentId: line.askerId) } label: {
      HStack(spacing: Theme.Rows.gap) {
        ProvidedBot(traits: h?.bot(runId: runId, agentId: line.askerId), size: .xs, provider: h?.agentProvider(runId: runId, agentId: line.askerId))
          .frame(width: Theme.Rows.whoBot, height: Theme.Rows.whoBot)
        Text(verbatim: line.askerName).font(Theme.Rows.whoName).foregroundStyle(Theme.Rows.whoNameText).lineLimit(1).fixedSize()
      }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .help("Open its thread")
    .accessibilityLabel("Open \(line.askerName)")
  }

  /// What became of it, in words: the status, or (answered) who answered what.
  @ViewBuilder private var outcome: some View {
    if let o = line.outcome {
      (Text(verbatim: "\(o.lead) ").foregroundStyle(Theme.Rows.statusText)
        + Text(verbatim: o.answer).font(Theme.Rows.verdictFont).foregroundStyle(Theme.Rows.cardText)
        + Text(verbatim: " \(o.tail)").foregroundStyle(Theme.Rows.statusText))
        .font(Theme.Rows.detail).lineLimit(2)
    } else {
      HStack(spacing: Theme.Rows.statusWordGap) {
        if case .passed = line.state {
          Image(systemName: "arrow.up").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.Rows.statusText)
        }
        Text(verbatim: line.status ?? "").font(Theme.Rows.detail).foregroundStyle(Theme.Rows.statusText).lineLimit(1).truncationMode(.tail)
      }
    }
  }

  /// On the right: Answer while it is open, the blue tick once answered.
  @ViewBuilder private var trailing: some View {
    switch line.state {
    case .open: accessory
    case .answered: ToolStatusView(status: .done, duration: nil)
    case .passed, .withdrawn: EmptyView()
    }
  }
}

extension Theme {
  /// The question card's tokens (DurableAsked-v3): the board's --t1/--t2/--t3, its hairline and its strong line.
  package enum AskCard {
    package static let t1 = Color(red: 0xF2 / 255, green: 0xF2 / 255, blue: 0xF7 / 255)
    package static let t2 = Color(red: 0xA9 / 255, green: 0xA9 / 255, blue: 0xB1 / 255)
    package static let t3 = Color(red: 0x8E / 255, green: 0x8E / 255, blue: 0x96 / 255)
    package static let line = Color.white.opacity(0.12)
    package static let strong = Color.white.opacity(0.28)
    package static let selected = Color.white.opacity(0.05)
    package static let card = Color(red: 0x1B / 255, green: 0x1B / 255, blue: 0x1F / 255)
    package static let inset = Color.white.opacity(0.03)
    package static let kbdFill = Color.white.opacity(0.08)
  }
}
#endif
