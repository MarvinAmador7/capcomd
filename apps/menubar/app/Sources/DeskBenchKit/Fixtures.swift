import Foundation
import CapcomdStore
import CapcomdThread

// Deterministic worlds for the desktop window: projects, agent trees, threads and asks, generated from a name and a
// seed, fed straight into CapcomdStore. No daemon: a benchmark that fetches is measuring the daemon (and, as the old
// reel showed, can take it down). The same name always produces the same bytes, so two runs compare like for like.

/// A fixture as `deskbench list` describes it.
public struct FixtureSpec: Sendable, Codable, Hashable {
  public var name: String
  public var summary: String
  /// Agents in the open project (the one with the most agents), and how long its threads are.
  public var openAgents: Int
  public var itemsPerThread: ClosedRange<Int>
  public var projects: Int
  public var asks: Int
  /// The parameters `NAME@key=value,…` may set, each with the range it accepts (the manifest's `parametric`; see
  /// FixtureParams.swift). Nil for a fixture that can't be varied (a captured one).
  public var parametric: [String: [Int]]? = nil
}

/// What one fixture generates: lifecycle events per run scope, thread items per agent, media bytes by attachment id.
public struct World: Sendable {
  public var spec: FixtureSpec
  public var events: [(scope: String, envelope: Envelope)] = []
  public var threads: [String: [Item]] = [:]
  public var attachments: [String: Data] = [:]
  /// Run ids, oldest first; the first is the open project (the deck with the most agents and the ask).
  public var runIds: [String] = []
  /// Agents of each run, tree order.
  public var agents: [String: [String]] = [:]
  /// Agents with a pending ask, by run.
  public var asking: [String: [String]] = [:]
  /// The highest item seq handed out, so live replays continue after it.
  public var lastSeq = 0
  /// Items exactly as a daemon served them, by item id (a captured fixture): FixtureThread serves these bytes
  /// instead of re-encoding the decoded item, so fields this client doesn't decode still reach the page.
  public var wire: [String: Data] = [:]

  /// Feeds every event into the store, in order, and follows every run's threads so live frames are kept.
  @MainActor public func load(into s: CapcomdStore) {
    for (scope, e) in events { s.receive(.event(e), scope: scope) }
    for r in runIds { s.followThreads(runId: r, holder: "fixture:\(r)") }
  }

  /// The run's open project, as the model will pick it: the oldest with an ask, else the oldest.
  public var openRunId: String? { runIds.first { !(asking[$0] ?? []).isEmpty } ?? runIds.first }
}

/// Pages of a world's threads, as the daemon's route would serve them (100 items a page). Media bytes come from the
/// world too, so a column with an image loads it without a socket.
public final class FixtureThread: ThreadFetching, @unchecked Sendable {
  let world: World
  /// Pages served, for tests and for the "one page per column" check.
  public private(set) var pagesServed = 0
  public init(_ w: World) { world = w }
  public func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> Page {
    pagesServed += 1
    let all = (world.threads[agentId] ?? []).filter { $0.seq > after }
    let page = Array(all.prefix(limit))
    return try JSONDecoder().decode(Page.self, from: Fixtures.pageJSON(page, next: all.count > page.count ? page.last?.seq : nil, wire: world.wire))
  }
  public func attachment(runId: String, id: String) async throws -> Data {
    guard let d = world.attachments[id] else { throw DetailUnavailable.failed("no such attachment in the fixture") }
    return d
  }
  public func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data { throw DetailUnavailable.unsupported }
}

public enum Fixtures {
  /// Every fixture, smallest first.
  public static let all: [FixtureSpec] = [
    FixtureSpec(name: "solo", summary: "One project, one planner with a medium thread. The floor: anything slow here is not the reel.", openAgents: 1, itemsPerThread: 40...60, projects: 1, asks: 0),
    FixtureSpec(name: "trio", summary: "Two projects; the open one is planner → lead → worker, short threads, no ask.", openAgents: 3, itemsPerThread: 20...40, projects: 2, asks: 0),
    FixtureSpec(name: "crew17", summary: "SPEC §1's reference: 17 agents (planner, 3 leads, 12 workers, critic) with markdown, tools, diffs, thinking, a handoff and one ask; two folded projects.", openAgents: 17, itemsPerThread: 60...120, projects: 3, asks: 1),
    FixtureSpec(name: "crew17-long", summary: "crew17 with 400–600 items a thread: the memory and first-page budgets.", openAgents: 17, itemsPerThread: 400...600, projects: 3, asks: 1),
    FixtureSpec(name: "swarm64", summary: "64 agents under 8 leads, three asks, five projects: past warmCap (32), the title bar overflows.", openAgents: 64, itemsPerThread: 30...80, projects: 5, asks: 3),
    FixtureSpec(name: "search", summary: "Search ⌘K's load: 60 projects (~200 agents in all, 40 in the open one, three asks) plus the commands: 250+ searchable items, short threads.", openAgents: 40, itemsPerThread: 8...16, projects: 60, asks: 3),
    FixtureSpec(name: "crew", summary: "The family the sweeps vary: crew17's shape (3 projects, one ask, 60–120 items a thread) for `crew@agents=N,items=M` (M ± 20 % a thread; also projects, asks, seed).", openAgents: 17, itemsPerThread: 60...120, projects: 3, asks: 1),
  ].map { var s = $0; s.parametric = Fixtures.parameterRanges; return s }

