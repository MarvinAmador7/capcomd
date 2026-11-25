import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
import CapcomdUI
import SwiftUI
#endif

/// A question an agent asked and stopped on (capability agents.ask, DurableAsked-v3), drawn as the window draws it from
/// the frames the daemon sends (snapshot.agents with `asked`, snapshot.approvals of kind question, then agent.answered):
/// the card with no reason, a one-line reason, a long one with what waits on it, asked of you, the asker's whole pane,
/// and the answered line. With PANE_CAPTURE_DIR=<dir> each is written to <dir>/<name>.png; without it they are drawn only.
final class QuestionCaptureTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  let scope = "lifecycle:run-q"
  static let question = "Ship the limiter at 100 or 500 req/min?"
  static let longWhy = "docs/api/limits.md sets the free tier at 100 a minute, and the gateway shares one pool across every key. At 500, four busy keys would take the whole pool and starve the rest, which is the thing the goal asks to prevent. Paid tiers can raise their own limit later."

  @MainActor func store(why: String?, holds: String?, toPlanner: Bool = true) -> CapcomdStore {
    let s = CapcomdStore()
    let to = toPlanner ? #""agt-p""# : "null"
    let j = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    let asked = #"{"questionId":"qst-1","approvalId":"apr-1","question":"\#(Self.question)","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":\#(j(why)),"holds":\#(j(holds)),"to":\#(to),"at":"2026-11-20T11:40:00.000Z"}"#
    let agent = { (id: String, profile: String, parent: String, status: String, asked: String, title: String) in
      #"{"id":"\#(id)","runId":"run-q","parent":\#(parent),"depth":\#(parent == "null" ? 0 : 1),"profile":"\#(profile)","status":"\#(status)","text":"x","task":"Rate limit the public API per key","taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-20T11:30:00.000Z","provider":"claude","title":"\#(title)","asked":\#(asked)}"#
    }
    let agents = toPlanner
      ? [agent("agt-p", "planner", "null", "running", "null", "rate limit api"), agent("agt-w", "worker", #""agt-p""#, "done", asked, "request limiter")]
      : [agent("agt-w", "planner", "null", "done", asked, "request limiter")]
    let subject = #"{"questionId":"qst-1","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"recommend":"100 req/min","why":\#(j(why)),"holds":\#(j(holds)),"to":\#(to)}"#
    let approvals = #"[{"approvalId":"apr-1","kind":"question","status":"pending","question":"\#(Self.question)","requestedBy":{"agentId":"agt-w","runId":"run-q"},"subject":\#(subject),"requestedAt":"2026-11-20T11:40:00.000Z"}]"#
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-q","projectId":"prj-q","label":null,"state":"running","goal":"Rate limit the public API per key","sandbox":"boxd"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents.joined(separator: ","))]}"#), ("snapshot.approvals", #"{"approvals":\#(approvals)}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
    s.capabilities = [Capability.agentsIdle]
    s.changed()
    return s
  }

  @MainActor func testTheCardFollowsTheBoard() throws {
    let m = DeskModel(store: store(why: "The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.", holds: nil))
    let card = try XCTUnwrap(m.agent("agt-w")?.question)
    XCTAssertEqual(card.options.first?.recommended, true)
    XCTAssertEqual(card.whoLine, "worker · asked planner")
    XCTAssertEqual(card.hint, "Answer as you, or let the planner answer.")
    // Asked of the planner: no amber ring, no Needs you, the row reads "asked".
    XCTAssertNil(m.agent("agt-w")?.approval)
    XCTAssertEqual(m.agent("agt-w")?.header.life, .asked)
    XCTAssertEqual(DeskModel.sidebarWord(try XCTUnwrap(m.agent("agt-w")?.header), approval: nil, limit: nil).0, "asked")
    XCTAssertEqual(m.agent("agt-w")?.composer?.placeholder, "Answer worker…")
    // Asked of you: the column asks.
    let you = DeskModel(store: store(why: nil, holds: nil, toPlanner: false))
    XCTAssertEqual(you.agent("agt-w")?.approval?.kind, "question")
    XCTAssertEqual(you.agent("agt-w")?.question?.whoLine, "planner · asked you")
  }

  @MainActor func testDrawsTheCardInEachState() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let cards: [(String, String?, String?, Bool)] = [
      ("question-no-reason", nil, nil, true),
      ("question-reason", "The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.", nil, true),
      ("question-long-reason", Self.longWhy, "write tests · open PR", true),
      ("question-asked-of-you", "The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.", nil, false),
    ]
    for (name, why, holds, toPlanner) in cards {
      let m = DeskModel(store: store(why: why, holds: holds, toPlanner: toPlanner))
      let card = try XCTUnwrap(m.agent("agt-w")?.question, name)
      try Self.draw(AnyView(QuestionCard(card: card, focused: true)), model: m, width: 432, name: name, into: dir)
    }
    // The asker's whole pane: its thread, the card, then the box whose message is its answer.
    let m = DeskModel(store: store(why: "The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.", holds: "write tests"))
    try Self.drawPane("agt-w", m, name: "question-pane", into: dir, size: CGSize(width: 760, height: 640))
  }

  @MainActor func testDrawsTheAnsweredLine() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let at = 1_795_174_920_000
    let lines: [(String, AnsweredQuestion, String?)] = [
      ("answered-recommended", AnsweredQuestion(questionId: "qst-1", answer: "100 req/min", recommended: true, by: "client:desk", note: nil, atMs: at), nil),
      ("answered-not-recommended", AnsweredQuestion(questionId: "qst-1", answer: "500 req/min", recommended: false, by: "client:desk", note: "Our biggest client already does 300.", atMs: at + 120_000), nil),
      ("answered-by-planner", AnsweredQuestion(questionId: "qst-1", answer: "100 req/min", recommended: true, by: "agt-p", note: "the docs win", atMs: at), "planner"),
    ]
    let m = DeskModel(store: store(why: nil, holds: nil))
    for (name, rec, by) in lines {
      try Self.draw(AnyView(AnsweredLine(record: rec, byName: by).padding(.horizontal, 12)), model: m, width: 432, name: name, into: dir)
    }
  }

  /// Draws an agent's opened pane offscreen (as PaneCaptureTests.draw, for any agent); with `dir`, to <dir>/<name>.png.
  @MainActor static func drawPane(_ agentId: String, _ m: DeskModel, name: String, into dir: URL?, size: CGSize, settle: Int = 8) throws {
    let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.appearance = NSAppearance(named: .darkAqua)
    let pane = NativeColumnView(agentId: agentId, model: m, style: .pane, pane: PaneState(id: 0))
    pane.frame = CGRect(origin: .zero, size: size)
    w.contentView = pane
    for _ in 0..<settle { pane.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    let rep = try XCTUnwrap(pane.bitmapImageRepForCachingDisplay(in: pane.bounds))
    pane.cacheDisplay(in: pane.bounds, to: rep)
    if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
    w.contentView = nil
  }

  /// Draws a view on the column's ground at `width`, offscreen; with `dir`, writes it to <dir>/<name>.png.
  @MainActor static func draw(_ view: AnyView, model: DeskModel, width: CGFloat, name: String, into dir: URL?) throws {
    let host = NSHostingView(rootView: view.padding(.vertical, 16).frame(width: width, alignment: .topLeading).background(Theme.Desk.column)
      .environment(model).environment(\.colorScheme, .dark))
    let size = host.fittingSize
    let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.appearance = NSAppearance(named: .darkAqua)
    host.frame = CGRect(origin: .zero, size: size)
    w.contentView = host
    for _ in 0..<6 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    XCTAssertGreaterThan(size.height, 30, name)
    let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
    host.cacheDisplay(in: host.bounds, to: rep)
    if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
    w.contentView = nil
  }
  #endif
}
