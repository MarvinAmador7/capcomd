#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import UserNotifications
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdBot

/// UserDefaults-backed prefs for the store's remembered UI choices.
final class DefaultsPreferences: PreferenceStoring {
  let d = UserDefaults.standard
  func string(forKey k: String) -> String? { d.string(forKey: "capcomd.\(k)") }
  func set(_ v: String?, forKey k: String) { d.set(v, forKey: "capcomd.\(k)") }
}

/// Observable mirror of CapcomdStore. The store stays platform-neutral; every store change bumps `revision`,
/// and computed properties read it so SwiftUI tracks them.
@Observable @MainActor
final class AppModel {
  /// Replaceable: a new token builds a fresh transport + store (the old one is stopped).
  @ObservationIgnored private(set) var store: CapcomdStore
  /// The transport behind `store`. AsyncHTTPClient traps in debug if its client is freed without shutdown(),
  /// so a replaced transport must be shut down explicitly before it is released.
  @ObservationIgnored private var transport: UnixSocketTransport
  private(set) var revision = 0
  var path: [Route] = []
  /// No Keychain token yet (first launch) or the daemon answered 401: the panel shows the token prompt.
  private(set) var tokenMissing: Bool
  var needsToken: Bool { _ = revision; return tokenMissing || store.unauthorized }

  enum Route: Hashable { case run(String), thread(runId: String, agentId: String) }

  init(_ pair: (CapcomdStore, UnixSocketTransport), tokenMissing: Bool = false) {
    self.store = pair.0; self.transport = pair.1; self.tokenMissing = tokenMissing
    attach(store)
  }

  private func attach(_ s: CapcomdStore) {
    s.onChange = { [weak self] in self?.revision &+= 1 }
    s.onNotify = { [weak self] n in self?.moment(n); Notifier.post(n, bot: self?.notificationBot(n)) }
  }

  static var socketPath: String {
    UserDefaults.standard.string(forKey: "capcomd.socketPath")
      ?? (NSHomeDirectory() as NSString).appendingPathComponent(".capcomd/harness.sock")
  }

