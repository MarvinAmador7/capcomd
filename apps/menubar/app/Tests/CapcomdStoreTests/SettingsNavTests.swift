import XCTest
@testable import CapcomdStore

/// The Settings window's Back and Forward, and its search (design/desktop/settings).
final class SettingsNavTests: XCTestCase {
  func testBackAndForwardWalkPagesAndPushedPages() {
    var n = SettingsNav()
    XCTAssertEqual(n.current, .page(.general))
    XCTAssertFalse(n.canGoBack); XCTAssertFalse(n.canGoForward)
    n.go(.page(.runs)); n.go(.place("boxd"))
    XCTAssertEqual(n.current.page, .runs)                 // a place keeps Runs selected
    n.goBack(); XCTAssertEqual(n.current, .page(.runs))
    n.goBack(); XCTAssertEqual(n.current, .page(.general))
    n.goBack(); XCTAssertEqual(n.current, .page(.general)) // nothing before: stays
    n.goForward(); n.goForward()
    XCTAssertEqual(n.current, .place("boxd"))
    n.goBack(); n.go(.page(.about))                         // a new page clears Forward
    XCTAssertFalse(n.canGoForward)
    n.go(.page(.about)); n.goBack()                         // the same page again isn't a step
    XCTAssertEqual(n.current, .page(.runs))
  }

  func testTheSidebarsGroups() {
    XCTAssertEqual(SettingsPage.groups.flatMap { $0 }, [.general, .notifications, .interface, .shortcuts, .runs, .accounts, .about])
    XCTAssertEqual(SettingsPage.status.title, "capcomd")
  }

  func testSearchFindsRowsLoginsAndPlaces() {
    let entries = SettingsSearch.entries(providers: [("claude", "Claude Code"), ("codex", "Codex")],
                                         places: [("docker", "Local"), ("boxd", "Cloud")], boxd: true)
    // The board's "login": the logins first (a word starts with it), then Open at login, then a place's Logins row.
    let r = SettingsSearch.results("login", in: entries)
    XCTAssertEqual(Array(r.prefix(5).map(\.entry.title)), ["Claude Code logins", "Codex logins", "Open at login", "Logins · Local", "Logins · Cloud"])
    XCTAssertEqual(r.first?.entry.route, .page(.accounts))
    XCTAssertEqual(r.first?.entry.card, "accounts.claude")
    XCTAssertEqual(r.first?.match, 12..<17)                 // "logins" in "Claude Code logins": the bold part
    XCTAssertEqual(r.first { $0.entry.title == "Logins · Cloud" }?.entry.route, .place("boxd"))
    XCTAssertEqual(r.first { $0.entry.title == "Logins · Cloud" }?.entry.pageTitle, "Runs")
    // Case and accents don't matter; a keyword finds what its title doesn't say.
    XCTAssertEqual(SettingsSearch.results("DOCK", in: entries).first?.entry.title, "Dock icon")
    XCTAssertTrue(SettingsSearch.results("quota", in: entries).contains { $0.entry.title == "Usage limits" && $0.match == nil })
    XCTAssertTrue(SettingsSearch.results("  ", in: entries).isEmpty)
    XCTAssertTrue(SettingsSearch.results("zzz", in: entries).isEmpty)
    // Every shortcut can be found.
    XCTAssertEqual(SettingsSearch.results("split down", in: entries).first?.entry.card, "shortcuts.panes")
  }
}
