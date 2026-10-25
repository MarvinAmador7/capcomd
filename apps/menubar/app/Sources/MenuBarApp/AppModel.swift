#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
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
  @ObservationIgnored let store: CapcomdStore
  private(set) var revision = 0
  var path: [Route] = []

  enum Route: Hashable { case run(String), thread(runId: String, agentId: String) }

  init(store: CapcomdStore) {
    self.store = store
    store.onChange = { [weak self] in self?.revision &+= 1 }
  }

  static func live() -> AppModel {
    let sock = UserDefaults.standard.string(forKey: "capcomd.socketPath")
      ?? (NSHomeDirectory() as NSString).appendingPathComponent(".capcomd/harness.sock")
    let token = Keychain.token() ?? ""
    let t = UnixSocketTransport(socketPath: sock, token: token)
    let s = CapcomdStore(subscriber: LiveSubscriber(transport: t), decider: LiveDecider(transport: t), prefs: DefaultsPreferences())
    let m = AppModel(store: s); s.start(); return m
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
  var activityCollapsed: Bool {
    get { _ = revision; return store.prefs.activityCollapsed }
    set { store.prefs.activityCollapsed = newValue; revision &+= 1 }
  }

  func open(run id: String) { store.openRun(id); path = [.run(id)] }
  func back() { if !path.isEmpty { path.removeLast() }; if path.isEmpty { store.closeRun() } }
  func decide(_ id: String, _ d: ApprovalDecision) { Task { _ = await store.decide(id, d) } }
}

/// Reads the daemon token from the Keychain (generic password, service "capcomd"). UNVERIFIED: service/account
/// names must match what `capcomd` writes; this is one of the Mac-only checks.
enum Keychain {
  static func token() -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "capcomd",
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
}
#endif
