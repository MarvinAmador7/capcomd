import Foundation

/// Agent status per contract `agent.status_changed` / agents.tree `status` enum.
public enum AgentStatus: String, Sendable, Hashable, CaseIterable {
  case pending, running, paused, done, failed, cancelled, handedOff = "handed-off", unknown
  public init(wire: String?) { self = wire.flatMap(AgentStatus.init(rawValue:)) ?? .unknown }
  public var isTerminal: Bool { [.done, .failed, .cancelled, .handedOff].contains(self) }
}

/// Profile family → SF Symbol (SPEC §5). Agents are named by profile, never by role.
public enum ProfileKind: String, Sendable, Hashable {
  case planner, lead, worker, critic, other
  public init(profile: String?) { self = profile.flatMap { ProfileKind(rawValue: $0.lowercased()) } ?? .other }
  public var symbol: String {
    switch self {
    case .planner: "point.3.connected.trianglepath.dotted"
    case .lead: "flag"
    case .worker: "hammer"
    case .critic: "checkmark.seal"
    case .other: "hexagon"          // drawn with a centre dot overlay
    }
  }
  public var hasCentreDot: Bool { self == .other }
}

/// Icon tint state (SPEC §2/§5): grey by default, blue while running, amber on approval, red on failure.
public enum Tint: Sendable, Hashable { case grey, blue, amber, red, tertiary }

/// The AI provider an agent runs on. Wire values: `Agent.provider` ("claude", "codex"), or agent.spawned's
/// `agent.provider` / `agent.kind` ("claude-code", "codex"; "fake" is none).
public enum Provider: String, Sendable, Hashable {
  case claude, codex
  public init?(wire: String?) {
    switch wire { case "claude", "claude-code": self = .claude; case "codex": self = .codex; default: return nil }
  }
  public var displayName: String { switch self { case .claude: "Claude"; case .codex: "Codex" } }
}

public struct Agent: Sendable, Hashable, Identifiable {
  public var id: String
  public var runId: String
  public var parent: String?
  public var depth: Int
  public var profile: String?
  public var status: AgentStatus
  public var task: UntrustedText?
  /// Task key from `agent.spawned.key` (short task id candidate).
  public var key: String?
  /// Where it works: `Agent.workspace.label` (harness #46), shown verbatim as its folder chip. Older daemons: `repo` or
  /// `agent.repo` on agent.spawned when present.
  public var repo: String?
  public var spawnedAtMs: Int
  /// When its status last changed (snapshot `updatedAt`, or the event that changed it): a finished run's end.
  public var updatedAtMs: Int? = nil
  /// What it is doing now (`Agent.activity.text`, daemon-written, trusted): shown under a running agent's row.
  public var activity: String? = nil
  /// `Agent.activity.kind`: icon hint for the activity line (read, edit, test, …).
  public var activityKind: String? = nil
  /// `taskAttachment`: the full task is stored by the daemon; only its metadata is shown.
  public var taskAttachment: AttachmentRef? = nil
  /// `result.summary` once the agent finished (agent-written, untrusted).
  public var resultSummary: UntrustedText? = nil
  /// Which AI it runs on, and the model when the daemon knows it (daemon-written).
  public var provider: Provider? = nil
  public var model: String? = nil
  public var kind: ProfileKind { ProfileKind(profile: profile) }
  /// Profile names stay lowercase as the contract sends them ("lead"); nil → "agent".
  public var displayName: String {
    guard let p = profile, !p.isEmpty else { return "agent" }
    return p
  }
}

public enum StepStatus: Sendable, Hashable { case done, running, failed, queued, waiting, paused
  /// SPEC §5 status symbols. Done has none.
  public var symbol: String? {
    switch self {
    case .done: nil; case .running: "smallcircle.filled.circle"; case .failed: "xmark.circle"; case .queued: "clock"; case .waiting: "hand.raised"
    case .paused: "pause.circle"
    }
  }
  public var tint: Tint { switch self { case .done: .grey; case .running: .blue; case .failed: .red; case .queued, .paused: .tertiary; case .waiting: .amber } }
}

