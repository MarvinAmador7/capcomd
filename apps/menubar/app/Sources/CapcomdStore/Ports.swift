import Foundation
import CapcomdThread

/// Server's decision record (200 body, and `Error.decision` on 409 already_decided).
public struct DecisionRecord: Codable, Sendable, Hashable {
  public var approvalId: String
  public var status: String
  public var decidedBy: By?
  public var decidedAt: String?
  public var reason: String?
  public struct By: Codable, Sendable, Hashable { public var clientId: String; public var principal: String
    public init(clientId: String, principal: String) { self.clientId = clientId; self.principal = principal } }
  public init(approvalId: String, status: String, decidedBy: By? = nil, decidedAt: String? = nil, reason: String? = nil) {
    self.approvalId = approvalId; self.status = status; self.decidedBy = decidedBy; self.decidedAt = decidedAt; self.reason = reason
  }
}

public enum DecideOutcome: Sendable, Hashable {
  case decided(DecisionRecord)
  /// 409 `already_decided`: someone else (or an earlier key) decided first; carries the existing decision.
  case alreadyDecided(DecisionRecord?)
  /// 409 `idempotency_conflict`: this key was used with a different body.
  case idempotencyConflict(String)
}

/// `POST /v1/approvals/{id}/decision` with `Idempotency-Key`. Throwing means transport failure (safe to retry with the same key).
public protocol ApprovalDeciding: Sendable {
  func decide(approvalId: String, decision: ApprovalDecision, idempotencyKey: String) async throws -> DecideOutcome
}

public protocol SubscriptionHandle: Sendable { func cancel() }

/// Opens `GET /v1/streams/{scope}/events` resuming after `after`, delivering parsed frames in order.
public protocol StreamSubscribing: Sendable {
  func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle
  /// `feed: "lifecycle"` opens `?feed=lifecycle&activity=1` (run scopes only): snapshot, then run/agent/approval lifecycle
  /// events plus live, ephemeral `agent.activity_changed` frames.
  func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle
  /// `thread: true` adds `&thread=1`: live, ephemeral `agent.thread_item_changed` frames for every agent of the run.
  func subscribe(scope: String, feed: String?, thread: Bool, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle
}
public extension StreamSubscribing {
  func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    feed == nil ? subscribe(scope: scope, after: after, onFrame: onFrame) : NoSubscription()
  }
  func subscribe(scope: String, feed: String?, thread: Bool, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    subscribe(scope: scope, feed: feed, after: after, onFrame: onFrame)
  }
}
struct NoSubscription: SubscriptionHandle { func cancel() {} }

/// Thrown by adapters when the daemon answers 401; the app reopens the token prompt.
public struct Unauthorized: Error, Sendable { public init() {} }

/// Tiny persistence seam for UI choices (UserDefaults on macOS, in-memory in tests).
public protocol PreferenceStoring: AnyObject { func string(forKey: String) -> String?; func set(_ v: String?, forKey: String) }
public final class InMemoryPreferences: PreferenceStoring {
  var d: [String: String] = [:]
  public init() {}
  public func string(forKey k: String) -> String? { d[k] }
  public func set(_ v: String?, forKey k: String) { d[k] = v }
}

public enum DrillView: String, Sendable { case activity, trace }
/// The drill-down's lower pane: one of Log or Files at a time (remembered).
public enum DetailTab: String, Sendable { case log, files }

/// Remembered UI choices (SPEC §4.3: Activity · Trace remembered globally; strip collapse remembered per user).
public final class UIPreferences {
  let store: PreferenceStoring
  public init(store: PreferenceStoring) { self.store = store }
  public var drillView: DrillView {
    get { store.string(forKey: "drillView").flatMap(DrillView.init(rawValue:)) ?? .activity }
    set { store.set(newValue.rawValue, forKey: "drillView") }
  }
  public var detailTab: DetailTab {
    get { store.string(forKey: "detailTab").flatMap(DetailTab.init(rawValue:)) ?? .log }
    set { store.set(newValue.rawValue, forKey: "detailTab") }
  }
  /// The project folder last used to start a run when the daemon had no default repository.
  public var startRepo: String? {
    get { store.string(forKey: "startRepo") }
    set { store.set(newValue, forKey: "startRepo") }
  }
  public var activityCollapsed: Bool {
    get { store.string(forKey: "activityCollapsed") == "1" }
    set { store.set(newValue ? "1" : "0", forKey: "activityCollapsed") }
  }
}

