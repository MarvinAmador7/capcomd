#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdThread
import CapcomdBot
import CapcomdUI
import PerfLoopProbe

// State for the desktop window (design/desktop/SPEC.md §1, §6). The store reports what each change touched; this model
// keeps one small observable slice per agent and per thread, and assigns a slice only when its value differs. A view
// reads only its own slice, so a thread item arriving re-renders that column's rows and nothing else.
//
// Each observed property that drives a body reports its sets to `Mutations` (PerfLoopProbe, CAPABILITIES.md C7), so the
// bench can say which change preceded which bodies. With no sink attached (the app) that is a nil check per set.

/// One agent as its column header and tab show it.
@Observable @MainActor
package final class AgentSlice {
  package let id: String
  /// Bumped by Message the planner… (⌘L): its message box takes the focus.
  package private(set) var boxFocus = 0 { didSet { Mutations.record("AgentSlice.boxFocus", id: id) } }
  func focusBox() { boxFocus += 1 }
  package private(set) var header: ColumnHeader { didSet { Mutations.record("AgentSlice.header", id: id) } }
  package private(set) var bot: BotTraits? { didSet { Mutations.record("AgentSlice.bot", id: id) } }
  /// The approval this agent waits on, if any.
  package private(set) var approval: PendingApproval? { didSet { Mutations.record("AgentSlice.approval", id: id) } }
  /// Whether the column shows its thread (DeskModel's warm set); a cold column is its header and box only.
  package private(set) var warm = false { didSet { Mutations.record("AgentSlice.warm", id: id) } }
  /// Its column is on screen (the tab is bracketed) / focused. Kept per agent so a scroll or a focus change re-renders
  /// the columns and tabs whose state changed, not every one that read the model's position.
  package private(set) var onScreen = false { didSet { Mutations.record("AgentSlice.onScreen", id: id) } }
  package private(set) var focused = false { didSet { Mutations.record("AgentSlice.focused", id: id) } }
  /// The run's goal branch, on the planner's (root) column only: its name in the header while it works, then the ready
  /// card docked at the column's foot (GoalCard).
  package private(set) var goal: GoalCard? { didSet { Mutations.record("AgentSlice.goal", id: id) } }
  /// Where it is being renamed (a double-click on its tab or its column header), nil while it isn't.
  package private(set) var renaming: RenamePlace? { didSet { Mutations.record("AgentSlice.renaming", id: id) } }
  /// Why its last rename didn't go through (the old title is back); nil once a later one does.
  package private(set) var renameFailure: String? { didSet { Mutations.record("AgentSlice.renameFailure", id: id) } }
  /// The usage-limit pause its run is in, when its column shows it as an ask (the Needs you reel).
  package private(set) var limit: NeedsLimit? { didSet { Mutations.record("AgentSlice.limit", id: id) } }
  init(_ h: ColumnHeader) { id = h.agentId; header = h }
  func set(limit l: NeedsLimit?) { if limit != l { limit = l } }
  func set(renaming r: RenamePlace?) { if renaming != r { renaming = r } }
  func set(renameFailure f: String?) { if renameFailure != f { renameFailure = f } }
  func set(goal g: GoalCard?) { if goal != g { goal = g } }
  func set(warm w: Bool) { if warm != w { warm = w } }
  func set(onScreen o: Bool) { if onScreen != o { onScreen = o } }
  func set(focused f: Bool) { if focused != f { focused = f } }
  func set(_ h: ColumnHeader) { if header != h { header = h } }
  func set(bot b: BotTraits?) { if bot != b { bot = b } }
  func set(approval a: PendingApproval?) { if approval != a { approval = a } }
}

/// One agent's thread as its column shows it.
@Observable @MainActor
package final class ThreadSlice {
  package private(set) var entries: [ThreadEntry] = [] { didSet { Mutations.record("ThreadSlice.entries") } }
  package private(set) var pending: [PendingSteer] = [] { didSet { Mutations.record("ThreadSlice.pending") } }
  package private(set) var unavailable: DetailUnavailable? { didSet { Mutations.record("ThreadSlice.unavailable") } }
  @ObservationIgnored let agentId: String
  /// Development only (DeskDebug, CAPCOMD_DESK_THREAD_LOG): told each time a column's entries change. Nil otherwise.
  @ObservationIgnored package static var trace: (@MainActor (_ agentId: String, _ entries: [ThreadEntry]) -> Void)?
  /// Read newest first (`agents.thread_tail`): where the shown thread starts, nil when it shows everything; and whether
  /// the page above it is on its way.
  package private(set) var top: Int? { didSet { Mutations.record("ThreadSlice.top") } }
  package private(set) var loadingEarlier = false { didSet { Mutations.record("ThreadSlice.loadingEarlier") } }
  init(agentId: String) { self.agentId = agentId }
  func set(entries e: [ThreadEntry], pending p: [PendingSteer], unavailable u: DetailUnavailable?, top t: Int? = nil, loadingEarlier l: Bool = false) {
    if entries != e { entries = e; Self.trace?(agentId, e) }
    if pending != p { pending = p }
    if unavailable != u { unavailable = u }
    if top != t { top = t }
    if loadingEarlier != l { loadingEarlier = l }
  }
}