  /// A named fixture, a named one with parameters (`crew@agents=24,items=100`), or nil.
  public static func spec(_ name: String) -> FixtureSpec? { resolve(name)?.spec }

  /// Builds the world for a fixture: a name from `all`, one with parameters (`crew@agents=24`), or a captured file
  /// (`file:PATH`, CapturedFixture.swift). The same name and seed always give the same world; parameters keep the
  /// base name's seed, so the points of a sweep share their generator and differ only where the parameters do.
  public static func make(_ name: String, seed: UInt64 = 7) -> World? {
    if name.hasPrefix(CapturedFixture.prefix) { return try? CapturedFixture.world(name) }
    guard let (family, spec, seedOverride) = resolve(name) else { return nil }
    var g = Gen(seed: (seedOverride ?? seed) ^ UInt64(family.utf8.reduce(0) { ($0 &* 31) &+ UInt64($1) }))
    var w = World(spec: spec)
    var seq = 0
    // Half an hour ago, to the minute: the clocks read like a live run; ids, text and structure never depend on it.
    let base = (Int(Date().timeIntervalSince1970 * 1000) / 60_000) * 60_000 - 30 * 60_000
    let openIndex = 0
    for p in 0..<spec.projects {
      let runId = "run-\(family)-\(p + 1)"
      let count = p == openIndex ? spec.openAgents : [1, 3, 5, 2][p % 4]
      let start = base + p * 90_000
      let title = Goals.pick(&g, p)
      func ev(_ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int) {
        seq += 1
        w.events.append((runId, Envelope(id: "e\(seq)", scope: runId, seq: seq, entity: agent ?? runId, type: type, epochMs: at,
                                         projectId: "prj-\(family)-\(p + 1)", runId: runId, agentId: agent, data: d)))
      }
      ev("run.created", nil, ["goal": .string(title), "sandbox": .string(p % 2 == 0 ? "docker" : "boxd")], at: start)
      ev("run.started", nil, at: start + 1)
      // The tree: a planner; leads for every 4 workers past the first few agents; a critic last.
      let ids = tree(count: count, run: runId)
      var order: [String] = []
      for (i, a) in ids.enumerated() {
        var d: [String: JSONValue] = ["profile": .string(a.profile), "agent": .object(["provider": .string(i % 3 == 2 ? "codex" : "claude"), "model": .string(i % 3 == 2 ? "gpt-5-codex" : "claude-opus-4-5")])]
        if let parent = a.parent { d["parent"] = .string(parent) }
        if let key = a.key { d["key"] = .string(key) }
        if a.profile == "worker" { d["workspace"] = .object(["label": .string(Repos.pick(&g))]) }
        ev("agent.spawned", a.id, d, at: start + 10 + i * 7)
        ev("agent.started", a.id, at: start + 20 + i * 7)
        ev("agent.activity_changed", a.id, ["activity": .object(["text": .string(Activities.pick(&g)), "kind": .string(["edit", "read", "run", "search"][i % 4])])], at: start + 30 + i * 7)
        order.append(a.id)
      }
      // Threads: every agent gets one, in the spec's length range. Items are at most 400 ms apart.
      for (i, id) in order.enumerated() {
        let n = g.int(spec.itemsPerThread)
        var items: [Item] = []
        var t = start + 1000 + i * 37
        var say = 0
        for k in 0..<n {
          seq += 1; w.lastSeq = seq
          t += g.int(40...400)
          let kind = ItemKinds.pick(&g, k, n)
          let (json, media) = itemJSON(id: "itm-\(id)-\(k + 1)", seq: seq, order: k, agentId: id, kind: kind, at: t, g: &g, say: &say)
          if let media { w.attachments[media.id] = media.png }
          items.append(try! JSONDecoder().decode(Item.self, from: json))
        }
        w.threads[id] = items
      }
      // Asks: pending approvals on workers, the first one deep in the tree so Follow has somewhere to go.
      let asks = p == openIndex ? spec.asks : 0
      var asking: [String] = []
      let workers = ids.filter { $0.profile == "worker" }.map(\.id)
      for a in 0..<asks where !workers.isEmpty {
        let who = workers[(workers.count * (a + 2)) / (asks + 2) % workers.count]
        let apr = "apr-\(runId)-\(a + 1)"
        ev("approval.requested", who, ["approvalId": .string(apr), "kind": .string("merge"), "question": .string("Merge \(Repos.pick(&g))'s change into main?"),
                                       "subject": .object(["ref": .string("fix/\(who.suffix(4))"), "target": .string("main")]),
                                       "requestedBy": .object(["agentId": .string(who), "runId": .string(runId)])], at: start + 5_000 + a)
        asking.append(who)
      }
      w.runIds.append(runId); w.agents[runId] = order; w.asking[runId] = asking
    }
    return w
  }

