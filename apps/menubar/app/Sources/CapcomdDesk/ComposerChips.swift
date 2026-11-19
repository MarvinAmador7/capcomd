#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

// The composer's chips, as Home's composer shows them: the folder (the menu bar's chip, CapcomdUI's ComposerFolderChip),
// the base and the goal branch. The tool row (+ , Local / Cloud, the model chip, the mic, Start) is in Home.swift, built
// from the menu bar composer's own views (CapcomdUI/ComposerToolRow.swift).

/// Where the run goes: the remembered project checkout (× goes back to the default project), else the daemon's default
/// project (a click chooses a folder). While a picked folder is looked at or set up: that folder, with a spinner or the
/// orange "not set up" dot; × cancels.
struct FolderChip: View {
  @Environment(DeskModel.self) private var model
  /// The column's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  var body: some View {
    let flow = model.setupFlow
    let place: ComposerFolderChip.Where
    if flow.isOpen, let path = flow.path {
      let screen = flow.screen(goal: "", sandbox: nil)
      place = .settingUp(name: screen?.name ?? (path as NSString).lastPathComponent, path: path, loading: screen?.phase == .loading)
    } else if let repo = model.store.prefs.startRepo {
      place = .checkout(path: repo)
    } else {
      place = .defaultProject
    }
    return ComposerFolderChip(place, remove: { if model.setupFlow.isOpen { model.cancelSetup() } else { model.useDefaultProject() } },
                              choose: { model.chooseProjectFolder() })
  }
}

/// The base the work starts from: the repository's branches, the daemon's suggestion preselected; nothing selected (and
/// Start disabled, with "Pick the branch this work starts from") when it can't say: never a guessed main.
struct BaseChip: View {
  @Environment(DeskModel.self) private var model
  let form: NewProjectForm
  var body: some View {
    let s = form.goalSetup
    Menu {
      if s.branches.isEmpty {
        Button(s.awaitingFirstAnswer ? "Reading the branches…" : "No branches") {}.disabled(true)
      } else {
        Section("Starts from") {
          ForEach(s.branches, id: \.self) { b in
            Toggle(isOn: Binding(get: { b == s.base }, set: { _ in model.pickBase(b) })) { Text(verbatim: b) }
          }
        }
      }
    } label: {
      HStack(spacing: 4) {
        Image(systemName: "arrow.triangle.branch").font(.system(size: 10, weight: .medium))
        Text(verbatim: s.base ?? "Pick a branch").font(Theme.Desk.Home.chipFont).lineLimit(1)
        if s.awaitingFirstAnswer { ProgressView().controlSize(.mini).frame(width: 10, height: 10) }
        Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
      }
      .foregroundStyle(s.base == nil && !s.awaitingFirstAnswer ? Theme.Setup.orange : Theme.Desk.tertiary)
      .padding(.horizontal, 7).frame(height: 22)
      .contentShape(Rectangle())
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .help("The branch this work starts from; the pull request goes back into it")
    .accessibilityLabel(s.base.map { "Starts from \($0)" } ?? GoalBranchSetup.pickBase)
  }
}

/// The goal branch the reviewed work lands on: the daemon's suggestion for the goal, until it's edited.
struct GoalBranchName: View {
  @Environment(DeskModel.self) private var model
  let form: NewProjectForm
  var body: some View {
    let s = form.goalSetup
    HStack(spacing: 4) {
      Image(systemName: "arrow.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.Desk.tertiary).accessibilityHidden(true)
      GoalBranchField(text: Binding(get: { s.goalBranch }, set: { model.typeBranch($0) }), placeholder: s.placeholder,
                      error: form.branchLine?.warn == true)
        .frame(minWidth: 90, maxWidth: .infinity)
    }
  }
}

/// The daemon's sentences under the branch row: about the name, about the base, where the branches came from.
struct BranchLines: View {
  let form: NewProjectForm
  var body: some View {
    let lines = [form.branchLine, form.baseLine, form.goalSetup.note].compactMap { $0 }
    if !lines.isEmpty {
      VStack(alignment: .leading, spacing: 2) {
        ForEach(lines, id: \.self) { l in
          Text(verbatim: l.text).font(Theme.Setup.noteFont).foregroundStyle(l.warn ? Theme.Setup.orange : Theme.Setup.noteText)
            .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading).textSelection(.enabled)
        }
      }
      .padding(.horizontal, 3)
    }
  }
}

#endif
