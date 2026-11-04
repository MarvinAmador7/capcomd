import XCTest
@testable import CapcomdStore

final class AppShellTests: XCTestCase {
  func testTheDockIconShowsWhileAWindowIsOpenOrWhenKeptOrWhenTheMenuBarItemIsOff() {
    XCTAssertTrue(Presence.showsInDock(windowOpen: true, keepInDock: false, showInMenuBar: true))
    XCTAssertFalse(Presence.showsInDock(windowOpen: false, keepInDock: false, showInMenuBar: true))   // the menu bar is home
    XCTAssertTrue(Presence.showsInDock(windowOpen: false, keepInDock: true, showInMenuBar: true))
    XCTAssertTrue(Presence.showsInDock(windowOpen: false, keepInDock: false, showInMenuBar: false))  // never unreachable
  }

  func testTheLastWayInCantBeTurnedOff() {
    XCTAssertFalse(Presence.canTurnOffKeepInDock(showInMenuBar: false))
    XCTAssertTrue(Presence.canTurnOffKeepInDock(showInMenuBar: true))
    XCTAssertFalse(Presence.canTurnOffMenuBar(keepInDock: false))
    XCTAssertTrue(Presence.canTurnOffMenuBar(keepInDock: true))
    XCTAssertTrue(Presence.showsInMenuBar(keepInDock: false, showInMenuBar: false))   // both off stored: the menu bar wins
    XCTAssertFalse(Presence.showsInMenuBar(keepInDock: true, showInMenuBar: false))
  }

  /// The window's Choose Project Folder…: a click there while another app is in front used to begin the Open panel
  /// behind that app. The app is made regular and active first when it isn't, and the panel is always ordered front.
  func testTheOpenPanelComesToTheFront() {
    // Clicked while another app was in front (the window takes the first click): ask to be active.
    XCTAssertEqual(Presence.beforeOpenPanel(regular: true, active: false), OpenPanelSteps(becomeRegular: false, activate: true, orderFront: true))
    // Reached with no window open (an accessory app, the menu bar its home): regular first, or the first click cancels it.
    XCTAssertEqual(Presence.beforeOpenPanel(regular: false, active: true), OpenPanelSteps(becomeRegular: true, activate: true, orderFront: true))
    XCTAssertEqual(Presence.beforeOpenPanel(regular: false, active: false), OpenPanelSteps(becomeRegular: true, activate: true, orderFront: true))
    // Active with the window key: nothing to change, still in front.
    XCTAssertEqual(Presence.beforeOpenPanel(regular: true, active: true), OpenPanelSteps(becomeRegular: false, activate: false, orderFront: true))
  }

  private func deck(_ project: String, _ run: String) -> DeckInfo {
    DeckInfo(id: project, runId: run, title: project, startedAtMs: nil, endedHead: nil, isRunning: true, sandbox: nil,
             askingAgentId: nil, askingName: nil, agentIds: [])
  }

  func testARunOpensItsDeckElseItsProjects() {
    let decks = [deck("p1", "run-a"), deck("p2", "run-b")]
    XCTAssertEqual(DeepLink.deck(forRun: "run-b", project: nil, in: decks)?.id, "p2")
    XCTAssertEqual(DeepLink.deck(forRun: "run-old", project: "p1", in: decks)?.id, "p1")   // an older run of p1
    XCTAssertNil(DeepLink.deck(forRun: "run-x", project: "p9", in: decks))
  }

  func testAnAgentLandsOnItsColumnOrItsNearestAncestorsOrThePlanners() {
    let parents = ["agt-helper": "agt-lead", "agt-lead": "agt-planner", "agt-loop": "agt-loop2", "agt-loop2": "agt-loop"]
    let parent: (String) -> String? = { parents[$0] }
    let cols = ["agt-planner", "agt-lead"]
    XCTAssertEqual(DeepLink.column(for: "agt-lead", columns: cols, parent: parent), "agt-lead")
    XCTAssertEqual(DeepLink.column(for: "agt-helper", columns: cols, parent: parent), "agt-lead")
    XCTAssertEqual(DeepLink.column(for: nil, columns: cols, parent: parent), "agt-planner")
    XCTAssertEqual(DeepLink.column(for: "agt-loop", columns: cols, parent: parent), "agt-planner")   // a cycle ends
    XCTAssertNil(DeepLink.column(for: "agt-lead", columns: [], parent: parent))
  }

  @MainActor func testSelectionIsOneValueAndReportsOnlyItsKey() {
    let s = CapcomdStore()
    var keys: [Set<ChangeKey>] = []
    s.onChanges = { keys.append($0) }
    s.select(runId: "run-a", agentId: "agt-1")
    s.select(runId: "run-a", agentId: "agt-1")   // unchanged: nothing reported
    XCTAssertEqual(s.selection, Selection(runId: "run-a", agentId: "agt-1"))
    s.select(runId: nil, agentId: "agt-1")
    XCTAssertNil(s.selection)
    XCTAssertEqual(keys, [[.selection], [.selection]])
  }
}
