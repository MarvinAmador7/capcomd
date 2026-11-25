import Foundation
import CapcomdThread

/// ADR-026 §4 (capability agents.ask): the question an agent asked and stopped on, as `Agent.asked` and agent.asked
/// carry it. Its words are the agent's (untrusted); `to` is who it is asked of (an agent id), nil when it is the user's.
public struct AskedQuestion: Sendable, Hashable {
  public var questionId: String
  public var question: UntrustedText
  public var to: String?
  public var atMs: Int?
  public init(questionId: String, question: UntrustedText, to: String?, atMs: Int?) {
    self.questionId = questionId; self.question = question; self.to = to; self.atMs = atMs
  }
  /// From `Agent.asked` (snapshot) or agent.asked's data (`atMs`: the event's time).
  init?(_ v: JSONValue?, atMs: Int? = nil) {
    guard let v, case .object = v, let id = v["questionId"]?.string else { return nil }
    questionId = id; question = UntrustedText(v["question"]?.string ?? ""); to = v["to"]?.string
    self.atMs = atMs ?? v["at"]?.string.flatMap(CapcomdStore.parseISO).map { Int($0.timeIntervalSince1970 * 1000) }
  }
}

/// A question's card, from its approval's `subject` (kind question): the options with the recommended one first, the
/// asker's reason for it, what waits on the answer, and who it is asked of. Every label is the asker's words.
public struct QuestionAsk: Sendable, Hashable {
  public struct Option: Sendable, Hashable {
    public var label: UntrustedText
    public var recommended: Bool
    public init(label: String, recommended: Bool) { self.label = UntrustedText(label); self.recommended = recommended }
  }
  public var questionId: String
  public var options: [Option]
  public var why: UntrustedText?
  public var holds: UntrustedText?
  /// An agent (its parent, or an ancestor it was passed up to), or nil: the user.
  public var to: String?
  public init(questionId: String, options: [Option], why: String? = nil, holds: String? = nil, to: String? = nil) {
    self.questionId = questionId; self.options = options; self.why = why.map(UntrustedText.init); self.holds = holds.map(UntrustedText.init); self.to = to
  }
  init?(subject: [String: JSONValue]) {
    guard let id = subject["questionId"]?.string else { return nil }
    questionId = id
    options = (subject["options"]?.array ?? []).compactMap { o in o["label"]?.string.map { Option(label: $0, recommended: o["recommended"]?.bool ?? false) } }
    if options.isEmpty, let r = subject["recommend"]?.string { options = [Option(label: r, recommended: true)] }
    why = subject["why"]?.string.flatMap { $0.isEmpty ? nil : UntrustedText($0) }
    holds = subject["holds"]?.string.flatMap { $0.isEmpty ? nil : UntrustedText($0) }
    to = subject["to"]?.string
  }
  public var recommended: Option? { options.first(where: \.recommended) }
}

/// A question once answered (agent.answered): the one line its card collapses to. The answer and the note are the
/// answerer's words (a person's or an agent's: untrusted either way).
public struct AnsweredQuestion: Sendable, Hashable {
  public var questionId: String
  public var answer: UntrustedText
  public var recommended: Bool
  /// operator, client:<id>, driver (a person), or the agent that answered.
  public var by: String
  public var note: UntrustedText?
  public var atMs: Int
  public init(questionId: String, answer: String, recommended: Bool, by: String, note: String?, atMs: Int) {
    self.questionId = questionId; self.answer = UntrustedText(answer); self.recommended = recommended; self.by = by
    self.note = note.flatMap { $0.isEmpty ? nil : UntrustedText($0) }; self.atMs = atMs
  }
  /// A person answered (not an agent).
  public var byPerson: Bool { !by.hasPrefix("agt-") }

  /// The line (DurableAsked-v3): "Answered · 100 req/min · 11:42", "· not the recommended" when it wasn't; an agent's
  /// answer is named ("planner answered"). `name` names the answering agent; `time` is the clock ("11:42").
  public func line(name: String?, time: String) -> (lead: String, answer: String, tail: String) {
    let lead = byPerson ? "Answered" : "\(name ?? "agent") answered"
    return (lead, answer.firstLine, recommended ? time : "not the recommended · \(time)")
  }
  /// "Your note: “…”" (a person's) or "planner's note: “…”".
  public func noteLine(name: String?) -> String? {
    guard let n = note?.firstLine, !n.isEmpty else { return nil }
    return "\(byPerson ? "Your" : "\(name ?? "Its")'s") note: “\(n)”"
  }
}

extension AnsweredQuestion {
  /// From the thread's record of it (a `question` item, answered): what rebuilds the line after a reconnect.
  init?(_ q: CapcomdThread.Item.Question, fallbackMs: Int) {
    guard q.state == .answered, let by = q.by else { return nil }
    self.init(questionId: q.questionId, answer: q.answer ?? "", recommended: q.recommended ?? false, by: by, note: q.note, atMs: q.decidedAtMs ?? fallbackMs)
  }
}

