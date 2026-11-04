#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

/// The new project (ReelNew): one plain column where the planner's column will stand, and the dashed space where its
/// crew will. Shown in the reel's place while it's open.
struct NewProjectStage: View {
  @Environment(DeskModel.self) private var model
  let np: NewProjectModel
  var body: some View {
    DeskProbe.body("NewProjectStage")
    return GeometryReader { g in
      let geo = ReelGeometry.measure(bounds: g.size, count: 1, scale: NSScreen.main?.backingScaleFactor ?? 2)
      HStack(spacing: Theme.Desk.gap) {
        NewProjectColumn(np: np).frame(width: geo.width)
        // Where the crew will stand.
        RoundedRectangle(cornerRadius: Theme.Desk.columnRadius + 1, style: .continuous)
          .strokeBorder(Theme.Desk.crewDash, style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
          .accessibilityHidden(true)
      }
      .padding(.leading, ReelGeometry.inset).padding(.trailing, Theme.Desk.gap)
      .frame(height: max(0, g.size.height - Theme.Desk.gap), alignment: .top)
    }
  }
}

/// The column: no agent header yet. The planner-to-be waits with a sleepy face, smiles once you type, and the composer
/// card stands at the foot. Started, its header appears with the goal as the first message, until the run's own
/// planner column takes its place.
struct NewProjectColumn: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Namespace private var bot
  let np: NewProjectModel
  var body: some View {
    DeskProbe.body("NewProjectColumn")
    let started: Bool = { if case .started = np.form.phase { return true }; return false }()
    return VStack(spacing: 0) {
      if started {
        HStack(spacing: 8) {
          BotAvatar(traits: np.happy, size: .xs, cell: 1.5).matchedGeometryEffect(id: "bot", in: bot)
          (Text("planner").font(Theme.Desk.name).foregroundColor(Theme.Desk.text)
            + Text(verbatim: " · starting").font(Theme.Desk.meta).foregroundColor(Theme.Desk.secondary))
          Spacer(minLength: 0)
        }
        .padding(.horizontal, 12).frame(height: Theme.Desk.columnHeader)
        .transition(.opacity)
        Spacer(minLength: 0)
        // The goal, as the planner's first message, until its own thread delivers it.
        Text(verbatim: np.form.goal.trimmingCharacters(in: .whitespacesAndNewlines))
          .font(.system(size: 13)).foregroundStyle(Theme.Desk.text).textSelection(.enabled)
          .padding(.horizontal, 10).padding(.vertical, 7)
          .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.white.opacity(0.08)))
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.leading, 48).padding(.trailing, 16).padding(.bottom, 16)
          .transition(.opacity)
      } else {
        Spacer(minLength: 0)
        VStack(spacing: Theme.Desk.NewProject.greetingGap) {
          ZStack {
            // One change, no loop: the face crossfades once.
            BotAvatar(traits: np.face, size: .full, cell: Theme.Desk.NewProject.botCell)
              .id(np.form.smiling)
              .transition(.opacity)
          }
          .matchedGeometryEffect(id: "bot", in: bot)
          .animation(.easeOut(duration: 0.15), value: np.form.smiling)
          DitherShadow().padding(.top, -Theme.Desk.NewProject.shadowLift)
          (Text("Hi, I'm ") + Text(verbatim: np.name).foregroundColor(Theme.Desk.text).fontWeight(.medium) + Text(". What are we building?"))
            .font(.system(size: 13)).foregroundStyle(Theme.Desk.secondary).multilineTextAlignment(.center)
            .accessibilityLabel("Hi, I'm \(np.name), the planner. What are we building?")
        }
        .padding(.bottom, Theme.Desk.NewProject.greetingBottom)
        NewProjectComposer(np: np)
          .padding([.horizontal, .bottom], Theme.Desk.NewProject.cardMargin)
          .transition(.opacity)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).fill(Theme.Desk.column))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).strokeBorder(Theme.Desk.columnStroke, lineWidth: 0.5))
    .clipShape(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous))
    .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.3, bounce: 0), value: started)
    .accessibilityElement(children: .contain).accessibilityLabel("New project")
  }
}

/// The 1 pt checker under the bot (the board's dither shadow).
struct DitherShadow: View {
  var body: some View {
    Canvas { ctx, size in
      let w = size.width / 24, h = size.height / 2
      for x in 2..<22 { for y in 0..<2 where (x + y) % 2 == 0 {
        ctx.fill(Path(CGRect(x: CGFloat(x) * w, y: CGFloat(y) * h, width: w, height: h)), with: .color(Theme.Desk.NewProject.dither))
      } }
    }
    .frame(width: 96, height: 6)
    .accessibilityHidden(true)
  }
}

