import Foundation

// Run detail (SPEC §4.3): what the drill-down's Trace, Log and Files read over REST, and how it is shaped for display.

/// `GET /v1/runs/{runId}/trace` item: an OpenTelemetry-shaped span from the run's trace file (written when it ends).
public struct TraceSpan: Codable, Sendable, Hashable {
  public var spanId: String
  public var parentSpanId: String?
  public var name: String
  public var start: String
  public var end: String?
  /// OTel status code: 0 unset, 1 ok, 2 error.
  public var status: Int
  public var attributes: [String: JSONValue]
  public init(spanId: String, parentSpanId: String?, name: String, start: String, end: String?, status: Int, attributes: [String: JSONValue]) {
    self.spanId = spanId; self.parentSpanId = parentSpanId; self.name = name; self.start = start; self.end = end; self.status = status; self.attributes = attributes
  }
}

/// `GET /v1/runs/{runId}/agents/{agentId}/transcript` page. `text` is agent output (x-untrusted): plain text only.
public struct TranscriptPage: Codable, Sendable, Hashable {
  public struct Item: Codable, Sendable, Hashable { public var seq: Int; public var at: String; public var stream: String; public var text: String }
  public var items: [Item]
  public var next: Int?
}

/// One line of the Log pane.
public struct LogLine: Sendable, Hashable, Identifiable {
  public var id: Int { seq }
  public var seq: Int
  public var atMs: Int
  public var text: UntrustedText
}

/// `GET /v1/runs/{runId}/files`: the files a run's agents changed. `path`/`oldPath` are x-untrusted.
public struct RunFiles: Codable, Sendable, Hashable {
  public struct File: Codable, Sendable, Hashable {
    public var path: String; public var oldPath: String?; public var status: String
    public var added: Int?; public var removed: Int?; public var agentId: String
  }
  public var runId: String
  public var asOf: Int
  public var files: [File]
  public var total: Int
  public var truncated: Bool
}

/// A run detail fetch that failed: the daemon is older than the route (404 on the route itself), or it couldn't answer.
public enum DetailUnavailable: Error, Sendable, Hashable { case unsupported, failed(String) }

/// What the drill-down shows for one part of the run, as last fetched.
public enum Fetched<T: Sendable & Hashable>: Sendable, Hashable {
  case loading, loaded(T), unavailable(DetailUnavailable)
  public var value: T? { if case .loaded(let v) = self { return v }; return nil }
}

/// The Trace view's row: a span the operator cares about (or a running/queued agent that has no span yet), indented by
/// its kept ancestors, with its lane on the run's timeline.
public struct TraceRow: Sendable, Hashable, Identifiable {
  public var id: String
  public var depth: Int
  public var label: String
  public var kind: StepKind
  public var status: StepStatus
  public var startMs: Int
  public var endMs: Int?
  public var hasChildren: Bool
  /// Lane as fractions of the timeline: offset and width in 0…1.
  public var laneStart: Double = 0
  public var laneWidth: Double = 0
  public var durationMs: Int? { endMs.map { $0 - startMs } }
}

public enum TraceShape {
  /// Internal spans (actor RPCs, state transitions) are noise in a person's view of a run; these are kept, labelled.
  static func describe(_ s: TraceSpan) -> (label: String, kind: StepKind)? {
    let a = s.attributes
    switch s.name {
    case "agent.run":
      return (a["agent.profile"]?.string ?? "agent", .agent)
    case "agent.claude_code", "agent.codex", "model.generate":
      return ("model call", .model)
    case "sandbox.ensure": return ("sandbox up", .sandbox)
    case "sandbox.waitReady": return ("wait for sandbox", .sandbox)
    case "actor.verifier.verify": return ("verify", .tool)
    default:
      if s.name.hasPrefix("git.") {
        let op = a["git.operation"]?.string ?? String(s.name.dropFirst(4))
        return (a["git.ref"]?.string.map { "\(op) \($0)" } ?? op, .git)
      }
      if s.name.hasPrefix("merge.") { return (s.name.replacingOccurrences(of: ".", with: " "), .git) }
      return nil
    }
  }

