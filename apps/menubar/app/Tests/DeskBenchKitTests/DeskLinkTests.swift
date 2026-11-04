import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// The window and the menu bar panel are two views of one store: a panel row opens the window at its run and agent,
/// and what the window focuses is the store's selection, which the panel marks.
final class DeskLinkTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  var seq = 0
  @MainActor func ev(_ s: CapcomdStore, _ run: String, _ project: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:]) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: 1_000 + seq, projectId: project,
                              runId: run, agentId: agent, data: d)), scope: run)
  }

  /// Two projects, each a planner with workers.
  @MainActor func store() -> CapcomdStore {
    let s = CapcomdStore()
    for (run, project) in [("run-a", "prj-a"), ("run-b", "prj-b")] {
      ev(s, run, project, "run.created", nil, ["goal": .string("Goal \(run)")])
      ev(s, run, project, "agent.spawned", "\(run)-pl", ["profile": .string("planner")])
      for w in ["w1", "w2", "w3"] {
        ev(s, run, project, "agent.spawned", "\(run)-\(w)", ["profile": .string("worker"), "parent": .string("\(run)-pl")])
        ev(s, run, project, "agent.started", "\(run)-\(w)")
      }
    }
    return s
  }

  @MainActor func testARowOpensItsProjectAtItsAgentsColumn() {
    let s = store()
    let m = DeskModel(store: s)
    m.across = 1
    m.show(run: "run-b", agent: "run-b-w3")
    XCTAssertEqual(m.openRunId, "run-b")
    XCTAssertEqual(m.focusedAgent, "run-b-w3")
    XCTAssertTrue(m.onScreen.contains("run-b-w3"))
    m.show(run: "run-a")   // a run row: the planner's column
    XCTAssertEqual(m.openRunId, "run-a")
    XCTAssertEqual(m.focusedAgent, "run-a-pl")
  }

  @MainActor func testAnUnknownRunChangesNothing() {
    let s = store()
    let m = DeskModel(store: s)
    let before = m.openRunId
    m.show(run: "run-gone", agent: "x")
    XCTAssertEqual(m.openRunId, before)
  }

  @MainActor func testAProjectPutAwayComesBackForARow() {
    let s = store()
    let m = DeskModel(store: s)
    m.fold()
    XCTAssertNil(m.openRunId)
    m.show(run: "run-a", agent: "run-a-w1")
    XCTAssertEqual(m.openRunId, "run-a")
    XCTAssertEqual(m.focusedAgent, "run-a-w1")
  }

  /// No syncing layer: the window's focus is the store's selection, which the panel reads.
  @MainActor func testTheWindowsFocusIsTheStoresSelection() {
    let s = store()
    let m = DeskModel(store: s)
    m.show(run: "run-b", agent: "run-b-w2")
    XCTAssertEqual(s.selection, Selection(runId: "run-b", agentId: "run-b-w2"))
    m.scroll(to: "run-b-w1", animated: false)
    XCTAssertEqual(s.selection, Selection(runId: "run-b", agentId: "run-b-w1"))
    m.fold()
    XCTAssertNil(s.selection)
  }
  #endif
}
