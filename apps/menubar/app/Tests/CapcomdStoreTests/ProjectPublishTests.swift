import XCTest
import Foundation
@testable import CapcomdStore

/// Taking a plain folder to a GitHub checkout from the app (capability `projects.git`): starting its repository, the
/// publish options, publishing and its refusals as the daemon words them; and `POST /v1/projects` without a check and
/// with `gitignore`.
@MainActor
final class ProjectPublishTests: XCTestCase {
  let path = "/Users/me/Downloads/my-app"

  func store(_ d: FakeProjectDaemon) -> CapcomdStore { CapcomdStore(daemonInfo: d, prefs: InMemoryPreferences()) }

  func testDecodesThePublishOptions() throws {
    let o = try ProjectWire.publishOptions(Data(#"""
      {"path":"/a","root":"/a","ghReady":true,"accounts":[{"login":"marvin","kind":"user"},{"login":"acme","kind":"org"},{"kind":"org"}],
       "suggestedName":"my-app","hasCommits":false,"branch":"main","files":24,"blocked":[{"path":".env","reason":"an environment file, which usually holds secrets"}],"later":1}
      """#.utf8))
    XCTAssertEqual(o.accounts, [ProjectPublishAccount(login: "marvin", kind: "user"), ProjectPublishAccount(login: "acme", kind: "org")])   // one that doesn't decode is dropped
    XCTAssertTrue(o.accounts[1].isOrganization)
    XCTAssertEqual(o.blocked, [ProjectBlockedFile(path: ".env", reason: "an environment file, which usually holds secrets")])
    XCTAssertEqual(o.files, 24); XCTAssertEqual(o.branch, "main"); XCTAssertEqual(o.root, "/a")
    XCTAssertFalse(o.canPublish)   // a likely secret in the first commit
    XCTAssertTrue(ProjectPublishOptions(ghReady: true, accounts: [ProjectPublishAccount(login: "m")], suggestedName: "x", files: 3).canPublish)
    XCTAssertFalse(ProjectPublishOptions(ghReady: true, accounts: [ProjectPublishAccount(login: "m")], suggestedName: "x", files: 2001).canPublish)
    XCTAssertTrue(ProjectPublishOptions(ghReady: true, accounts: [ProjectPublishAccount(login: "m")], suggestedName: "x", hasCommits: true, files: 5000).canPublish)
    XCTAssertFalse(ProjectPublishOptions(ghReady: false, suggestedName: "x", files: 3).canPublish)
    let body = try JSONSerialization.jsonObject(with: ProjectWire.publishBody(path: "/a", owner: "acme", name: "x", visibility: "public")) as! [String: String]
    XCTAssertEqual(body, ["path": "/a", "owner": "acme", "name": "x", "visibility": "public"])
  }

  func testInitGitThenPublishThenTheFolderIsACheckoutOnGitHub() async {
    let d = FakeProjectDaemon()
    let s = store(d)
    await s.refreshDaemonInfo()
    XCTAssertTrue(s.projectGitSupported)
    await s.inspectProject(path: path)
    guard case .loaded(let before) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(before.problems.map(\.code), ["not_git"])
    var busy: [Bool] = []
    s.onChange = { busy.append(s.initializingGit) }
    await s.initGit(path: path)
    XCTAssertEqual(busy.first, true); XCTAssertFalse(s.initializingGit)
    guard case .loaded(let started) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(started.root, path); XCTAssertEqual(started.problems.map(\.code), ["no_origin"])
    XCTAssertEqual(d.gitInits, [path])
    var states: [ProjectPublishState] = []
    s.onChange = { states.append(s.projectPublish) }
    await s.loadPublishOptions(path: path)
    XCTAssertEqual(states, [.loadingOptions, .ready(d.options)])
    XCTAssertEqual(s.projectPublishOptions, d.options)
    states = []
    await s.publishProject(path: path, owner: "acme", name: "my-app", visibility: "private")
    XCTAssertEqual(states.first, .publishing)
    XCTAssertEqual(s.projectPublish, .idle)
    XCTAssertNil(s.projectPublishOptions)
    XCTAssertEqual(d.publishes, [[path, "acme", "my-app", "private"]])
    guard case .loaded(let after) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(after.github, "acme/my-app"); XCTAssertTrue(after.canSetUp)
    // Then the usual setup, without a check (the daemon's suggestion) and with .capcomd/ ignored.
    await s.setUpProject(path: path, mode: "pr", target: "main", agents: ["claude"], gitignore: true)
    XCTAssertEqual(d.setups.last?.request, ProjectSetupRequest(path: path, mode: "pr", target: "main", check: nil, agents: ["claude"], expectRepo: "https://github.com/acme/my-app.git", gitignore: true))
    guard case .done = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
  }

  func testPublishRefusalsAsTheDaemonWordsThem() async {
    let d = FakeProjectDaemon()
    d.inspections[path] = ProjectInspection(path: path, root: path, problems: [ProjectProblem(code: "no_origin", message: "no origin")])
    let s = store(d)
    await s.refreshDaemonInfo(); await s.inspectProject(path: path); await s.loadPublishOptions(path: path)
    d.publishAnswers = [ProjectSetupRefused.invalid("acme/my-app already exists on GitHub. Choose another name.", field: "name")]
    await s.publishProject(path: path, owner: "acme", name: "my-app", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: "acme/my-app already exists on GitHub. Choose another name.", field: "name"))
    XCTAssertEqual(s.projectPublishOptions, d.options)   // the form keeps its values
    d.publishAnswers = [ProjectSetupRefused.invalid(".env looks like it holds secrets, and the first commit would publish it. Add it to .gitignore, then publish again.", field: "files")]
    await s.publishProject(path: path, owner: "acme", name: "other", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: ".env looks like it holds secrets, and the first commit would publish it. Add it to .gitignore, then publish again.", field: "files"))
    d.publishAnswers = [MessageRefused("The GitHub CLI couldn't publish acme/other: HTTP 502.")]
    await s.publishProject(path: path, owner: "acme", name: "other", visibility: "private")
    XCTAssertEqual(s.projectPublish, .failed("The GitHub CLI couldn't publish acme/other: HTTP 502."))
    d.publishAnswers = [URLError(.networkConnectionLost)]
    await s.publishProject(path: path, owner: "acme", name: "other", visibility: "private")
    XCTAssertEqual(s.projectPublish, .failed("Couldn't reach capcomd. Try again."))
    // It has an origin now (published by the lost request): the folder is inspected again.
    var moved = d.inspections[path]!; moved.problems = []; moved.github = "acme/other"; moved.repo = "https://github.com/acme/other.git"
    d.inspections[path] = moved
    d.publishAnswers = [ProjectSetupRefused.conflict("~/Downloads/my-app is already on GitHub (acme/other), so there's nothing to publish.", repo: nil)]
    await s.publishProject(path: path, owner: "acme", name: "other", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: "~/Downloads/my-app is already on GitHub (acme/other), so there's nothing to publish.", field: "path"))
    XCTAssertEqual(s.projectInspect, .loaded(moved))
  }

  func testOptionsAndInitRefusalsAndATokenWithoutConfigure() async {
    let d = FakeProjectDaemon()
    let s = store(d)
    await s.refreshDaemonInfo()
    d.optionsAnswers = [ProjectSetupRefused.invalid("/tmp/x isn't a git checkout.", field: "path")]
    await s.loadPublishOptions(path: "/tmp/x")
    XCTAssertEqual(s.projectPublish, .refused(message: "/tmp/x isn't a git checkout.", field: "path"))
    d.initAnswers = [ProjectSetupRefused.invalid("/Users holds your home folder, so capcomd won't start a repository there. Choose your project's own folder.", field: "path")]
    await s.initGit(path: "/Users")
    XCTAssertEqual(s.projectPublish, .refused(message: "/Users holds your home folder, so capcomd won't start a repository there. Choose your project's own folder.", field: "path"))
    XCTAssertFalse(s.initializingGit)
    d.initAnswers = [ProjectSetupRefused.forbidden]
    await s.initGit(path: path)
    XCTAssertEqual(s.projectPublish, .refused(message: "Reset your token in Settings to set up projects.", field: nil))
    XCTAssertTrue(s.configureDenied)
    await s.publishProject(path: path, owner: "acme", name: "x", visibility: "private")
    XCTAssertTrue(d.publishes.isEmpty)   // not asked again with the same token
  }

  func testAnOlderCapcomdSaysToUpdateAndGetsACheck() async throws {
    let d = FakeProjectDaemon(); d.caps.remove(Capability.projectsGit)
    let ready = ProjectInspection(path: path, root: path, repo: "https://github.com/acme/app.git", github: "acme/app", suggestedCheck: "npm test")
    d.inspections[path] = ready
    let s = store(d)
    await s.refreshDaemonInfo()
    XCTAssertFalse(s.projectGitSupported)
    await s.initGit(path: path)
    XCTAssertEqual(s.projectPublish, .failed("Update capcomd to publish projects from here."))
    await s.loadPublishOptions(path: path)
    XCTAssertEqual(s.projectPublish, .failed("Update capcomd to publish projects from here."))
    await s.publishProject(path: path, owner: "acme", name: "x", visibility: "private")
    XCTAssertTrue(d.gitInits.isEmpty && d.publishes.isEmpty)
    // No check given: a daemon from before projects.git needs one, so the suggested check is sent.
    await s.inspectProject(path: path)
    await s.setUpProject(path: path, mode: "direct", target: "main", agents: ["claude"])
    XCTAssertEqual(d.setups.last?.request.check, "npm test")
    let body = try JSONSerialization.jsonObject(with: ProjectWire.body(ProjectSetupRequest(path: "/a", mode: "direct", target: "main", agents: ["claude"]))) as! [String: Any]
    XCTAssertEqual(Set(body.keys), ["path", "mode", "target", "agents"])   // no check, no gitignore
    let ignored = try JSONSerialization.jsonObject(with: ProjectWire.body(ProjectSetupRequest(path: "/a", mode: "direct", target: "main", agents: ["claude"], gitignore: true))) as! [String: Any]
    XCTAssertEqual(ignored["gitignore"] as? Bool, true)
  }
}
