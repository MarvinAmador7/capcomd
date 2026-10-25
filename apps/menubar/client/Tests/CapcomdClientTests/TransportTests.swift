import XCTest
import Foundation
@testable import CapcomdClient

final class TransportTests: XCTestCase {
  static var server: Process!
  static let sock = NSTemporaryDirectory() + "capcomd-test-\(getpid()).sock"
  let token = "test-token"
  var transports: [UnixSocketTransport] = []
  func make(_ tok: String) -> UnixSocketTransport { let t = UnixSocketTransport(socketPath: Self.sock, token: tok); transports.append(t); return t }

  override func setUp() async throws {
    // Fresh server per test so the drop/reset script is deterministic.
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe") // real binary, not the sh shim (shim orphans bun on terminate)
    let mock = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../mock/server.ts").standardized.path
    p.arguments = [mock, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": token, "HEARTBEAT_MS": "100"]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); Self.server = p
    for _ in 0..<100 where !FileManager.default.fileExists(atPath: Self.sock) { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(100))
  }
  override func tearDown() async throws { for t in transports { try? await t.shutdown() }; transports = []; Self.server.terminate(); Self.server.waitUntilExit()
    // bun's launcher is a shell wrapper; make sure the real child is gone too.
    let k = Process(); k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); k.arguments = ["-f", Self.sock]; try? k.run(); k.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock) }

  func testSocketIs0600() throws {
    let a = try FileManager.default.attributesOfItem(atPath: Self.sock)
    XCTAssertEqual((a[.posixPermissions] as? NSNumber)?.intValue, 0o600)
  }

  func testAuthenticatedGET() async throws {
    let t = make(token)
    let api = try t.openAPIClient()
    let runs = try await api.runs_period_list(.init()).ok.body.json
    XCTAssertEqual(runs.map(\.id), ["run-demo"])
    let agents = try await api.agents_period_tree(.init(path: .init(runId: "run-demo"))).ok.body.json
    XCTAssertEqual(agents.first?.status, .running)
    let replay = try await api.events_period_replay(.init(query: .init(scope: "run-demo", after: 25))).ok.body.json
    XCTAssertEqual(replay.map(\.seq), [26, 27, 28, 29, 30])
    XCTAssertEqual(replay.first.map { HarnessTime.string($0.ts) }, "2026-10-25T06:00:26.000Z")
    let (_, raw) = try await make(token).get("/v1/events?scope=run-demo&after=25")
    XCTAssertTrue(String(decoding: raw, as: UTF8.self).contains(#""ts":"2026-10-25T06:00:26.000Z""#), "wire format is ….000Z")
    // apr-6 is the pending one. Same key + same body replays; same key + other body and a new key on a decided approval are 409 Error.
    func decide(_ key: String, _ d: Operations.approvals_period_decide.Input.Body.jsonPayload.decisionPayload) async throws -> Operations.approvals_period_decide.Output {
      try await api.approvals_period_decide(.init(path: .init(approvalId: "apr-6"), headers: .init(idempotency_hyphen_key: key), body: .json(.init(decision: d))))
    }
    let d1 = try await decide("key-aaaaaaaa", .approve).ok.body.json
    XCTAssertEqual(d1.status, .approved); XCTAssertNotNil(d1.decidedBy); XCTAssertNotNil(d1.decidedAt)
    XCTAssertNotNil(d1.decidedAt.map(HarnessTime.string)?.wholeMatch(of: try Regex(#"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"#)), "3-digit ms UTC")
    let d1b = try await decide("key-aaaaaaaa", .approve).ok.body.json; XCTAssertEqual(d1b.decidedAt, d1.decidedAt, "idempotent replay")
    let c1 = try await decide("key-aaaaaaaa", .deny).conflict.body.json
    XCTAssertEqual(c1.code, .idempotency_conflict)
    let c2 = try await decide("key-bbbbbbbb", .deny).conflict.body.json
    XCTAssertEqual(c2.code, .already_decided); XCTAssertEqual(c2.decision?.status, .approved)
    if case .unprocessableContent = try await decide("short", .approve) {} else { XCTFail("expected 422 for short key") }
  }

  func testBadTokenIs401() async throws {
    let t = make("wrong")
    let (s, _) = try await t.get("/v1/runs"); XCTAssertEqual(s, 401)
    let api = try t.openAPIClient()
    switch try await api.runs_period_list(.init()) {
    case .unauthorized(let u): XCTAssertEqual(try u.body.json.code, .unauthorized)
    case .undocumented(let code, _): XCTAssertEqual(code, 401)
    default: XCTFail("expected 401")
    }
    let es = ResumableEventStream(transport: t)
    do { try await es.run { _ in }; XCTFail("expected 401") } catch let e as HTTPStatusError { XCTAssertEqual(e.status, 401) }
  }

  /// Lifecycle feed: the mock cuts conn #1 after the first frame (no `id:`) of the seq-4 group {agent.started, run.started}.
  /// The cursor must stay at 2 (the last SSE id), conn #2 re-sends the whole group, and run.started is delivered once.
  func testLifecycleDropMidGroupDeliversRunEventOnce() async throws {
    let t = make(token)
    let es = ResumableEventStream(transport: t, scope: "run-demo", feed: "lifecycle")
    let box = Collector()
    try await es.run(until: { if case .event(let e) = $0 { return e.seq == 30 }; return false }) { await box.add($0) }
    let events = await box.items.compactMap { if case .event(let e) = $0 { return e }; return nil }
    let ids = events.map(\.id)
    XCTAssertEqual(ids.count, Set(ids).count, "no envelope delivered twice")
    XCTAssertEqual(events.filter { $0._type == "run.started" }.count, 1)
    XCTAssertEqual(events.filter { $0._type == "agent.started" && $0.agentId == "agt-1" }.count, 1)
    XCTAssertEqual(events.first { $0._type == "run.started" }?.id, "evt_run-demo_4_run.started")
    let stats = await es.stats
    XCTAssertEqual(stats.drops, 1); XCTAssertEqual(stats.dupesDropped, 1)   // the re-sent agent.started
    let last = await es.lastSeq; XCTAssertEqual(last, 30)
    let (_, raw) = try await make(token).get("/__log")
    let log = String(decoding: raw, as: UTF8.self)
    XCTAssertTrue(log.contains("lc1 after=none") && log.contains("lc2 after=2"), "resumed from the last SSE id, not the cut frame's seq: \(log)")
    XCTAssertEqual(events.map(\.seq).filter { $0 <= 1 }, [], "nothing at or below the snapshot")
  }

  func testResumeAfterResetAndDropHasNoGapsOrDupes() async throws {
    let t = make(token)
    let es = ResumableEventStream(transport: t)
    let box = Collector()
    try await es.run { await box.add($0) }
    let items = await box.items
    let seqs = items.compactMap { if case .event(let e) = $0 { return e.seq }; return nil }
    XCTAssertEqual(seqs, Array(1...30), "no gaps, no dupes")
    // In-band reset on conn #1 after seq 12: reset → snapshot.run/agents/approvals/steps/threads → snapshot.end, all before seq 13.
    let i = items.firstIndex(of: .reset(snapshotSeq: 12, reason: "overflow"))!
    let names = items[(i + 1)...].prefix(6).map { (it: StreamItem) -> String in
      switch it { case .snapshot(let n, _): return n; case .snapshotEnd: return "snapshot.end"; default: return "?" } }
    XCTAssertEqual(names, ["snapshot.run", "snapshot.agents", "snapshot.approvals", "snapshot.steps", "snapshot.threads", "snapshot.end"])
    if case .event(let e) = items[i + 7] { XCTAssertEqual(e.seq, 13) } else { XCTFail("live events resume at snapshotSeq+1") }
    let st = await es.stats
    XCTAssertEqual(st.resets, 1); XCTAssertEqual(st.drops, 1); XCTAssertEqual(st.connections, 2); XCTAssertEqual(st.dupesDropped, 1)
    let (_, logData) = try await t.get("/__log")
    print("server log:", String(decoding: logData, as: UTF8.self))
  }

  func testCompactedCursorGetsResetAndSnapshotAtHead() async throws {
    let es = ResumableEventStream(transport: make(token), startAfter: 1)
    let box = Collector()
    try await es.run { await box.add($0) }
    let items = await box.items
    XCTAssertEqual(items.first, .reset(snapshotSeq: 30, reason: "compacted"))
    XCTAssertEqual(items.last, .snapshotEnd(snapshotSeq: 30))
    let lastSeq = await es.lastSeq; XCTAssertEqual(lastSeq, 30)
  }

  func testHealthNeedsNoToken() async throws {
    let api = try make("wrong").openAPIClient()
    let h = try await api.health(.init()).ok.body.json
    XCTAssertEqual(h.ok, true); XCTAssertEqual(h.api, "harness.v1")
  }

  func testSilentSocketTimesOutButHeartbeatsKeepItAlive() async throws {
    let t = make(token)
    // run-silent sends nothing: two idle timeouts, then give up.
    let dead = ResumableEventStream(transport: t, scope: "run-silent", maxReconnects: 1, backoff: .milliseconds(10), idleTimeout: .milliseconds(300))
    do { try await dead.run { _ in }; XCTFail("expected idle timeout") } catch is SSEIdleTimeout {}
    let ds = await dead.stats; XCTAssertEqual(ds.idleTimeouts, 2); XCTAssertEqual(ds.connections, 2)
    // daemon sends only `: heartbeat` (HEARTBEAT_MS=100 in tests): stays alive past several idle windows.
    let live = ResumableEventStream(transport: t, scope: "daemon", maxReconnects: 0, idleTimeout: .milliseconds(300))
    let task = Task { try await live.run { _ in } }
    try await Task.sleep(for: .milliseconds(1200)); task.cancel()
    let ls = await live.stats
    XCTAssertEqual(ls.idleTimeouts, 0); XCTAssertEqual(ls.connections, 1); XCTAssertGreaterThanOrEqual(ls.heartbeats, 5)
  }

  func testSSEParserChunkBoundaries() {
    var p = SSEParser(); let s = Array("id: 7\nevent: event\ndata: {\"a\":\ndata: 1}\n\n: comment\r\ndata: x\r\n\r\n".utf8)
    var out = [SSEFrame](); for b in s { out += p.feed([b]) }
    XCTAssertEqual(out, [SSEFrame(id: "7", event: "event", data: "{\"a\":\n1}"), SSEFrame(id: nil, event: "message", data: "x")])
  }
}
actor Collector { var items = [StreamItem](); func add(_ i: StreamItem) { items.append(i) } }
