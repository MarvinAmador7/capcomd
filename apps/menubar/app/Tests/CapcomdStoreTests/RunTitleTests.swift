import XCTest
@testable import CapcomdStore

/// Run titles: the port of the daemon's rules against the fixture its own tests read (tests/api/run-titles.json), and
/// the title the panel shows as a run goes on (goal-derived, then the merged work's subject; the daemon's when better).
@MainActor
final class RunTitleTests: XCTestCase {
  static let fixture = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../../tests/api/run-titles.json").standardizedFileURL

  struct Fixture: Decodable {
    struct Short: Decodable { var input: String; var title: String? }
    struct RunCase: Decodable {
      struct In: Decodable { var label: String?; var goal: String?; var agents: [A] }
      struct A: Decodable { var parent: String?; var task: String?; var result: JSONValue? }
      var name: String; var run: In; var title: String?; var titleSource: String?
    }
    var short: [Short]; var runs: [RunCase]
  }
  func fixture() throws -> Fixture { try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: Self.fixture)) }

  func testShortTitlesMatchTheDaemon() throws {
    let f = try fixture()
    XCTAssertGreaterThan(f.short.count, 10)
    for c in f.short { XCTAssertEqual(RunTitle.short(c.input), c.title, "\(c.input.prefix(48))") }
  }

  func testRunTitlesMatchTheDaemon() throws {
    for c in try fixture().runs {
      let agents = c.run.agents.enumerated().map { i, a in
        var ag = Agent(id: "a\(i)", runId: "r", parent: a.parent, depth: a.parent == nil ? 0 : 1, profile: nil, status: .done,
                       task: a.task.map(UntrustedText.init), key: nil, repo: nil, spawnedAtMs: i)
        ag.read(result: a.result)
        return ag
      }
      let t = RunTitle.of(label: c.run.label, goal: c.run.goal, agents: agents)
      XCTAssertEqual(t?.text, c.title, c.name)
      XCTAssertEqual(t.map { "\($0.source)" }, c.titleSource, c.name)
    }
  }

  // MARK: in the store
  var seq = 0
  func ev(_ s: CapcomdStore, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:]) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: "run-t", seq: seq, entity: agent ?? "run-t", type: type, epochMs: 1_000_000 + seq * 1000,
                              projectId: "prj-t", runId: "run-t", agentId: agent, data: d)), scope: "run-t")
  }
  let goal = "Add a multiply(a, b) function to src/math.ts and a bun test for it"

  func testGoalDerivedWhileRunningThenTheMergedSubjectOnceItLands() {
    let s = CapcomdStore()
    ev(s, "run.created", nil, ["goal": .string(goal), "label": .string(goal)])
    ev(s, "agent.spawned", "pl", ["profile": .string("planner"), "task": .string(goal)])
    ev(s, "agent.spawned", "wk", ["profile": .string("worker"), "parent": .string("pl"), "task": .string("Add multiply(a, b) to src/math.ts with a test\n\nExport it.")])
    XCTAssertEqual(s.projects[0].title, "Add a multiply(a, b) function to src/math.ts")
    XCTAssertNil(s.projects[0].goalLine, "the title is cut from the goal: the goal line would repeat it")
    XCTAssertEqual(s.projects[0].fullTitle, goal)

    ev(s, "merge.succeeded", "wk", ["id": .string("mrg-1"), "target": .string("main")])
    XCTAssertEqual(s.runs["run-t"]?.titled, RunTitle(text: "Add multiply(a, b) to src/math.ts with a test", source: .merge))
    XCTAssertEqual(s.projects[0].title, "Add multiply(a, b) to src/math.ts with a test")
    XCTAssertEqual(s.projects[0].goalLine, goal, "a title in other words leaves the goal as the second line")
  }

  func testTheDaemonsTitleWinsUnlessTheAppKnowsABetterOne() {
    func snapshot(title: String?, source: String?, merged: Bool) -> CapcomdStore {
      let s = CapcomdStore()
      s.receive(.reset(snapshotSeq: 3, reason: "compacted"), scope: "daemon")
      s.receive(.snapshotRun(SnapshotRun(id: "run-s", projectId: "p", label: nil, state: "idle", goal: goal, title: title, titleSource: source, createdAt: nil)), scope: "daemon")
      if merged {
        s.receive(StreamFrame.parse(event: "snapshot.agents", data: """
        {"agents":[{"id":"wk","runId":"run-s","parent":null,"depth":0,"profile":"worker","status":"done","task":"Ship multiply","result":{"merge":{"state":"merged","target":"main"}}}]}
        """), scope: "daemon")
      }
      s.receive(.snapshotEnd(snapshotSeq: 3), scope: "daemon")
      return s
    }
    // An older daemon: the app titles the run from its goal.
    XCTAssertEqual(snapshot(title: nil, source: nil, merged: false).projects[0].title, "Add a multiply(a, b) function to src/math.ts")
    // The daemon named it from a merge the app hasn't seen: its title wins over the app's goal-derived one.
    XCTAssertEqual(snapshot(title: "Add multiply to math", source: "merge", merged: false).projects[0].title, "Add multiply to math")
    // A source this app doesn't know yet ranks first.
    XCTAssertEqual(snapshot(title: "Multiply, with tests", source: "agent", merged: true).projects[0].title, "Multiply, with tests")
    // The daemon's goal title is older than the merge the app knows of.
    XCTAssertEqual(snapshot(title: "Add a multiply(a, b) function to src/math.ts", source: "goal", merged: true).projects[0].title, "Ship multiply")
  }

  func testTheTooltipHasTheLineATitleWasCutFrom() {
    let s = CapcomdStore()
    let label = "Onboarding remembers the last folder the user picked across launches of the app, even after a crash"
    ev(s, "run.created", nil, ["goal": .string("Rework onboarding"), "label": .string(label)])
    XCTAssertEqual(s.projects[0].title, "Onboarding remembers the last folder the user…")
    XCTAssertEqual(s.projects[0].fullTitle, label)
    XCTAssertEqual(s.projects[0].goalLine, "Rework onboarding")
  }

  func testARunWithNothingToNameItIsUntitledNotItsId() {
    let s = CapcomdStore()
    ev(s, "run.created", nil, [:])
    XCTAssertEqual(s.projects[0].title, "Untitled run")
    XCTAssertNil(s.projects[0].goalLine)
  }

  func testTheOutcomeMarkFollowsHowItEnded() {
    func end(_ more: (CapcomdStore) -> Void) -> CardOutcome.End? {
      let s = CapcomdStore()
      ev(s, "run.created", nil, ["goal": .string(goal)])
      ev(s, "agent.spawned", "wk", ["profile": .string("worker")])
      more(s)
      return s.outcome(s.projects[0])?.end
    }
    XCTAssertEqual(end { s in self.ev(s, "agent.done", "wk", ["result": .object([:])]); self.ev(s, "run.completed", nil) }, .done)
    XCTAssertEqual(end { s in self.ev(s, "agent.done", "wk", ["result": .object(["merge": .object(["state": .string("merged"), "target": .string("main")])])]); self.ev(s, "run.completed", nil) }, .merged)
    XCTAssertEqual(end { s in self.ev(s, "agent.done", "wk", ["result": .object(["merge": .object(["state": .string("denied")])])]); self.ev(s, "run.completed", nil) }, .mergeDenied)
    XCTAssertEqual(end { s in self.ev(s, "agent.done", "wk", ["result": .object(["merge": .object(["state": .string("failed")])])]); self.ev(s, "run.completed", nil) }, .mergeFailed)
    XCTAssertEqual(end { s in self.ev(s, "agent.failed", "wk", ["result": .object(["error": .string("boom")])]); self.ev(s, "run.failed", nil) }, .failed)
    XCTAssertEqual(end { s in self.ev(s, "agent.cancelled", "wk"); self.ev(s, "run.cancelled", nil) }, .stopped)
  }
}
