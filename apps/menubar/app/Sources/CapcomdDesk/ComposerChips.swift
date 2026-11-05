#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

// The composer's chips and switches, as Home's composer (Home.dc.html) shows them: the folder, the base and the goal
// branch, + , and Local / Cloud. The model button is in Home.swift.

/// Where the run goes: the remembered project checkout (× goes back to the default project), else the daemon's default
/// project (a click chooses a folder). While a picked folder is looked at or set up: that folder, with a spinner or the
/// orange "not set up" dot; × cancels.
struct FolderChip: View {
  @Environment(DeskModel.self) private var model
  /// The column's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  var body: some View {
    let flow = model.setupFlow
    if flow.isOpen, let path = flow.path {
      let screen = flow.screen(goal: "", sandbox: nil)
      chip(text: screen?.name ?? (path as NSString).lastPathComponent, remove: { model.cancelSetup() }) {
        if screen?.phase == .loading { ProgressView().controlSize(.mini).frame(width: 10, height: 10).accessibilityLabel("Looking at the folder") }
        else { SetupDot() }
      }
      .help(path)
    } else if let repo = model.store.prefs.startRepo {
      chip(text: (repo as NSString).lastPathComponent, remove: { model.useDefaultProject() }) { EmptyView() }.help(repo)
    } else {
      Button { model.chooseProjectFolder() } label: { chip(text: "Default project", remove: nil) { EmptyView() } }
        .buttonStyle(.plain).help("capcomd's default project; click to choose a folder")
    }
  }

  private func chip<T: View>(text: String, remove: (() -> Void)?, @ViewBuilder trailing: () -> T) -> some View {
    HStack(spacing: 5) {
      Image(systemName: "folder").font(.system(size: 10.5))
      Text(verbatim: text).font(Theme.Desk.Home.chipFont).lineLimit(1)
      trailing()
      if let remove {
        Button(action: remove) { Image(systemName: "xmark").font(.system(size: 7.5, weight: .bold)).foregroundStyle(Theme.Desk.tertiary).frame(width: 14, height: 14) }
          .buttonStyle(.plain).accessibilityLabel("Remove \(text)")
      }
    }
    .foregroundStyle(Theme.Desk.text)
    .padding(.leading, 7).padding(.trailing, remove == nil ? 7 : 4).frame(height: 22)
    .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.white.opacity(0.07)))
    .fixedSize()
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

/// + : what the menu bar's + offers for a project folder (Settings is in the app menu, ⌘,).
struct AddMenu: View {
  @Environment(DeskModel.self) private var model
  /// The column's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  var body: some View {
    Menu {
      Button("Choose Project Folder…") { model.chooseProjectFolder() }
      if model.store.prefs.startRepo != nil { Button("Use the Default Project") { model.useDefaultProject() } }
    } label: {
      Image(systemName: "plus").font(.system(size: 12, weight: .regular)).foregroundStyle(Theme.Desk.secondary)
        .frame(width: 28, height: 28)
        .overlay(Circle().strokeBorder(Color.white.opacity(0.22), lineWidth: 0.5))
        .contentShape(Circle())
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .accessibilityLabel("Add a project folder")
  }
}

/// Local / Cloud, as the daemon offers them (`GET /v1/run-options`); the pick is remembered. One it can't use now is
/// dimmed, with its reason.
struct PlaceSwitch: View {
  @Environment(DeskModel.self) private var model
  /// The column's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  var body: some View {
    let s = model.store
    if let current = s.startSandbox, s.runOptions.sandboxes.count > 1 {
      HStack(spacing: 0) {
        ForEach(s.runOptions.sandboxes) { o in
          let on = o.name == current.name
          let place = Place(sandbox: o.name)
          Button { s.setDefaultPlace(o.name); model.newProjectChanged() } label: {
            HStack(spacing: 5) {
              if let place { Image(systemName: place.symbol).font(.system(size: 11)) }
              Text(verbatim: place?.word ?? o.label).font(.system(size: 12, weight: on ? .medium : .regular))
            }
            .foregroundStyle(on ? Theme.Desk.text : Theme.Desk.tertiary)
            .padding(.horizontal, 10).frame(height: 24)
            .background { if on { Capsule().fill(Theme.Desk.Home.segmentOn).shadow(color: .black.opacity(0.35), radius: 1, y: 1) } }
            .contentShape(Capsule())
          }
          .buttonStyle(PressableStyle()).disabled(!o.available).opacity(o.available ? 1 : 0.4)
          .help(o.available ? (o.name == "boxd" ? "\(o.label): agents run on boxd machines" : "\(o.label): agents run in Docker on this Mac") : "\(o.label): \(o.reason ?? "unavailable")")
          .accessibilityLabel(o.label).accessibilityAddTraits(on ? .isSelected : [])
        }
      }
      .padding(2)
      .background(Capsule().fill(Color.black.opacity(0.28)))
      .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
      .fixedSize()
      .accessibilityElement(children: .contain).accessibilityLabel("Where it runs")
    }
  }
}
#endif
