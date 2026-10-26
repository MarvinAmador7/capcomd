import XCTest
@testable import CapcomdStore

@MainActor
final class TreeTests: XCTestCase {
  /// planner ─┬ worker (matchkey)
  ///          ├ lead (ids/v1) ─┬ worker d3ce ── worker
  ///          │                └ worker 4423
  ///          └ critic (addriva)
  func store() -> CapcomdStore {
    let s = CapcomdStore()
    var seq = 0
    func spawn(_ id: String, parent: String?, _ profile: String, folder: String?, key: String? = nil) {
      seq += 1
      var d: [String: JSONValue] = ["profile": .string(profile)]
      if let parent { d["parent"] = .string(parent) }
      if let key { d["key"] = .string(key) }
      if let folder { d["workspace"] = .object(["repo": .string("/src/x"), "path": .null, "label": .string(folder)]) }
      s.receive(.event(Envelope(id: "e\(seq)", scope: "run-t", seq: seq, entity: id, type: "agent.spawned", epochMs: seq, projectId: "prj-t", runId: "run-t", agentId: id, data: d)), scope: "run-t")
    }
    spawn("pl", parent: nil, "planner", folder: nil)
    spawn("w1", parent: "pl", "worker", folder: "matchkey")
    spawn("ld", parent: "pl", "lead", folder: "ids/v1")
    spawn("w2", parent: "ld", "worker", folder: "ids/v1", key: "task-d3ce")
    spawn("w4", parent: "w2", "worker", folder: "ids/v1")
    spawn("w3", parent: "ld", "worker", folder: "ids/v1", key: "task-4423")
    spawn("cr", parent: "pl", "critic", folder: "addriva")
    return s
  }

  func testOutlineGuidesMatchTreeCardV3() {
    let tree = store().agentTree(runId: "run-t")
    let lines = tree.outline(collapsed: [])
    XCTAssertEqual(lines.map(\.node.id), ["pl", "w1", "ld", "w2", "w4", "w3", "cr"])
    XCTAssertEqual(lines.map(\.guides), [
      [],                      // planner: no guide column
      [.tee],                  // worker: more siblings follow
      [.tee],                  // lead
      [.line, .tee],           // worker d3ce under lead, planner's line carries on
      [.line, .line, .elbow],  // its only child
      [.line, .elbow],         // worker 4423: lead's last child
      [.elbow],                // critic: planner's last child
    ])
    // Under worker 4423 (its approval): planner's line carries on, lead's column has ended.
    XCTAssertEqual(lines[5].below, [.line, .blank])
    // Under lead (its activity line): its own column runs on down to its children.
    XCTAssertEqual(lines[2].below, [.line, .line])
    XCTAssertEqual(tree.folders, ["matchkey", "ids/v1", "addriva"])
    XCTAssertEqual(lines.map(\.node.suffix), [nil, nil, nil, "d3ce", nil, "4423", nil])   // repeated siblings: short task id
    XCTAssertEqual(lines[3].node.accessibilityLabel, "worker d3ce, ids/v1, pending, level 3")
  }

  func testCollapsedHidesChildrenButKeepsTheRow() {
    let tree = store().agentTree(runId: "run-t")
    let lines = tree.outline(collapsed: ["ld"])
    XCTAssertEqual(lines.map(\.node.id), ["pl", "w1", "ld", "cr"])
    XCTAssertTrue(lines[2].collapsed)
    XCTAssertEqual(lines[2].below, [.line])   // no children column under a closed row
  }

  func testWorkspaceFromSnapshotAgents() throws {
    let s = CapcomdStore()
    let frames: [(String, String)] = [
      ("stream.reset", #"{"snapshotSeq":2,"reason":"compacted"}"#),
      ("snapshot.run", #"{"run":{"id":"run-w","projectId":"prj-w","label":null,"state":"running","goal":"x"}}"#),
      ("snapshot.agents", #"{"agents":[{"id":"agt-1","runId":"run-w","parent":null,"depth":0,"profile":"planner","status":"running","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"workspace":{"repo":"https://github.com/acme/matchkey.git","path":null,"label":"matchkey"}}]}"#),
      ("snapshot.approvals", #"{"approvals":[]}"#),
      ("snapshot.end", #"{"snapshotSeq":2}"#),
    ]
    for (e, d) in frames { s.receive(StreamFrame.parse(event: e, data: d), scope: "daemon") }
    XCTAssertEqual(try XCTUnwrap(s.agentTree(runId: "run-w").first).repo, "matchkey")
    XCTAssertEqual(s.projects.first?.scopes, ["matchkey"])
  }
}
