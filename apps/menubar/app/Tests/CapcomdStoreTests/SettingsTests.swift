import XCTest
import Foundation
@testable import CapcomdStore

/// A daemon with (or without) the Settings routes.
final class FakeSettingsDaemon: DaemonInfoFetching, @unchecked Sendable {
  var caps: Set<String> = [Capability.runsOptions, Capability.runsOptionsSandbox, Capability.logins, Capability.environments, Capability.service]
  var version: String? = "0.6.0"
  var down = false
  var rejects = false
  var loginList: [LoginInfo] = []
  var envList: [EnvironmentInfo] = []
  var svc = ServiceInfo(installed: true, loaded: true)
  var options = RunOptions()
  func capabilities() async throws -> Set<String> { caps }
  func health() async throws -> DaemonHealth { if down { throw Boom() }; return DaemonHealth(version: version, capabilities: caps) }
  func skills() async throws -> [SkillInfo] { [] }
  func runOptions(repo: String?) async throws -> RunOptions { if down { throw Boom() }; return options }
  func logins() async throws -> [LoginInfo] { try check(); return loginList }
  func environments() async throws -> [EnvironmentInfo] { try check(); return envList }
  func service() async throws -> ServiceInfo { try check(); return svc }
  private func check() throws { if down { throw Boom() }; if rejects { throw Unauthorized() } }
}

/// run-options as a daemon with `runs.options.sandbox` answers: Claude can run on Cloud only, Codex nowhere.
func settingsOptions(dockerUp: Bool = true, boxdKey: Bool = true, perSandbox: Bool = true) -> RunOptions {
  RunOptions(
    drivers: [
      DriverInfo(provider: "claude", label: "Claude Code", available: true, isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"], effort: nil,
                 sandboxes: perSandbox ? ["docker": DriverAvailability(available: false, reason: "Not logged in to Claude Code for Local (run capcomd auth login claude --sandbox docker)"),
                                          "boxd": DriverAvailability(available: true)] : nil),
      DriverInfo(provider: "codex", label: "Codex", available: false, reason: "No agent environment for Cloud yet (run `capcomd env build --sandbox boxd`)", isDefault: false,
                 efforts: ["minimal", "low", "medium", "high"], effort: "medium",
                 sandboxes: perSandbox ? ["docker": DriverAvailability(available: false, reason: "Not logged in to Codex for Local (run capcomd auth login codex --sandbox docker)"),
                                          "boxd": DriverAvailability(available: false, reason: "No agent environment for Cloud yet (run `capcomd env build --sandbox boxd`)")] : nil),
    ],
    sandboxes: [SandboxInfo(name: "docker", label: "Local", available: dockerUp, reason: dockerUp ? nil : "Docker isn't running", isDefault: false),
                SandboxInfo(name: "boxd", label: "Cloud", available: boxdKey, reason: boxdKey ? nil : "No boxd API key (run capcomd setup)", isDefault: true)])
}

@MainActor
final class SettingsTests: XCTestCase {
  // MARK: decoding

