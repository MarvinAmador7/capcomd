import XCTest
@testable import CapcomdStore

/// The desktop's actions as data (design/desktop ReelNew, ReelMenu, ⌘K): the new project column's form, the project
/// menu's items per capability and run state, and the palette's entries and filtering.
@MainActor
final class DeskActionsTests: XCTestCase {
  var seq = 0
  func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int = 1_000) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)", runId: run,
                              agentId: agent, data: d)), scope: run)
  }
  func branches(base: String?, suggested: String? = "capcomd/backfill", problem: String? = nil) -> ProjectBranches {
    ProjectBranches(path: "/src/app", source: "github", defaultBranch: base, branches: ["dev", "main", "release"], suggestedBase: base,
                    suggestedGoalBranch: suggested, goalBranchProblem: problem)
  }

  // MARK: the new project column

  /// Empty → typing: the bot smiles at the first word and keeps smiling (one change, no loop); Esc closes only while
  /// nothing is typed; Start needs a goal.
  func testTheFormFromEmptyToTyping() {
    var f = NewProjectForm()
    XCTAssertFalse(f.smiling); XCTAssertTrue(f.escCloses)
    XCTAssertFalse(f.canStart(branches: false, setupShowing: false))
    f.type("   ")
    XCTAssertFalse(f.smiling)                       // spaces aren't a goal
    f.type("Backfill addriva_id")
    XCTAssertTrue(f.smiling); XCTAssertFalse(f.escCloses)
    XCTAssertTrue(f.canStart(branches: false, setupShowing: false))
    f.type("")
    XCTAssertTrue(f.smiling)                        // never back to sleep
    XCTAssertTrue(f.escCloses)
  }

  /// Starting → started: nothing can start twice; the column waits for the run.
  func testStartingThenStarted() {
    var f = NewProjectForm()
    f.type("Ship it")
    f.starting()
    XCTAssertEqual(f.phase, .starting)
    XCTAssertFalse(f.canStart(branches: false, setupShowing: false))
    XCTAssertFalse(f.escCloses)
    f.finished(.started(runId: "run-9"), field: nil)
    XCTAssertEqual(f.phase, .started(runId: "run-9"))
  }

  /// A refused start keeps the column and puts the daemon's sentence under the field it names: the goal branch row's
  /// field when it shows, else under the goal. Editing that field puts it away.
  func testARefusedStartSaysWhyUnderItsField() {
    var f = NewProjectForm()
    f.type("Ship it")
    f.goalSetup.open(path: "/src/app")
    let q = f.goalSetup.query!
    f.goalSetup.receive(.loaded(branches(base: "dev")), for: q)
    f.starting()
    f.finished(.failed("capcomd/backfill already exists on origin"), field: "goalBranch")
    XCTAssertEqual(f.phase, .editing)
    XCTAssertNil(f.goalLine(branches: true))
    XCTAssertEqual(f.branchLine, GoalSetupLine("capcomd/backfill already exists on origin", warn: true))
    XCTAssertEqual(f.goalLine(branches: false), "capcomd/backfill already exists on origin")   // no row: under the goal
    f.editedBranchField()
    XCTAssertNil(f.branchLine)
    // A refusal about the goal itself shows under the goal, and stays while the goal is edited.
    f.finished(.failed("goal is empty"), field: nil)
    XCTAssertEqual(f.goalLine(branches: true), "goal is empty")
  }

  /// The branch row never defaults to main: with no suggestion nothing is picked, Start waits, and the row says so.
  func testNeverMain() {
    var f = NewProjectForm()
    f.type("Ship it")
    f.goalSetup.open(path: "/src/app")
    XCTAssertFalse(f.canStart(branches: true, setupShowing: false))   // the first answer is still out
    f.goalSetup.receive(.loaded(branches(base: nil)), for: f.goalSetup.query!)
    XCTAssertNil(f.goalSetup.base)
    XCTAssertTrue(f.goalSetup.branches.contains("main"))
    XCTAssertFalse(f.canStart(branches: true, setupShowing: false))
    XCTAssertEqual(f.baseLine, GoalSetupLine(GoalBranchSetup.pickBase, warn: true))
    f.goalSetup.pickBase("release")
    XCTAssertTrue(f.canStart(branches: true, setupShowing: false))
    XCTAssertEqual(f.goalSetup.choice.base, "release")
  }

  /// A folder that isn't set up shows its next steps instead of the tool row: Start waits for them.
  func testANotSetUpFolderHoldsStart() {
    var f = NewProjectForm()
    f.type("Ship it")
    XCTAssertFalse(f.canStart(branches: false, setupShowing: true))
  }

  /// Without `runs.goal_branch` (or without a project folder) there is no branch row, and Start sends no base or branch;
  /// with it, the row's choices go with the run.
  func testTheBranchRowNeedsTheCapabilityAndAFolder() {
    let s = CapcomdStore()
    var g = GoalBranchSetup()
    g.open(path: "/src/app")
    g.receive(.loaded(branches(base: "dev")), for: g.query!)
    s.prefs.startRepo = "/src/app"
    XCTAssertFalse(s.goalBranchesOffered)
    XCTAssertNil(s.newRunChoice(goalSetup: g).base)
    XCTAssertNil(s.newRunChoice(goalSetup: g).goalBranch)
    s.capabilities = [Capability.runsGoalBranch]
    XCTAssertTrue(s.goalBranchesOffered)
    XCTAssertEqual(s.newRunChoice(goalSetup: g).base, "dev")
    XCTAssertEqual(s.newRunChoice(goalSetup: g).repo, "/src/app")
    s.prefs.startRepo = nil
    XCTAssertFalse(s.goalBranchesOffered)            // the default project: no row
    XCTAssertNil(s.newRunChoice(goalSetup: g).base)
  }

  // MARK: the project menu

  func running(_ s: CapcomdStore, _ run: String = "run-a") {
    ev(s, run, "run.created", nil, ["goal": .string("Migrate matchkey to v3.2 across ids/v1 and addriva"), "sandbox": .string("boxd")])
    ev(s, run, "agent.spawned", "pl", ["profile": .string("planner")])
    ev(s, run, "agent.started", "pl")
    ev(s, run, "agent.spawned", "w1", ["profile": .string("worker"), "parent": .string("pl")])
  }

  func testARunningProjectsMenu() throws {
    let s = CapcomdStore()
    s.capabilities = [Capability.runControls]
    running(s)
    let m = try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a"))
    XCTAssertEqual(m.goal, "Migrate matchkey to v3.2 across ids/v1 and addriva")
    XCTAssertEqual(m.sandbox, "boxd"); XCTAssertEqual(m.agents, 2); XCTAssertEqual(m.plannerId, "pl")
    XCTAssertEqual(m.sections, [[.messagePlanner], [.pause, .stop], [.fold, .copyRunId(short: "run-a")]])
    XCTAssertEqual(m.items.map(\.shortcut), ["⌘L", "⌥⌘P", nil, "⌘W", nil])
  }

  /// Pause becomes Resume while paused (and while a pause is on its way to being confirmed).
  func testPauseBecomesResume() throws {
    let s = CapcomdStore()
    s.capabilities = [Capability.runControls]
    running(s)
    ev(s, "run-a", "run.paused", nil)
    XCTAssertEqual(try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a")).sections[1], [.resume, .stop])
  }

  /// Without `run.controls` there is nothing to pause or stop: hidden, not disabled.
  func testNoRunControlsNoControls() throws {
    let s = CapcomdStore()
    running(s)
    let m = try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a"))
    XCTAssertFalse(m.items.contains(.pause)); XCTAssertFalse(m.items.contains(.stop))
    XCTAssertEqual(m.sections.count, 2)
  }

  /// A finished project: no planner to message, nothing to control, and Remove from the title bar instead of Fold.
  func testAFinishedProjectOffersRemove() throws {
    let s = CapcomdStore()
    s.capabilities = [Capability.runControls]
    running(s)
    ev(s, "run-a", "agent.done", "pl"); ev(s, "run-a", "agent.done", "w1")
    ev(s, "run-a", "run.completed", nil)
    let m = try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a"))
    XCTAssertEqual(m.sections, [[.remove, .copyRunId(short: "run-a")]])
    XCTAssertEqual(ProjectMenu.Item.remove.shortcut, "⌘W")
  }

  /// Changes shows only for a run whose goal branch is on GitHub (the compare it opens), with the goal view's counts;
  /// Trace and Browse the workspace aren't offered at all.
  func testChangesNeedsTheGoalBranchCompare() throws {
    let s = CapcomdStore()
    running(s)
    XCTAssertFalse(try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a")).items.contains { $0.name == "changes" })
    let run = try JSONDecoder().decode(SnapshotRun.self, from: Data("""
      {"id":"run-a","projectId":"prj-run-a","label":null,"state":"running","goal":"g","goalBranch":{"branch":"capcomd/add-x","base":"dev","state":"working","readyAt":null,"pullRequest":null}}
      """.utf8))
    s.receive(.reset(snapshotSeq: 100, reason: "compacted"), scope: "daemon")
    s.receive(.snapshotRun(run), scope: "daemon")
    s.receive(.snapshotEnd(snapshotSeq: 100), scope: "daemon")
    XCTAssertFalse(try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a")).items.contains { $0.name == "changes" })   // the view isn't read yet
    s.goalViews["run-a"] = .loaded(GoalView(runId: "run-a", branch: "capcomd/add-x", base: "dev", state: "working",
                                            compare: GoalCompare(files: [], filesTotal: 3, added: 73, removed: 5),
                                            openPullRequest: .init(available: false, repo: "acme/app")))
    let m = try XCTUnwrap(s.projectMenu(projectId: "prj-run-a", runId: "run-a"))
    let changes = try XCTUnwrap(m.items.first { $0.name == "changes" })
    XCTAssertEqual(changes, .changes(added: 73, removed: 5, files: 3, url: URL(string: "https://github.com/acme/app/compare/dev...capcomd/add-x")!))
  }

  func testTheRunIdIsShortenedButCopiedWhole() {
    XCTAssertEqual(ProjectMenu.shortId("run-7f3a2c1d-55aa-4e1f"), "run-7f3a2c")
    XCTAssertEqual(ProjectMenu.shortId("run-a"), "run-a")
  }

  // MARK: the palette

  func header(_ id: String, _ name: String, title: String?) -> ColumnHeader {
    ColumnHeader(agentId: id, runId: "run-a", name: name, title: title, suffix: nil, kind: .other, status: .running, waiting: false, activity: nil,
                 repo: nil, spawnedAtMs: 0, startedAtMs: nil, provider: nil, depth: 0)
  }

  func entries() -> [PaletteEntry] {
    let decks = [DeckInfo(id: "p1", runId: "r1", title: "Migrate matchkey", isRunning: true, agentIds: []),
                 DeckInfo(id: "p2", runId: "r2", title: "Fix proration", isRunning: true, agentIds: [])]
    let menu = ProjectMenu(projectId: "p1", runId: "r1", goal: "g", repos: [], agents: 2, plannerId: "pl",
                           sections: [[.messagePlanner], [.pause, .stop], [.fold, .copyRunId(short: "r1")]], control: .idle)
    return Palette.entries(menu: menu, decks: decks, openProjectId: "p1",
                           agents: [header("pl", "planner", title: "plan the backfill"), header("w1", "worker", title: "login redirect")], follow: true)
  }

  /// The menu's actions, Home, new project, Follow, the other projects (not the open one) and the agents by title.
  func testThePalettesEntries() {
    let e = entries()
    XCTAssertEqual(e.map(\.title), ["Message the planner…", "Pause project", "Stop project…", "Fold into the title bar", "Copy run ID",
                                    "Home", "New project", "Turn Follow off", "Switch to Fix proration", "Focus plan the backfill", "Focus login redirect"])
    XCTAssertEqual(e.first { $0.id == "home" }?.shortcut, "⌘0")
    XCTAssertEqual(e.first { $0.id == "home" }?.action, .home)
    XCTAssertEqual(e.first { $0.id == "project.p2" }?.shortcut, "⌘2")
    XCTAssertEqual(e.first { $0.id == "agent.w1" }?.action, .agent("w1"))
    XCTAssertEqual(e.first { $0.id == "follow" }?.action, .follow(false))
    XCTAssertEqual(e.first { $0.id == "menu.copy" }?.detail, "r1")
  }

  /// Typing filters by word starts, every word; titles that start with what's typed come first.
  func testFiltering() {
    let e = entries()
    XCTAssertEqual(Palette.filter(e, "").count, e.count)
    XCTAssertEqual(Palette.filter(e, "pro").map(\.title), ["Pause project", "Stop project…", "New project", "Switch to Fix proration"])
    XCTAssertEqual(Palette.filter(e, "login").map(\.action), [.agent("w1")])
    XCTAssertEqual(Palette.filter(e, "f o").map(\.title), ["Turn Follow off"])
    XCTAssertEqual(Palette.filter(e, "fold").map(\.action), [.menu(.fold)])
    XCTAssertEqual(Palette.filter(e, "switch fix").map(\.action), [.project("p2")])
    XCTAssertEqual(Palette.filter(e, "worker").map(\.action), [.agent("w1")])    // its profile, when it has a title
    XCTAssertTrue(Palette.filter(e, "zzz").isEmpty)
    // A title that starts with the query leads.
    XCTAssertEqual(Palette.filter(e, "new").first?.action, .newProject)
  }
}
