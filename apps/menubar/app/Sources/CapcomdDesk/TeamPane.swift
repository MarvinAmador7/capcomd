#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// A profile as a pane (CrewProfile.dc.html, the approved board): the reel's pane chrome and 44 pt header, then a centred
// 680 pt column: the bot and the title (both edited in place), the launcher (Home's composer card and tool row), the
// sheet tucked under it (SOUL.md, then the settings row that opens in place), Recent work, and where it came from. Each
// part whose route the daemon lacks is left out. Labels and values only.

/// The Team panes in the pane's place: one, or splits side by side (8 pt from the top, right and bottom, 8 pt apart);
/// expanded, the focused one has the whole window.
struct TeamDeck: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("TeamDeck")
    let t = model.team
    let expanded = model.nav.expanded
    let panes = expanded ? t.panes.filter { $0.id == t.focused } : t.panes
    let m = expanded ? 0 : PaneMetrics.inset
    return HStack(spacing: PaneMetrics.gap) {
      ForEach(panes) { p in
        // A pane keeps its views when its profile changes (a row, ↑ ↓): only what differs is drawn again.
        TeamPaneView(pane: p, focused: p.id == t.focused, split: t.panes.count > 1, expanded: expanded)
      }
    }
    .padding(.top, m).padding(.trailing, m).padding(.bottom, m)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

/// One profile's pane: the reel's pane (11 pt corners, the column's fill, its .5 pt ring; in a split the focused one has
/// the blue 1 pt ring), its header and its body. A click anywhere in it focuses it.
struct TeamPaneView: View {
  @Environment(DeskModel.self) private var model
  let pane: TeamPane
  let focused: Bool
  let split: Bool
  let expanded: Bool
  var body: some View {
    DeskProbe.body("TeamPane", id: pane.key)
    let s = model.team.slice(pane.key)
    let shape = RoundedRectangle(cornerRadius: expanded ? 0 : Theme.Desk.columnRadius, style: .continuous)
    return VStack(spacing: 0) {
      TeamPaneHead(slice: s, pane: pane, focused: focused, split: split, expanded: expanded)
      TeamProfileBody(slice: s)
    }
    .background(shape.fill(Theme.Desk.column))
    .clipShape(shape)
    .overlay {
      if !expanded {
        shape.strokeBorder(focused && split ? Theme.accent : Theme.Desk.columnStroke, lineWidth: focused && split ? 1 : 0.5)
      }
    }
    .simultaneousGesture(TapGesture().onEnded { model.focusTeamPane(pane.id) })
    .accessibilityElement(children: .contain)
    .accessibilityLabel(s.title)
  }
}

// MARK: the header

