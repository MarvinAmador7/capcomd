import Foundation

// The app's two views of one store: the window and the menu bar panel. What's in focus lives in the store, so both
// show the same run and agent; a panel row opens the window there (DeepLink); the Dock icon shows while a window is
// open, or always with Keep in Dock (Presence).

/// The run and agent in focus: the window's open project and column. The panel marks them.
public struct Selection: Equatable, Sendable {
  public var runId: String
  public var agentId: String?
  public init(runId: String, agentId: String?) { self.runId = runId; self.agentId = agentId }
}

extension CapcomdStore {
  /// Focus a run (and an agent in it), or nothing. A change reports `.selection` only, so the window refreshes nothing
  /// else.
  public func select(runId: String?, agentId: String?) {
    let s = runId.map { Selection(runId: $0, agentId: agentId) }
    guard s != selection else { return }
    selection = s
    mark(.selection); changed()
  }
}

/// Where a panel row (or a notification) lands in the window.
public enum DeepLink {
  /// The project to open for a run: the deck showing that run, else its project's deck (a finished run whose project
  /// moved on to a newer one).
  public static func deck(forRun runId: String, project: String?, in decks: [DeckInfo]) -> DeckInfo? {
    decks.first { $0.runId == runId } ?? project.flatMap { p in decks.first { $0.id == p } }
  }

  /// The column for an agent: its own, else its nearest ancestor's (a column may stand for its folded helpers), else
  /// the first (the planner). Nil: no columns yet.
  public static func column(for agentId: String?, columns: [String], parent: (String) -> String?) -> String? {
    var a = agentId, seen = Set<String>()
    while let id = a, seen.insert(id).inserted {
      if columns.contains(id) { return id }
      a = parent(id)
    }
    return columns.first
  }
}

/// The Dock icon and the menu bar item. The menu bar item is the app's home: closing the last window keeps the app
/// running there, and the Dock icon (with ⌘-Tab) shows only while a window is open, unless Keep in Dock. One of the two
/// always stays, so the app can't become unreachable.
public enum Presence {
  public static func showsInDock(windowOpen: Bool, keepInDock: Bool, showInMenuBar: Bool) -> Bool {
    windowOpen || keepInDock || !showInMenuBar
  }
  /// Settings disables the toggle that would turn the last one off.
  public static func canTurnOffKeepInDock(showInMenuBar: Bool) -> Bool { showInMenuBar }
  public static func canTurnOffMenuBar(keepInDock: Bool) -> Bool { keepInDock }
  /// Stored values with both off (`defaults write`, say) read as the menu bar item on.
  public static func showsInMenuBar(keepInDock: Bool, showInMenuBar: Bool) -> Bool { showInMenuBar || !keepInDock }
}