/// A question withdrawn before it was answered (its agent was cancelled): one quiet line where its card was,
/// "Withdrawn · Which limit? · 11:42". The question is the asker's words.
public struct WithdrawnQuestion: Sendable, Hashable {
  public var questionId: String
  public var question: UntrustedText
  public var atMs: Int
  public init(questionId: String, question: String, atMs: Int) { self.questionId = questionId; self.question = UntrustedText(question); self.atMs = atMs }
  public func line(time: String) -> (lead: String, question: String, tail: String) { ("Withdrawn", question.firstLine, time) }
  /// The line under it: why nobody will answer it.
  public static let why = "Its agent was cancelled, so it won't be answered."
}

/// A question in the thread of an agent other than its asker (ADR-026 §4, §9.1): the one it is asked of (its parent, or
/// an ancestor it was passed up to), one that passed it up or answered it, or the run's root once it is the user's. The
/// thread keeps one compact line where the question reached it, at the question's one state, not a second card:
/// "request limiter asked: Ship the limiter…? · waiting on rate limit api" with Answer (the user's answer always wins),
/// then "planner answered 500 req/min — not the recommendation", "passed up to you", "withdrawn". In the root's thread a
/// question that is the user's is drawn as its full card instead (`forYou`): where the user reads.
public struct QuestionLine: Sendable, Hashable {
  public enum State: Sendable, Hashable {
    /// Waiting on its answer from `waitingOn`: an agent's title, or "you".
    case open(waitingOn: String)
    /// Passed up from this thread's agent (or above it): to an agent, its title, or "you".
    case passed(to: String)
    /// `byName` names an agent that answered; nil when a person did.
    case answered(AnsweredQuestion, byName: String?)
    /// Its agent was cancelled before it was answered, at `atMs`.
    case withdrawn(atMs: Int)
  }
  public var questionId: String
  public var askerId: String
  /// The asker's title (else its profile).
  public var askerName: String
  public var question: UntrustedText
  public var state: State
  /// When the question reached this thread's agent: where the line sits.
  public var atMs: Int
  /// The question's full card while it is open: what Answer opens (a popover on the line), or what the root's thread
  /// draws in the line's place (`forYou`). The same card the asker's thread docks.
  public var card: QuestionCardModel?
  /// It is the user's to answer and this is the run's root thread: the full card, not the line.
  public var forYou: Bool
  /// The asker's own thread, the question passed up to you: its card is owed in the root's thread, here it is the line
  /// ("asked you").
  public var askedYou = false

  /// "asked: Ship the limiter at 100 or 500 req/min?": after the asker's name, one line.
  public var asked: String { "\(askedYou ? "asked you" : "asked"): \(question.firstLine)" }
  /// What became of it, after the question: "waiting on planner", "passed up to you", "withdrawn"; nil once answered (the
  /// outcome line says it).
  public var status: String? {
    switch state {
    case .open(let w): "waiting on \(w)"
    case .passed(let to): "passed up to \(to)"
    case .withdrawn: "withdrawn"
    case .answered: nil
    }
  }
  /// Answered: "You answered" / "planner answered", the answer, and "(recommended)" or "— not the recommendation".
  public var outcome: (lead: String, answer: String, tail: String)? {
    guard case .answered(let r, let name) = state else { return nil }
    return (r.byPerson ? "You answered" : "\(name ?? "agent") answered", r.answer.firstLine, r.recommended ? "(recommended)" : "— not the recommendation")
  }
  /// The answerer's note, under the outcome: "Your note: “…”" / "planner's note: “…”".
  public var noteLine: String? {
    guard case .answered(let r, let name) = state else { return nil }
    return r.noteLine(name: name)
  }
  /// The line as one string (VoiceOver, tests): "request limiter asked: … · waiting on planner".
  public var summary: String {
    if let o = outcome { return "\(askerName) \(asked) · \(o.lead) \(o.answer) \(o.tail)" }
    return "\(askerName) \(asked) · \(status ?? "")"
  }
  public var isOpen: Bool { if case .open = state { return true }; return false }
}

extension PendingApproval {
  /// Whether it is a person's to decide: every kind but a question asked of an agent (that one is quiet: its card shows,
  /// the user may answer it, but it isn't in Needs you, the badge or amber).
  public var needsPerson: Bool { kind != "question" || ask?.to == nil }
}

