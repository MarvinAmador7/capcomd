import XCTest
import Foundation
@testable import CapcomdStore
import CapcomdThread

/// ADR-026 §4 (capability agents.ask): an agent that asked a question and stopped. From snapshot.agents (`Agent.asked`),
/// snapshot.approvals (kind question, its card in `subject`) and the lifecycle feed's agent.asked / approval.requested /
/// agent.question_passed / agent.answered / approval.decided: it reads "asked" wherever its state shows; asked of an
/// agent it is quiet (no badge, not in Needs you), asked of you it is an ask; its card carries the options, the
/// recommended one's reason and what waits on it; its message box sends the answer; answered, the thread keeps one line.
@MainActor
final class AskedTests: XCTestCase {
  let scope = "lifecycle:run-q"
  // nonisolated: a default argument (approval(subject:)) reads it outside the main actor.
  nonisolated static let subject = #"{"questionId":"qst-1","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"recommend":"100 req/min","why":"The docs set the free tier at 100.","holds":null,"to":"agt-p"}"#
  nonisolated static let asked = #"{"questionId":"qst-1","approvalId":"apr-1","question":"Ship the limiter at 100 or 500 req/min?","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":"The docs set the free tier at 100.","holds":null,"to":"agt-p","at":"2026-11-20T11:40:00.000Z"}"#

