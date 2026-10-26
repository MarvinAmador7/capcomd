import CapcomdClient
import CapcomdStore
import Foundation

/// SSE subscription per scope on `GET /v1/streams/{scope}/events` over the CapcomdClient Unix-socket transport.
/// Contract handling: Last-Event-ID resume; `stream.reset` → `snapshot.*` → `snapshot.end` arrive in-band on the same
/// connection (the store drops local state and applies the snapshot; the cursor jumps to snapshotSeq); `: heartbeat`
/// every 15s, so `idleTimeout` (default 45s) of silence is a dead socket and we reconnect. No retry on HTTP errors.
public final class LiveSubscriber: StreamSubscribing, @unchecked Sendable {
  let transport: UnixSocketTransport
  let maxReconnects: Int; let backoff: Duration; let idleTimeout: Duration
  public init(transport: UnixSocketTransport, maxReconnects: Int = 10, backoff: Duration = .milliseconds(500), idleTimeout: Duration = .seconds(45)) {
    self.transport = transport; self.maxReconnects = maxReconnects; self.backoff = backoff; self.idleTimeout = idleTimeout
  }
  final class Handle: SubscriptionHandle, @unchecked Sendable { var task: Task<Void, Never>?; func cancel() { task?.cancel() } }

  public func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    subscribe(scope: scope, feed: nil, after: after, onFrame: onFrame)
  }

  /// Resume cursor = last SSE `id:` seen, never an envelope seq: in a shared-seq group only the last frame has an id, so a
  /// cut mid-group resumes before the group and the store drops the re-sent members by envelope id.
  public func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    let path = "/v1/streams/\(scope)/events" + (feed.map { "?feed=\($0)" } ?? "")
    let h = Handle(); let t = transport, maxR = maxReconnects, bo = backoff, idle = idleTimeout
    h.task = Task {
      var last = after, attempts = 0
      while !Task.isCancelled {
        do {
          for try await item in t.sseItems(path, lastEventID: last > 0 ? String(last) : nil, idleTimeout: idle) {
            guard case .frame(let f) = item else { continue } // heartbeat: activity only
            let frame = StreamFrame.parse(event: f.event, data: f.data)
            if case .snapshotEnd(let s) = frame, f.id == nil { last = s; attempts = 0 }
            await onFrame(frame)
            if let id = f.id, let n = Int(id) { last = n; attempts = 0; await onFrame(.cursor(n)) }
          }
          return // clean close: stream finished
        } catch let e as HTTPStatusError { if e.status == 401 { await onFrame(.unauthorized) }; return }
        catch is CancellationError { return }
        catch {
          if Task.isCancelled { return }
          attempts += 1; if attempts > maxR { return }
          try? await Task.sleep(for: liveBackoff(base: bo, attempt: attempts))
        }
      }
    }
    return h
  }
}

/// `POST /v1/approvals/{id}/decision` through the generated client (`approvals.decide`): Idempotency-Key header,
/// 409 bodies decoded as the generated `Error` schema (`already_decided` carries `decision`).
public struct LiveDecider: ApprovalDeciding {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func decide(approvalId: String, decision: ApprovalDecision, idempotencyKey: String) async throws -> DecideOutcome {
    let api = try transport.openAPIClient()
    let out = try await api.approvals_period_decide(.init(path: .init(approvalId: approvalId), headers: .init(idempotency_hyphen_key: idempotencyKey),
                                                          body: .json(.init(decision: decision == .approve ? .approve : .deny))))
    switch out {
    case .ok(let ok):
      let r = try ok.body.json
      return .decided(DecisionRecord(approvalId: r.approvalId, status: r.status.rawValue, decidedBy: r.decidedBy.map { DecisionRecord.By(clientId: $0.clientId, principal: $0.principal) },
                                     decidedAt: r.decidedAt.map(HarnessTime.string), reason: r.reason))
    case .conflict(let c):
      let e = try c.body.json
      switch e.code {
      case .already_decided:
        return .alreadyDecided(e.decision.map { d in DecisionRecord(approvalId: d.approvalId, status: d.status.rawValue,
          decidedBy: d.decidedBy.map { DecisionRecord.By(clientId: $0.clientId, principal: $0.principal) }, decidedAt: d.decidedAt.map(HarnessTime.string)) })
      default: return .idempotencyConflict(e.message)
      }
    case .unauthorized: throw Unauthorized()
    case .notFound: throw HTTPStatusError(status: 404)
    case .unprocessableContent: throw HTTPStatusError(status: 422)
    case .undocumented(let code, _): throw HTTPStatusError(status: code)
    }
  }
}

/// Exponential backoff with full jitter: a random delay in [0, min(cap, base * 2^(attempt-1))].
/// Spreads reconnects out after an engine restart instead of every client hammering it at once.
func liveBackoff(base: Duration, attempt: Int, cap: Duration = .seconds(30)) -> Duration {
  func ms(_ d: Duration) -> Double { Double(d.components.seconds) * 1000 + Double(d.components.attoseconds) / 1e15 }
  let ceiling = min(ms(cap), ms(base) * pow(2, Double(max(0, min(attempt - 1, 30)))))
  return .microseconds(Int64(Double.random(in: 0...max(0, ceiling)) * 1000))
}