  struct Node { var id: String; var profile: String; var parent: String?; var key: String? }
  /// planner; leads every 5th agent after the second when there are more than 6; workers under the latest lead; a
  /// critic under the planner last.
  static func tree(count: Int, run: String) -> [Node] {
    let short = String(run.split(separator: "-").last ?? "x")
    guard count > 0 else { return [] }
    var out = [Node(id: "agt-\(short)-pl", profile: "planner", parent: nil, key: nil)]
    if count == 1 { return out }
    if count == 2 { out.append(Node(id: "agt-\(short)-w1", profile: "worker", parent: out[0].id, key: "task-a1b2")); return out }
    var lead = out[0].id
    var workers = 0, leads = 0
    for i in 1..<(count - 1) {
      if count > 6 && (i - 1) % 5 == 0 {
        leads += 1; lead = "agt-\(short)-ld\(leads)"
        out.append(Node(id: lead, profile: "lead", parent: out[0].id, key: nil))
      } else {
        workers += 1
        out.append(Node(id: "agt-\(short)-w\(workers)", profile: "worker", parent: lead, key: "task-\(String(format: "%04x", 0x1000 + workers * 0x3b7))"))
      }
    }
    out.append(Node(id: "agt-\(short)-cr", profile: "critic", parent: out[0].id, key: nil))
    return out
  }

  // MARK: items

  struct MediaOut { var id: String; var png: Data }

  /// One thread item as the daemon's route serializes it (format blocks/1), decoded by CapcomdThread like the real one.
  static func itemJSON(id: String, seq: Int, order: Int, agentId: String, kind: String, at: Int, g: inout Gen, say: inout Int) -> (Data, MediaOut?) {
    var o: [String: JSONValue] = [
      "id": .string(id), "rev": .number(1), "seq": .number(Double(seq)), "order": .number(Double(order)), "agentId": .string(agentId),
      "kind": .string(kind), "status": .string("done"), "at": .string(iso(at)), "durationMs": .null, "format": .string("blocks/1"),
      "redacted": .bool(false), "tool": .null, "error": .null, "truncated": .null, "child": .null, "blocks": .array([]), "text": .string(""),
    ]
    var media: MediaOut?
    switch kind {
    case "thinking":
      o["durationMs"] = .number(Double(g.int(800...9000)))
      let t = Prose.thought(&g); o["text"] = .string(t); o["blocks"] = .array([Blocks.paragraph(t)])
    case "tool":
      let (tool, text) = Tools.make(&g, agentId: agentId)
      o["tool"] = tool; o["text"] = .string(text)
    case "say", "result":
      say += 1
      let blocks = Prose.blocks(&g, rich: say % 4 == 0, long: say % 7 == 0)
      o["blocks"] = .array(blocks); o["text"] = .string(Blocks.plain(blocks))
    case "plan":
      let b = Blocks.taskList(["Read the schema", "Normalize emails before the join", "Run the tests", "Write the summary"], done: g.int(0...3))
      o["blocks"] = .array([b]); o["text"] = .string(Blocks.plain([b]))
    case "handoff":
      o["child"] = .object(["agentId": .string(agentId.replacingOccurrences(of: "-pl", with: "-w1")), "status": .string(["running", "done"][g.int(0...1)])])
      let t = "Handing the migration of `ids/v1` to the worker."; o["text"] = .string(t); o["blocks"] = .array([Blocks.paragraph(t)])
    case "error":
      o["error"] = .object(["message": .string("The test runner exited with status 1 (2 failures)."), "code": .string("tests")])
      o["text"] = .string("The test runner exited with status 1 (2 failures).")
    case "media":
      o["kind"] = .string("say")
      let mid = "att-\(id)"
      media = MediaOut(id: mid, png: Images.png(seed: g.next()))
      let caption = "The dashboard after the change:"
      o["blocks"] = .array([Blocks.paragraph(caption), .object(["t": .string("media"), "kind": .string("image"), "source": .object(["type": .string("attachment"), "id": .string(mid)]),
                                                              "alt": .string("dashboard screenshot"), "mime": .string("image/png"), "width": .number(64), "height": .number(40)])])
      o["text"] = .string(caption)
    default:
      o["text"] = .string("Unknown event: \(kind)")
    }
    return (try! JSONEncoder().encode(JSONValue.object(o)), media)
  }