/// Home's Running cards (HomeRun), refreshed only while Home shows and only when a run, an approval or the projects
/// changed; assigned only when they differ.
@Observable @MainActor
package final class HomeSlice {
  package private(set) var runs: [HomeRun] = [] { didSet { Mutations.record("HomeSlice.runs") } }
  func set(_ r: [HomeRun]) { if runs != r { runs = r } }
}

/// Media bytes loaded through the daemon; rare, so one observed dictionary is enough.
@Observable @MainActor
package final class MediaSlice { package var items: [MediaKey: Fetched<Data>] = [:] { didSet { Mutations.record("MediaSlice.items") } } }

@Observable @MainActor
package final class DeskModel {
  package enum Link: Equatable { case connecting, needsToken, ready }

  /// The app's one store (the session's, which the menu bar panel reads too), or the bench's.
  @ObservationIgnored package private(set) var store: CapcomdStore
  /// The app's session (token, pairing, starting the daemon, the store), shared with the menu bar; nil for the bench
  /// and tests.
  @ObservationIgnored package let session: AppSession?
  @ObservationIgnored private var connected = false
  package private(set) var link: Link = .connecting { didSet { Mutations.record("DeskModel.link") } }
  /// The daemon refused the token it was given (rather than there being none).
  package private(set) var tokenRejected = false { didSet { Mutations.record("DeskModel.tokenRejected") } }
  /// The daemon's feed is down (it keeps retrying): the window says so instead of showing stale state as live.
  package private(set) var unreachable = false { didSet { Mutations.record("DeskModel.unreachable"); if !unreachable { session?.reachable() } } }
  /// The daemon's version (`GET /v1/health`), for the version check.
  package private(set) var daemonVersion: String? { didSet { Mutations.record("DeskModel.daemonVersion") } }
  /// The daemon has answered: until then an empty title bar means "not read yet", not "nothing running".
  package private(set) var loaded = false { didSet { Mutations.record("DeskModel.loaded") } }
  /// Every project with something to show, oldest first (never reordered by activity).
  package private(set) var decks: [DeckInfo] = [] { didSet { Mutations.record("DeskModel.decks") } }
  /// The project the reel shows, and its run.
  package private(set) var openProjectId: String? { didSet { Mutations.record("DeskModel.openProjectId") } }
  package private(set) var openRunId: String? { didSet { Mutations.record("DeskModel.openRunId"); publishSelection() } }
  /// The open run's agents, in tree order: the reel's columns and the title bar's tabs.
  package private(set) var columns: [String] = [] { didSet { Mutations.record("DeskModel.columns") } }
  /// The reel's leading on-screen column, as the reel reports it: once per column crossed, never per frame.
  package private(set) var reelPosition: String? { didSet { Mutations.record("DeskModel.reelPosition") } }
  /// A scroll the reel carries out (a tab click, Follow, the keyboard, a project switch); `serial` makes a repeat count.
  package private(set) var reelRequest: ReelRequest? { didSet { Mutations.record("DeskModel.reelRequest") } }
  /// The agent whose rename field is open (one at a time): while it is, Return belongs to the field, never to a decision
  /// (`returnApproves`).
  package private(set) var renamingAgent: String? { didSet { Mutations.record("DeskModel.renamingAgent") } }
  package var focusedAgent: String? {
    didSet { Mutations.record("DeskModel.focusedAgent"); if focusedAgent != oldValue { syncFlags(); publishSelection(); placeFocusInPanes() } }
  }
  /// The opened window's panes for the open run (PaneSplits.swift): one, or splits. Folded, they wait as they were.
  package internal(set) var panes = PaneLayout() { didSet { Mutations.record("DeskModel.panes") } }
  /// Other runs' panes, put away while their project isn't open (splits are kept per project).
  @ObservationIgnored var savedPanes: [String: PaneLayout] = [:]
  @ObservationIgnored var nextPaneId = 0
  /// The pane area's size, as it last laid out (a split refuses to make panes too small).
  @ObservationIgnored package var paneArea: CGSize = .zero
  /// Follow: an ask or a failure in the open project scrolls the reel to its column (SPEC §3).
  package var follow = true { didSet { Mutations.record("DeskModel.follow") } }
  /// Columns across the window (3, 2 or 1), set by the reel when its width crosses a step.
  package var across = 3 { didSet { Mutations.record("DeskModel.across"); if across != oldValue { syncFlags() } } }
  /// Home (design/desktop/Home.dc.html) while it shows: its composer's model; nil: the reel shows. A draft that didn't
  /// start is kept for the next time Home shows. Home shows whenever no project is open.
  package internal(set) var newProject: NewProjectModel? { didSet { Mutations.record("DeskModel.newProject") } }
  package var homeShown: Bool { newProject != nil }
  /// With nothing open, the window opens the project that asks, else the first (the bench and older tests); false (the
  /// app): it shows Home, and a project opens only when it's picked.
  @ObservationIgnored let autoOpens: Bool
  @ObservationIgnored var newProjectDraft: NewProjectModel?
  /// The open project's menu (ReelMenu) and the ⌘K palette are open; Stop project… is asking first.
  package internal(set) var menuOpen = false { didSet { Mutations.record("DeskModel.menuOpen") } }
  package internal(set) var paletteOpen = false { didSet { Mutations.record("DeskModel.paletteOpen") } }
  package internal(set) var stopAsked = false { didSet { Mutations.record("DeskModel.stopAsked") } }
  /// The palette's query and the entry Return runs (an index into what the query shows).
  package var paletteQuery = "" { didSet { Mutations.record("DeskModel.paletteQuery"); if paletteQuery != oldValue { paletteSelection = 0 } } }
  package internal(set) var paletteSelection = 0 { didSet { Mutations.record("DeskModel.paletteSelection") } }
  /// Bumped on every unnarrowed store change, for the views that show the store's general state (the menu, the palette,
  /// the new project column) while they are open. Nothing else reads it.
  package internal(set) var actionsRevision = 0 { didSet { Mutations.record("DeskModel.actionsRevision") } }
  /// The person put every project away (⌘W, Remove from the title bar): the window doesn't open one by itself until
  /// they pick one.
  @ObservationIgnored var folded = false
  /// Finished projects removed from the title bar, by project id, with the run they showed: back once they have news (a
  /// new run, an ask). Kept across launches in `defaults` (the app's: UserDefaults.standard; none for the bench).
  @ObservationIgnored var hidden: [String: String] = [:] { didSet { defaults?.set(hidden, forKey: Self.hiddenKey) } }
  @ObservationIgnored private var defaults: UserDefaults?
  static let hiddenKey = "desk.hiddenProjects"
  /// Message the planner…: the agent whose message box takes the focus when its column next shows (ColumnComposer).
  @ObservationIgnored var boxFocusPending: String?
  /// The folder setup the new project column shows (ProjectSetupFlow, as the menu bar's composer has), on `store`.
  @ObservationIgnored package internal(set) var setupFlow: ProjectSetupFlow
  @ObservationIgnored var branchTask: Task<Void, Never>?
  @ObservationIgnored var branchesAsked: GoalBranchSetup.Query?
  /// What the app does outside the window, replaceable in tests: open a link, copy text, ask for a project folder.
  @ObservationIgnored package var openURL: (URL) -> Void = { NSWorkspace.shared.open($0) }
  @ObservationIgnored package var copyText: (String) -> Void = { t in NSPasteboard.general.clearContents(); NSPasteboard.general.setString(t, forType: .string) }
  @ObservationIgnored package var chooseFolder: () async -> String? = { await DeskFolderPicker.choose() }
  /// Return approves the focused column's ask only while nothing else takes Return: a rename field, the new project
  /// column's composer, the menu, the palette or the Stop question (SPEC §4).
  package var returnApproves: Bool { renamingAgent == nil && typingIn == nil && newProject == nil && !menuOpen && !paletteOpen && !stopAsked }
  /// The column whose message box has the keyboard (nil: none).
  package private(set) var typingIn: String? { didSet { Mutations.record("DeskModel.typingIn") } }
  /// A message box took or gave up the keyboard: its column is the focused one while it has it.
  package func typing(in agentId: String, _ on: Bool) {
    if on { typingIn = agentId; if focusedAgent != agentId { focusedAgent = agentId } }
    else if typingIn == agentId { typingIn = nil }
  }
  /// The column ids on screen, for the title bar's bracket: derived from the scroll position, never tracked per frame.
  package var onScreen: Set<String> {
    let start = reelPosition.flatMap { columns.firstIndex(of: $0) } ?? 0
    return Set(columns.dropFirst(start).prefix(across))
  }

  /// Copies position and focus into the agents' slices (equality-guarded: only changed ones notify).
  private func syncFlags() {
    let seen = onScreen
    for (id, a) in agents { a.set(onScreen: seen.contains(id)); a.set(focused: id == focusedAgent) }
    needs.syncFocus(focusedAgent)
  }

  @ObservationIgnored private var agents: [String: AgentSlice] = [:]
  @ObservationIgnored private var threads: [String: ThreadSlice] = [:]
  @ObservationIgnored let mediaSlice = MediaSlice()
  @ObservationIgnored package let home = HomeSlice()
  /// Folded or opened, and the sidebar's view state; the sidebar's content (SidebarModel.swift).
  @ObservationIgnored package let nav = DeskNav()
  @ObservationIgnored package let sidebar = SidebarSlice()
  @ObservationIgnored var sidebarRowsByRun: [String: [(row: SidebarRow, needs: Bool)]] = [:]
  /// The Needs you reel (NeedsYou.swift): every asking agent, across projects.
  @ObservationIgnored package let needs = NeedsReel()
  @ObservationIgnored private var teams: [String: (sig: String, bots: [String: BotTraits])] = [:]
  @ObservationIgnored private var knownAsks: Set<String> = []
  /// The open run's failed agents, once its columns were first read (nil: not yet).
  @ObservationIgnored private var knownFailures: Set<String>?

  /// The app's window, on each store the session makes (a token from the Keychain, a pairing, a paste or
  /// `CAPCOMD_TOKEN`): the same store the menu bar panel reads. Notifications are the menu bar's (one banner per notice).
  package init(session: AppSession) {
    self.session = session
    autoOpens = false
    store = session.store
    setupFlow = ProjectSetupFlow(store: store)
    restoreHidden(from: .standard)
    nav.restore(from: .standard)
    needs.model = self
    session.onStore { [weak self] s in self?.connect(s) }
  }

  /// A model on a store that is already filled and needs no socket (the bench's fixtures, previews, tests): ready at
  /// once, following the store's keyed changes exactly as the connected model does.
  package init(store s: CapcomdStore, defaults d: UserDefaults? = nil, autoOpens a: Bool = true) {
    store = s; session = nil; autoOpens = a
    setupFlow = ProjectSetupFlow(store: s)
    if let d { restoreHidden(from: d) }
    nav.restore(from: d)
    needs.model = self
    setupFlow.onChange = { [weak self] in self?.newProjectChanged() }
    s.onChanges = { [weak self] keys in self?.apply(keys) }
    link = .ready
    apply([.all])
  }

  private func restoreHidden(from d: UserDefaults) {
    hidden = d.dictionary(forKey: Self.hiddenKey) as? [String: String] ?? [:]
    defaults = d
  }

  // MARK: connection

  /// A new store (a new token): follow it; the session starts it.
  private func connect(_ s: CapcomdStore) {
    let reconnect = connected
    connected = true
    store = s
    setupFlow = ProjectSetupFlow(store: s)
    setupFlow.onChange = { [weak self] in self?.newProjectChanged() }
    s.onChanges = { [weak self] keys in self?.apply(keys) }
    tokenRejected = false
    // The run that was open follows the new store's feeds: select it again.
    if reconnect { openRunId = nil }
    link = .ready
    apply([.all])
  }

  /// The window's focus is the store's selection, which the menu bar panel reads (no copy to keep in step).
  private func publishSelection() {
    if needs.isOpen { return store.select(runId: focusedAgent.flatMap { agent($0)?.header.runId }, agentId: focusedAgent) }
    store.select(runId: openRunId, agentId: openRunId == nil ? nil : focusedAgent)
  }

  /// A panel row or a notification: the run's project, at the agent's column (its nearest shown ancestor's, else the
  /// planner's). A project put away from the title bar comes back.
  package func show(run runId: String, agent agentId: String? = nil) {
    let project = store.runs[runId]?.projectId
    guard let deck = DeepLink.deck(forRun: runId, project: project, in: store.decks()) else { return }
    hidden[deck.id] = nil
    open(project: deck.id)
    let parents = store.runs[openRunId ?? runId]?.agents.mapValues(\.parent) ?? [:]
    if let column = DeepLink.column(for: agentId, columns: columns, parent: { parents[$0] ?? nil }) { scroll(to: column, animated: false) }
  }

  /// A pasted token: saved to the Keychain item the menu bar uses too; both reconnect with it.
  package func submit(token raw: String) -> Bool { session?.submit(pasted: raw) ?? false }

  // MARK: changes

  /// The store changed: refresh only what the keys name. `.all` refreshes everything, comparing before assigning.
  package func apply(_ keys: Set<ChangeKey>) {
    if store.unauthorized {
      tokenRejected = true; link = .needsToken
      session?.storeRejected(store)
      return
    }
    if keys == [.selection] { return }   // the window's own focus, published (publishSelection)
    // After the open run's slices: an asking agent of the open project shares its slice with the Needs you reel.
    defer { needs.apply(keys) }
    let all = keys.contains(.all)
    if all {
      if unreachable != store.daemonUnreachable { unreachable = store.daemonUnreachable }
      if daemonVersion != store.daemonVersion { daemonVersion = store.daemonVersion }
      if !loaded, store.daemonLoaded { loaded = true }
      actionsRevision &+= 1
      let d = shown(store.decks())
      if decks != d { decks = d }
      let opens = autoOpens && !folded
      if openProjectId == nil ? opens : !d.contains(where: { $0.id == openProjectId }) {
        let pick = opens ? d.first(where: { $0.askingAgentId != nil })?.id ?? d.first?.id : nil
        if pick != nil { leaveHome() }
        select(pick)
      }
      else if let deck = d.first(where: { $0.id == openProjectId }), deck.runId != openRunId { select(deck.id) }
      // Nothing open: Home (the window's first screen, and where folding the last project leaves you).
      if openProjectId == nil, newProject == nil, !needs.isOpen { openHome(focus: false) }
    }
    // Home: its cards follow the runs; its composer redraws on general changes, and a run it started takes over once the
    // run's planner is listed (which may arrive as that run's own change).
    if homeShown {
      let runTouched = keys.contains { if case .run = $0 { return true }; return false }
      if all || runTouched { home.set(store.homeRuns()) }
      if all { newProjectChanged() } else if runTouched { adoptStartedRun() }
    }
    refreshSidebar(keys)
    guard let runId = openRunId else { return }
    let touchesRun = all || keys.contains(.run(runId))
    if touchesRun {
      let cols = store.reelColumns(runId: runId)
      let ids = cols.map(\.agentId)
      defer { syncFlags() }
      let bots = all ? team(runId) : nil
      let asks = all ? Dictionary(store.approvals(forRun: runId).compactMap { a in store.waitingAgent(a).map { ($0, a) } }, uniquingKeysWith: { a, _ in a }) : nil
      // Slices first, added in one assignment, then the columns: a column or tab that read `agents` mid-way would
      // render empty first and then once per agent added.
      var added: [String: AgentSlice] = [:]
      for h in cols where all || keys.contains(.agent(h.agentId)) {
        let s = agents[h.agentId] ?? added[h.agentId] ?? { let n = AgentSlice(h); added[h.agentId] = n; return n }()
        s.set(h)
        if let bots { s.set(bot: bots[h.agentId]) }
        if let asks { s.set(approval: asks[h.agentId]) }
      }
      if !added.isEmpty { agents.merge(added) { a, _ in a } }
      syncGoal(runId, root: ids.first)
      if columns != ids {
        // A project just opened shows its columns' heads first; their threads warm after, nearest first.
        let opened = columns.isEmpty
        columns = ids
        prunePanes()
        if !opened { warm(around: columns.firstIndex(of: reelPosition ?? "") ?? 0) }
        startWarming()
      }
      if let asks { followAsks(Set(asks.keys)) }
      followFailures(Set(cols.filter { $0.status == .failed }.map(\.agentId)))
    }
    for (id, t) in threads where all || keys.contains(.thread(id)) {
      t.set(entries: store.threadEntries(agentId: id), pending: store.pendingSteers(agentId: id), unavailable: store.threadUnavailable[id],
            top: store.threadTop(agentId: id), loadingEarlier: store.threadLoadingEarlier.contains(id))
    }
    if all { for (k, v) in store.media where mediaSlice.items[k] != v { mediaSlice.items[k] = v } }
  }

  /// The goal card goes on the planner's column (the root, first in tree order); its view is read once a decision is up
  /// or made (the store reads it again on the goal events).
  @ObservationIgnored private var goalsAsked: Set<String> = []
  private func syncGoal(_ runId: String, root: String?) {
    let card = store.goalCard(runId: runId)
    for (id, a) in agents { a.set(goal: id == root ? card : nil) }
    if let card, card.docks || card.outcome != nil, store.goalViews[runId] == nil, goalsAsked.insert(runId).inserted {
      Task { await store.loadGoal(runId: runId) }
    }
  }

  // Goal card actions (the planner's column).
  /// Open PR: a stopped run asks the daemon's question first; else it opens (the daemon may still ask).
  package func openPullRequest(_ card: GoalCard) {
    switch card.openTap {
    case .ask(let q): store.askToOpenStoppedPullRequest(runId: card.runId, question: q)
    case .open: Task { _ = await store.openPullRequest(runId: card.runId) }
    }
  }
  package func confirmPullRequest(_ runId: String) { Task { _ = await store.openPullRequest(runId: runId, stopped: true) } }
  package func cancelGoalAction(_ runId: String) { store.cancelGoalAction(runId: runId) }
  package func keepBranch(_ runId: String) { Task { _ = await store.keepBranch(runId: runId) } }

  /// A new ask in the open project scrolls the reel to it while Follow is on; an answered ask never moves it.
  private func followAsks(_ asking: Set<String>) {
    let new = asking.subtracting(knownAsks)
    knownAsks = asking
    guard follow, !needs.isOpen, !nav.sidebarOpen, let first = columns.first(where: new.contains) else { return }
    scroll(to: first)
  }

  /// An agent of the open project that fails scrolls the reel to it while Follow is on (SPEC §3). Agents that had
  /// already failed when the project opened don't: the first look at a project only learns them.
  private func followFailures(_ failed: Set<String>) {
    // Learned from the first read that has the run's agents (the feed may answer with the run before its agents).
    guard let known = knownFailures else { if !columns.isEmpty { knownFailures = failed }; return }
    let new = failed.subtracting(known)
    knownFailures = failed
    guard follow, !needs.isOpen, !nav.sidebarOpen, let first = columns.first(where: new.contains) else { return }
    scroll(to: first)
  }

  /// Bots for every agent of the run, made distinct as a team; recomputed only when the run's agents change, so a
  /// newcomer never changes an earlier agent's bot.
  func team(_ runId: String) -> [String: BotTraits] {
    guard let run = store.runs[runId] else { return [:] }
    let list = run.agents.values.sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) }
    let sig = list.map { "\($0.id):\($0.kind.rawValue)" }.joined(separator: ",")
    if let t = teams[runId], t.sig == sig { return t.bots }
    let traits = botTeam(list.map { (seed: $0.id, role: Optional($0.kind.rawValue)) })
    let bots = Dictionary(uniqueKeysWithValues: zip(list.map(\.id), traits))
    teams[runId] = (sig, bots)
    return bots
  }

  // MARK: projects and columns

  /// Show a project (a deck click, ⌘1–9). Keyboard switches don't animate; the reel starts at its ask, if any.
  package func open(project id: String?) {
    menuOpen = false; stopAsked = false
    if id != nil { needs.close(restore: false) }
    if newProject != nil, id != nil { leaveHome() }
    if id != nil { folded = false }
    guard select(id) else { return }
    apply([.all])
  }

  /// Switches the reel to the project's run without refreshing; returns whether the run changed.
  @discardableResult private func select(_ id: String?) -> Bool {
    let deck = decks.first { $0.id == id }
    openProjectId = deck?.id
    let run = deck?.runId
    guard run != openRunId else { return false }
    let oldRun = openRunId
    openRunId = run
    agents = [:]; threads = [:]; columns = []; warmOrder = []; typingIn = nil
    swapPanes(from: oldRun, to: run)
    knownAsks = Set(deck?.askingAgentId.map { [$0] } ?? [])
    knownFailures = nil
    // Opened, a project whose panes were put away shows them as they were; else the one that asks.
    reelPosition = deck?.askingAgentId; focusedAgent = nav.sidebarOpen ? panes.focusedAgent ?? deck?.askingAgentId : deck?.askingAgentId; syncFlags()
    reelRequest = ReelRequest(agentId: deck?.askingAgentId, animated: false, serial: (reelRequest?.serial ?? 0) + 1)
    store.followThreads(runId: run, holder: CapcomdStore.reelHolder)
    // The run's own stream carries its messages (your steers, agents' messages to each other), which the lifecycle
    // feed doesn't: without it a sent steer never settles into the thread. Opened after this change is applied, since
    // opening reports a change itself.
    Task { @MainActor [weak self] in
      guard let self, self.openRunId == run else { return }
      if let run { self.store.openRun(run) } else { self.store.closeRun() }
    }
    return true
  }

  /// A notification's run: its project, at its planner's column (where a goal card docks).
  package func openRun(_ runId: String) { show(run: runId) }

  package func agent(_ id: String) -> AgentSlice? { agents[id] ?? needs.slice(id) }
  /// A column's slice in its reel: the Needs you reel keeps its own (cold until it warms them, without an amber ring),
  /// even for an agent of the open project.
  package func agent(_ id: String, inNeeds: Bool) -> AgentSlice? { inNeeds ? needs.slice(id) : agents[id] }
  /// The run a column's agent is in: the open run's, or a Needs you column's own.
  func runId(of agentId: String) -> String? { agent(agentId)?.header.runId ?? openRunId }
  /// Every column's slice (renaming closes the others).
  var agentSlices: [String: AgentSlice] { agents }
  /// The column's thread slice if its column made one (DeskDebug), without making it.
  package func peekThread(_ id: String) -> ThreadSlice? { threads[id] }

  /// A folded deck's heads: its run's bots, cached per run until its agents change.
  package func heads(_ deck: DeckInfo) -> [BotTraits] { let t = team(deck.runId); return deck.agentIds.compactMap { t[$0] } }

  /// Bring a column on screen and focus it. `animated` only for Follow and clicks, never for the keyboard (SPEC §4).
  package func scroll(to agentId: String, animated: Bool = true) {
    focusedAgent = agentId
    guard !onScreen.contains(agentId) else { return }
    // Keep the column where it lands: the reel's leading column moves only as far as needed.
    let i = columns.firstIndex(of: agentId) ?? 0, start = columns.firstIndex(of: reelPosition ?? "") ?? 0
    let target = columns[i < start ? i : max(0, i - across + 1)]
    reelPosition = target; syncFlags()
    reelRequest = ReelRequest(agentId: target, animated: animated, serial: (reelRequest?.serial ?? 0) + 1)
  }

  /// The reel's leading column changed (it scrolled, by hand or by request).
  package func reelScrolled(toIndex i: Int) {
    let id = columns.indices.contains(i) ? columns[i] : columns.last
    if reelPosition != id { reelPosition = id; syncFlags() }
    warm(around: i)
  }

  // MARK: warm columns

  // Every column of the open run exists for as long as the run is open, so scrolling only moves them. A column's
  // thread (the costly part to build) is made once, when the column is "warmed", and kept: the on-screen columns and
  // one each side at once, the rest one at a time while the reel stands still, nearest first, up to `warmCap`. Past
  // the cap the least recently shown thread is let go (its data stays in the store).

  package static let warmCap = 32
  /// Set by the reel: warming waits while it moves, so it never competes with a scroll for a frame.
  @ObservationIgnored package var reelMoving = false
  @ObservationIgnored private var warmOrder: [String] = []
  @ObservationIgnored private var warmer: Task<Void, Never>?

  private func warm(around i: Int) {
    guard !columns.isEmpty else { return }
    let lo = max(0, i - 1), hi = min(columns.count - 1, i + across)
    if lo <= hi { for id in columns[lo...hi] { warm(id) } }
  }

  private func warm(_ id: String) {
    guard let a = agents[id] else { return }
    a.set(warm: true)
    if warmOrder.last != id { warmOrder.removeAll { $0 == id }; warmOrder.append(id) }
    while warmOrder.count > Self.warmCap { agents[warmOrder.removeFirst()]?.set(warm: false) }
  }

  private func startWarming() {
    warmer?.cancel()
    warmer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(40))
        guard let self else { return }
        if self.reelMoving { continue }
        if self.nav.sidebarOpen { return }   // hidden under the pane: nothing to warm until it folds (resumeWarming)
        let at = self.columns.firstIndex(of: self.reelPosition ?? "") ?? 0
        let cold = self.columns.indices.filter { self.agents[self.columns[$0]]?.warm == false }
        guard self.warmOrder.count < Self.warmCap, let next = cold.min(by: { abs($0 - at) < abs($1 - at) }) else { return }
        self.warm(self.columns[next])
      }
    }
  }

  /// The sidebar folded: warming picks up where the reel stands.
  func resumeWarming() { if !columns.isEmpty { warm(around: columns.firstIndex(of: reelPosition ?? "") ?? 0); startWarming() } }

  package func goToProject(_ n: Int) { if decks.indices.contains(n) { open(project: decks[n].id) } }
  package func goToAgent(_ n: Int) {
    if needs.isOpen { if needs.columns.indices.contains(n) { needs.focus(needs.columns[n]) }; return }
    if columns.indices.contains(n) { scroll(to: columns[n], animated: false) }
  }
  package func moveFocus(_ by: Int) {
    if needs.isOpen { return needs.moveFocus(by) }
    if movePaneFocus(by) { return }   // opened with splits: the neighbouring pane
    let i = focusedAgent.flatMap { columns.firstIndex(of: $0) } ?? 0
    let j = min(max(0, i + by), columns.count - 1)
    if columns.indices.contains(j) { scroll(to: columns[j], animated: false) }
  }

  /// The column's thread, created when the column first shows (its pages load then, not before).
  package func thread(_ agentId: String) -> ThreadSlice {
    if let t = threads[agentId] { return t }
    if agents[agentId] == nil, let t = needs.thread(agentId) { return t }
    let t = ThreadSlice(agentId: agentId); threads[agentId] = t
    ThreadSlice.trace?(agentId, [])   // the column's thread opened
    t.set(entries: store.threadEntries(agentId: agentId), pending: store.pendingSteers(agentId: agentId), unavailable: store.threadUnavailable[agentId],
          top: store.threadTop(agentId: agentId), loadingEarlier: store.threadLoadingEarlier.contains(agentId))
    return t
  }

  /// Read the column's thread from the route, then again slowly in case the stream dropped a frame.
  package func keepThreadFresh(agentId: String) async {
    guard let runId = runId(of: agentId) else { return }
    while !Task.isCancelled {
      await store.refreshThread(runId: runId, agentId: agentId)
      try? await Task.sleep(for: .seconds(15))
    }
  }

  /// The column scrolled up to the top of what it shows: the page above it loads, and shows above without moving what
  /// is on screen (the thread's scroll keeps its bottom where it was).
  package func loadEarlier(agentId: String) async {
    guard let runId = runId(of: agentId) else { return }
    await store.loadEarlierThread(runId: runId, agentId: agentId)
  }

  package func steer(agentId: String, body: String) {
    guard let runId = runId(of: agentId) else { return }
    Task { await store.steer(runId: runId, agentId: agentId, body: body) }
  }

  package func retrySteer(agentId: String, _ p: PendingSteer) {
    guard let runId = runId(of: agentId) else { return }
    Task { await store.steer(runId: runId, agentId: agentId, body: p.body, skills: p.skills, retrying: p.id) }
  }
  package func discardSteer(agentId: String, id: String) { store.discardSteer(agentId: agentId, id: id) }

  package func decide(_ approvalId: String, _ d: ApprovalDecision) {
    if let a = store.approvals[approvalId], let id = store.waitingAgent(a) { needs.answered(agentId: id) }
    Task { _ = await store.decide(approvalId, d) }
  }
}

