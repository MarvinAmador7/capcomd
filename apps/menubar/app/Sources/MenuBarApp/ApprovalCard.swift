#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §4.2: question first, branch line beneath in mono, Deny (grey) / Approve (blue). No timer.
struct ApprovalCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let approval: PendingApproval
  @State private var appeared = false

  var body: some View {
    VStack(alignment: .leading, spacing: 6) {
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "hand.raised").foregroundStyle(Theme.amber).opacity(appeared ? 1 : 0)
        Text(verbatim: approval.question.plain).font(.system(size: 13, weight: .medium)).lineLimit(3)
      }
      if let line = approval.branchLine {
        Text(verbatim: line).font(Theme.monoCode).foregroundStyle(.secondary).lineLimit(1).truncationMode(.middle)
      }
      switch approval.decision {
      case .decided(let status, let by, let already):
        Text(verbatim: decidedText(status, by, already)).font(Theme.chip).foregroundStyle(.secondary)
      case .failed(let msg):
        Text(verbatim: msg).font(Theme.chip).foregroundStyle(Theme.red)
        buttons
      default:
        buttons
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel([approval.question.plain, approval.branchLine?.replacingOccurrences(of: "→", with: "to")].compactMap { $0 }.joined(separator: ". "))
    .onAppear { withAnimation(reduceMotion ? .easeInOut(duration: 0.15) : .easeOut(duration: 0.25)) { appeared = true } }
  }

  private var submitting: Bool { if case .submitting = approval.decision { return true }; return false }

  private var buttons: some View {
    HStack(spacing: 8) {
      Button { model.decide(approval.id, .deny) } label: { Text("Deny").frame(maxWidth: .infinity) }
        .buttonStyle(.bordered).controlSize(.regular)
      Button { model.decide(approval.id, .approve) } label: { Text("Approve").frame(maxWidth: .infinity) }
        .buttonStyle(.borderedProminent).controlSize(.regular)   // system accent = blue
        .keyboardShortcut(.defaultAction)
    }
    .disabled(submitting)
  }

  private func decidedText(_ status: String, _ by: String?, _ already: Bool) -> String {
    let s = status.prefix(1).uppercased() + status.dropFirst()
    let who = by.map { " by \($0)" } ?? ""
    return already ? "Already \(status)\(who)" : "\(s)\(who)"
  }
}
#endif
