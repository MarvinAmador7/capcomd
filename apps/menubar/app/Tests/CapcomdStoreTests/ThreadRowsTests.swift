import XCTest
@testable import CapcomdStore
import CapcomdThread

/// Thread v2: the entries as the thread draws them. Calls in a row fold into one line, thinking in a row merges,
/// anything else stays itself and ends a run; nothing is dropped or moved.
final class ThreadRowsTests: XCTestCase {
  func item(_ id: String, kind: String = "tool", status: String = "done", at: String = "2026-10-27T00:00:00Z", durationMs: Int? = nil,
            error: [String: Any]? = nil, diff: Bool = false) throws -> CapcomdThread.Item {
    var o: [String: Any] = ["id": id, "rev": 1, "seq": 1, "order": 0, "agentId": "agt-p", "kind": kind, "status": status, "at": at,
                            "text": "x", "blocks": [], "format": "blocks/1", "redacted": kind == "thinking"]
    if let durationMs { o["durationMs"] = durationMs }
    if kind == "tool" {
      var t: [String: Any] = ["callId": "c-\(id)", "name": "Bash", "kind": "run", "summary": "Run ls", "isError": error != nil, "files": []]
      if diff { t["diff"] = ["path": "a.ts", "added": 1, "removed": 0, "lines": [["op": "+", "text": "x"]]] }
      o["tool"] = t
    }
    if let error { o["error"] = error }
    return try JSONDecoder().decode(CapcomdThread.Item.self, from: JSONSerialization.data(withJSONObject: o))
  }
  /// Entries as `threadEntries` makes them: each item with the item after it.
  func entries(_ xs: [Any]) -> [ThreadEntry] {
    var out: [ThreadEntry] = []
    let items = xs.compactMap { $0 as? CapcomdThread.Item }
    for x in xs {
      if let i = x as? CapcomdThread.Item {
        let n = items.firstIndex { $0.id == i.id }!
        out.append(.item(i, next: n + 1 < items.count ? items[n + 1] : nil))
      } else if let e = x as? ThreadItem { out.append(.event(e)) }
    }
    return out
  }
  func shape(_ rows: [ThreadRow]) -> [String] {
    rows.map {
      switch $0 {
      case .entry(.item(let i, _)): i.id
      case .entry(.event(let e)): "event:\(e.id)"
      case .tools(let r): "tools(\(r.items.map(\.id).joined(separator: ",")))"
      case .thinking(let r): "think(\(r.items.map(\.id).joined(separator: ",")))"
      }
    }
  }

  func testCallsInARowFoldIntoOneLine() throws {
    let say = try item("s", kind: "say")
    let rows = ThreadRow.rows(entries([say, try item("a"), try item("b"), try item("c"), try item("s2", kind: "say")]))
    XCTAssertEqual(shape(rows), ["s", "tools(a,b,c)", "s2"])
    XCTAssertEqual(rows[1].id, "tools:a")   // keyed by its first call: it keeps its place as it grows
  }

  func testOneCallStaysItself() throws {
    XCTAssertEqual(shape(ThreadRow.rows(entries([try item("s", kind: "say"), try item("a"), try item("s2", kind: "say")]))), ["s", "a", "s2"])
  }

  func testARunningCallStaysOutUntilItFinishes() throws {
    let done = [try item("a"), try item("b")]
    XCTAssertEqual(shape(ThreadRow.rows(entries(done + [try item("c", status: "open")]))), ["tools(a,b)", "c"])
    XCTAssertEqual(shape(ThreadRow.rows(entries(done + [try item("c")]))), ["tools(a,b,c)"])
  }

  func testRefusedAndFailedCallsFoldInAndAreCounted() throws {
    let refused: [String: Any] = ["message": "requires approval", "code": "refused"]
    let rows = ThreadRow.rows(entries([try item("a", error: refused), try item("b"), try item("c", error: ["message": "1 fail"])]))
    guard case .tools(let run)? = rows.first, rows.count == 1 else { return XCTFail("\(shape(rows))") }
    XCTAssertEqual(run.notes, ["1 not allowed", "1 failed"])
  }

  func testAnEditWithADiffKeepsItsCard() throws {
    XCTAssertEqual(shape(ThreadRow.rows(entries([try item("a"), try item("b"), try item("e", diff: true), try item("c"), try item("d")]))),
                   ["tools(a,b)", "e", "tools(c,d)"])
  }

  func testThinkingInARowMergesAndEndsACallRun() throws {
    let t1 = try item("t1", kind: "thinking", durationMs: 1_000), t2 = try item("t2", kind: "thinking", durationMs: 3_000)
    let rows = ThreadRow.rows(entries([try item("a"), try item("b"), t1, t2, try item("c"), try item("d")]))
    XCTAssertEqual(shape(rows), ["tools(a,b)", "think(t1,t2)", "tools(c,d)"])
    guard case .thinking(let run) = rows[1] else { return XCTFail() }
    XCTAssertEqual(run.label, "Thinking · 4s")
    XCTAssertEqual(run.next?.id, "c")
  }

  func testAThoughtsTimeRunsToTheNextItem() throws {
    let t = try item("t", kind: "thinking", at: "2026-10-27T00:00:00Z")
    let rows = ThreadRow.rows(entries([t, try item("s", kind: "say", at: "2026-10-27T00:00:08Z")]))
    guard case .thinking(let run) = rows[0] else { return XCTFail() }
    XCTAssertEqual(run.seconds, 8)
  }

  func testAMessageBetweenEndsTheRun() throws {
    let steer = ThreadItem(id: "msg:operator:agt-p:1", seq: 2, epochMs: 0, kind: .message(from: "operator", to: "agt-p", text: UntrustedText("stop"), attachment: nil))
    XCTAssertEqual(shape(ThreadRow.rows(entries([try item("a"), try item("b"), steer, try item("c"), try item("d")]))),
                   ["tools(a,b)", "event:msg:operator:agt-p:1", "tools(c,d)"])
  }

  func testNothingIsDroppedOrMoved() throws {
    let xs: [Any] = [try item("s", kind: "say"), try item("t", kind: "thinking"), try item("a"), try item("b", status: "open"),
                     try item("h", kind: "handoff"), try item("c"), try item("d"), try item("e", kind: "error")]
    let rows = ThreadRow.rows(entries(xs))
    let flat = rows.flatMap { r -> [String] in
      switch r {
      case .entry(.item(let i, _)): [i.id]; case .entry(.event(let e)): [e.id]
      case .tools(let run): run.items.map(\.id); case .thinking(let run): run.items.map(\.id)
      }
    }
    XCTAssertEqual(flat, ["s", "t", "a", "b", "h", "c", "d", "e"])
    XCTAssertEqual(rows.count, 7)   // 8 entries, c and d folded
  }

  /// A long thread of calls draws far fewer rows (and so fewer row bodies).
  func testALongRunOfCallsIsOneRow() throws {
    let calls = try (0..<200).map { try item("c\($0)") }
    XCTAssertEqual(ThreadRow.rows(entries(calls)).count, 1)
  }
}
