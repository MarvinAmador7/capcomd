#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import CapcomdBot
import CapcomdUI
import PerfLoopProbe

// Team (design/desktop/team, SPEC §2.2): the agent profiles, by project, in the opened sidebar; the selected one as a
// pane. The data is the store's `TeamStore`, which reports its own changes (never the store's run changes); this keeps
// one small observable per profile the panes show and the roster's, each assigned only when it differs.

/// A Team pane: the profile it shows (its `TeamKey`).
package struct TeamPane: Hashable, Sendable, Identifiable {
  package var id: Int
  package var key: String
}

/// The Team screen's state: whether it shows, the roster, its panes.
@Observable @MainActor
package final class TeamModel {
  /// The Team button is pressed: the sidebar lists the roster and the main area shows the profile's pane.
  package internal(set) var isOpen = false { didSet { Mutations.record("TeamModel.isOpen") } }
  /// The daemon lists profiles (capability profiles): the Team button works.
  package internal(set) var available = false { didSet { Mutations.record("TeamModel.available") } }
  package internal(set) var roster: [TeamGroup] = [] { didSet { Mutations.record("TeamModel.roster") } }
  /// The roster was read at least once.
  package internal(set) var loaded = false { didSet { Mutations.record("TeamModel.loaded") } }
  /// Team has shown once: from then on its panes stay built while it is closed.
  package internal(set) var everOpened = false { didSet { Mutations.record("TeamModel.everOpened") } }
  /// Left to right; the focused one is the selected profile.
  package internal(set) var panes: [TeamPane] = [] { didSet { Mutations.record("TeamModel.panes") } }
  package internal(set) var focused = 0 { didSet { Mutations.record("TeamModel.focused") } }
  @ObservationIgnored var nextPaneId = 1
  @ObservationIgnored var slices: [String: TeamProfileSlice] = [:]
  @ObservationIgnored var bots: [String: BotTraits] = [:]
  /// A run started from a launcher, opened once the feed lists it.
  @ObservationIgnored var runToOpen: String?

  /// The focused pane's profile: the roster's selected row.
  package var selectedKey: String? { panes.first { $0.id == focused }?.key ?? panes.first?.key }
  /// The profiles the other panes show (their rows are tinted, as split agents' are).
  package var visibleKeys: Set<String> { panes.count > 1 ? Set(panes.map(\.key)) : [] }
  package var members: [TeamMember] { roster.flatMap(\.members) }
  package func member(_ key: String) -> TeamMember? { members.first { $0.id == key } }

  /// A profile's slice, made the first time a pane or a row asks for it.
  package func slice(_ key: String) -> TeamProfileSlice {
    if let s = slices[key] { return s }
    let s = TeamProfileSlice(key: key)
    slices[key] = s
    return s
  }

  /// A profile's bot: the daemon's seed for it when it has one (profiles.avatar), else the app's own derivation from
  /// its name and role, as an agent's is from its id and role. Made once per seed and role.
  package func bot(name: String, role: TeamRole, seed: String?) -> BotTraits {
    let s = seed ?? "profile:\(name)"
    let k = "\(s)|\(role.botRole)"
    if let b = bots[k] { return b }
    let b = botTraits(seed: s, role: role.botRole)
    bots[k] = b
    return b
  }
}

