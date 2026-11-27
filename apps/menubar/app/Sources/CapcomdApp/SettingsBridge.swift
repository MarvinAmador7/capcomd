#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot
import CapcomdSettings

/// What the panel and the onboarding read of Settings (CapcomdSettings' SettingsModel, on the same store): the logins
/// and the Terminal hand-offs they share with the Settings window, and the menu bar mark it picks.
extension AppModel {
  /// Rows waiting on Terminal: the Settings window's, so a login started in the onboarding waits there too.
  var handOffs: HandOffs {
    get { settings.handOffs }
    set { settings.handOffs = newValue }
  }
  var loginRows: [LoginRow] { settings.loginRows }
  var connection: ConnectionState { settings.connection }
  func refreshSettings() async { await settings.refreshSettings() }
  @discardableResult
  func handOff(_ key: String, command: String, baseline: String) -> Bool { settings.handOff(key, command: command, baseline: baseline) }
  /// Settings › General › App Icon › Menu bar.
  var menuBarMark: MenuBarMark { _ = revision; return settings.menuBarMark }
}
#endif