/// REST reads behind the drill-down (`GET /v1/runs/{runId}/trace`, `…/agents/{agentId}/transcript`, `…/files`). Throws
/// `DetailUnavailable` (`.unsupported` when the daemon predates the route) or `Unauthorized`.
public protocol RunDetailFetching: Sendable {
  func trace(runId: String) async throws -> [TraceSpan]
  func transcript(runId: String, agentId: String, after: Int?, limit: Int) async throws -> TranscriptPage
  func files(runId: String) async throws -> RunFiles
}

/// Agent threads (harness #59): `GET /v1/runs/{runId}/agents/{agentId}/thread` pages, and the bytes behind media.
/// Throws `DetailUnavailable` (`.unsupported` when the daemon predates the route) or `Unauthorized`.
public protocol ThreadFetching: Sendable {
  func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page
  /// `GET /v1/runs/{runId}/attachments/{id}/content`.
  func attachment(runId: String, id: String) async throws -> Data
  /// `GET /v1/runs/{runId}/agents/{agentId}/workspace?path=`.
  func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data
}

/// `POST /v1/runs/{runId}/{pause|resume|cancel}` with `Idempotency-Key` (steer scope).
public enum RunControl: String, Sendable, Hashable { case pause, resume, cancel }
/// The daemon said no (409 `conflict`: nothing to pause, nothing left to cancel); `message` is its plain sentence.
public struct ControlRefused: Error, Sendable, Hashable { public var message: String; public init(_ m: String) { message = m } }
public protocol RunControlling: Sendable {
  func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws
}

/// `POST /v1/runs` (harness #49): start a run on a goal, detached, with an Idempotency-Key (steer scope). Returns the
/// new run's id. A 422 is `StartRefused` with the daemon's sentence (`needsRepo` when it has no default repository).
public struct StartRefused: Error, Sendable, Hashable {
  public var message: String; public var needsRepo: Bool
  public init(_ m: String, needsRepo: Bool = false) { message = m; self.needsRepo = needsRepo }
}
public protocol RunStarting: Sendable {
  func start(goal: String, repo: String?, idempotencyKey: String) async throws -> String
}

/// `POST /v1/runs/{runId}/agents/{agentId}/messages` (harness #50, steer scope) with `Idempotency-Key`. `skills` rides
/// along only when the daemon advertises `steer.skills`. Returns the message seq the confirming `message.sent` carries.
public struct SentMessage: Sendable, Hashable { public var seq: Int; public var note: String?; public init(seq: Int, note: String?) { self.seq = seq; self.note = note } }
public struct MessageRefused: Error, Sendable, Hashable { public var message: String; public init(_ m: String) { message = m } }
public protocol AgentMessaging: Sendable {
  func send(runId: String, agentId: String, body: String, skills: [String], idempotencyKey: String) async throws -> SentMessage
}

/// `GET /v1/skills` entry: name and description from SKILL.md frontmatter, `source` bundled or user.
public struct SkillInfo: Codable, Sendable, Hashable, Identifiable {
  public var id: String { name }
  public var name: String; public var description: String; public var source: String
  public init(name: String, description: String, source: String) { self.name = name; self.description = description; self.source = source }
}
/// What the daemon can do beyond the base contract (`GET /v1/health` `capabilities`, absent on older daemons), and
/// its skills list.
public protocol DaemonInfoFetching: Sendable {
  func capabilities() async throws -> Set<String>
  func skills() async throws -> [SkillInfo]
}
