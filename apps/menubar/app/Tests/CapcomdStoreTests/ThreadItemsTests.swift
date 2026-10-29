import XCTest
@testable import CapcomdStore
import CapcomdThread

final class FakeThread: ThreadFetching, @unchecked Sendable {
  var pages: [Int: CapcomdThread.Page] = [:]   // by `after`
  var afters: [Int] = []
  var unsupported = false
  var bytes = Data([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  func thread(runId: String, agentId: String, after: Int, limit: Int) async throws -> CapcomdThread.Page {
    afters.append(after)
    if unsupported { throw DetailUnavailable.unsupported }
    return pages[after] ?? (try! JSONDecoder().decode(CapcomdThread.Page.self, from: Data(#"{"items":[],"next":null}"#.utf8)))
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
