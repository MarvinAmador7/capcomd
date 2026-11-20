import XCTest
@testable import CapcomdThread

/// Thread v2's presentation: tool names and what they were about, call status, call groups, merged thinking, the seal.
final class RowsTests: XCTestCase {
  static func item(_ id: String, kind: String = "tool", status: String = "done", at: String = "2026-10-27T00:00:00Z", durationMs: Int? = nil,
                   name: String = "Bash", toolKind: String = "run", summary: String = "Run bun test", isError: Bool = false,
                   error: [String: Any]? = nil, redacted: Bool = false, text: String = "x") throws -> Item {
    var o: [String: Any] = ["id": id, "rev": 1, "seq": 1, "order": 0, "agentId": "agt-p", "kind": kind, "status": status, "at": at,
                            "text": text, "blocks": [], "format": "blocks/1", "redacted": redacted]
    if let durationMs { o["durationMs"] = durationMs }
    if kind == "tool" { o["tool"] = ["callId": "c-\(id)", "name": name, "kind": toolKind, "summary": summary, "isError": isError, "files": []] }
    if let error { o["error"] = error }
    return try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: o))
  }

  func testToolNamesAreShortAndMono() throws {
    func name(_ n: String) throws -> String { try Self.item("t", name: n).tool!.displayName }
    XCTAssertEqual(try name("Bash"), "Bash")
    XCTAssertEqual(try name("mcp__capcomd__capcomd_spawn"), "spawn")
    XCTAssertEqual(try name("capcomd.capcomd_verify"), "verify")
    XCTAssertEqual(try name("mcp__browser__screenshot"), "screenshot")
    XCTAssertEqual(try name("command_execution"), "shell")
    XCTAssertEqual(try name("file_change"), "edit")
    XCTAssertEqual(try name("read_file"), "read_file")
  }

  func testTheDetailDropsTheVerbTheNameSays() throws {
    func detail(_ name: String, _ s: String) throws -> String { try Self.item("t", name: name, summary: s).tool!.detail }
    XCTAssertEqual(try detail("Bash", "Run sed -n 78,92p CONTENT.md"), "sed -n 78,92p CONTENT.md")
    XCTAssertEqual(try detail("Read", "Read site/CONTENT.md"), "site/CONTENT.md")
    XCTAssertEqual(try detail("Glob", "Find **/*.png in apps"), "**/*.png in apps")
    XCTAssertEqual(try detail("Grep", "Search the code for snapshot|fixture in DESKBENCH.md"), "snapshot|fixture in DESKBENCH.md")
    XCTAssertEqual(try detail("mcp__capcomd__capcomd_spawn", "Spawn a worker"), "Spawn a worker")   // capcomd's own keep their phrase
    XCTAssertEqual(try detail("mcp__browser__screenshot", "browser: screenshot"), "browser")
    XCTAssertEqual(try detail("Bash", "Run "), "Run ")   // nothing after the verb: the summary as it is
  }

  func testStatusSaysRunningDoneFailedOrNotAllowed() throws {
    XCTAssertEqual(try Self.item("a", status: "open").toolStatus, .running)
    XCTAssertEqual(try Self.item("b").toolStatus, .done)
    XCTAssertEqual(try Self.item("c", isError: true, error: ["message": "1 fail"]).toolStatus, .failed)
    let refused = try Self.item("d", isError: true, error: ["message": "requires approval", "code": "refused"])
    XCTAssertEqual(refused.toolStatus, .notAllowed)
    XCTAssertTrue(refused.refused)
    XCTAssertFalse(try Self.item("e", isError: true, error: ["message": "x", "code": "unfinished"]).refused)
  }

  func testAGroupSaysItsRefusalsAndFailuresInWords() throws {
    let run = ToolRun([
      try Self.item("a", durationMs: 100),
      try Self.item("b", isError: true, error: ["message": "no", "code": "refused"]),
      try Self.item("c", isError: true, error: ["message": "no", "code": "refused"]),
      try Self.item("d", durationMs: 4_800, isError: true, error: ["message": "1 fail"]),
    ])
    XCTAssertEqual(run.title, "Used 4 tools")
    XCTAssertEqual(run.notes, ["2 not allowed", "1 failed"])
    XCTAssertEqual(run.duration, "4.9s")   // the calls' own times added up
    XCTAssertEqual(run.stacked.map(\.id), ["a", "b", "c"])
    XCTAssertEqual(run.spoken, "Used 4 tools, 2 not allowed, 1 failed, 4.9s")
  }

  func testAQuietGroupHasNoNotes() throws {
    let run = ToolRun([try Self.item("a"), try Self.item("b")])
    XCTAssertEqual(run.notes, [])
    XCTAssertNil(run.duration)
  }

  func testThinkingMergesIntoOneLineWithTheTotal() throws {
    let a = try Self.item("t1", kind: "thinking", durationMs: 1_000, redacted: true, text: "")
    let b = try Self.item("t2", kind: "thinking", durationMs: 3_000, redacted: true, text: "")
    let c = try Self.item("t3", kind: "thinking", at: "2026-10-27T00:00:10Z", redacted: true, text: "")
    let next = try Self.item("n", at: "2026-10-27T00:00:11Z")
    let run = ThinkingRun([a, b, c], next: next)
    XCTAssertEqual(run.seconds, 5)   // 1 + 3 + the gap to the next item (1)
    XCTAssertEqual(run.label, "Thinking · 5s")
    XCTAssertEqual(run.spoken, "Thought for 5 seconds")
    XCTAssertTrue(run.hidden)   // "hidden by the CLI" goes inside, not on the line
    XCTAssertFalse(run.label.contains("hidden"))
  }

  func testThinkingWhileItThinks() throws {
    let open = try Self.item("t", kind: "thinking", status: "open", text: "")
    let run = ThinkingRun([open], next: nil)
    XCTAssertTrue(run.open)
    XCTAssertEqual(run.label, "Thinking")
    XCTAssertNil(run.seconds)
  }

  func testTheSealsWords() {
    XCTAssertEqual(Verdict(passed: true, reasons: []).title, "Passed review")
    XCTAssertEqual(Verdict(passed: false, reasons: ["no alt text"]).title, "Didn't pass review")
  }
}
