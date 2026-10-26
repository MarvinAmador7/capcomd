#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import UserNotifications
import CapcomdStore
import CapcomdLive
import CapcomdClient

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
    s.onNotify = { Notifier.post($0) }
  }

  static var socketPath: String {
    UserDefaults.standard.string(forKey: "capcomd.socketPath")
      ?? (NSHomeDirectory() as NSString).appendingPathComponent(".capcomd/harness.sock")
  }

  static func makeStore(token: String) -> (CapcomdStore, UnixSocketTransport) {
    let t = UnixSocketTransport(socketPath: socketPath, token: token)
    return (CapcomdStore(subscriber: LiveSubscriber(transport: t), decider: LiveDecider(transport: t), detail: LiveDetail(transport: t),
                         controls: LiveControls(transport: t), prefs: DefaultsPreferences()), t)
  }

  static func live() -> AppModel {
    Notifier.requestAuthorization()
    guard let token = Keychain.token(), !token.isEmpty else {
      return AppModel(makeStore(token: ""), tokenMissing: true)   // not started: nothing to authenticate with
    }
    let m = AppModel(makeStore(token: token)); m.store.start(); return m
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
  static func post(_ n: Notice) {
    guard available else { return }
    let c = UNMutableNotificationContent()
    let id: String
    switch n {
    case .approvalRequested(let aid, _, let q):
      id = "approval-\(aid)"; c.title = "Approval needed"; c.body = q.plain   // plain text; notifications don't render markdown
    case .runFinished(let rid, let type, let title):
      id = "run-\(rid)-\(type)"; c.title = title
      c.body = type == "run.completed" ? "Run completed" : "Run failed"
    }
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: id, content: c, trigger: nil))
  }
}
#endif
