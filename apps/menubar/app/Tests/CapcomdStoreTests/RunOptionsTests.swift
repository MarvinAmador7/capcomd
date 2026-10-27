import XCTest
@testable import CapcomdStore

final class FakeOptions: DaemonInfoFetching, @unchecked Sendable {
  var caps: Set<String> = [Capability.runsOptions]
  var asked: [String?] = []
  var refuse: String? = nil
  func capabilities() async throws -> Set<String> { caps }
  func skills() async throws -> [SkillInfo] { [] }
  func runOptions(repo: String?) async throws -> RunOptions {
    asked.append(repo)
    if let refuse { throw MessageRefused(refuse) }
    let planner = repo != nil
    return RunOptions(drivers: [DriverInfo(provider: "claude", label: "Claude Code", model: nil, available: planner, reason: planner ? nil : "No planner profile (run capcomd setup)", isDefault: planner)],
                      sandboxes: [SandboxInfo(name: "boxd", label: "VM", isDefault: true)])
  }
}

@MainActor
final class RunOptionsTests: XCTestCase {
  func testOptionsAreAskedForTheChosenProjectWhenTheDaemonCanSay() async {
    let info = FakeOptions()
    let s = CapcomdStore(daemonInfo: info)
    s.prefs.startRepo = "/Users/me/src/app"
    await s.refreshDaemonInfo()
    XCTAssertEqual(info.asked, [nil])                                        // older daemon: only its own project
    XCTAssertEqual(s.runOptions.drivers.first?.available, false)
    info.caps.insert(Capability.runsOptionsRepo)
    await s.refreshDaemonInfo()
    XCTAssertEqual(info.asked.last, "/Users/me/src/app")
    XCTAssertEqual(s.runOptions.drivers.first?.available, true)
  }

  func testAFolderThatIsNoProjectLeavesEveryDriverUnavailableSayingWhy() async {
    let info = FakeOptions(); info.caps.insert(Capability.runsOptionsRepo)
    let s = CapcomdStore(daemonInfo: info)
    s.prefs.startRepo = "/Users/me/src/app"
    await s.refreshDaemonInfo()
    info.refuse = "/Users/me/Downloads is not a capcomd project (no .capcomd/config.json in it or above it). Run `capcomd setup project` in it first."
    s.prefs.startRepo = "/Users/me/Downloads"
    await s.refreshRunOptions()
    XCTAssertEqual(s.runOptions.drivers.map(\.available), [false])
    XCTAssertEqual(s.runOptions.drivers.first?.reason, info.refuse)
    XCTAssertEqual(s.runOptions.sandboxes.map(\.name), ["boxd"])             // where it runs doesn't depend on the folder
  }
}
