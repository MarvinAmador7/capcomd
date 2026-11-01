#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

// Goal branches in the menu bar (capability runs.goal_branch): the composer's row under the goal (the branch the run's
// work lands on, and the base it's cut from), and the run's compact "Ready" bar once the planner is done. What they
// say comes from GoalBranchSetup and GoalCard (CapcomdStore); these only lay it out.

/// The composer's goal branch row: ⎇ [goal branch field] from [base ▾], then a line under it when there is something
/// to say (the daemon's sentence about a field, "Pick the branch this work starts from", where the branches came from).
struct GoalBranchRows: View {
  @Environment(AppModel.self) private var model

  var body: some View {
    let s = model.goalSetup
    let field = model.startRefusedField
    let refusal: String? = { if case .failed(let m) = model.startState { return m }; return nil }()
    let branchLine = s.branchLine(refusedField: field, refusal: refusal), baseLine = s.baseLine(refusedField: field, refusal: refusal)
    VStack(alignment: .leading, spacing: Theme.Goal.lineGap) {
      HStack(spacing: Theme.Goal.rowGap) {
        Image(systemName: "arrow.triangle.branch").font(Theme.Goal.icon).foregroundStyle(Theme.Setup.labelText).accessibilityHidden(true)
        GoalBranchField(text: Binding(get: { s.goalBranch }, set: { v in edit { model.goalSetup.typeBranch(v) } }),
                        placeholder: s.placeholder, error: branchLine?.warn == true)
        Text("from").font(Theme.Setup.labelFont).foregroundStyle(Theme.Setup.labelText).fixedSize()
        SetupPopup(text: s.base ?? "Pick a branch", accessibility: s.base.map { "Starts from \($0)" } ?? "Pick the branch this work starts from") {
          if s.branches.isEmpty {
            Button(s.awaitingFirstAnswer ? "Reading the branches…" : "No branches") {}.disabled(true)
          } else {
            Section("Starts from") {
              ForEach(s.branches, id: \.self) { b in
                Toggle(isOn: Binding(get: { b == s.base }, set: { _ in edit { model.goalSetup.pickBase(b) } })) { Text(verbatim: b) }
              }
            }
          }
        }
        .overlay(alignment: .trailing) {
          if s.awaitingFirstAnswer { ProgressView().controlSize(.mini).offset(x: Theme.Goal.spinnerOffset).accessibilityLabel("Reading the branches") }
        }
      }
      ForEach([branchLine, baseLine, s.note].compactMap { $0 }, id: \.self) { l in
        Text(verbatim: l.text).font(Theme.Setup.noteFont).lineSpacing(Theme.Setup.noteLineSpacing)
          .foregroundStyle(l.warn ? Theme.Setup.orange : Theme.Setup.noteText)
          .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
          .textSelection(.enabled)
      }
    }
    .padding(.horizontal, Theme.Composer2.textInset)
    .accessibilityElement(children: .contain).accessibilityLabel("Goal branch")
  }

  /// An edit to a field puts away the last Start's refusal (it was about what the person is changing).
  private func edit(_ f: () -> Void) {
    f()
    if model.startRefusedField != nil { model.clearStart() }
  }
}

/// The goal branch's name: mono on the setup's dark well, the daemon's suggestion as its placeholder, orange when the
/// daemon said it can't be used.
struct GoalBranchField: View {
  @Binding var text: String
  let placeholder: String
  var error = false
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Setup.controlRadius, style: .continuous)
    TextField("", text: $text).textFieldStyle(.plain)
      .font(Theme.Setup.fieldFont).foregroundStyle(Theme.Setup.valueText)
      .background(alignment: .leading) {
        if text.isEmpty { Text(verbatim: placeholder).font(Theme.Setup.fieldFont).foregroundStyle(Theme.Setup.noteText).lineLimit(1).allowsHitTesting(false) }
      }
      .padding(.horizontal, Theme.Setup.fieldPadding).frame(maxWidth: .infinity).frame(height: Theme.Setup.controlHeight)
      .background(shape.fill(Theme.Setup.fieldFill))
      .overlay(shape.strokeBorder(error ? Theme.Setup.orange : Theme.Setup.fieldStroke, lineWidth: 0.5))
      .background(shape.stroke(Theme.Setup.orange.opacity(Theme.Setup.errorRingOpacity), lineWidth: Theme.Setup.errorRing)
        .padding(-Theme.Setup.errorRing / 2).opacity(error ? 1 : 0))
      .accessibilityLabel("Goal branch").accessibilityValue(text.isEmpty ? placeholder : text)
      .help("Reviewed work lands on this branch; when the planner is done you choose whether to open a pull request from it")
  }
}

