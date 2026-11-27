import XCTest
@testable import CapcomdStore

/// The Settings redesign's preferences (design/desktop/settings): Show app icon, the menu bar mark and Dock icon picks,
/// the Notifications page's new rows, and Interface › Reel.
@MainActor
final class SettingsPrefsTests: XCTestCase {
  func testShowAppIconIsTheTwoSwitchesAndNeverBothOff() {
    typealias S = Presence.ShowAppIcon
    XCTAssertEqual(S(keepInDock: false, showInMenuBar: true), .menuBarOnly)     // the default
    XCTAssertEqual(S(keepInDock: true, showInMenuBar: true), .dockAndMenuBar)
    XCTAssertEqual(S(keepInDock: true, showInMenuBar: false), .dockOnly)
    XCTAssertEqual(S(keepInDock: false, showInMenuBar: false), .menuBarOnly)    // both off stored: the menu bar wins
    for c in S.allCases {
      XCTAssertTrue(c.keepInDock || c.showInMenuBar, "\(c) keeps a way in")
      XCTAssertEqual(S(keepInDock: c.keepInDock, showInMenuBar: c.showInMenuBar), c, "\(c) round-trips")
      // Without a window open the Dock icon shows exactly when the choice has it.
      XCTAssertEqual(Presence.showsInDock(windowOpen: false, keepInDock: c.keepInDock, showInMenuBar: c.showInMenuBar), c != .menuBarOnly)
    }
    XCTAssertEqual(S.allCases.map(\.title), ["Dock and menu bar", "Dock only", "Menu bar only"])
  }

  func testTheIconPicksAndNotificationRowsAreStored() {
    let p = UIPreferences(store: InMemoryPreferences())
    XCTAssertNil(p.menuBarMark); XCTAssertNil(p.dockIcon)
    XCTAssertTrue(p.notifyUsageLimits); XCTAssertTrue(p.badgeAppIcon)              // on until turned off
    p.menuBarMark = "ring"; p.dockIcon = "night"; p.notifyUsageLimits = false; p.badgeAppIcon = false
    XCTAssertEqual(p.menuBarMark, "ring"); XCTAssertEqual(p.dockIcon, "night")
    XCTAssertFalse(p.notifyUsageLimits); XCTAssertFalse(p.badgeAppIcon)
    let limit = Notice.usageLimit(runId: "run-1", agentId: "agt-1", title: "x", asker: nil, resumesAtMs: nil)
    XCTAssertFalse(p.allows(limit))
    p.notifyUsageLimits = true
    XCTAssertTrue(p.allows(limit))
    p.notifyApprovals = false; p.notifyRunFinished = false
    XCTAssertTrue(p.allows(limit))                                                   // its own switch
  }

  func testInterfaceReelPrefs() {
    typealias C = InterfacePrefs.Columns
    XCTAssertEqual(C(stored: 0), .fit); XCTAssertEqual(C(stored: 2), .two); XCTAssertEqual(C(stored: 7), .fit)
    for c in C.allCases { XCTAssertEqual(C(stored: c.stored), c) }
    XCTAssertEqual(InterfacePrefs.across(1440, .fit), 3)
    XCTAssertEqual(InterfacePrefs.across(1000, .fit), 2)
    XCTAssertEqual(InterfacePrefs.across(800, .fit), 1)
    XCTAssertEqual(InterfacePrefs.across(800, .three), 3)
    XCTAssertEqual(InterfacePrefs.across(1440, .one), 1)
    XCTAssertEqual(InterfacePrefs.CrewTabs(stored: nil), .botAndTitle)
    XCTAssertEqual(InterfacePrefs.CrewTabs(stored: "botOnly"), .botOnly)
    XCTAssertTrue(InterfacePrefs.followAtLaunch(nil))
    XCTAssertFalse(InterfacePrefs.followAtLaunch(false))
  }

  func ev(_ s: CapcomdStore, _ type: String, _ agent: String, seq: Int, _ data: [String: JSONValue] = [:]) {
    s.receive(.event(Envelope(id: "e\(seq)", scope: "lifecycle:run-x", seq: seq, entity: agent, type: type, epochMs: seq * 1000, projectId: "prj-x",
                              runId: "run-x", agentId: agent, data: data)), scope: "lifecycle:run-x")
  }

  /// A usage limit is said once per run while its agents wait on it, and again after the run picked up.
  func testAUsageLimitNotifiesOncePerPause() {
    let s = CapcomdStore(); var notices: [Notice] = []; s.onNotify = { notices.append($0) }
    let quota: [String: JSONValue] = ["result": .object(["limit": .string("quota")]), "until": .number(1_800_000_000_000)]
    ev(s, "agent.spawned", "agt-1", seq: 1, ["profile": .string("planner")])
    ev(s, "agent.spawned", "agt-2", seq: 2, ["profile": .string("worker"), "parentId": .string("agt-1")])
    ev(s, "agent.started", "agt-1", seq: 3); ev(s, "agent.started", "agt-2", seq: 4)
    ev(s, "agent.paused", "agt-2", seq: 5, quota)
    ev(s, "agent.paused", "agt-1", seq: 6, quota)                  // the same limit: no second notice
    ev(s, "agent.paused", "agt-1", seq: 7)                         // paused by hand: none
    let limits = notices.compactMap { n -> (String, Int?)? in if case .usageLimit(_, let a, _, _, let at) = n { return (a, at) }; return nil }
    XCTAssertEqual(limits.map(\.0), ["agt-2"])
    XCTAssertEqual(limits.first?.1, 1_800_000_000_000)
    ev(s, "agent.continued", "agt-1", seq: 8); ev(s, "agent.continued", "agt-2", seq: 9)
    ev(s, "agent.paused", "agt-1", seq: 10, quota)
    XCTAssertEqual(notices.filter { if case .usageLimit = $0 { return true }; return false }.count, 2)
  }
}
