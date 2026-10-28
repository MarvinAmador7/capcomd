import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive

/// Setting a folder up as a project through the live adapter against the Bun mock's PROJECTS scenes
/// (client/mock/projects.ts): the routes decode, each scene's folder reads as the daemon would say it, and the refusals
/// arrive as the daemon words them.
extension SettingsLiveMockTests {
  func projects(_ scene: String, env: [String: String] = [:]) async throws -> (CapcomdStore, LiveDaemonInfo) {
    let info = LiveDaemonInfo(transport: try await start("mixed", env: ["PROJECTS": scene].merging(env) { $1 }))
    let s = CapcomdStore(daemonInfo: info)
    await s.refreshDaemonInfo()
    return (s, info)
  }

  func testSettingUpAReadyGitHubCheckoutThroughTheMock() async throws {
    let (s, info) = try await projects("ready")
    XCTAssertTrue(s.projectSetupSupported)
    // Before: the folder isn't a project, so no driver can start a run there.
    s.prefs.startRepo = "/Users/me/src/app"
    await s.refreshRunOptions()
    XCTAssertEqual(s.runOptions.drivers.map(\.available), [false, false])
    XCTAssertEqual(s.runOptions.drivers.first?.reason, "/Users/me/src/app is not a capcomd project (no .capcomd/config.json in it or above it). Run `capcomd setup project` in it first.")
    await s.inspectProject(path: "/Users/me/src/app/src")
    guard case .loaded(let i) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(i.root, "/Users/me/src/app")
    XCTAssertEqual(i.repo, "https://github.com/acme/app.git")
    XCTAssertTrue(i.canSetUp && i.pullRequestsAvailable && !i.configured && !i.budgetAsked)
    XCTAssertEqual(i.branches, ["capcomd/staging", "main"])
    XCTAssertEqual(i.agents.map(\.auth), ["subscription", "subscription"])
    await s.setUpProject(path: i.path, mode: i.suggestedMode, target: i.defaultBranch, check: i.suggestedCheck, agents: i.suggestedAgents)
    guard case .done(let r) = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
    XCTAssertEqual(r.project.values, ProjectSettings(repo: "https://github.com/acme/app.git", mode: "pr", target: "main", check: "bun run test", agents: ["claude"]))
    XCTAssertTrue(r.changed)
    XCTAssertEqual(s.prefs.startRepo, "/Users/me/src/app")
    XCTAssertEqual(s.runOptions.drivers.first?.available, true)   // Claude Code is logged in on Cloud
    // Inspected again: configured, with what was written.
    await s.inspectProject(path: "/Users/me/src/app")
    guard case .loaded(let after) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertTrue(after.configured)
    XCTAssertEqual(after.values?.mode, "pr")
    // The same key and answers replay the first answer.
    let req = ProjectSetupRequest(path: "/Users/me/src/other", mode: "direct", target: "main", check: "", agents: ["claude"], expectRepo: "https://github.com/acme/app.git")
    let one = try await info.setUpProject(req, idempotencyKey: "setup-same-1")
    let two = try await info.setUpProject(req, idempotencyKey: "setup-same-1")
    XCTAssertEqual(one, two)
  }

  func testEachMockSceneReadsAsTheDaemonSaysIt() async throws {
    let (s, _) = try await projects("ready")
    func inspected(_ path: String) async -> ProjectInspection? { await s.inspectProject(path: path); if case .loaded(let i) = s.projectInspect { return i }; return nil }
    let configured = await inspected("/tmp/w/configured")
    XCTAssertEqual(configured?.values, ProjectSettings(repo: "https://github.com/acme/app.git", mode: "direct", target: "capcomd/staging", check: "bun run test", agents: ["claude", "codex"]))
    let notgit = await inspected("/tmp/w/notgit")
    XCTAssertEqual(notgit?.problems, [ProjectProblem(code: "not_git", message: "/tmp/w/notgit isn't a git checkout. Choose your repository's folder, or clone it first.")])
    let lab = await inspected("/tmp/w/notgithub")
    XCTAssertEqual(lab?.problems.map(\.code), ["not_github"])
    XCTAssertEqual(lab?.problems.first?.message, "/tmp/w/notgithub's origin (https://gitlab.com/acme/app.git) isn't on GitHub. The app sets up GitHub checkouts; set this one up with `capcomd setup project` in Terminal.")
    let nogh = await inspected("/tmp/w/nogh")
    XCTAssertEqual(nogh?.pullRequestsAvailable, false)
    XCTAssertEqual(nogh?.suggestedMode, "direct")
    await s.setUpProject(path: "/tmp/w/nogh", mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first.", field: "mode"))
    let key = await inspected("/tmp/w/apikey")
    XCTAssertEqual(key?.budgetAsked, true)
    XCTAssertEqual(key?.budgetAsked(for: ["codex"]), false)
    await s.setUpProject(path: "/tmp/w/apikey", mode: "pr", target: "main", check: "", agents: ["claude"], budgetUsd: 20)
    guard case .done(let r) = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
    XCTAssertEqual(r.project.values.budgetUsd, 20)
    _ = await inspected("/tmp/w/refuse")
    await s.setUpProject(path: "/tmp/w/refuse", mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "/tmp/w/refuse/.capcomd leads outside the checkout (a symlink), so capcomd won't write there. Remove the link, or set the project up with `capcomd setup project` in Terminal.", field: "path"))
  }

  func testAnOlderDaemonAndATokenWithoutConfigure() async throws {
    let (old, _) = try await projects("old")
    XCTAssertFalse(old.projectSetupSupported)
    await old.inspectProject(path: "/tmp/w/app")
    XCTAssertEqual(old.projectInspect, .failed("Update capcomd to set up projects here."))
    try? await transport?.shutdown(); server?.terminate(); server?.waitUntilExit()

    let (s, _) = try await projects("ready", env: ["SCOPES": "read,steer,approve"])
    await s.inspectProject(path: "/tmp/w/app")
    guard case .loaded = s.projectInspect else { return XCTFail("inspect needs only read: \(s.projectInspect)") }
    await s.setUpProject(path: "/tmp/w/app", mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Reset your token in Settings to set up projects.", field: nil))
  }
}