/// The run's goal branch on the menu bar. Ready (or stopped): "Ready: <branch>" with View diff · Keep branch · Open PR
/// (or why Open PR can't be offered), and the stopped run's question with Cancel · Open PR. Once chosen: the pull
/// request's link or "Kept on <branch>". While the planner works only `quiet` places (the drill-down) name the branch.
/// `docked`: the foot of a card (the Active card's bar); else a box of its own.
struct GoalReadyBar: View {
  @Environment(AppModel.self) private var model
  let runId: String
  var docked = true
  var quiet = false

  var body: some View {
    if let c = model.goalCard(runId) {
      Group {
        if c.docks { deciding(c) }
        else if let o = c.outcome { settled(c, o) }
        else if quiet, c.phase == .working {
          label(icon: "arrow.triangle.branch", head: "Lands on", c.branch, tail: "from \(c.base)")
        }
      }
      .modifier(GoalBarChrome(docked: docked, shows: c.docks || c.outcome != nil || (quiet && c.phase == .working)))
      .task(id: c.docks || c.outcome != nil) { if c.docks || c.outcome != nil { model.loadGoal(runId) } }
    }
  }

  @ViewBuilder private func deciding(_ c: GoalCard) -> some View {
    VStack(alignment: .leading, spacing: Theme.Goal.barGap) {
      VStack(alignment: .leading, spacing: Theme.Goal.lineGap) {
        label(icon: c.stopped ? "exclamationmark.triangle" : "arrow.triangle.branch", head: c.stopped ? "Stopped:" : "Ready:", c.branch, tail: "→ \(c.base)")
        if let line = c.compareError ?? c.compareLine { Text(verbatim: line).font(Theme.Ask.statsFont).foregroundStyle(Theme.Ask.text3).lineLimit(1) }
      }
      if let q = c.confirm {
        Text(verbatim: q).font(Theme.Ask.noteFont).foregroundStyle(Theme.Ask.text).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: Theme.Ask.barGap) {
          Spacer(minLength: 0)
          Button("Cancel") { model.cancelGoalAction(runId) }.buttonStyle(CardButtonStyle(kind: .ghost))
          openButton(c, title: "Open PR") { model.confirmPullRequest(runId) }
        }
      } else {
        if case .refused(let m)? = c.outcome { sentence(m, warn: true) }
        if case .unavailable(let why) = c.openPR { sentence(why, warn: false) }
        HStack(spacing: Theme.Ask.barGap) {
          Button("View diff") { model.viewGoalDiff(c) }.buttonStyle(CardTextButtonStyle())
            .help(c.diffURL == nil ? "The run's files" : "The branch against \(c.base) on GitHub")
          Spacer(minLength: 0)
          if c.keepShown {
            Button { model.keepBranch(runId) } label: { busyLabel("Keep branch", busy: c.keepBusy) }
              .buttonStyle(CardButtonStyle(kind: .ghost)).disabled(c.keepBusy)
              .help("Keep the work on \(c.branch) without a pull request")
          }
          if case .button = c.openPR { openButton(c, title: "Open PR") { model.openPullRequest(c) } }
        }
      }
    }
  }

  @ViewBuilder private func settled(_ c: GoalCard, _ o: GoalCard.Outcome) -> some View {
    HStack(spacing: Theme.Ask.barGap) {
      switch o {
      case .pullRequest(let n, let url):
        Image(systemName: "arrow.triangle.pull").font(Theme.Goal.icon).foregroundStyle(Theme.Ask.green).accessibilityHidden(true)
        if let url {
          Button { NSWorkspace.shared.open(url) } label: {
            Text(verbatim: "Pull request #\(n)").font(Theme.Ask.statsFont.weight(.medium)) + Text(verbatim: " ↗").font(Theme.Ask.statsFont)
          }
          .buttonStyle(CardTextButtonStyle()).help(url.absoluteString)
        } else {
          Text(verbatim: "Pull request #\(n)").font(Theme.Ask.statsFont).foregroundStyle(Theme.Ask.text2)
        }
        Text(verbatim: "\(c.branch) → \(c.base)").font(Theme.Ask.monoFont).foregroundStyle(Theme.Ask.text3).lineLimit(1).truncationMode(.middle)
        Spacer(minLength: 0)
      case .kept(let line), .refused(let line):
        Image(systemName: "arrow.triangle.branch").font(Theme.Goal.icon).foregroundStyle(Theme.Ask.text3).accessibilityHidden(true)
        // "Kept on <branch>" stays one line (the name gives way in its middle); a refusal's sentence may take two.
        Text(verbatim: line).font(Theme.Ask.statsFont).foregroundStyle(Theme.Ask.text2).lineLimit(c.phase == .kept ? 1 : 2).truncationMode(.middle).help(line)
        Spacer(minLength: 0)
        if c.phase == .kept, case .button = c.openPR { openButton(c, title: "Open PR") { model.openPullRequest(c) } }
      }
    }
  }

  private func label(icon: String, head: String, _ branch: String, tail: String) -> some View {
    HStack(spacing: Theme.Goal.labelGap) {
      Image(systemName: icon).font(Theme.Goal.icon).foregroundStyle(Theme.Ask.text3).accessibilityHidden(true)
      Text(verbatim: head).font(Theme.Ask.statsFont.weight(.medium)).foregroundStyle(Theme.Ask.text2).fixedSize()
      Text(verbatim: branch).font(Theme.Ask.monoFont).foregroundStyle(Theme.Ask.text).lineLimit(1).truncationMode(.middle).layoutPriority(1)
      Text(verbatim: tail).font(Theme.Ask.monoFont).foregroundStyle(Theme.Ask.text3).lineLimit(1).fixedSize()
    }
    .accessibilityElement(children: .combine)
  }

  private func sentence(_ s: String, warn: Bool) -> some View {
    Text(verbatim: s).font(Theme.Setup.noteFont).foregroundStyle(warn ? Theme.Ask.red : Theme.Ask.text2)
      .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
  }

  private func openButton(_ c: GoalCard, title: String, _ action: @escaping () -> Void) -> some View {
    let busy = c.openPR == .button(busy: true)
    return Button(action: action) { busyLabel(title, busy: busy) }
      .buttonStyle(CardButtonStyle(kind: .primary)).disabled(busy)
      .help("Opens a pull request from \(c.branch) into \(c.base) with your GitHub login; capcomd never merges it")
  }

  private func busyLabel(_ s: String, busy: Bool) -> some View {
    ZStack { Text(verbatim: s).opacity(busy ? 0 : 1); if busy { ProgressView().controlSize(.mini) } }.fixedSize()
  }
}

/// The bar's chrome: docked to a card's foot on the darker step (as the Active card's decision bar), or a sunk box.
private struct GoalBarChrome: ViewModifier {
  let docked: Bool
  let shows: Bool
  func body(content: Content) -> some View {
    if !shows { content }
    else if docked {
      content.padding(Theme.Ask.barPadding).frame(maxWidth: .infinity, alignment: .leading).background(Theme.Ask.sunk)
    } else {
      content.padding(Theme.Ask.barPadding).frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: Theme.Ask.errRadius, style: .continuous).fill(Theme.Ask.sunk))
    }
  }
}
#endif
