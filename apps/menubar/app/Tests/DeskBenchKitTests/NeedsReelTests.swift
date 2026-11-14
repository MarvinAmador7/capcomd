import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
#endif

/// The Needs you reel (design/desktop SPEC, Needs you reel): every asking agent across projects, oldest first; an
/// answered ask leaves and the next takes its place; a new one joins at the end; ⌘J steps through them.
final class NeedsReelTests: XCTestCase {
  var seq = 0
  @MainActor func ev(_ s: CapcomdStore, _ run: String, _ type: String, _ agent: String?, _ d: [String: JSONValue] = [:], at: Int) {
    seq += 1
    s.receive(.event(Envelope(id: "e\(seq)", scope: run, seq: seq, entity: agent ?? run, type: type, epochMs: at, projectId: "prj-\(run)",
                              runId: run, agentId: agent, data: d)), scope: run)
  }

  /// Three projects (run-a, run-b, run-c), each a planner and two workers, all running.
  @MainActor func store() -> CapcomdStore {
    let s = CapcomdStore()
    for (n, r) in ["run-a", "run-b", "run-c"].enumerated() {
      let t = 1_000 + n * 100
      ev(s, r, "run.created", nil, ["goal": .string("Goal \(r)"), "sandbox": .string("docker")], at: t)
      ev(s, r, "agent.spawned", "\(r)-pl", ["profile": .string("planner")], at: t + 1)
      for w in ["w1", "w2"] {
        ev(s, r, "agent.spawned", "\(r)-\(w)", ["profile": .string("worker"), "parent": .string("\(r)-pl")], at: t + 2)
        ev(s, r, "agent.started", "\(r)-\(w)", at: t + 3)
      }
    }
    return s
  }

  @MainActor func ask(_ s: CapcomdStore, _ run: String, _ agent: String, _ id: String, at: Int, kind: String = "custom") {
    var d: [String: JSONValue] = ["approvalId": .string(id), "kind": .string(kind), "question": .string("Go ahead with \(id)?"),
                                  "requestedBy": .object(["agentId": .string(agent), "runId": .string(run)])]
    if kind == "merge" {
      d["subject"] = .object(["ref": .string("fix/\(agent)"), "target": .string("main"), "askedBy": .string(agent),
                              "files": .array([.object(["path": .string("a.sql"), "added": .number(18), "removed": .number(3)])]), "filesTotal": .number(3),
                              "added": .number(73), "removed": .number(5)])
    }
    ev(s, run, "approval.requested", agent, d, at: at)
  }
  @MainActor func decided(_ s: CapcomdStore, _ run: String, _ id: String, at: Int) {
    ev(s, run, "approval.decided", nil, ["approvalId": .string(id), "status": .string("approved")], at: at)
  }

  // MARK: the store's list

  /// Oldest first across projects, one per agent (its oldest), a usage limit once per run, decided ones gone.
  @MainActor func testAsksAreOldestFirstAcrossProjectsOnePerAgent() {
    let s = store()
    ask(s, "run-b", "run-b-w1", "apr-2", at: 5_000, kind: "merge")
    ask(s, "run-a", "run-a-w2", "apr-1", at: 4_000)
    ask(s, "run-b", "run-b-w1", "apr-3", at: 6_000)   // the same agent again: it keeps one column, its oldest ask
    ev(s, "run-c", "agent.paused", "run-c-w1", ["result": .object(["limit": .string("quota")]), "until": .number(9_000_000)], at: 4_500)
    ev(s, "run-c", "agent.paused", "run-c-w2", ["result": .object(["limit": .string("quota")])], at: 4_600)
    let asks = s.needsAsks()
    XCTAssertEqual(asks.map(\.agentId), ["run-a-w2", "run-c-w1", "run-b-w1"])
    XCTAssertEqual(asks[2].approval?.id, "apr-2")
    XCTAssertEqual(asks[1].limit?.agentIds, ["run-c-w1", "run-c-w2"])
    XCTAssertEqual(asks[1].limit?.resumesAtMs, 9_000_000)
    decided(s, "run-b", "apr-2", at: 7_000)
    XCTAssertEqual(s.needsAsks().map(\.agentId), ["run-a-w2", "run-c-w1", "run-b-w1"])   // apr-3 still asks
    XCTAssertEqual(s.needsAsks().last?.approval?.id, "apr-3")
    ev(s, "run-c", "agent.resumed", "run-c-w1", at: 8_000)
    ev(s, "run-c", "agent.resumed", "run-c-w2", at: 8_001)
    XCTAssertEqual(s.needsAsks().map(\.agentId), ["run-a-w2", "run-b-w1"])
  }

  #if canImport(SwiftUI) && os(macOS)
  // MARK: the reel

