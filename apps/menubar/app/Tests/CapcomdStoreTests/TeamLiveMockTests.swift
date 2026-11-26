import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive
import CapcomdClient

/// The live adapter against the Bun mock's profile routes (client/mock/profiles.ts): the Team screen's reads and writes
/// decode, a stale rev is a conflict, and a daemon without the newer routes leaves those parts out.
@MainActor
final class TeamLiveMockTests: XCTestCase {
  static let sock = NSTemporaryDirectory() + "capcomd-team-\(getpid()).sock"
  var server: Process?
  var transport: UnixSocketTransport?

  func start(_ scene: String) async throws -> LiveDaemonInfo {
    try? FileManager.default.removeItem(atPath: Self.sock)
    let p = Process()
    p.executableURL = BunPath.url
    p.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/server.ts").standardized.path, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": "test-token", "PROFILES": scene]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); server = p
    for _ in 0..<100 where !FileManager.default.fileExists(atPath: Self.sock) { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(100))
    let t = UnixSocketTransport(socketPath: Self.sock, token: "test-token"); transport = t
    return LiveDaemonInfo(transport: t)
  }

  override func tearDown() async throws {
    try? await transport?.shutdown()
    server?.terminate(); server?.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock)
  }

  func testTheRoutesDecodeAndTheRosterIsByProject() async throws {
    let info = try await start("team")
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshDaemonInfo()
    XCTAssertTrue(s.team.available)
    await s.team.refresh()
    XCTAssertEqual(s.team.roster.map(\.title), ["capcomd", "capcomd-site", "All projects"])
    XCTAssertEqual(s.team.roster[0].members.map(\.role.rawValue), ["plans", "leads", "builds", "reviews"])
    XCTAssertEqual(s.team.roster[2].members.map(\.title), ["Security critic", "tern"])
    let key = try XCTUnwrap(s.team.roster[2].members.first?.id)
    await s.team.load(key)
    let d = try XCTUnwrap(s.team.details[key])
    let names = Dictionary(s.runOptions.drivers.flatMap { $0.models ?? [] }.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(TeamSummary.line(d.profile, detail: d, models: names), "Opus 5.5 · high · Cloud · read-only · alone · 40 turns · 30 min · 2 skills")
    XCTAssertEqual(d.field("sharing.source")?.value, "acme/capcomd-profiles")
    XCTAssertEqual(s.team.work[key]?.map(\.outcome), ["found_issues", "passed"])
    XCTAssertNotNil(s.team.work[key]?.first?.endedAtMs)
    XCTAssertTrue(s.team.personas[key]?.text?.hasPrefix("You are Security critic.") ?? false)
    XCTAssertEqual(s.team.rows[key]?.avatarSeed, "security-critic-seed")

    // A change is written; a stale rev is a conflict.
    await s.team.set(key, ["limits.maxTurns": "45"])
    XCTAssertEqual(s.team.details[key]?.field("limits.maxTurns")?.display, "45 turns")
    do { _ = try await info.updateProfile("security-critic", repo: nil, values: ["limits.maxTurns": "50"], rev: d.rev, idempotencyKey: "key-stale-1"); XCTFail("a stale rev was taken") }
    catch ProfileRefused.conflict(let rev) { XCTAssertEqual(rev, s.team.details[key]?.rev) }
    // A profile the daemon doesn't have is a refusal, not a missing route.
    do { _ = try await info.profile("nobody", repo: nil); XCTFail() } catch ProfileRefused.invalid(let m) { XCTAssertTrue(m.hasPrefix("profile")) }
    // The persona, over the hash it was read at.
    await s.team.savePersona(key, text: "You are Security critic. You never edit code.")
    XCTAssertEqual(s.team.personas[key]?.text, "You are Security critic. You never edit code.")
  }

  func testAConflictReadsAgainAndRetries() async throws {
    let info = try await start("conflict")
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshDaemonInfo()
    await s.team.refresh()
    let key = TeamKey.make(repo: "/Users/dev/capcomd", name: "warden")
    await s.team.load(key)
    await s.team.set(key, ["identity.title": "Warden"])
    XCTAssertEqual(s.team.details[key]?.profile.title, "Warden")
    XCTAssertNil(s.team.refusals[key])
    XCTAssertEqual(s.team.roster[0].members.first { $0.id == key }?.title, "Warden")
  }

  func testWithoutTheNewerRoutesThosePartsAreLeftOut() async throws {
    let info = try await start("basic")
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshDaemonInfo()
    XCTAssertFalse(s.capabilities.contains(Capability.profilesWork))
    await s.team.refresh()
    let key = try XCTUnwrap(s.team.roster.first?.members.first?.id)
    await s.team.load(key)
    XCTAssertNotNil(s.team.details[key])
    XCTAssertNil(s.team.work[key])
    XCTAssertNil(s.team.personas[key])
    XCTAssertNil(s.team.rows[key]?.avatarSeed)
    XCTAssertFalse(s.team.canStart(key), "signal plans, and this daemon takes no planner")
    do { _ = try await info.profileWork("signal", repo: nil, limit: 5); XCTFail() } catch DetailUnavailable.unsupported {}
  }
}
