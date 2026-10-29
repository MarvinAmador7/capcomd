import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive

/// Starting a folder's repository and publishing it (capability `projects.git`) through the live adapter against the Bun
/// mock's PROJECTS scenes (client/mock/projects.ts): notgit, noorigin, nogh-publish, secrets, taken.
extension SettingsLiveMockTests {
  func testAPlainFolderAllTheWayToASetUpProjectThroughTheMock() async throws {
    let (s, _) = try await projects("notgit")
    XCTAssertTrue(s.projectGitSupported)
    let folder = "/Users/me/Downloads/my-app"
    await s.inspectProject(path: folder)
    guard case .loaded(let plain) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(plain.problems.map(\.code), ["not_git"])
    await s.initGit(path: folder)
    guard case .loaded(let started) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(started.root, folder)
    XCTAssertEqual(started.problems, [ProjectProblem(code: "no_origin", message: "\(folder) has no origin remote, so agents have no repository to push to. Add one (`git remote add origin <url>`), or choose another checkout.")])
    await s.loadPublishOptions(path: folder)
    guard case .ready(let o) = s.projectPublish else { return XCTFail("\(s.projectPublish)") }
    XCTAssertEqual(o.accounts, [ProjectPublishAccount(login: "marvin", kind: "user"), ProjectPublishAccount(login: "acme", kind: "org")])
    XCTAssertEqual(o.suggestedName, "my-app"); XCTAssertEqual(o.files, 24); XCTAssertTrue(o.canPublish)
    await s.publishProject(path: folder, owner: "marvin", name: o.suggestedName, visibility: "private")
    XCTAssertEqual(s.projectPublish, .idle)
    guard case .loaded(let published) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(published.github, "marvin/my-app")
    XCTAssertEqual(published.repo, "https://github.com/marvin/my-app.git")
    XCTAssertTrue(published.canSetUp && published.pullRequestsAvailable && !published.configured)
    // Starting it again: it's a checkout now.
    await s.initGit(path: folder)
    XCTAssertEqual(s.projectPublish, .refused(message: "\(folder) is already in a git checkout (\(folder)). Look at the folder again.", field: "path"))
    // Set up with the suggested check and .capcomd/ ignored.
    await s.setUpProject(path: folder, mode: "pr", target: published.defaultBranch, agents: ["claude"], gitignore: true)
    guard case .done(let r) = s.projectSetup else { return XCTFail("\(s.projectSetup)") }
    XCTAssertEqual(r.project.values, ProjectSettings(repo: "https://github.com/marvin/my-app.git", mode: "pr", target: "main", check: "bun run test", agents: ["claude"]))
  }

  func testEachPublishSceneReadsAsTheDaemonSaysIt() async throws {
    let (s, info) = try await projects("ready")
    func options(_ path: String) async -> ProjectPublishOptions? { await s.loadPublishOptions(path: path); if case .ready(let o) = s.projectPublish { return o }; return nil }
    // No GitHub CLI login: no accounts; publishing says to log in.
    let nogh = await options("/tmp/w/nogh-publish")
    XCTAssertEqual(nogh?.ghReady, false); XCTAssertEqual(nogh?.accounts, [])
    await s.publishProject(path: "/tmp/w/nogh-publish", owner: "marvin", name: "x", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: "Publishing needs the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), then publish again.", field: "gh"))
    // A .env in the first commit.
    let secrets = await options("/tmp/w/secrets")
    XCTAssertEqual(secrets?.blocked, [ProjectBlockedFile(path: ".env", reason: "an environment file, which usually holds secrets")])
    XCTAssertEqual(secrets?.canPublish, false)
    await s.publishProject(path: "/tmp/w/secrets", owner: "marvin", name: "secrets", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: ".env looks like it holds secrets, and the first commit would publish it. Add it to .gitignore, then publish again.", field: "files"))
    // The name is taken; another one publishes.
    let taken = await options("/tmp/w/taken")
    await s.publishProject(path: "/tmp/w/taken", owner: "acme", name: taken?.suggestedName ?? "", visibility: "public")
    XCTAssertEqual(s.projectPublish, .refused(message: "acme/taken already exists on GitHub. Choose another name. The first commit is made; publishing again pushes it.", field: "name"))
    await s.publishProject(path: "/tmp/w/taken", owner: "acme", name: "taken-2", visibility: "public")
    guard case .loaded(let i) = s.projectInspect else { return XCTFail("\(s.projectInspect)") }
    XCTAssertEqual(i.github, "acme/taken-2")
    // A GitHub checkout has nothing to publish; a folder that isn't a checkout can't be.
    await s.loadPublishOptions(path: "/tmp/w/app")
    XCTAssertEqual(s.projectPublish, .refused(message: "/tmp/w/app is already on GitHub (acme/app), so there's nothing to publish.", field: "path"))
    await s.loadPublishOptions(path: "/tmp/w/notgit")
    XCTAssertEqual(s.projectPublish, .refused(message: "/tmp/w/notgit isn't a git checkout. Choose your repository's folder, or clone it first.", field: "path"))
    // An owner the GitHub CLI isn't, straight through the port.
    do { _ = try await info.publishProject(path: "/tmp/w/noorigin", owner: "someone", name: "x", visibility: "private"); XCTFail("published") }
    catch ProjectSetupRefused.invalid(let m, let field) { XCTAssertEqual(field, "owner"); XCTAssertEqual(m, "The GitHub CLI isn't logged in as someone or a member of it: choose marvin, acme.") }
  }

  func testPublishingNeedsTheConfigureScopeAndANewerDaemon() async throws {
    let (old, _) = try await projects("old")
    XCTAssertFalse(old.projectGitSupported)
    await old.loadPublishOptions(path: "/tmp/w/noorigin")
    XCTAssertEqual(old.projectPublish, .failed("Update capcomd to publish projects from here."))
    try? await transport?.shutdown(); server?.terminate(); server?.waitUntilExit()

    let (s, _) = try await projects("noorigin", env: ["SCOPES": "read,steer,approve"])
    await s.loadPublishOptions(path: "/tmp/w/x")
    guard case .ready = s.projectPublish else { return XCTFail("publish-options needs only read: \(s.projectPublish)") }
    await s.publishProject(path: "/tmp/w/x", owner: "marvin", name: "x", visibility: "private")
    XCTAssertEqual(s.projectPublish, .refused(message: "Reset your token in Settings to set up projects.", field: nil))
  }
}