  static func pageJSON(_ items: [Item], next: Int?, wire: [String: Data] = [:]) throws -> Data {
    // Items are already decoded; re-encode the minimum the Page decoder needs through their original fields (or
    // serve a captured item's own bytes).
    var out = "{\"items\":["
    out += items.map { i in wire[i.id].map { String(decoding: $0, as: UTF8.self) } ?? itemBack(i) }.joined(separator: ",")
    out += "],\"next\":\(next.map(String.init) ?? "null")}"
    return Data(out.utf8)
  }

  /// A decoded item back to wire JSON (what FixtureThread serves). Blocks go back through their plain text as one
  /// paragraph when they were prose; tools, errors, children and media are rebuilt exactly.
  static func itemBack(_ i: Item) -> String {
    var o: [String: JSONValue] = [
      "id": .string(i.id), "rev": .number(Double(i.rev)), "seq": .number(Double(i.seq)), "order": .number(Double(i.order)), "agentId": .string(i.agentId),
      "kind": .string(i.kind), "status": .string(i.open ? "open" : "done"), "at": .string(i.at), "durationMs": i.durationMs.map { .number(Double($0)) } ?? .null,
      "format": .string(i.format), "redacted": .bool(i.redacted), "text": .string(i.text), "blocks": .array(i.blocks.map(Blocks.encode)),
      "tool": .null, "error": .null, "truncated": .null, "child": .null,
    ]
    if let t = i.tool {
      o["tool"] = .object(["callId": .string(t.callId), "name": .string(t.name), "kind": .string(t.kind), "summary": .string(t.summary), "isError": .bool(t.isError),
                           "args": t.args.map(JSONValue.string) ?? .null, "output": t.output.map(JSONValue.string) ?? .null, "files": .array([]),
                           "diff": t.diff.map(Blocks.encode) ?? .null])
    }
    if let e = i.error { o["error"] = .object(["message": .string(e.message), "code": e.code.map(JSONValue.string) ?? .null]) }
    if let c = i.child { o["child"] = .object(["agentId": .string(c.agentId), "status": .string(c.status)]) }
    return String(decoding: try! JSONEncoder().encode(JSONValue.object(o)), as: UTF8.self)
  }

  /// A live item for a replay: a new `say` item for `agentId` after the world's last seq.
  public static func liveItem(world: inout World, agentId: String, text: String) -> Item {
    world.lastSeq += 1
    let order = (world.threads[agentId]?.count ?? 0)
    let o: [String: JSONValue] = [
      "id": .string("live-\(agentId)-\(world.lastSeq)"), "rev": .number(1), "seq": .number(Double(world.lastSeq)), "order": .number(Double(order)),
      "agentId": .string(agentId), "kind": .string("say"), "status": .string("done"), "at": .string(iso(Int(Date().timeIntervalSince1970 * 1000))),
      "durationMs": .null, "format": .string("blocks/1"), "redacted": .bool(false), "tool": .null, "error": .null, "truncated": .null, "child": .null,
      "text": .string(text), "blocks": .array([Blocks.paragraph(text)]),
    ]
    let item = try! JSONDecoder().decode(Item.self, from: try! JSONEncoder().encode(JSONValue.object(o)))
    world.threads[agentId, default: []].append(item)
    return item
  }

