import Foundation
import CapcomdStore
import CapcomdThread

/// A fixture captured from a daemon (`deskbench fixture capture`, CAPABILITIES.md C8): the runs' durable events and
/// every agent's thread pages as the app reads them, anonymised by default, attachments reduced to their shape (the
/// bench draws a placeholder image of the same kind). The bench runs on one as `--fixture file:PATH`.
///
/// `deskbench.fixture/1`; never committed: captures live outside the repo (`defaultDirectory`) unless the owner
/// says otherwise.
public struct CapturedFixture: Codable, Sendable {
  public static let prefix = "file:"
  public var schema = "deskbench.fixture/1"
  public var name: String
  public var anonymised: Bool
  public var capturedAt: String
  public var runs: [Run]
  /// Attachment id → what it was (no bytes).
  public var attachments: [String: Attachment]
  public var notes: [String] = []

  public struct Run: Codable, Sendable {
    public var runId: String
    /// The stream scope the events came from (`run-…`; the app subscribes to it).
    public var scope: String
    /// Agent ids in tree order.
    public var agents: [String]
    /// `GET /v1/events?scope=` as served (anonymised).
    public var events: [JSONValue]
    /// Agent id → `GET /v1/runs/{run}/agents/{agent}/thread` items, every page, in seq order.
    public var threads: [String: [JSONValue]]
  }
  public struct Attachment: Codable, Sendable, Equatable {
    public var kind: String?
    public var mime: String?
    public var width: Int?
    public var height: Int?
    public var bytes: Int?
  }

  /// What a capture read for one run, before anonymising.
  public struct RawRun: Sendable {
    public var runId: String
    public var scope: String
    public var agents: [String]
    public var events: [JSONValue]
    public var threads: [String: [JSONValue]]
    public init(runId: String, scope: String, agents: [String], events: [JSONValue], threads: [String: [JSONValue]]) {
      self.runId = runId; self.scope = scope; self.agents = agents; self.events = events; self.threads = threads
    }
  }

  /// 2026-01-01T00:00:00Z: an anonymised capture's earliest time (only intervals are kept). The bench moves a
  /// capture's times to just before now when it loads it, so the clocks read like a live run.
  public static let anonymousEpochMs = 1_767_225_600_000

  /// Builds the file from what was read: anonymised (text, ids, URLs, times; `salt` nil = random) unless `anonymise`
  /// is false.
  public static func build(name: String, runs raw: [RawRun], anonymise: Bool, salt: Data? = nil) -> CapturedFixture {
    let first = raw.flatMap { r in r.events.compactMap { $0["epochMs"]?.int } + r.threads.values.flatMap { $0.compactMap { epochMs(iso: $0["at"]?.string) } } }.min() ?? anonymousEpochMs
    var a = Anonymiser(salt: salt, shiftMs: anonymise ? anonymousEpochMs - first : 0)
    var runs: [Run] = []
    for r in raw {
      if !anonymise { runs.append(Run(runId: r.runId, scope: r.scope, agents: r.agents, events: r.events, threads: r.threads)); continue }
      var threads: [String: [JSONValue]] = [:]
      for (agent, items) in r.threads { threads[a.id(agent)] = items.map { a.value($0, key: nil) } }
      runs.append(Run(runId: a.id(r.runId), scope: a.id(r.scope), agents: r.agents.map { a.id($0) }, events: r.events.map { a.value($0, key: nil) }, threads: threads))
    }
    var atts: [String: Attachment] = [:]
    for r in runs { for items in r.threads.values { for i in items { media(in: i, into: &atts) } } }
    var notes = ["captured with deskbench fixture capture; \(anonymise ? "anonymised: text replaced by generated text of the same length and shape, ids hashed, URLs and hosts replaced, times moved (intervals kept)" : "NOT anonymised (--raw): holds the runs' real text")",
                 "attachments: shape only (kind, mime, size); the bench draws a placeholder"]
    if raw.contains(where: { $0.threads.isEmpty }) { notes.append("a run had no thread items") }
    return CapturedFixture(name: name, anonymised: anonymise, capturedAt: CaptureClock.isoNow(), runs: runs, attachments: atts, notes: notes)
  }

  /// Every attachment-sourced media block under `v`.
  static func media(in v: JSONValue, into out: inout [String: Attachment]) {
    switch v {
    case .object(let o):
      if o["t"]?.string == "media", let src = o["source"], src["type"]?.string == "attachment", let id = src["id"]?.string {
        out[id] = Attachment(kind: o["kind"]?.string, mime: o["mime"]?.string, width: o["width"]?.int, height: o["height"]?.int, bytes: o["bytes"]?.int)
      }
      for x in o.values { media(in: x, into: &out) }
    case .array(let a): for x in a { media(in: x, into: &out) }
    default: break
    }
  }

  // MARK: loading

