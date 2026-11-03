#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import UserNotifications
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdBot

/// Observable mirror of CapcomdStore. The store stays platform-neutral; every store change bumps `revision`,
/// and computed properties read it so SwiftUI tracks them.
@Observable @MainActor
final class AppModel {
  /// Replaceable: a new token builds a fresh transport + store (the old one is stopped).
  @ObservationIgnored private(set) var store: CapcomdStore
  /// The transport behind `store`. AsyncHTTPClient traps in debug if its client is freed without shutdown(),
  /// so a replaced transport must be shut down explicitly before it is released.
  @ObservationIgnored private var transport: UnixSocketTransport
  /// The composer's inline project setup (ProjectSetupInline.swift), on `store`.
  @ObservationIgnored private(set) var setup: ProjectSetupFlow
  private(set) var revision = 0
  var path: [Route] = []
  /// No Keychain token yet (first launch) or the daemon answered 401: the panel shows the token prompt.
  private(set) var tokenMissing: Bool
  /// The Keychain read is still out (macOS may be asking whether this build can read the token).
  private(set) var tokenPending = false
  var needsToken: Bool { _ = revision; return !tokenPending && (tokenMissing || store.unauthorized) }

  enum Route: Hashable { case run(String), thread(runId: String, agentId: String) }

  init(_ pair: (CapcomdStore, UnixSocketTransport), tokenMissing: Bool = false) {
    self.store = pair.0; self.transport = pair.1; self.tokenMissing = tokenMissing
    self.setup = ProjectSetupFlow(store: pair.0)
    attach(store)
  }

  private func attach(_ s: CapcomdStore) {
    s.onChange = { [weak self] in self?.revision &+= 1 }
    setup = ProjectSetupFlow(store: s)
    setup.onChange = { [weak self] in self?.revision &+= 1 }
    s.onNotify = { [weak self] n in
      guard let self else { return }
      self.moment(n)
      // A goal branch run that is ready already said so (its goal notice): no second banner for its completion.
      if case .runFinished(let rid, "run.completed", _) = n, self.store.goalNoticed.contains(rid) { return }
      if self.store.prefs.allows(n) { Notifier.post(n, bot: self.notificationBot(n)) }   // Settings › General › Notifications
    }
  }

  static var socketPath: String { Connection.socketPath }

  static func makeStore(token: String) -> (CapcomdStore, UnixSocketTransport) { Connection.makeStore(token: token) }

  // Identity moments: seen live only (never from a snapshot or a reopened panel), each once per run.
  @ObservationIgnored private var celebrations: [String: Date] = [:]
  @ObservationIgnored private var meetScheduled: Set<String> = []
  @ObservationIgnored private let launched = Date()

  /// A run that just completed (live): its project keeps a cheering card for `cheerFor` seconds. Never on failure.
  func moment(_ n: Notice) {
    guard case .runFinished(let rid, let type, _) = n, type == "run.completed" else { return }
    celebrations[rid] = Date(); revision &+= 1
    Task { [weak self] in try? await Task.sleep(for: .seconds(Theme.Moments.cheerFor)); self?.celebrations[rid] = nil; self?.revision &+= 1 }
  }
  func celebrating(_ p: Project) -> Run? {
    _ = revision
    return p.runs.first { celebrations[$0.id].map { Date().timeIntervalSince($0) < Theme.Moments.cheerFor } ?? false }
  }

  /// A run in its first seconds, started while the app was watching: the card shows "meet your team" until
  /// `meetWindow` has passed, then the tree.
  func meeting(_ p: Project) -> Run? {
    _ = revision
    let now = Date().timeIntervalSince1970 * 1000, start = launched.timeIntervalSince1970 * 1000
    guard let run = p.activeRuns.first(where: { r in
      guard let s = r.startedAtMs else { return false }
      return Double(s) >= start && now - Double(s) < Theme.Moments.meetWindow * 1000
    }), let s = run.startedAtMs else { return nil }
    if !meetScheduled.contains(run.id) {
      meetScheduled.insert(run.id)
      let left = Theme.Moments.meetWindow - (now - Double(s)) / 1000
      Task { [weak self] in try? await Task.sleep(for: .seconds(max(0.1, left))); self?.revision &+= 1 }
    }
    return run
  }