  /// The envelope the daemon sends for a live item (`agent.thread_item_changed`, ephemeral, on the run's lifecycle feed).
  public static func liveFrame(runId: String, item: Item) -> (scope: String, envelope: Envelope) {
    let data = try! JSONDecoder().decode(JSONValue.self, from: Data(itemBack(item).utf8))
    var e = Envelope(id: "live-\(item.seq)", scope: runId, seq: item.seq, entity: item.agentId, type: "agent.thread_item_changed", epochMs: item.atMs,
                     projectId: nil, runId: runId, agentId: item.agentId, data: ["agentId": .string(item.agentId), "item": data])
    e.durability = "ephemeral"
    return (CapcomdStore.lifecycleKey(runId), e)
  }

  /// An ask arriving live for `agentId` (what Follow reacts to).
  public static func askFrame(runId: String, agentId: String, approvalId: String, seq: Int) -> (scope: String, envelope: Envelope) {
    let e = Envelope(id: "ask-\(seq)", scope: runId, seq: seq, entity: agentId, type: "approval.requested", epochMs: Int(Date().timeIntervalSince1970 * 1000),
                     projectId: nil, runId: runId, agentId: agentId,
                     data: ["approvalId": .string(approvalId), "kind": .string("merge"), "question": .string("Merge the change into main?"),
                            "requestedBy": .object(["agentId": .string(agentId), "runId": .string(runId)])])
    return (runId, e)
  }

  static func iso(_ ms: Int) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }
}

/// SplitMix64: small, fast, deterministic.
public struct Gen {
  var state: UInt64
  public init(seed: UInt64) { state = seed }
  public mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
  public mutating func int(_ r: ClosedRange<Int>) -> Int { r.lowerBound + Int(next() % UInt64(r.count)) }
  public mutating func pick<T>(_ xs: [T]) -> T { xs[int(0...(xs.count - 1))] }
}

enum ItemKinds {
  /// A plausible mix: tools dominate, prose every few items, thinking before prose, a plan early, a handoff and a
  /// media item once in a while, the last item a result.
  static func pick(_ g: inout Gen, _ k: Int, _ n: Int) -> String {
    if k == n - 1 { return "result" }
    if k == 1 { return "plan" }
    let r = g.int(0...99)
    switch r {
    case 0..<48: return "tool"
    case 48..<66: return "say"
    case 66..<82: return "thinking"
    case 82..<88: return "say"
    case 88..<92: return "media"
    case 92..<95: return "handoff"
    case 95..<97: return "error"
    default: return "other"
    }
  }
}

enum Goals {
  static let list = ["Migrate matchkey to v3.2", "Fix proration rounding in billing", "Add dark mode to the settings pane", "Shard the ids table by region",
                     "Replace the cron importer with a queue", "Audit the OAuth refresh path", "Port the avatar renderer to Swift"]
  static func pick(_ g: inout Gen, _ p: Int) -> String { list[p % list.count] }
}
enum Repos {
  static let list = ["acme/billing", "acme/ids", "acme/web", "acme/infra", "acme/mobile"]
  static func pick(_ g: inout Gen) -> String { g.pick(list) }
}
enum Activities {
  static let list = ["Writing shard 118 of 256", "Read 4 files", "Running the test suite", "Searching for callers of normalize()", "Editing billing/proration.ts",
                     "Waiting for the verifier", "Reading the schema", "Rebasing onto main"]
  static func pick(_ g: inout Gen) -> String { g.pick(list) }
}

enum Prose {
  static let sentences = [
    "The join matches on raw email, so it misses mixed-case addresses.", "I normalized both sides with `lower(email)` before comparing.",
    "The migration runs in three passes: schema, backfill, then the swap.", "Two of the fixtures encode the old rounding; I updated them with the new values.",
    "The retry loop had no upper bound, which is why the importer pinned a core.", "Benchmarks are within noise of the previous run (p95 4.1 ms vs 4.0 ms).",
    "The verifier passed on the merged tree; the only warning is a stale snapshot in `web/`.", "I left the feature flag off by default so the rollout can be staged.",
    "The handler now returns 409 when the lease epoch is stale instead of silently overwriting.", "Both call sites pass the same options object, so I lifted it to a module constant.",
  ]
  static func thought(_ g: inout Gen) -> String { (0..<g.int(1...3)).map { _ in g.pick(sentences) }.joined(separator: " ") }
  static func blocks(_ g: inout Gen, rich: Bool, long: Bool) -> [JSONValue] {
    var out: [JSONValue] = []
    let paragraphs = long ? g.int(4...8) : g.int(1...2)
    for _ in 0..<paragraphs { out.append(Blocks.paragraphInline((0..<g.int(1...4)).map { _ in g.pick(sentences) }, &g)) }
    if rich {
      out.insert(Blocks.heading(2, g.pick(["Plan", "What changed", "Findings", "Next"])), at: 0)
      out.append(Blocks.list(["Normalize emails before the join", "Fan out three workers on `ids/v1`", "Keep the old table until the swap"], ordered: true))
      out.append(Blocks.code("sql", "SELECT count(*) FROM ids WHERE email IS NULL;\n-- expect 0 after the backfill"))
      out.append(Blocks.table())
      out.append(Blocks.quote("Emails are case-insensitive; the comparison must be too."))
    }
    return out
  }
}

