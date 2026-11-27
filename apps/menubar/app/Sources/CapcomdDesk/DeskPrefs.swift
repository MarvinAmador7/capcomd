#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import CapcomdStore

/// Settings › Interface › Reel (InterfacePrefs): Columns across and Crew tabs, read from the app's defaults once and
/// again whenever Settings changes them (`changed()`), so the reel's layout pass and the tabs never read defaults
/// themselves. Observable: the tabs redraw, and the reel lays out again, when a value changes.
@Observable @MainActor
package final class DeskPrefs {
  package static let shared = DeskPrefs()
  /// Columns across: nil fits the window (3 from 1280 pt, 2 from 900, else 1).
  package private(set) var columns: InterfacePrefs.Columns = .fit
  package private(set) var crewTabs: InterfacePrefs.CrewTabs = .botAndTitle
  @ObservationIgnored package var defaults: UserDefaults? = .standard

  init() { read() }

  /// The reel's layout pass reads this (not observed: the reel lays out again on `didChange`).
  nonisolated(unsafe) package static var columnsNow: InterfacePrefs.Columns = .fit
  package static let didChange = Notification.Name("capcomd.deskPrefsChanged")

  /// Settings wrote a value: read them again, tell the reel.
  package static func changed() {
    shared.read()
    NotificationCenter.default.post(name: didChange, object: nil)
  }

  func read() {
    let d = defaults
    let c = InterfacePrefs.Columns(stored: d?.integer(forKey: InterfacePrefs.columnsKey) ?? 0)
    if c != columns { columns = c }
    Self.columnsNow = c
    let t = InterfacePrefs.CrewTabs(stored: d?.string(forKey: InterfacePrefs.crewTabsKey))
    if t != crewTabs { crewTabs = t }
  }

  /// Follow's value when the window opens (Settings › Interface › Follow asks and failures).
  package static func followAtLaunch(_ d: UserDefaults?) -> Bool { InterfacePrefs.followAtLaunch(d?.object(forKey: InterfacePrefs.followKey)) }
}
#endif