/// A question's card as its column shows it (DurableAsked-v3): who asked whom, the question, the options with keys,
/// the recommended one's reason, what waits on it, and the hint when it is asked of an agent.
public struct QuestionCardModel: Sendable, Hashable {
  public var approvalId: String
  public var questionId: String
  public var askerId: String
  /// How the asker is named ("request limiter", its title; else its profile).
  public var askerName: String
  /// "worker · asked planner", "worker · asked you".
  public var whoLine: String
  public var question: UntrustedText
  public var options: [QuestionAsk.Option]
  public var why: UntrustedText?
  public var holds: UntrustedText?
  /// The agent it is asked of, named ("planner"); nil: asked of you.
  public var askedOf: String?
  /// An answer from the card is on its way.
  public var sending: Bool
  /// Whether the asker's column docks it: yes when it is asked of an agent, or of you by the root itself. A question
  /// passed up to you from below the root is owed in the root's thread (its card there), so the asker's thread shows
  /// its line, "asked you", instead: one full card per question, wherever it is decided (from `to`, not from what is
  /// on screen).
  public var docks: Bool = true
  /// "Answer as you, or let the planner answer." (asked of an agent); nil when it is yours.
  public var hint: String? { askedOf.map { "Answer as you, or let the \($0) answer." } }
  /// The line under the question when nothing waits on it: what happens to the asker.
  public static let saved = "Its work is saved. It carries on by itself once this is answered."
}

extension CapcomdStore {
  /// The open question this agent asked (any: of you or of an agent), as its column's card; nil without one.
  public func questionCard(runId: String, agentId: String) -> QuestionCardModel? {
    guard let run = runs[runId], let a = run.agents[agentId],
          let ap = approvals.values.first(where: { $0.kind == "question" && $0.agentId == agentId && $0.runId == runId }), let q = ap.ask else { return nil }
    let name = { (id: String) in run.agents[id].map { $0.titleText ?? $0.displayName } }
    let of = q.to.flatMap { id in run.agents[id]?.displayName ?? name(id) }
    return QuestionCardModel(approvalId: ap.id, questionId: q.questionId, askerId: agentId, askerName: a.titleText ?? a.displayName,
                             whoLine: "\(a.displayName) · asked \(of ?? "you")", question: ap.question, options: q.options, why: q.why, holds: q.holds,
                             askedOf: of, sending: answering.contains(ap.id), docks: q.to != nil || a.parent == nil)
  }

  /// Answer from the card: the chosen option's words as a message to the asker (ADR-026 §9.4: a plain message to an
  /// agent that asked is its answer, and continues it). The card shows it sending until agent.answered comes.
  public func answerQuestion(runId: String, agentId: String, approvalId: String, answer: String) async {
    let text = answer.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    answering.insert(approvalId); changed()
    await steer(runId: runId, agentId: agentId, body: text)
    // A send that failed shows on its steer (Retry); the card can be used again.
    if case .failed? = outbox[agentId]?.last?.state { answering.remove(approvalId); changed() }
  }

  /// agent.asked, agent.answered, agent.question_passed, agent.question_withdrawn (capability agents.ask).
  func applyAsk(_ e: Envelope, runId: String?, agentId: String?) {
    guard let runId, let agentId, runs[runId]?.agents[agentId] != nil else { return }
    let d = e.data
    switch e.type {
    case "agent.asked":
      updateAgent(runId, agentId) { $0.asked = AskedQuestion(.object(d), atMs: e.epochMs) }
    case "agent.question_passed":
      updateAgent(runId, agentId) { $0.asked?.to = d["to"]?.string }
      if let qid = d["questionId"]?.string, let id = approvals.first(where: { $0.value.ask?.questionId == qid })?.key { updateApproval(id) { $0.ask?.to = d["to"]?.string } }
    default:   // answered, withdrawn
      if e.type == "agent.question_withdrawn", let qid = d["questionId"]?.string {
        // Withdrawn reads as withdrawn, not gone: one line in the asker's thread, in its question's words.
        let text = runs[runId]?.agents[agentId]?.asked.flatMap { $0.questionId == qid ? $0.question.plain : nil }
          ?? approvals.values.first(where: { $0.ask?.questionId == qid })?.question.plain ?? ""
        appendThread(runId, agentId, ThreadItem(id: "withdrawn:\(qid)", seq: e.seq, epochMs: e.epochMs,
                                                kind: .withdrawn(WithdrawnQuestion(questionId: qid, question: text, atMs: e.epochMs))))
      }
      updateAgent(runId, agentId) { if $0.asked?.questionId == d["questionId"]?.string { $0.asked = nil } }
      if let qid = d["questionId"]?.string {
        if let id = approvals.first(where: { $0.value.ask?.questionId == qid })?.key { answering.remove(id) }
        answering.remove("q:\(qid)")   // answered from a card built from the thread's record (QuestionLine)
      }
    }
  }
}

