#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// The goal branch's ready card, docked at the planner's column foot where an ask docks (capability runs.goal_branch).
/// Titled with the branch → its base; the planner's summary first, then the compare line, what landed and what didn't
/// (folded past four), then View diff · Keep branch · Open PR (or why a pull request can't be opened). A stopped run's
/// Open PR asks the daemon's question first (Cancel · Open PR). Once chosen it is one line: the pull request's link, or
/// "Kept on <branch>". What it says is GoalCard's (CapcomdStore).
struct GoalDock: View {
  @Environment(DeskModel.self) private var model
  let card: GoalCard
  @State private var all = false
  @State private var files = false

  var body: some View {
    DeskProbe.body("GoalDock")
    return Group {
      if card.docks { deciding } else if let o = card.outcome { settled(o) }
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.Desk.goalFill)
    .overlay(alignment: .top) { Rectangle().fill(Theme.Desk.columnStroke).frame(height: 0.5) }
  }

  private var deciding: some View {
    VStack(alignment: .leading, spacing: 8) {
      HStack(spacing: 6) {
        Image(systemName: card.stopped ? "exclamationmark.triangle" : "arrow.triangle.branch")
          .font(.system(size: 12, weight: .semibold)).foregroundStyle(card.stopped ? Theme.amber : Theme.Desk.secondary)
        Text(verbatim: card.branch).font(Theme.Desk.goalTitle).foregroundStyle(Theme.Desk.text).lineLimit(1).truncationMode(.middle)
        Text(verbatim: "→ \(card.base)").font(Theme.Desk.goalTitle).foregroundStyle(Theme.Desk.secondary).lineLimit(1).fixedSize()
        Spacer(minLength: 0)
        Text(card.stopped ? "stopped" : "ready").font(Theme.Desk.meta).foregroundStyle(card.stopped ? Theme.amber : Theme.Desk.tertiary)
      }
      .accessibilityElement(children: .combine)
      if let s = card.summary {
        Text(verbatim: s.plain).font(Theme.Desk.label).foregroundStyle(Theme.Desk.text)   // the planner's words: plain, never markdown
          .lineLimit(all ? nil : 5).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
      } else if card.loading {
        Text("Reading the goal branch…").font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary)
      }
      if let e = card.compareError ?? card.problem { Text(verbatim: e).font(Theme.Desk.meta).foregroundStyle(Theme.amber).fixedSize(horizontal: false, vertical: true) }
      else if let c = card.compareLine { Text(verbatim: c).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.secondary) }
      rows
      if files { fileList }
      if let q = card.confirm {
        Text(verbatim: q).font(Theme.Desk.question).foregroundStyle(Theme.Desk.text).fixedSize(horizontal: false, vertical: true)
        HStack(spacing: 8) {
          Spacer(minLength: 0)
          Button("Cancel") { model.cancelGoalAction(card.runId) }.buttonStyle(DeskButton(kind: .outline))
          openButton { model.confirmPullRequest(card.runId) }
        }
      } else {
        if case .refused(let m)? = card.outcome { Text(verbatim: m).font(Theme.Desk.meta).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true).textSelection(.enabled) }
        HStack(spacing: 8) {
          Button(card.diffURL == nil ? (files ? "Hide files" : "View diff") : "View diff ↗") {
            if let u = card.diffURL { NSWorkspace.shared.open(u) } else { files.toggle() }
          }
          .buttonStyle(DeskButton(kind: .outline))
          .help(card.diffURL.map { "Opens \($0.absoluteString)" } ?? "The files the branch changes (the repository isn't on GitHub)")
          if case .unavailable(let why) = card.openPR {
            Text(verbatim: why).font(Theme.Desk.meta).foregroundStyle(Theme.Desk.secondary).lineLimit(3)
              .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .trailing).multilineTextAlignment(.trailing)
              .textSelection(.enabled)
          } else { Spacer(minLength: 0) }
          if card.keepShown {
            Button { model.keepBranch(card.runId) } label: { busy("Keep branch", card.keepBusy) }
              .buttonStyle(DeskButton(kind: .outline)).disabled(card.keepBusy)
              .help("Keep the work on \(card.branch) without a pull request")
          }
          if case .button = card.openPR { openButton { model.openPullRequest(card) } }
        }
      }
    }
  }

  /// What landed, then what didn't; past four rows, the first three and Show all.
  @ViewBuilder private var rows: some View {
    let list = card.landed + card.notLanded
    let shown = all || !card.collapsible ? list : Array(list.prefix(GoalCard.rowsFolded - 1))
    if !list.isEmpty {
      VStack(alignment: .leading, spacing: 5) {
        ForEach(shown) { r in row(r) }
        if card.collapsible {
          Button(all ? "Show less" : "Show all \(list.count)") { all.toggle() }
            .buttonStyle(.plain).font(Theme.Desk.meta).foregroundStyle(Theme.Desk.secondary)
        }
      }
      .padding(.top, 2)
    }
  }

  private func row(_ r: GoalCard.Row) -> some View {
    HStack(alignment: .firstTextBaseline, spacing: 7) {
      Image(systemName: r.landed ? "checkmark" : "minus.circle").font(.system(size: 10, weight: .bold))
        .foregroundStyle(r.landed ? Theme.green : Theme.Desk.tertiary)
        .accessibilityLabel(r.landed ? "Landed" : "Not landed")
      VStack(alignment: .leading, spacing: 1) {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
          Text(verbatim: r.task.plain).font(Theme.Desk.label).foregroundStyle(r.landed ? Theme.Desk.text : Theme.Desk.secondary).lineLimit(1).truncationMode(.tail)
          Text(verbatim: r.status).font(Theme.Desk.meta).foregroundStyle(r.landed ? Theme.Desk.tertiary : Theme.amber).lineLimit(1).fixedSize()
        }
        if let d = r.detail { Text(verbatim: d.plain).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary).lineLimit(2).truncationMode(.tail) }
      }
    }
    .accessibilityElement(children: .combine)
  }

  /// The files the branch changes, when there's no compare to open (not on GitHub).
  private var fileList: some View {
    VStack(alignment: .leading, spacing: 3) {
      ForEach(card.files) { f in
        HStack(spacing: 8) {
          Text(verbatim: f.path.plain).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.text).lineLimit(1).truncationMode(.middle)
          Spacer(minLength: 0)
          Text(verbatim: f.added.map { "+\($0)" } ?? "–").font(Theme.Desk.mono).foregroundStyle(Theme.green)
          Text(verbatim: f.removed.map { "−\($0)" } ?? "").font(Theme.Desk.mono).foregroundStyle(Theme.red)
        }
      }
      if card.filesMore > 0 { Text(verbatim: "and \(card.filesMore) more").font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary) }
      if card.files.isEmpty { Text("No files to show").font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary) }
    }
    .padding(8).background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(Color.black.opacity(0.2)))
  }

  private func settled(_ o: GoalCard.Outcome) -> some View {
    HStack(spacing: 8) {
      switch o {
      case .pullRequest(let n, let url):
        Image(systemName: "arrow.triangle.pull").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.green)
        if let url {
          Button { NSWorkspace.shared.open(url) } label: { Text(verbatim: "Pull request #\(n) ↗").font(Theme.Desk.name).foregroundStyle(Theme.Desk.text) }
            .buttonStyle(.plain).help(url.absoluteString)
        } else { Text(verbatim: "Pull request #\(n)").font(Theme.Desk.name).foregroundStyle(Theme.Desk.text) }
        Text(verbatim: card.title).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary).lineLimit(1).truncationMode(.middle)
        Spacer(minLength: 0)
      case .kept(let line), .refused(let line):
        Image(systemName: "arrow.triangle.branch").font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.Desk.secondary)
        Text(verbatim: line).font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary).lineLimit(2)
        Spacer(minLength: 0)
        if card.phase == .kept, case .button = card.openPR { openButton { model.openPullRequest(card) } }
      }
    }
  }

  private func openButton(_ action: @escaping () -> Void) -> some View {
    let busy = card.openPR == .button(busy: true)
    return Button(action: action) { self.busy("Open PR", busy) }
      .buttonStyle(DeskButton(kind: .primary)).disabled(busy)
      .help("Opens a pull request from \(card.branch) into \(card.base) with your GitHub login; capcomd never merges it")
  }

  private func busy(_ s: String, _ on: Bool) -> some View {
    ZStack { Text(verbatim: s).opacity(on ? 0 : 1); if on { ProgressView().controlSize(.mini) } }
  }
}
#endif