/// RexMain `.ph` for a profile: its bot (24 pt), its name, its role word, "· ready" (or why it isn't), then the pane's
/// controls: split right, •••, expand. Another pane of a split: × and expand. Expanded: 52 pt in the title bar's band,
/// the Needs you hand and arrows-in.
struct TeamPaneHead: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let slice: TeamProfileSlice
  let pane: TeamPane
  let focused: Bool
  let split: Bool
  let expanded: Bool
  var body: some View {
    DeskProbe.body("TeamPaneHead", id: pane.key)
    let row = slice.row
    let role = row.map(TeamRole.of) ?? .builds
    let name = TeamKey.split(pane.key).name
    let ready = row?.ready ?? true
    return HStack(spacing: 8) {
      BotAvatar(traits: model.team.bot(name: name, role: role, seed: slice.avatarSeed), size: .small, cell: 1)
        .frame(width: Theme.Desk.Team.headerBot, height: Theme.Desk.Team.headerBot)
      Text(verbatim: slice.title).font(Theme.PaneHead.title).foregroundStyle(Theme.PaneHead.titleText)
        .lineLimit(1).truncationMode(.tail).layoutPriority(1)
      Text(verbatim: role.rawValue).font(Theme.PaneHead.role).foregroundStyle(Theme.PaneHead.roleText).fixedSize()
      Text(verbatim: "· " + (ready ? "ready" : (row?.readiness ?? "not ready")))
        .font(Theme.PaneHead.state).foregroundStyle(Theme.PaneHead.stateText).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        if expanded {
          NeedsHand()
          SideButton(symbol: "arrow.down.right.and.arrow.up.left", on: true, help: "Collapse pane (Esc)", label: "Collapse pane") {
            paneMotion(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.2)) { model.collapsePane() }
          }
          .modifier(EscLeaves())
        } else {
          if focused {
            PaneButton(symbol: "rectangle.split.2x1", help: "Split right (⌘D)", label: "Split right") { model.splitTeam() }
            TeamPaneMore(key: pane.key, path: row?.path)
          } else {
            PaneButton(symbol: "xmark", help: "Close this split", label: "Close this split", size: 12) { model.closeTeamPane(pane.id) }
          }
          PaneButton(symbol: "arrow.up.left.and.arrow.down.right", help: "Expand pane (⇧⌘↩)", label: "Expand pane") {
            paneMotion(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.22)) { model.expandTeamPane(pane.id) }
          }
        }
      }
    }
    .lineLimit(1)
    .padding(.leading, expanded ? Theme.Desk.titleLeading : 14).padding(.trailing, expanded ? 12 : 8)
    .frame(height: expanded ? PaneMetrics.expandedHeader : Theme.Desk.paneHeader)
    .contentShape(Rectangle())
    .accessibilityElement(children: .contain)
  }
}

/// The pane's •••: copy the profile's name; show its file.
struct TeamPaneMore: View {
  @Environment(DeskModel.self) private var model
  let key: String
  let path: String?
  var body: some View {
    Menu {
      Button("Copy Profile Name") { model.copyProfileName(key) }
      if let path { Button("Show in Finder") { model.showProfileFile(path) } }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.Desk.paneControl)
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .frame(width: 26, height: 26)
    .help("More")
    .accessibilityLabel("More")
  }
}

// MARK: the body

/// The centred column: who it is, the launcher and its sheet, Recent work, the foot. The bottom fades as the board's.
struct TeamProfileBody: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  var body: some View {
    DeskProbe.body("TeamProfileBody", id: slice.key)
    let t = Theme.Desk.Team.self
    return ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 0) {
        TeamIdentity(slice: slice)
        TeamLauncher(slice: slice).padding(.top, t.launcherTop).zIndex(1)
        TeamSheet(slice: slice)
        if let work = slice.work, !work.isEmpty { TeamWork(slice: slice, items: work) }
        TeamFoot(slice: slice)
      }
      .frame(maxWidth: t.column, alignment: .leading)
      .padding(.horizontal, t.gutter)
      .padding(.top, t.top).padding(.bottom, t.bottom)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.automatic)
    .mask(LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: t.fadeFrom), .init(color: .clear, location: 1)],
                         startPoint: .top, endPoint: .bottom))
  }
}

