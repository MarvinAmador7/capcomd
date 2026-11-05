import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// The desktop model's new project column, project menu and palette against a store fed event by event: what each
/// shows and does, and who gets Return.
final class DeskActionsModelTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  final class Starter: RunStarting, @unchecked Sendable {
    var outcomes: [Result<String, Error>] = []
    var choices: [RunChoice] = []
    func start(goal: String, choice: RunChoice, idempotencyKey: String) async throws -> String { choices.append(choice); return try outcomes.removeFirst().get() }
  }
  final class Controls: RunControlling, @unchecked Sendable {
    var calls: [RunControl] = []
    func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws { calls.append(action) }
    func control(runId: String, agentId: String, _ action: RunControl, idempotencyKey: String) async throws {}
  }

  var seq = 0
  @MainActor func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int = 1_000) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)",
                              runId: run, agentId: agent, data: d)), scope: run)
  }
  @MainActor func project(_ s: CapcomdStore, _ run: String, goal: String, at: Int) {
    ev(s, run, "run.created", nil, ["goal": .string(goal)], at: at)
    ev(s, run, "agent.spawned", "\(run)-pl", ["profile": .string("planner")], at: at + 1)
    ev(s, run, "agent.started", "\(run)-pl", at: at + 2)
  }
  @MainActor func model(starter: Starter? = nil, controls: Controls? = nil) -> (DeskModel, CapcomdStore) {
    let s = CapcomdStore(controls: controls, starter: starter)
    project(s, "run-a", goal: "Migrate matchkey", at: 1_000)
    let m = DeskModel(store: s)
    m.chooseFolder = { nil }
    return (m, s)
  }
  @MainActor func until(_ what: @escaping () -> Bool) async throws {
    var n = 0
    while !what() && n < 200 { n += 1; try await Task.sleep(for: .milliseconds(5)) }
  }

  /// Open → typing → starting → the planner's column: the run the daemon started opens on its planner once the feed
  /// lists it, and the new project takes its place after the others.
  @MainActor func testStartTurnsTheColumnIntoThePlannersColumn() async throws {
    let st = Starter(); st.outcomes = [.success("run-new")]
    let (m, s) = model(starter: st)
    XCTAssertEqual(m.openRunId, "run-a")
    m.openNewProject()
    let np = try XCTUnwrap(m.newProject)
    XCTAssertFalse(np.form.smiling)
    XCTAssertFalse(m.newProjectCanStart)
    m.typeGoal("Backfill addriva_id")
    XCTAssertTrue(np.form.smiling)
    XCTAssertTrue(m.newProjectCanStart)
    await m.startNewProject()
    XCTAssertEqual(np.form.phase, .started(runId: "run-new"))
    XCTAssertNotNil(m.newProject)                        // waits for the run's planner
    XCTAssertNil(st.choices.first?.base)                 // no goal branches on this daemon
    project(s, "run-new", goal: "Backfill addriva_id", at: 5_000)
    XCTAssertNil(m.newProject)
    XCTAssertEqual(m.openRunId, "run-new")
    XCTAssertEqual(m.columns.first, "run-new-pl")
    XCTAssertEqual(m.focusedAgent, "run-new-pl")
    XCTAssertEqual(m.decks.map(\.runId), ["run-a", "run-new"])
  }

  /// The tool row's picks (place, driver, effort) as the chip's bindings make them, while the column is open: Start
  /// sends them, and the column redraws with each.
  @MainActor func testTheToolRowsPicksGoWithTheRun() async throws {
    let st = Starter(); st.outcomes = [.success("run-new")]
    let (m, s) = model(starter: st)
    s.runOptions = RunOptions(
      drivers: [DriverInfo(provider: "claude", label: "Claude Code", isDefault: true, efforts: ["low", "high"],
                           sandboxes: ["docker": DriverAvailability(available: false, reason: "Not logged in to Claude Code for Local"), "boxd": DriverAvailability(available: true)]),
                DriverInfo(provider: "codex", label: "Codex", efforts: ["low", "medium", "high"], effort: "medium")],
      sandboxes: [SandboxInfo(name: "docker", label: "Local"), SandboxInfo(name: "boxd", label: "Cloud", isDefault: true)])
    m.openNewProject()
    let np = try XCTUnwrap(m.newProject)
    XCTAssertEqual(s.driverChoices.current?.provider, "claude")
    let before = np.revision
    s.pickDriver("codex"); m.newProjectChanged()          // the driver menu's Picker
    s.pickEffort("high"); m.newProjectChanged()           // its effort Picker
    XCTAssertGreaterThan(np.revision, before)
    XCTAssertEqual(s.driverChoices.current?.provider, "codex")
    m.typeGoal("Ship it")
    await m.startNewProject()
    XCTAssertEqual(st.choices.first?.driver, "codex")
    XCTAssertEqual(st.choices.first?.effort, "high")
    XCTAssertEqual(st.choices.first?.sandbox, "boxd")
    // Local: Claude Code can't run there, so the chip offers Codex and says why Claude Code isn't listed.
    s.setDefaultPlace("docker"); s.pickDriver("claude")
    XCTAssertEqual(s.driverChoices.current?.provider, "codex")
    XCTAssertEqual(s.driverChoices.unavailable.first?.reason, "Not logged in to Claude Code for Local")
  }

  /// A refused start: the column stays, with the daemon's sentence, and Start can go again.
  @MainActor func testARefusedStartKeepsTheColumn() async throws {
    let st = Starter(); st.outcomes = [.failure(StartRefused("codex can't drive this run: codex isn't logged in"))]
    let (m, _) = model(starter: st)
    m.openNewProject()
    m.typeGoal("Ship it")
    await m.startNewProject()
    let np = try XCTUnwrap(m.newProject)
    XCTAssertEqual(np.form.phase, .editing)
    XCTAssertEqual(np.form.goalLine(branches: false), "codex can't drive this run: codex isn't logged in")
    XCTAssertTrue(m.newProjectCanStart)
  }

  /// A goal typed on Home and left (⌘W, or Esc on an empty one) stays for next time.
  @MainActor func testClosingKeepsTheDraft() throws {
    let (m, _) = model()
    m.openNewProject()
    m.typeGoal("Half a thought")
    m.closeNewProject()                                  // ⌘W or Esc: back to the open project
    XCTAssertNil(m.newProject)
    m.openNewProject()
    XCTAssertEqual(m.newProject?.form.goal, "Half a thought")
    XCTAssertEqual(m.newProject?.form.escCloses, false)
  }

  /// Return approves the focused column's ask only while nothing else takes Return.
  @MainActor func testReturnNeverApprovesWhileATextFieldHasIt() {
    let (m, _) = model()
    XCTAssertTrue(m.returnApproves)
    m.openNewProject(); XCTAssertFalse(m.returnApproves)
    m.closeNewProject(); XCTAssertTrue(m.returnApproves)
    m.togglePalette(); XCTAssertFalse(m.returnApproves)
    m.closePalette(); XCTAssertTrue(m.returnApproves)
    m.toggleMenu(); XCTAssertFalse(m.returnApproves)
    m.closeMenu()
    m.typing(in: "run-a-pl", true); XCTAssertFalse(m.returnApproves)
    XCTAssertEqual(m.focusedAgent, "run-a-pl")           // typing in a box focuses its column
    m.typing(in: "run-a-pl", false); XCTAssertTrue(m.returnApproves)
    m.beginRename("run-a-pl", at: .tab); XCTAssertFalse(m.returnApproves)
  }

  /// Stop asks first; only a yes cancels. Pause and Resume go straight to the daemon.
  @MainActor func testStopAsksFirst() async throws {
    let c = Controls()
    let (m, s) = model(controls: c)
    s.capabilities = [Capability.runControls]
    m.apply([.all])
    m.perform(try XCTUnwrap(m.menuItem("stop")))
    XCTAssertTrue(m.stopAsked); XCTAssertFalse(m.returnApproves)
    try await Task.sleep(for: .milliseconds(50))
    XCTAssertEqual(c.calls, [])
    m.cancelStop()
    XCTAssertFalse(m.stopAsked)
    m.perform(try XCTUnwrap(m.menuItem("stop")))
    m.confirmStop()
    try await until { !c.calls.isEmpty }
    XCTAssertEqual(c.calls, [.cancel])
    m.pauseShortcut()
    try await until { c.calls.count == 2 }
    XCTAssertEqual(c.calls.last, .pause)
  }

  /// ⌘W folds the open project into its deck: it keeps running and nothing opens by itself until one is picked.
  @MainActor func testFoldKeepsTheProjectInItsDeck() {
    let (m, s) = model()
    m.foldShortcut()
    XCTAssertNil(m.openProjectId)
    XCTAssertEqual(m.decks.count, 1)
    ev(s, "run-a", "agent.activity_changed", "run-a-pl", ["activity": .object(["text": .string("Reading"), "kind": .string("read")])])
    m.apply([.all])
    XCTAssertNil(m.openProjectId)                        // still folded
    m.goToProject(0)
    XCTAssertEqual(m.openRunId, "run-a")
  }

  /// A finished project offers Remove from the title bar: it's gone until it has news (here, a new run).
  @MainActor func testRemoveHidesAFinishedProjectUntilItHasNews() throws {
    let (m, s) = model()
    project(s, "run-b", goal: "Fix proration", at: 2_000)
    m.open(project: m.decks.first { $0.runId == "run-a" }?.id)
    ev(s, "run-a", "agent.done", "run-a-pl"); ev(s, "run-a", "run.completed", nil)
    XCTAssertNil(m.menuItem("fold"))
    m.perform(try XCTUnwrap(m.menuItem("remove")))
    XCTAssertEqual(m.decks.map(\.runId), ["run-b"])
    XCTAssertNil(m.openProjectId)
    ev(s, "run-a", "approval.requested", "run-a-pl", ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge?"),
                                                       "requestedBy": .object(["agentId": .string("run-a-pl"), "runId": .string("run-a")])])
    XCTAssertEqual(m.decks.map(\.runId), ["run-a", "run-b"])   // it asks: it's back
  }

  /// Removed stays removed across launches: the next model on the same defaults hides it until it has news.
  @MainActor func testRemoveLastsAcrossLaunches() throws {
    let suite = "desk-tests-\(UUID().uuidString)"
    let d = try XCTUnwrap(UserDefaults(suiteName: suite))
    defer { d.removePersistentDomain(forName: suite) }
    let s = CapcomdStore()
    project(s, "run-a", goal: "Migrate matchkey", at: 1_000)
    project(s, "run-b", goal: "Fix proration", at: 2_000)
    ev(s, "run-a", "agent.done", "run-a-pl"); ev(s, "run-a", "run.completed", nil)
    let first = DeskModel(store: s, defaults: d)
    first.open(project: first.decks.first { $0.runId == "run-a" }?.id)
    first.perform(try XCTUnwrap(first.menuItem("remove")))
    XCTAssertEqual(first.decks.map(\.runId), ["run-b"])
    let relaunched = DeskModel(store: s, defaults: d)
    XCTAssertEqual(relaunched.decks.map(\.runId), ["run-b"])
    project(s, "run-a2", goal: "Migrate matchkey again", at: 9_000)  // another project's news doesn't bring it back
    relaunched.apply([.all])
    XCTAssertFalse(relaunched.decks.map(\.runId).contains("run-a"))
  }

  /// Message the planner: its column comes on screen and its box takes the focus once.
  @MainActor func testMessageThePlannerFocusesItsBox() {
    let (m, _) = model()
    m.messagePlannerShortcut()
    XCTAssertEqual(m.focusedAgent, "run-a-pl")
    XCTAssertEqual(m.agent("run-a-pl")?.boxFocus, 1)
    XCTAssertTrue(m.takeBoxFocus("run-a-pl"))
    XCTAssertFalse(m.takeBoxFocus("run-a-pl"))
  }

  /// The palette: what's typed filters, ↑ ↓ move, Return runs the selection and closes it.
  @MainActor func testThePaletteRunsWhatsSelected() {
    let (m, s) = model()
    project(s, "run-b", goal: "Fix proration", at: 2_000)
    m.togglePalette(query: "switch")
    XCTAssertEqual(m.paletteShown.map(\.action), [.project(m.decks[1].id)])
    m.runPaletteSelection()
    XCTAssertFalse(m.paletteOpen)
    XCTAssertEqual(m.openRunId, "run-b")
    m.togglePalette(query: "follow")
    m.runPaletteSelection()
    XCTAssertFalse(m.follow)
    m.togglePalette()
    m.paletteQuery = "new"
    m.movePaletteSelection(5); XCTAssertEqual(m.paletteSelection, m.paletteShown.count - 1)
    m.movePaletteSelection(-9); XCTAssertEqual(m.paletteSelection, 0)
    m.runPaletteSelection()
    XCTAssertNotNil(m.newProject)
    // While the new project column is open the palette has no open project's actions.
    XCTAssertFalse(m.paletteEntries.contains { if case .menu = $0.action { return true }; return false })
  }
  #endif
}
