import XCTest
import Foundation
@testable import CapcomdStore

/// ADR-026 §4 (capability agents.ask): an agent that asked a question and stopped. From snapshot.agents (`Agent.asked`),
/// snapshot.approvals (kind question, its card in `subject`) and the lifecycle feed's agent.asked / approval.requested /
/// agent.question_passed / agent.answered / approval.decided: it reads "asked" wherever its state shows; asked of an
/// agent it is quiet (no badge, not in Needs you), asked of you it is an ask; its card carries the options, the
/// recommended one's reason and what waits on it; its message box sends the answer; answered, the thread keeps one line.
@MainActor
final class AskedTests: XCTestCase {
  let scope = "lifecycle:run-q"
  static let subject = #"{"questionId":"qst-1","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"recommend":"100 req/min","why":"The docs set the free tier at 100.","holds":null,"to":"agt-p"}"#
  static let asked = #"{"questionId":"qst-1","approvalId":"apr-1","question":"Ship the limiter at 100 or 500 req/min?","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":"The docs set the free tier at 100.","holds":null,"to":"agt-p","at":"2026-11-20T11:40:00.000Z"}"#

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
}