  /// The waiting agent's bot for an approval notification.
  func notificationBot(_ n: Notice) -> (traits: BotTraits, agentId: String)? {
    guard case .approvalRequested(let aid, let runId, _, _) = n, let runId, let agentId = store.approvals[aid]?.agentId,
          let t = bot(runId: runId, agentId: agentId) else { return nil }
    return (t, agentId)
  }

  /// The model at once, connecting when the token arrives. The Keychain read runs off the main thread: macOS can hold
  /// it on an "allow access" prompt (a new build's signature), and the menu bar item must show meanwhile.
  /// `CAPCOMD_TOKEN` in the environment wins (development and UI tests, so a rebuild doesn't need a Keychain prompt).
  static func live() -> AppModel {
    Notifier.requestAuthorization()
    if Notifier.available { ApprovalNotifications.register() }
    let m = AppModel(makeStore(token: ""), tokenMissing: false)   // not started until the token is in
    m.tokenPending = true
    ApprovalNotifications.onDecision = { [weak m] id, approve in m?.decide(id, approve ? .approve : .deny) }   // Approve / Deny in the notification
    // A click on a goal branch notice: the run's detail, with its Ready bar.
    ApprovalNotifications.onOpenRun = { [weak m] rid in m?.open(run: rid); MenuBarPanel.open() }
    #if DEBUG
    DispatchQueue.main.async { MenuBarDebug.start(m) }   // CAPCOMD_MENUBAR_CONTROL (MenuBarDebug.swift)
    #endif
    if let env = ProcessInfo.processInfo.environment["CAPCOMD_TOKEN"], !env.isEmpty { m.tokenFromEnvironment = true; m.connect(token: env); return m }
    Task.detached(priority: .userInitiated) {
      let token = Keychain.token()
      await MainActor.run { m.connect(token: token) }
    }
    return m
  }

  /// Starts with `token`, or asks for one when there is none.
  private func connect(token: String?) {
    tokenPending = false
    guard let token, !token.isEmpty else { tokenMissing = true; revision &+= 1; return }
    let old = transport
    Task { try? await old.shutdown() }   // the placeholder's client must be shut down, not dropped (06db2b8)
    let (s, t) = Self.makeStore(token: token); store = s; transport = t; attach(s)
    tokenMissing = false; s.start(); revision &+= 1
  }

  /// Saves the pasted token (generic password, service "capcomd", account NSUserName()) and reconnects with it.
  func submitToken(_ raw: String) -> Bool {
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty, Keychain.save(token) else { return false }
    store.stop()
    let old = transport
    Task { try? await old.shutdown() }   // keeps `old` alive until its client is shut down
    let (s, t) = Self.makeStore(token: token); store = s; transport = t; attach(s)
    tokenMissing = false; tokenFromEnvironment = false; path = []
    s.start(); revision &+= 1
    Task { await s.refreshSettings() }
    return true
  }
  /// The token came from `CAPCOMD_TOKEN` (development): Settings says so and offers no Reset.
  private(set) var tokenFromEnvironment = false

  /// Settings: what the user is finishing in Terminal (SettingsModel.swift).
  var handOffs = HandOffs()
  /// A pref the store doesn't watch changed: views reading it re-render.
  func bump() { revision &+= 1 }

