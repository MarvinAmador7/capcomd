#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// An approval in the run's drill-down: the question, what lands (the files, or the branch line from an older daemon), then
/// Deny / Approve ↩ as on the Active card (direction B, ActiveCardView.swift). No timer, no icon: the waiting agent's row
/// carries the amber hand.
struct ApprovalCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let approval: PendingApproval
  @State private var appeared = false

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      RedactableText(text: approval.question)
        .font(Theme.Approval.questionFont).foregroundStyle(Theme.Approval.questionText).lineLimit(3)
        .padding(.bottom, Theme.Approval.questionBottom)
      if let diff = approval.diff {
        FilesList(diff: diff).padding(.bottom, Theme.Approval.branchBottom)
      } else if let line = approval.branchLine {
        Text(verbatim: line).font(Theme.Approval.branchFont).foregroundStyle(Theme.Approval.branchText)
          .lineLimit(1).truncationMode(.middle)
          .padding(.bottom, Theme.Approval.branchBottom)
      }
      HStack(spacing: Theme.Ask.barGap) {
        Spacer(minLength: 0)
        DecisionButtons(approval: approval)
      }
    }
    .padding(.top, Theme.Approval.top).padding(.bottom, Theme.Approval.bottom)
    .opacity(appeared ? 1 : 0)
    .offset(y: appeared || reduceMotion ? 0 : Theme.Approval.appearRise)
    .accessibilityElement(children: .contain)
    .accessibilityLabel([approval.question.plain, approval.branchLine?.replacingOccurrences(of: "→", with: "to")].compactMap { $0 }.joined(separator: ". "))
    .onAppear { withAnimation(Theme.Motion.ease(reduceMotion)) { appeared = true } }
  }
}

#endif
