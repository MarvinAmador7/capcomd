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

  func start(_ scene: String) async throws -> UnixSocketTransport {
    try? FileManager.default.removeItem(atPath: Self.sock)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe")
    p.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/server.ts").standardized.path, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": "test-token", "SETTINGS": scene]) { $1 }
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
}