  var projects: [Project] { _ = revision; return store.projects }
  var badgeCount: Int { _ = revision; return store.badgeCount }
  func run(_ id: String) -> Run? { _ = revision; return store.runs[id] }
  func tree(_ runId: String) -> [AgentNode] { _ = revision; return store.agentTree(runId: runId) }
  func approvals(_ runId: String) -> [PendingApproval] { _ = revision; return store.approvals(forRun: runId) }
  func approval(_ id: String) -> PendingApproval? { _ = revision; return store.approvals[id] }
  func steps(_ runId: String) -> [Step] { _ = revision; return store.steps(forRun: runId) }
  func thread(_ agentId: String) -> [ThreadItem] { _ = revision; return store.thread(agentId: agentId) }
  func threadEntries(_ agentId: String) -> [ThreadEntry] { _ = revision; return store.threadEntries(agentId: agentId) }
  func threadUnavailable(_ agentId: String) -> DetailUnavailable? { _ = revision; return store.threadUnavailable[agentId] }
  func media(_ key: MediaKey) -> Fetched<Data>? { _ = revision; return store.media[key] }
  func loadMedia(_ key: MediaKey) async { await store.loadMedia(key) }
  func openThread(runId: String, agentId: String) { store.openThread(runId: runId, agentId: agentId) }
  func closeThread(agentId: String) { if store.openThreadAgent == agentId { store.closeThread() } }
  func refreshThread(runId: String, agentId: String) async { await store.refreshThread(runId: runId, agentId: agentId) }
  func threadTop(_ agentId: String) -> Int? { _ = revision; return store.threadTop(agentId: agentId) }
  func threadLoadingEarlier(_ agentId: String) -> Bool { _ = revision; return store.threadLoadingEarlier.contains(agentId) }
  func loadEarlierThread(runId: String, agentId: String) async { await store.loadEarlierThread(runId: runId, agentId: agentId) }

  var drillView: DrillView {
    get { _ = revision; return store.prefs.drillView }
    set { store.prefs.drillView = newValue; revision &+= 1 }
  }
  var detailTab: DetailTab {
    get { _ = revision; return store.prefs.detailTab }
    set { store.prefs.detailTab = newValue; revision &+= 1 }
  }
  var activityCollapsed: Bool {
    get { _ = revision; return store.prefs.activityCollapsed }
    set { store.prefs.activityCollapsed = newValue; revision &+= 1 }
  }

  // Run detail (drill-down)
  func traceRows(_ runId: String, nowMs: Int, collapsed: Set<String>) -> [TraceRow] { _ = revision; return store.traceRows(runId: runId, nowMs: nowMs, collapsed: collapsed) }
  func traceState(_ runId: String) -> Fetched<[TraceSpan]>? { _ = revision; return store.traces[runId] }
  func filesState(_ runId: String) -> Fetched<RunFiles>? { _ = revision; return store.files[runId] }
  func log(_ agentId: String) -> [LogLine] { _ = revision; return store.logs[agentId] ?? [] }
  func logUnavailable(_ agentId: String) -> DetailUnavailable? { _ = revision; return store.logUnavailable[agentId] }
  func focusAgent(_ runId: String) -> Agent? { _ = revision; return store.focusAgent(runId: runId) }
  func controlState(_ runId: String) -> ControlState { _ = revision; return store.controlState[runId] ?? .idle }
  func pauseAction(_ runId: String) -> RunControl { _ = revision; return store.pauseAction(runId: runId) }
  func control(_ runId: String, _ action: RunControl) { Task { _ = await store.control(runId, action) } }
  /// One refresh of what the drill-down shows: the trace when it is on screen, and the visible Log or Files tab.
  func refreshDetail(_ runId: String, trace: Bool, files: Bool, logAgent: String?) async {
    if trace { await store.refreshTrace(runId) }
    if files { await store.refreshFiles(runId) }
    if let a = logAgent { await store.refreshLog(runId: runId, agentId: a) }
  }

