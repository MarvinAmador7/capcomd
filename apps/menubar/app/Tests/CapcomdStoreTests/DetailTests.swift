import XCTest
@testable import CapcomdStore

final class FakeDetail: RunDetailFetching, @unchecked Sendable {
  var spans: [TraceSpan] = []
  var pages: [Int: TranscriptPage] = [:]   // keyed by `after` (0 for the first page)
  var filesError: DetailUnavailable?
  var transcriptCalls: [Int?] = []
  func trace(runId: String) async throws -> [TraceSpan] { spans }
  func transcript(runId: String, agentId: String, after: Int?, limit: Int) async throws -> TranscriptPage {
    transcriptCalls.append(after); return pages[after ?? 0] ?? TranscriptPage(items: [], next: nil)
  }
  func files(runId: String) async throws -> RunFiles {
    if let e = filesError { throw e }
    return RunFiles(runId: runId, asOf: 1, files: [], total: 0, truncated: false)
  }
}
final class FakeControls: RunControlling, @unchecked Sendable {
  var outcome: Error?
  var calls: [(RunControl, String)] = []
  func control(runId: String, _ action: RunControl, idempotencyKey: String) async throws {
    calls.append((action, idempotencyKey)); if let e = outcome { throw e }
  }
}

@MainActor
final class DetailTests: XCTestCase {
  static let t0 = "2026-10-26T10:00:00.000Z"
  static func at(_ s: Int) -> String { ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: 1_793_008_800 + Double(s))).replacingOccurrences(of: "Z", with: ".000Z") }
  static func span(_ id: String, _ name: String, parent: String? = nil, from: Int, took: Int?, error: Bool = false, attrs: [String: JSONValue] = [:]) -> TraceSpan {
    TraceSpan(spanId: id, parentSpanId: parent, name: name, start: at(from), end: took.map { at(from + $0) }, status: error ? 2 : 1, attributes: attrs)
  }

  func testTraceKeepsMeaningfulSpansReparentsAndLanes() {
    let spans = [
      Self.span("a", "sandbox.ensure", from: 0, took: 6),
      Self.span("b", "actor.scope.kvGet", parent: "a", from: 1, took: 1),          // dropped
      Self.span("c", "sandbox.waitReady", parent: "b", from: 2, took: 3),           // re-parented under a
      Self.span("d", "agent.claude_code", from: 10, took: 9, error: true),
      Self.span("e", "git.push", from: 20, took: 4, attrs: ["git.operation": .string("push"), "git.ref": .string("fix/x")]),
      Self.span("f", "transition.task", from: 25, took: 1),                          // dropped
    ]
    let now = epochMs(iso: Self.at(40))!
    let rows = TraceShape.rows(spans: spans, pending: [(id: "agent:w", label: "Editing 3 files", kind: .fileWrite, status: .running, startMs: epochMs(iso: Self.at(30))!)], nowMs: now)
    XCTAssertEqual(rows.map(\.label), ["sandbox up", "wait for sandbox", "model call", "push fix/x", "Editing 3 files"])
    XCTAssertEqual(rows.map(\.depth), [0, 1, 0, 0, 0])
    XCTAssertTrue(rows[0].hasChildren)
    XCTAssertEqual(rows[2].status, .failed); XCTAssertEqual(rows[4].status, .running)
    XCTAssertEqual(rows[0].laneStart, 0, accuracy: 0.001)
    XCTAssertEqual(rows[4].laneStart + rows[4].laneWidth, 1, accuracy: 0.001)   // running lane reaches now
    XCTAssertTrue(rows.allSatisfy { $0.laneStart >= 0 && $0.laneStart + $0.laneWidth <= 1.0001 })
    let folded = TraceShape.rows(spans: spans, pending: [], nowMs: now, collapsed: ["a"])
    XCTAssertEqual(folded.map(\.label), ["sandbox up", "model call", "push fix/x"])
  }

  func testTimeFormats() {
    XCTAssertEqual(relativeAgo(ms: 0, nowMs: 5_000), "now")
    XCTAssertEqual(relativeAgo(ms: 0, nowMs: 45_000), "45s ago")
    XCTAssertEqual(relativeAgo(ms: 0, nowMs: 6 * 60_000), "6m ago")
    XCTAssertEqual(relativeAgo(ms: 0, nowMs: 2 * 3_600_000), "2h ago")
    XCTAssertEqual(clockDuration(ms: 33_000), "0:33"); XCTAssertEqual(clockDuration(ms: 312_000), "5:12")
    XCTAssertEqual(clockDuration(ms: 3_727_000), "1:02:07")
  }

  func testLogPagesToTheEndAndKeepsTheTail() async {
    let d = FakeDetail()
    d.pages[0] = TranscriptPage(items: (1...150).map { .init(seq: $0, at: Self.t0, stream: "stdout", text: "line \($0)") }, next: 150)
    d.pages[150] = TranscriptPage(items: (151...260).map { .init(seq: $0, at: Self.t0, stream: "stdout", text: "line \($0)\nmore") }, next: nil)
    let s = CapcomdStore(detail: d)
    await s.refreshLog(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(d.transcriptCalls, [nil, 150])
    XCTAssertEqual(s.logs["agt-1"]?.count, CapcomdStore.logTail)
    XCTAssertEqual(s.logs["agt-1"]?.last?.seq, 260)
    XCTAssertEqual(s.logs["agt-1"]?.last?.text.firstLine, "line 260")         // untrusted, first line only
    d.pages[260] = TranscriptPage(items: [.init(seq: 261, at: Self.t0, stream: "stdout", text: "new")], next: nil)
    await s.refreshLog(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(d.transcriptCalls.last, 260)                                // resumes from its cursor
    XCTAssertEqual(s.logs["agt-1"]?.last?.seq, 261)
  }

  func testFilesUnsupportedOnAnOlderDaemon() async {
    let d = FakeDetail(); d.filesError = .unsupported
    let s = CapcomdStore(detail: d)
    await s.refreshFiles("run-x")
    XCTAssertEqual(s.files["run-x"], .unavailable(.unsupported))
  }

  func testControlsHoldUntilTheLifecycleConfirms() async {
    let c = FakeControls()
    var n = 0
    let s = CapcomdStore(controls: c, makeKey: { n += 1; return "key-\(n)" })
    func env(_ seq: Int, _ type: String) {
      s.receive(.event(Envelope(id: "e\(seq)", scope: "run-x", seq: seq, entity: "run-x", type: type, epochMs: seq, projectId: "prj-x", runId: "run-x", agentId: nil, data: [:])), scope: "run-x")
    }
    env(1, "run.started")
    XCTAssertEqual(s.pauseAction(runId: "run-x"), .pause)
    let r = await s.control("run-x", .pause)
    XCTAssertEqual(r, .requested(.pause))
    XCTAssertEqual(s.pauseAction(runId: "run-x"), .resume)                     // shows Resume while agents stop
    env(2, "run.paused")
    XCTAssertEqual(s.controlState["run-x"], .idle)                             // the lifecycle confirmed it
    XCTAssertEqual(s.pauseAction(runId: "run-x"), .resume)
    c.outcome = ControlRefused("nothing is paused")
    let refused = await s.control("run-x", .resume)
    XCTAssertEqual(refused, .failed("nothing is paused"))
    c.outcome = DetailUnavailable.unsupported
    let old = await s.control("run-x", .cancel)
    XCTAssertEqual(old, .failed("This capcomd can't stop runs yet"))
    XCTAssertEqual(c.calls.map(\.1), ["key-1", "key-2", "key-3"])              // a fresh key per tap
  }

  func testActivityRowsUseTheAgentsActivity() {
    let s = CapcomdStore()
    func send(_ seq: Int, _ type: String, agent: String, _ data: [String: JSONValue]) {
      s.receive(.event(Envelope(id: "e\(seq)", scope: "run-x", seq: seq, entity: agent, type: type, epochMs: seq, projectId: "prj-x", runId: "run-x", agentId: agent, data: data)), scope: "run-x")
    }
    send(1, "agent.spawned", agent: "a1", ["profile": .string("worker"), "task": .string("Validate row counts\nmore")])
    send(2, "agent.spawned", agent: "a2", ["profile": .string("worker")])
    s.receive(.event(Envelope(id: "eph", scope: "run-x", seq: 2, entity: "a2", type: "agent.activity_changed", epochMs: 3, projectId: "prj-x", runId: "run-x", agentId: "a2",
      data: ["agentId": .string("a2"), "status": .string("running"), "activity": .object(["text": .string("Editing 3 files"), "kind": .string("edit")])])), scope: "run-x")
    let steps = s.steps(forRun: "run-x")
    XCTAssertEqual(steps.map(\.text), ["Validate row counts", "Editing 3 files"])   // task first line, then activity
    XCTAssertEqual(steps.map(\.kind), [.agent, .fileWrite])
  }
}