public enum StepKind: String, Sendable, Hashable { case plan, fileRead, fileWrite, tool, shell, sandbox, model, network, git, retry, approval, agent, verify
  public var symbol: String {
    switch self {
    case .plan: "list.bullet"; case .fileRead: "doc.text"; case .fileWrite: "square.and.pencil"; case .tool: "wrench"
    case .shell: "apple.terminal"; case .sandbox: "shippingbox"; case .model: "sparkles"; case .network: "globe"
    case .git: "arrow.triangle.branch"; case .retry: "arrow.clockwise"; case .approval: "hand.raised"
    case .agent: "hexagon"; case .verify: "checkmark.seal"
    }
  }
}
public enum Phase: String, Sendable, Hashable, CaseIterable { case plan = "Plan", build = "Build", ship = "Ship" }

/// One Activity row. `text` is composed by the client from trusted fields; agent-written parts sit in `detail`.
public struct Step: Sendable, Hashable, Identifiable {
  public var id: String          // stable: entity of the thing this row tracks
  public var seq: Int
  public var epochMs: Int
  public var agentId: String?
  public var kind: StepKind
  public var phase: Phase
  public var text: String
  public var detail: UntrustedText?
  public var status: StepStatus
}

public enum DecisionState: Sendable, Hashable {
  case idle
  case submitting(ApprovalDecision)
  case decided(status: String, by: String?, alreadyDecided: Bool)
  case failed(String)
}
public enum ApprovalDecision: String, Sendable, Hashable, Codable { case approve, deny }

public struct PendingApproval: Sendable, Hashable, Identifiable {
  public var id: String                 // apr-…
  public var runId: String?
  public var agentId: String?
  public var kind: String
  /// Shown first (13 pt medium). Agent-written.
  public var question: UntrustedText
  /// Shown beneath in mono, e.g. "fix/backfill → main". From `subject` (merge {ref, target}, egress {host}, secret {name}).
  public var branchLine: String?
  public var decision: DecisionState = .idle
  /// Reused for every retry of the same (approval, decision) so a lost response replays instead of double-deciding.
  public var idempotencyKeys: [ApprovalDecision: String] = [:]
}

public struct Run: Sendable, Hashable, Identifiable {
  public var id: String
  public var projectId: String?
  public var label: String?
  public var goal: UntrustedText?
  public var state: String
  public var startedAtMs: Int?
  public var lastEventMs: Int
  public var agents: [String: Agent] = [:]
  public var steps: [Step] = []
  /// `run.*` lifecycle transitions applied to this run, in order (lifecycle feed).
  public var lifecycle: [RunTransition] = []
  public static let terminalStates: Set<String> = ["completed", "failed", "cancelled", "deleted"]
  public var isRunning: Bool {
    if Self.terminalStates.contains(state) { return false }
    return state == "running" || agents.values.contains { $0.status == .running }
  }
  public var title: String { goal?.firstLine ?? label ?? id }

  /// Where a run stands for the panel: still doing something (it stays in the Active list), or how it ended.
  public enum Outcome: Sendable, Hashable { case active, done, failed, stopped }
  /// A run that never spawned an agent (snapshot state `new`) counts as active this long after it was created.
  public static let startGraceMs = 5 * 60_000
  /// Lifecycle states win; otherwise the daemon's own state, then its agents. The daemon snapshot says `idle` for a run
  /// whose agents all ended (it doesn't replay run.completed), so their statuses tell how it ended.
  public func outcome(nowMs: Int) -> Outcome {
    switch state {
    case "completed": return .done
    case "failed": return .failed
    case "cancelled", "deleted": return .stopped
    case "running", "paused", "starting": return .active
    case "new": return nowMs - (startedAtMs ?? nowMs) < Self.startGraceMs ? .active : .stopped
    default: break
    }
    let statuses = agents.values.map(\.status)
    if statuses.contains(where: { !$0.isTerminal }) { return .active }
    if statuses.contains(.failed) { return .failed }
    if statuses.contains(.cancelled) { return .stopped }
    return .done
  }
  public var outcome: Outcome { outcome(nowMs: Int(Date().timeIntervalSince1970 * 1000)) }
  public var isActive: Bool { outcome == .active }
  /// When it ended: its terminal lifecycle transition, else its agents' last change, else its last event.
  public var endedAtMs: Int? {
    if let t = lifecycle.last(where: { Self.terminalStates.contains($0.state) }) { return t.epochMs }
    return agents.values.compactMap(\.updatedAtMs).max() ?? (lastEventMs > 0 ? lastEventMs : nil)
  }
  /// For ordering: the latest thing known about it.
  public var recencyMs: Int { max(lastEventMs, endedAtMs ?? 0, startedAtMs ?? 0) }
}

