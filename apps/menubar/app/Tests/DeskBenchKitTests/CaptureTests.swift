import XCTest
@testable import DeskBenchKit
import CapcomdStore
import CapcomdThread

/// C8 on the adapter's side: parametric fixtures (`crew@agents=24`), and captured ones: anonymisation leaks none of
/// the original text, ids or URLs and keeps the structure, and the bench loads the file as a World.
final class CaptureTests: XCTestCase {
  // MARK: parametric

  func testParametricFixturesVaryTheGenerator() throws {
    let w = try XCTUnwrap(Fixtures.make("crew@agents=24,items=100"))
    XCTAssertEqual(w.agents[w.openRunId!]?.count, 24)
    XCTAssertTrue(w.threads.values.allSatisfy { (80...120).contains($0.count) })
    XCTAssertEqual(w.spec.name, "crew@agents=24,items=100")
    XCTAssertEqual(w.runIds.first, "run-crew-1")                          // ids from the family, not the parameters
    let r = try XCTUnwrap(Fixtures.make("crew@items=40-60,projects=2,asks=0"))
    XCTAssertEqual(r.runIds.count, 2); XCTAssertTrue(r.threads.values.allSatisfy { (40...60).contains($0.count) }); XCTAssertEqual(r.asking[r.openRunId!], [])
    // A named fixture with its own numbers is the same world: parameters change only what they say.
    let a = try XCTUnwrap(Fixtures.make("crew17")), b = try XCTUnwrap(Fixtures.make("crew17@agents=17"))
    XCTAssertEqual(a.events.map(\.envelope.id), b.events.map(\.envelope.id))
    XCTAssertEqual(a.threads.mapValues { $0.map(\.text) }, b.threads.mapValues { $0.map(\.text) })
    XCTAssertNotEqual(Fixtures.make("crew@seed=3")!.threads.mapValues { $0.map(\.text) }, Fixtures.make("crew")!.threads.mapValues { $0.map(\.text) })
    // Few agents, many asks: no more asks than workers.
    XCTAssertEqual(Fixtures.make("crew@agents=2,asks=5")!.asking.values.map(\.count).max(), 1)
    for bad in ["crew@agents=0", "crew@agents=500", "crew@colour=red", "crew@items=60-40", "nope@agents=3"] {
      XCTAssertNil(Fixtures.make(bad), bad); XCTAssertNotNil(Fixtures.problem(bad), bad)
    }
    XCTAssertNil(Fixtures.problem("crew@agents=64"))
    XCTAssertEqual(Fixtures.all.first { $0.name == "crew" }?.parametric?["agents"], [1, 128])
  }

  // MARK: anonymisation

  /// Strings planted in every kind of field a daemon sends: none may survive the capture.
  static let canaries = ["Zanzibarquux", "QUOKKAPLANT", "marmosetfig", "9f3c2e71ab", "secret-acme-repo", "kgarcia", "hunter2xyz"]

