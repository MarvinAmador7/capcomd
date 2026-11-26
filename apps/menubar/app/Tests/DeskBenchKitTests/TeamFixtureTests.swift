import XCTest
import CapcomdStore
@testable import DeskBenchKit

/// The Team fixture answers as the daemon's profile routes do, so the bench's Team scenarios see the board's roster.
@MainActor
final class TeamFixtureTests: XCTestCase {
  func testTheFixtureIsTheBoardsRoster() async throws {
    let f = TeamFixtureDaemon()
    let s = CapcomdStore(daemonInfo: f)
    await s.refreshDaemonInfo()
    await s.team.refresh()
    XCTAssertEqual(s.team.roster.map(\.title), ["capcomd", "capcomd-site", "All projects"])
    XCTAssertEqual(s.team.roster.map { $0.members.map(\.role.rawValue) }, [["plans", "leads", "builds", "reviews"], ["plans", "builds", "builds"], ["reviews", "builds"]])
    let key = try XCTUnwrap(s.team.roster[2].members.first?.id)
    await s.team.load(key)
    let d = try XCTUnwrap(s.team.details[key])
    let names = Dictionary(s.runOptions.drivers.flatMap { $0.models ?? [] }.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    XCTAssertEqual(TeamSummary.line(d.profile, detail: d, models: names), "Opus 5.5 · high · Cloud · read-only · alone · 40 turns · 30 min · 2 skills")
    XCTAssertEqual(TeamFields.rows(d).count, 13)
    await s.team.set(key, ["limits.maxTurns": "45"])
    XCTAssertEqual(s.team.details[key]?.field("limits.maxTurns")?.display, "45 turns")
    XCTAssertEqual(f.puts.last?.rev, d.rev)
    XCTAssertEqual(Fixtures.make("team")?.spec.team, true)
  }

  func testADaemonWithoutTheNewerRoutes() async throws {
    let f = TeamFixtureDaemon(capabilities: [Capability.profiles, Capability.profilesEdit, Capability.projectsKnown])
    let s = CapcomdStore(daemonInfo: f)
    await s.refreshDaemonInfo()
    await s.team.refresh()
    let key = try XCTUnwrap(s.team.roster.first?.members.first?.id)
    await s.team.load(key)
    XCTAssertNotNil(s.team.details[key])
    XCTAssertNil(s.team.work[key])
    XCTAssertNil(s.team.personas[key])
    XCTAssertNil(s.team.rows[key]?.avatarSeed)
  }
}
