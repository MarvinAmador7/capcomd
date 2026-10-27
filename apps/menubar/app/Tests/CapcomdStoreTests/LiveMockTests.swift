import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive
import CapcomdClient

/// Drives the real LiveSubscriber/LiveDecider against the Bun mock (contract reset+snapshot after 12, drop after 22, re-send cursor).
@MainActor
final class LiveMockTests: XCTestCase {
  static let sock = NSTemporaryDirectory() + "capcomd-app-\(getpid()).sock"
  var server: Process!
  var transport: UnixSocketTransport!

  override func setUp() async throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe")
    let mock = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/server.ts").standardized.path
    p.arguments = [mock, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": "test-token"]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); server = p
    for _ in 0..<100 where !FileManager.default.fileExists(atPath: Self.sock) { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(100))
    transport = UnixSocketTransport(socketPath: Self.sock, token: "test-token")
  }
  func startServer() throws {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe")
    p.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/server.ts").standardized.path, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SOCK": Self.sock, "TOKEN": "test-token"]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); server = p
  }

  /// A feed outlives the daemon: the daemon going away for longer than a few quick retries (a restart) and coming back
  /// must not end the subscription (it used to give up after 10 tries in ~3 s, and for good on a clean close).
  func testSubscriptionReconnectsAfterTheDaemonRestarts() async throws {
    final class Count: @unchecked Sendable { var resets = 0; let lock = NSLock(); func add() { lock.lock(); resets += 1; lock.unlock() }; var n: Int { lock.lock(); defer { lock.unlock() }; return resets } }
    let c = Count()
    let h = LiveSubscriber(transport: transport, maxBackoff: .milliseconds(500)).subscribe(scope: "daemon", after: 0) { f in
      if case .reset = f { c.add() }
    }
    defer { h.cancel() }
    var deadline = Date().addingTimeInterval(10)
    while c.n < 1, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
    XCTAssertEqual(c.n, 1)
    server.terminate(); server.waitUntilExit()
    let k = Process(); k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); k.arguments = ["-f", Self.sock]; try? k.run(); k.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock)
    try await Task.sleep(for: .seconds(4))   // longer than the old retry budget
    try startServer()
    deadline = Date().addingTimeInterval(15)
    while c.n < 2, Date() < deadline { try await Task.sleep(for: .milliseconds(100)) }
    XCTAssertGreaterThanOrEqual(c.n, 2, "the feed reconnected after the restart")
  }

  override func tearDown() async throws {
    try? await transport.shutdown(); server.terminate(); server.waitUntilExit()
    let k = Process(); k.executableURL = URL(fileURLWithPath: "/usr/bin/pkill"); k.arguments = ["-f", Self.sock]; try? k.run(); k.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock)
  }

  func testStreamThroughResetAndDropThenDecide() async throws {
    let store = CapcomdStore(subscriber: LiveSubscriber(transport: transport), decider: LiveDecider(transport: transport))
    store.openRun("run-demo")
    let deadline = Date().addingTimeInterval(15)
    while (store.lastSeq["run-demo"] ?? 0) < 30, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
    XCTAssertEqual(store.lastSeq["run-demo"], 30)
    XCTAssertEqual(store.pendingApprovals.map(\.id), ["apr-6"])
    XCTAssertEqual(store.pendingApprovals.first?.question.plain, "Merge task 6 into main?")
    XCTAssertEqual(store.pendingApprovals.first?.branchLine, "fix/task-6 → main")
    let tree = store.agentTree(runId: "run-demo")
    XCTAssertEqual(tree.count, 1); XCTAssertEqual(tree[0].children.count, 5)
    XCTAssertEqual(Set(tree[0].children.compactMap(\.suffix)).count, 5)   // repeated "worker" profile disambiguated by key
    store.stop()

    let d = LiveDecider(transport: transport)
    let first = try await d.decide(approvalId: "apr-6", decision: .approve, idempotencyKey: "key-aaaaaaaa")
    guard case .decided(let rec) = first else { return XCTFail("\(first)") }
    XCTAssertEqual(rec.status, "approved")
    XCTAssertNotNil(rec.decidedAt?.wholeMatch(of: try Regex(#"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z"#)), "….000Z")
    let replay = try await d.decide(approvalId: "apr-6", decision: .approve, idempotencyKey: "key-aaaaaaaa")
    XCTAssertEqual(replay, first)
    let conflict = try await d.decide(approvalId: "apr-6", decision: .deny, idempotencyKey: "key-aaaaaaaa")
    guard case .idempotencyConflict = conflict else { return XCTFail("\(conflict)") }
    let already = try await d.decide(approvalId: "apr-6", decision: .deny, idempotencyKey: "key-bbbbbbbb")
    guard case .alreadyDecided(let r2) = already else { return XCTFail("\(already)") }
    XCTAssertEqual(r2?.status, "approved")
  }

  /// The daemon scope only learns approvals from a reset snapshot; snapshot.approvals now carries requestedBy/subject (0fb6e53),
  /// so the pending card keeps its run, agent and branch line after the reset.
  func testDaemonResetSnapshotRebuildsBranchLineAndRun() async throws {
    let store = CapcomdStore(subscriber: LiveSubscriber(transport: transport), decider: LiveDecider(transport: transport))
    store.start()
    let deadline = Date().addingTimeInterval(10)
    while store.lastSeq["daemon"] != 30, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
    XCTAssertEqual(store.lastSeq["daemon"], 30)
    let a = try XCTUnwrap(store.pendingApprovals.first)
    XCTAssertEqual(store.pendingApprovals.map(\.id), ["apr-6"])
    XCTAssertEqual(a.runId, "run-demo"); XCTAssertEqual(a.agentId, "agt-6")
    XCTAssertEqual(a.branchLine, "fix/task-6 → main")
    // lifecycle feed for the unfinished run: cut mid-group, resumed from the last SSE id, run.started applied exactly once
    let d2 = Date().addingTimeInterval(10)
    while store.runs["run-demo"]?.lifecycle.isEmpty ?? true, Date() < d2 { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(300))
    XCTAssertEqual(store.runs["run-demo"]?.lifecycle.map(\.type), ["run.started"])
    XCTAssertEqual(store.runs["run-demo"]?.state, "running")
    store.stop()
  }
}