/// "45s", "4m", "1h 5m", "3d": the finished row's duration.
public func shortDuration(ms: Int) -> String {
  let s = max(0, ms / 1000)
  if s < 60 { return "\(s)s" }
  if s < 3600 { return "\(s / 60)m" }
  if s < 86_400 { let m = (s % 3600) / 60; return m == 0 ? "\(s / 3600)h" : "\(s / 3600)h \(m)m" }
  return "\(s / 86_400)d"
}

public struct Project: Sendable, Hashable, Identifiable {
  public var id: String
  /// Title = goal of its most recent run (contract has no project goal; gap G1).
  public var goal: UntrustedText?
  public var runs: [Run]
  public var title: String { goal.map { $0.firstLine.trimmingCharacters(in: .whitespaces) } ?? runs.first?.title ?? id }
  public var isRunning: Bool { runs.contains(where: \.isRunning) }
  public var lastEventMs: Int { runs.map(\.lastEventMs).max() ?? 0 }
  public var recencyMs: Int { runs.map(\.recencyMs).max() ?? 0 }
  public var latestRun: Run? { runs.max { ($0.recencyMs, $0.id) < ($1.recencyMs, $1.id) } }
  /// How long its latest run took, once it ended (nil while active or when start/end aren't known).
  public var endedDurationMs: Int? {
    guard !isActive, let r = latestRun, let s = r.startedAtMs, let e = r.endedAtMs, e >= s else { return nil }
    return e - s
  }
  /// Runs still doing something: the card nests only these; finished and failed runs leave it.
  public var activeRuns: [Run] { runs.filter(\.isActive) }
  /// In the Active list while any run is active; otherwise a one-line finished row.
  public var isActive: Bool { runs.contains(where: \.isActive) }
  /// The finished row's trailing text (v5-a-final): how its latest run ended and how long it took, then its folders.
  /// "Done in 4m · 3 repos", "Failed after 12m", "Stopped". Nil while active.
  public var endedLine: String? {
    guard !isActive, let last = latestRun else { return nil }
    let took = endedDurationMs.map { shortDuration(ms: $0) }
    let verb: (String, String) = switch last.outcome { case .failed: ("Failed", "after"); case .stopped: ("Stopped", "after"); default: ("Done", "in") }
    let head = took.map { "\(verb.0) \(verb.1) \($0)" } ?? verb.0
    let n = scopes.count
    return n == 0 ? head : "\(head) · \(n) \(n == 1 ? "repo" : "repos")"
  }
  /// Scope chips: the distinct folders its agents work in, newest run first, then spawn order. Empty until the
  /// daemon reports agent repos (gap G1).
  public var scopes: [String] {
    var seen = Set<String>()
    return runs.flatMap { $0.agents.values.sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) } }
      .compactMap(\.repo).filter { seen.insert($0).inserted }
  }
}

/// Display node for the outline tree.
public struct AgentNode: Sendable, Hashable, Identifiable {
  public var id: String
  public var name: String
  /// Mono tertiary suffix when sibling profiles repeat: repo, else short task id, else last 4 of agentId.
  public var suffix: String?
  public var kind: ProfileKind
  public var status: AgentStatus
  /// Its folder (`Agent.repo`): the row's folder chip.
  public var repo: String? = nil
  /// Daemon-written activity line (trusted plain text), if known.
  public var activity: String? = nil
  /// `taskAttachment`: the full task is stored by the daemon; only its metadata is shown.
  public var taskAttachment: AttachmentRef? = nil
  /// `result.summary` once the agent finished (agent-written, untrusted).
  public var resultSummary: UntrustedText? = nil
  public var depth: Int
  public var waiting: Bool            // this node has a pending approval
  public var descendantWaiting: Bool  // bubbled up for collapsed ancestors
  public var children: [AgentNode]
  public var childrenOrNil: [AgentNode]? { children.isEmpty ? nil : children }   // for OutlineGroup
  /// This node's id and every descendant's, depth first.
  public var subtreeIds: [String] { [id] + children.flatMap(\.subtreeIds) }
  public var iconTint: Tint { waiting ? .amber : status == .running ? .blue : status == .failed ? .red : .grey }
  public var statusSymbol: StepStatus? {
    if waiting { return .waiting }
    switch status { case .running: return .running; case .failed: return .failed; case .pending: return .queued; case .paused: return .paused; default: return nil }
  }
  /// VoiceOver label per SPEC §8.
  public var accessibilityLabel: String {
    let state = waiting ? "waiting for approval" : status.rawValue.replacingOccurrences(of: "-", with: " ")
    return ([name + (suffix.map { " \($0)" } ?? ""), repo, state, "level \(depth + 1)"] as [String?]).compactMap { $0 }.joined(separator: ", ")
  }
}

