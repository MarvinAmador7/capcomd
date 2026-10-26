import XCTest
@testable import CapcomdThread

/// The daemon's golden sessions (packages/agent-thread/fixtures/golden): every item revision an adapter emits for a
/// recorded CLI session. They are ItemDrafts (no seq, order, agentId: the daemon's storage sets those), so each update
/// gets them here the way the thread store would: seq per write, order per new id.
final class ThreadTests: XCTestCase {
  static let golden = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../../packages/agent-thread/fixtures/golden").standardizedFileURL

  func goldenItems(_ name: String) throws -> [Item] {
    let data = try Data(contentsOf: Self.golden.appendingPathComponent("\(name).items.json"))
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    var order: [String: Int] = [:]
    let stored: [[String: Any]] = try XCTUnwrap(root["updates"] as? [[String: Any]]).enumerated().map { seq, u in
      var u = u; let id = u["id"] as! String
      u["seq"] = seq + 1; u["order"] = order[id] ?? order.count; order[id] = u["order"] as? Int; u["agentId"] = "agt-golden"
      return u
    }
    return try JSONDecoder().decode([Item].self, from: JSONSerialization.data(withJSONObject: stored))
  }

  func testEveryGoldenSessionDecodes() throws {
    let names = try FileManager.default.contentsOfDirectory(atPath: Self.golden.path).filter { $0.hasSuffix(".items.json") }
    XCTAssertEqual(names.count, 4)
    for n in names {
      let items = try goldenItems(String(n.dropLast(".items.json".count)))
      XCTAssertFalse(items.isEmpty, n)
      XCTAssertTrue(items.allSatisfy { $0.format == threadFormat }, n)
    }
  }

  func testClaudeSessionShapes() throws {
    var book = Book(); book.apply(try goldenItems("claude-2.1.303"))
    let kinds = Set(book.items.map(\.kind))
    XCTAssertTrue(kinds.isSuperset(of: ["thinking", "say", "tool", "plan"]))
    // An open tool call and its result are one item: the done rev replaced the open one.
    XCTAssertEqual(Set(book.items.map(\.id)).count, book.items.count)
    XCTAssertTrue(book.items.filter { $0.kind == "tool" }.allSatisfy { !$0.open && $0.tool != nil })
    XCTAssertEqual(book.items.map(\.order), book.items.map(\.order).sorted())
  }

  func testEveryBlockAndLinkTargetIsRepresented() throws {
    var blocks: Set<String> = [], links: Set<Link.Target> = [], media: Set<String> = []
    func inl(_ xs: [Inline]) {
      for x in xs {
        switch x {
        case .link(let l): links.insert(l.target)
        case .strong(let k), .em(let k), .strike(let k): inl(k)
        default: break
        }
      }
    }
    func walk(_ bs: [Block]) {
      for b in bs {
        switch b {
        case .paragraph(let k): blocks.insert("paragraph"); inl(k)
        case .heading(_, let k): blocks.insert("heading"); inl(k)
        case .list(_, _, let items): blocks.insert("list"); items.forEach { walk($0.blocks) }
        case .code: blocks.insert("code")
        case .table(let t): blocks.insert("table"); t.header.forEach(inl); t.rows.forEach { $0.forEach(inl) }
        case .quote(let q): blocks.insert("quote"); walk(q)
        case .rule: blocks.insert("rule")
        case .media(let m):
          blocks.insert("media")
          switch m.source { case .attachment: media.insert("attachment"); case .workspace: media.insert("workspace"); case .remote: media.insert("remote"); case .unknown: XCTFail() }
        case .open: blocks.insert("open")
        case .unknown: XCTFail("golden blocks are all known")
        }
      }
    }
    for n in ["claude-2.1.303", "codex-0.163.0", "claude-2.1.303-usage-limit", "codex-0.163.0-turn-failed"] {
      for i in try goldenItems(n) { walk(i.blocks); i.tool?.files.forEach { links.insert($0.target) } }
    }
    XCTAssertEqual(blocks, ["paragraph", "heading", "list", "code", "table", "quote", "rule", "media"])
    XCTAssertEqual(links, [.web, .artifact, .file, .agent, .run, .none])
    XCTAssertEqual(media, ["attachment", "workspace", "remote"])
  }

  func testFailedSessionsCarryErrors() throws {
    for n in ["claude-2.1.303-usage-limit", "codex-0.163.0-turn-failed"] {
      XCTAssertTrue(try goldenItems(n).contains { $0.kind == "error" && $0.error?.message.isEmpty == false }, n)
    }
  }

  // MARK: Book

  func item(_ id: String, rev: Int = 1, seq: Int, order: Int, kind: String = "say", status: String = "done", text: String = "x") -> Item {
    let json = #"{"id":"\#(id)","rev":\#(rev),"seq":\#(seq),"order":\#(order),"agentId":"a","kind":"\#(kind)","status":"\#(status)","at":"2026-10-26T12:00:00.000Z","durationMs":null,"text":"\#(text)","blocks":[],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null}"#
    return try! JSONDecoder().decode(Item.self, from: Data(json.utf8))
  }

