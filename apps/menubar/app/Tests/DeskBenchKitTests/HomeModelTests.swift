import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
import AppKit
import SwiftUI
@testable import CapcomdDesk
#endif

/// Home's state in the window's model (design/desktop/Home.dc.html): when it shows, + and ⌘0, the composer's focus, the
/// model menu, Start, and its Running cards.
final class HomeModelTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  final class Starter: RunStarting, @unchecked Sendable {
    var outcomes: [Result<String, Error>] = []
    var choices: [RunChoice] = []
    func start(goal: String, choice: RunChoice, idempotencyKey: String) async throws -> String { choices.append(choice); return try outcomes.removeFirst().get() }
  }
  final class Decider: ApprovalDeciding, @unchecked Sendable {
    var calls: [(String, ApprovalDecision)] = []
    func decide(approvalId: String, decision: ApprovalDecision, idempotencyKey: String) async throws -> DecideOutcome {
      calls.append((approvalId, decision))
      return .decided(DecisionRecord(approvalId: approvalId, status: decision == .approve ? "approved" : "denied", decidedBy: .init(clientId: "menubar", principal: "me")))
    }
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
  /// The app's model (Home at open, nothing opens by itself) on a store with one running project.
  @MainActor func app(starter: Starter? = nil, decider: Decider? = nil) -> (DeskModel, CapcomdStore) {
    let s = CapcomdStore(decider: decider, starter: starter)
    project(s, "run-a", goal: "Migrate matchkey", at: 1_000)
    let m = DeskModel(store: s, autoOpens: false)
    m.chooseFolder = { nil }
    return (m, s)
  }

  @MainActor func testTheWindowOpensOnHomeWithNoProjectFocused() {
    let (m, s) = app()
    XCTAssertTrue(m.homeShown)
    XCTAssertNil(m.openProjectId)
    XCTAssertEqual(m.newProject?.focusSerial, 0)                // shown, not focused: + focuses
    XCTAssertEqual(m.home.runs.map(\.runId), ["run-a"])
    // Another project starting doesn't take the window away from Home.
    project(s, "run-b", goal: "Fix proration", at: 2_000)
    XCTAssertTrue(m.homeShown); XCTAssertNil(m.openProjectId)
    XCTAssertEqual(m.home.runs.map(\.runId), ["run-b", "run-a"])
    XCTAssertFalse(m.returnApproves)                            // Return belongs to Home's own focus
  }

  @MainActor func testFocusingADeckOrACardLeavesHomeAndHomeAndCommandZeroComeBack() throws {
    let (m, s) = app()
    project(s, "run-b", goal: "Fix proration", at: 2_000)
    m.openCard(try XCTUnwrap(m.home.runs.first { $0.runId == "run-a" }).id)   // a click on a Running card
    XCTAssertFalse(m.homeShown)
    XCTAssertEqual(m.openRunId, "run-a")
    m.toggleHome()                                              // Home (⌘0): the reel stays open under it
    XCTAssertTrue(m.homeShown); XCTAssertEqual(m.openRunId, "run-a")
    XCTAssertEqual(m.newProject?.focusSerial, 0)
    m.toggleHome()                                              // pressed again: back to the project
    XCTAssertFalse(m.homeShown); XCTAssertEqual(m.openRunId, "run-a")
    m.toggleHome()
    m.goToProject(1)                                            // ⌘2: a deck
    XCTAssertFalse(m.homeShown); XCTAssertEqual(m.openRunId, "run-b")
    // Folding the last open project leaves Home.
    m.foldShortcut()
    XCTAssertNil(m.openProjectId); XCTAssertTrue(m.homeShown)
    // With nothing open, ⌘0, ⌘W and Esc keep Home: it is the window's screen then.
    m.toggleHome(); m.foldShortcut(); m.newProjectEscape()
    XCTAssertTrue(m.homeShown)
  }

  /// Home opens with nothing focused; a key typed there starts the goal and hands the keyboard to the goal field.
  @MainActor func testTypingOnHomeStartsTheGoal() {
    let (m, _) = app()
    let np = m.newProject!
    XCTAssertEqual(np.focusSerial, 0)
    m.toggleModelMenu()
    m.typeIntoComposer("A")
    XCTAssertEqual(np.form.goal, "A")
    XCTAssertEqual(np.focusSerial, 1)
    XCTAssertFalse(np.modelMenuOpen)
    m.typeIntoComposer("dd")                                     // keys that arrive before the field has the keyboard
    XCTAssertEqual(np.form.goal, "Add")
    XCTAssertTrue(np.form.smiling)
  }

  /// A window that counts as key without the test process becoming the active app (activating it would take the
  /// keyboard from whoever is at the Mac). SwiftUI applies focus changes only in the active app, so the handoff to the
  /// goal field here is the AppKit path HomeComposer takes when SwiftUI did not move it.
  final class KeyWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var isKeyWindow: Bool { true }
  }

  /// The real window, hosted off screen: Home opens with no text field holding the keyboard (Home's own focus has it,
  /// so no blue ring); a letter typed then lands in the goal and the goal field takes over; + gives it to the goal too.
  @MainActor func testTheWindowOpensWithNothingFocused() throws {
    let (m, _) = app()
    _ = NSApplication.shared
    let w = KeyWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1200, height: 800), styleMask: [.titled, .resizable], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.contentView = NSHostingView(rootView: DeskWindowContent(model: m))
    w.orderFrontRegardless()
    NotificationCenter.default.post(name: NSWindow.didBecomeKeyNotification, object: w)
    defer { w.orderOut(nil) }
    func spin(_ s: Double = 0.4) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
    func field() -> Bool { w.firstResponder is NSTextView }
    spin(0.8)
    XCTAssertTrue(m.homeShown)
    XCTAssertEqual(m.newProject?.focusSerial, 0)
    XCTAssertFalse(field(), "the goal field took the keyboard at launch: \(String(describing: w.firstResponder))")
    XCTAssertNotNil(HomeComposer.goalField(in: w.contentView), "the goal field's AppKit view isn't found")
    // A letter typed now goes to the goal.
    let key = try XCTUnwrap(NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0, windowNumber: w.windowNumber, context: nil,
                                             characters: "b", charactersIgnoringModifiers: "b", isARepeat: false, keyCode: 11))
    w.sendEvent(key)
    spin()
    XCTAssertEqual(m.newProject?.form.goal, "b")
    XCTAssertTrue(field(), "typing on Home didn't hand the keyboard to the goal field: \(String(describing: w.firstResponder))")
    // Leave the field, then + : the goal field takes it again.
    w.makeFirstResponder(nil)
    spin()
    XCTAssertFalse(field())
    m.openNewProject()
    spin()
    XCTAssertTrue(field(), "+ didn't focus the goal field: \(String(describing: w.firstResponder))")
  }

  @MainActor func testPlusIsHomeWithTheComposerFocused() {
    let (m, _) = app()
    m.openCard(m.home.runs[0].id)
    m.openNewProject()                                          // + or ⇧⌘N from the reel
    XCTAssertTrue(m.homeShown)
    XCTAssertEqual(m.newProject?.focusSerial, 1)
    m.openNewProject()                                          // again on Home: the focus goes back to the goal
    XCTAssertEqual(m.newProject?.focusSerial, 2)
    XCTAssertTrue(m.homeShown)                                  // + never closes Home (it isn't a toggle any more)
    m.togglePalette(query: "home")
    XCTAssertEqual(m.paletteShown.first?.action, .home)
  }

  @MainActor func testTheModelMenuOpensClosesAndItsPickReachesTheRun() async throws {
    let st = Starter(); st.outcomes = [.success("run-new")]
    let (m, s) = app(starter: st)
    s.capabilities = [Capability.runsOptions, Capability.runsOptionsModels]
    s.runOptions = RunOptions(drivers: [
      DriverInfo(provider: "claude", label: "Claude Code", model: "claude-opus-5-5", isDefault: true, efforts: ["low", "high"],
                 models: [ModelInfo(id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable"), ModelInfo(id: "claude-haiku-5-5", name: "Haiku 5.5", note: "Fastest")]),
      DriverInfo(provider: "codex", label: "Codex", available: false, reason: "Not logged in to Codex (run capcomd auth login codex)", efforts: ["low"],
                 models: [ModelInfo(id: "gpt-5.6", name: "GPT-5.6", note: "Codex")]),
    ], sandboxes: [SandboxInfo(name: "boxd", label: "Cloud", isDefault: true)])
    let np = try XCTUnwrap(m.newProject)
    m.toggleModelMenu(); XCTAssertTrue(np.modelMenuOpen)
    m.newProjectEscape(); XCTAssertFalse(np.modelMenuOpen)      // Esc closes the menu first
    XCTAssertTrue(m.homeShown)
    m.toggleModelMenu()
    let menu = s.modelMenu
    let codex = try XCTUnwrap(menu.sections[1].options.first)
    m.pickModel(codex)                                          // disabled: nothing happens
    XCTAssertTrue(np.modelMenuOpen)
    XCTAssertEqual(menu.sections[1].reason, "Not logged in to Codex (run capcomd auth login codex)")
    let before = np.revision
    m.pickEffort("high")                                        // the Effort control keeps the menu open
    XCTAssertTrue(np.modelMenuOpen); XCTAssertGreaterThan(np.revision, before)
    m.pickModel(try XCTUnwrap(menu.sections[0].options.first { $0.model == "claude-haiku-5-5" }))
    XCTAssertFalse(np.modelMenuOpen)
    XCTAssertEqual(s.modelMenu.chip, "Haiku 5.5")
    m.typeGoal("Backfill addriva_id")
    await m.startNewProject()
    XCTAssertEqual(st.choices.first?.model, "claude-haiku-5-5")
    XCTAssertEqual(st.choices.first?.driver, "claude")
    XCTAssertEqual(st.choices.first?.effort, "high")
    // Started: Home waits for the run's planner, then the reel opens on it.
    XCTAssertTrue(m.homeShown)
    project(s, "run-new", goal: "Backfill addriva_id", at: 5_000)
    XCTAssertFalse(m.homeShown)
    XCTAssertEqual(m.openRunId, "run-new")
    XCTAssertEqual(m.focusedAgent, "run-new-pl")
    // Home again: a fresh composer (the started goal isn't kept).
    m.toggleHome()
    XCTAssertEqual(m.newProject?.form.goal, "")
  }

  @MainActor func testAnAskingCardsButtonsGoToTheApprovalPath() async throws {
    let d = Decider()
    let (m, s) = app(decider: d)
    ev(s, "run-a", "approval.requested", "run-a-pl", ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge?"),
                                                       "requestedBy": .object(["agentId": .string("run-a-pl"), "runId": .string("run-a")]),
                                                       "subject": .object(["target": .string("main"), "filesTotal": .number(3), "added": .number(73), "removed": .number(5), "files": .array([])])])
    let card = try XCTUnwrap(m.home.runs.first)
    XCTAssertEqual(card.ask?.approvalId, "apr-1")
    XCTAssertEqual(card.ask?.evidence, "3 files, +73 −5")
    m.decide("apr-1", .approve)                                 // Approve ↩ (the menu bar card's path)
    var n = 0
    while d.calls.isEmpty && n < 200 { n += 1; try await Task.sleep(for: .milliseconds(5)) }
    XCTAssertEqual(d.calls.map(\.0), ["apr-1"])
    XCTAssertEqual(d.calls.first?.1, .approve)
    XCTAssertTrue(m.homeShown)                                  // deciding doesn't leave Home
  }

  /// The bench and the older tests: with nothing open the first project opens, and Home shows only when there is none.
  @MainActor func testTheBenchsModelStillOpensAProjectAndShowsHomeWithNone() {
    let s = CapcomdStore()
    let empty = DeskModel(store: s)
    XCTAssertTrue(empty.homeShown)
    project(s, "run-a", goal: "Migrate matchkey", at: 1_000)
    XCTAssertEqual(empty.openRunId, "run-a")
    XCTAssertFalse(empty.homeShown)
  }
  #endif
}
