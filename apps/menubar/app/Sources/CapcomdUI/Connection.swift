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
    UserDefaults.standard.string(forKey: "capcomd.socketPath")
      ?? (NSHomeDirectory() as NSString).appendingPathComponent(".capcomd/harness.sock")
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
