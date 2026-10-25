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
  /// Repo, if capcomd ever sends one (not in contract 7b4cb74; read from `repo` or `agent.repo` when present).
  public var repo: String?
  public var spawnedAtMs: Int
  /// Plain-language status line from agents.tree / snapshot.agents `text` (daemon-written, trusted). Shown as the activity line.
  public var activity: String? = nil
  /// `taskAttachment`: the full task is stored by the daemon; only its metadata is shown.
  public var taskAttachment: AttachmentRef? = nil
  /// `result.summary` once the agent finished (agent-written, untrusted).
  public var resultSummary: UntrustedText? = nil
  public var kind: ProfileKind { ProfileKind(profile: profile) }
  /// Profile names stay lowercase as the contract sends them ("lead"); nil → "agent".
  public var displayName: String {
    guard let p = profile, !p.isEmpty else { return "agent" }
    return p
  }
}

public enum StepStatus: Sendable, Hashable { case done, running, failed, queued, waiting
  /// SPEC §5 status symbols. Done has none.
  public var symbol: String? {
    switch self { case .done: nil; case .running: "smallcircle.filled.circle"; case .failed: "xmark.circle"; case .queued: "clock"; case .waiting: "hand.raised" }
  }
  public var tint: Tint { switch self { case .done: .grey; case .running: .blue; case .failed: .red; case .queued: .tertiary; case .waiting: .amber } }
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
}

public struct Project: Sendable, Hashable, Identifiable {
  public var id: String
  /// Title = goal of its most recent run (contract has no project goal; gap G1).
  public var goal: UntrustedText?
  public var runs: [Run]
  public var title: String { goal?.firstLine ?? runs.first?.title ?? id }
  public var isRunning: Bool { runs.contains(where: \.isRunning) }
  public var lastEventMs: Int { runs.map(\.lastEventMs).max() ?? 0 }
}

/// Display node for the outline tree.
public struct AgentNode: Sendable, Hashable, Identifiable {
  public var id: String
  public var name: String
  /// Mono tertiary suffix when sibling profiles repeat: repo, else short task id, else last 4 of agentId.
  public var suffix: String?
  public var kind: ProfileKind
  public var status: AgentStatus
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
  public var iconTint: Tint { waiting ? .amber : status == .running ? .blue : status == .failed ? .red : .grey }
  public var statusSymbol: StepStatus? {
    if waiting { return .waiting }
    switch status { case .running: return .running; case .failed: return .failed; case .pending: return .queued; default: return nil }
  }
  /// VoiceOver label per SPEC §8.
  public var accessibilityLabel: String {
    let state = waiting ? "waiting for approval" : status.rawValue.replacingOccurrences(of: "-", with: " ")
    return [name + (suffix.map { " \($0)" } ?? ""), state, "level \(depth + 1)"].joined(separator: ", ")
  }
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