/// The bot (64 pt; a click gives it a new face, where the daemon keeps one) beside the title, edited in place.
struct TeamIdentity: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  @State private var title = ""
  @State private var hover = false
  @FocusState private var editing: Bool
  var body: some View {
    let t = Theme.Desk.Team.self
    let team = model.store.team
    let name = TeamKey.split(slice.key).name
    let role = slice.row.map(TeamRole.of) ?? .builds
    let canFace = team.editable && team.has(Capability.profilesAvatar)
    let box = RoundedRectangle(cornerRadius: t.botRadius, style: .continuous)
    return HStack(spacing: t.headerGap) {
      Button { model.newFace(slice.key) } label: {
        BotAvatar(traits: model.team.bot(name: name, role: role, seed: slice.avatarSeed), size: .full, cell: t.botCell)
          .frame(width: t.botBox, height: t.botBox)
          .background(box.fill(t.surface))
          .overlay(box.strokeBorder(hover && canFace ? t.botHover : t.botRing, lineWidth: 0.5))
          .contentShape(box)
      }
      .buttonStyle(PressableStyle())
      .disabled(!canFace)
      .onHover { hover = $0 }
      .help(canFace ? "Change its bot" : "")
      .accessibilityLabel("Change its bot")
      if team.editable {
        TextField("", text: $title)
          .textFieldStyle(.plain).font(t.title).foregroundStyle(Theme.Affect.t1)
          .frame(height: t.titleLine)
          .padding(.horizontal, t.titlePad).padding(.leading, -t.titlePad)
          .background(RoundedRectangle(cornerRadius: t.titleRadius, style: .continuous)
            .strokeBorder(hover || editing ? t.titleRing : .clear, lineWidth: 0.5).padding(.leading, -t.titlePad))
          .focused($editing)
          .onSubmit(commit)
          .onChange(of: editing) { _, on in if !on { commit() } }
          .accessibilityLabel("Title")
      } else {
        Text(verbatim: slice.title).font(t.title).foregroundStyle(Theme.Affect.t1).lineLimit(1)
          .frame(maxWidth: .infinity, alignment: .leading)
      }
    }
    .onAppear { title = slice.title }
    .onChange(of: slice.title) { _, v in if !editing { title = v } }
  }

  /// Return or leaving the field: the title is written; emptied, it goes back to the profile's name.
  private func commit() {
    let v = title.trimmingCharacters(in: .whitespacesAndNewlines)
    guard v != slice.title else { return }
    let name = TeamKey.split(slice.key).name
    model.setProfile(slice.key, ["identity.title": v.isEmpty || v == name ? nil : v])
  }
}

// MARK: the launcher

/// Home's composer card and tool row for a run of this profile: its project as the chip (the user's own run where the
/// composer's project is), the goal ("Give <name> a task…"), +, This Mac / Cloud, its model, the mic, send. A planner
/// starts only where the daemon takes `planner`; otherwise there is no send.
struct TeamLauncher: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  @State private var goal = ""
  @FocusState private var focused: Bool
  var body: some View {
    _ = model.actionsRevision   // the store's run options and the picked place, which the store doesn't publish
    let s = model.store
    let team = s.team
    let (repo, _) = TeamKey.split(slice.key)
    let busy = slice.start == .starting
    let canStart = team.canStart(slice.key)
    return VStack(alignment: .leading, spacing: Theme.Desk.Home.cardGap) {
      HStack(spacing: 4) { projectChip(repo); Spacer(minLength: 0) }
      TextField("", text: $goal, axis: .vertical)
        .textFieldStyle(.plain).font(Theme.Desk.Home.goalFont).tracking(Theme.Desk.Home.goalTracking).foregroundStyle(Theme.Desk.text)
        .lineLimit(2...8).lineSpacing(4)
        .frame(minHeight: 50, alignment: .topLeading)
        .background(alignment: .topLeading) {
          if goal.isEmpty {
            Text(verbatim: "Give \(slice.title) a task…").font(Theme.Desk.Home.goalFont).tracking(Theme.Desk.Home.goalTracking)
              .foregroundStyle(Theme.Desk.tertiary).allowsHitTesting(false).accessibilityHidden(true)
          }
        }
        .padding(4)
        .focused($focused).disabled(busy)
        .onSubmit(submit)
        .accessibilityLabel("Task for \(slice.title)")
      if let why = refusal { Text(verbatim: why).font(Theme.Setup.noteFont).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true).padding(.horizontal, 4) }
      HStack(spacing: Theme.Composer2.chipGap) {
        if repo == nil {
          ComposerAddMenu(label: "Add a project folder") {
            Button("Choose Project Folder…") { chooseFolder() }
            if s.prefs.startRepo != nil { Button("Use the Default Project") { model.useDefaultProject() } }
          }
        }
        ComposerPlaceSwitch(places: s.runOptions.sandboxes, current: s.startSandbox?.name) { s.setDefaultPlace($0) }
        Spacer(minLength: 0)
        TeamModelChip(slice: slice)
        if busy { ProgressView().controlSize(.small).accessibilityLabel("Starting") }
        ComposerMicButton { focused = true }.disabled(busy)
        if canStart {
          SendCircle(ready: !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !busy, stop: false, label: "Start \(slice.title)") { submit() }
            .help("Start (Return)")
        }
      }
      .frame(height: Theme.Desk.Home.toolRow)
    }
    .modifier(ComposerCard(focused: focused))
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .animation(.easeOut(duration: 0.18), value: focused)
    .onChange(of: slice.start) { _, st in if case .started? = st { goal = "" } }
    .onChange(of: slice.key) { _, _ in goal = "" }   // another profile in this pane: a fresh task
    .accessibilityElement(children: .contain).accessibilityLabel("Give \(slice.title) a task")
  }

  private var refusal: String? {
    switch slice.start {
    case .failed(let m)?, .needsRepo(let m)?: m
    default: nil
    }
  }

  @ViewBuilder private func projectChip(_ repo: String?) -> some View {
    if let repo {
      let title = model.team.roster.first { $0.id == repo }?.title ?? (repo as NSString).lastPathComponent
      Chip2(icon: "folder", text: title, onRemove: nil).fixedSize().help(repo)
    } else {
      ComposerFolderChip(model.store.prefs.startRepo.map { .checkout(path: $0) } ?? .defaultProject,
                         remove: { model.useDefaultProject() }, choose: { chooseFolder() })
    }
  }

  private func chooseFolder() {
    Task {
      guard let f = await model.chooseFolder() else { return }
      model.store.prefs.startRepo = f
      await model.store.refreshRunOptions()
    }
  }

  private func submit() {
    let g = goal.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !g.isEmpty, model.store.team.canStart(slice.key), slice.start != .starting else { return }
    model.startTeamRun(slice.key, goal: g)
  }
}