/// The composer card (ReelNew): the folder and branch on top, the goal, then one tool row (+, Local / Cloud, the model
/// with its effort bars, Start). A folder that isn't set up swaps the tool row for its next steps (the menu bar's inline
/// setup). The goal is the field's own state, handed to the model as it changes (the bot, the branch suggestion).
struct NewProjectComposer: View {
  @Environment(DeskModel.self) private var model
  let np: NewProjectModel
  @FocusState private var focused: Bool
  @State private var goal = ""

  var body: some View {
    DeskProbe.body("NewProjectComposer")
    _ = np.revision
    let form = np.form
    let starting = form.phase == .starting
    let setup = model.newProjectSetup()
    let branches = model.newProjectBranches
    let shape = RoundedRectangle(cornerRadius: Theme.Desk.NewProject.cardRadius, style: .continuous)
    return VStack(alignment: .leading, spacing: Theme.Desk.NewProject.cardGap) {
      contextRow(branches: branches)
      if branches { BranchLines(form: form) }
      TextField("", text: $goal, axis: .vertical)
        .textFieldStyle(.plain).font(Theme.Desk.NewProject.goalFont).foregroundStyle(Theme.Desk.text)
        .lineLimit(3...8).lineSpacing(3)
        .background(alignment: .topLeading) {
          if goal.isEmpty { Text("Describe a project for your agents…").font(Theme.Desk.NewProject.goalFont).foregroundStyle(Theme.Desk.tertiary).allowsHitTesting(false) }
        }
        .padding(.horizontal, 3).padding(.vertical, 2)
        .focused($focused).disabled(starting)
        .onSubmit(submit)
        .onKeyPress(.escape) { model.newProjectEscape(); return .handled }
        .accessibilityLabel("Describe a project for your agents")
      if let line = form.goalLine(branches: branches) {
        Text(verbatim: line).font(Theme.Setup.noteFont).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled).padding(.horizontal, 3)
      }
      if let setup {
        InlineSetupSection(screen: setup, flow: model.setupFlow, defaultKey: !focused, cardInset: Theme.Desk.NewProject.cardPadding.leading,
                           onPrimary: { model.setupAction($0) }, onChooseAnother: { model.chooseProjectFolder() },
                           onCancel: { model.cancelSetup() }, onLogIn: { SetupTerminal.githubLogin() })
          .transition(.opacity)
      } else {
        toolRow(starting: starting)
      }
    }
    .padding(Theme.Desk.NewProject.cardPadding)
    .background(shape.fill(Theme.Desk.NewProject.cardFill))
    .overlay(shape.strokeBorder(Theme.Desk.NewProject.cardStroke, lineWidth: 1))
    .background(shape.stroke(Theme.Composer2.ring, lineWidth: 3).padding(-1.5).opacity(focused ? 1 : 0))
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .animation(Theme.Motion.fast, value: focused)
    .animation(Theme.Motion.fast, value: setup == nil)
    .onAppear { goal = form.goal; focused = true }
    .onChange(of: goal) { _, g in model.typeGoal(g) }
    .onChange(of: np.focusSerial) { _, _ in focused = true }
    .onChange(of: form.goal) { _, g in if g != goal { goal = g } }   // the debug control file types into the model
  }

  /// The folder chip and, with goal branches, the base it starts from; the branch the work lands on gets a line of its
  /// own under them, so a long name isn't cut at narrow widths.
  @ViewBuilder private func contextRow(branches: Bool) -> some View {
    HStack(spacing: 4) {
      FolderChip(revision: np.revision)
      if branches { BaseChip(form: np.form) }
      Spacer(minLength: 0)
    }
    if branches { GoalBranchName(form: np.form) }
  }

  private func toolRow(starting: Bool) -> some View {
    HStack(spacing: 6) {
      AddMenu(revision: np.revision)
      PlaceSwitch(revision: np.revision)
      DriverChip(revision: np.revision)
      Spacer(minLength: 0)
      if starting { ProgressView().controlSize(.small).accessibilityLabel("Starting") }
      SendCircle(ready: model.newProjectCanStart, stop: false, label: "Start the project", size: 30) { submit() }
        .help("Start (Return)")
    }
    .frame(height: 32)
  }

  private func submit() {
    // Return while a folder's next steps show presses Set Up (or Set Up and Start), as the menu bar's composer does.
    if let p = model.newProjectSetup()?.primary {
      if (p.action == .setUp || p.action == .setUpAndStart) && p.enabled && !p.busy { model.setupAction(p.action) }
      return
    }
    Task { await model.startNewProject() }
  }
}

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
      Text(verbatim: text).font(Theme.Desk.NewProject.chipFont).lineLimit(1)
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
        Text(verbatim: s.base ?? "Pick a branch").font(Theme.Desk.NewProject.chipFont).lineLimit(1)
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
            .background { if on { Capsule().fill(Theme.Desk.NewProject.segmentOn).shadow(color: .black.opacity(0.35), radius: 1, y: 1) } }
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