  @MainActor func testTheReelOpensOnEveryAskOldestFirstAndCloses() async throws {
    let s = store()
    ask(s, "run-c", "run-c-w1", "apr-c", at: 3_000)
    ask(s, "run-a", "run-a-w2", "apr-a", at: 2_000)
    ask(s, "run-b", "run-b-pl", "apr-b", at: 2_500, kind: "merge")
    let m = DeskModel(store: s)
    XCTAssertEqual(m.needs.count, 3)
    let before = m.focusedAgent
    m.openNeedsReel()
    XCTAssertTrue(m.needs.isOpen)
    XCTAssertEqual(m.needs.columns, ["run-a-w2", "run-b-pl", "run-c-w1"])
    XCTAssertEqual(m.focusedAgent, "run-a-w2")
    // Every column has its slice (agents of other projects than the open one too) with its ask; their threads warm
    // after the first frame, nearest first.
    for id in m.needs.columns { XCTAssertNotNil(m.agent(id)?.approval, id) }
    XCTAssertEqual(m.agent("run-c-w1")?.warm, false)
    for _ in 0..<60 where !m.needs.columns.allSatisfy({ m.agent($0)?.warm == true }) { try await Task.sleep(for: .milliseconds(25)) }
    for id in m.needs.columns { XCTAssertEqual(m.agent(id)?.warm, true, id) }
    XCTAssertEqual(m.agent("run-a-w2")?.focused, true)
    XCTAssertEqual(m.needs.place("run-b-pl")?.role, "planner")
    // Each column's run follows its live thread items while the reel is open; closing lets them go.
    XCTAssertTrue(s.threadStreamRuns.isSuperset(of: ["run-a", "run-b", "run-c"]))
    m.closeNeedsReel()
    XCTAssertFalse(m.needs.isOpen)
    XCTAssertEqual(m.focusedAgent, before)
    XCTAssertFalse(s.threadStreamRuns.contains("run-c"))
  }

  /// Answering slides the column out: it leaves the reel's columns, the next takes its place and its focus.
  @MainActor func testAnAnsweredAskLeavesAndTheNextTakesItsPlace() {
    let s = store()
    ask(s, "run-a", "run-a-w1", "apr-1", at: 2_000)
    ask(s, "run-b", "run-b-w1", "apr-2", at: 2_100)
    ask(s, "run-c", "run-c-w1", "apr-3", at: 2_200)
    let m = DeskModel(store: s)
    m.openNeedsReel()
    m.focusedAgent = "run-b-w1"
    decided(s, "run-b", "apr-2", at: 3_000)
    XCTAssertEqual(m.needs.columns, ["run-a-w1", "run-c-w1"])
    XCTAssertEqual(m.focusedAgent, "run-c-w1")
    XCTAssertTrue(m.needs.animatesRemoval)
    XCTAssertEqual(m.needs.count, 2)
    // While it slides out the leaving column keeps its slice (it doesn't go blank).
    XCTAssertNotNil(m.agent("run-b-w1"))
    decided(s, "run-a", "apr-1", at: 3_100)
    decided(s, "run-c", "apr-3", at: 3_200)
    XCTAssertTrue(m.needs.columns.isEmpty)   // "Nothing needs you."
    XCTAssertTrue(m.needs.isOpen)
    XCTAssertNil(m.focusedAgent)
  }

  /// A new ask joins at the end; the column you are reading doesn't move, nor does an earlier ask answered elsewhere.
  @MainActor func testANewAskJoinsAtTheEnd() {
    let s = store()
    ask(s, "run-a", "run-a-w1", "apr-1", at: 2_000)
    ask(s, "run-b", "run-b-w1", "apr-2", at: 2_100)
    let m = DeskModel(store: s)
    m.openNeedsReel()
    m.needs.reelScrolled(toIndex: 1)
    // An ask that is older than the others by its clock still joins at the end: nothing shifts under you.
    ask(s, "run-c", "run-c-w2", "apr-3", at: 1_500)
    XCTAssertEqual(m.needs.columns, ["run-a-w1", "run-b-w1", "run-c-w2"])
    XCTAssertEqual(m.needs.reelPosition, "run-b-w1")
    XCTAssertEqual(ReelRemoval.plan(old: ["run-a-w1", "run-b-w1", "run-c-w2"], new: ["run-b-w1", "run-c-w2"], at: 1)?.at, 0)
  }

  @MainActor func testTheRemovalPlanKeepsTheLeadingColumnOrGivesItsPlaceToTheNext() {
    XCTAssertNil(ReelRemoval.plan(old: ["a", "b"], new: ["a", "b", "c"], at: 0))
    XCTAssertEqual(ReelRemoval.plan(old: ["a", "b", "c", "d"], new: ["a", "c", "d"], at: 1), ReelRemoval(removed: ["b"], at: 1))   // the leader went: c leads
    XCTAssertEqual(ReelRemoval.plan(old: ["a", "b", "c", "d"], new: ["b", "c", "d"], at: 2), ReelRemoval(removed: ["a"], at: 1))   // c stays leading
    XCTAssertEqual(ReelRemoval.plan(old: ["a", "b", "c"], new: ["a", "b"], at: 2), ReelRemoval(removed: ["c"], at: 1))            // the last went
    XCTAssertEqual(ReelRemoval.plan(old: ["a"], new: [], at: 0), ReelRemoval(removed: ["a"], at: 0))
  }

