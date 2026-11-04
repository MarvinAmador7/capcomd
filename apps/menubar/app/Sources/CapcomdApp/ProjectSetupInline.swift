#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

// The composer's inline project setup (design/setup/InlineSetup, InlineAttention, InlinePublish; setup-spec.md): a
// picked folder that isn't a set-up capcomd project swaps the tool row for its next steps, inside the composer card.
// ProjectSetupFlow (CapcomdStore) decides what shows; these views draw its SetupScreen.

extension AppModel {
  /// The picked folder's next steps for the composer card, or nil (the tool row shows).
  func setupScreen(goal: String) -> SetupScreen? { _ = revision; return setup.screen(goal: goal, sandbox: startSandbox?.name) }
  /// The card shows a folder's next steps (not just looking at it).
  var setupShowing: Bool { _ = revision; return setup.screen(goal: "", sandbox: nil).map { $0.phase != .loading } ?? false }
  /// The + menu's Choose Project Folder…, and Choose Another Folder… on the card.
  func chooseProjectFolder() {
    Task { if let f = await ProjectFolderPicker.choose(prompt: "Choose the project's folder.") { await setup.pick(f) } }
  }
  func cancelSetup() { setup.cancel() }
  /// Settings › General › New projects.
  var gitignoreCapcomd: Bool {
    get { _ = revision; return store.prefs.gitignoreCapcomd }
    set { store.prefs.gitignoreCapcomd = newValue; bump() }
  }
  /// The daemon applies it (`projects.git`).
  var gitignoreSupported: Bool { _ = revision; return store.projectGitSupported }

  /// A button on the card. Set Up (and Start) answers how it ended, for the composer's focus.
  func setupAction(_ a: SetupAction, goal: String) async -> SetupOutcome {
    switch a {
    case .setUp, .setUpAndStart: return await setup.submit(goal: goal) { [weak self] g in await self?.startRun(g) ?? false }
    case .initializeGit: await setup.initializeGit()
    case .publish: await setup.publish()
    case .logInToGitHub: TerminalLauncher.githubLogin()
    case .openInTerminal: if let p = setup.path { TerminalLauncher.setUpProject(in: p) }
    case .tryAgain: if let p = setup.path { await setup.pick(p) }
    }
    return .showing
  }
}

extension TerminalLauncher {
  /// Log In… / Log In to GitHub… on the card: the GitHub CLI's own login, in Terminal (the app never sees the token).
  @discardableResult
  static func githubLogin() -> Bool {
    script(name: "gh-login", """
      gh auth login
      echo
      echo "When you're logged in, open capcomd from the menu bar again."
      """)
  }

  /// Open in Terminal for a checkout that isn't on GitHub: `capcomd setup project` in the folder the person picked.
  @discardableResult
  static func setUpProject(in folder: String) -> Bool {
    let quoted = "'" + folder.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return script(name: "setup-project", """
      cd \(quoted) || exit 1
      capcomd setup project
      """)
  }
}
#endif