extension CapcomdStore {
  /// A question item in the thread of `agentId`, which didn't ask it (see QuestionLine): the line at the question's one
  /// state. The thread's record, with what came live since it was written (an answer or a withdrawal in the asker's
  /// thread, a pass on its approval), so answering anywhere turns every place into the answered line at once.
  func heldQuestionLine(_ it: CapcomdThread.Item, _ q: CapcomdThread.Item.Question, agentId: String) -> ThreadItem? {
    guard let run = runs.values.first(where: { $0.agents[agentId] != nil }) else { return nil }
    let name = { (id: String) in run.agents[id].map { $0.titleText ?? $0.displayName } }
    var state = q.state, to = q.to
    var answered = AnsweredQuestion(q, fallbackMs: q.decidedAtMs ?? it.atMs)
    // Live since the record: the newest answer (a person's may replace an agent's), or the withdrawal.
    for e in thread(agentId: q.asker).reversed() {
      if case .answered(let r, _) = e.kind, r.questionId == q.questionId {
        if state == .open || (state == .answered && r.atMs > (answered?.atMs ?? 0) && r.by != answered?.by) { state = .answered; answered = r }
        break
      }
      if case .withdrawn(let w) = e.kind, w.questionId == q.questionId { if state == .open { state = .withdrawn }; break }
    }
    let pending = approvals.values.first { $0.kind == "question" && $0.ask?.questionId == q.questionId }
    if state == .open, let a = pending?.ask { to = a.to }
    let isRoot = run.agents[agentId]?.parent == nil
    var forYou = false
    let line: QuestionLine.State
    switch state {
    case .answered:
      guard let r = answered else { return nil }
      line = .answered(r, byName: r.byPerson ? nil : name(r.by))
    case .withdrawn: line = .withdrawn(atMs: q.decidedAtMs ?? withdrawnAt(q.questionId, asker: q.asker) ?? it.atMs)
    case .open:
      if to == agentId { line = .open(waitingOn: name(agentId) ?? "agent") }
      else if to == nil && isRoot { line = .open(waitingOn: "you"); forYou = true }
      else { line = .passed(to: to.flatMap(name) ?? "you") }
    }
    var card: QuestionCardModel?
    if state == .open {
      card = questionCard(runId: run.id, agentId: q.asker).flatMap { $0.questionId == q.questionId ? $0 : nil } ?? recordCard(q, run: run, to: to)
    }
    let asker = run.agents[q.asker]
    let model = QuestionLine(questionId: q.questionId, askerId: q.asker, askerName: asker.map { $0.titleText ?? $0.displayName } ?? q.asker,
                             question: UntrustedText(q.question), state: line, atMs: it.atMs, card: card, forYou: forYou)
    return ThreadItem(id: "q:\(it.id)", seq: it.seq, epochMs: it.atMs, kind: .question(model))
  }

  /// The card from the thread's record when the question's approval isn't here (yet): the same card, keyed by its question.
  private func recordCard(_ q: CapcomdThread.Item.Question, run: Run, to: String?) -> QuestionCardModel {
    let a = run.agents[q.asker]
    let of = to.flatMap { run.agents[$0]?.displayName }
    let key = "q:\(q.questionId)"
    return QuestionCardModel(approvalId: key, questionId: q.questionId, askerId: q.asker, askerName: a.map { $0.titleText ?? $0.displayName } ?? q.asker,
                             whoLine: "\(a?.displayName ?? "agent") · asked \(of ?? "you")", question: UntrustedText(q.question),
                             options: q.options.map { QuestionAsk.Option(label: $0.label, recommended: $0.recommended) },
                             why: q.why.map(UntrustedText.init), holds: q.holds.map(UntrustedText.init), askedOf: of, sending: answering.contains(key),
                             docks: to != nil || a?.parent == nil)
  }

  /// When a live agent.question_withdrawn said it (the record may not have come yet).
  private func withdrawnAt(_ questionId: String, asker: String) -> Int? {
    thread(agentId: asker).last { if case .withdrawn(let w) = $0.kind { return w.questionId == questionId }; return false }?.epochMs
  }

  /// The asker's own line for its open question when the question is the user's and the asker isn't the root
  /// (`docks` false): "request limiter asked you: … · waiting on you" with Answer, where it asked. Its card is the root's.
  func askerLine(agentId: String) -> ThreadItem? {
    guard let run = runs.values.first(where: { $0.agents[agentId] != nil }), let card = questionCard(runId: run.id, agentId: agentId), !card.docks else { return nil }
    let at = run.agents[agentId]?.asked.flatMap { $0.questionId == card.questionId ? $0.atMs : nil }
      ?? approvals[card.approvalId]?.requestedAtMs ?? 0
    let line = QuestionLine(questionId: card.questionId, askerId: agentId, askerName: card.askerName, question: card.question,
                            state: .open(waitingOn: "you"), atMs: at, card: card, forYou: false, askedYou: true)
    return ThreadItem(id: "asked-you:\(card.questionId)", seq: 0, epochMs: at, kind: .question(line))
  }
}
