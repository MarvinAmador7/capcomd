import XCTest
import Foundation
@testable import CapcomdStore

/// A daemon that sets projects up (capability `projects.setup`), scripted per test.
final class FakeProjectDaemon: DaemonInfoFetching, ProjectSettingUp, @unchecked Sendable {
  var caps: Set<String> = [Capability.runsOptions, Capability.runsOptionsRepo, Capability.projectsSetup, Capability.projectsGit]
  var inspections: [String: ProjectInspection] = [:]
  /// Answers for the next inspects, in order (an error to throw, or nil to answer); none left: answer.
  var inspectAnswers: [Error?] = []
  /// Inspects wait this long before answering (to race two of them).
  var inspectDelay: [String: Duration] = [:]
  var inspected: [String] = []
  var setups: [(request: ProjectSetupRequest, key: String)] = []
  /// Answers for the next setups, in order (an error to throw, or nil to set it up); none left: set it up.
  var setupAnswers: [Error?] = []
  var runOptionsAsked: [String?] = []
  // projects.git
  var gitInits: [String] = []
  var initAnswers: [Error?] = []
  var options = ProjectPublishOptions(ghReady: true, accounts: [ProjectPublishAccount(login: "marvin"), ProjectPublishAccount(login: "acme", kind: "org")], suggestedName: "my-app", files: 24)
  var optionsAnswers: [Error?] = []
  var publishes: [[String]] = []
  var publishAnswers: [Error?] = []
  func capabilities() async throws -> Set<String> { caps }
  func health() async throws -> DaemonHealth { DaemonHealth(version: "0.7.0", capabilities: caps) }
  func skills() async throws -> [SkillInfo] { [] }
  func runOptions(repo: String?) async throws -> RunOptions {
    runOptionsAsked.append(repo)
    return RunOptions(drivers: [DriverInfo(provider: "claude", label: "Claude Code", available: true, isDefault: true)], sandboxes: [SandboxInfo(name: "boxd", label: "Cloud")])
  }
  func inspectProject(path: String) async throws -> ProjectInspection {
    inspected.append(path)
    if let d = inspectDelay[path] { try? await Task.sleep(for: d) }
    if !inspectAnswers.isEmpty, let e = inspectAnswers.removeFirst() { throw e }
    return inspections[path] ?? ProjectInspection(path: path, problems: [ProjectProblem(code: "not_git", message: "\(path) isn't a git checkout. Choose your repository's folder, or clone it first.")])
  }
  func setUpProject(_ request: ProjectSetupRequest, idempotencyKey: String) async throws -> ProjectSetupResult {
    setups.append((request, idempotencyKey))
    if !setupAnswers.isEmpty, let e = setupAnswers.removeFirst() { throw e }
    let root = inspections[request.path]?.root ?? request.path
    return ProjectSetupResult(project: .init(path: request.path, root: root, name: "app",
                                             values: ProjectSettings(repo: "https://github.com/acme/app.git", mode: request.mode, target: request.target, check: request.check ?? "", agents: request.agents, budgetUsd: request.budgetUsd)),
                              changed: true)
  }
  func initGit(path: String) async throws -> ProjectInspection {
    gitInits.append(path)
    if !initAnswers.isEmpty, let e = initAnswers.removeFirst() { throw e }
    let i = ProjectInspection(path: path, root: path, name: "my-app", problems: [ProjectProblem(code: "no_origin", message: "\(path) has no origin remote.")])
    inspections[path] = i
    return i
  }
  func publishOptions(path: String) async throws -> ProjectPublishOptions {
    if !optionsAnswers.isEmpty, let e = optionsAnswers.removeFirst() { throw e }
    return options
  }
  func publishProject(path: String, owner: String, name: String, visibility: String) async throws -> ProjectInspection {
    publishes.append([path, owner, name, visibility])
    if !publishAnswers.isEmpty, let e = publishAnswers.removeFirst() { throw e }
    let i = ProjectInspection(path: path, root: path, name: "my-app", repo: "https://github.com/\(owner)/\(name).git", github: "\(owner)/\(name)", ghReady: true, branches: ["main"], suggestedMode: "pr")
    inspections[path] = i
    return i
  }
}