/// One profile as its pane and its roster row show it, refreshed from the TeamStore for that profile only.
@Observable @MainActor
package final class TeamProfileSlice {
  package let key: String
  package private(set) var row: ProfileRow? { didSet { Mutations.record("TeamProfileSlice.row", id: key) } }
  package private(set) var detail: ProfileDetail? { didSet { Mutations.record("TeamProfileSlice.detail", id: key) } }
  package private(set) var work: [ProfileWorkItem]? { didSet { Mutations.record("TeamProfileSlice.work", id: key) } }
  package private(set) var persona: ProfilePersona? { didSet { Mutations.record("TeamProfileSlice.persona", id: key) } }
  package private(set) var pending: [String: String?] = [:] { didSet { Mutations.record("TeamProfileSlice.pending", id: key) } }
  package private(set) var refusal: String? { didSet { Mutations.record("TeamProfileSlice.refusal", id: key) } }
  package private(set) var start: StartState? { didSet { Mutations.record("TeamProfileSlice.start", id: key) } }
  /// The settings row opened in place; SOUL.md opened for editing.
  package var settingsOpen = false { didSet { Mutations.record("TeamProfileSlice.settingsOpen", id: key) } }
  package var soulOpen = false { didSet { Mutations.record("TeamProfileSlice.soulOpen", id: key) } }
  init(key: String) { self.key = key }

  func sync(_ t: TeamStore) {
    let r = t.rows[key]; if row != r { row = r }
    let d = t.details[key]; if detail != d { detail = d }
    let w = t.work[key]; if work != w { work = w }
    let p = t.personas[key]; if persona != p { persona = p }
    let pe = t.pending[key] ?? [:]; if pending != pe { pending = pe }
    let rf = t.refusals[key]; if refusal != rf { refusal = rf }
    let st = t.starts[key]; if start != st { start = st }
  }

  /// A field's value as the row shows it now: the one on its way, else the daemon's.
  package func value(_ f: ProfileField) -> String? { pending[f.id] ?? f.value }
  /// The bot's seed now: a new one on its way, else the daemon's.
  package var avatarSeed: String? { pending["identity.avatar.seed"] ?? row?.avatarSeed }
  package var title: String {
    if case .some(.some(let t)) = pending["identity.title"], !t.isEmpty { return t }
    return row?.displayName ?? TeamKey.split(key).name
  }
}

extension DeskModel {
  // MARK: Team

  /// The Team button (the sidebar's foot, the folded rail): the sidebar opens on the roster, and the selected profile
  /// shows in the pane's place. Again: back to what was there.
  package func toggleTeam() { if team.isOpen { closeTeam() } else { openTeam() } }

  package func openTeam() {
    guard team.available else { return }
    menuOpen = false; paletteOpen = false; stopAsked = false
    collapsePane()
    needs.close(restore: false)
    leaveHome()
    if !team.everOpened { team.everOpened = true }
    team.isOpen = true
    if !nav.sidebarOpen { setSidebar(open: true) }
    nav.focusList()
    if team.panes.isEmpty, let first = team.members.first { showProfile(first.id) }
    Task { [weak self] in await self?.store.team.refresh() }
  }

  /// Leaves Team for what the window shows without it: the open project's panes, else Home.
  package func closeTeam() {
    guard team.isOpen else { return }
    collapsePane()
    team.isOpen = false
    if openProjectId == nil, newProject == nil, !needs.isOpen { openHome(focus: false) }
  }

  /// A roster row (or ↑ ↓ in the roster): that profile in the focused pane. ⌘-click: beside it.
  package func showProfile(_ key: String, split: Bool = false) {
    if split, team.panes.contains(where: { $0.key != key }), !team.panes.contains(where: { $0.key == key }) { return splitTeam(key) }
    if let p = team.panes.first(where: { $0.key == key }) { if team.focused != p.id { team.focused = p.id } }
    else if let i = team.panes.firstIndex(where: { $0.id == team.focused }) { team.panes[i].key = key }
    else { team.panes = [TeamPane(id: team.nextPaneId, key: key)]; team.focused = team.nextPaneId; team.nextPaneId += 1 }
    loadProfile(key)
  }

  func loadProfile(_ key: String) {
    let s = team.slice(key)
    s.sync(store.team)
    Task { [weak self] in await self?.store.team.load(key) }
  }

  /// ⌘D or the pane's split button: a pane beside the focused one with the next profile no pane shows; refused (the
  /// system beep) when the panes would be narrower than a split allows.
  package func splitTeam(_ key: String? = nil) {
    guard team.isOpen, !nav.expanded else { return }
    let shown = Set(team.panes.map(\.key))
    let width = paneArea.width > 0 ? paneArea.width : 1100
    let fits = (width - PaneMetrics.gap * CGFloat(team.panes.count)) / CGFloat(team.panes.count + 1) >= PaneMetrics.minWidth
    guard fits, let k = key ?? team.members.first(where: { !shown.contains($0.id) })?.id else { return beep() }
    let at = (team.panes.firstIndex { $0.id == team.focused } ?? team.panes.count - 1) + 1
    let p = TeamPane(id: team.nextPaneId, key: k)
    team.nextPaneId += 1
    team.panes.insert(p, at: min(at, team.panes.count))
    team.focused = p.id
    loadProfile(k)
  }

