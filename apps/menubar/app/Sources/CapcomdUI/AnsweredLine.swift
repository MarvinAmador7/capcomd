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
