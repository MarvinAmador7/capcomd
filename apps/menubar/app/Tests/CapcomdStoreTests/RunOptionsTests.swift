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
                      sandboxes: [SandboxInfo(name: "boxd", label: "Cloud", isDefault: true)])
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
    XCTAssertEqual(s.runOptions.drivers(in: "boxd").map(\.available), [false]) // nor do per-sandbox answers bring it back
  }

  func testOptionsAreReadAgainWhenTheDaemonComesBack() async throws {
    let info = FakeOptions(); info.caps = []                                   // down at launch: nothing read
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshDaemonInfo()
    XCTAssertTrue(s.runOptions.drivers.isEmpty)
    info.caps = [Capability.runsOptions]
    s.receive(.link(up: false), scope: "daemon")
    s.receive(.link(up: true), scope: "daemon")
    for _ in 0..<100 where s.runOptions.drivers.isEmpty { try await Task.sleep(nanoseconds: 10_000_000) }
    XCTAssertEqual(s.runOptions.drivers.map(\.provider), ["claude"])
  }

  func testADriverIsAvailableOnlyWhereItCanRun() {
    let o = RunOptions(drivers: [DriverInfo(provider: "claude", label: "Claude Code", available: true,
                                            sandboxes: ["boxd": DriverAvailability(available: true),
                                                        "docker": DriverAvailability(available: false, reason: "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)")])])
    XCTAssertEqual(o.drivers(in: "boxd").first?.available, true)
    XCTAssertEqual(o.drivers(in: "docker").first?.available, false)
    XCTAssertEqual(o.drivers(in: "docker").first?.reason, "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)")
    XCTAssertEqual(o.drivers(in: nil).first?.available, true)                 // older daemon: its own sandbox's answer
  }

  func testPerSandboxAnswersDecode() throws {
    let json = #"{"drivers":[{"provider":"claude","label":"Claude Code","model":null,"efforts":["low"],"effort":null,"available":true,"reason":null,"default":true,"sandboxes":{"docker":{"available":false,"reason":"No agent environment for Local yet"},"boxd":{"available":true,"reason":null}}}],"sandboxes":[{"name":"docker","label":"Local","available":true,"reason":null,"default":false}]}"#
    let o = try JSONDecoder().decode(RunOptions.self, from: Data(json.utf8))
    XCTAssertEqual(o.drivers.first?.sandboxes?["docker"], DriverAvailability(available: false, reason: "No agent environment for Local yet"))
  }
}