  /// ×, or ⌘W with two or more: the split closes and the pane before it takes the focus.
  package func closeTeamPane(_ id: Int) {
    guard team.panes.count > 1, let i = team.panes.firstIndex(where: { $0.id == id }) else { return }
    if nav.expanded, team.focused == id { nav.expanded = false }
    team.panes.remove(at: i)
    if team.focused == id { team.focused = team.panes[max(0, i - 1)].id }
  }
  package func focusTeamPane(_ id: Int) { if team.focused != id { team.focused = id } }

  /// The arrows-out: the pane takes the window (the sidebar hides), as an agent's does.
  package func expandTeamPane(_ id: Int) {
    guard team.isOpen else { return }
    focusTeamPane(id)
    if !nav.expanded { nav.expanded = true }
  }

  /// ↑ ↓ in the roster: the previous or next profile shows.
  package func moveTeamSelection(_ by: Int) {
    let all = team.members.map(\.id)
    guard !all.isEmpty else { return }
    let i = team.selectedKey.flatMap { all.firstIndex(of: $0) } ?? (by > 0 ? -1 : all.count)
    showProfile(all[min(max(0, i + by), all.count - 1)])
  }

  /// The TeamStore changed: the roster or one profile's slice, assigned only where it differs.
  func teamChanged(_ c: TeamStore.Change) {
    let t = store.team
    switch c {
    case .roster:
      if team.roster != t.roster { team.roster = t.roster }
      if team.loaded != t.rosterLoaded { team.loaded = t.rosterLoaded }
      // A profile gone from the roster leaves its pane for the first one there; the first read picks one.
      let keys = Set(team.members.map(\.id))
      if team.isOpen, team.panes.isEmpty, let first = team.members.first { showProfile(first.id) }
      for p in team.panes where !keys.contains(p.key) && t.rosterLoaded {
        if let first = team.members.first, let i = team.panes.firstIndex(of: p) { team.panes[i].key = first.id; loadProfile(first.id) }
      }
      for s in team.slices.values { s.sync(t) }
    case .profile(let key):
      team.slices[key]?.sync(t)
      if case .started(let runId)? = t.starts[key] {
        team.runToOpen = runId
        t.clearStart(key)
        openStartedTeamRun()
      }
    }
  }

  /// Follows the store's changes the Team screen cares about: whether the daemon lists profiles, and the run a launcher
  /// started (its project opens, at its first agent, once the feed lists it).
  func teamStoreChanged() {
    let a = store.team.available
    if team.available != a { team.available = a }
    if team.runToOpen != nil { openStartedTeamRun() }
  }

  private func openStartedTeamRun() {
    guard let runId = team.runToOpen, decks.contains(where: { $0.runId == runId }), !store.reelColumns(runId: runId).isEmpty else { return }
    team.runToOpen = nil
    closeTeam()
    show(run: runId)
  }

  /// Send in a profile's launcher: a run of that profile on the goal, where the composer's pills say.
  package func startTeamRun(_ key: String, goal: String) {
    let place = store.startSandbox?.name
    Task { [weak self] in _ = await self?.store.team.start(key, goal: goal, sandbox: place) }
  }

  /// A row's value changed (a pick, a toggle, − or +, a field's Return): written to the profile's own file at once.
  package func setProfile(_ key: String, _ values: [String: String?]) {
    Task { [weak self] in await self?.store.team.set(key, values) }
  }

  /// A click on the bot: a new face (the daemon keeps its seed, capability profiles.avatar).
  package func newFace(_ key: String) {
    let name = TeamKey.split(key).name
    setProfile(key, ["identity.avatar.seed": "\(name)-\(String(UInt32.random(in: 0...UInt32.max), radix: 36))"])
  }

  package func savePersona(_ key: String, text: String) {
    Task { [weak self] in await self?.store.team.savePersona(key, text: text) }
  }

  /// Show in Finder: the profile's file, selected.
  package func showProfileFile(_ path: String) {
    NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
  }

  /// Check for updates: `capcomd profiles update <name> --dry-run` in Terminal (the project's checkout for a project's
  /// profile), which says what an update would change.
  package func checkProfileUpdates(_ key: String) {
    let (repo, name) = TeamKey.split(key)
    SetupTerminal.profileUpdate(name: name, project: repo)
  }

  /// The pane's ••• menu.
  package func copyProfileName(_ key: String) { copyText(TeamKey.split(key).name) }
}
#endif