  /// `${PERFLOOP_HOME:-~/.perfloop}/capcomd-desktop/fixtures`: where captures go unless `--out` says otherwise.
  public static var defaultDirectory: URL {
    let env = ProcessInfo.processInfo.environment
    let home = env["PERFLOOP_HOME"].map { URL(fileURLWithPath: $0) } ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".perfloop")
    return home.appendingPathComponent("capcomd-desktop").appendingPathComponent("fixtures")
  }

  /// `file:PATH` → the file: PATH as given, or a bare name in `defaultDirectory` (`file:crew-real` → …/crew-real.json).
  public static func path(_ name: String) -> URL {
    let p = name.hasPrefix(prefix) ? String(name.dropFirst(prefix.count)) : name
    let expanded = p.hasPrefix("~/") ? FileManager.default.homeDirectoryForCurrentUser.path + p.dropFirst(1) : p
    if FileManager.default.fileExists(atPath: expanded) || expanded.contains("/") { return URL(fileURLWithPath: expanded) }
    return defaultDirectory.appendingPathComponent(expanded.hasSuffix(".json") ? expanded : expanded + ".json")
  }

  struct LoadError: Error, CustomStringConvertible { var description: String }

  public static func read(_ name: String) throws -> CapturedFixture {
    let u = path(name)
    guard let d = try? Data(contentsOf: u) else { throw LoadError(description: "no captured fixture at \(u.path)") }
    do {
      let f = try JSONDecoder().decode(CapturedFixture.self, from: d)
      guard f.schema.hasPrefix("deskbench.fixture/") else { throw LoadError(description: "\(u.path) is a \(f.schema), not a deskbench.fixture/1") }
      return f
    } catch let e as LoadError { throw e } catch { throw LoadError(description: "\(u.path) is not a deskbench.fixture/1: \(error)") }
  }

  /// The World for `file:PATH`, its times moved so the newest is a minute ago.
  public static func world(_ name: String, now: Date = Date()) throws -> World {
    let f = try read(name)
    let latest = f.runs.flatMap { r in r.events.compactMap { $0["epochMs"]?.int } + r.threads.values.flatMap { $0.compactMap { epochMs(iso: $0["at"]?.string) } } }.max() ?? 0
    let shift = Anonymiser(salt: Data(), shiftMs: Int(now.timeIntervalSince1970 * 1000) - 60_000 - latest)
    let spec0 = FixtureSpec(name: name, summary: "", openAgents: 0, itemsPerThread: 0...0, projects: f.runs.count, asks: 0)
    var w = World(spec: spec0)
    var firstAt: [String: Int] = [:]
    var counts: [Int] = []
    for r in f.runs {
      var decided: Set<String> = [], asked: [(approval: String, agent: String)] = []
      for raw in r.events {
        let v = shift.times(raw)
        guard let e = try? JSONDecoder().decode(Envelope.self, from: JSONEncoder().encode(v)) else { continue }
        w.events.append((r.scope, e))
        firstAt[r.runId] = min(firstAt[r.runId] ?? .max, e.epochMs)
        w.lastSeq = max(w.lastSeq, e.seq)
        if e.type == "approval.requested", let id = e.data["approvalId"]?.string { asked.append((id, e.agentId ?? e.data["requestedBy"]?["agentId"]?.string ?? "")) }
        if e.type == "approval.decided", let id = e.data["approvalId"]?.string { decided.insert(id) }
      }
      var agents = r.agents
      if agents.isEmpty { agents = w.events.filter { $0.scope == r.scope && $0.envelope.type == "agent.spawned" }.compactMap(\.envelope.agentId) }
      for (agent, items) in r.threads {
        var decodedItems: [Item] = []
        for raw in items {
          let v = shift.times(raw)
          guard let data = try? JSONEncoder().encode(v), let i = try? JSONDecoder().decode(Item.self, from: data) else { continue }
          decodedItems.append(i); w.wire[i.id] = data
          w.lastSeq = max(w.lastSeq, i.seq)
        }
        w.threads[agent] = decodedItems.sorted { $0.seq < $1.seq }
        counts.append(decodedItems.count)
      }
      w.agents[r.runId] = agents
      w.asking[r.runId] = asked.filter { !decided.contains($0.approval) && !$0.agent.isEmpty }.map(\.agent)
    }
    w.runIds = f.runs.map(\.runId).sorted { (firstAt[$0] ?? 0, $0) < (firstAt[$1] ?? 0, $1) }
    for (id, a) in f.attachments where a.kind == "image" || a.mime?.hasPrefix("image/") == true { w.attachments[id] = Images.png(seed: id.utf8.reduce(UInt64(14695981039346656037)) { ($0 ^ UInt64($1)) &* 1099511628211 }) }
    let open = w.openRunId
    w.spec = FixtureSpec(name: name, summary: "captured\(f.anonymised ? ", anonymised" : " (not anonymised)"): \(f.runs.count) run(s), \(w.threads.values.map(\.count).reduce(0, +)) thread items",
                         openAgents: open.flatMap { w.agents[$0]?.count } ?? 0, itemsPerThread: (counts.min() ?? 0)...(counts.max() ?? 0), projects: f.runs.count,
                         asks: open.flatMap { w.asking[$0]?.count } ?? 0)
    return w
  }
}

extension Anonymiser {
  /// Only the time shift: every epoch-ms and time field moved by `shiftMs`, nothing else touched.
  public func times(_ v: JSONValue, key: String? = nil) -> JSONValue {
    switch v {
    case .number(let n): return key.map(Self.epochKey) == true ? .number(n + Double(shiftMs)) : v
    case .string(let s): if let k = key, Self.timeKey(k), let t = epochMs(iso: s) { return .string(Self.iso(t + shiftMs)) }; return v
    case .array(let a): return .array(a.map { times($0, key: key) })
    case .object(let o): var out: [String: JSONValue] = [:]; for (k, x) in o { out[k] = times(x, key: k) }; return .object(out)
    default: return v
    }
  }
}

enum CaptureClock {
  static func isoNow() -> String { let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime]; return f.string(from: Date()) }
}
