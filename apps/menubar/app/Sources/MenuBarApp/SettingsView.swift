#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

/// The Settings window (design/settings/*.dc.html): the system Settings scene, a toolbar tab per pane (the window
/// title follows the pane), each pane a grouped Form whose height the window fits. Changes apply at once; anything
/// that has to run in a terminal opens Terminal with the command ready, and the row follows it.
struct SettingsView: View {
  @Environment(AppModel.self) private var model
  enum Pane: Hashable { case general, accounts, runs, about }
  @State private var pane: Pane = .general

  var body: some View {
    TabView(selection: $pane) {
      GeneralPane().tabItem { Label("General", systemImage: "gearshape") }.tag(Pane.general)
      AccountsPane().tabItem { Label("Accounts", systemImage: "person.crop.circle") }.tag(Pane.accounts)
      RunsPane().tabItem { Label("Runs", systemImage: "square.stack.3d.up") }.tag(Pane.runs)
      AboutPane().tabItem { Label("About", systemImage: "info.circle") }.tag(Pane.about)
    }
    .frame(width: Theme.Settings.width)
    // Every route Settings reads is cheap: read them while the window is open, and at once when the app comes back
    // from Terminal.
    .task {
      while !Task.isCancelled {
        await model.refreshSettings()
        try? await Task.sleep(for: .seconds(Theme.Settings.poll))
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      Task { await model.refreshSettings() }
    }
    // A menu bar app is an accessory: bring the window forward when it opens (⌘, or the panel's Settings…).
    .onAppear { DispatchQueue.main.async { SettingsWindow.front() } }
  }
}
#endif