/// Setting a folder up as a project from the app (capability `projects.setup`): inspect states, the setup's states, the
/// refusals as the daemon words them, and what changes for new runs afterwards.
@MainActor
final class ProjectSetupTests: XCTestCase {
  let ready = ProjectInspection(path: "/Users/me/src/app/src", root: "/Users/me/src/app", name: "app", repo: "https://github.com/acme/app.git", github: "acme/app",
                                ghReady: true, branches: ["capcomd/staging", "main"], suggestedCheck: "bun run test", suggestedMode: "pr",
                                agents: [ProjectAgent(provider: "claude", label: "Claude Code", loggedIn: true), ProjectAgent(provider: "codex", label: "Codex", auth: "apikey")])

  func daemon() -> FakeProjectDaemon { let d = FakeProjectDaemon(); d.inspections[ready.path] = ready; return d }
  func store(_ d: FakeProjectDaemon, prefs: InMemoryPreferences = InMemoryPreferences(), keys: [String] = []) -> CapcomdStore {
    var k = keys
    return CapcomdStore(daemonInfo: d, prefs: prefs, makeKey: { k.isEmpty ? UUID().uuidString : k.removeFirst() })
  }

  func testDecodesTheDaemonsInspectAndTheResult() throws {
    let i = try ProjectWire.inspection(Data(#"""
      {"path":"/Users/me/src/app/src","root":"/Users/me/src/app","name":"app","configured":true,
       "values":{"repo":"https://github.com/acme/app.git","mode":"direct","target":"capcomd/staging","check":"bun run test","agents":["claude","codex"],"budgetUsd":15},
       "repo":"https://github.com/acme/app.git","github":"acme/app","ghReady":false,"defaultBranch":"main","branches":["capcomd/staging","main"],
       "suggestedCheck":"bun run test","suggestedMode":"direct","suggestedAgents":["claude"],
       "agents":[{"provider":"claude","label":"Claude Code","loggedIn":true,"auth":"apikey","places":[{"sandbox":"docker","loggedIn":true,"how":"api_key"},{"sandbox":"boxd","loggedIn":false,"how":null}]},
                 {"provider":"codex","label":"Codex","loggedIn":false,"auth":"subscription","places":[]}, {"provider":42}],
       "budgetAsked":true,"problems":[],"later":"ignored"}
      """#.utf8))
    XCTAssertEqual(i.root, "/Users/me/src/app")
    XCTAssertEqual(i.values, ProjectSettings(repo: "https://github.com/acme/app.git", mode: "direct", target: "capcomd/staging", check: "bun run test", agents: ["claude", "codex"], budgetUsd: 15))
    XCTAssertEqual(i.agents.map(\.provider), ["claude", "codex"])   // an element that doesn't decode is dropped
    XCTAssertEqual(i.agents[0].places, [.init(sandbox: "docker", loggedIn: true, how: "api_key"), .init(sandbox: "boxd", loggedIn: false)])
    XCTAssertTrue(i.canSetUp)
    XCTAssertFalse(i.pullRequestsAvailable)
    XCTAssertTrue(i.budgetAsked(for: ["claude"]))
    XCTAssertFalse(i.budgetAsked(for: ["codex"]))
    let blocked = try ProjectWire.inspection(Data(#"{"path":"/tmp/notes","root":null,"problems":[{"code":"not_git","message":"/tmp/notes isn't a git checkout."},{"code":"later"}]}"#.utf8))
    XCTAssertFalse(blocked.canSetUp)
    XCTAssertEqual(blocked.problems, [ProjectProblem(code: ProjectProblem.notGit, message: "/tmp/notes isn't a git checkout.")])
    let r = try ProjectWire.result(Data(#"{"project":{"path":"/a/src","root":"/a","name":"a","configured":true,"values":{"repo":"https://github.com/acme/a.git","mode":"pr","target":"main","check":"","agents":["claude"],"budgetUsd":null}},"changed":false}"#.utf8))
    XCTAssertEqual(r.project.root, "/a"); XCTAssertFalse(r.changed); XCTAssertEqual(r.project.values.check, "")
  }

  func testTheRequestCarriesTheInspectedOriginNeverARepoURL() throws {
    let body = try JSONSerialization.jsonObject(with: ProjectWire.body(ProjectSetupRequest(path: "/a", mode: "pr", target: "main", check: "", agents: ["claude"], expectRepo: "https://github.com/acme/a.git"))) as! [String: Any]
    XCTAssertEqual(Set(body.keys), ["path", "mode", "target", "check", "agents", "expect"])
    XCTAssertEqual(body["expect"] as? [String: String], ["repo": "https://github.com/acme/a.git"])
    let capped = try JSONSerialization.jsonObject(with: ProjectWire.body(ProjectSetupRequest(path: "/a", mode: "direct", target: "main", check: "x", agents: ["codex"], budgetUsd: 20))) as! [String: Any]
    XCTAssertEqual(capped["budgetUsd"] as? Double, 20)
    XCTAssertNil(capped["expect"])   // nothing inspected: nothing to compare
  }

  func testInspectLoadsAndSaysWhatBlocksAFolder() async {
    let d = daemon()
    let s = store(d)
    await s.refreshDaemonInfo()
    var seen: [ProjectInspectState] = []
    s.onChange = { seen.append(s.projectInspect) }
    await s.inspectProject(path: ready.path)
    XCTAssertEqual(seen.first, .loading(path: ready.path))
    XCTAssertEqual(s.projectInspect, .loaded(ready))
    await s.inspectProject(path: "/tmp/notes")
    guard case .loaded(let i) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(i.problems.map(\.code), ["not_git"])
    XCTAssertFalse(i.canSetUp)
  }

  func testAnAnswerForAFolderNoLongerAskedAboutIsDropped() async {
    let d = daemon()
    d.inspectDelay["/slow"] = .milliseconds(200)
    let s = store(d)
    await s.refreshDaemonInfo()
    async let first: Void = s.inspectProject(path: "/slow")
    try? await Task.sleep(for: .milliseconds(20))
    await s.inspectProject(path: ready.path)
    await first
    XCTAssertEqual(s.projectInspect, .loaded(ready))
  }

  func testAnOlderCapcomdSaysToUpdate() async {
    let d = daemon(); d.caps.remove(Capability.projectsSetup)
    let s = store(d)
    await s.inspectProject(path: ready.path)   // capabilities read on the way
    XCTAssertEqual(s.projectInspect, .failed("Update capcomd to set up projects here."))
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Update capcomd to set up projects here.", field: nil))
    XCTAssertTrue(d.inspected.isEmpty && d.setups.isEmpty)
    // A daemon that advertises it but answers 404 (an odd build): the same sentence.
    let e = daemon(); e.inspectAnswers = [DetailUnavailable.unsupported]
    let s2 = store(e)
    await s2.inspectProject(path: ready.path)
    XCTAssertEqual(s2.projectInspect, .failed("Update capcomd to set up projects here."))
  }

  func testDoneNewRunsGoToTheProjectAndItsRunOptionsAreRead() async {
    let d = daemon()
    let prefs = InMemoryPreferences()
    let s = store(d, prefs: prefs)
    await s.refreshDaemonInfo()
    await s.inspectProject(path: ready.path)
    var states: [ProjectSetupState] = []
    s.onChange = { states.append(s.projectSetup) }
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "bun run test", agents: ["claude"])
    XCTAssertEqual(states.first, .saving)
    guard case .done(let r) = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
    XCTAssertEqual(r.project.root, "/Users/me/src/app")
    XCTAssertEqual(d.setups.first?.request, ProjectSetupRequest(path: ready.path, mode: "pr", target: "main", check: "bun run test", agents: ["claude"], expectRepo: "https://github.com/acme/app.git"))
    XCTAssertEqual(s.prefs.startRepo, "/Users/me/src/app")
    XCTAssertEqual(d.runOptionsAsked.last, "/Users/me/src/app")
    XCTAssertEqual(s.runOptions.drivers.first?.available, true)
  }

  func testTheDaemonsRefusalWithItsField() async {
    let d = daemon()
    d.setupAnswers = [ProjectSetupRefused.invalid("Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first.", field: "mode")]
    let s = store(d)
    await s.refreshDaemonInfo(); await s.inspectProject(path: ready.path)
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Pull requests need the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), so choose direct merges or log in first.", field: "mode"))
    XCTAssertNil(s.prefs.startRepo)
    // Fixed and sent again: a new request, a new key.
    await s.setUpProject(path: ready.path, mode: "direct", target: "main", check: "", agents: ["claude"])
    guard case .done = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
    XCTAssertNotEqual(d.setups[0].key, d.setups[1].key)
  }

  func testATokenWithoutConfigureSaysToResetIt() async {
    let d = daemon(); d.setupAnswers = [ProjectSetupRefused.forbidden]
    let s = store(d)
    await s.refreshDaemonInfo(); await s.inspectProject(path: ready.path)
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Reset your token in Settings to set up projects.", field: nil))
    XCTAssertTrue(s.configureDenied)
    // The same token can't: it isn't asked again.
    await s.setUpProject(path: ready.path, mode: "direct", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(d.setups.count, 1)
    XCTAssertEqual(s.projectSetup, .refused(message: "Reset your token in Settings to set up projects.", field: nil))
  }

  func testTheFolderChangedSinceItWasInspected() async {
    let d = daemon()
    d.setupAnswers = [ProjectSetupRefused.conflict("~/src/app's origin changed since you looked: it's https://github.com/someone/app.git now. Look at the folder again before setting it up.", repo: "https://github.com/someone/app.git")]
    let s = store(d)
    await s.refreshDaemonInfo(); await s.inspectProject(path: ready.path)
    var moved = ready; moved.repo = "https://github.com/someone/app.git"; moved.github = "someone/app"
    d.inspections[ready.path] = moved
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "~/src/app's origin changed since you looked: it's https://github.com/someone/app.git now. Look at the folder again before setting it up.", field: "path"))
    XCTAssertEqual(s.projectInspect, .loaded(moved))   // inspected again: the form shows the origin as it is now
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(d.setups.last?.request.expectRepo, "https://github.com/someone/app.git")
  }

  func testALostAnswerRetriesWithTheSameKey() async {
    let d = daemon(); d.setupAnswers = [URLError(.networkConnectionLost)]
    let s = store(d, keys: ["key-0000001", "key-0000002"])
    await s.refreshDaemonInfo(); await s.inspectProject(path: ready.path)
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(s.projectSetup, .refused(message: "Couldn't reach capcomd. Try again.", field: nil))
    await s.setUpProject(path: ready.path, mode: "pr", target: "main", check: "", agents: ["claude"])
    XCTAssertEqual(d.setups.map(\.key), ["key-0000001", "key-0000001"])
    guard case .done = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
  }

  func testARejectedTokenReopensThePrompt() async {
    let d = daemon(); d.inspectAnswers = [Unauthorized()]
    let s = store(d)
    await s.refreshDaemonInfo()
    await s.inspectProject(path: ready.path)
    XCTAssertTrue(s.unauthorized)
    XCTAssertEqual(s.projectInspect, .failed("capcomd rejected this app's token."))
  }
}
