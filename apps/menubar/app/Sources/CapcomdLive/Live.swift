import CapcomdClient
import CapcomdStore
import CapcomdThread
import Foundation

/// SSE subscription per scope on `GET /v1/streams/{scope}/events` over the CapcomdClient Unix-socket transport.
/// Contract handling: Last-Event-ID resume; `stream.reset` → `snapshot.*` → `snapshot.end` arrive in-band on the same
/// connection (the store drops local state and applies the snapshot; the cursor jumps to snapshotSeq); `: heartbeat`
/// every 15s, so `idleTimeout` (default 45s) of silence is a dead socket and we reconnect. A feed must outlive the
/// daemon: a clean close (daemon restart, a cut connection), a 5xx or a transport error reconnects from the cursor,
/// backing off up to `maxBackoff`, for as long as the subscription lives. Only 401 (bad token) and 404 (no such
/// scope) end it.
public final class LiveSubscriber: StreamSubscribing, @unchecked Sendable {
  let transport: UnixSocketTransport
  let backoff: Duration; let maxBackoff: Duration; let idleTimeout: Duration
  public init(transport: UnixSocketTransport, backoff: Duration = .milliseconds(50), maxBackoff: Duration = .seconds(5), idleTimeout: Duration = .seconds(45)) {
    self.transport = transport; self.backoff = backoff; self.maxBackoff = maxBackoff; self.idleTimeout = idleTimeout
  }
  final class Handle: SubscriptionHandle, @unchecked Sendable { var task: Task<Void, Never>?; func cancel() { task?.cancel() } }

