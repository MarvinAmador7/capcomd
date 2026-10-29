import XCTest
import Foundation
@testable import CapcomdStore
@testable import CapcomdLive
import CapcomdClient

/// The Active card's states (direction B) through the live adapter against the UI mock's `cards` scene
/// (client/mock/scenarios.ts): approval files and request time, agent results (a usage limit, a failed check, a merge,
/// cost) and the run's files decode, and each project's card says what the board shows.
@MainActor
final class ActiveCardLiveMockTests: XCTestCase {
  static let sock = NSTemporaryDirectory() + "capcomd-cards-\(getpid()).sock"
  var server: Process?
  var transport: UnixSocketTransport?

  override func setUp() async throws {
    try? FileManager.default.removeItem(atPath: Self.sock)
    let p = Process()
    p.executableURL = URL(fileURLWithPath: ProcessInfo.processInfo.environment["BUN_BIN"] ?? "/usr/local/lib/pnpm/5/.pnpm/bun@1.4.2/node_modules/bun/bin/bun.exe")
    p.arguments = [URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../../client/mock/scenarios.ts").standardized.path, Self.sock]
    p.environment = ProcessInfo.processInfo.environment.merging(["SCENARIO": "cards", "TOKEN": "test-token"]) { $1 }
    p.standardOutput = FileHandle.nullDevice; p.standardError = FileHandle.nullDevice
    try p.run(); server = p
    for _ in 0..<100 where !FileManager.default.fileExists(atPath: Self.sock) { try await Task.sleep(for: .milliseconds(50)) }
    try await Task.sleep(for: .milliseconds(100))
    transport = UnixSocketTransport(socketPath: Self.sock, token: "test-token")
  }

  override func tearDown() async throws {
    try? await transport?.shutdown()
    server?.terminate(); server?.waitUntilExit()
    try? FileManager.default.removeItem(atPath: Self.sock)
  }

  func testEachStateOfTheCardsSceneReadsAsTheBoardShowsIt() async throws {
    let t = try XCTUnwrap(transport)
    let s = CapcomdStore(subscriber: LiveSubscriber(transport: t), decider: LiveDecider(transport: t), detail: LiveDetail(transport: t))
    s.start()
    defer { s.stop() }
    let deadline = Date().addingTimeInterval(15)
    while s.projects.count < 5 || s.approvals.isEmpty, Date() < deadline { try await Task.sleep(for: .milliseconds(50)) }
    let byRun = Dictionary(uniqueKeysWithValues: s.projects.compactMap { p in p.runs.first.map { ($0.id, p) } })
    XCTAssertEqual(Set(byRun.keys), ["run-cl01", "run-pr02", "run-mk40", "run-cl02", "run-cl03"])

    // The screenshot case: worker asks to merge, with its two files.
    let ask = s.activeCard(try XCTUnwrap(byRun["run-cl01"]))
    guard case .ask(let a) = ask.body else { return XCTFail("\(ask.body)") }
    XCTAssertEqual(a.question, "Merge worker's work into main?")
    XCTAssertEqual(a.waiters.map(\.name), ["planner", "critic"])
    XCTAssertEqual(a.approval.diff?.files.map(\.path.plain), ["src/math.test.ts", "src/math.ts"])
    XCTAssertEqual(a.approval.diff.map { [$0.total, $0.added, $0.removed] }, [2, 24, 0])
    XCTAssertNotNil(a.approval.requestedAtMs)

    // A failed worker: its checks, and the lines that name the failure.
    let failed = s.activeCard(try XCTUnwrap(byRun["run-pr02"]))
    guard case .failed(let f) = failed.body else { return XCTFail("\(failed.body)") }
    XCTAssertEqual(f.agent.name, "worker relay")   // siblings with distinct folders: the folder tells them apart
    XCTAssertTrue(f.checksFailed)
    XCTAssertEqual(f.detail?.plain, "(fail) rounds half up\nExpected: 10.33\nReceived: 10.34")

    // A usage-limit pause: Claude's, picking up again in about 38 minutes.
    let paused = s.activeCard(try XCTUnwrap(byRun["run-cl02"]))
    guard case .paused(let p) = paused.body else { return XCTFail("\(paused.body)") }
    XCTAssertEqual(p.agents.map(\.name), ["planner", "critic"])
    XCTAssertEqual(p.provider, .claude)
    let left = try XCTUnwrap(p.resumesAtMs) - Int(Date().timeIntervalSince1970 * 1000)
    XCTAssertTrue((36 * 60_000...39 * 60_000).contains(left), "\(left)")

    // Ten agents, folded: five heads and +5, and the agent whose activity changed last.
    let long = s.activeCard(try XCTUnwrap(byRun["run-mk40"]))
    guard case .working = long.body else { return XCTFail("\(long.body)") }
    XCTAssertEqual(long.crew.count, 5); XCTAssertEqual(long.crewMore, 5)
    XCTAssertEqual(long.sentence.text, "worker d3ce is editing keys.ts")

    // A finished run folds to its outcome; its files come from GET …/files.
    let done = try XCTUnwrap(byRun["run-cl03"])
    XCTAssertFalse(done.isActive)
    await s.refreshFiles("run-cl03")
    let o = try XCTUnwrap(s.outcome(done))
    XCTAssertEqual(o.head, "Merged into main")
    XCTAssertEqual([o.files, o.added, o.removed], [2, 24, 0])
    XCTAssertEqual(o.checksPassed, true)
    XCTAssertEqual(try XCTUnwrap(o.costUsd), 0.41, accuracy: 0.0001)

    // Approve through the live decider: the ask settles as decided.
    let result = await s.decide("apr-cl1", .approve)
    guard case .decided(let status, _, _) = result else { return XCTFail("\(result)") }
    XCTAssertEqual(status, "approved")
  }
}
