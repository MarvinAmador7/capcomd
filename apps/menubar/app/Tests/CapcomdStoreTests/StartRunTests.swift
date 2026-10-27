import XCTest
@testable import CapcomdStore

final class FakeStarter: RunStarting, @unchecked Sendable {
  var outcomes: [Result<String, Error>] = []
  var calls: [(goal: String, repo: String?, driver: String?, sandbox: String?, key: String)] = []
  func start(goal: String, repo: String?, driver: String?, sandbox: String?, idempotencyKey: String) async throws -> String {
    calls.append((goal, repo, driver, sandbox, idempotencyKey)); return try outcomes.removeFirst().get()
  }
}

@MainActor
final class StartRunTests: XCTestCase {
  func testStartTrimsGoalAndReportsTheRun() async {
    let f = FakeStarter(); f.outcomes = [.success("run-new1")]
    let s = CapcomdStore(starter: f, makeKey: { "key-1" })
    let r = await s.startRun(goal: "  Backfill addriva_id\n")
    XCTAssertEqual(r, .started(runId: "run-new1"))
    XCTAssertEqual(f.calls.first?.goal, "Backfill addriva_id")
    let empty = await s.startRun(goal: "   ")
    XCTAssertEqual(empty, .idle); XCTAssertEqual(f.calls.count, 1)        // nothing sent for a blank goal
  }

  func testNoDefaultRepositoryAsksForOne() async {
    let f = FakeStarter(); f.outcomes = [.failure(StartRefused("repo is required: …", needsRepo: true)), .success("run-2")]
    var n = 0
    let s = CapcomdStore(starter: f, makeKey: { n += 1; return "key-\(n)" })
    let first = await s.startRun(goal: "Ship it")
    guard case .needsRepo = first else { return XCTFail("expected needsRepo, got \(first)") }
    let second = await s.startRun(goal: "Ship it", repo: "/src/matchkey")
    XCTAssertEqual(second, .started(runId: "run-2"))
    XCTAssertEqual(f.calls.map(\.repo), [nil, "/src/matchkey"])
  }

  func testATransportFailureRetriesWithTheSameKey() async {
    struct Down: Error {}
    let f = FakeStarter(); f.outcomes = [.failure(Down()), .success("run-3")]
    var n = 0
    let s = CapcomdStore(starter: f, makeKey: { n += 1; return "key-\(n)" })
    let failed = await s.startRun(goal: "Ship it")
    XCTAssertEqual(failed, .failed("Couldn't reach capcomd"))
    _ = await s.startRun(goal: "Ship it")
    XCTAssertEqual(f.calls.map(\.key), ["key-1", "key-1"])               // a lost response can't start it twice
    f.outcomes = [.success("run-4")]
    _ = await s.startRun(goal: "Something else")
    XCTAssertEqual(f.calls.last?.key, "key-2")                           // a new goal is a new request
  }

  func testOlderDaemonSaysSo() async {
    let f = FakeStarter(); f.outcomes = [.failure(DetailUnavailable.unsupported)]
    let s = CapcomdStore(starter: f)
    let r = await s.startRun(goal: "Ship it")
    XCTAssertEqual(r, .failed("This capcomd can't start runs from here yet"))
  }

  /// The driver and sandbox ride along, and a retry after a transport failure reuses the key only for the same choice.
  func testDriverIsSentAndPartOfTheRetryKey() async {
    let f = FakeStarter(); f.outcomes = [.failure(URLError(.timedOut)), .success("run-a"), .success("run-b")]
    var n = 0
    let s = CapcomdStore(starter: f, makeKey: { n += 1; return "key-\(n)" })
    _ = await s.startRun(goal: "Ship it", driver: "codex")
    _ = await s.startRun(goal: "Ship it", driver: "codex")
    XCTAssertEqual(f.calls.map(\.driver), ["codex", "codex"])
    XCTAssertEqual(f.calls.map(\.key), ["key-1", "key-1"])      // same submission: replayed, not started twice
    _ = await s.startRun(goal: "Ship it", driver: "claude", sandbox: "boxd")
    XCTAssertEqual(f.calls.last?.driver, "claude"); XCTAssertEqual(f.calls.last?.sandbox, "boxd"); XCTAssertEqual(f.calls.last?.key, "key-2")
  }
}
