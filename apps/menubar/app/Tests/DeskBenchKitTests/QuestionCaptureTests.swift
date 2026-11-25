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

  // ── another agent's thread (QuestionLine): the compact line, its popover, the root's card for you ─────────────────
  /// planner (root) → lead → worker; the worker asked. `items` per agent, as the thread routes and frames serve them.
  @MainActor func treeStore(to: String?, items: [String: [String]]) -> CapcomdStore {
    let s = CapcomdStore()
    let j = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    let asked = #"{"questionId":"qst-1","approvalId":"apr-1","question":"\#(Self.question)","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":"The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.","holds":"write tests","to":\#(j(to)),"at":"2026-11-20T11:40:00.000Z"}"#
    let agent = { (id: String, profile: String, parent: String?, status: String, asked: String, title: String) in
      #"{"id":"\#(id)","runId":"run-q","parent":\#(j(parent)),"depth":0,"profile":"\#(profile)","status":"\#(status)","text":"x","task":"Rate limit the public API per key","taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-20T11:30:00.000Z","provider":"claude","title":"\#(title)","asked":\#(asked)}"#
    }
    let agents = [agent("agt-p", "planner", nil, "running", "null", "rate limit api"), agent("agt-l", "lead", "agt-p", "running", "null", "api lead"),
                  agent("agt-w", "worker", "agt-l", "done", asked, "request limiter")]
    let subject = #"{"questionId":"qst-1","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"recommend":"100 req/min","why":"The docs set the free tier at 100; at 500 a few busy keys use up the shared pool.","holds":"write tests","to":\#(j(to))}"#
    let approvals = #"[{"approvalId":"apr-1","kind":"question","status":"pending","question":"\#(Self.question)","requestedBy":{"agentId":"agt-w","runId":"run-q"},"subject":\#(subject),"requestedAt":"2026-11-20T11:40:00.000Z"}]"#
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-q","projectId":"prj-q","label":null,"state":"running","goal":"Rate limit the public API per key","sandbox":"boxd"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents.joined(separator: ","))]}"#), ("snapshot.approvals", #"{"approvals":\#(approvals)}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
    s.capabilities = [Capability.agentsIdle]
    s.followThreads(runId: "run-q", holder: CapcomdStore.reelHolder)
    for (agentId, list) in items {
      for it in list { s.applyThreadFrame(runId: "run-q", agentId: agentId, ["item": try! JSONDecoder().decode(JSONValue.self, from: Data(it.utf8))]) }
    }
    s.changed()
    return s
  }
  static func say(_ id: String, _ agent: String, order: Int, at: String, _ text: String) -> String {
    #"{"id":"\#(id)","rev":1,"seq":\#(order),"order":\#(order),"agentId":"\#(agent)","kind":"say","status":"done","at":"\#(at)","durationMs":null,"text":"\#(text)","blocks":[{"t":"paragraph","children":[{"t":"text","text":"\#(text)"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null}"#
  }
  static func held(_ agent: String, order: Int = 2, state: String = "open", to: String?, passedBy: [String] = [], answer: String? = nil, recommended: Bool? = nil,
                   by: String? = nil, note: String? = nil, at: String = "2026-11-20T11:40:00.000Z", decidedAt: String? = nil) -> String {
    let j = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    let passed = passedBy.map { #""\#($0)""# }.joined(separator: ",")
    return #"{"id":"itm-\#(agent)-asked-qst-1","rev":1,"seq":\#(order),"order":\#(order),"agentId":"\#(agent)","kind":"question","status":"done","at":"\#(at)","durationMs":null,"text":"agt-w asked","blocks":[],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null,"question":{"questionId":"qst-1","asker":"agt-w","state":"\#(state)","question":"\#(question)","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"why":null,"holds":"write tests","to":\#(j(to)),"passedBy":[\#(passed)],"answer":\#(j(answer)),"recommended":\#(recommended.map(String.init) ?? "null"),"by":\#(j(by)),"note":\#(j(note)),"replaces":null,"reason":\#(state == "withdrawn" ? #""cancelled""# : "null"),"askedAt":"2026-11-20T11:40:00.000Z","decidedAt":\#(j(decidedAt))}}"#
  }
  @MainActor func line(_ s: CapcomdStore, _ agentId: String) throws -> QuestionLine {
    try XCTUnwrap(s.threadEntries(agentId: agentId).compactMap { if case .event(let it) = $0, case .question(let l) = it.kind { return l }; return nil }.first)
  }

  @MainActor func testDrawsTheLineInTheParentsThreadAndTheRootsCard() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let decided = "2026-11-20T11:44:00.000Z"
    let states: [(String, String?, String)] = [
      ("parent-line-open", "agt-l", Self.held("agt-l", to: "agt-l")),
      ("parent-line-answered", "agt-l", Self.held("agt-l", state: "answered", to: "agt-l", answer: "500 req/min", recommended: false, by: "agt-l",
                                                  note: "Our biggest client already does 300.", decidedAt: decided)),
      ("parent-line-answered-by-you", "agt-l", Self.held("agt-l", state: "answered", to: "agt-l", answer: "100 req/min", recommended: true, by: "client:desk", decidedAt: decided)),
      ("parent-line-passed-up", "agt-p", Self.held("agt-l", to: "agt-p", passedBy: ["agt-l"])),
      ("parent-line-passed-up-to-you", nil, Self.held("agt-l", to: nil, passedBy: ["agt-l", "agt-p"])),
      ("parent-line-withdrawn", "agt-l", Self.held("agt-l", state: "withdrawn", to: "agt-l", decidedAt: decided)),
    ]
    for (name, to, item) in states {
      let s = treeStore(to: to, items: ["agt-l": [item]])
      let m = DeskModel(store: s)
      let l = try line(s, "agt-l")
      XCTAssertFalse(l.forYou, name)
      try Self.draw(AnyView(QuestionLineRow(runId: "run-q", agentId: "agt-l", line: l, proseWidth: nil).padding(.horizontal, 16)
        .environment(\.threadHost, ThreadHostBox(host: m))), model: m, width: 432, name: name, into: dir)
    }
    // The popover Answer opens: the asker's own card, under its line (as NSPopover draws it, anchored to the line).
    let s = treeStore(to: "agt-l", items: ["agt-l": [Self.held("agt-l", to: "agt-l")]])
    let m = DeskModel(store: s)
    let l = try line(s, "agt-l")
    let card = try XCTUnwrap(l.card)
    XCTAssertEqual(card, s.questionCard(runId: "run-q", agentId: "agt-w"))
    try Self.draw(AnyView(VStack(alignment: .leading, spacing: 4) {
      QuestionLineRow(runId: "run-q", agentId: "agt-l", line: l, proseWidth: nil).padding(.horizontal, 16)
      QuestionCard(card: card, focused: true, placement: .popover(done: {})).frame(width: 432)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color(nsColor: .windowBackgroundColor)))
        .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
        .padding(.leading, 40)
    }.environment(\.threadHost, ThreadHostBox(host: m))), model: m, width: 520, name: "parent-line-popover", into: dir)
    // The question is the user's: the root's pane draws its card in the line's place (and the lead's says where it went).
    let you = treeStore(to: nil, items: [
      "agt-p": [Self.say("p1", "agt-p", order: 1, at: "2026-11-20T11:35:00.000Z", "I split the work: the lead takes the request limiter."),
                Self.held("agt-p", to: nil, passedBy: ["agt-l", "agt-p"], at: "2026-11-20T11:41:00.000Z"),
                Self.say("p3", "agt-p", order: 3, at: "2026-11-20T11:42:00.000Z", "Passed the limit question up to you: it is a product call. Meanwhile I review the docs branch.")],
      "agt-l": [Self.held("agt-l", to: nil, passedBy: ["agt-l", "agt-p"])],
    ])
    let root = try line(you, "agt-p")
    XCTAssertTrue(root.forYou)
    XCTAssertEqual(root.card?.whoLine, "worker · asked you")
    let ym = DeskModel(store: you)
    try Self.drawPane("agt-p", ym, name: "root-thread-for-you-card", into: dir, size: CGSize(width: 760, height: 720))
    try Self.drawPane("agt-l", ym, name: "lead-thread-passed-up-to-you", into: dir, size: CGSize(width: 760, height: 360))
  }

  // ── v4: one row when it fits, the asker's "asked you" line, the root's card, the quiet withdrawn line ─────────────
  /// The row's height at `width`, as the thread lays it out.
  @MainActor static func height(_ view: AnyView, model: DeskModel, width: CGFloat) -> CGFloat {
    let host = NSHostingView(rootView: view.frame(width: width, alignment: .topLeading).environment(model).environment(\.colorScheme, .dark))
    return host.fittingSize.height
  }

  @MainActor func testV4Captures() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    // One row in a pane's width, two in a reel column's: ViewThatFits decides, no width of ours.
    let s = treeStore(to: "agt-l", items: ["agt-l": [Self.held("agt-l", to: "agt-l")]])
    let m = DeskModel(store: s)
    let l = try line(s, "agt-l")
    let row = { AnyView(QuestionLineRow(runId: "run-q", agentId: "agt-l", line: l, proseWidth: nil).padding(.horizontal, 16).environment(\.threadHost, ThreadHostBox(host: m))) }
    let wide = Self.height(row(), model: m, width: 720), narrow = Self.height(row(), model: m, width: 432)
    XCTAssertLessThan(wide, narrow, "one row at 720 pt, two at 432 pt")
    try Self.draw(row(), model: m, width: 720, name: "v4-line-one-row-pane", into: dir)
    try Self.draw(row(), model: m, width: 432, name: "v4-line-two-rows-column", into: dir)
    let answered = treeStore(to: "agt-l", items: ["agt-l": [Self.held("agt-l", state: "answered", to: "agt-l", answer: "500 req/min", recommended: false, by: "agt-l",
                                                                      note: "Our biggest client already does 300.", decidedAt: "2026-11-20T11:44:00.000Z")]])
    let am = DeskModel(store: answered)
    let al = try line(answered, "agt-l")
    try Self.draw(AnyView(QuestionLineRow(runId: "run-q", agentId: "agt-l", line: al, proseWidth: nil).padding(.horizontal, 16)
      .environment(\.threadHost, ThreadHostBox(host: am))), model: am, width: 720, name: "v4-line-answered-one-row-pane", into: dir)
    // Passed up to you: the asker's pane has its line "asked you" (no docked card); the root's pane has the card.
    let you = treeStore(to: nil, items: [
      "agt-p": [Self.say("p1", "agt-p", order: 1, at: "2026-11-20T11:35:00.000Z", "I split the work: the lead takes the request limiter."),
                Self.held("agt-p", to: nil, passedBy: ["agt-l", "agt-p"], at: "2026-11-20T11:41:00.000Z")],
      "agt-w": [Self.say("w1", "agt-w", order: 1, at: "2026-11-20T11:38:00.000Z", "The gateway shares one pool across every key; the limit decides how it is split.")],
    ])
    XCTAssertEqual(you.questionCard(runId: "run-q", agentId: "agt-w")?.docks, false)
    let ym = DeskModel(store: you)
    try Self.drawPane("agt-w", ym, name: "v4-asker-asked-you", into: dir, size: CGSize(width: 760, height: 420))
    try Self.drawPane("agt-p", ym, name: "v4-root-card", into: dir, size: CGSize(width: 760, height: 720))
    // Withdrawn: the asker's record and the parent's line, one quiet line each (the reason is the hover help).
    let w = treeStore(to: "agt-l", items: ["agt-l": [Self.held("agt-l", state: "withdrawn", to: "agt-l", decidedAt: "2026-11-20T11:44:00.000Z")]])
    let wm = DeskModel(store: w)
    let wl = try line(w, "agt-l")
    try Self.draw(AnyView(VStack(alignment: .leading, spacing: 12) {
      WithdrawnLine(record: WithdrawnQuestion(questionId: "qst-1", question: Self.question, atMs: 1_795_175_040_000))
      QuestionLineRow(runId: "run-q", agentId: "agt-l", line: wl, proseWidth: nil).padding(.horizontal, 16)
    }.environment(\.threadHost, ThreadHostBox(host: wm))), model: wm, width: 432, name: "v4-withdrawn", into: dir)
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