/// Where an agent is renamed inline: its crew tab, or its column header.
package enum RenamePlace: Equatable, Sendable { case tab, header }

extension DeskModel {
  // MARK: renaming (capability agents.title)

  /// A double-click on a tab or a column header: that field opens (and any other closes).
  package func beginRename(_ agentId: String, at place: RenamePlace) {
    for (id, a) in agentSlices where id != agentId { a.set(renaming: nil) }
    agent(agentId)?.set(renaming: place)
    renamingAgent = agentId
  }
  /// Esc, or a click elsewhere: the field closes, nothing is sent.
  package func endRename(_ agentId: String) {
    agent(agentId)?.set(renaming: nil)
    if renamingAgent == agentId { renamingAgent = nil }
  }
  /// What the field starts from: the title shown, and whether it is the person's own.
  package func titleEdit(_ agentId: String) -> TitleEdit? {
    guard let runId = openRunId else { return nil }
    return store.titleEdit(runId: runId, agentId: agentId)
  }
  /// Return: a name the daemon would refuse keeps the field open (false); anything else closes it, and the store sends
  /// the rename (the tab shows the new title at once; a failure puts the old one back and says why).
  @discardableResult
  package func commitRename(_ agentId: String, _ edit: TitleEdit) -> Bool {
    let outcome = edit.commit
    if case .invalid = outcome { return false }
    endRename(agentId)
    guard let runId = openRunId else { return true }
    Task { [weak self] in
      let r = await self?.store.rename(runId: runId, agentId: agentId, outcome)
      if case .failed(let why)? = r { self?.agent(agentId)?.set(renameFailure: why) } else { self?.agent(agentId)?.set(renameFailure: nil) }
    }
    return true
  }
}

package struct ReelRequest: Equatable {
  /// nil: the first column.
  package var agentId: String?
  package var animated: Bool
  package var serial: Int
}

extension DeskModel: ThreadHost {
  /// The agent's slice only: no observed state (an `isOpen` read here re-rendered every column's rows when the Needs you
  /// reel opened or closed) and nothing computed per call (a `team(runId)` fallback cost the project reel ~9 % CPU per
  /// step: the bench's rows name agents that have no slice).
  package func bot(runId: String, agentId: String) -> BotTraits? { agents[agentId]?.bot ?? needs.slice(agentId)?.bot }
  package func agentProvider(runId: String, agentId: String) -> Provider? { (agents[agentId] ?? needs.slice(agentId))?.header.provider }
  package func role(runId: String, agentId: String) -> String? { (agents[agentId] ?? needs.slice(agentId))?.header.name }
  package func media(_ key: MediaKey) -> Fetched<Data>? { mediaSlice.items[key] }
  package func loadMedia(_ key: MediaKey) async { await store.loadMedia(key); mediaSlice.items[key] = store.media[key] }
  package func openAgent(runId: String, agentId: String) { scroll(to: agentId) }
}
#endif