enum Tools {
  static func make(_ g: inout Gen, agentId: String) -> (JSONValue, String) {
    let kind = g.pick(["read", "edit", "run", "search", "edit"])
    let file = g.pick(["billing/proration.ts", "ids/v1/schema.json", "web/src/App.tsx", "infra/queue.ts", "scripts/backfill.ts"])
    var tool: [String: JSONValue] = ["callId": .string("toolu_\(g.next() % 100_000)"), "isError": .bool(g.int(0...19) == 0), "files": .array([]), "diff": .null, "output": .null, "args": .null]
    let text: String
    switch kind {
    case "read":
      text = "Read \(file)"; tool["name"] = .string("Read"); tool["kind"] = .string("read"); tool["summary"] = .string(text)
      tool["args"] = .string("{\"file_path\":\"/work/\(file)\"}"); tool["output"] = .string("export const PRECISION = 2;\n")
    case "edit":
      text = "Edited \(file)"; tool["name"] = .string("Edit"); tool["kind"] = .string("edit"); tool["summary"] = .string(text)
      let n = g.int(2...12)
      var lines: [JSONValue] = [.object(["op": .string(" "), "text": .string("export function prorate(amount: number, days: number) {")])]
      for i in 0..<n {
        lines.append(.object(["op": .string("-"), "text": .string("  return amount * days / 30;  // \(i)")]))
        lines.append(.object(["op": .string("+"), "text": .string("  return round2(amount * days / daysInMonth);  // \(i)")]))
      }
      lines.append(.object(["op": .string(" "), "text": .string("}")]))
      tool["diff"] = .object(["path": .string(file), "added": .number(Double(n)), "removed": .number(Double(n)), "lines": .array(lines), "truncatedLines": .null])
    case "run":
      text = "Ran bun test"; tool["name"] = .string("Bash"); tool["kind"] = .string("run"); tool["summary"] = .string(text)
      tool["args"] = .string("bun test tests/billing"); tool["output"] = .string(" 42 pass\n 0 fail\nRan 42 tests across 6 files. [1.21s]\n")
    default:
      text = "Searched for normalize("; tool["name"] = .string("Grep"); tool["kind"] = .string("search"); tool["summary"] = .string(text)
      tool["args"] = .string("normalize("); tool["output"] = .string("ids/join.ts:12\nids/join.ts:48\nweb/src/email.ts:3\n")
    }
    return (.object(tool), text)
  }
}