/// One column of the outline's hairline guides (tree-card-v3 `.gd`): nothing, a line through, a tee into this row,
/// or an elbow for a last child.
public enum TreeGuide: Sendable, Hashable { case blank, line, tee, elbow }

/// A visible row of the agent outline: its guide columns (one per level above it) and the columns for whatever sits
/// under the row (its approval or activity line), where ancestors' lines carry on.
public struct TreeLine: Sendable, Hashable, Identifiable {
  public var id: String { node.id }
  public var node: AgentNode
  public var guides: [TreeGuide]
  public var below: [TreeGuide]
  public var collapsed: Bool
}

extension Array where Element == AgentNode {
  /// The visible outline, depth first. `collapsed` hides a node's children (its row stays, with a closed chevron).
  public func outline(collapsed: Set<String>) -> [TreeLine] {
    var out: [TreeLine] = []
    func walk(_ nodes: [AgentNode], _ prefix: [TreeGuide], root: Bool) {
      for (i, n) in nodes.enumerated() {
        let last = i == nodes.count - 1
        let shut = collapsed.contains(n.id)
        let own: [TreeGuide] = root ? [] : prefix + [last ? .elbow : .tee]
        let through: [TreeGuide] = root ? [] : prefix + [last ? .blank : .line]
        // Under an open parent, its children's column already runs down to them.
        let below = through + (shut || n.children.isEmpty ? [] : [.line])
        out.append(TreeLine(node: n, guides: own, below: below, collapsed: shut))
        if !shut { walk(n.children, through, root: false) }
      }
    }
    walk(self, [], root: true)
    return out
  }

  /// Distinct folders across the outline: row chips are only worth showing when there is more than one.
  public var folders: Set<String> { Set(flatMap { [$0.repo].compactMap { $0 } + $0.children.folders }) }
}

/// One `run.*` lifecycle event (run.started/paused/resumed/completed/failed/cancelled/deleted).
public struct RunTransition: Sendable, Hashable {
  public var type: String
  /// LifecycleCause (trusted daemon code), e.g. "all_agents_done".
  public var cause: String?
  public var agentId: String?
  public var seq: Int
  public var epochMs: Int
  /// run.state after this transition.
  public var state: String { Self.state(for: type) ?? "running" }
  public static func state(for type: String) -> String? {
    switch type {
    case "run.started", "run.resumed": "running"
    case "run.paused": "paused"
    case "run.completed": "completed"
    case "run.failed": "failed"
    case "run.cancelled": "cancelled"
    case "run.deleted": "deleted"
    default: nil
    }
  }
}

/// Daemon-stored attachment metadata (`taskAttachment`, `message.sent.attachment`). Never fetched or opened here.
public struct AttachmentRef: Sendable, Hashable {
  public var id: String; public var bytes: Int; public var mediaType: String
  public init(id: String, bytes: Int, mediaType: String) { self.id = id; self.bytes = bytes; self.mediaType = mediaType }
  public init?(_ v: JSONValue?) {
    guard let v, let id = v["id"]?.string else { return nil }
    self.init(id: id, bytes: v["bytes"]?.int ?? 0, mediaType: v["mediaType"]?.string ?? "text/plain")
  }
  /// "Full text stored · 12 KB" (client-composed; mediaType is shown via UntrustedText by the caller if at all).
  public var label: String {
    let kb = bytes >= 1024 ? "\(bytes / 1024) KB" : "\(bytes) bytes"
    return "Full text stored · \(kb)"
  }
}

/// Something the user should hear about (macOS notification), raised only for live lifecycle events.
public enum Notice: Sendable, Hashable {
  case approvalRequested(approvalId: String, runId: String?, question: UntrustedText)
  case runFinished(runId: String, type: String, title: String)
}