  /// The slide-out on the reel itself: the leaving column fades in the render server and goes; the ones after it close
  /// up by one pitch, transform only; their frames are already where they land.
  @MainActor func testTheReelSlidesAnAnsweredColumnOutAndClosesUp() throws {
    let s = store()
    for (n, r) in ["run-a", "run-b", "run-c"].enumerated() { ask(s, r, "\(r)-w1", "apr-\(n)", at: 2_000 + n) }
    ask(s, "run-a", "run-a-w2", "apr-9", at: 2_100)
    let m = DeskModel(store: s)
    m.openNeedsReel()
    let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 800), styleMask: [.titled], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    let reel = ReelView(model: m, driver: m.needs, kind: .needs)
    reel.frame = w.contentView!.bounds
    w.contentView!.addSubview(reel)
    reel.show(m.needs.columns)
    reel.layoutSubtreeIfNeeded()
    XCTAssertEqual(reel.columnCount, 4)
    let pitch = reel.columnFrame(at: 1).minX - reel.columnFrame(at: 0).minX
    let leaving = try XCTUnwrap(reel.columnView(at: 0))
    let next = try XCTUnwrap(reel.columnView(at: 1))
    let nextX = next.frame.minX
    reel.animatesRemovals = true
    decided(s, "run-a", "apr-0", at: 3_000)
    reel.show(m.needs.columns)
    XCTAssertEqual(reel.columnCount, 3)
    XCTAssertNotNil(leaving.layer?.animation(forKey: "leave"))
    XCTAssertNotNil(leaving.superview)   // still drawn until its fade ends
    XCTAssertEqual(next.frame.minX, nextX - pitch, accuracy: 0.5)   // its frame is where it lands
    let closeUp = try XCTUnwrap(next.layer?.animation(forKey: "closeUp") as? CABasicAnimation)
    XCTAssertEqual(closeUp.keyPath, "position.x")
    XCTAssertEqual((closeUp.fromValue as? CGFloat) ?? 0, pitch, accuracy: 0.5)
    XCTAssertLessThan(max(closeUp.duration, ReelRemoval.leave), 0.3)
    // From the keyboard: nothing slides.
    reel.animatesRemovals = false
    let gone = try XCTUnwrap(reel.columnView(at: 0))   // run-b-w1, leading now
    for i in 0..<reel.columnCount { reel.columnView(at: i)?.layer?.removeAllAnimations() }
    decided(s, "run-b", "apr-1", at: 3_100)
    reel.show(m.needs.columns)
    XCTAssertNil(gone.superview)
    XCTAssertNil(reel.columnView(at: 0)?.layer?.animation(forKey: "closeUp"))
  }

  /// ⌘J outside the reel opens each ask in turn, oldest first, and starts again after the newest; in the reel it
  /// focuses the next column.
  @MainActor func testNextAskStepsThroughTheAsksOneAtATime() {
    let s = store()
    ask(s, "run-b", "run-b-w2", "apr-1", at: 2_000)
    ask(s, "run-c", "run-c-w1", "apr-2", at: 2_100)
    ask(s, "run-a", "run-a-w1", "apr-3", at: 2_200)
    let m = DeskModel(store: s)
    var seen: [String] = []
    for _ in 0..<4 {
      m.nextAsk()
      seen.append("\(m.openRunId ?? "-")/\(m.focusedAgent ?? "-")")
    }
    XCTAssertEqual(seen, ["run-b/run-b-w2", "run-c/run-c-w1", "run-a/run-a-w1", "run-b/run-b-w2"])
    // An answered ask is skipped; the next one after it still comes next.
    decided(s, "run-c", "apr-2", at: 3_000)
    m.nextAsk()
    XCTAssertEqual(m.focusedAgent, "run-a-w1")
    m.openNeedsReel()
    XCTAssertEqual(m.focusedAgent, "run-b-w2")
    m.nextAsk()
    XCTAssertEqual(m.focusedAgent, "run-a-w1")
    XCTAssertTrue(m.needs.isOpen)
  }

  /// Opened from Home, Back returns to Home; opening a project from the title bar leaves the reel without going back.
  @MainActor func testBackReturnsWhereYouCameFrom() {
    let s = store()
    ask(s, "run-b", "run-b-w2", "apr-1", at: 2_000)
    let m = DeskModel(store: s, autoOpens: false)
    XCTAssertTrue(m.homeShown)
    m.openNeedsReel()
    XCTAssertFalse(m.homeShown)
    XCTAssertEqual(m.needs.backLabel, "Home")
    m.closeNeedsReel()
    XCTAssertTrue(m.homeShown)
    m.openNeedsReel()
    m.open(project: m.decks.first?.id)
    XCTAssertFalse(m.needs.isOpen)
    XCTAssertFalse(m.homeShown)
  }
  #endif
}
