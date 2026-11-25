import Foundation

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
                             askedOf: of, sending: answering.contains(ap.id))
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
      updateAgent(runId, agentId) { if $0.asked?.questionId == d["questionId"]?.string { $0.asked = nil } }
      if let qid = d["questionId"]?.string, let id = approvals.first(where: { $0.value.ask?.questionId == qid })?.key { answering.remove(id) }
    }
  }
}