  var startState: StartState { _ = revision; return store.startState }
  /// The daemon can't be reached right now (the app keeps retrying).
  var daemonUnreachable: Bool { _ = revision; return store.daemonUnreachable }
  /// The project checkout new runs go to (remembered); nil: the daemon's default project.
  var startRepo: String? {
    get { _ = revision; return store.prefs.startRepo }
    set { store.prefs.startRepo = newValue; revision &+= 1; Task { await store.refreshRunOptions() } }
  }
  /// Starts a run; when the daemon has no default repository, asks for the project folder once and remembers it.
  /// Who can drive a new run as its planner, and where it can run (`runs.options`); empty on daemons that can't say.
  var drivers: [DriverInfo] { _ = revision; return store.startDrivers }
  var sandboxes: [SandboxInfo] { _ = revision; return store.runOptions.sandboxes }
  /// Where new runs go: the default place (Settings › Runs) while it can be used, else the project's default.
  var startSandbox: SandboxInfo? { _ = revision; return store.startSandbox }
  /// The composer's Local / Cloud switch picks the default place too (Settings › Runs shows it as "Default").
  func pickSandbox(_ name: String) { store.setDefaultPlace(name) }
  /// The driver's reasoning effort for new runs (nil: Auto). See CapcomdStore.startEffort.
  var startEffort: String? { _ = revision; return store.startEffort }
  func pickEffort(_ effort: String?) { store.pickEffort(effort) }
  /// The driver new runs go to: the one last picked while the daemon still offers it, else the project's default.
  var startDriver: DriverInfo? { _ = revision; return store.startDriver }
  func pickDriver(_ provider: String) { store.pickDriver(provider) }

  func startRun(_ goal: String) async -> Bool {
    // The goal branch rows chose for this checkout: the base and the branch as shown (GoalBranchRows.swift).
    var choice = store.newRunChoice(goalSetup: goalSetup)
    var state = await store.startRun(goal: goal, choice)
    if case .needsRepo = state, let folder = await ProjectFolderPicker.choose() {
      // A folder that isn't set up yet shows its next steps in the composer (the goal stays: Set Up and Start). A set-up
      // one takes the run, with the project's own drivers (the daemon's, without a project, may have had none to offer).
      guard await setup.pick(folder) else { return false }
      choice = store.newRunChoice(goalSetup: nil)
      state = await store.startRun(goal: goal, choice)
    }
    if case .started = state { return true }
    return false
  }
  func clearStart() { store.clearStart() }

  // Goal branches (capability runs.goal_branch): the composer's rows (GoalBranchRows.swift) and the ready card.
  /// The base and goal branch for the next run, for the checkout it goes to.
  var goalSetup = GoalBranchSetup()
  /// The rows show for a project checkout on a daemon with goal branches; the default project and older daemons keep
  /// today's composer.
  var goalBranchesOffered: Bool { _ = revision; return store.goalBranchesOffered }
  /// The field the last Start's refusal is about ("base", "goalBranch").
  var startRefusedField: String? { _ = revision; return store.startRefusedField }
  /// Asks the daemon about the rows' question and files its answer against it (an older question's answer is dropped).
  func loadBranches(_ q: GoalBranchSetup.Query) async {
    if let f = await store.loadProjectBranches(path: q.path, goal: q.goal, goalBranch: q.goalBranch, base: q.base) { goalSetup.receive(f, for: q) }
  }
  /// The run's goal card (nil without a goal branch).
  func goalCard(_ runId: String) -> GoalCard? { _ = revision; return store.goalCard(runId: runId) }
  /// The goal view behind the card, read once per run here (the store reads it again on the goal events).
  @ObservationIgnored private var goalsAsked: Set<String> = []
  func loadGoal(_ runId: String) {
    guard goalsAsked.insert(runId).inserted else { return }
    Task { await store.loadGoal(runId: runId) }
  }
  /// Open PR: a stopped run asks the daemon's question first; else it opens (the daemon may still ask).
  func openPullRequest(_ card: GoalCard) {
    switch card.openTap {
    case .ask(let q): store.askToOpenStoppedPullRequest(runId: card.runId, question: q)
    case .open: Task { _ = await store.openPullRequest(runId: card.runId) }
    }
  }
  /// The person said yes to the stopped run's question.
  func confirmPullRequest(_ runId: String) { Task { _ = await store.openPullRequest(runId: runId, stopped: true) } }
  func cancelGoalAction(_ runId: String) { store.cancelGoalAction(runId: runId) }
  func keepBranch(_ runId: String) { Task { _ = await store.keepBranch(runId: runId) } }
  /// View diff: the compare on GitHub, else the run's Files tab.
  func viewGoalDiff(_ card: GoalCard) {
    if let u = card.diffURL { NSWorkspace.shared.open(u) } else { viewDiff(runId: card.runId) }
  }

