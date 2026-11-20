import XCTest
@testable import CapcomdThread

final class VerdictTests: XCTestCase {
  func item(_ text: String, kind: String = "say") throws -> Item {
    let o: [String: Any] = ["id": "itm-1", "rev": 1, "seq": 1, "order": 0, "agentId": "agt-r", "kind": kind, "open": false,
                            "at": "2026-10-27T00:00:00Z", "status": "done", "text": text, "blocks": [], "format": "blocks/1", "redacted": false]
    return try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: o))
  }
  func itemWithBlocks(_ blocks: [[String: Any]]) throws -> Item {
    let o: [String: Any] = ["id": "itm-2", "rev": 1, "seq": 2, "order": 1, "agentId": "agt-r", "kind": "say", "open": false, "status": "done",
                            "at": "2026-10-27T00:00:00Z", "text": "…", "blocks": blocks, "format": "blocks/1", "redacted": false]
    return try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: o))
  }

  func testAVerdictAfterProseKeepsTheProse() throws {
    let tail = try itemWithBlocks([
      ["t": "paragraph", "children": [["t": "text", "text": "The change meets both criteria."]]],
      ["t": "paragraph", "children": [["t": "text", "text": #"{"passed": true, "reasons": ["bun test passes"]}"#]]],
    ]).verdictTail
    XCTAssertEqual(tail?.prose.count, 1)
    XCTAssertEqual(tail?.verdict, Verdict(passed: true, reasons: ["bun test passes"]))
  }

  func testAVerdictInACodeBlock() throws {
    let tail = try itemWithBlocks([["t": "code", "lang": "json", "text": #"{"passed": false, "reasons": ["no test"]}"#]]).verdictTail
    XCTAssertEqual(tail?.prose.count, 0)
    XCTAssertEqual(tail?.verdict.passed, false)
  }

  func testProseEndingInOtherJSONIsProse() throws {
    XCTAssertNil(try itemWithBlocks([["t": "paragraph", "children": [["t": "text", "text": #"{"ok": true}"#]]]]).verdictTail)
  }

  func testAReviewersJSONIsAVerdict() throws {
    let v = try item(#"{"passed": true, "reasons": ["src/math.ts exports negate", "bun test passes: 3 pass, 0 fail"]}"#).verdictTail?.verdict
    XCTAssertEqual(v, Verdict(passed: true, reasons: ["src/math.ts exports negate", "bun test passes: 3 pass, 0 fail"]))
  }

  func testAFencedFailingVerdict() throws {
    let v = try item("```json\n{\"passed\": false, \"reasons\": [\"no test for negate\"]}\n```", kind: "result").verdictTail?.verdict
    XCTAssertEqual(v, Verdict(passed: false, reasons: ["no test for negate"]))
  }

  func testAnythingElseIsProse() throws {
    XCTAssertNil(try item("The change looks good.").verdictTail?.verdict)
    XCTAssertNil(try item(#"{"reasons": ["no passed field"]}"#).verdictTail?.verdict)
    XCTAssertNil(try item(#"{"passed": "yes"}"#).verdictTail?.verdict)
    XCTAssertNil(try item(#"Verdict: {"passed": true}"#).verdictTail?.verdict)
    XCTAssertNil(try item(#"{"passed": true}"#, kind: "tool").verdictTail?.verdict)
  }

  /// review-verdict@1: findings (lines, or {text, severity, file, line}) are the verdict's reasons, with their place.
  func testAReviewVerdictV1MessageHasFindings() throws {
    let v = try item(#"{"passed": false, "findings": [{"severity": "blocker", "file": "src/b.txt", "line": 1, "text": "writes the wrong content"}, "no test", {"text": "x", "severity": "loud", "line": 4}, {"text": ""}]}"#).verdictTail?.verdict
    XCTAssertEqual(v?.passed, false)
    XCTAssertEqual(v?.findings, [Finding(text: "writes the wrong content", severity: .blocker, file: "src/b.txt", line: 1), Finding(text: "no test"), Finding(text: "x")])
    XCTAssertEqual(v?.reasons, ["src/b.txt:1: writes the wrong content", "no test", "x"])
  }

  /// A typed hand-back (handback@1, `child.handback`) and a reviewer's findings (`child.verdict.findings`) on a handoff;
  /// a status or a result this client doesn't know never reads as passed.
  func testAHandoffCarriesATypedHandbackAndFindings() throws {
    let o: [String: Any] = ["id": "itm-t", "rev": 1, "seq": 4, "order": 3, "agentId": "agt-p", "kind": "handoff", "status": "done",
                            "at": "2026-10-27T00:00:00Z", "text": "Done: added the parser.", "blocks": [], "format": "blocks/1", "redacted": false,
                            "child": ["agentId": "agt-c", "status": "done", "handback": [
                              "status": "done", "outcome": "added the parser\u{202E}", "changed": [["path": "src/parse.ts", "what": "new"], ["path": " "]],
                              "checked": [["check": "bun test", "result": "passed", "note": "12 pass"], ["check": "the CLI", "result": "not run", "note": NSNull()], ["check": "lint", "result": "maybe"]],
                              "risks": ["dates before 1970"], "decide": ["keep the old parser?"]] as [String: Any],
                              "verdict": ["passed": false, "reasons": ["src/b.txt:1: wrong"], "findings": [["text": "wrong", "severity": "blocker", "file": "src/b.txt", "line": 1]]] as [String: Any]] as [String: Any],
                            "internal": false]
    let item = try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: o))
    let hb = try XCTUnwrap(item.typedHandback)
    XCTAssertEqual(hb.status, .done); XCTAssertEqual(hb.statusWord, "Done"); XCTAssertEqual(hb.outcome, "added the parser")
    XCTAssertEqual(hb.changed, [Handback.Change(path: "src/parse.ts", what: "new")])
    XCTAssertEqual(hb.checked.map(\.result), [.passed, .notRun, .notRun])
    XCTAssertEqual(hb.checked.first?.note, "12 pass")
    XCTAssertEqual(hb.risks, ["dates before 1970"]); XCTAssertEqual(hb.decide, ["keep the old parser?"])
    XCTAssertEqual(item.child?.verdict?.findings, [Finding(text: "wrong", severity: .blocker, file: "src/b.txt", line: 1)])
    XCTAssertFalse(item.internal)
    // A hand-back this client can't read is none (its blocks still say it); no `internal` is not bookkeeping.
    var bad = o; bad["child"] = ["agentId": "agt-c", "status": "done", "handback": ["status": "done"]]; bad.removeValue(forKey: "internal")
    let plain = try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: bad))
    XCTAssertNil(plain.typedHandback); XCTAssertFalse(plain.internal)
    var odd = o; odd["child"] = ["agentId": "agt-c", "status": "done", "handback": ["status": "someday", "outcome": "x"]]
    XCTAssertEqual(try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: odd)).typedHandback?.status, .done)
  }

  func testEscapedBidiCharactersAreCleaned() throws {
    let v = try item(#"{"passed": true, "reasons": ["ok\u202Egnp.exe"]}"#).verdictTail?.verdict
    XCTAssertEqual(v?.reasons, ["okgnp.exe"])
  }

  /// A reviewer's hand-back (the daemon's `child.verdict`): the verdict, and the blocks after the paragraph that says it.
  func testAHandoffCarriesTheReviewersVerdict() throws {
    let o: [String: Any] = ["id": "itm-h", "rev": 1, "seq": 3, "order": 2, "agentId": "agt-p", "kind": "handoff", "status": "done",
                            "at": "2026-10-27T00:00:00Z", "text": "**Passed review**\n\n- bun test passes", "format": "blocks/1", "redacted": false,
                            "blocks": [["t": "paragraph", "children": [["t": "strong", "children": [["t": "text", "text": "Passed review"]]]]],
                                       ["t": "list", "ordered": false, "start": NSNull(), "items": [["checked": NSNull(), "blocks": [["t": "paragraph", "children": [["t": "text", "text": "bun test passes"]]]]]]]],
                            "child": ["agentId": "agt-r", "status": "done", "verdict": ["passed": true, "reasons": ["bun test passes", "  ", "ok\u{202E}"]]]]
    let item = try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: o))
    XCTAssertEqual(item.child?.verdict, Verdict(passed: true, reasons: ["bun test passes", "ok"]))
    XCTAssertEqual(item.handoffVerdict?.rest.count, 1, "the paragraph that says the verdict is the card's seal instead")
    // An older daemon's hand-back (no verdict), or a verdict this client can't read: no verdict, the blocks as they are.
    var older = o; older["child"] = ["agentId": "agt-c", "status": "done"]
    XCTAssertNil(try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: older)).handoffVerdict)
    var odd = o; odd["child"] = ["agentId": "agt-r", "status": "done", "verdict": "yes"]
    let oddItem = try JSONDecoder().decode(Item.self, from: JSONSerialization.data(withJSONObject: odd))
    XCTAssertNil(oddItem.child?.verdict); XCTAssertEqual(oddItem.child?.agentId, "agt-r")
  }

  /// An older daemon's Claude bookkeeping lines are not shown; plain-word lines are.
  func testSystemBookkeepingLines() throws {
    XCTAssertTrue(try item("System: thinking_tokens", kind: "other").isSystemBookkeeping)
    XCTAssertTrue(try item("System: permission_denied", kind: "other").isSystemBookkeeping)
    XCTAssertFalse(try item("Compacted the conversation", kind: "other").isSystemBookkeeping)
    XCTAssertFalse(try item("System: thinking_tokens", kind: "say").isSystemBookkeeping)
    XCTAssertFalse(try item("System: Something Else", kind: "other").isSystemBookkeeping)
  }
}