  /// Kept spans as an outline (children under their nearest kept ancestor, in start order), then agents that are
  /// running or queued without a span yet. `collapsed` folds a row's children. Lanes span the run's first start to
  /// `nowMs` while anything runs, else to the last end.
  public static func rows(spans: [TraceSpan], pending: [(id: String, label: String, kind: StepKind, status: StepStatus, startMs: Int)],
                          nowMs: Int, collapsed: Set<String> = []) -> [TraceRow] {
    let byId = Dictionary(spans.map { ($0.spanId, $0) }, uniquingKeysWith: { a, _ in a })
    var kept: [String: TraceRow] = [:], parentOf: [String: String] = [:]
    for s in spans {
      guard let d = describe(s), let start = epochMs(iso: s.start) else { continue }
      let end = epochMs(iso: s.end)
      let status: StepStatus = s.status == 2 ? .failed : end == nil ? .running : .done
      kept[s.spanId] = TraceRow(id: s.spanId, depth: 0, label: d.label, kind: d.kind, status: status, startMs: start, endMs: end, hasChildren: false)
    }
    // Nearest kept ancestor (skipping dropped spans); guards against cycles in a malformed file.
    for id in kept.keys {
      var p = byId[id]?.parentSpanId, hops = 0
      while let pid = p, hops < 64 { if kept[pid] != nil { parentOf[id] = pid; break }; p = byId[pid]?.parentSpanId; hops += 1 }
    }
    let kids = Dictionary(grouping: kept.keys, by: { parentOf[$0] ?? "" })
    var out: [TraceRow] = []
    func walk(_ parent: String, _ depth: Int) {
      for id in (kids[parent] ?? []).sorted(by: { (kept[$0]!.startMs, $0) < (kept[$1]!.startMs, $1) }) {
        var r = kept[id]!; r.depth = depth; r.hasChildren = !(kids[id] ?? []).isEmpty
        out.append(r)
        if !collapsed.contains(id) { walk(id, depth + 1) }
      }
    }
    walk("", 0)
    for p in pending { out.append(TraceRow(id: "pending:\(p.id)", depth: 0, label: p.label, kind: p.kind, status: p.status, startMs: p.startMs, endMs: nil, hasChildren: false)) }
    guard let t0 = out.map(\.startMs).min() else { return out }
    let live = out.contains { $0.status == .running }
    let t1 = max(t0 + 1, live ? nowMs : (out.compactMap(\.endMs).max() ?? nowMs))
    let span = Double(t1 - t0)
    return out.map { r in
      var r = r
      let s = Double(r.startMs - t0) / span
      let e = r.status == .queued || r.status == .paused ? s : Double((r.endMs ?? (r.status == .running ? t1 : r.startMs)) - t0) / span
      r.laneStart = min(max(s, 0), 1); r.laneWidth = min(max(e - s, 0), 1 - r.laneStart)
      return r
    }
  }
}

/// "now", "45s ago", "6m ago", "2h ago", "3d ago": an Activity row's time.
public func relativeAgo(ms: Int, nowMs: Int) -> String {
  let s = max(0, (nowMs - ms) / 1000)
  if s < 10 { return "now" }
  if s < 60 { return "\(s)s ago" }
  if s < 3600 { return "\(s / 60)m ago" }
  if s < 86_400 { return "\(s / 3600)h ago" }
  return "\(s / 86_400)d ago"
}

/// "0:33", "5:12", "1:02:07": a span's duration or the run's elapsed time.
public func clockDuration(ms: Int) -> String {
  let s = max(0, ms / 1000)
  return s >= 3600 ? String(format: "%d:%02d:%02d", s / 3600, (s % 3600) / 60, s % 60) : String(format: "%d:%02d", s / 60, s % 60)
}

extension StepKind {
  /// Agent.activity `kind` (harness #48 vocabulary) → step icon. Unknown kinds are a tool, as the contract asks.
  public init(activityKind k: String?) {
    switch k {
    case "read", "search", "report": self = .fileRead
    case "edit", "write": self = .fileWrite
    case "run": self = .shell
    case "install": self = .sandbox
    case "git", "merge": self = .git
    case "web": self = .network
    case "plan": self = .plan
    case "think": self = .model
    case "spawn", "wait", "delegate", "message": self = .agent
    default: self = .tool    // test, build, check, verify, tool, unknown
    }
  }
}