  // Bot avatars (brand direction B): one team per run, siblings kept distinct (botTeam). Agents join in spawn order, so
  // a newcomer never changes an earlier agent's bot. Recomputed only when the run's agents change.
  @ObservationIgnored private var teams: [String: (sig: String, bots: [String: BotTraits])] = [:]
  func bot(runId: String, agentId: String) -> BotTraits? {
    _ = revision
    guard let run = store.runs[runId] else { return nil }
    let agents = run.agents.values.sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) }
    let sig = agents.map { "\($0.id):\($0.kind.rawValue)" }.joined(separator: ",")
    if let t = teams[runId], t.sig == sig { return t.bots[agentId] }
    let traits = botTeam(agents.map { (seed: $0.id, role: Optional($0.kind.rawValue)) })
    let bots = Dictionary(uniqueKeysWithValues: zip(agents.map(\.id), traits))
    teams[runId] = (sig, bots)
    return bots[agentId]
  }

  /// Which AI the agent runs on, and its model when the daemon says.
  func provider(runId: String, agentId: String) -> (provider: Provider, model: String?)? {
    _ = revision
    guard let a = store.runs[runId]?.agents[agentId], let p = a.provider else { return nil }
    return (p, a.model)
  }

  /// The agent's bot name ("Ziggy"), shown beside its role in headers and handoffs and read in tooltips and VoiceOver.
  func botName(runId: String, agentId: String) -> String? { bot(runId: runId, agentId: agentId)?.name }

  /// The menu bar mark's face: a raised mitt when an approval waits, open eyes while anything runs, else sleepy.
  /// With bot faces off (Settings › General) it stays the plain mark, eyes open.
  var menuBarFace: MenuBarFace {
    _ = revision
    switch store.markFace { case .plain, .working: return .working; case .idle: return .idle; case .approval: return .approval }
  }

  // Panel height: each screen reports what its content needs; PanelView clamps it (Theme.Panel).
  var listHeight: CGFloat = 0
  /// The width the project composer's tool row needs (its pills and chips never truncate); the panel widens past
  /// Theme.panelWidth to fit it.
  var composerRowWidth: CGFloat = 0
  var routeHeight: CGFloat = 0

  // Agent thread input (7c)
  func agentControlState(_ agentId: String) -> ControlState { _ = revision; return store.agentControlState[agentId] ?? .idle }
  func controlAgent(runId: String, agentId: String, _ action: RunControl) { Task { _ = await store.controlAgent(runId: runId, agentId: agentId, action) } }
  /// Renaming an agent (agents.title): where the field starts, and what Return sends.
  func titleEdit(runId: String, agentId: String) -> TitleEdit? { store.titleEdit(runId: runId, agentId: agentId) }
  func rename(runId: String, agentId: String, _ outcome: TitleEdit.Outcome) { Task { _ = await store.rename(runId: runId, agentId: agentId, outcome) } }
  func pendingSteers(_ agentId: String) -> [PendingSteer] { _ = revision; return store.pendingSteers(agentId: agentId) }
  func steer(runId: String, agentId: String, body: String, skills: [String]) { Task { await store.steer(runId: runId, agentId: agentId, body: body, skills: skills) } }
  func retrySteer(runId: String, agentId: String, _ p: PendingSteer) { Task { await store.steer(runId: runId, agentId: agentId, body: p.body, skills: p.skills, retrying: p.id) } }
  func discardSteer(agentId: String, id: String) { store.discardSteer(agentId: agentId, id: id) }
  var capabilities: Set<String> { _ = revision; return store.capabilities }
  var skills: [SkillInfo] { _ = revision; return store.skills?.value ?? [] }
  func refreshDaemonInfo() async { await store.refreshDaemonInfo() }
  /// The agents under `agentId` in its run, depth first: who a steer can @-mention.
  func descendants(runId: String, of agentId: String) -> [AgentNode] {
    func find(_ ns: [AgentNode]) -> AgentNode? { for n in ns { if n.id == agentId { return n }; if let f = find(n.children) { return f } }; return nil }
    func flat(_ ns: [AgentNode]) -> [AgentNode] { ns.flatMap { [$0] + flat($0.children) } }
    return find(tree(runId)).map { flat($0.children) } ?? []
  }

  // The Active card (direction B: CapcomdStore/ActiveCard.swift, ActiveCardView.swift).
  func card(_ p: Project) -> ActiveCard { _ = revision; return store.activeCard(p) }
  func outcome(_ p: Project) -> CardOutcome? { _ = revision; return store.outcome(p) }
  /// Unfold reasons the user put away ("failed:agt-…" via Hide): the card stays folded until another reason unfolds it.
  var hiddenReasons: Set<String> = []
  /// Cards whose agent tree is showing (by project id).
  var treeShown: Set<String> = []
  /// View diff: the run's drill-down with its Files tab.
  func viewDiff(runId: String) { store.prefs.detailTab = .files; revision &+= 1; open(run: runId) }
  /// The outcome's files and lines (GET …/files), read once per finished run.
  @ObservationIgnored private var outcomeFilesAsked: Set<String> = []
  func loadOutcomeFiles(_ runId: String) {
    guard outcomeFilesAsked.insert(runId).inserted else { return }
    Task { await store.refreshFiles(runId) }
  }

  func open(run id: String) { store.openRun(id); path = [.run(id)] }
  func back() { if !path.isEmpty { path.removeLast() }; if path.isEmpty { store.closeRun() } }
  func decide(_ id: String, _ d: ApprovalDecision) { Task { _ = await store.decide(id, d) } }
}