  func feed(_ s: CapcomdStore, workerAsked: String = "null", approvals: String = "[]", workerStatus: String = "done") {
    let agent = { (id: String, profile: String, parent: String, status: String, asked: String) in
      #"{"id":"\#(id)","runId":"run-q","parent":\#(parent),"depth":\#(parent == "null" ? 0 : 1),"profile":"\#(profile)","status":"\#(status)","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-20T11:30:00.000Z","title":\#(profile == "worker" ? #""request limiter""# : "null"),"asked":\#(asked)}"#
    }
    let agents = [agent("agt-p", "planner", "null", "running", "null"), agent("agt-w", "worker", #""agt-p""#, workerStatus, workerAsked)].joined(separator: ",")
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-q","projectId":"prj-q","label":null,"state":"running","goal":"Rate limit the public API"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents)]}"#), ("snapshot.approvals", #"{"approvals":\#(approvals)}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
  }
  func approval(subject: String = AskedTests.subject) -> String {
    #"[{"approvalId":"apr-1","kind":"question","status":"pending","question":"Ship the limiter at 100 or 500 req/min?","requestedBy":{"agentId":"agt-w","runId":"run-q"},"subject":\#(subject),"requestedAt":"2026-11-20T11:40:00.000Z"}]"#
  }
  var seq = 3
  func event(_ s: CapcomdStore, _ type: String, _ data: String, agent: String = "agt-w", ms: Int = 1_795_174_920_000) {
    seq += 1
    let frame = #"{"v":1,"id":"evt_run-q_\#(seq)","scope":"run-q","seq":\#(seq),"entity":"\#(agent)","entitySeq":\#(seq),"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-11-20T11:42:00.000Z","epochMs":\#(ms),"projectId":"prj-q","runId":"run-q","agentId":"\#(agent)","text":"x","data":\#(data)}"#
    s.receive(StreamFrame.parse(event: type, data: frame), scope: scope)
  }

  func testAskedOfItsParentItIsQuietAndItsCardSaysTheParentMayAnswer() throws {
    let s = CapcomdStore()
    feed(s, workerAsked: Self.asked, approvals: approval())
    let w = try XCTUnwrap(s.runs["run-q"]?.agents["agt-w"])
    XCTAssertEqual(w.asked?.questionId, "qst-1")
    XCTAssertEqual(w.asked?.to, "agt-p")
    XCTAssertEqual(s.agentLife(runId: "run-q", agentId: "agt-w"), .asked)
    XCTAssertEqual(AgentLife.asked.word, "asked")
    // Not the user's to decide: no badge, not in Needs you, not an ask on the planner's tree row.
    XCTAssertEqual(s.badgeCount, 0)
    XCTAssertTrue(s.pendingApprovals.isEmpty)
    XCTAssertTrue(s.needsAsks().isEmpty)
    let node = try XCTUnwrap(s.agentTree(runId: "run-q").first?.children.first)
    XCTAssertTrue(node.asked); XCTAssertFalse(node.waiting)
    XCTAssertEqual(node.statusSymbol, .asked)
    XCTAssertTrue(node.accessibilityLabel.contains(", asked,"))
    // Its card, for the user to answer all the same.
    let card = try XCTUnwrap(s.questionCard(runId: "run-q", agentId: "agt-w"))
    XCTAssertEqual(card.question.plain, "Ship the limiter at 100 or 500 req/min?")
    XCTAssertEqual(card.options.map(\.label.plain), ["100 req/min", "500 req/min"])
    XCTAssertEqual(card.options.map(\.recommended), [true, false])
    XCTAssertEqual(card.why?.plain, "The docs set the free tier at 100.")
    XCTAssertNil(card.holds)
    XCTAssertEqual(card.askerName, "request limiter")
    XCTAssertEqual(card.whoLine, "worker · asked planner")
    XCTAssertEqual(card.hint, "Answer as you, or let the planner answer.")
    // Its message box sends the answer.
    XCTAssertEqual(s.composerState(runId: "run-q", agentId: "agt-w", name: "worker").placeholder, "Answer worker…")
    XCTAssertTrue(s.composerState(runId: "run-q", agentId: "agt-w", name: "worker").isIdle)
  }

  func testARootQuestionIsTheUsersAsk() throws {
    let s = CapcomdStore()
    let toYou = AskedTests.subject.replacingOccurrences(of: #""to":"agt-p""#, with: #""to":null"#)
    feed(s, workerAsked: Self.asked.replacingOccurrences(of: #""to":"agt-p""#, with: #""to":null"#), approvals: approval(subject: toYou))
    XCTAssertEqual(s.badgeCount, 1)
    XCTAssertEqual(s.needsAsks().map(\.agentId), ["agt-w"])
    XCTAssertEqual(s.needsAsks().first?.approval?.kind, "question")
    let card = try XCTUnwrap(s.questionCard(runId: "run-q", agentId: "agt-w"))
    XCTAssertEqual(card.whoLine, "worker · asked you")
    XCTAssertNil(card.hint)
  }

  func testLiveAskedPassedUpThenAnsweredLeavesOneLine() throws {
    let s = CapcomdStore()
    feed(s, workerStatus: "running")
    XCTAssertEqual(s.agentLife(runId: "run-q", agentId: "agt-w"), .active)
    event(s, "agent.asked", #"{"questionId":"qst-1","to":"agt-p","question":"Ship the limiter at 100 or 500 req/min?","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":null,"holds":"write tests","cause":"asked"}"#)
    event(s, "approval.requested", #"{"approvalId":"apr-1","kind":"question","question":"Ship the limiter at 100 or 500 req/min?","requestedBy":{"agentId":"agt-w","runId":"run-q"},"subject":\#(Self.subject.replacingOccurrences(of: #""holds":null"#, with: #""holds":"write tests""#)),"expiresAt":null,"cause":"approval_needed"}"#)
    XCTAssertEqual(s.agentLife(runId: "run-q", agentId: "agt-w"), .asked)
    XCTAssertEqual(s.questionCard(runId: "run-q", agentId: "agt-w")?.holds?.plain, "write tests")
    XCTAssertEqual(s.badgeCount, 0)
    // The planner passes it up: now it's yours.
    event(s, "agent.question_passed", #"{"questionId":"qst-1","from":"agt-p","to":null,"cause":"passed_up"}"#)
    XCTAssertEqual(s.badgeCount, 1)
    XCTAssertNil(s.questionCard(runId: "run-q", agentId: "agt-w")?.askedOf)
    XCTAssertNil(s.runs["run-q"]?.agents["agt-w"]?.asked?.to)
    // Answered (not the recommendation, with a note): the card goes, one line stays in its thread.
    event(s, "agent.answered", #"{"questionId":"qst-1","by":"client:desk","answer":"500 req/min","recommended":false,"note":"Our biggest client already does 300.","messageSeq":9,"replaces":null,"cause":"answered"}"#)
    event(s, "approval.decided", #"{"approvalId":"apr-1","status":"answered","decidedBy":{"clientId":"client:desk","principal":"client:desk"},"decidedAt":"2026-11-20T11:44:00.000Z","reason":"Our biggest client already does 300.","answer":"500 req/min","recommended":false,"cause":"answered"}"#)
    XCTAssertNil(s.runs["run-q"]?.agents["agt-w"]?.asked)
    XCTAssertNil(s.questionCard(runId: "run-q", agentId: "agt-w"))
    XCTAssertEqual(s.badgeCount, 0)
    let lines = s.thread(agentId: "agt-w").compactMap { if case .answered(let r, let by) = $0.kind { return (r, by) }; return nil }
    XCTAssertEqual(lines.count, 1)
    let (rec, by) = try XCTUnwrap(lines.first)
    XCTAssertNil(by)
    let l = rec.line(name: by, time: "11:44")
    XCTAssertEqual("\(l.lead) · \(l.answer) · \(l.tail)", "Answered · 500 req/min · not the recommended · 11:44")
    XCTAssertEqual(rec.noteLine(name: by), "Your note: “Our biggest client already does 300.”")
    XCTAssertEqual(s.threadEntries(agentId: "agt-w").count, 1)
  }

  func testAnAgentsAnswerIsNamedInBothThreads() throws {
    let s = CapcomdStore()
    feed(s, workerAsked: Self.asked, approvals: approval())
    event(s, "agent.answered", #"{"questionId":"qst-1","by":"agt-p","answer":"100 req/min","recommended":true,"note":null,"messageSeq":9,"replaces":null,"cause":"answered"}"#)
    for id in ["agt-w", "agt-p"] {
      let line = s.thread(agentId: id).compactMap { if case .answered(let r, let by) = $0.kind { return r.line(name: by, time: "11:42") }; return nil }.first
      XCTAssertEqual(line.map { "\($0.lead) · \($0.answer) · \($0.tail)" }, "planner answered · 100 req/min · 11:42", id)
    }
    XCTAssertEqual(s.agentLife(runId: "run-q", agentId: "agt-w"), .idle)
  }

  func testAWithdrawnQuestionClearsAsked() {
    let s = CapcomdStore()
    feed(s, workerAsked: Self.asked, approvals: approval())
    event(s, "agent.question_withdrawn", #"{"questionId":"qst-1","reason":"cancelled","cause":"withdrawn"}"#)
    XCTAssertNil(s.runs["run-q"]?.agents["agt-w"]?.asked)
  }

  // ── after a reconnect: the thread is the record (ADR-026 §1) ─────────────────────────────────────────────────────
  /// A `question` thread item as GET …/thread serves it.
  func questionItem(_ id: String, agent: String = "agt-w", rev: Int = 3, seq: Int, order: Int, state: String, answer: String? = nil, recommended: Bool? = nil,
                    by: String? = nil, note: String? = nil, asker: String = "agt-w", decidedAt: String? = "2026-11-20T11:44:00.000Z") -> String {
    let q = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    return #"{"id":"\#(id)","rev":\#(rev),"seq":\#(seq),"order":\#(order),"agentId":"\#(agent)","kind":"question","status":"done","at":"2026-11-20T11:40:00.000Z","durationMs":null,"text":"Asked: Ship the limiter at 100 or 500 req/min?","blocks":[{"t":"paragraph","children":[{"t":"text","text":"Asked: Ship the limiter at 100 or 500 req/min?"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null,"internal":false,"question":{"questionId":"qst-1","asker":"\#(asker)","state":"\#(state)","question":"Ship the limiter at 100 or 500 req/min?","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"why":null,"holds":null,"to":null,"passedBy":["agt-p"],"answer":\#(q(answer)),"recommended":\#(recommended.map(String.init) ?? "null"),"by":\#(q(by)),"note":\#(q(note)),"replaces":null,"reason":\#(state == "withdrawn" ? #""cancelled""# : "null"),"askedAt":"2026-11-20T11:40:00.000Z","decidedAt":\#(q(decidedAt))}}"#
  }
  func sayItem(_ id: String, agent: String = "agt-w", seq: Int, order: Int, at: String) -> String {
    #"{"id":"\#(id)","rev":1,"seq":\#(seq),"order":\#(order),"agentId":"\#(agent)","kind":"say","status":"done","at":"\#(at)","durationMs":null,"text":"t","blocks":[{"t":"paragraph","children":[{"t":"text","text":"t"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null}"#
  }
  func tail(_ items: [String]) -> CapcomdThread.Tail {
    let page = try! JSONDecoder().decode(CapcomdThread.Page.self, from: Data(#"{"items":[\#(items.joined(separator: ","))],"next":null}"#.utf8))
    return CapcomdThread.Tail(items: page.items, before: nil, cursor: 50)
  }
  /// "HH:mm" in UTC: the fixtures' times are UTC.
  func clock(_ ms: Int) -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm"; f.timeZone = TimeZone(identifier: "UTC")
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }
  /// The question lines a thread shows, in order, as "lead · words · tail" (and the note line), each at its own time.
  func lines(_ s: CapcomdStore, _ agentId: String) -> [String] {
    s.threadEntries(agentId: agentId).compactMap { e -> String? in
      guard case .event(let it) = e else { return nil }
      switch it.kind {
      case .answered(let r, let by):
        let l = r.line(name: by, time: clock(r.atMs))
        return ["\(l.lead) · \(l.answer) · \(l.tail)", r.noteLine(name: by)].compactMap { $0 }.joined(separator: " / ")
      case .withdrawn(let w):
        let l = w.line(time: clock(w.atMs)); return "\(l.lead) · \(l.question) · \(l.tail)"
      default: return nil
      }
    }
  }

  func testAfterAReconnectTheThreadAloneRebuildsTheAnsweredLine() async throws {
    // A new store (the app restarted, or reconnected after the answer): the snapshot has no open question and no
    // approval, and no agent.answered comes again. Only the thread read brings it back.
    let t = FakeThread()
    t.tails[nil] = tail([sayItem("i1", seq: 1, order: 1, at: "2026-11-20T11:39:00.000Z"),
                         questionItem("itm-agt-w-question-qst-1", seq: 9, order: 2, state: "answered", answer: "500 req/min", recommended: false,
                                      by: "client:desk", note: "Our biggest client already does 300."),
                         sayItem("i3", seq: 10, order: 3, at: "2026-11-20T11:45:00.000Z")])
    let s = CapcomdStore(thread: t)
    feed(s)
    XCTAssertTrue(s.thread(agentId: "agt-w").isEmpty)   // nothing from live events
    await s.refreshThread(runId: "run-q", agentId: "agt-w")
    XCTAssertEqual(lines(s, "agt-w"), ["Answered · 500 req/min · not the recommended · 11:44 / Your note: “Our biggest client already does 300.”"])
    // One line where the card was, between the turns, and not also as a raw item.
    let ids = s.threadEntries(agentId: "agt-w").map { e -> String in
      switch e { case .item(let i, _): i.id; case .event(let it): it.questionId.map { "line:\($0)" } ?? it.id }
    }
    XCTAssertEqual(ids, ["i1", "line:qst-1", "i3"])
    let rec = try XCTUnwrap(s.threadEntries(agentId: "agt-w").compactMap { e -> AnsweredQuestion? in
      if case .event(let it) = e, case .answered(let r, _) = it.kind { return r }; return nil
    }.first)
    XCTAssertEqual(rec.atMs, 1_795_175_040_000)   // when it was answered (decidedAt), for its clock
    XCTAssertNil(s.questionCard(runId: "run-q", agentId: "agt-w"))
  }

  func testAfterAReconnectAnAgentsAnswerIsNamedAndAWithdrawnQuestionStays() async {
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s)
    // The planner answered (the recommendation): its own thread keeps its copy, named as the live line was.
    t.tails[nil] = tail([questionItem("itm-agt-p-answered-qst-1", agent: "agt-p", seq: 9, order: 4, state: "answered", answer: "100 req/min", recommended: true, by: "agt-p")])
    await s.refreshThread(runId: "run-q", agentId: "agt-p")
    XCTAssertEqual(lines(s, "agt-p"), ["planner answered · 100 req/min · 11:44"])
    // A withdrawn one reads as withdrawn.
    t.tails[nil] = tail([questionItem("itm-agt-w-question-qst-1", seq: 9, order: 2, state: "withdrawn")])
    await s.refreshThread(runId: "run-q", agentId: "agt-w")
    XCTAssertEqual(lines(s, "agt-w"), ["Withdrawn · Ship the limiter at 100 or 500 req/min? · 11:44"])
    // An open one is its docked card (from its approval), not a line.
    t.tails[nil] = tail([questionItem("itm-agt-w-question-qst-1", seq: 9, order: 2, state: "open", decidedAt: nil)])
    let s2 = CapcomdStore(thread: t)
    feed(s2, workerAsked: Self.asked, approvals: approval())
    await s2.refreshThread(runId: "run-q", agentId: "agt-w")
    XCTAssertEqual(lines(s2, "agt-w"), [])
    XCTAssertTrue(s2.threadEntries(agentId: "agt-w").isEmpty)
    XCTAssertNotNil(s2.questionCard(runId: "run-q", agentId: "agt-w"))
  }

  func testLiveAndRecordedShowOneLine() async {
    // Live: agent.answered builds the line at once; the thread's record of the same answer then replaces it.
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s, workerAsked: Self.asked, approvals: approval())
    t.tails[nil] = tail([questionItem("itm-agt-w-question-qst-1", rev: 1, seq: 9, order: 2, state: "open", decidedAt: nil)])
    await s.refreshThread(runId: "run-q", agentId: "agt-w")
    event(s, "agent.answered", #"{"questionId":"qst-1","by":"agt-p","answer":"100 req/min","recommended":true,"note":null,"messageSeq":9,"replaces":null,"cause":"answered"}"#)
    XCTAssertEqual(lines(s, "agt-w"), ["planner answered · 100 req/min · 11:42"])   // the record is still open: the live line shows
    s.followThreads(runId: "run-q", holder: CapcomdStore.reelHolder)
    s.applyThreadFrame(runId: "run-q", agentId: "agt-w", ["item": try! JSONDecoder().decode(JSONValue.self, from: Data(
      questionItem("itm-agt-w-question-qst-1", seq: 11, order: 2, state: "answered", answer: "100 req/min", recommended: true, by: "agt-p").utf8))])
    XCTAssertEqual(lines(s, "agt-w"), ["planner answered · 100 req/min · 11:44"])
  }

  func testALiveWithdrawnQuestionLeavesALine() {
    let s = CapcomdStore()
    feed(s, workerAsked: Self.asked, approvals: approval())
    event(s, "agent.question_withdrawn", #"{"questionId":"qst-1","reason":"cancelled","cause":"withdrawn"}"#)
    let w = s.thread(agentId: "agt-w").compactMap { if case .withdrawn(let w) = $0.kind { return w.line(time: "11:42") }; return nil }
    XCTAssertEqual(w.map { "\($0.lead) · \($0.question) · \($0.tail)" }, ["Withdrawn · Ship the limiter at 100 or 500 req/min? · 11:42"])
  }
}