  static func makeStore(token: String) -> (CapcomdStore, UnixSocketTransport) {
    let t = UnixSocketTransport(socketPath: socketPath, token: token)
    return (CapcomdStore(subscriber: LiveSubscriber(transport: t), decider: LiveDecider(transport: t), detail: LiveDetail(transport: t),
                         controls: LiveControls(transport: t), starter: LiveStarter(transport: t), messenger: LiveMessenger(transport: t),
                         daemonInfo: LiveDaemonInfo(transport: t), thread: LiveThread(transport: t), prefs: DefaultsPreferences()), t)
  }

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
    guard case .approvalRequested(let aid, let runId, _) = n, let runId, let agentId = store.approvals[aid]?.agentId,
          let t = bot(runId: runId, agentId: agentId) else { return nil }
    return (t, agentId)
  }

  static func live() -> AppModel {
    Notifier.requestAuthorization()
    if Notifier.available { ApprovalNotifications.register() }
    guard let token = Keychain.token(), !token.isEmpty else {
      return AppModel(makeStore(token: ""), tokenMissing: true)   // not started: nothing to authenticate with
    }
    let m = AppModel(makeStore(token: token)); m.store.start()
    ApprovalNotifications.onDecision = { [weak m] id, approve in m?.decide(id, approve ? .approve : .deny) }   // Approve / Deny in the notification
    return m
  }

  /// Saves the pasted token (generic password, service "capcomd", account NSUserName()) and reconnects with it.
  func submitToken(_ raw: String) -> Bool {
    let token = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !token.isEmpty, Keychain.save(token) else { return false }
    store.stop()
    let old = transport
    Task { try? await old.shutdown() }   // keeps `old` alive until its client is shut down
    let (s, t) = Self.makeStore(token: token); store = s; transport = t; attach(s)
    tokenMissing = false; path = []
    s.start(); revision &+= 1
    return true
  }

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
  /// The project checkout new runs go to (remembered); nil: the daemon's default project.
  var startRepo: String? {
    get { _ = revision; return store.prefs.startRepo }
    set { store.prefs.startRepo = newValue; revision &+= 1 }
  }
  /// Starts a run; when the daemon has no default repository, asks for the project folder once and remembers it.
  /// Who can drive a new run as its planner, and where it can run (`runs.options`); empty on daemons that can't say.
  var drivers: [DriverInfo] { _ = revision; return store.runOptions.drivers }
  var sandboxes: [SandboxInfo] { _ = revision; return store.runOptions.sandboxes }
  /// Where new runs go: the one last picked while still available, else the project's default.
  var startSandbox: SandboxInfo? {
    let ss = sandboxes
    return ss.first { $0.name == store.prefs.startSandbox && $0.available } ?? ss.first { $0.isDefault == true && $0.available } ?? ss.first(where: \.available)
  }
  func pickSandbox(_ name: String) { store.prefs.startSandbox = name; revision &+= 1 }
  /// The driver's reasoning effort for new runs: the one last picked for it while it still offers it, else its default.
  var startEffort: String? {
    guard let d = startDriver, let levels = d.efforts, !levels.isEmpty else { return nil }
    _ = revision
    return store.prefs.startEffort(d.provider).flatMap { levels.contains($0) ? $0 : nil } ?? d.effort.flatMap { levels.contains($0) ? $0 : nil }
  }
  func pickEffort(_ effort: String) {
    guard let d = startDriver else { return }
    store.prefs.setStartEffort(effort, for: d.provider); revision &+= 1
  }
  /// The driver new runs go to: the one last picked while the daemon still offers it, else the project's default.
  var startDriver: DriverInfo? {
    let ds = drivers
    return ds.first { $0.provider == store.prefs.startDriver && $0.available } ?? ds.first { $0.isDefault == true && $0.available } ?? ds.first(where: \.available)
  }
  func pickDriver(_ provider: String) { store.prefs.startDriver = provider; revision &+= 1 }

  func startRun(_ goal: String) async -> Bool {
    var choice = RunChoice(repo: store.prefs.startRepo, driver: startDriver?.provider, sandbox: startSandbox?.name, effort: startEffort)
    var state = await store.startRun(goal: goal, choice)
    if case .needsRepo = state, let folder = ProjectFolderPicker.choose() {
      store.prefs.startRepo = folder; choice.repo = folder
      state = await store.startRun(goal: goal, choice)
    }
    if case .started = state { return true }
    return false
  }
  func clearStart() { store.clearStart() }

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
  var menuBarFace: MenuBarFace {
    _ = revision
    if store.badgeCount > 0 { return .approval }
    return store.runs.values.contains { r in r.agents.values.contains { $0.status == .running } } ? .working : .idle
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

  func open(run id: String) { store.openRun(id); path = [.run(id)] }
  func back() { if !path.isEmpty { path.removeLast() }; if path.isEmpty { store.closeRun() } }
  func decide(_ id: String, _ d: ApprovalDecision) { Task { _ = await store.decide(id, d) } }
}

/// Daemon token in the login Keychain: generic password, service "capcomd", account NSUserName().
enum Keychain {
  static let service = "capcomd"
  static func token() -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: NSUserName(),
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  @discardableResult
  static func save(_ token: String) -> Bool {
    let key: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                              kSecAttrAccount as String: NSUserName()]
    let data = Data(token.utf8)
    let upd = SecItemUpdate(key as CFDictionary, [kSecValueData as String: data] as CFDictionary)
    if upd == errSecSuccess { return true }
    guard upd == errSecItemNotFound else { return false }
    var add = key; add[kSecValueData as String] = data
    add[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
    return SecItemAdd(add as CFDictionary, nil) == errSecSuccess
  }
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
    case .approvalRequested(let aid, _, let q):
      id = "approval-\(aid)"; c.title = "Approval needed"; c.body = q.plain   // plain text; notifications don't render markdown
      c.categoryIdentifier = ApprovalNotifications.category; c.userInfo = ["approvalId": aid]
      if let bot, let a = ApprovalNotifications.botAttachment(bot.traits, id: bot.agentId) { c.attachments = [a] }
    case .runFinished(let rid, let type, let title):
      id = "run-\(rid)-\(type)"; c.title = title
      c.body = type == "run.completed" ? "Run completed" : "Run failed"
    }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}
#endif