/// Approval / run-finished notifications from the lifecycle feed. UNUserNotificationCenter needs a bundle, so a bare
/// `swift run` binary (no bundle identifier) skips them instead of crashing.
enum Notifier {
  static var available: Bool { Bundle.main.bundleIdentifier != nil }
  static func requestAuthorization() {
    guard available else { return }
    UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }
  @MainActor static func post(_ n: Notice, bot: (traits: BotTraits, agentId: String)? = nil) {
    guard available else { return }
    let c = UNMutableNotificationContent()
    let id: String
    switch n {
    case .approvalRequested(let aid, _, let q, let asker):
      // "lead · login redirect asks": the agent as its tab names it (titles are plain text, like the question).
      id = "approval-\(aid)"; c.title = asker.map { "\($0) asks" } ?? "Approval needed"; c.body = q.plain   // plain text; notifications don't render markdown
      c.categoryIdentifier = ApprovalNotifications.category; c.userInfo = ["approvalId": aid]
      if let bot, let a = ApprovalNotifications.botAttachment(bot.traits, id: bot.agentId) { c.attachments = [a] }
    case .runFinished(let rid, let type, let title):
      id = "run-\(rid)-\(type)"; c.title = title
      c.body = type == "run.completed" ? "Run completed" : type == "run.cancelled" ? "Run stopped" : "Run failed"
    case .goalReady(let g):
      // "Ready: capcomd/add-x → dev: 2 of 3 tasks landed"; a click opens the run.
      id = "goal-\(g.runId)"; c.title = g.title; c.body = g.line; c.userInfo = ["runId": g.runId]
    }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}
#endif

#if canImport(SwiftUI) && os(macOS)
/// The menu bar's thread views read the whole model (its `revision`): fine for one thread at a time in the panel.
extension AppModel: ThreadHost {
  func agentProvider(runId: String, agentId: String) -> Provider? { provider(runId: runId, agentId: agentId)?.provider }
  func role(runId: String, agentId: String) -> String? { run(runId)?.agents[agentId]?.displayName }
  func openAgent(runId: String, agentId: String) { path.append(.thread(runId: runId, agentId: agentId)) }
}
#endif
