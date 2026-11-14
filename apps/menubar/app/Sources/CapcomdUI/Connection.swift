#if canImport(SwiftUI) && os(macOS)
import Foundation
import Security
import CapcomdStore
import CapcomdLive
import CapcomdClient

/// How the app reaches the daemon: its socket, the token in the login Keychain (one item, which the menu bar and
/// desktop apps before it shared too), and a store wired to the live transport.
package enum Connection {
  package static var socketPath: String {
    socketPath(env: ProcessInfo.processInfo.environment, defaults: UserDefaults.standard.string(forKey: "capcomd.socketPath"), home: NSHomeDirectory())
  }

  /// The daemon's socket, resolved as the CLI resolves it (src/api/socket.ts), environment first, as `CAPCOMD_TOKEN`
  /// comes before the Keychain: `CAPCOMD_HARNESS_SOCKET`, else `$CAPCOMD_HOME/harness.sock`, else the app's
  /// `capcomd.socketPath` default, else ~/.capcomd/harness.sock. A development launch with its own daemon's
  /// environment therefore never reaches the owner's. A leading `~/` is the home directory.
  package static func socketPath(env: [String: String], defaults: String?, home: String) -> String {
    func expand(_ p: String) -> String {
      let full = p.hasPrefix("~/") ? (home as NSString).appendingPathComponent(String(p.dropFirst(2))) : p
      return (full as NSString).standardizingPath
    }
    if let s = env["CAPCOMD_HARNESS_SOCKET"], !s.isEmpty { return expand(s) }
    if let h = env["CAPCOMD_HOME"], !h.isEmpty { return (expand(h) as NSString).appendingPathComponent("harness.sock") }
    if let d = defaults, !d.isEmpty { return expand(d) }
    return (home as NSString).appendingPathComponent(".capcomd/harness.sock")
  }

  @MainActor package static func makeStore(token: String) -> (CapcomdStore, UnixSocketTransport) {
    let t = UnixSocketTransport(socketPath: socketPath, token: token)
    return (CapcomdStore(subscriber: LiveSubscriber(transport: t), decider: LiveDecider(transport: t), detail: LiveDetail(transport: t),
                         controls: LiveControls(transport: t), starter: LiveStarter(transport: t), messenger: LiveMessenger(transport: t),
                         daemonInfo: LiveDaemonInfo(transport: t), thread: LiveThread(transport: t), prefs: DefaultsPreferences()), t)
  }
}

/// UserDefaults-backed prefs for the store's remembered UI choices.
package final class DefaultsPreferences: PreferenceStoring {
  package init() {}
  let d = UserDefaults.standard
  package func string(forKey k: String) -> String? { d.string(forKey: "capcomd.\(k)") }
  package func set(_ v: String?, forKey k: String) { d.set(v, forKey: "capcomd.\(k)") }
}

/// Daemon token in the login Keychain: generic password, service "capcomd", account NSUserName().
/// `-capcomd.keychainService NAME` (development: a scratch daemon) uses another item, so your own token is never read
/// or replaced.
package enum Keychain {
  package static var service: String { UserDefaults.standard.string(forKey: "capcomd.keychainService") ?? "capcomd" }
  package static func token() -> String? {
    let q: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                            kSecAttrAccount as String: NSUserName(),
                            kSecReturnData as String: true, kSecMatchLimit as String: kSecMatchLimitOne]
    var out: CFTypeRef?
    guard SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess, let d = out as? Data else { return nil }
    return String(data: d, encoding: .utf8)
  }
  @discardableResult
  package static func save(_ token: String) -> Bool {
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
#endif
