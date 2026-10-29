import XCTest
import Foundation
@testable import CapcomdStore

/// The composer's inline project setup (design/setup): which section, rows and buttons each folder gets, what Set Up
/// and Set Up and Start do, and that Cancel leaves new runs where they were.
@MainActor
final class ProjectSetupFlowTests: XCTestCase {
  let claude = ProjectAgent(provider: "claude", label: "Claude Code", loggedIn: true, places: [.init(sandbox: "docker", loggedIn: false), .init(sandbox: "boxd", loggedIn: true, how: "plan")])
  let codex = ProjectAgent(provider: "codex", label: "Codex", places: [.init(sandbox: "docker", loggedIn: false), .init(sandbox: "boxd", loggedIn: false)])
  var ready: ProjectInspection {
    ProjectInspection(path: "/Users/me/src/my-app", root: "/Users/me/src/my-app", name: "my-app", repo: "https://github.com/acme/my-app.git", github: "acme/my-app",
                      ghReady: true, branches: ["develop", "main", "release/2.0"], suggestedCheck: "bun run test", suggestedMode: "pr", agents: [claude, codex])
  }

  struct Rig { let daemon: FakeProjectDaemon; let store: CapcomdStore; let flow: ProjectSetupFlow; let prefs: InMemoryPreferences }
  func rig(_ inspections: [ProjectInspection] = [], previous: String? = "/Users/me/src/old", caps: Set<String>? = nil) async -> Rig {
    let d = FakeProjectDaemon()
    if let caps { d.caps = caps }
    for i in [ready] + inspections { d.inspections[i.path] = i }
    let prefs = InMemoryPreferences()
    prefs.set(previous, forKey: "startRepo")
    let s = CapcomdStore(daemonInfo: d, prefs: prefs)
    await s.refreshDaemonInfo()
    return Rig(daemon: d, store: s, flow: ProjectSetupFlow(store: s), prefs: prefs)
  }

  // MARK: picking a folder

  func testASetUpProjectBecomesWhereRunsGoAtOnce() async {
    var configured = ready; configured.path = "/Users/me/src/app/src"; configured.root = "/Users/me/src/app"; configured.configured = true
    let r = await rig([configured])
    let used = await r.flow.pick(configured.path)
    XCTAssertTrue(used)
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertNil(r.flow.screen(goal: "", sandbox: nil))
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/app")   // its checkout, not the folder inside it
  }

  func testAnOlderCapcomdTakesTheFolderAsBefore() async {
    let r = await rig(caps: [Capability.runsOptions])
    let used = await r.flow.pick("/Users/me/src/my-app")
    XCTAssertTrue(used)
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/my-app")
  }

  func testAGitHubCheckoutShowsItsNextStepsFilledFromTheFolder() async {
    let r = await rig()
    let used = await r.flow.pick(ready.path)
    XCTAssertFalse(used)
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")   // new runs don't move until it's set up
    let s = r.flow.screen(goal: "", sandbox: "boxd")!
    XCTAssertEqual(s.phase, .form)
    XCTAssertEqual(s.name, "my-app")
    XCTAssertEqual(s.header, "my-app isn't set up for capcomd yet.")
    XCTAssertEqual(s.rows.map(\.id), ["repository", "target", "mode", "agents"])   // no Check row; no spend cap on a plan
    XCTAssertEqual(s.rows[0].row, .repository("acme/my-app"))
    XCTAssertEqual(s.rows[1].row, .target("main", choices: ["main", "develop", "release/2.0"]))
    XCTAssertEqual(s.rows[2].row, .mode("pr", target: "main", pullRequests: true))
    XCTAssertEqual(s.rows[3].row, .agents([SetupAgentChip(provider: "claude", label: "Claude Code", on: true, enabled: true),
                                           SetupAgentChip(provider: "codex", label: "Codex", on: false, enabled: false)]))
    XCTAssertTrue(s.rows.allSatisfy { $0.note == nil })
    XCTAssertNil(s.callout)
    XCTAssertTrue(s.cancel); XCTAssertFalse(s.chooseAnother)
    XCTAssertEqual(s.primary, SetupButton("Set Up", .setUp))
  }