  func testDecodesTheThreeRoutesAndHealth() throws {
    let logins = try SettingsWire.logins(Data(#"""
      {"logins":[{"provider":"claude","sandbox":"docker","loggedIn":false,"how":null,"detail":null,"command":"capcomd auth login claude --sandbox docker"},
                 {"provider":"claude","sandbox":"boxd","loggedIn":true,"how":"plan","detail":"Logged in with a Claude plan","command":"capcomd auth login claude --sandbox boxd"},
                 {"provider":"codex","sandbox":"docker","loggedIn":true,"how":"api_key","detail":null,"command":"capcomd auth login codex --sandbox docker"},
                 {"provider":"codex","sandbox":"boxd","loggedIn":false,"how":null,"detail":null,"command":"capcomd auth login codex --sandbox boxd"}]}
      """#.utf8))
    XCTAssertEqual(logins.count, 4)
    XCTAssertEqual(logins[1], LoginInfo(provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", detail: "Logged in with a Claude plan", command: "capcomd auth login claude --sandbox boxd"))
    XCTAssertNil(logins[0].how)

    let envs = try SettingsWire.environments(Data(#"""
      {"environments":[{"sandbox":"docker","status":"missing","name":null,"versions":{},"builtAt":null,"command":"capcomd env build --sandbox docker"},
                       {"sandbox":"boxd","status":"ready","name":"capcomd-env-boxd-3f2a91","versions":{"claude":"2.1.303","codex":"0.163.0","node":"22.11.0"},"builtAt":"2026-10-24T09:12:03.000Z","command":"capcomd env build --sandbox boxd"}]}
      """#.utf8))
    XCTAssertEqual(envs.map(\.status), ["missing", "ready"])
    XCTAssertEqual(envs[1].versions?["claude"], "2.1.303")
    XCTAssertEqual(envs[1].builtAt, "2026-10-24T09:12:03.000Z")

    let svc = try SettingsWire.service(Data(#"{"installed":true,"loaded":false,"installCommand":"capcomd service install","uninstallCommand":"capcomd service uninstall"}"#.utf8))
    XCTAssertEqual(svc, ServiceInfo(installed: true, loaded: false))

    let h = SettingsWire.health(Data(#"{"ok":true,"api":"harness.v1","version":"0.6.0-rc.1","capabilities":["logins","runs.options"]}"#.utf8))
    XCTAssertEqual(h, DaemonHealth(version: "0.6.0-rc.1", capabilities: ["logins", "runs.options"]))
    XCTAssertEqual(SettingsWire.health(Data(#"{"ok":true}"#.utf8)), DaemonHealth())   // older daemon: nothing advertised
  }

  func testUnknownFieldsAndMissingOptionalsDecode() throws {
    let e = try SettingsWire.environments(Data(#"{"environments":[{"sandbox":"boxd","status":"building","command":"capcomd env build --sandbox boxd","extra":1}]}"#.utf8))
    XCTAssertEqual(e, [EnvironmentInfo(sandbox: "boxd", status: "building", command: "capcomd env build --sandbox boxd")])
  }

  // MARK: logins

  func testLoginRowsFromTheLoginsRoute() {
    let infos = [LoginInfo(provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", command: "capcomd auth login claude --sandbox boxd"),
                 LoginInfo(provider: "claude", sandbox: "docker", loggedIn: false, command: "capcomd auth login claude --sandbox docker"),
                 LoginInfo(provider: "codex", sandbox: "boxd", loggedIn: true, how: "api_key", command: "capcomd auth login codex --sandbox boxd"),
                 LoginInfo(provider: "codex", sandbox: "docker", loggedIn: true, how: nil, command: "capcomd auth login codex --sandbox docker")]
    let opts = settingsOptions()
    let places = SettingsRows.accountPlaces(opts, infos)
    XCTAssertEqual(places, ["boxd", "docker"])                                 // Cloud first, as on the Accounts board
    let rows = SettingsRows.logins(.loaded(infos), options: opts, capabilities: [Capability.logins], places: places)
    XCTAssertEqual(rows.map(\.id), ["claude:boxd", "claude:docker", "codex:boxd", "codex:docker"])
    XCTAssertEqual(rows.map(\.state), [.plan, .notLoggedIn, .apiKey, .loggedIn])
    XCTAssertEqual(rows[1].command, "capcomd auth login claude --sandbox docker")
    XCTAssertTrue(rows[0].isLoggedIn); XCTAssertFalse(rows[1].isLoggedIn)
  }

  /// Without `GET /v1/logins`, run-options' per-sandbox answers stand in: a reason about logging in means logged out,
  /// any other reason (no agent environment) says nothing about the login.
  func testLoginRowsFallBackToRunOptionsPerSandbox() {
    let opts = settingsOptions()
    let rows = SettingsRows.logins(.unavailable(.unsupported), options: opts, capabilities: [Capability.runsOptions, Capability.runsOptionsSandbox], places: ["boxd", "docker"])
    XCTAssertEqual(rows.map(\.state), [.loggedIn, .notLoggedIn, .unknown, .notLoggedIn])
    XCTAssertEqual(rows[2].detail, "No agent environment for Cloud yet (run `capcomd env build --sandbox boxd`)")
    XCTAssertEqual(rows[1].command, "capcomd auth login claude --sandbox docker")      // the app's own command when the daemon gives none
  }

  /// An older daemon answers for its own place only (the default one); every other place is Unknown.
  func testLoginRowsOnADaemonThatAnswersForItsOwnPlaceOnly() {
    let opts = settingsOptions(perSandbox: false)
    let rows = SettingsRows.logins(nil, options: opts, capabilities: [Capability.runsOptions], places: ["boxd", "docker"])
    XCTAssertEqual(rows.map(\.state), [.loggedIn, .unknown, .unknown, .unknown])
    // No run-options at all: nothing is known.
    XCTAssertEqual(SettingsRows.logins(nil, options: RunOptions(), capabilities: [], places: SettingsRows.accountPlaces(RunOptions(), nil)).map(\.state),
                   [.unknown, .unknown, .unknown, .unknown])
    XCTAssertEqual(SettingsRows.accountPlaces(RunOptions(), nil), ["boxd", "docker"])
  }

  // MARK: environments, service, boxd key

  func testEnvironmentRows() throws {
    let infos = [EnvironmentInfo(sandbox: "docker", status: "missing", command: "capcomd env build --sandbox docker"),
                 EnvironmentInfo(sandbox: "boxd", status: "ready", versions: ["node": "22", "codex": "0.163.0", "claude": "2.1.303"], builtAt: "2026-10-24T09:12:03.000Z", command: "capcomd env build --sandbox boxd")]
    let rows = try XCTUnwrap(SettingsRows.environments(.loaded(infos), places: ["docker", "boxd", "gcp"]))
    XCTAssertEqual(rows.map(\.state), [.missing, .ready, .unknown])
    XCTAssertEqual(rows[1].versions.map(\.tool), ["Claude Code", "Codex"])                 // the agent tools, in that order; node isn't one
    XCTAssertEqual(rows[1].builtAt, SettingsRows.parseISO("2026-10-24T09:12:03Z"))
    XCTAssertEqual(rows[1].rebuildCommand, "capcomd env build --sandbox boxd --force")
    XCTAssertEqual(rows[2].command, "capcomd env build --sandbox gcp")
    XCTAssertEqual(SettingsRows.environments(.loaded([EnvironmentInfo(sandbox: "docker", status: "building", command: "x")]), places: ["docker"])?.first?.state, .building)
    XCTAssertEqual(SettingsRows.environments(.loaded([EnvironmentInfo(sandbox: "docker", status: "failed", command: "x")]), places: ["docker"])?.first?.state, .failed)
    XCTAssertNil(SettingsRows.environments(.unavailable(.unsupported), places: ["docker"]))   // older daemon: rows hidden
    XCTAssertNil(SettingsRows.environments(nil, places: ["docker"]))
  }

  func testServiceAndBoxdKey() {
    XCTAssertEqual(SettingsRows.service(.loaded(ServiceInfo(installed: true, loaded: true))), .on)
    XCTAssertEqual(SettingsRows.service(.loaded(ServiceInfo(installed: true, loaded: false))), .off)
    XCTAssertEqual(SettingsRows.service(.loaded(ServiceInfo(installed: false, loaded: false))), .off)
    XCTAssertEqual(SettingsRows.service(.unavailable(.unsupported)), .unknown)
    XCTAssertEqual(SettingsRows.boxdKey(settingsOptions()), .saved)
    XCTAssertEqual(SettingsRows.boxdKey(settingsOptions(boxdKey: false)), .notSet)
    XCTAssertEqual(SettingsRows.boxdKey(RunOptions()), .unknown)
  }

  func testConnectionState() {
    XCTAssertEqual(ConnectionState.of(tokenPending: true, tokenMissing: true, unauthorized: true, unreachable: true, version: nil), .waitingForKeychain)
    XCTAssertEqual(ConnectionState.of(tokenPending: false, tokenMissing: true, unauthorized: true, unreachable: true, version: nil), .noToken)
    XCTAssertEqual(ConnectionState.of(tokenPending: false, tokenMissing: false, unauthorized: true, unreachable: true, version: nil), .rejected)
    XCTAssertEqual(ConnectionState.of(tokenPending: false, tokenMissing: false, unauthorized: false, unreachable: true, version: "1"), .unreachable)
    XCTAssertEqual(ConnectionState.of(tokenPending: false, tokenMissing: false, unauthorized: false, unreachable: false, version: "0.6.0"), .connected(version: "0.6.0"))
    XCTAssertTrue(ConnectionState.connected(version: nil).live); XCTAssertFalse(ConnectionState.unreachable.live)
  }

  // MARK: the store

  func testRefreshReadsEveryRouteTheDaemonAdvertises() async {
    let d = FakeSettingsDaemon()
    d.options = settingsOptions()
    d.loginList = [LoginInfo(provider: "claude", sandbox: "boxd", loggedIn: true, how: "plan", command: "capcomd auth login claude --sandbox boxd")]
    d.envList = [EnvironmentInfo(sandbox: "boxd", status: "ready", command: "capcomd env build --sandbox boxd")]
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings()
    XCTAssertEqual(s.daemonVersion, "0.6.0")
    XCTAssertEqual(s.logins?.value?.count, 1)
    XCTAssertEqual(s.environments?.value?.first?.status, "ready")
    XCTAssertEqual(s.service?.value, ServiceInfo(installed: true, loaded: true))
    XCTAssertEqual(s.runOptions.sandboxes.map(\.name), ["docker", "boxd"])

    // capcomd goes away: what it last said stays (the window shows it disabled).
    d.down = true
    await s.refreshSettings()
    XCTAssertEqual(s.logins?.value?.count, 1)
    XCTAssertEqual(s.service?.value?.loaded, true)

    // A rejected token is the token prompt's business.
    d.down = false; d.rejects = true
    await s.refreshSettings()
    XCTAssertTrue(s.unauthorized)
  }

  func testAnOlderDaemonGetsTheRowsHiddenNotFailed() async {
    let d = FakeSettingsDaemon()
    d.caps = [Capability.runsOptions]; d.version = nil
    d.options = settingsOptions(perSandbox: false)
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings()
    XCTAssertNil(s.daemonVersion)
    XCTAssertEqual(s.logins, .unavailable(.unsupported))
    XCTAssertEqual(s.environments, .unavailable(.unsupported))
    XCTAssertEqual(s.service, .unavailable(.unsupported))
    XCTAssertEqual(SettingsRows.service(s.service), .unknown)
    XCTAssertNil(SettingsRows.environments(s.environments, places: ["docker", "boxd"]))
    XCTAssertEqual(SettingsRows.logins(s.logins, options: s.runOptions, capabilities: s.capabilities, places: ["boxd", "docker"]).map(\.state),
                   [.loggedIn, .unknown, .unknown, .unknown])
  }

  /// The composer reads the daemon's version too (refreshDaemonInfo goes through /v1/health).
  func testDaemonInfoKeepsTheVersion() async {
    let d = FakeSettingsDaemon(); d.version = "0.6.0-rc.1"
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshDaemonInfo()
    XCTAssertEqual(s.daemonVersion, "0.6.0-rc.1")
  }

  // MARK: the default place: Runs on ↔ Make Default ↔ the composer

  func testDefaultPlaceIsOneSettingForRunsOnMakeDefaultAndTheComposer() async {
    let d = FakeSettingsDaemon(); d.options = settingsOptions()
    let prefs = InMemoryPreferences()
    let s = CapcomdStore(daemonInfo: d, prefs: prefs)
    await s.refreshSettings()
    // Nothing picked yet: the daemon's default (Cloud) is the default, and the composer starts there.
    XCTAssertEqual(s.defaultPlace?.name, "boxd"); XCTAssertEqual(s.startSandbox?.name, "boxd")

    // Settings › Runs › Local › Make Default (or picking Local in Runs on): the composer starts on Local.
    s.setDefaultPlace("docker")
    XCTAssertEqual(s.defaultPlace?.name, "docker"); XCTAssertEqual(s.startSandbox?.name, "docker")
    XCTAssertEqual(prefs.string(forKey: "startSandbox"), "docker")

    // The composer's switch writes the same pref, so Settings shows Cloud as Default again.
    s.prefs.startSandbox = "boxd"
    XCTAssertEqual(s.defaultPlace?.name, "boxd")

    // A default that can't be used now stays the default in Settings; the composer falls back until it can.
    s.setDefaultPlace("docker")
    d.options = settingsOptions(dockerUp: false)
    await s.refreshSettings()
    XCTAssertEqual(s.defaultPlace?.name, "docker")
    XCTAssertEqual(s.startSandbox?.name, "boxd")
    d.options = settingsOptions()
    await s.refreshSettings()
    XCTAssertEqual(s.startSandbox?.name, "docker")

    // A place the daemon no longer lists isn't the default.
    s.setDefaultPlace("gcp")
    XCTAssertEqual(s.defaultPlace?.name, "boxd")
  }

  func testDriverAndEffortPicksAreShared() async {
    let d = FakeSettingsDaemon()
    var o = settingsOptions(); o.drivers[1].sandboxes = nil; o.drivers[1].available = true
    d.options = o
    let s = CapcomdStore(daemonInfo: d)
    await s.refreshSettings()
    XCTAssertEqual(s.startDriver?.provider, "claude")
    XCTAssertNil(s.startEffort)                           // Claude Code: Auto
    s.pickEffort("xhigh"); XCTAssertEqual(s.startEffort, "xhigh")
    s.pickEffort(nil); XCTAssertNil(s.startEffort); XCTAssertEqual(s.prefs.startEffort("claude"), UIPreferences.autoEffort)
    s.pickDriver("codex"); XCTAssertEqual(s.startDriver?.provider, "codex")
    XCTAssertEqual(s.startEffort, "medium")               // Codex's own default
  }

  // MARK: prefs

  func testNotificationPrefsGateEachKind() {
    let p = UIPreferences(store: InMemoryPreferences())
    let approval = Notice.approvalRequested(approvalId: "apr-1", runId: "run-1", question: UntrustedText("Merge?"))
    let finished = Notice.runFinished(runId: "run-1", type: "run.failed", title: "x")
    XCTAssertTrue(p.allows(approval)); XCTAssertTrue(p.allows(finished))          // both on by default
    p.notifyApprovals = false
    XCTAssertFalse(p.allows(approval)); XCTAssertTrue(p.allows(finished))
    p.notifyRunFinished = false; p.notifyApprovals = true
    XCTAssertTrue(p.allows(approval)); XCTAssertFalse(p.allows(finished))
  }

  /// "Finished runs: including runs that failed or were stopped": a stopped run notifies too.
  func testStoppedRunsNotifyAsFinished() {
    let s = CapcomdStore(); var notices: [Notice] = []; s.onNotify = { notices.append($0) }
    for (i, type) in ["run.completed", "run.failed", "run.cancelled"].enumerated() {
      let run = "run-\(i)"
      s.receive(StreamFrame.parse(event: type, data: StoreTests.envelope("evt_\(i)", seq: 1, type: type, run: run, data: #"{"cause":"x"}"#)), scope: "lifecycle:\(run)")
    }
    XCTAssertEqual(notices.compactMap { if case .runFinished(_, let t, _) = $0 { return t }; return nil }, ["run.completed", "run.failed", "run.cancelled"])
  }

  func testBotFacesOffKeepsThePlainMark() throws {
    let s = CapcomdStore()
    XCTAssertEqual(s.markFace, .idle)                      // nothing running: sleepy
    for (e, d) in try loadSSE("contract") { s.receive(StreamFrame.parse(event: e, data: d), scope: "run-a1") }
    XCTAssertEqual(s.markFace, .approval)                  // an approval waits
    s.prefs.botFaces = false
    XCTAssertEqual(s.markFace, .plain)
    s.prefs.botFaces = true
    XCTAssertEqual(s.markFace, .approval)
  }

  // MARK: Terminal hand-offs

  func testHandOffsEndWhenTheRowChangesTerminalQuitsOrTimeOut() {
    let t0 = Date(timeIntervalSince1970: 1_000_000)
    var h = HandOffs()
    h.start("login-claude-docker", command: "capcomd auth login claude --sandbox docker", baseline: "notLoggedIn|", at: t0)
    h.start("env-docker", command: "capcomd env build --sandbox docker", baseline: "missing|", at: t0)
    h.start("service", command: "capcomd service install", baseline: "off", at: t0)

    // Terminal still opening, nothing changed: all wait.
    h.settle(current: ["login-claude-docker": "notLoggedIn|", "env-docker": "missing|", "service": "off"], terminalRunning: false, now: t0.addingTimeInterval(2))
    XCTAssertEqual(h.open.count, 3)
    // Logged in: that row stops waiting.
    h.settle(current: ["login-claude-docker": "plan|", "env-docker": "missing|", "service": "off"], terminalRunning: true, now: t0.addingTimeInterval(30))
    XCTAssertNil(h.waiting("login-claude-docker")); XCTAssertNotNil(h.waiting("env-docker"))
    // Terminal quit after it had opened: the rest stop waiting.
    h.settle(current: ["env-docker": "missing|", "service": "off"], terminalRunning: false, now: t0.addingTimeInterval(40))
    XCTAssertTrue(h.open.isEmpty)

    h.start("service", command: "capcomd service install", baseline: "off", at: t0)
    h.settle(current: [:], terminalRunning: false, now: t0.addingTimeInterval(HandOffs.timeout + 1))
    XCTAssertNil(h.waiting("service"))                      // gave up waiting

    // Log In Again… that changes nothing: the script saying it finished ends the wait.
    h.start("login-claude-boxd", command: "capcomd auth login claude --sandbox boxd", baseline: "plan|", at: t0)
    h.settle(current: ["login-claude-boxd": "plan|"], terminalRunning: true, now: t0.addingTimeInterval(20))
    XCTAssertNotNil(h.waiting("login-claude-boxd"))
    h.settle(current: ["login-claude-boxd": "plan|"], finished: ["login-claude-boxd"], terminalRunning: true, now: t0.addingTimeInterval(25))
    XCTAssertNil(h.waiting("login-claude-boxd"))
  }

  // MARK: commands from the daemon

  func testOnlyPlainCapcomdCommandsReachTerminal() {
    for ok in ["capcomd auth login claude --sandbox docker", "capcomd env build --sandbox boxd --force", "capcomd service install",
               "CAPCOMD_SANDBOX=docker capcomd auth login codex", "capcomd setup accounts", "capcomd service install --port=6420"] {
      XCTAssertTrue(SettingsRows.isSafeCommand(ok), ok)
    }
    for bad in ["", "rm -rf ~", "capcomd auth login claude; rm -rf ~", "capcomd $(whoami)", "capcomd `id`", "capcomd auth login 'x'",
                "capcomd  service install", "capcomd service install && curl x | sh", "lower=1 capcomd service install", "capcomdx service",
                "capcomd service install\nrm -rf ~", "PATH=/tmp capcomd service install", "DYLD_INSERT_LIBRARIES=/tmp/x.dylib capcomd service install",
                "capcomd service install x>y"] {
      XCTAssertFalse(SettingsRows.isSafeCommand(bad), bad)
    }
  }

  // MARK: window size

  /// Accounts on a 949 pt screen with the Dock at the bottom: the window moves up rather than running under the Dock.
  func testTheWindowStaysInsideTheVisibleFrame() {
    let visible = CGRect(x: 0, y: 70, width: 1512, height: 849)            // Dock below 70, menu bar above 919
    let window = CGRect(x: 400, y: 949 - 252 - 500, width: 620, height: 500) // top edge at y=252 from the top
    // Taller pane: top kept when it fits…
    let a = WindowFit.fitted(window, height: 600, visible: visible)
    XCTAssertEqual(a.maxY, window.maxY); XCTAssertEqual(a.height, 600); XCTAssertGreaterThanOrEqual(a.minY, visible.minY)
    // …moved up when it would run under the Dock.
    let b = WindowFit.fitted(window, height: 820, visible: visible)
    XCTAssertEqual(b.height, 820); XCTAssertEqual(b.minY, visible.minY); XCTAssertLessThanOrEqual(b.maxY, visible.maxY)
    // Taller than the whole visible height: capped to it (the pane scrolls).
    let c = WindowFit.fitted(window, height: 1200, visible: visible)
    XCTAssertEqual(c, CGRect(x: 400, y: visible.minY, width: 620, height: visible.height))
    // Shorter: the top edge stays.
    XCTAssertEqual(WindowFit.fitted(window, height: 400, visible: visible).maxY, window.maxY)
  }
}
