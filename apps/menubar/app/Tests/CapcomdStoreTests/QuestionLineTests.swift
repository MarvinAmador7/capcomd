import XCTest
import Foundation
@testable import CapcomdStore
import CapcomdThread

/// ADR-026 §4, §9.1 (capability agents.ask): a question in the thread of an agent that didn't ask it, as the daemon
/// records it there (`itm-<agent>-asked-<qst>`, kind question): one compact line at the question's one state where it
/// reached that agent (open with Answer, answered, passed up, withdrawn), built from the thread alone after a reconnect;
/// in the run's root thread, when the question is the user's, its full card instead. Answering anywhere turns every
/// place into the answered line at once, and no thread shows two full cards for one question.
@MainActor
final class QuestionLineTests: XCTestCase {
  let scope = "lifecycle:run-q"
  static let question = "Ship the limiter at 100 or 500 req/min?"

  /// planner (root, "rate limit api") → lead ("api lead") → worker ("request limiter"), the worker asked.
  func feed(_ s: CapcomdStore, to: String? = "agt-l", approval: Bool = true, workerStatus: String = "done", messages: String = "[]", on scope: String? = nil) {
    let q = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    let asked = #"{"questionId":"qst-1","approvalId":"apr-1","question":"\#(Self.question)","recommend":"100 req/min","options":["100 req/min","500 req/min"],"why":"The docs set the free tier at 100.","holds":"write tests","to":\#(q(to)),"at":"2026-11-20T11:40:00.000Z"}"#
    let agent = { (id: String, profile: String, parent: String?, status: String, asked: String, title: String) in
      #"{"id":"\#(id)","runId":"run-q","parent":\#(q(parent)),"depth":0,"profile":"\#(profile)","status":"\#(status)","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"2026-11-20T11:30:00.000Z","title":"\#(title)","asked":\#(asked)}"#
    }
    let agents = [agent("agt-p", "planner", nil, "running", "null", "rate limit api"), agent("agt-l", "lead", "agt-p", "running", "null", "api lead"),
                  agent("agt-w", "worker", "agt-l", workerStatus, asked, "request limiter")].joined(separator: ",")
    let subject = #"{"questionId":"qst-1","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"recommend":"100 req/min","why":"The docs set the free tier at 100.","holds":"write tests","to":\#(q(to))}"#
    let approvals = approval ? #"[{"approvalId":"apr-1","kind":"question","status":"pending","question":"\#(Self.question)","requestedBy":{"agentId":"agt-w","runId":"run-q"},"subject":\#(subject),"requestedAt":"2026-11-20T11:40:00.000Z"}]"# : "[]"
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-q","projectId":"prj-q","label":null,"state":"running","goal":"Rate limit the public API"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agents)]}"#), ("snapshot.approvals", #"{"approvals":\#(approvals)}"#), ("snapshot.threads", #"{"messages":\#(messages)}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope ?? self.scope)
    }
  }
  var seq = 3
  func event(_ s: CapcomdStore, _ type: String, _ data: String, agent: String = "agt-w", ms: Int = 1_795_174_920_000) {
    seq += 1
    let frame = #"{"v":1,"id":"evt_run-q_\#(seq)","scope":"run-q","seq":\#(seq),"entity":"\#(agent)","entitySeq":\#(seq),"type":"\#(type)","typeVersion":1,"durability":"durable","ts":"2026-11-20T11:42:00.000Z","epochMs":\#(ms),"projectId":"prj-q","runId":"run-q","agentId":"\#(agent)","text":"x","data":\#(data)}"#
    s.receive(StreamFrame.parse(event: type, data: frame), scope: scope)
  }

  /// The question item as GET …/thread serves it in `agent`'s thread (another agent's: `asker` asked it).
  func item(_ agent: String, rev: Int = 1, seq: Int = 9, order: Int = 2, state: String = "open", to: String? = "agt-l", passedBy: [String] = [],
            answer: String? = nil, recommended: Bool? = nil, by: String? = nil, note: String? = nil, asker: String = "agt-w",
            at: String = "2026-11-20T11:40:00.000Z", decidedAt: String? = nil) -> String {
    let q = { (v: String?) in v.map { #""\#($0)""# } ?? "null" }
    let id = agent == asker ? "itm-\(agent)-question-qst-1" : "itm-\(agent)-asked-qst-1"
    let passed = passedBy.map { #""\#($0)""# }.joined(separator: ",")
    return #"{"id":"\#(id)","rev":\#(rev),"seq":\#(seq),"order":\#(order),"agentId":"\#(agent)","kind":"question","status":"done","at":"\#(at)","durationMs":null,"text":"agt-w asked: \#(Self.question)","blocks":[{"t":"paragraph","children":[{"t":"text","text":"agt-w asked"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null,"internal":false,"question":{"questionId":"qst-1","asker":"\#(asker)","state":"\#(state)","question":"\#(Self.question)","options":[{"label":"100 req/min","recommended":true},{"label":"500 req/min","recommended":false}],"why":"The docs set the free tier at 100.","holds":"write tests","to":\#(q(to)),"passedBy":[\#(passed)],"answer":\#(q(answer)),"recommended":\#(recommended.map(String.init) ?? "null"),"by":\#(q(by)),"note":\#(q(note)),"replaces":null,"reason":\#(state == "withdrawn" ? #""cancelled""# : "null"),"askedAt":"2026-11-20T11:40:00.000Z","decidedAt":\#(q(decidedAt))}}"#
  }
  func say(_ id: String, agent: String, seq: Int, order: Int, at: String) -> String {
    #"{"id":"\#(id)","rev":1,"seq":\#(seq),"order":\#(order),"agentId":"\#(agent)","kind":"say","status":"done","at":"\#(at)","durationMs":null,"text":"t","blocks":[{"t":"paragraph","children":[{"t":"text","text":"t"}]}],"format":"blocks/1","redacted":false,"tool":null,"error":null,"truncated":null,"child":null}"#
  }
  func load(_ s: CapcomdStore, _ t: FakeThread, _ agent: String, _ items: [String]) async {
    let page = try! JSONDecoder().decode(CapcomdThread.Page.self, from: Data(#"{"items":[\#(items.joined(separator: ","))],"next":null}"#.utf8))
    t.tails[nil] = CapcomdThread.Tail(items: page.items, before: nil, cursor: 50)
    await s.refreshThread(runId: "run-q", agentId: agent)
  }
  /// A new store (the app restarted) that reads only `agent`'s thread: the line from the record alone.
  func fresh(to: String? = "agt-l", _ agent: String, _ items: [String]) async -> CapcomdStore {
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s, to: to, approval: false)
    await load(s, t, agent, items)
    return s
  }
  /// The question lines (and full cards) another agent's thread shows, in order.
  func lines(_ s: CapcomdStore, _ agent: String) -> [QuestionLine] {
    s.threadEntries(agentId: agent).compactMap { if case .event(let it) = $0, case .question(let l) = it.kind { return l }; return nil }
  }

  func testAfterAReconnectTheParentsLineComesFromItsThreadAlone() async throws {
    // A new store: no approval in the snapshot yet, no live event. Only the lead's thread brings the line back, placed
    // when the question reached the lead.
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s, approval: false)
    await load(s, t, "agt-l", [say("i1", agent: "agt-l", seq: 1, order: 1, at: "2026-11-20T11:39:00.000Z"), item("agt-l"),
                               say("i3", agent: "agt-l", seq: 10, order: 3, at: "2026-11-20T11:45:00.000Z")])
    let ids = s.threadEntries(agentId: "agt-l").map { e -> String in
      switch e { case .item(let i, _): i.id; case .event(let it): it.questionId.map { "line:\($0)" } ?? it.id }
    }
    XCTAssertEqual(ids, ["i1", "line:qst-1", "i3"])
    let l = try XCTUnwrap(lines(s, "agt-l").first)
    XCTAssertEqual(l.summary, "request limiter asked: \(Self.question) · waiting on api lead")
    XCTAssertEqual(l.state, .open(waitingOn: "api lead"))
    XCTAssertFalse(l.forYou)
    XCTAssertEqual(l.askerId, "agt-w")
    XCTAssertEqual(l.atMs, 1_795_174_800_000)
    // Answer opens the card from the record (no approval here yet): the same card the asker docks.
    let card = try XCTUnwrap(l.card)
    XCTAssertEqual(card.approvalId, "q:qst-1")
    XCTAssertEqual(card.askerId, "agt-w")
    XCTAssertEqual(card.options.map(\.label.plain), ["100 req/min", "500 req/min"])
    XCTAssertEqual(card.why?.plain, "The docs set the free tier at 100.")
    XCTAssertEqual(card.holds?.plain, "write tests")
    XCTAssertEqual(card.whoLine, "worker · asked lead")
    // Answered, passed up, withdrawn: each from the record alone.
    var s2 = await fresh("agt-l", [item("agt-l", rev: 3, state: "answered", answer: "500 req/min", recommended: false, by: "agt-l",
                                        note: "our biggest client does 300", decidedAt: "2026-11-20T11:44:00.000Z")])
    var a = try XCTUnwrap(lines(s2, "agt-l").first)
    XCTAssertEqual(a.summary, "request limiter asked: \(Self.question) · api lead answered 500 req/min — not the recommendation")
    XCTAssertEqual(a.noteLine, "api lead's note: “our biggest client does 300”")
    XCTAssertNil(a.card)
    s2 = await fresh("agt-l", [item("agt-l", rev: 4, state: "answered", answer: "100 req/min", recommended: true, by: "client:desk", decidedAt: "2026-11-20T11:46:00.000Z")])
    a = try XCTUnwrap(lines(s2, "agt-l").first)
    XCTAssertEqual(a.outcome.map { "\($0.lead) \($0.answer) \($0.tail)" }, "You answered 100 req/min (recommended)")
    s2 = await fresh(to: "agt-p", "agt-l", [item("agt-l", rev: 2, to: "agt-p", passedBy: ["agt-l"])])
    XCTAssertEqual(lines(s2, "agt-l").first?.summary, "request limiter asked: \(Self.question) · passed up to rate limit api")
    s2 = await fresh(to: "agt-p", "agt-p", [item("agt-p", to: "agt-p", passedBy: ["agt-l"], at: "2026-11-20T11:41:00.000Z")])
    XCTAssertEqual(lines(s2, "agt-p").first?.summary, "request limiter asked: \(Self.question) · waiting on rate limit api")
    XCTAssertEqual(lines(s2, "agt-p").first?.atMs, 1_795_174_860_000)   // when it reached the planner
    s2 = await fresh(to: "agt-p", "agt-l", [item("agt-l", rev: 3, state: "withdrawn", to: "agt-p", passedBy: ["agt-l"], decidedAt: "2026-11-20T11:44:00.000Z")])
    XCTAssertEqual(lines(s2, "agt-l").first?.summary, "request limiter asked: \(Self.question) · withdrawn")
    XCTAssertEqual(lines(s2, "agt-l").first?.state, .withdrawn(atMs: 1_795_175_040_000))   // when it was withdrawn: the quiet line's clock
    XCTAssertNil(lines(s2, "agt-l").first?.card)
  }

  func testAnswerOpensTheAskersOwnCardAndAnswersTheSameWay() async throws {
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s)
    await load(s, t, "agt-l", [item("agt-l")])
    let l = try XCTUnwrap(lines(s, "agt-l").first)
    // With its approval here, the popover's card is the asker's card itself: answering it is the card's answer (a
    // message to the asker), and it shows sending wherever it is drawn.
    let card = try XCTUnwrap(s.questionCard(runId: "run-q", agentId: "agt-w"))
    XCTAssertEqual(l.card, card)
    XCTAssertTrue(card.docks)   // asked of an agent: the asker's column docks it
    s.answering.insert(card.approvalId)
    XCTAssertEqual(lines(s, "agt-l").first?.card?.sending, true)
    XCTAssertEqual(s.questionCard(runId: "run-q", agentId: "agt-w")?.sending, true)
    // The asker's own thread keeps its docked card, not a line: one full card in its view.
    XCTAssertTrue(lines(s, "agt-w").isEmpty)
  }

  func testAQuestionForTheUserIsTheFullCardInTheRootsThread() async throws {
    // Passed up by the lead, then by the planner: it is the user's. The root's thread (where the user reads) draws the
    // card in the line's place; the lead's says where it went; Needs you and the menu bar list it.
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s, to: nil)
    await load(s, t, "agt-p", [say("i1", agent: "agt-p", seq: 1, order: 1, at: "2026-11-20T11:39:00.000Z"),
                               item("agt-p", rev: 2, to: nil, passedBy: ["agt-l", "agt-p"], at: "2026-11-20T11:41:00.000Z")])
    await load(s, t, "agt-l", [item("agt-l", rev: 3, to: nil, passedBy: ["agt-l", "agt-p"])])
    let root = lines(s, "agt-p")
    XCTAssertEqual(root.count, 1)
    XCTAssertTrue(root[0].forYou)
    XCTAssertEqual(root[0].card?.whoLine, "worker · asked you")
    XCTAssertNil(root[0].card?.hint)
    XCTAssertEqual(lines(s, "agt-l").map(\.summary), ["request limiter asked: \(Self.question) · passed up to you"])
    XCTAssertFalse(lines(s, "agt-l")[0].forYou)
    XCTAssertEqual(s.needsAsks().map(\.agentId), ["agt-w"])
    XCTAssertEqual(s.pendingApprovals.map(\.id), ["apr-1"])
    XCTAssertEqual(s.badgeCount, 1)
    // The asker's thread: no docked card (it is owed in the root's thread), its line "asked you" with Answer instead,
    // opening the same card. From `to`, whatever columns are open.
    let card = try XCTUnwrap(s.questionCard(runId: "run-q", agentId: "agt-w"))
    XCTAssertFalse(card.docks)
    let mine = lines(s, "agt-w")
    XCTAssertEqual(mine.map(\.summary), ["request limiter asked you: \(Self.question) · waiting on you"])
    XCTAssertFalse(mine[0].forYou)
    XCTAssertEqual(mine[0].card, card)
    XCTAssertEqual(mine[0].atMs, 1_795_174_800_000)
    // One full card for the question across the run: the root's.
    XCTAssertEqual(["agt-p", "agt-l", "agt-w"].flatMap { lines(s, $0) }.filter(\.forYou).count, 1)
    // Live: the approval turned the user's as it was passed (agent.question_passed): the root's record still says the
    // planner, the line follows the pass.
    let s2 = CapcomdStore(thread: t)
    feed(s2, to: "agt-p")
    await load(s2, t, "agt-p", [item("agt-p", to: "agt-p", passedBy: ["agt-l"])])
    XCTAssertFalse(lines(s2, "agt-p")[0].forYou)
    event(s2, "agent.question_passed", #"{"questionId":"qst-1","from":"agt-p","to":null,"cause":"passed_up"}"#)
    XCTAssertTrue(lines(s2, "agt-p")[0].forYou)
    XCTAssertEqual(s2.needsAsks().map(\.agentId), ["agt-w"])
    XCTAssertEqual(s2.questionCard(runId: "run-q", agentId: "agt-w")?.docks, false)
    // A root's own question to you docks at the root, as before: no line.
    let s3 = CapcomdStore()
    feed(s3, to: "agt-p")
    XCTAssertEqual(s3.questionCard(runId: "run-q", agentId: "agt-w")?.docks, true)
  }

  func testAnsweringInOnePlaceTurnsEveryPlaceIntoTheAnsweredLine() async throws {
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s, to: nil)
    await load(s, t, "agt-p", [item("agt-p", rev: 2, to: nil, passedBy: ["agt-l", "agt-p"])])
    await load(s, t, "agt-l", [item("agt-l", rev: 3, to: nil, passedBy: ["agt-l", "agt-p"])])
    await load(s, t, "agt-w", [item("agt-w", rev: 3, to: nil, passedBy: ["agt-l", "agt-p"])])
    XCTAssertNotNil(s.questionCard(runId: "run-q", agentId: "agt-w"))
    // The user answers (from the asker's card, the root's card, a line's popover or Needs: all send the same message);
    // agent.answered comes once, and every place reads it before any thread is read again.
    event(s, "agent.answered", #"{"questionId":"qst-1","by":"client:desk","answer":"500 req/min","recommended":false,"note":null,"messageSeq":9,"replaces":null,"cause":"answered"}"#)
    event(s, "approval.decided", #"{"approvalId":"apr-1","decision":"answer","status":"answered","answer":"500 req/min"}"#)
    XCTAssertNil(s.questionCard(runId: "run-q", agentId: "agt-w"))
    for agent in ["agt-p", "agt-l"] {
      let l = try XCTUnwrap(lines(s, agent).first, agent)
      XCTAssertFalse(l.forYou, agent)
      XCTAssertNil(l.card, agent)
      XCTAssertEqual(l.summary, "request limiter asked: \(Self.question) · You answered 500 req/min — not the recommendation", agent)
    }
    XCTAssertTrue(s.needsAsks().isEmpty)
    // The asker's thread: its answered line (from the live event until the record comes).
    let w = s.threadEntries(agentId: "agt-w").compactMap { if case .event(let it) = $0, case .answered(let r, _) = it.kind { return r.answer.plain }; return nil }
    XCTAssertEqual(w, ["500 req/min"])
    // The records arrive: still one line each, no second one from the live event.
    await load(s, t, "agt-p", [item("agt-p", rev: 3, state: "answered", to: nil, passedBy: ["agt-l", "agt-p"], answer: "500 req/min", recommended: false,
                                    by: "client:desk", decidedAt: "2026-11-20T11:42:00.000Z")])
    XCTAssertEqual(s.threadEntries(agentId: "agt-p").count, 1)
  }

  func testTheDeliveringMessageIsBookkeepingAndTheLineIsOne() async throws {
    // The message that delivered the question to the lead is bookkeeping (the daemon marks it internal): out of the
    // thread unless its bookkeeping is shown. An agent that answered has the line, not also the live answered line.
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s)
    event(s, "message.sent", #"{"to":"agt-l","seq":5,"bytes":80,"text":"agt-w asked you a question (qst-1) and stopped until it's answered:\n\#(Self.question)","internal":true}"#, ms: 1_795_174_800_000)
    event(s, "message.sent", #"{"to":"agt-l","seq":6,"bytes":10,"text":"also: hello"}"#, ms: 1_795_174_801_000)
    await load(s, t, "agt-l", [item("agt-l")])
    event(s, "agent.answered", #"{"questionId":"qst-1","by":"agt-l","answer":"100 req/min","recommended":true,"note":null,"messageSeq":9,"replaces":null,"cause":"answered"}"#)
    let kinds = { s.threadEntries(agentId: "agt-l").map { e -> String in
      guard case .event(let it) = e else { return "item" }
      switch it.kind {
      case .question(let l): return "line: \(l.summary)"
      case .message(_, _, let text, _): return "message: \(text?.plain.prefix(24) ?? "")"
      case .answered: return "answered"
      default: return "other"
      }
    } }
    XCTAssertEqual(kinds(), ["line: request limiter asked: \(Self.question) · api lead answered 100 req/min (recommended)", "message: also: hello"])
    s.setBookkeepingShown(true, agentId: "agt-l")
    XCTAssertEqual(kinds(), ["message: agt-w asked you a questi", "line: request limiter asked: \(Self.question) · api lead answered 100 req/min (recommended)",
                             "message: also: hello"])
    // From a snapshot too (snapshot.threads carries `internal`).
    let s2 = CapcomdStore()
    feed(s2, messages: #"[{"seq":5,"from":"agt-w","to":"agt-l","at":"2026-11-20T11:40:00.000Z","text":"agt-w asked you a question (qst-1)","attachment":null,"internal":true},{"seq":6,"from":"agt-w","to":"agt-l","at":"2026-11-20T11:40:01.000Z","text":"hi","attachment":null}]"#, on: "run-q")   // the run's own stream carries its threads
    XCTAssertEqual(s2.thread(agentId: "agt-l").map(\.internal), [true, false])
    XCTAssertEqual(s2.threadEntries(agentId: "agt-l").count, 1)
  }

  func testAWithdrawnQuestionIsOneQuietLineWithItsReasonOnHover() async throws {
    let w = WithdrawnQuestion(questionId: "qst-1", question: Self.question, atMs: 1_795_175_040_000)
    let l = w.line(time: "11:44")
    XCTAssertEqual("\(l.lead) · \(l.question) · \(l.tail)", "Withdrawn · \(Self.question) · 11:44")
    XCTAssertEqual(WithdrawnQuestion.why, "Its agent was cancelled, so it won't be answered.")
    // Live, before the lead's record says so: the line follows the asker's withdrawal, at its time.
    let t = FakeThread()
    let s = CapcomdStore(thread: t)
    feed(s)
    await load(s, t, "agt-l", [item("agt-l")])
    event(s, "agent.question_withdrawn", #"{"questionId":"qst-1","reason":"cancelled","cause":"withdrawn"}"#, ms: 1_795_175_100_000)
    XCTAssertEqual(lines(s, "agt-l").first?.state, .withdrawn(atMs: 1_795_175_100_000))
    XCTAssertNil(lines(s, "agt-l").first?.card)
  }
}