enum Blocks {
  static func text(_ s: String) -> JSONValue { .object(["t": .string("text"), "text": .string(s)]) }
  static func paragraph(_ s: String) -> JSONValue { .object(["t": .string("paragraph"), "children": .array([text(s)])]) }
  /// Sentences with an inline emphasis, code or link now and then.
  static func paragraphInline(_ sentences: [String], _ g: inout Gen) -> JSONValue {
    var kids: [JSONValue] = []
    for (i, s) in sentences.enumerated() {
      switch g.int(0...5) {
      case 0: kids.append(.object(["t": .string("strong"), "children": .array([text(s)])]))
      case 1: kids.append(.object(["t": .string("em"), "children": .array([text(s)])]))
      case 2: kids.append(text("See ")); kids.append(.object(["t": .string("link"), "text": .string("the ADR"), "href": .string("https://example.com/adr-16"), "target": .string("web"), "host": .string("example.com"), "mismatch": .bool(false)])); kids.append(text(". " + s))
      default: kids.append(text(s))
      }
      if i < sentences.count - 1 { kids.append(text(" ")) }
    }
    return .object(["t": .string("paragraph"), "children": .array(kids)])
  }
  static func heading(_ level: Int, _ s: String) -> JSONValue { .object(["t": .string("heading"), "level": .number(Double(level)), "children": .array([text(s)])]) }
  static func list(_ items: [String], ordered: Bool) -> JSONValue {
    .object(["t": .string("list"), "ordered": .bool(ordered), "start": ordered ? .number(1) : .null,
             "items": .array(items.map { .object(["checked": .null, "blocks": .array([paragraph($0)])]) })])
  }
  static func taskList(_ items: [String], done: Int) -> JSONValue {
    .object(["t": .string("list"), "ordered": .bool(false), "start": .null,
             "items": .array(items.enumerated().map { .object(["checked": .bool($0.offset < done), "blocks": .array([paragraph($0.element)])]) })])
  }
  static func code(_ lang: String, _ s: String) -> JSONValue { .object(["t": .string("code"), "lang": .string(lang), "text": .string(s), "truncatedLines": .null]) }
  static func quote(_ s: String) -> JSONValue { .object(["t": .string("quote"), "blocks": .array([paragraph(s)])]) }
  static func table() -> JSONValue {
    .object(["t": .string("table"), "align": .array([.string("left"), .string("right"), .string("center")]),
             "header": .array([.array([text("shard")]), .array([text("rows")]), .array([text("ok")])]),
             "rows": .array([.array([.array([text("1")]), .array([text("1,204")]), .array([text("yes")])]),
                             .array([.array([text("2")]), .array([text("980")]), .array([text("no")])])]),
             "truncatedRows": .null, "truncatedCols": .null])
  }
  static func plain(_ blocks: [JSONValue]) -> String {
    func inl(_ v: JSONValue) -> String { v["text"]?.string ?? (v["children"]?.array ?? []).map(inl).joined() }
    return blocks.map { b -> String in
      switch b["t"]?.string {
      case "paragraph", "heading": return (b["children"]?.array ?? []).map(inl).joined()
      case "code": return b["text"]?.string ?? ""
      case "list": return (b["items"]?.array ?? []).map { plain($0["blocks"]?.array ?? []) }.joined(separator: "\n")
      case "quote": return plain(b["blocks"]?.array ?? [])
      default: return ""
      }
    }.joined(separator: "\n\n")
  }

  // Decoded → wire, for FixtureThread's pages.
  static func encode(_ i: Inline) -> JSONValue {
    switch i {
    case .text(let s): return text(s)
    case .code(let s): return .object(["t": .string("code"), "text": .string(s)])
    case .strong(let k): return .object(["t": .string("strong"), "children": .array(k.map(encode))])
    case .em(let k): return .object(["t": .string("em"), "children": .array(k.map(encode))])
    case .strike(let k): return .object(["t": .string("strike"), "children": .array(k.map(encode))])
    case .link(let l): return .object(["t": .string("link"), "text": .string(l.text), "href": l.href.map(JSONValue.string) ?? .null, "target": .string(l.target.rawValue),
                                       "host": l.host.map(JSONValue.string) ?? .null, "id": l.id.map(JSONValue.string) ?? .null, "path": l.path.map(JSONValue.string) ?? .null, "mismatch": .bool(l.mismatch)])
    case .lineBreak: return .object(["t": .string("break")])
    case .unknown(let s): return .object(["t": .string("unknown"), "text": s.map(JSONValue.string) ?? .null])
    }
  }
  static func encode(_ b: Block) -> JSONValue {
    switch b {
    case .paragraph(let k): return .object(["t": .string("paragraph"), "children": .array(k.map(encode))])
    case .heading(let l, let k): return .object(["t": .string("heading"), "level": .number(Double(l)), "children": .array(k.map(encode))])
    case .list(let ordered, let start, let items):
      return .object(["t": .string("list"), "ordered": .bool(ordered), "start": start.map { .number(Double($0)) } ?? .null,
                      "items": .array(items.map { .object(["checked": $0.checked.map(JSONValue.bool) ?? .null, "blocks": .array($0.blocks.map(encode))]) })])
    case .code(let lang, let t, let tr): return .object(["t": .string("code"), "lang": lang.map(JSONValue.string) ?? .null, "text": .string(t), "truncatedLines": tr.map { .number(Double($0)) } ?? .null])
    case .table(let t):
      return .object(["t": .string("table"), "align": .array(t.align.map { $0.map { .string($0.rawValue) } ?? .null }),
                      "header": .array(t.header.map { .array($0.map(encode)) }), "rows": .array(t.rows.map { .array($0.map { .array($0.map(encode)) }) }),
                      "truncatedRows": t.truncatedRows.map { .number(Double($0)) } ?? .null, "truncatedCols": t.truncatedCols.map { .number(Double($0)) } ?? .null])
    case .quote(let k): return .object(["t": .string("quote"), "blocks": .array(k.map(encode))])
    case .rule: return .object(["t": .string("rule")])
    case .media(let m):
      let src: JSONValue
      switch m.source {
      case .attachment(let id): src = .object(["type": .string("attachment"), "id": .string(id)])
      case .workspace(let p): src = .object(["type": .string("workspace"), "path": .string(p)])
      case .remote(let u, let h): src = .object(["type": .string("remote"), "url": .string(u), "host": .string(h)])
      case .unknown: src = .object(["type": .string("unknown")])
      }
      return .object(["t": .string("media"), "kind": .string(m.kind.rawValue), "source": src, "alt": .string(m.alt), "mime": m.mime.map(JSONValue.string) ?? .null,
                      "bytes": m.bytes.map { .number(Double($0)) } ?? .null, "width": m.width.map { .number(Double($0)) } ?? .null, "height": m.height.map { .number(Double($0)) } ?? .null])
    case .open(let s): return .object(["t": .string("open"), "text": .string(s)])
    case .unknown(let s): return .object(["t": .string("unknown"), "text": s.map(JSONValue.string) ?? .null])
    }
  }
  static func encode(_ d: Item.Diff) -> JSONValue {
    .object(["path": d.path.map(JSONValue.string) ?? .null, "added": .number(Double(d.added)), "removed": .number(Double(d.removed)),
             "truncatedLines": d.truncatedLines.map { .number(Double($0)) } ?? .null,
             "lines": .array(d.lines.map { l in
               let op: String = switch l.op { case .added: "+"; case .removed: "-"; case .gap: "@"; case .context: " " }
               return .object(["op": .string(op), "text": .string(l.text)])
             })])
  }
}