  func testWhileLookingTheToolRowStays() async {
    let r = await rig()
    r.daemon.inspectDelay[ready.path] = .milliseconds(150)
    async let picked = r.flow.pick(ready.path)
    try? await Task.sleep(for: .milliseconds(30))
    XCTAssertTrue(r.flow.isOpen)
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)?.phase, .loading)
    _ = await picked
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)?.phase, .form)
  }

  func testValuesEditInPlace() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    r.flow.setTarget("develop"); r.flow.setMode("direct")
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.rows[1].row, .target("develop", choices: ["main", "develop", "release/2.0"]))
    XCTAssertEqual(s.rows[2].row, .mode("direct", target: "develop", pullRequests: true))   // "Pushes to develop"
    r.flow.toggleAgent("claude")
    XCTAssertFalse(r.flow.screen(goal: "", sandbox: nil)!.primary!.enabled)   // no agent chosen
  }

  // MARK: Set Up, Set Up and Start, Cancel

  func testAGoalMakesItSetUpAndStartWhichSetsUpThenStartsTheRun() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    XCTAssertEqual(r.flow.screen(goal: "Add a dark mode toggle to Settings", sandbox: nil)?.primary, SetupButton("Set Up and Start", .setUpAndStart))
    XCTAssertEqual(r.flow.screen(goal: "   ", sandbox: nil)?.primary?.title, "Set Up")
    var started: [(goal: String, repo: String?, setUps: Int)] = []
    let outcome = await r.flow.submit(goal: "Add a dark mode toggle to Settings") { g in
      started.append((g, r.store.prefs.startRepo, r.daemon.setups.count)); return true
    }
    XCTAssertEqual(outcome, .started)
    XCTAssertEqual(started.count, 1)
    XCTAssertEqual(started.first?.goal, "Add a dark mode toggle to Settings")
    XCTAssertEqual(started.first?.repo, "/Users/me/src/my-app")   // set up first: the run goes to the new project
    XCTAssertEqual(started.first?.setUps, 1)
    XCTAssertEqual(r.daemon.setups.first?.request, ProjectSetupRequest(path: ready.path, mode: "pr", target: "main", agents: ["claude"],
                                                                       expectRepo: "https://github.com/acme/my-app.git"))   // no check: the daemon's suggestion
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertEqual(r.store.projectSetup, .idle)
  }

  func testSetUpWithoutAGoalHandsTheToolRowBack() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    var starts = 0
    let outcome = await r.flow.submit(goal: "") { _ in starts += 1; return true }
    XCTAssertEqual(outcome, .setUp)
    XCTAssertEqual(starts, 0)
    XCTAssertNil(r.flow.screen(goal: "", sandbox: nil))
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/my-app")
  }

  func testARunThatDoesntStartAfterSetUpSaysSo() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    let outcome = await r.flow.submit(goal: "Ship it") { _ in false }
    XCTAssertEqual(outcome, .startFailed)
    XCTAssertFalse(r.flow.isOpen)   // set up all the same
  }

  func testCancelGoesBackToThePreviousProject() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    // Choose Another Folder… and then Cancel: still the project from before the first pick.
    await r.flow.pick("/Users/me/Downloads")
    r.flow.cancel()
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertNil(r.flow.screen(goal: "", sandbox: nil))
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")
    XCTAssertEqual(r.store.projectInspect, .idle)
    XCTAssertTrue(r.daemon.setups.isEmpty)
  }

  func testCancelledWhileSettingUpStillGoesBack() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    // Cancel while the setup is on its way to the daemon.
    r.store.onChange = { if case .saving = r.store.projectSetup { r.flow.cancel() } }
    var starts = 0
    let outcome = await r.flow.submit(goal: "Ship it") { _ in starts += 1; return true }
    XCTAssertEqual(outcome, .showing)
    XCTAssertEqual(starts, 0)
    XCTAssertEqual(r.daemon.setups.count, 1)   // it reached the daemon
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")
    XCTAssertFalse(r.flow.isOpen)
  }

  func testAPickAnsweredAfterCancelIsDropped() async {
    let r = await rig()
    r.daemon.inspectDelay[ready.path] = .milliseconds(150)
    async let picked = r.flow.pick(ready.path)
    try? await Task.sleep(for: .milliseconds(30))
    r.flow.cancel()
    _ = await picked
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")
  }

  // MARK: refusals

  func testARefusalShowsUnderItsRowUntilThatAnswerChanges() async {
    let r = await rig()
    r.daemon.setupAnswers = [ProjectSetupRefused.invalid("develop isn't on GitHub. Push it first, or pick another branch.", field: "target")]
    await r.flow.pick(ready.path)
    r.flow.setTarget("develop")
    let outcome = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(outcome, .showing)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.rows.first { $0.id == "target" }?.note, SetupNote("develop isn't on GitHub. Push it first, or pick another branch.", warn: true))
    XCTAssertNil(s.notice)
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")
    r.flow.setMode("direct")   // another answer: the note stays
    XCTAssertNotNil(r.flow.screen(goal: "", sandbox: nil)!.rows.first { $0.id == "target" }?.note)
    r.flow.setTarget("main")
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertNil(s.rows.first { $0.id == "target" }?.note)
  }

  func testARefusalAboutTheFolderOrNothingInParticularSitsOverTheButtons() async {
    let r = await rig()
    let symlink = "~/src/my-app/.capcomd leads outside the checkout (a symlink), so capcomd won't write there."
    r.daemon.setupAnswers = [ProjectSetupRefused.invalid(symlink, field: "path"), ProjectSetupRefused.forbidden]
    await r.flow.pick(ready.path)
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)?.notice, SetupNote(symlink, warn: true))
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)?.notice, SetupNote("Reset your token in Settings to set up projects.", warn: true))
  }

  func testWhileSettingUpThePrimarySaysSo() async {
    let r = await rig()
    await r.flow.pick(ready.path)
    var during: SetupScreen?
    r.store.onChange = { if case .saving = r.store.projectSetup { during = r.flow.screen(goal: "", sandbox: nil) } }
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(during?.primary, SetupButton("Setting Up…", .setUp, enabled: false, busy: true))
    XCTAssertEqual(during?.cancel, true)
  }

  // MARK: the GitHub CLI and the spend cap

  func testGitHubCLILoggedOutLandsAsPushesWithALogIn() async {
    var nogh = ready; nogh.ghReady = false; nogh.suggestedMode = "direct"
    let r = await rig()
    r.daemon.inspections[ready.path] = nogh
    await r.flow.pick(ready.path)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    let mode = s.rows.first { $0.id == "mode" }!
    XCTAssertEqual(mode.row, .mode("direct", target: "main", pullRequests: false))
    XCTAssertEqual(mode.note, SetupNote("Pull requests need the GitHub CLI logged in.", warn: true, logIn: true))
    XCTAssertTrue(s.primary!.enabled)
    // Even a suggestion of pull requests lands as pushes while gh is logged out.
    var odd = nogh; odd.suggestedMode = "pr"
    XCTAssertEqual(SetupAnswers(odd).mode, "direct")
    r.flow.setMode("pr")
    XCTAssertFalse(r.flow.screen(goal: "", sandbox: nil)!.primary!.enabled)
    r.flow.setMode("direct")
    // Logged in in Terminal, back in the panel: pull requests come back (the person didn't pick pushes themselves).
    r.daemon.inspections[ready.path] = ready
    let fresh = await rig()
    fresh.daemon.inspections[ready.path] = nogh
    await fresh.flow.pick(ready.path)
    fresh.daemon.inspections[ready.path] = ready
    await fresh.flow.refresh()
    s = fresh.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.rows.first { $0.id == "mode" }?.row, .mode("pr", target: "main", pullRequests: true))
    XCTAssertNil(s.rows.first { $0.id == "mode" }?.note)
    // A pick the person made stays.
    await r.flow.refresh()
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.rows.first { $0.id == "mode" }?.row, .mode("direct", target: "main", pullRequests: true))
  }

  func testTheSpendCapShowsOnlyWhenAnAgentBillsAKeyWhereRunsGo() async {
    var apikey = ready
    apikey.agents = [ProjectAgent(provider: "claude", label: "Claude Code", loggedIn: true, auth: "apikey",
                                  places: [.init(sandbox: "docker", loggedIn: false), .init(sandbox: "boxd", loggedIn: true, how: "api_key")]), codex]
    let r = await rig()
    r.daemon.inspections[ready.path] = apikey
    await r.flow.pick(ready.path)
    let cloud = r.flow.screen(goal: "", sandbox: "boxd")!
    XCTAssertEqual(cloud.rows.map(\.id), ["repository", "target", "mode", "agents", "budgetUsd"])
    XCTAssertEqual(cloud.rows.last?.row, .spendCap("5.00", valid: true))
    XCTAssertEqual(cloud.rows.last?.note, SetupNote("Claude Code bills your API key. A run stops at this amount."))
    // On Local Claude Code has no key: nothing to cap.
    XCTAssertFalse(r.flow.screen(goal: "", sandbox: "docker")!.rows.contains { $0.id == "budgetUsd" })
    // Not chosen: nothing to cap either.
    r.flow.toggleAgent("claude")
    XCTAssertFalse(r.flow.screen(goal: "", sandbox: "boxd")!.rows.contains { $0.id == "budgetUsd" })
    r.flow.toggleAgent("claude")
    // A plan login anywhere means it never bills a key.
    XCTAssertTrue(ProjectSetupFlow.billing(ready, SetupAnswers(ready), sandbox: "boxd").isEmpty)
    // Not an amount: the field and the button say so.
    r.flow.setBudget("abc")
    let bad = r.flow.screen(goal: "", sandbox: "boxd")!
    XCTAssertEqual(bad.rows.last?.row, .spendCap("abc", valid: false))
    XCTAssertEqual(bad.rows.last?.note?.warn, true)
    XCTAssertFalse(bad.primary!.enabled)
    // The cap goes with the setup (new runs go to Cloud here); empty is no limit.
    r.flow.setBudget("$ 12.50")
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(r.daemon.setups.last?.request.budgetUsd, 12.5)
    XCTAssertEqual(SetupAnswers(target: "main", mode: "pr", agents: [], budget: "").budgetValue, .none)
    XCTAssertEqual(SetupAnswers(target: "main", mode: "pr", agents: [], budget: "0").budgetValue, .invalid)
  }

  func testNoAgentLoggedInSaysWhereToLogIn() async {
    var nobody = ready
    nobody.agents = [ProjectAgent(provider: "claude", label: "Claude Code"), codex]
    let r = await rig()
    r.daemon.inspections[ready.path] = nobody
    await r.flow.pick(ready.path)
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.rows.first { $0.id == "agents" }?.note, SetupNote("Log in to Claude Code or Codex in Settings › Accounts first.", warn: true))
    XCTAssertFalse(s.primary!.enabled)
  }

  func testSetUpSendsNoCheckAndKeepsCapcomdOutOfGitWhenAsked() async {
    let r = await rig()
    XCTAssertFalse(r.store.prefs.gitignoreCapcomd)   // off by default
    await r.flow.pick(ready.path)
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertNil(r.daemon.setups.last?.request.check)   // the daemon keeps the project's check or uses its suggestion
    XCTAssertEqual(r.daemon.setups.last?.request.gitignore, false)
    let on = await rig()
    on.store.prefs.gitignoreCapcomd = true
    XCTAssertEqual(on.prefs.string(forKey: "gitignoreCapcomd"), "1")
    await on.flow.pick(ready.path)
    _ = await on.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(on.daemon.setups.last?.request.gitignore, true)
    let body = try! JSONSerialization.jsonObject(with: ProjectWire.body(on.daemon.setups.last!.request)) as! [String: Any]
    XCTAssertEqual(body["gitignore"] as? Bool, true)
    XCTAssertNil(body["check"])
    // A capcomd without projects.git: no gitignore, and the check it needs (its suggestion).
    let older = await rig(caps: [Capability.runsOptions, Capability.runsOptionsRepo, Capability.projectsSetup])
    older.store.prefs.gitignoreCapcomd = true
    await older.flow.pick(ready.path)
    _ = await older.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(older.daemon.setups.last?.request.gitignore, false)
    XCTAssertEqual(older.daemon.setups.last?.request.check, "bun run test")
  }

  // MARK: folders that need something first

  func testNotAGitCheckoutOffersInitializeGitThenThePublishForm() async {
    let path = "/Users/me/Downloads/my-app"
    let notGit = ProjectInspection(path: path, agents: [claude, codex], problems: [ProjectProblem(code: "not_git", message: "~/Downloads/my-app isn't a git checkout. Choose your repository's folder, or clone it first.")])
    let r = await rig([notGit])
    await r.flow.pick(path)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .attention)
    XCTAssertEqual(s.header, "my-app isn't a git checkout.")
    XCTAssertEqual(s.callout, [SetupSpan("Initialize Git to start a repository in this folder, or choose your repository's folder.")])
    XCTAssertTrue(s.chooseAnother); XCTAssertFalse(s.cancel)
    XCTAssertEqual(s.primary, SetupButton("Initialize Git", .initializeGit))
    var during: SetupButton?
    r.store.onChange = { if r.store.initializingGit { during = r.flow.screen(goal: "", sandbox: nil)?.primary } }
    await r.flow.initializeGit()
    XCTAssertEqual(during, SetupButton("Initializing…", .initializeGit, enabled: false, busy: true))
    XCTAssertEqual(r.daemon.gitInits, [path])
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .publish)
    XCTAssertEqual(s.header, "my-app isn't on GitHub yet.")
    XCTAssertEqual(s.rows.map(\.row), [.account("marvin", accounts: r.daemon.options.accounts), .name("my-app", valid: true), .visibility("private")])
    XCTAssertEqual(s.callout?.map(\.text).joined(), "Creates github.com/marvin/my-app, commits the folder's 24 files as the first commit, and pushes main.")
    XCTAssertEqual(s.callout?.filter(\.mono).map(\.text), ["github.com/marvin/my-app", "main"])
    XCTAssertNil(s.notice)
    XCTAssertEqual(s.primary, SetupButton("Publish to GitHub", .publish))
    XCTAssertTrue(s.chooseAnother)
  }

  func testInitializeGitRefusedSaysWhy() async {
    let path = "/Users/me/Downloads/my-app"
    let notGit = ProjectInspection(path: path, problems: [ProjectProblem(code: "not_git", message: "not a checkout")])
    let r = await rig([notGit])
    r.daemon.initAnswers = [ProjectSetupRefused.invalid("~/Downloads/my-app holds capcomd's settings, so it can't be a project.", field: "path")]
    await r.flow.pick(path)
    await r.flow.initializeGit()
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .attention)
    XCTAssertEqual(s.notice, SetupNote("~/Downloads/my-app holds capcomd's settings, so it can't be a project.", warn: true))
    XCTAssertEqual(s.primary?.title, "Initialize Git")
  }

  func testWithoutTheGitRoutesTheDaemonsSentenceAndAnotherFolder() async {
    let path = "/Users/me/Downloads"
    let notGit = ProjectInspection(path: path, problems: [ProjectProblem(code: "not_git", message: "~/Downloads isn't a git checkout. Choose your repository's folder, or clone it first.")])
    let noOrigin = ProjectInspection(path: "/Users/me/src/x", root: "/Users/me/src/x", name: "x", problems: [ProjectProblem(code: "no_origin", message: "~/src/x has no origin remote.")])
    let r = await rig([notGit, noOrigin], caps: [Capability.runsOptions, Capability.runsOptionsRepo, Capability.projectsSetup])
    await r.flow.pick(path)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.callout, [SetupSpan("~/Downloads isn't a git checkout. Choose your repository's folder, or clone it first.")])
    XCTAssertTrue(s.chooseAnother); XCTAssertNil(s.primary)
    await r.flow.pick(noOrigin.path)
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .attention)
    XCTAssertEqual(s.header, "x isn't on GitHub yet.")
    XCTAssertEqual(s.callout, [SetupSpan("~/src/x has no origin remote.")])
    XCTAssertNil(s.primary)
  }

  func testNotOnGitHubHandsOffToTerminal() async {
    let gitlab = ProjectInspection(path: "/Users/me/src/docs-site", root: "/Users/me/src/docs-site", name: "docs-site", repo: "https://gitlab.com/acme/docs-site.git",
                                   problems: [ProjectProblem(code: "not_github", message: "isn't on GitHub")])
    let r = await rig([gitlab])
    await r.flow.pick(gitlab.path)
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.header, "docs-site isn't on GitHub.")
    XCTAssertEqual(s.callout?.map(\.text).joined(), "Its repository is gitlab.com/acme/docs-site. The app sets up GitHub projects; for others, run capcomd setup project in Terminal.")
    XCTAssertEqual(s.callout?.filter(\.mono).map(\.text), ["gitlab.com/acme/docs-site", "capcomd setup project"])
    XCTAssertEqual(s.primary, SetupButton("Open in Terminal", .openInTerminal))
    XCTAssertTrue(s.chooseAnother)
    // Set up in Terminal, back in the panel: it's where new runs go.
    var done = gitlab; done.configured = true; done.problems = []
    r.daemon.inspections[gitlab.path] = done
    await r.flow.refresh()
    XCTAssertFalse(r.flow.isOpen)
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/docs-site")
  }

  func testAFolderThatCantBeCheckedOffersTryAgain() async {
    let r = await rig()
    r.daemon.inspectAnswers = [URLError(.timedOut)]
    await r.flow.pick(ready.path)
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .attention)
    XCTAssertEqual(s.header, "my-app couldn't be checked.")
    XCTAssertEqual(s.callout, [SetupSpan("Couldn't look at this folder just now. Try again.")])
    XCTAssertEqual(s.primary, SetupButton("Try Again", .tryAgain))
  }

  // MARK: publishing

  // MARK: publishing

  let noOriginPath = "/Users/me/src/my-app"
  var noOrigin: ProjectInspection {
    ProjectInspection(path: noOriginPath, root: noOriginPath, name: "my-app", agents: [claude, codex], problems: [ProjectProblem(code: "no_origin", message: "no origin")])
  }

  func testPublishLocksTheRowsThenTheUsualSetupWithTheNewRepository() async {
    let r = await rig([noOrigin])
    await r.flow.pick(noOriginPath)
    r.flow.setOwner("acme"); r.flow.setVisibility("public")
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.callout?.map(\.text).joined(), "Creates github.com/acme/my-app, commits the folder's 24 files as the first commit, and pushes main.")
    // Publishing: locked rows, the line says what's happening, one button.
    var during: SetupScreen?
    r.store.onChange = { if case .publishing = r.store.projectPublish { during = r.flow.screen(goal: "", sandbox: nil) } }
    await r.flow.publish()
    XCTAssertEqual(during?.locked, true)
    XCTAssertEqual(during?.callout?.map(\.text).joined(), "Pushing main to github.com/acme/my-app…")
    XCTAssertEqual(during?.primary, SetupButton("Publishing…", .publish, enabled: false, busy: true))
    XCTAssertEqual(during?.chooseAnother, false)
    XCTAssertEqual(r.daemon.publishes, [[noOriginPath, "acme", "my-app", "public"]])
    // Published: straight into the usual setup, the new repository filled in.
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .form)
    XCTAssertEqual(s.rows.first?.row, .repository("acme/my-app"))
    XCTAssertEqual(s.rows.first?.note, SetupNote("Published just now, public."))
    XCTAssertEqual(s.primary?.title, "Set Up")
    XCTAssertEqual(r.store.prefs.startRepo, "/Users/me/src/old")   // not set up yet
    _ = await r.flow.submit(goal: "") { _ in true }
    XCTAssertEqual(r.store.prefs.startRepo, noOriginPath)
  }

  func testAPrivatePublishSaysSoAndACheckoutWithCommitsPushesItsBranch() async {
    let r = await rig([noOrigin])
    r.daemon.options.hasCommits = true; r.daemon.options.branch = "trunk"
    await r.flow.pick(noOriginPath)
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.callout?.map(\.text).joined(), "Creates github.com/marvin/my-app and pushes trunk.")
    await r.flow.publish()
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.rows.first?.note, SetupNote("Published just now, private."))
  }

  func testATakenNameShowsUnderName() async {
    let r = await rig([noOrigin])
    r.daemon.publishAnswers = [ProjectSetupRefused.invalid("marvin/my-app already exists on GitHub. Pick another name.", field: "name")]
    await r.flow.pick(noOriginPath)
    await r.flow.publish()
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .publish)
    XCTAssertEqual(s.rows.first { $0.id == "name" }?.note, SetupNote("marvin/my-app already exists on GitHub. Pick another name.", warn: true))
    XCTAssertEqual(s.rows.map(\.row).first, .account("marvin", accounts: r.daemon.options.accounts))   // the values stay
    XCTAssertNil(s.notice)
    r.flow.setName("bad name")
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertNil(s.rows.first { $0.id == "name" }?.note)
    XCTAssertEqual(s.rows.first { $0.id == "name" }?.row, .name("bad name", valid: false))
    XCTAssertFalse(s.primary!.enabled)
    r.flow.setName("my-app-2")
    await r.flow.publish()
    XCTAssertEqual(r.daemon.publishes.last, [noOriginPath, "marvin", "my-app-2", "private"])
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)?.phase, .form)
  }

  func testLikelySecretsAreSaidUnderTheCalloutAndRefusalsWithoutARowToo() async {
    let r = await rig([noOrigin])
    r.daemon.options.files = 25
    r.daemon.options.blocked = [ProjectBlockedFile(path: ".env", reason: "an environment file, which usually holds secrets")]
    await r.flow.pick(noOriginPath)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.callout?.map(\.text).joined(), "Creates github.com/marvin/my-app, commits the folder's 25 files as the first commit, and pushes main.")
    XCTAssertEqual(s.notice, SetupNote(".env looks like it holds secrets, and the first commit would publish it. Add it to .gitignore, then publish.", warn: true))
    XCTAssertFalse(s.primary!.enabled)
    // The daemon's own refusal (files, identity) shows in the same place.
    r.daemon.options.blocked = []
    await r.flow.refresh()
    XCTAssertTrue(r.flow.screen(goal: "", sandbox: nil)!.primary!.enabled)
    let identity = "git doesn't know who you are, so it can't make the first commit. Set your name and email, then publish again."
    r.daemon.publishAnswers = [ProjectSetupRefused.invalid(identity, field: "identity")]
    await r.flow.publish()
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.notice, SetupNote(identity, warn: true))
    XCTAssertTrue(s.rows.allSatisfy { $0.note == nil })
  }

  func testPublishNeedsTheGitHubCLI() async {
    let r = await rig([noOrigin])
    r.daemon.options = ProjectPublishOptions(ghReady: false, suggestedName: "my-app", files: 24)
    await r.flow.pick(noOriginPath)
    var s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.callout, [SetupSpan("Publishing needs the GitHub CLI logged in on this Mac.")])
    XCTAssertEqual(s.primary, SetupButton("Log In to GitHub…", .logInToGitHub))
    XCTAssertTrue(s.rows.isEmpty); XCTAssertTrue(s.chooseAnother)
    // Logged in in Terminal, back in the panel.
    r.daemon.options = ProjectPublishOptions(ghReady: true, accounts: [ProjectPublishAccount(login: "marvin")], suggestedName: "my-app", files: 24)
    await r.flow.refresh()
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.primary?.title, "Publish to GitHub")
    // The daemon finds it logged out after all: log in again.
    r.daemon.publishAnswers = [ProjectSetupRefused.invalid("Publishing needs the GitHub CLI logged in on this Mac (run `gh auth login` in Terminal), then publish again.", field: "gh")]
    await r.flow.publish()
    s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.primary, SetupButton("Log In to GitHub…", .logInToGitHub))
    await r.flow.refresh()
    XCTAssertEqual(r.flow.screen(goal: "", sandbox: nil)!.primary?.title, "Publish to GitHub")
  }

  func testPublishOptionsThatCantBeReadOfferTryAgain() async {
    let r = await rig([noOrigin])
    r.daemon.optionsAnswers = [URLError(.timedOut)]
    await r.flow.pick(noOriginPath)
    let s = r.flow.screen(goal: "", sandbox: nil)!
    XCTAssertEqual(s.phase, .publish)
    XCTAssertEqual(s.notice, SetupNote("Couldn't read this folder's publish options just now. Try again.", warn: true))
    XCTAssertEqual(s.primary, SetupButton("Try Again", .tryAgain))
  }

  func testShortRepository() {
    XCTAssertEqual(ProjectSetupFlow.shortRepo("https://gitlab.com/acme/docs-site.git"), "gitlab.com/acme/docs-site")
    XCTAssertEqual(ProjectSetupFlow.shortRepo("git@gitlab.com:acme/docs-site.git"), "gitlab.com/acme/docs-site")
    XCTAssertNil(ProjectSetupFlow.shortRepo(nil))
  }
}