  func testBookKeepsHighestRevAndOrder() {
    var b = Book()
    XCTAssertTrue(b.apply(item("i2", seq: 2, order: 1)))
    XCTAssertTrue(b.apply(item("i1", seq: 1, order: 0, status: "open")))
    XCTAssertEqual(b.items.map(\.id), ["i1", "i2"])
    XCTAssertTrue(b.apply(item("i1", rev: 2, seq: 3, order: 0)))
    XCTAssertFalse(b.items[0].open)
    XCTAssertFalse(b.apply(item("i1", rev: 1, seq: 1, order: 0, status: "open")))   // a stale rev from the route
    XCTAssertFalse(b.apply(item("i1", rev: 2, seq: 3, order: 0)))                   // the same rev from a live frame
    XCTAssertFalse(b.items[0].open)
    XCTAssertEqual(b.cursor, 3)
    b.apply(item("i0", seq: 4, order: 2)); b.apply(item("i3", seq: 5, order: 1))   // order ties break by id
    XCTAssertEqual(b.items.map(\.id), ["i1", "i2", "i3", "i0"])
    XCTAssertTrue(b.apply(item("i3", rev: 2, seq: 6, order: 1, text: "y")))
    XCTAssertEqual(b.items[2].text, "y")
  }

  func testUnknownFormatKindAndTypesFallBackToText() throws {
    let json = #"{"id":"i","rev":1,"seq":1,"order":0,"agentId":"a","kind":"vote","status":"done","at":"x","durationMs":null,"text":"hi‮there\u0007","blocks":[{"t":"poll","text":"p"},{"t":"paragraph","children":[{"t":"sparkle","text":"s"},{"t":"link","text":"go","href":"javascript:alert(1)","target":"web","host":null,"id":null,"path":null,"mismatch":false}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null,"future":1}"#
    let i = try JSONDecoder().decode(Item.self, from: Data(json.utf8))
    XCTAssertEqual(i.text, "hithere")   // bidi override and BEL dropped
    XCTAssertEqual(i.blocks.first, .unknown("p"))
    guard case .paragraph(let k) = i.blocks.last, case .link(let l) = k.last else { return XCTFail() }
    XCTAssertEqual(k.first, .unknown("s"))
    XCTAssertEqual(l.action, .none)   // "web" but not http(s): plain text
    XCTAssertNil(l.destination)
    let v2 = try JSONDecoder().decode(Item.self, from: Data(json.replacingOccurrences(of: "blocks/1", with: "blocks/2").utf8))
    XCTAssertTrue(v2.blocks.isEmpty)   // a format we don't know: render `text`
  }

  // MARK: Presentation

  func testLinkActions() throws {
    func link(_ fields: [String: Any]) throws -> Link {
      var d: [String: Any] = ["t": "link", "text": "t", "href": NSNull(), "host": NSNull(), "id": NSNull(), "path": NSNull(), "mismatch": false]
      d.merge(fields) { $1 }
      return try JSONDecoder().decode(Link.self, from: JSONSerialization.data(withJSONObject: d))
    }
    let web = try link(["target": "web", "href": "https://docs.example.com/a?b=1", "host": "docs.example.com"])
    XCTAssertEqual(web.action, .web(URL(string: "https://docs.example.com/a?b=1")!))
    XCTAssertEqual(web.destination, "docs.example.com")
    var spoof = web; spoof.mismatch = true
    XCTAssertEqual(spoof.destination, "https://docs.example.com/a?b=1")   // the text points elsewhere: show the real URL
    XCTAssertEqual(try link(["target": "agent", "id": "agt-1"]).action, .agent("agt-1"))
    XCTAssertEqual(try link(["target": "file", "path": "src/a.ts"]).action, .file("src/a.ts"))
    XCTAssertEqual(try link(["target": "teleport"]).action, .none)
    XCTAssertEqual(try link(["target": "web", "href": "ftp://x.y/z"]).action, .none)
    XCTAssertEqual(try link(["target": "web", "href": "https:///nohost"]).action, .none)
  }

  func testThinkingDuration() {
    var t = item("t", seq: 1, order: 0, kind: "thinking"); t.at = "2026-10-26T12:00:00.000Z"
    var n = item("n", seq: 2, order: 1); n.at = "2026-10-26T12:00:07.600Z"
    XCTAssertEqual(t.thinkingSeconds(next: n), 8)
    XCTAssertNil(t.thinkingSeconds(next: nil))
    t.durationMs = 2400; XCTAssertEqual(t.thinkingSeconds(next: nil), 2)
    XCTAssertEqual(callDuration(ms: 400), "0.4s"); XCTAssertEqual(callDuration(ms: 12_300), "12s"); XCTAssertEqual(callDuration(ms: 185_000), "3m 5s")
  }

  func testHighlightReproducesTextAndMarksTokens() {
    let sql = "SELECT shard, count(*) AS rows\nFROM read_parquet('r2://x/*.parquet')\nWHERE id IS NULL   -- must be 0\nLIMIT 5;"
    let t = Highlight.tokens(sql, lang: "sql")
    XCTAssertEqual(t.map(\.text).joined(), sql)
    XCTAssertTrue(t.contains(.init(text: "SELECT", kind: .keyword)))
    XCTAssertTrue(t.contains(.init(text: "'r2://x/*.parquet'", kind: .string)))
    XCTAssertTrue(t.contains(.init(text: "-- must be 0", kind: .comment)))
    XCTAssertTrue(t.contains(.init(text: "5", kind: .number)))
    XCTAssertFalse(t.contains { $0.text == "shard" && $0.kind != .plain })
    XCTAssertEqual(Highlight.tokens("x = 1", lang: "brainfuck"), [.init(text: "x = 1", kind: .plain)])
    let ts = "const a = \"q\\\"x\" // c\nlet b2 = 3"
    XCTAssertEqual(Highlight.tokens(ts, lang: "ts").map(\.text).joined(), ts)
  }
}