  public func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    subscribe(scope: scope, feed: nil, after: after, onFrame: onFrame)
  }

  /// Resume cursor = last SSE `id:` seen, never an envelope seq: in a shared-seq group only the last frame has an id, so a
  /// cut mid-group resumes before the group and the store drops the re-sent members by envelope id.
  public func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    subscribe(scope: scope, feed: feed, thread: false, after: after, onFrame: onFrame)
  }

  public func subscribe(scope: String, feed: String?, thread: Bool, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle {
    let query = (feed.map { ["feed=\($0)", "activity=1"] } ?? []) + (thread ? ["thread=1"] : [])
    let path = "/v1/streams/\(scope)/events" + (query.isEmpty ? "" : "?" + query.joined(separator: "&"))
    let h = Handle(); let t = transport, bo = backoff, cap = maxBackoff, idle = idleTimeout
    h.task = Task {
      var last = after, attempts = 0, down = false
      while !Task.isCancelled {
        do {
          for try await item in t.sseItems(path, lastEventID: last > 0 ? String(last) : nil, idleTimeout: idle) {
            attempts = 0   // anything from the daemon, heartbeats included, means it's up
            if down { down = false; await onFrame(.link(up: true)) }
            guard case .frame(let f) = item else { continue } // heartbeat: activity only
            let frame = StreamFrame.parse(event: f.event, data: f.data)
            if case .snapshotEnd(let s) = frame, f.id == nil { last = s }
            await onFrame(frame)
            if let id = f.id, let n = Int(id) { last = n; await onFrame(.cursor(n)) }
          }
          // Clean close (daemon restart or a cut connection): reconnect from the cursor below.
        } catch let e as HTTPStatusError {
          if e.status == 401 { await onFrame(.unauthorized); return }
          if e.status == 404 { return }   // no such scope (a deleted run): nothing to follow
        } catch is CancellationError { return }
        catch { if Task.isCancelled { return } }
        attempts += 1
        if attempts >= 2, !down { down = true; await onFrame(.link(up: false)) }   // not on one quick reconnect
        try? await Task.sleep(for: min(bo * attempts * attempts, cap))
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

/// Agent threads (harness #59). Pages are at most 100 items (each up to 64 KB of blocks plus its text), read with a 16 MB
/// cap; media is at most 5 MB on the daemon's side.
public struct LiveThread: ThreadFetching {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
    let path = "/v1/runs/\(LiveDetail.seg(runId))/agents/\(LiveDetail.seg(agentId))/thread?after=\(after)&limit=\(limit)"
    do { return try await transport.getJSON(path, as: CapcomdThread.Page.self, maxBytes: 16 << 20) }
    catch let e as HTTPStatusError {
      switch e.status { case 401: throw Unauthorized(); case 404: throw DetailUnavailable.unsupported; default: throw DetailUnavailable.failed("HTTP \(e.status)") }
    }
    catch is DecodingError { throw DetailUnavailable.failed("unexpected response") }
  }
  public func attachment(runId: String, id: String) async throws -> Data {
    try await bytes("/v1/runs/\(LiveDetail.seg(runId))/attachments/\(LiveDetail.seg(id))/content")
  }
  public func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data {
    let q = path.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~/"))) ?? path
    return try await bytes("/v1/runs/\(LiveDetail.seg(runId))/agents/\(LiveDetail.seg(agentId))/workspace?path=\(q)")
  }
  func bytes(_ path: String) async throws -> Data {
    let (status, data) = try await transport.get(path, maxBytes: 6 << 20)
    switch status {
    case 200: return data
    case 401: throw Unauthorized()
    case 404: throw DetailUnavailable.failed("not found")
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}

/// `POST /v1/runs/{runId}/{pause|resume|cancel}` (harness #50): Idempotency-Key, steer scope. 409 `conflict` carries
/// the daemon's sentence ("nothing is running to pause"); 404 on the route means this daemon predates it.
public struct LiveControls: RunControlling {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws {
    try await post("/v1/runs/\(LiveDetail.seg(runId))/\(action.rawValue)", action, idempotencyKey)
  }
  public func control(runId: String, agentId: String, _ action: RunControl, idempotencyKey: String) async throws {
    guard action != .cancel else { throw ControlRefused("An agent can be paused or resumed, not stopped on its own") }
    try await post("/v1/runs/\(LiveDetail.seg(runId))/agents/\(LiveDetail.seg(agentId))/\(action.rawValue)", action, idempotencyKey)
  }
  func post(_ path: String, _ action: RunControl, _ idempotencyKey: String) async throws {
    let (status, body) = try await transport.post(path, headers: [("Idempotency-Key", idempotencyKey)])
    let err = try? JSONDecoder().decode([String: String].self, from: body)
    switch status {
    case 200: return
    case 401: throw Unauthorized()
    case 403: throw ControlRefused("This app's capcomd token can't control runs (needs the steer scope)")
    case 404 where err?["code"] == "not_found" && ["run ", "agent "].contains(where: { (err?["message"] ?? "").contains($0) }): throw ControlRefused(err?["message"] ?? "not found")
    case 404: throw DetailUnavailable.unsupported
    case 409: throw ControlRefused(err?["message"] ?? "capcomd refused")
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}

/// `POST /v1/runs` (harness #49): 201 with the run; 422 `invalid` carries the daemon's sentence, and "repo is required"
/// means it has no default repository, so the app asks for a project folder.
public struct LiveStarter: RunStarting {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func start(goal: String, choice c: RunChoice, idempotencyKey: String) async throws -> String {
    var body: [String: String] = ["goal": goal]
    if let v = c.repo { body["repo"] = v }; if let v = c.driver { body["driver"] = v }
    if let v = c.sandbox { body["sandbox"] = v }; if let v = c.effort { body["effort"] = v }
    let (status, data) = try await transport.post("/v1/runs", headers: [("Idempotency-Key", idempotencyKey)], json: try JSONEncoder().encode(body))
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = obj?["message"] as? String ?? "capcomd refused"
    switch status {
    case 200, 201: if let id = obj?["id"] as? String { return id }; throw DetailUnavailable.failed("unexpected response")
    case 401: throw Unauthorized()
    case 403: throw StartRefused("This app's capcomd token can't start runs (needs the steer scope)")
    case 404: throw DetailUnavailable.unsupported
    case 409, 422: throw StartRefused(message, needsRepo: message.hasPrefix("repo is required"))
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}

/// `POST /v1/runs/{runId}/agents/{agentId}/messages` (harness #50). 409 `conflict` (the agent has ended) and 422 carry
/// the daemon's sentence; a 404 that names the run or agent is a refusal, any other 404 means the route is missing.
public struct LiveMessenger: AgentMessaging {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func send(runId: String, agentId: String, body: String, skills: [String], idempotencyKey: String) async throws -> SentMessage {
    var payload: [String: Any] = ["body": body]; if !skills.isEmpty { payload["skills"] = skills }
    let path = "/v1/runs/\(LiveDetail.seg(runId))/agents/\(LiveDetail.seg(agentId))/messages"
    let (status, data) = try await transport.post(path, headers: [("Idempotency-Key", idempotencyKey)], json: try JSONSerialization.data(withJSONObject: payload))
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = obj?["message"] as? String ?? "capcomd refused"
    switch status {
    case 200, 201:
      guard let seq = obj?["seq"] as? Int else { throw DetailUnavailable.failed("unexpected response") }
      return SentMessage(seq: seq, note: obj?["note"] as? String)
    case 401: throw Unauthorized()
    case 403: throw MessageRefused("This app's capcomd token can't send messages (needs the steer scope)")
    case 404 where (obj?["code"] as? String) == "not_found" && (message.hasPrefix("run ") || message.hasPrefix("agent ")): throw MessageRefused(message)
    case 404: throw DetailUnavailable.unsupported
    case 409, 422: throw MessageRefused(message)
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}

/// `GET /v1/health` (`capabilities`, absent on older daemons) and `GET /v1/skills`.
public struct LiveDaemonInfo: DaemonInfoFetching {
  let transport: UnixSocketTransport
  public init(transport: UnixSocketTransport) { self.transport = transport }
  public func capabilities() async throws -> Set<String> { try await health().capabilities }
  public func health() async throws -> DaemonHealth {
    let (s, d) = try await transport.get("/v1/health")
    guard s == 200 else { return DaemonHealth() }
    return SettingsWire.health(d)
  }
  /// `GET /v1/logins` (capability `logins`).
  public func logins() async throws -> [LoginInfo] { let d = try await settingsGet("/v1/logins"); return try decoded(SettingsWire.logins(d)) }
  /// `GET /v1/environments` (capability `environments`).
  public func environments() async throws -> [EnvironmentInfo] { let d = try await settingsGet("/v1/environments"); return try decoded(SettingsWire.environments(d)) }
  /// `GET /v1/service` (capability `service`).
  public func service() async throws -> ServiceInfo { let d = try await settingsGet("/v1/service"); return try decoded(SettingsWire.service(d)) }
  /// `GET /v1/sandboxes` (capability `sandboxes`).
  public func sandboxes() async throws -> [SandboxDescriptor] { let d = try await settingsGet("/v1/sandboxes"); return try decoded(SandboxWire.sandboxes(d)) }
  /// `GET /v1/sandboxes/{name}`.
  public func sandbox(_ name: String) async throws -> SandboxDetail {
    let d = try await settingsGet("/v1/sandboxes/\(LiveDetail.seg(name))"); return try decoded(SandboxWire.detail(d))
  }
  /// `GET /v1/sandboxes/{name}/resources?limit=200` (capability `sandboxes.resources`): the last list the daemon got from
  /// the provider (cached there, so cheap to poll).
  public func resources(sandbox: String) async throws -> ResourcePage {
    let d = try await settingsGet("/v1/sandboxes/\(LiveDetail.seg(sandbox))/resources?limit=200"); return try decoded(SandboxWire.resources(d))
  }
  /// `GET /v1/sandboxes/{name}/resources/{id}`: one machine and its `terminalCommand`. The route exists (the caller checked
  /// the capability), so a 404 means the machine is gone.
  public func resource(sandbox: String, id: String) async throws -> ResourceDetail {
    let d: Data
    do { d = try await settingsGet("/v1/sandboxes/\(LiveDetail.seg(sandbox))/resources/\(LiveDetail.seg(id))") }
    catch DetailUnavailable.unsupported { throw DetailUnavailable.failed(SandboxRows.gone) }
    return try decoded(SandboxWire.resource(d))
  }
  /// `PATCH /v1/sandboxes/{name}/settings` (capability `sandboxes.settings`, scope `configure`): 200 is the place as
  /// `GET /v1/sandboxes/{name}` now answers; 403 the token lacks `configure`; 409 `conflict` carries the current `rev`;
  /// 422 `invalid` and 404 (no such place: the caller checked the capability, so the route exists) the daemon's sentence.
  public func updateSandboxSettings(_ name: String, values: [String: String], rev: String) async throws -> SandboxDetail {
    let body = try JSONSerialization.data(withJSONObject: ["values": values, "rev": rev] as [String: Any])
    let (status, data) = try await transport.patch("/v1/sandboxes/\(LiveDetail.seg(name))/settings", json: body)
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = (obj?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    switch status {
    case 200: return try decoded(SandboxWire.detail(data))
    case 401: throw Unauthorized()
    case 403: throw SettingsRefused.forbidden
    case 404, 422: throw SettingsRefused.invalid(message ?? "capcomd won't take that value")
    case 409: throw SettingsRefused.conflict(rev: (obj?["rev"] as? String) ?? (obj?["rev"] as? NSNumber)?.stringValue)
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
  /// `POST /v1/sandboxes/{name}/resources/{id}/actions/{action}` (capability `sandboxes.actions`, scope `steer`), no body,
  /// with `idempotencyKey`. 200 is `{resource, changed}`; every refusal carries the daemon's sentence (404 gone or not
  /// capcomd's, 409 it changed or is capcomd's own, 503 the provider didn't answer, 403 the token lacks steer).
  public func resourceAction(sandbox: String, id: String, action: String, idempotencyKey: String) async throws -> ResourceActionResult {
    let path = "/v1/sandboxes/\(LiveDetail.seg(sandbox))/resources/\(LiveDetail.seg(id))/actions/\(LiveDetail.seg(action))"
    let (status, data) = try await transport.post(path, headers: [("Idempotency-Key", idempotencyKey)])
    let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let message = (obj?["message"] as? String).flatMap { $0.isEmpty ? nil : $0 }
    switch status {
    case 200: return try decoded(SandboxWire.actionResult(data))
    case 401: throw Unauthorized()
    case 403: throw ActionRefused("This app's capcomd token can't delete machines (it needs the steer scope).", status: 403)
    case 404, 409, 422, 503: throw ActionRefused(message ?? "capcomd couldn't delete it.", status: status)
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
  private func decoded<T>(_ f: @autoclosure () throws -> T) throws -> T {
    do { return try f() } catch let e as DetailUnavailable { throw e } catch is Unauthorized { throw Unauthorized() } catch { throw DetailUnavailable.failed("unexpected response") }
  }
  private func settingsGet(_ path: String) async throws -> Data {
    let (status, data) = try await transport.get(path)
    switch status {
    case 200: return data
    case 401: throw Unauthorized()
    case 404: throw DetailUnavailable.unsupported
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
  public func skills() async throws -> [SkillInfo] {
    do { return try await transport.getJSON("/v1/skills", as: [SkillInfo].self) }
    catch let e as HTTPStatusError { if e.status == 401 { throw Unauthorized() }; throw e.status == 404 ? DetailUnavailable.unsupported : DetailUnavailable.failed("HTTP \(e.status)") }
  }
  /// `GET /v1/run-options[?repo=]`: `{drivers: [DriverInfo], sandboxes: [SandboxInfo]}`, for the project checkout
  /// `repo` (nil: the daemon's own). 422 (not a capcomd project): `MessageRefused` with the daemon's message.
  public func runOptions(repo: String?) async throws -> RunOptions {
    let path = repo.map { "/v1/run-options?repo=\($0.addingPercentEncoding(withAllowedCharacters: .alphanumerics.union(CharacterSet(charactersIn: "-._~/"))) ?? $0)" } ?? "/v1/run-options"
    let (status, data) = try await transport.get(path)
    switch status {
    case 200:
      do { return try JSONDecoder().decode(RunOptions.self, from: data) } catch { throw DetailUnavailable.failed("unexpected response") }
    case 401: throw Unauthorized()
    case 404: throw DetailUnavailable.unsupported
    case 422:
      let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
      throw MessageRefused((o?["message"] as? String) ?? "This folder isn't a capcomd project")
    default: throw DetailUnavailable.failed("HTTP \(status)")
    }
  }
}
