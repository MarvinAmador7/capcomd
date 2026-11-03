import XCTest
@testable import CapcomdStore
import CapcomdThread

final class FakeThread: ThreadFetching, @unchecked Sendable {
  var pages: [Int: CapcomdThread.Page] = [:]   // by `after`
  var afters: [Int] = []
  var unsupported = false
  /// Tail pages by `before` (`agents.thread_tail`); none: the route isn't there (404).
  var tails: [Int?: CapcomdThread.Tail] = [:]
  var befores: [Int?] = []
  /// The daemon can't be reached: every read fails as a refused connection would.
  var down = false
  var bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
    afters.append(after)
    if down { throw URLError(.cannotConnectToHost) }
    if unsupported { throw DetailUnavailable.unsupported }
    return pages[after] ?? (try! JSONDecoder().decode(CapcomdThread.Page.self, from: Data(#"{"items":[],"next":null}"#.utf8)))
  }
  func threadTail(runId: String, agentId: String, before: Int?, limit: Int) async throws -> CapcomdThread.Tail {
    befores.append(before)
    if down { throw URLError(.cannotConnectToHost) }
    guard let t = tails[before] else { throw DetailUnavailable.unsupported }
    return t
  }
  func attachment(runId: String, id: String) async throws -> Data { bytes }
  func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data { bytes }
}

final class RecordingSub: StreamSubscribing, @unchecked Sendable {
  var opened: [(scope: String, feed: String?, thread: Bool)] = []
  final class H: SubscriptionHandle { func cancel() {} }
  func subscribe(scope: String, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle { opened.append((scope, nil, false)); return H() }
  func subscribe(scope: String, feed: String?, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle { opened.append((scope, feed, false)); return H() }
  func subscribe(scope: String, feed: String?, thread: Bool, after: Int, onFrame: @escaping @Sendable (StreamFrame) async -> Void) -> SubscriptionHandle { opened.append((scope, feed, thread)); return H() }
}

@MainActor
final class ThreadItemsTests: XCTestCase {
  func itemJSON(_ id: String, rev: Int = 1, seq: Int, order: Int, at: String = "2026-10-26T12:00:00.000Z", status: String = "done") -> String {
    #"{"id":"\#(id)","rev":\#(rev),"seq":\#(seq),"order":\#(order),"agentId":"agt-1","kind":"say","status":"\#(status)","at":"\#(at)","durationMs":null,"text":"t","blocks":[{"t":"paragraph","children":[{"t":"text","text":"t"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null}"#
  }
  func page(_ items: [String], next: Int?) -> CapcomdThread.Page {
    try! JSONDecoder().decode(CapcomdThread.Page.self, from: Data(#"{"items":[\#(items.joined(separator: ","))],"next":\#(next.map(String.init) ?? "null")}"#.utf8))
  }
  func tail(_ items: [String], before: Int?, cursor: Int) -> CapcomdThread.Tail {
    CapcomdThread.Tail(items: page(items, next: nil).items, before: before, cursor: cursor)
  }
  /// Waits (a bounded number of turns) for work the store started on its own, such as a reread after a reconnect.
  func settle(_ done: @escaping () -> Bool) async {
    for _ in 0..<200 {
      if done() { return }
      try? await Task.sleep(for: .milliseconds(5))
    }
  }
  func spawn(_ s: CapcomdStore) {
    s.receive(.event(Envelope(id: "sp", scope: "run-x", seq: 1, entity: "agt-1", type: "agent.spawned", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-1", data: ["profile": .string("lead")])), scope: "run-x")
  }
  func frame(_ s: CapcomdStore, _ json: String) {
    let item = try! JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
    var e = Envelope(id: UUID().uuidString, scope: "run-x", seq: 1, entity: "agt-1", type: "agent.thread_item_changed", epochMs: 1, projectId: "prj-x",
                     runId: "run-x", agentId: "agt-1", data: ["agentId": .string("agt-1"), "item": item])
    e.durability = "ephemeral"
    s.receive(.event(e), scope: CapcomdStore.lifecycleKey("run-x"))
  }

  func testPagesFromTheRouteCursorNotFromLiveFrames() async {
    let t = FakeThread()
    t.pages[0] = page([itemJSON("i1", seq: 3, order: 0), itemJSON("i2", seq: 5, order: 1)], next: 5)
    t.pages[5] = page([itemJSON("i3", seq: 9, order: 2)], next: nil)
    let s = CapcomdStore(thread: t); spawn(s)
    s.openThread(runId: "run-x", agentId: "agt-1")
    frame(s, itemJSON("i9", seq: 40, order: 8))   // live, ahead of the route
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t.afters, [0, 5])               // never after=40
    XCTAssertEqual(s.books["agt-1"]?.items.map(\.id), ["i1", "i2", "i3", "i9"])
    // The open i1 → done i1 arrives live and again from the route: shown once, latest rev.
    frame(s, itemJSON("i1", rev: 2, seq: 41, order: 0))
    t.pages[9] = page([itemJSON("i1", rev: 2, seq: 41, order: 0)], next: nil)
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(s.books["agt-1"]?.items.map(\.id), ["i1", "i2", "i3", "i9"])
    XCTAssertEqual(s.books["agt-1"]?.items.first?.rev, 2)
    XCTAssertEqual(t.afters.last, 9)
  }

  /// A long thread read over several pages goes into the book once the read ends: a change in between (here a live
  /// frame) doesn't show the thread as read so far, its oldest items first.
  func testAThreadReadOverSeveralPagesShowsWhenItIsAllRead() async {
    final class Paused: ThreadFetching, @unchecked Sendable {
      let base = FakeThread()
      var between: (@MainActor () -> Void)?
      func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
        let p = try await base.thread(runId: runId, agentId: agentId, after: after, limit: limit)
        if after == 5, let between { await MainActor.run { between() } }
        return p
      }
      func attachment(runId: String, id: String) async throws -> Data { Data() }
      func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data { Data() }
    }
    let t = Paused()
    t.base.pages[0] = page([itemJSON("i1", seq: 3, order: 0), itemJSON("i2", seq: 5, order: 1)], next: 5)
    t.base.pages[5] = page([itemJSON("i3", seq: 9, order: 2)], next: nil)
    let s = CapcomdStore(thread: t); spawn(s)
    s.openThread(runId: "run-x", agentId: "agt-1")
    var midway: [String]?
    t.between = { [unowned self] in
      self.frame(s, self.itemJSON("i9", seq: 40, order: 8))   // a live item while the second page is on its way
      midway = s.threadEntries(agentId: "agt-1").map(\.id)
    }
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(midway, ["itm:i9"])   // the newest, live; not i1 and i2 alone
    XCTAssertEqual(s.books["agt-1"]?.items.map(\.id), ["i1", "i2", "i3", "i9"])
  }

  func testFramesForOtherRunsAreIgnored() {
    let s = CapcomdStore(thread: FakeThread()); spawn(s)
    frame(s, itemJSON("i1", seq: 1, order: 0))     // no thread open
    XCTAssertNil(s.books["agt-1"])
  }

  func testOpeningAThreadAddsThreadToItsRunsLifecycleFeed() {
    let sub = RecordingSub(); let s = CapcomdStore(subscriber: sub, thread: FakeThread())
    s.start(); spawn(s)
    s.receive(.event(Envelope(id: "rc", scope: "daemon", seq: 2, entity: "run-x", type: "run.created", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: nil, data: [:])), scope: "daemon")
    XCTAssertEqual(sub.opened.last.map { "\($0.scope) \($0.feed ?? "-") \($0.thread)" }, "run-x lifecycle false")
    s.openThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(sub.opened.last.map { "\($0.scope) \($0.feed ?? "-") \($0.thread)" }, "run-x lifecycle true")
    s.closeThread()
    XCTAssertEqual(sub.opened.last.map { "\($0.scope) \($0.feed ?? "-") \($0.thread)" }, "run-x lifecycle false")
    XCTAssertEqual(sub.opened.filter { $0.scope == "run-x" }.count, 3)
  }

  func testPanelAndReelFollowRunsIndependently() {
    let sub = RecordingSub(); let s = CapcomdStore(subscriber: sub, thread: FakeThread())
    s.start(); spawn(s)
    s.receive(.event(Envelope(id: "rc", scope: "daemon", seq: 2, entity: "run-x", type: "run.created", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: nil, data: [:])), scope: "daemon")
    func runX() -> Int { sub.opened.filter { $0.scope == "run-x" }.count }
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    XCTAssertEqual(sub.opened.last?.thread, true)
    let reopened = runX()
    s.openThread(runId: "run-x", agentId: "agt-1")   // already followed by the reel: the feed isn't reopened
    XCTAssertEqual(runX(), reopened)
    s.closeThread()                                 // the reel still follows it
    XCTAssertEqual(runX(), reopened)
    XCTAssertEqual(s.threadStreamRuns, ["run-x"])
    frame(s, itemJSON("i1", seq: 1, order: 0))
    XCTAssertEqual(s.books["agt-1"]?.items.map(\.id), ["i1"])
    s.followThreads(runId: nil, holder: CapcomdStore.reelHolder)
    XCTAssertEqual(sub.opened.last.map { "\($0.scope) \($0.feed ?? "-") \($0.thread)" }, "run-x lifecycle false")
  }

  func testLiveFramesNarrowTheChangeToTheirAgent() {
    let s = CapcomdStore(thread: FakeThread()); spawn(s)
    var seen: [Set<ChangeKey>] = []
    s.onChanges = { seen.append($0) }
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    frame(s, itemJSON("i1", seq: 1, order: 0))
    XCTAssertEqual(seen.last, [.run("run-x"), .agent("agt-1"), .thread("agt-1")])
    var e = Envelope(id: "act", scope: "run-x", seq: 1, entity: "agt-1", type: "agent.activity_changed", epochMs: 2, projectId: "prj-x",
                     runId: "run-x", agentId: "agt-1", data: ["activity": .object(["text": .string("Editing keys.ts"), "kind": .string("edit")])])
    e.durability = "ephemeral"
    s.receive(.event(e), scope: CapcomdStore.lifecycleKey("run-x"))
    XCTAssertEqual(seen.last, [.run("run-x"), .agent("agt-1"), .thread("agt-1")])
    s.receive(.event(Envelope(id: "sp2", scope: "run-x", seq: 3, entity: "agt-2", type: "agent.spawned", epochMs: 3, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-2", data: ["profile": .string("worker")])), scope: "run-x")   // durable: not narrowed
    XCTAssertEqual(seen.last, [.all])
  }

  func testStructuredItemsInterleaveWithSteersAndFallBackOnOlderDaemons() async {
    let t = FakeThread()
    t.pages[0] = page([itemJSON("i1", seq: 1, order: 0, at: "2026-10-26T12:00:00.000Z"), itemJSON("i2", seq: 2, order: 1, at: "2026-10-26T12:00:10.000Z")], next: nil)
    let s = CapcomdStore(thread: t); spawn(s)
    s.receive(.event(Envelope(id: "st", scope: "run-x", seq: 5, entity: "agt-1", type: "agent.started", epochMs: 1, projectId: "prj-x", runId: "run-x",
                              agentId: "agt-1", data: [:])), scope: "run-x")
    let steerMs = 1_793_016_005_000   // 2026-10-26T12:00:05Z
    s.receive(.event(Envelope(id: "m1", scope: "run-x", seq: 6, entity: "msg", type: "message.sent", epochMs: steerMs, projectId: "prj-x", runId: "run-x",
                              agentId: "operator", data: ["from": .string("operator"), "to": .string("agt-1"), "seq": .number(1), "text": .string("cap it at 200")])), scope: "run-x")
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").count, 2)   // not read yet: the event-built items
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1", "evt:msg:operator:agt-1:1", "itm:i2"])   // "Started" is dropped

    let old = FakeThread(); old.unsupported = true
    let s2 = CapcomdStore(thread: old); spawn(s2)
    s2.receive(.event(Envelope(id: "st", scope: "run-x", seq: 5, entity: "agt-1", type: "agent.started", epochMs: 1, projectId: "prj-x", runId: "run-x",
                               agentId: "agt-1", data: [:])), scope: "run-x")
    await s2.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(s2.threadSupported(agentId: "agt-1"), false)
    XCTAssertEqual(s2.threadEntries(agentId: "agt-1").count, 1)
  }

  /// agents.thread_tail: a first read shows the newest page at once, then catches up from the tail's cursor (never from
  /// 0). An item above the page that changed meanwhile is kept but not shown until a page above reaches it, and that
  /// page's older rev of it never wins.
  func testATailFirstShowsTheNewestThenPagesUpWithNoGapAndNoDuplicate() async {
    let t = FakeThread()
    t.tails[nil] = tail([itemJSON("i8", seq: 30, order: 8), itemJSON("i9", seq: 31, order: 9)], before: 8, cursor: 31)
    // Written after the tail was read: i1 (above it) finishes, i10 is new; i9 also comes live.
    t.pages[31] = page([itemJSON("i1", rev: 2, seq: 32, order: 1), itemJSON("i10", seq: 33, order: 10)], next: nil)
    let s = CapcomdStore(thread: t); spawn(s)
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    frame(s, itemJSON("i9", seq: 31, order: 9))
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t.befores, [nil])
    XCTAssertEqual(t.afters, [31])                         // from the tail's cursor, never from the start
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i8", "itm:i9", "itm:i10"])
    XCTAssertTrue(s.threadHasEarlier(agentId: "agt-1"))
    XCTAssertEqual(s.threadTop(agentId: "agt-1"), 8)
    // Scrolled up: the page above, with i1 at the rev it had when that page was read (older than the one we have).
    t.tails[8] = tail([itemJSON("i1", seq: 2, order: 1), itemJSON("i5", seq: 20, order: 5)], before: nil, cursor: 33)
    await s.loadEarlierThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t.befores, [nil, 8])
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1", "itm:i5", "itm:i8", "itm:i9", "itm:i10"])
    XCTAssertEqual(s.books["agt-1"]?.items.first?.rev, 2)
    XCTAssertFalse(s.threadHasEarlier(agentId: "agt-1"))
    await s.loadEarlierThread(runId: "run-x", agentId: "agt-1")   // at the start: nothing more to ask
    XCTAssertEqual(t.befores, [nil, 8])
    // Later refreshes go on from the cursor.
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t.afters, [31, 33])
  }

  /// A steer older than the first item shown waits with the page above, rather than bunching at the top.
  func testMessagesAboveTheShownTailWaitForItsPage() async {
    let t = FakeThread()
    t.tails[nil] = tail([itemJSON("i8", seq: 30, order: 8, at: "2026-10-26T12:00:10.000Z")], before: 8, cursor: 30)
    let s = CapcomdStore(thread: t); spawn(s)
    s.receive(.event(Envelope(id: "m1", scope: "run-x", seq: 6, entity: "msg", type: "message.sent", epochMs: 1_793_016_005_000, projectId: "prj-x", runId: "run-x",
                              agentId: "operator", data: ["from": .string("operator"), "to": .string("agt-1"), "seq": .number(1), "text": .string("early steer")])), scope: "run-x")
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i8"])
    t.tails[8] = tail([itemJSON("i1", seq: 1, order: 1, at: "2026-10-26T12:00:00.000Z")], before: nil, cursor: 30)
    await s.loadEarlierThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1", "evt:msg:operator:agt-1:1", "itm:i8"])
  }

  /// A daemon that says it has no tail route is read from the start, without asking for one; one that hasn't said yet
  /// is asked, and its 404 falls back the same way.
  func testWithoutTheTailRouteTheThreadIsReadFromTheStart() async {
    let t = FakeThread()
    t.pages[0] = page([itemJSON("i1", seq: 1, order: 1)], next: nil)
    let s = CapcomdStore(thread: t); spawn(s)
    s.daemonVersion = "0.6.0"; s.capabilities = ["agents.title"]
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t.befores, [])
    XCTAssertEqual(t.afters, [0])
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1"])
    XCTAssertFalse(s.threadHasEarlier(agentId: "agt-1"))

    let t2 = FakeThread()
    t2.pages[0] = page([itemJSON("i1", seq: 1, order: 1)], next: nil)
    let s2 = CapcomdStore(thread: t2); spawn(s2)   // capabilities not read yet
    await s2.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertEqual(t2.befores, [nil])
    XCTAssertEqual(t2.afters, [0])
    XCTAssertEqual(s2.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1"])
  }

  /// The bug: the daemon was unreachable, the column's read failed ("Couldn't load the thread"), and the error stayed
  /// after the daemon came back, until that column happened to read again. Now the reconnect reads it again at once,
  /// from where it was, and the error clears.
  func testAThreadThatFailedWhileTheDaemonWasDownLoadsWhenItComesBack() async {
    let t = FakeThread()
    t.tails[nil] = tail([itemJSON("i1", seq: 1, order: 1), itemJSON("i2", seq: 2, order: 2)], before: nil, cursor: 2)
    let s = CapcomdStore(thread: t); spawn(s)
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    s.receive(.link(up: true), scope: "daemon")
    t.down = true
    s.receive(.link(up: false), scope: "daemon")
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    XCTAssertTrue(s.daemonUnreachable)
    XCTAssertEqual(s.threadUnavailable["agt-1"], .failed("Couldn't reach capcomd"))
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").count, 0)
    // Back.
    t.down = false
    s.receive(.link(up: true), scope: "daemon")
    await settle { s.threadUnavailable["agt-1"] == nil }
    XCTAssertFalse(s.daemonUnreachable)
    XCTAssertNil(s.threadUnavailable["agt-1"])
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1", "itm:i2"])
  }

  /// The run's own feed coming back reads its threads again too (frames written while it was away aren't replayed):
  /// from the cursor, so what was missed arrives.
  func testARunFeedReconnectReadsItsThreadsFromTheCursor() async {
    let t = FakeThread()
    t.tails[nil] = tail([itemJSON("i1", seq: 1, order: 1)], before: nil, cursor: 1)
    let s = CapcomdStore(thread: t); spawn(s)
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    await s.refreshThread(runId: "run-x", agentId: "agt-1")
    t.pages[1] = page([itemJSON("i2", seq: 5, order: 5)], next: nil)   // written while the feed was away
    s.receive(.link(up: true), scope: CapcomdStore.lifecycleKey("run-x"))
    await settle { s.threadEntries(agentId: "agt-1").count == 2 }
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1", "itm:i2"])
    XCTAssertEqual(t.afters.suffix(1), [1])
  }

  /// A reconnect while a read that is going to fail is still on its way: that read failing doesn't have the last word;
  /// the thread is read once more after it, and loads.
  func testAReconnectDuringAFailingReadReadsAgainAfterIt() async {
    final class Gated: ThreadFetching, @unchecked Sendable {
      let base = FakeThread()
      var gate: CheckedContinuation<Void, Never>?
      var holding = true
      func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
        try await base.thread(runId: runId, agentId: agentId, after: after, limit: limit)
      }
      func threadTail(runId: String, agentId: String, before: Int?, limit: Int) async throws -> CapcomdThread.Tail {
        if holding { holding = false; await withCheckedContinuation { gate = $0 }; throw URLError(.networkConnectionLost) }
        return try await base.threadTail(runId: runId, agentId: agentId, before: before, limit: limit)
      }
      func attachment(runId: String, id: String) async throws -> Data { Data() }
      func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data { Data() }
    }
    let t = Gated()
    t.base.tails[nil] = tail([itemJSON("i1", seq: 1, order: 1)], before: nil, cursor: 1)
    let s = CapcomdStore(thread: t); spawn(s)
    s.followThreads(runId: "run-x", holder: CapcomdStore.reelHolder)
    let first = Task { await s.refreshThread(runId: "run-x", agentId: "agt-1") }
    await settle { t.gate != nil }
    s.threadUnavailable["agt-1"] = .failed("Couldn't reach capcomd")   // an earlier read failed while it was down
    s.receive(.link(up: true), scope: CapcomdStore.lifecycleKey("run-x"))
    await Task.yield()
    t.gate?.resume()
    await first.value
    XCTAssertNil(s.threadUnavailable["agt-1"])
    XCTAssertEqual(s.threadEntries(agentId: "agt-1").map(\.id), ["itm:i1"])
  }

  /// A read cancelled because its column went away is not a failure: no error is left for the column to show later.
  func testACancelledReadLeavesNoError() async {
    final class Slow: ThreadFetching, @unchecked Sendable {
      func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
        try await Task.sleep(for: .seconds(10)); throw URLError(.timedOut)
      }
      func attachment(runId: String, id: String) async throws -> Data { Data() }
      func workspaceFile(runId: String, agentId: String, path: String) async throws -> Data { Data() }
    }
    let s = CapcomdStore(thread: Slow()); spawn(s)
    let read = Task { await s.refreshThread(runId: "run-x", agentId: "agt-1") }
    try? await Task.sleep(for: .milliseconds(20))
    read.cancel()
    await read.value
    XCTAssertNil(s.threadUnavailable["agt-1"])
  }

  func testMediaKeepsRasterImagesOnly() async {
    let t = FakeThread(); let s = CapcomdStore(thread: t)
    await s.loadMedia(.attachment(runId: "run-x", id: "att-1"))
    XCTAssertNotNil(s.media[.attachment(runId: "run-x", id: "att-1")]?.value)
    t.bytes = Data("<svg onload=alert(1)>".utf8)
    await s.loadMedia(.workspace(runId: "run-x", agentId: "agt-1", path: "a.png"))
    XCTAssertNil(s.media[.workspace(runId: "run-x", agentId: "agt-1", path: "a.png")]?.value)
    XCTAssertTrue(CapcomdStore.isRasterImage(Data("RIFF\0\0\0\0WEBPVP8 ".utf8)))
    XCTAssertFalse(CapcomdStore.isRasterImage(Data("RIFF\0\0\0\0WAVE".utf8)))
  }
}