/// A small, valid PNG (64×40, solid-ish stripes) with no image library: zlib "stored" blocks and CRCs by hand.
enum Images {
  static func png(seed: UInt64) -> Data {
    let w = 64, h = 40
    var raw = Data()
    for y in 0..<h {
      raw.append(0)   // filter: none
      for x in 0..<w {
        let v = UInt8(truncatingIfNeeded: (UInt64(x * 3 + y * 5) &+ seed) & 0xFF)
        raw.append(contentsOf: [v, UInt8(truncatingIfNeeded: y * 6), UInt8(truncatingIfNeeded: 200 &- v)])
      }
    }
    func chunk(_ type: String, _ body: Data) -> Data {
      var c = Data(); c.append(be32(UInt32(body.count))); let tb = Data(type.utf8) + body; c.append(tb); c.append(be32(crc32(tb))); return c
    }
    var ihdr = Data(); ihdr.append(be32(UInt32(w))); ihdr.append(be32(UInt32(h))); ihdr.append(contentsOf: [8, 2, 0, 0, 0])
    var out = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
    out.append(chunk("IHDR", ihdr)); out.append(chunk("IDAT", zlibStored(raw))); out.append(chunk("IEND", Data()))
    return out
  }
  static func be32(_ v: UInt32) -> Data { Data([UInt8(v >> 24), UInt8((v >> 16) & 0xFF), UInt8((v >> 8) & 0xFF), UInt8(v & 0xFF)]) }
  static func zlibStored(_ d: Data) -> Data {
    var out = Data([0x78, 0x01])
    var i = 0
    while i < d.count {
      let n = min(65535, d.count - i)
      out.append(i + n >= d.count ? 1 : 0)
      out.append(contentsOf: [UInt8(n & 0xFF), UInt8(n >> 8), UInt8(~n & 0xFF), UInt8((~n >> 8) & 0xFF)])
      out.append(d[i..<(i + n)]); i += n
    }
    var a: UInt32 = 1, b: UInt32 = 0
    for x in d { a = (a + UInt32(x)) % 65521; b = (b + a) % 65521 }
    out.append(be32((b << 16) | a))
    return out
  }
  static let table: [UInt32] = (0..<256).map { n -> UInt32 in
    var c = UInt32(n); for _ in 0..<8 { c = c & 1 == 1 ? 0xEDB8_8320 ^ (c >> 1) : c >> 1 }; return c
  }
  static func crc32(_ d: Data) -> UInt32 {
    var c: UInt32 = 0xFFFF_FFFF
    for b in d { c = table[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8) }
    return c ^ 0xFFFF_FFFF
  }
}
