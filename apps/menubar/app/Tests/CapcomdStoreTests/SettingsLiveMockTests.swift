import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive
import CapcomdClient

/// The live adapter against the Bun mock with its Settings scenes (client/mock/settings.ts): the routes decode, and a
/// daemon without them leaves the rows hidden rather than failing.
@MainActor
final class SettingsLiveMockTests: XCTestCase {
  static let sock = NSTemporaryDirectory() + "capcomd-settings-\(getpid()).sock"
  var server: Process?
  var transport: UnixSocketTransport?

  func start(_ scene: String, sandboxes: String = "machines") async throws -> UnixSocketTransport {
    try? FileManager.default.removeItem(atPath: Self.sock)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe")
    p.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/server.ts").standardized.path, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": "test-token", "SETTINGS": scene, "SANDBOXES": sandboxes]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); server = p
    for _ in 0..<100 where !FileManager.default.fileExists(atPath: Self.sock) { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(100))
    let t = UnixSocketTransport(socketPath: Self.sock, token: "test-token"); transport = t
    return t
  }

  override func tearDown() async throws {
    try? await transport?.shutdown()
    server?.terminate(); server?.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock)
  }

  func testTheSettingsRoutesDecodeAndMapToTheBoards() async throws {
    let info = LiveDaemonInfo(transport: try await start("mixed"))
    let h = try await info.health()
    XCTAssertTrue(h.capabilities.isSuperset(of: [Capability.logins, Capability.environments, Capability.service, Capability.runsOptionsSandbox]))
    XCTAssertEqual(h.version, "mock-pr40")
    let logins = try await info.logins()
    XCTAssertEqual(logins.count, 4)
    let envs = try await info.environments()
    XCTAssertEqual(envs.map(\.sandbox), ["docker", "boxd"])
    let svc = try await info.service()
    XCTAssertTrue(svc.installed && svc.loaded)

    let s = CapcomdStore(daemonInfo: info)
    await s.refreshSettings()
    let places = SettingsRows.accountPlaces(s.runOptions, s.logins?.value)
    let rows = SettingsRows.logins(s.logins, options: s.runOptions, capabilities: s.capabilities, places: places)
    // The Accounts board: Claude logged in with a plan on Cloud only, Codex nowhere.
    XCTAssertEqual(rows.map(\.id), ["claude:boxd", "claude:docker", "codex:boxd", "codex:docker"])
    XCTAssertEqual(rows.map(\.state), [.plan, .notLoggedIn, .notLoggedIn, .notLoggedIn])
    XCTAssertTrue(rows.allSatisfy { SettingsRows.isSafeCommand($0.command) })
    // The Runs board: Local not built, Cloud ready with its tools.
    let env = try XCTUnwrap(SettingsRows.environments(s.environments, places: s.runOptions.sandboxes.map(\.name)))
    XCTAssertEqual(env.map(\.state), [.missing, .ready])
    XCTAssertEqual(env[1].versions.map { "\($0.tool) \($0.version)" }, ["Claude Code 2.1.303", "Codex 0.163.0"])
    XCTAssertEqual(SettingsRows.service(s.service), .on)
    XCTAssertEqual(s.defaultPlace?.name, "boxd")
  }

  func testAnOlderDaemonAnswers404AndTheRowsFallBack() async throws {
    let info = LiveDaemonInfo(transport: try await start("old"))
    do { _ = try await info.logins(); XCTFail("expected unsupported") } catch DetailUnavailable.unsupported {}
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshSettings()
    XCTAssertEqual(s.logins, .unavailable(.unsupported))
    XCTAssertEqual(s.environments, .unavailable(.unsupported))
    XCTAssertEqual(SettingsRows.service(s.service), .unknown)
    // run-options answers for the daemon's own place (Cloud) only: Claude can run there, Codex isn't logged in there.
    let rows = SettingsRows.logins(s.logins, options: s.runOptions, capabilities: s.capabilities, places: ["boxd", "docker"])
    XCTAssertEqual(rows.map(\.state), [.loggedIn, .unknown, .notLoggedIn, .unknown])
  }

  // MARK: place details (ADR-021 phase 1)

  func testPlaceDetailsAndMachinesFromTheMock() async throws {
    let info = LiveDaemonInfo(transport: try await start("mixed"))
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshSettings()
    XCTAssertTrue(s.capabilities.isSuperset(of: [Capability.sandboxes, Capability.sandboxesResources]))
    // The test provider (`listed: false`) stays out.
    XCTAssertEqual(s.sandboxList?.value?.map(\.name), ["docker", "boxd"])
    XCTAssertEqual(s.sandboxDescriptor("docker")?.kind, .local)
    XCTAssertEqual(s.sandboxDescriptor("boxd")?.displayTitle, "Cloud · boxd")

    await s.refreshSandbox("boxd")
    let detail = try XCTUnwrap(s.sandboxDetails["boxd"]?.value)
    let sections = SandboxRows.sections(detail)
    XCTAssertEqual(sections.machines.map(\.id), ["idleLifetime"])
    XCTAssertEqual(sections.machines.first?.shown, "1 hour")
    XCTAssertEqual(sections.safety.map(\.id), ["logins", "checkpoints"])
    let page = try XCTUnwrap(s.sandboxResources["boxd"]?.value)
    XCTAssertFalse(page.stale)
    let rows = SandboxRows.machines(page, descriptor: s.sandboxDescriptor("boxd"))
    XCTAssertEqual(rows.map(\.title), ["reviewer · Add an abs(a) function to math.ts", "worker · Add an abs(a) function to math.ts", "Left behind · no agent owns it"])
    XCTAssertEqual(rows.map(\.age), ["1 min", "4 min", "2 h"])
    XCTAssertTrue(rows.allSatisfy(\.canOpenTerminal))
    // Logins on Cloud: Claude's is bound to its API host.
    XCTAssertEqual(SandboxRows.loginsSummary(s.logins?.value ?? [], sandbox: "boxd")?.text, "Bound")
    XCTAssertEqual(SandboxRows.loginsSummary(s.logins?.value ?? [], sandbox: "docker")?.text, "No logins")

    let owned = await s.terminalCommand(sandbox: "boxd", resource: "relay-3f9c2a1b7e5d4c60")
    XCTAssertEqual(owned, .ready("capcomd sandbox shell run-8kq2 agt-41"))
    let orphan = await s.terminalCommand(sandbox: "boxd", resource: "relay-0c11d5e2a9b74f08")
    XCTAssertEqual(orphan, .ready("capcomd sandbox shell --sandbox boxd --machine relay-0c11d5e2a9b74f08"))
    let gone = await s.terminalCommand(sandbox: "boxd", resource: "relay-gone")
    XCTAssertEqual(gone, .unavailable("This machine is gone."))
  }

  func testAStaleProviderKeepsItsLastList() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "stale")))
    await s.refreshSettings()
    await s.refreshSandbox("boxd")
    let page = try XCTUnwrap(s.sandboxResources["boxd"]?.value)
    XCTAssertTrue(page.stale)
    XCTAssertEqual(page.error, "boxd didn't answer within 3 s")
    XCTAssertEqual(page.resources.count, 3)
    await s.refreshSandbox("docker")
    XCTAssertEqual(s.sandboxResources["docker"]?.value?.stale, false)
  }

  func testUnsafeTerminalCommandsAreRefused() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "unsafe")))
    await s.refreshSettings()
    let r = await s.terminalCommand(sandbox: "boxd", resource: "relay-3f9c2a1b7e5d4c60")
    XCTAssertEqual(r, .refused)
  }

  func testNoMachinesAndNoResourceRoutes() async throws {
    let empty = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "empty")))
    await empty.refreshSettings()
    await empty.refreshSandbox("boxd")
    XCTAssertEqual(empty.sandboxResources["boxd"]?.value?.resources, [])
    try? await transport?.shutdown(); server?.terminate(); server?.waitUntilExit()

    let nores = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("mixed", sandboxes: "nores")))
    await nores.refreshSettings()
    XCTAssertTrue(nores.capabilities.contains(Capability.sandboxes))
    XCTAssertFalse(nores.capabilities.contains(Capability.sandboxesResources))
    await nores.refreshSandbox("boxd")
    XCTAssertNotNil(nores.sandboxDetails["boxd"]?.value)
    XCTAssertEqual(nores.sandboxResources["boxd"], .unavailable(.unsupported))
  }

  func testAnOldDaemonHasNoPlaceDetails() async throws {
    let s = CapcomdStore(daemonInfo: LiveDaemonInfo(transport: try await start("old")))
    await s.refreshSettings()
    XCTAssertEqual(s.sandboxList, .unavailable(.unsupported))
    await s.refreshSandbox("boxd")
    XCTAssertEqual(s.sandboxDetails["boxd"], .unavailable(.unsupported))
  }
}
