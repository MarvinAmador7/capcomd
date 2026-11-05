import XCTest
@testable import CapcomdStore

/// Home (design/desktop/Home.dc.html): the Running cards' view model (the few words, the ask line, the order) and the
/// composer's model menu (its options, disabled reasons, and the pick reaching the run request).
@MainActor
final class HomeTests: XCTestCase {
  var seq = 0
  func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)",
                              runId: run, agentId: agent, data: d)), scope: run)
  }
  func activity(_ s: CapcomdStore, _ run: String, _ agent: String, _ text: String, at: Int) {
    ev(s, run, "agent.activity_changed", agent, ["activity": .object(["text": .string(text), "kind": .string("edit")])], at: at)
  }
  /// A project: planner ─ worker, both running, the worker doing `doing`.
  func project(_ s: CapcomdStore, _ run: String, goal: String, sandbox: String? = nil, at: Int, doing: String) {
    var created: [String: JSONValue] = ["goal": .string(goal)]
    if let sandbox { created["sandbox"] = .string(sandbox) }
    ev(s, run, "run.created", nil, created, at: at)
    ev(s, run, "agent.spawned", "\(run)-pl", ["profile": .string("planner")], at: at + 1)
    ev(s, run, "agent.spawned", "\(run)-wk", ["profile": .string("worker"), "parent": .string("\(run)-pl")], at: at + 2)
    ev(s, run, "agent.started", "\(run)-pl", at: at + 3); ev(s, run, "agent.started", "\(run)-wk", at: at + 4)
    activity(s, run, "\(run)-wk", doing, at: at + 5)
  }

  // MARK: the few words

  func testThePhraseIsTheCardSentenceShortenedNeverInvented() {
    let who = ActiveCard.Member(runId: "r", agentId: "a", name: "worker d3ce")
    func p(_ rest: String, who w: ActiveCard.Member? = who) -> String { HomeRun.phrase(ActiveCard.Sentence(who: w, rest: rest)) }
    XCTAssertEqual(p(" is editing 3 files"), "editing 3 files")                         // who and "is" go
    XCTAssertEqual(p(" is writing shards, 118 of 256"), "writing shards, 118 of 256")
    XCTAssertEqual(p(": Read 4 files"), "read 4 files")                                 // a line that isn't progressive
    XCTAssertEqual(p(": README.md updated"), "README.md updated")                       // a name keeps its capitals
    XCTAssertEqual(p(" is working"), "working")
    XCTAssertEqual(p(" is queued"), "queued")
    XCTAssertEqual(p("Starting", who: nil), "starting")
    XCTAssertEqual(p("Wrapping up", who: nil), "wrapping up")
    // Cut at the first clause, then after six words.
    XCTAssertEqual(p(" is running 212 billing tests. Then the linter"), "running 212 billing tests")
    XCTAssertEqual(p(" is updating the proration maths for annual plans and refunds"), "updating the proration maths for annual…")
    // Every word shown is the sentence's own.
    let long = " is reading the whole billing module before changing anything"
    let shown = p(long).replacingOccurrences(of: "…", with: "").split(separator: " ")
    XCTAssertTrue(shown.allSatisfy { long.contains($0) })
  }

  func testTheEvidenceIsTheFilesWithTheirLines() {
    let three = PendingApproval(id: "a", runId: "r", agentId: "w", kind: "merge", question: UntrustedText("Merge?"), branchLine: "b → main",
                                diff: ApprovalDiff(files: [], total: 3, added: 73, removed: 5))
    XCTAssertEqual(HomeRun.evidence(three), "3 files, +73 −5")
    let one = PendingApproval(id: "a", runId: "r", agentId: "w", kind: "merge", question: UntrustedText("Merge?"), branchLine: nil,
                              diff: ApprovalDiff(files: [], total: 1, added: 2, removed: 0))
    XCTAssertEqual(HomeRun.evidence(one), "1 file, +2 −0")
    // No files read: the branch line; nothing at all: none.
    XCTAssertEqual(HomeRun.evidence(PendingApproval(id: "a", runId: "r", agentId: "w", kind: "merge", question: UntrustedText("?"), branchLine: "x → main")), "x → main")
    XCTAssertNil(HomeRun.evidence(PendingApproval(id: "a", runId: "r", agentId: "w", kind: "egress", question: UntrustedText("?"), branchLine: nil)))
  }

  // MARK: the cards

  func testOneCardPerRunningRunInTheStoresLiveOrderWithItsPlaceCrewAndClock() {
    let s = CapcomdStore()
    project(s, "run-m", goal: "Migrate matchkey to v3.2", sandbox: "boxd", at: 1_000_000, doing: "Writing shards, 118 of 256")
    project(s, "run-p", goal: "Fix proration for annual plans", sandbox: "docker", at: 2_000_000, doing: "Updating the proration maths")
    let runs = s.homeRuns(nowMs: 3_000_000)
    XCTAssertEqual(runs.map(\.id), s.projects.filter(\.isActive).map(\.id))             // the store's own order
    XCTAssertEqual(runs.map(\.runId), ["run-p", "run-m"])                               // the latest event first
    XCTAssertEqual(runs.map(\.title), ["Fix proration for annual plans", "Migrate matchkey to v3.2"])
    XCTAssertEqual(runs.map(\.phrase), ["updating the proration maths", "writing shards, 118 of 256"])
    XCTAssertEqual(runs.map(\.sandbox), ["docker", "boxd"])
    XCTAssertEqual(runs[0].agentIds, ["run-p-pl", "run-p-wk"])
    XCTAssertEqual(runs[1].startedAtMs, 1_000_000)
    XCTAssertNil(runs[0].ask)
    // Live: new activity in the older run moves it up.
    activity(s, "run-m", "run-m-wk", "Writing shards, 131 of 256", at: 2_500_000)
    XCTAssertEqual(s.homeRuns(nowMs: 3_000_000).map(\.runId), ["run-m", "run-p"])
    XCTAssertEqual(s.homeRuns(nowMs: 3_000_000)[0].phrase, "writing shards, 131 of 256")
    // A finished run leaves Running.
    ev(s, "run-p", "agent.done", "run-p-wk", at: 2_600_000); ev(s, "run-p", "agent.done", "run-p-pl", at: 2_600_001)
    ev(s, "run-p", "run.completed", nil, at: 2_600_002)
    XCTAssertEqual(s.homeRuns(nowMs: 3_000_000).map(\.runId), ["run-m"])
  }

  func testACardThatAsksCarriesTheQuestionAndTheEvidence() {
    let s = CapcomdStore()
    project(s, "run-m", goal: "Migrate matchkey to v3.2", sandbox: "boxd", at: 1_000_000, doing: "Writing shards, 118 of 256")
    ev(s, "run-m", "approval.requested", "run-m-wk", ["approvalId": .string("apr-1"), "kind": .string("merge"), "question": .string("Merge this agent's work into main?"),
                                                    "requestedBy": .object(["agentId": .string("run-m-wk"), "runId": .string("run-m")]),
                                                    "subject": .object(["target": .string("main"), "ref": .string("capcomd/run-m/wk"), "filesTotal": .number(3), "added": .number(73), "removed": .number(5),
                                                                        "files": .array([.object(["path": .string("src/a.ts"), "added": .number(73), "removed": .number(5)])])])], at: 1_100_000)
    let r = s.homeRuns(nowMs: 1_200_000)[0]
    let ask = try! XCTUnwrap(r.ask)
    XCTAssertEqual(ask.approvalId, "apr-1")
    XCTAssertEqual(ask.question, s.activeCard(s.projects[0], nowMs: 1_200_000).body.askQuestion)   // the menu bar card's words
    XCTAssertEqual(ask.question, "Merge work from worker into main?")
    XCTAssertEqual(ask.evidence, "3 files, +73 −5")
    XCTAssertFalse(ask.busy)
    XCTAssertEqual(r.phrase, "writing shards, 118 of 256")   // the first line keeps what the crew is doing
  }

  // MARK: the model menu

  /// Claude logged in for Cloud only; Codex everywhere; the daemon lists models.
  func menuStore() -> CapcomdStore {
    let s = CapcomdStore()
    s.capabilities = [Capability.runsOptions, Capability.runsOptionsSandbox, Capability.runsOptionsModels]
    s.runOptions = RunOptions(
      drivers: [DriverInfo(provider: "claude", label: "Claude Code", model: "claude-opus-5-5", isDefault: true, efforts: ["low", "medium", "high", "xhigh", "max"],
                           sandboxes: ["docker": DriverAvailability(available: false, reason: "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)"),
                                       "boxd": DriverAvailability(available: true)],
                           models: [ModelInfo(id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable"), ModelInfo(id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Balanced"),
                                    ModelInfo(id: "claude-haiku-5-5", name: "Haiku 5.5", note: "Fastest")]),
                DriverInfo(provider: "codex", label: "Codex", model: nil, efforts: ["minimal", "low", "medium", "high"], effort: "medium",
                           models: [ModelInfo(id: "gpt-5.6", name: "GPT-5.6", note: "Codex")])],
      sandboxes: [SandboxInfo(name: "docker", label: "Local"), SandboxInfo(name: "boxd", label: "Cloud", isDefault: true)])
    return s
  }

  func testTheMenuListsEachHarnessesModelsThenEffort() {
    let s = menuStore()
    let m = s.modelMenu
    XCTAssertEqual(m.sections.map(\.title), ["Claude Code", "Codex"])
    XCTAssertEqual(m.sections[0].options.map(\.name), ["Opus 5.5", "Sonnet 5.5", "Haiku 5.5"])
    XCTAssertEqual(m.sections[0].options.map(\.note), ["Most capable", "Balanced", "Fastest"])
    XCTAssertEqual(m.sections[1].options.map(\.name), ["GPT-5.6"])
    XCTAssertEqual(m.sections.flatMap(\.options).filter(\.checked).map(\.model), ["claude-opus-5-5"])   // the profile's model
    XCTAssertTrue(m.sections.allSatisfy { $0.reason == nil })
    XCTAssertEqual(m.chip, "Opus 5.5")
    XCTAssertTrue(m.offersAuto); XCTAssertNil(m.effort)
    XCTAssertEqual(m.efforts, ["low", "medium", "high", "xhigh", "max"])
    XCTAssertEqual(m.bars, 3)                                   // Auto: all three bars
    XCTAssertEqual(m.label, "Planner: Claude Code, Opus 5.5, auto effort")
    s.pickEffort("low")
    XCTAssertEqual(s.modelMenu.bars, 1)
    XCTAssertEqual(s.modelMenu.label, "Planner: Claude Code, Opus 5.5, low effort")
    s.pickEffort("medium"); XCTAssertEqual(s.modelMenu.bars, 2)
  }

  func testAHarnessThatCantRunHereIsListedDisabledWithTheReason() {
    let s = menuStore()
    s.setDefaultPlace("docker")                                 // Local: Claude Code isn't logged in there
    let m = s.modelMenu
    XCTAssertEqual(m.sections[0].reason, "Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)")
    XCTAssertTrue(m.sections[0].options.allSatisfy { !$0.enabled })
    XCTAssertTrue(m.sections[1].options.allSatisfy(\.enabled))
    XCTAssertNil(m.sections[1].reason)
    // The run goes to Codex, which can: its effort has a fixed default, so no Auto.
    XCTAssertEqual(m.chip, "Codex")                             // Codex's profile names no model (the CLI's default): its label
    XCTAssertFalse(m.offersAuto); XCTAssertEqual(m.effort, "medium")
    // Nothing can run: still a menu, every section saying why, the button dimmed.
    s.runOptions.drivers[1].sandboxes = ["docker": DriverAvailability(available: false, reason: "No agent environment for Local yet")]
    let none = s.modelMenu
    XCTAssertFalse(none.enabled)
    XCTAssertEqual(none.sections.map(\.reason), ["Not logged in to Claude Code for Local (run `capcomd auth login claude --sandbox docker`)", "No agent environment for Local yet"])
    XCTAssertEqual(none.chip, "Opus 5.5")                       // the default driver's model, dimmed
    XCTAssertTrue(none.label.hasPrefix("Planner unavailable"))
    XCTAssertNil(none.bars)
  }

  func testThePickReachesTheRunRequest() throws {
    let s = menuStore()
    s.pickModel("claude-sonnet-5-5", driver: "claude")
    XCTAssertEqual(s.modelMenu.chip, "Sonnet 5.5")
    XCTAssertEqual(s.modelMenu.sections.flatMap(\.options).filter(\.checked).map(\.model), ["claude-sonnet-5-5"])
    var c = s.newRunChoice(goalSetup: nil)
    XCTAssertEqual([c.driver, c.model, c.sandbox], ["claude", "claude-sonnet-5-5", "boxd"])
    let body = try JSONSerialization.jsonObject(with: StartWire.body(goal: "go", choice: c)) as! [String: Any]
    XCTAssertEqual(body["model"] as? String, "claude-sonnet-5-5")
    XCTAssertEqual(body["driver"] as? String, "claude")
    // Codex's model: the driver switches with it.
    s.pickModel("gpt-5.6", driver: "codex")
    c = s.newRunChoice(goalSetup: nil)
    XCTAssertEqual([c.driver, c.model], ["codex", "gpt-5.6"])
    XCTAssertEqual(s.modelMenu.chip, "GPT-5.6")
    // Back to Claude: its own pick is remembered per driver.
    s.pickDriver("claude")
    XCTAssertEqual(s.newRunChoice(goalSetup: nil).model, "claude-sonnet-5-5")
    // A model the daemon no longer lists is dropped: the run gets the profile's.
    s.runOptions.drivers[0].models = [ModelInfo(id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable")]
    XCTAssertNil(s.newRunChoice(goalSetup: nil).model)
    XCTAssertEqual(s.modelMenu.chip, "Opus 5.5")
    // No model chosen: nothing is sent.
    let plain = try JSONSerialization.jsonObject(with: StartWire.body(goal: "go", choice: RunChoice(driver: "claude"))) as! [String: Any]
    XCTAssertNil(plain["model"])
  }

  func testAnOlderDaemonOffersTheDriversThemselvesAndSendsNoModel() {
    let s = menuStore()
    s.capabilities.remove(Capability.runsOptionsModels)
    s.pickModel("claude-sonnet-5-5", driver: "claude")
    let m = s.modelMenu
    XCTAssertEqual(m.sections.map { $0.options.map(\.name) }, [["Opus 5.5"], ["Codex"]])   // one row per driver, on its profile's model
    XCTAssertEqual(m.sections.flatMap(\.options).map(\.model), [nil, nil])
    XCTAssertEqual(m.chip, "Opus 5.5")
    XCTAssertNil(s.newRunChoice(goalSetup: nil).model)
  }

  func testModelsDecodeFromRunOptions() throws {
    let json = #"{"drivers":[{"provider":"claude","label":"Claude Code","model":"claude-opus-5-5","models":[{"id":"claude-opus-5-5","name":"Opus 5.5","note":"Most capable"}],"efforts":["low"],"effort":null,"available":true,"reason":null,"default":true,"sandboxes":{}}],"sandboxes":[]}"#
    let o = try JSONDecoder().decode(RunOptions.self, from: Data(json.utf8))
    XCTAssertEqual(o.drivers.first?.models, [ModelInfo(id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable")])
    let old = #"{"drivers":[{"provider":"claude","label":"Claude Code","model":null,"efforts":[],"effort":null,"available":true,"reason":null,"default":true}],"sandboxes":[]}"#
    XCTAssertNil(try JSONDecoder().decode(RunOptions.self, from: Data(old.utf8)).drivers.first?.models)
  }

  /// Keys typed while Home holds the keyboard: text starts the goal; everything with its own meaning keeps it.
  func testTypingOnHomeIsTextOnly() {
    func t(_ c: String, cmd: Bool = false, ctrl: Bool = false, opt: Bool = false) -> String? { HomeTyping.text(c, command: cmd, control: ctrl, option: opt) }
    XCTAssertEqual(t("h"), "h"); XCTAssertEqual(t("H"), "H"); XCTAssertEqual(t(" "), " "); XCTAssertEqual(t("é"), "é"); XCTAssertEqual(t("7"), "7")
    XCTAssertNil(t("\r")); XCTAssertNil(t("\t")); XCTAssertNil(t("\u{1B}")); XCTAssertNil(t("\u{7F}"))     // Return, Tab, Esc, Delete
    XCTAssertNil(t("\u{F700}")); XCTAssertNil(t("\u{F704}"))                                             // ↑, F1
    XCTAssertNil(t("k", cmd: true)); XCTAssertNil(t("a", ctrl: true)); XCTAssertNil(t("π", opt: true))
    XCTAssertNil(t(""))
  }

  func testModelNames() {
    XCTAssertEqual(ModelMenu.displayName(model: "claude-opus-5-5"), "Opus 5.5")
    XCTAssertEqual(ModelMenu.displayName(model: "claude-sonnet-4-5-20250929"), "Sonnet 4.5")
    XCTAssertNil(ModelMenu.displayName(model: "gpt-5-codex"))
    XCTAssertEqual(ModelMenu.bars(nil), 3); XCTAssertEqual(ModelMenu.bars("minimal"), 1); XCTAssertEqual(ModelMenu.bars("xhigh"), 3)
  }
}

private extension ActiveCard.Body {
  var askQuestion: String? { if case .ask(let a) = self { return a.question }; return nil }
}
