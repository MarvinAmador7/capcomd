#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §4.2 / tree-card-v3 `.apx`: question first, branch line beneath in mono, then Deny (grey) / Approve (blue).
/// No timer, no footer, no icon: the waiting agent's row carries the amber hand.
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
      if let line = approval.branchLine {
        Text(verbatim: line).font(Theme.Approval.branchFont).foregroundStyle(Theme.Approval.branchText)
          .lineLimit(1).truncationMode(.middle)
          .padding(.bottom, Theme.Approval.branchBottom)
      }
      switch approval.decision {
      case .decided(let status, let by, let already):
        Text(verbatim: decidedText(status, by, already)).font(Theme.Approval.statusFont).foregroundStyle(Theme.Approval.branchText)
      case .failed(let msg):
        Text(verbatim: msg).font(Theme.Approval.statusFont).foregroundStyle(Theme.red).padding(.bottom, Theme.Approval.questionBottom)
        buttons
      default:
        buttons
      }
    }
    .padding(.top, Theme.Approval.top).padding(.bottom, Theme.Approval.bottom)
    .opacity(appeared ? 1 : 0)
    .offset(y: appeared || reduceMotion ? 0 : Theme.Approval.appearRise)
    .accessibilityElement(children: .contain)
    .accessibilityLabel([approval.question.plain, approval.branchLine?.replacingOccurrences(of: "→", with: "to")].compactMap { $0 }.joined(separator: ". "))
    .onAppear { withAnimation(Theme.Motion.ease(reduceMotion)) { appeared = true } }
  }

  private var submitting: Bool { if case .submitting = approval.decision { return true }; return false }

  private var buttons: some View {
    HStack(spacing: Theme.Approval.buttonGap) {
      Button("Deny") { model.decide(approval.id, .deny) }
        .buttonStyle(ApprovalButtonStyle(fill: Theme.Approval.denyFill))
      Button("Approve") { model.decide(approval.id, .approve) }
        .buttonStyle(ApprovalButtonStyle(fill: Theme.accent))
        .keyboardShortcut(.defaultAction)
    }
    .disabled(submitting)
    .opacity(submitting ? Theme.Approval.disabledOpacity : 1)
  }

  private func decidedText(_ status: String, _ by: String?, _ already: Bool) -> String {
    let s = status.prefix(1).uppercased() + status.dropFirst()
    let who = by.map { " by \($0)" } ?? ""
    return already ? "Already \(status)\(who)" : "\(s)\(who)"
  }
}

/// Full-width filled button from the mockup (`.btn`): fixed fills, so Approve stays blue while the panel's app isn't
/// active (a bordered-prominent button turns grey then).
struct ApprovalButtonStyle: ButtonStyle {
  let fill: Color
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(Theme.Approval.buttonFont).foregroundStyle(Theme.Approval.buttonText)
      .frame(maxWidth: .infinity).frame(height: Theme.Approval.buttonHeight)
      .background(RoundedRectangle(cornerRadius: Theme.Approval.buttonRadius).fill(fill))
      .contentShape(RoundedRectangle(cornerRadius: Theme.Approval.buttonRadius))
      .modifier(PressFeedback(isPressed: configuration.isPressed))
  }
}
#endif