/// The model that drives the run (its planner) and its reasoning effort as bars, as the menu bar's driver chip offers
/// them; a driver the daemon reports unavailable is listed, disabled, with its reason.
struct DriverChip: View {
  @Environment(DeskModel.self) private var model
  /// The column's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  var body: some View {
    let s = model.store
    if let current = s.startDriver {
      Menu {
        Picker("Driver", selection: Binding(get: { current.provider }, set: { s.pickDriver($0); model.newProjectChanged() })) {
          ForEach(s.startDrivers.filter(\.available)) { d in Text(verbatim: d.label + (d.model.map { " · \($0)" } ?? "")).tag(d.provider) }
        }
        .pickerStyle(.inline)
        ForEach(s.startDrivers.filter { !$0.available }) { d in Button(d.label + (d.reason.map { " (\($0))" } ?? " (unavailable)")) {}.disabled(true) }
        if let levels = current.efforts, !levels.isEmpty {
          Divider()
          Picker("Effort", selection: Binding(get: { s.startEffort ?? EffortBars.auto }, set: { s.pickEffort($0 == EffortBars.auto ? nil : $0); model.newProjectChanged() })) {
            if current.effort == nil { Text("Auto").tag(EffortBars.auto) }
            ForEach(Array(levels.enumerated()), id: \.element) { i, l in
              Label { Text(verbatim: EffortBars.title(l)) } icon: { Image(systemName: "cellularbars", variableValue: EffortBars.value(i, of: levels.count)) }.tag(l)
            }
          }
          .pickerStyle(.inline)
        }
      } label: {
        let levels = current.efforts ?? []
        HStack(spacing: 6) {
          Text(verbatim: Self.modelName(current)).font(.system(size: 12)).lineLimit(1)
          if let i = s.startEffort.flatMap({ levels.firstIndex(of: $0) }) { EffortBars(level: i, of: levels.count) }
          Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
        }
        .foregroundStyle(Theme.Desk.secondary)
        .padding(.horizontal, 8).frame(height: 28)
        .contentShape(Rectangle())
      }
      .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
      .help(([current.label, current.model, s.startEffort.map { "\(EffortBars.title($0)) effort" }] as [String?]).compactMap { $0 }.joined(separator: " · "))
      .accessibilityLabel("Driver: \(current.label)" + (s.startEffort.map { ", \(EffortBars.title($0)) effort" } ?? ""))
    } else if let shown = s.startDrivers.first(where: { $0.isDefault == true }) ?? s.startDrivers.first {
      Text(verbatim: Self.modelName(shown)).font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary)
        .padding(.horizontal, 8).frame(height: 28)
        .help(shown.reason ?? "No AI can drive a run yet")
        .accessibilityLabel("Driver unavailable: \(shown.reason ?? "no AI can drive a run yet")")
    }
  }

  /// "claude-opus-5-5" → "Opus 5.5" (the board's model name); anything else is the driver's label.
  static func modelName(_ d: DriverInfo) -> String {
    guard let m = d.model, m.hasPrefix("claude-") else { return d.label }
    // No dated suffix ("-20250929").
    let parts: [String] = m.dropFirst(7).split(separator: "-").map(String.init).filter { !($0.count == 8 && $0.allSatisfy(\.isNumber)) }
    guard let family = parts.first, family.allSatisfy(\.isLetter) else { return d.label }
    let version = parts.dropFirst().filter { $0.allSatisfy(\.isNumber) }.joined(separator: ".")
    let name = family.capitalized
    return version.isEmpty ? name : "\(name) \(version)"
  }

}
#endif
