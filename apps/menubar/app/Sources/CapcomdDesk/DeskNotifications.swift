#if canImport(SwiftUI) && os(macOS)
import AppKit
import UserNotifications
import CapcomdStore

/// The desktop app's notifications: a goal branch run that is ready, or stopped with work landed (the store's goal
/// notice, raised once per run from the live lifecycle feed). The menu bar app posts the same notice, so the window
/// posts only while it isn't running (one banner per run either way). A click opens the run on its planner's column,
/// where the card is. UNUserNotificationCenter needs a bundle: a bare `swift run` binary posts nothing.
@MainActor package enum DeskNotifications {
  static var available: Bool { Bundle.main.bundleIdentifier != nil }
  /// The menu bar app's executable: while it runs, it is the one that notifies.
  static let menuBarExecutable = "CapcomdMenuBar"
  private static let delegate = Delegate()
  static var onOpenRun: ((String) -> Void)?

  static func start(_ model: DeskModel) {
    onOpenRun = { [weak model] rid in model?.openRun(rid); NSApp.activate() }
    guard available else { return }
    let c = UNUserNotificationCenter.current()
    c.delegate = delegate
    c.requestAuthorization(options: [.alert, .sound]) { _, _ in }
  }

  static func post(_ n: Notice, prefs: UIPreferences) {
    guard available, case .goalReady(let g) = n, prefs.allows(n) else { return }
    let menuBar = NSWorkspace.shared.runningApplications.contains { $0.executableURL?.lastPathComponent == menuBarExecutable }
    guard !menuBar else { return }
    let c = UNMutableNotificationContent()
    c.title = g.title; c.body = g.line; c.userInfo = ["runId": g.runId]
    UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: "goal-\(g.runId)", content: c, trigger: nil))
  }

  final class Delegate: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
      guard let rid = response.notification.request.content.userInfo["runId"] as? String else { return }
      await MainActor.run { DeskNotifications.onOpenRun?(rid) }
    }
    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
      [.banner, .sound]
    }
  }
}
#endif