  /// One run as the daemon serves it: lifecycle events (goal, task, activity, an ask), and a planner's thread made of
  /// the golden Claude session (every item shape a CLI emits) with canaries planted in its text.
  func rawRun() throws -> CapturedFixture.RawRun {
    let c = Self.canaries
    let run = "run-\(c[3])", planner = "agt-\(c[3])-pl", worker = "agt-\(c[0])"
    func ev(_ seq: Int, _ type: String, _ agent: String?, _ data: String) -> String {
      #"{"v":1,"id":"evt-\#(seq)-\#(c[3])","scope":"\#(run)","seq":\#(seq),"entity":"\#(agent ?? run)","type":"\#(type)","ts":"2026-10-30T10:00:0\#(seq).000Z","epochMs":\#(1_793_354_400_000 + seq * 1000),"projectId":"prj-\#(c[4])","runId":"\#(run)","agentId":\#(agent.map { "\"\($0)\"" } ?? "null"),"durability":"durable","text":"\#(c[1]) started","data":\#(data)}"#
    }
    let events = [
      ev(1, "run.created", nil, #"{"goal":"Fix \#(c[0]) in https://github.com/\#(c[5])/\#(c[4]) before Friday","repo":"git@github.com:\#(c[5])/\#(c[4]).git","sandbox":"fake-host"}"#),
      ev(2, "agent.spawned", planner, #"{"profile":"planner","agent":{"provider":"claude","model":"claude-opus-4-5"},"task":"Plan the \#(c[2]) migration"}"#),
      ev(3, "agent.spawned", worker, #"{"profile":"\#(c[6])","parent":"\#(planner)","key":"task-\#(c[3])","workspace":{"label":"\#(c[4])"},"agent":{"provider":"codex","model":"gpt-5-codex"}}"#),
      ev(4, "agent.activity_changed", worker, #"{"activity":{"text":"Editing \#(c[2]).ts","kind":"edit"}}"#),
      ev(5, "approval.requested", worker, #"{"approvalId":"apr-\#(c[3])","kind":"merge","question":"Merge \#(c[1])?","subject":{"ref":"fix/\#(c[5])","target":"main"},"requestedBy":{"agentId":"\#(worker)","runId":"\#(run)"}}"#),
    ].map { try! JSONDecoder().decode(JSONValue.self, from: Data($0.utf8)) }

    let url = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../../../packages/agent-thread/fixtures/golden/claude-2.1.303.items.json").standardizedFileURL
    let root = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any])
    var order: [String: Int] = [:], last: [String: [String: Any]] = [:]
    for (seq, u0) in try XCTUnwrap(root["updates"] as? [[String: Any]]).enumerated() {
      var u = u0; let id = u["id"] as! String
      u["seq"] = 100 + seq; u["order"] = order[id] ?? order.count; order[id] = u["order"] as? Int; u["agentId"] = planner
      last[id] = u
    }
    var text = String(decoding: try JSONSerialization.data(withJSONObject: last.values.sorted { ($0["seq"] as! Int) < ($1["seq"] as! Int) }), as: UTF8.self)
    // Plant canaries where the session has text, paths and ids.
    text = text.replacingOccurrences(of: "schema", with: c[2]).replacingOccurrences(of: "/home/user", with: "/Users/\(c[5])")
      .replacingOccurrences(of: "toolu_", with: "toolu_\(c[6])").replacingOccurrences(of: "golden", with: c[0].lowercased())
    var items = try JSONDecoder().decode([JSONValue].self, from: Data(text.utf8))
    // And a say item with every block shape: heading, list, code, table, quote, link, image.
    let rich = #"""
    {"id":"itm-\#(c[3])-rich","rev":1,"seq":999,"order":999,"agentId":"\#(planner)","kind":"say","status":"done","at":"2026-10-30T10:05:00.000Z","durationMs":null,
     "format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null,"text":"\#(c[1]) see https://\#(c[4]).example.org/\#(c[2])",
     "blocks":[{"t":"heading","level":2,"children":[{"t":"text","text":"About \#(c[0])"}]},
               {"t":"list","ordered":true,"start":1,"items":[{"checked":null,"blocks":[{"t":"paragraph","children":[{"t":"text","text":"Call \#(c[6])"}]}]}]},
               {"t":"code","lang":"swift","text":"let \#(c[2]) = \"\#(c[1])\"\nprint(\#(c[2]))","truncatedLines":null},
               {"t":"table","align":["left","right"],"header":[[{"t":"text","text":"\#(c[5])"}],[{"t":"text","text":"rows"}]],"rows":[[[{"t":"text","text":"\#(c[4])"}],[{"t":"text","text":"1204"}]]],"truncatedRows":null,"truncatedCols":null},
               {"t":"quote","blocks":[{"t":"paragraph","children":[{"t":"em","children":[{"t":"text","text":"\#(c[0]) said so"}]},{"t":"link","text":"https://\#(c[4]).io/x","href":"https://\#(c[4]).io/x","target":"web","host":"\#(c[4]).io","mismatch":false}]}]},
               {"t":"media","kind":"image","source":{"type":"attachment","id":"att-\#(c[3])"},"alt":"\#(c[1]) screenshot","mime":"image/png","bytes":2048,"width":640,"height":400}]}
    """#
    items.append(try JSONDecoder().decode(JSONValue.self, from: Data(rich.utf8)))
    return CapturedFixture.RawRun(runId: run, scope: run, agents: [planner, worker], events: events, threads: [planner: items, worker: []])
  }

  func testAnonymisedCaptureLeaksNothingAndKeepsTheShape() throws {
    let raw = try rawRun()
    let f = CapturedFixture.build(name: "leak-test", runs: [raw], anonymise: true)
    let out = String(decoding: try JSONEncoder().encode(f), as: UTF8.self)
    let lower = out.lowercased()
    for c in Self.canaries { XCTAssertFalse(lower.contains(c.lowercased()), "\(c) leaked") }
    XCTAssertFalse(lower.contains("github"), "a host leaked")
    XCTAssertFalse(out.contains("/Users/"), "a home path leaked")
    // Every URL left is example.com.
    let re = try NSRegularExpression(pattern: #"https?:\\?/\\?/([^/\\"]+)"#)
    for m in re.matches(in: out, range: NSRange(out.startIndex..., in: out)) {
      XCTAssertTrue((out as NSString).substring(with: m.range(at: 1)).hasPrefix("example.com"), (out as NSString).substring(with: m.range))
    }
    // No word of seven letters or more from the session's own text survives (the generated words are shorter),
    // except the machine words kept on purpose (tool names, kinds).
    let kept = Set(["claude", "planner", "fake-host", "example"] + Anonymiser.toolNames.map { $0.lowercased() })
    let source = String(decoding: try JSONEncoder().encode(raw.threads.values.flatMap { $0 }.map { $0["text"] ?? .null }), as: UTF8.self)
    let words = Set(source.split { !$0.isLetter }.map { $0.lowercased() }.filter { $0.count >= 7 && !kept.contains($0) })
    XCTAssertFalse(words.isEmpty)
    for w in words { XCTAssertFalse(lower.contains(w), "'\(w)' from the source text leaked") }

    // The shape: same items, same kinds, same block types, same text lengths; ids consistent; times kept apart.
    let r = try XCTUnwrap(f.runs.first)
    XCTAssertEqual(r.agents.count, 2)
    let pl = r.agents[0]
    XCTAssertTrue(pl.hasPrefix("agt-")); XCTAssertNotEqual(pl, raw.agents[0])
    let before = raw.threads[raw.agents[0]]!, after = try XCTUnwrap(r.threads[pl])
    XCTAssertEqual(before.count, after.count)
    for (b, a) in zip(before, after) {
      XCTAssertEqual(b["kind"], a["kind"]); XCTAssertEqual(b["status"], a["status"]); XCTAssertEqual(b["seq"], a["seq"])
      XCTAssertEqual(b["text"]?.string?.count, a["text"]?.string?.count, "\(b["id"]!)")
      XCTAssertEqual(a["agentId"]?.string, pl)
      XCTAssertEqual(types(b["blocks"]), types(a["blocks"]))
      XCTAssertEqual(b["tool"]?["name"]?.string.map { Anonymiser.toolNames.contains($0) ? $0 : "-" }, a["tool"]?["name"]?.string.map { Anonymiser.toolNames.contains($0) ? $0 : "-" })
    }
    let rich = try XCTUnwrap(after.last)
    XCTAssertEqual(rich["blocks"]?.array?[2]["text"]?.string?.split(separator: "\n").count, 2)          // code keeps its lines
    XCTAssertEqual(rich["blocks"]?.array?[2]["lang"]?.string, "swift")
    XCTAssertEqual(rich["blocks"]?.array?[3]["rows"]?.array?.first?.array?.count, 2)                   // table keeps its shape
    XCTAssertEqual(rich["blocks"]?.array?[3]["rows"]?.array?.first?.array?[1].array?.first?["text"]?.string?.count, 4)
    let worker = r.events[2]
    XCTAssertEqual(worker["data"]?["parent"]?.string, pl)                                               // the tree still links
    XCTAssertEqual(r.events[4]["data"]?["requestedBy"]?["agentId"]?.string, r.agents[1])
    XCTAssertEqual(worker["data"]?["profile"]?.string?.count, Self.canaries[6].count)                     // an unknown profile is text
    XCTAssertEqual(r.events[1]["data"]?["agent"]?["model"]?.string, "claude-opus-4-5")
    let t = r.events.compactMap { $0["epochMs"]?.int }
    XCTAssertGreaterThanOrEqual(t.first!, CapturedFixture.anonymousEpochMs); XCTAssertEqual(zip(t.dropFirst(), t).map { $0 - $1 }, [1000, 1000, 1000, 1000])
    let times = r.events.compactMap { $0["epochMs"]?.int } + r.threads.values.flatMap { $0.compactMap { epochMs(iso: $0["at"]?.string) } }
    XCTAssertEqual(times.min(), CapturedFixture.anonymousEpochMs)                                    // the earliest time is the anonymous epoch
    XCTAssertEqual(f.attachments.count, 2)                                                              // the session's image and the planted one
    let img = rich["blocks"]?.array?[5]["source"]?["id"]?.string ?? ""
    XCTAssertEqual(f.attachments[img], CapturedFixture.Attachment(kind: "image", mime: "image/png", width: 640, height: 400, bytes: 2048))
    XCTAssertTrue(img.hasPrefix("att-")); XCTAssertTrue(img.dropFirst(4).allSatisfy(\.isHexDigit))
    // Two captures with random salts share no ids.
    let g = CapturedFixture.build(name: "again", runs: [raw], anonymise: true)
    XCTAssertNotEqual(g.runs[0].agents, r.agents)
  }

  func types(_ v: JSONValue?) -> [String] {
    var out: [String] = []
    func walk(_ v: JSONValue?) {
      switch v {
      case .object(let o)?: if let t = o["t"]?.string { out.append(t) }; for k in o.keys.sorted() { walk(o[k]) }
      case .array(let a)?: a.forEach(walk)
      default: break
      }
    }
    walk(v); return out
  }

  func testTheBenchLoadsACapturedFile() async throws {
    let f = CapturedFixture.build(name: "load-test", runs: [try rawRun()], anonymise: true)
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("deskbench-capture-\(UUID().uuidString)")
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    let path = dir.appendingPathComponent("crew-real.json")
    try JSONEncoder().encode(f).write(to: path)
    let name = "file:" + path.path
    XCTAssertNil(Fixtures.problem(name))
    let w = try XCTUnwrap(Fixtures.make(name))
    XCTAssertEqual(w.runIds.count, 1); XCTAssertEqual(w.agents[w.openRunId!]?.count, 2)
    XCTAssertEqual(w.asking[w.openRunId!]?.count, 1)
    XCTAssertEqual(w.attachments.count, 2)
    let pl = w.agents[w.openRunId!]![0]
    XCTAssertEqual(w.threads[pl]?.count, f.runs[0].threads[pl]?.count)
    XCTAssertEqual(w.spec.openAgents, 2)
    // Times moved to just before now, intervals kept.
    let latest = (w.events.map(\.envelope.epochMs) + w.threads.values.flatMap { $0.map(\.atMs) }).max()!
    XCTAssertLessThan(abs(Double(latest) / 1000 + 60 - Date().timeIntervalSince1970), 30)
    // Pages serve the captured bytes; the store loads the run as it would from a daemon.
    let t = FixtureThread(w)
    let page = try await t.thread(runId: w.openRunId!, agentId: pl, after: 0, limit: 100)
    XCTAssertEqual(page.items.count, min(100, w.threads[pl]!.count))
    let world = w
    await MainActor.run {
      let s = CapcomdStore(thread: t)
      world.load(into: s)
      XCTAssertEqual(s.decks().first?.agentIds.count, 2)
      XCTAssertNotNil(s.decks().first?.askingAgentId)
    }
    XCTAssertNotNil(Fixtures.problem("file:" + dir.appendingPathComponent("missing.json").path))
    // A bare name looks in the default directory.
    XCTAssertEqual(CapturedFixture.path("file:crew-real").lastPathComponent, "crew-real.json")
    XCTAssertEqual(CapturedFixture.path("file:crew-real").deletingLastPathComponent().path, CapturedFixture.defaultDirectory.path)
  }
}