/// The model chip (the composer's driver chip: the harness's mark, the profile's model, its effort as bars): its menu
/// picks the profile's model and effort, written to its file.
struct TeamModelChip: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  var body: some View {
    let s = model.store
    let row = slice.row
    let provider = Provider(wire: row?.provider)
    let driver = s.runOptions.drivers.first { $0.provider == row?.provider }
    let models = driver?.models ?? []
    let efforts = driver?.efforts ?? []
    let current: String? = slice.pending["harness.model"] ?? row?.model
    let effort: String? = slice.pending["harness.effort"] ?? row?.effort
    let names = Dictionary(s.runOptions.drivers.flatMap { $0.models ?? [] }.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    let text = current.map { names[$0] ?? $0 } ?? (row?.provider).map(TeamSummary.providerLabel) ?? "Model"
    let level = effort.flatMap { efforts.firstIndex(of: $0) }.map { ($0, efforts.count) }
    let canPick = s.team.editable && (!models.isEmpty || !efforts.isEmpty)
    return Menu {
      if !models.isEmpty {
        Section(TeamSummary.providerLabel(row?.provider ?? "")) {
          ForEach(models) { m in
            Toggle(isOn: Binding(get: { m.id == current }, set: { _ in model.setProfile(slice.key, ["harness.model": m.id]) })) { Text(verbatim: m.name) }
          }
        }
      }
      if !efforts.isEmpty {
        Section("Effort") {
          ForEach(efforts, id: \.self) { e in
            Toggle(isOn: Binding(get: { e == effort }, set: { _ in model.setProfile(slice.key, ["harness.effort": e]) })) { Text(verbatim: EffortBars.title(e)) }
          }
        }
      }
    } label: {
      DriverChipLabel(provider: provider, text: text, effort: level.map { (level: $0.0, of: $0.1) }, available: row?.ready ?? true)
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .disabled(!canPick)
    .help(text)
    .accessibilityLabel("Model: \(text)")
  }
}
#endif
