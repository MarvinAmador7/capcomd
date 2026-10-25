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
  /// `feed: "lifecycle"` opens `?feed=lifecycle` (run scopes only): snapshot, then run/agent/approval lifecycle events.
  func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle
}
public extension StreamSubscribing {
  func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    feed == nil ? subscribe(scope: scope, after: after, onFrame: onFrame) : NoSubscription()
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

/// Remembered UI choices (SPEC §4.3: Activity · Trace remembered globally; strip collapse remembered per user).
public final class UIPreferences {
  let store: PreferenceStoring
  public init(store: PreferenceStoring) { self.store = store }
  public var drillView: DrillView {
    get { store.string(forKey: "drillView").flatMap(DrillView.init(rawValue:)) ?? .activity }
    set { store.set(newValue.rawValue, forKey: "drillView") }
  }
  public var activityCollapsed: Bool {
    get { store.string(forKey: "activityCollapsed") == "1" }
    set { store.set(newValue ? "1" : "0", forKey: "activityCollapsed") }
  }
}
