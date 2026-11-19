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
