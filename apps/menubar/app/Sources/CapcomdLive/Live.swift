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
  public init(transport: UnixSocketTransport, maxReconnects: Int = 10, backoff: Duration = .milliseconds(50), idleTimeout: Duration = .seconds(45)) {
    self.transport = transport; self.maxReconnects = maxReconnects; self.backoff = backoff; self.idleTimeout = idleTimeout
  }
  final class Handle: SubscriptionHandle, @unchecked Sendable { var task: Task<Void, Never>?; func cancel() { task?.cancel() } }

  public func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    subscribe(scope: scope, feed: nil, after: after, onFrame: onFrame)
  }

  /// Resume cursor = last SSE `id:` seen, never an envelope seq: in a shared-seq group only the last frame has an id, so a
  /// cut mid-group resumes before the group and the store drops the re-sent members by envelope id.
  public func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    let path = "/v1/streams/\(scope)/events" + (feed.map { "?feed=\($0)&activity=1" } ?? "")
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
          try? await Task.sleep(for: bo * attempts)
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

/// The drill-down's REST reads. A 404 from a route the daemon doesn't have yet (files before harness #47) is
/// `.unsupported`, so the view can say so instead of showing an error.
public struct LiveDetail: RunDetailFetching {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  func get<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
    do { return try await transport.getJSON(path, as: T.self) }
    catch let e as HTTPStatusError {
      switch e.status { case 401: throw Unauthorized(); case 404: throw DetailUnavailable.unsupported; default: throw DetailUnavailable.failed("HTTP \(e.status)") }
    }
    catch is DecodingError { throw DetailUnavailable.failed("unexpected response") }
  }
  static func seg(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed.subtracting(CharacterSet(charactersIn: "/"))) ?? s }
  public func trace(runId: String) async throws -> [TraceSpan] { try await get("/v1/runs/\(Self.seg(runId))/trace", as: [TraceSpan].self) }
  public func transcript(runId: String, agentId: String, after: Int?, limit: Int) async throws -> TranscriptPage {
    try await get("/v1/runs/\(Self.seg(runId))/agents/\(Self.seg(agentId))/transcript?limit=\(limit)" + (after.map { "&after=\($0)" } ?? ""), as: TranscriptPage.self)
  }
  public func files(runId: String) async throws -> RunFiles { try await get("/v1/runs/\(Self.seg(runId))/files", as: RunFiles.self) }
}

/// `POST /v1/runs/{runId}/{pause|resume|cancel}` (harness #50): Idempotency-Key, steer scope. 409 `conflict` carries
/// the daemon's sentence ("nothing is running to pause"); 404 on the route means this daemon predates it.
public struct LiveControls: RunControlling {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws {
    let (status, body) = try await transport.post("/v1/runs/\(LiveDetail.seg(runId))/\(action.rawValue)", headers: [("Idempotency-Key", idempotencyKey)])
    let err = try? JSONDecoder().decode([String: String].self, from: body)
    switch status {
    case 200: return
    case 401: throw Unauthorized()
    case 403: throw ControlRefused("This app's capcomd token can't control runs (needs the steer scope)")
    case 404 where err?["code"] == "not_found" && (err?["message"] ?? "").contains("run "): throw ControlRefused(err?["message"] ?? "run not found")
    case 404: throw DetailUnavailable.unsupported
    case 409: throw ControlRefused(err?["message"] ?? "capcomd refused")
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}
