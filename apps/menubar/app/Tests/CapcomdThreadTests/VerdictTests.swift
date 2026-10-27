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
}
