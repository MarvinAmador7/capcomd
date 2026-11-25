import Foundation

/// One item in an agent's thread (SPEC §4.5), built only from what harness.v1 carries today.
/// No transcript text is in the contract (gap G3); every agent-written string is `UntrustedText`.
public struct ThreadItem: Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable {
    /// Started/finished/failed lines. `text` is client-composed.
    case status(String)
    /// `agent.notice.detail`.
    case notice(kind: String, detail: UntrustedText)
    /// `agent.checkpoint`: reason + file count.
    case checkpoint(reason: UntrustedText, files: Int?)
    /// Steer sent to this agent when `message.sent` carries no text (older daemons), only `bytes`.
    case steer(bytes: Int?)
    /// `message.sent` / `snapshot.threads` message with agent-written text (untrusted) and/or a stored attachment.
    case message(from: String, to: String, text: UntrustedText?, attachment: AttachmentRef?)
    /// `agent.woken` (capability agents.wake): what woke it, as a quiet line ("verify passed · woke planner").
    /// Client-composed from daemon-written fields.
    case woke(String)
    /// `agent.answered` (capability agents.ask): the question its card asked, answered, as one line ("Answered ·
    /// 100 req/min · 11:42"), in the asker's thread and the answering agent's. `byName` names an agent that answered.
    case answered(AnsweredQuestion, byName: String?)
    /// `agent.question_withdrawn` (capability agents.ask): its agent was cancelled before the question was answered.
    case withdrawn(WithdrawnQuestion)
    /// A question item in the thread of an agent that didn't ask it (capability agents.ask): its compact line, or (the
    /// root's thread, the user's to answer) its full card.
    case question(QuestionLine)
    /// Child handed back: `agent.done.result` (ChildResult {summary, artifacts[{name,ref}]}).
    case handoff(childId: String, childName: String, summary: UntrustedText?, artifacts: [UntrustedText])
  }
  public var id: String
  public var seq: Int
  public var epochMs: Int
  public var kind: Kind
  /// Bookkeeping (ADR-026 §7): a message capcomd wrote to carry what a question item already shows (a question
  /// delivered, an answer it worded). Shown only with the agent's bookkeeping.
  public var `internal` = false
  public init(id: String, seq: Int, epochMs: Int, kind: Kind, internal: Bool = false) {
    self.id = id; self.seq = seq; self.epochMs = epochMs; self.kind = kind; self.internal = `internal`
  }
  /// The question an answered, withdrawn or question line is about (agents.ask); nil for other kinds.
  public var questionId: String? {
    switch kind { case .answered(let r, _): r.questionId; case .withdrawn(let w): w.questionId; case .question(let l): l.questionId; default: nil }
  }
}

extension CapcomdStore {
  func appendThread(_ runId: String, _ agentId: String, _ item: ThreadItem) {
    guard runs[runId]?.agents[agentId] != nil else { return }
    var t = threads[agentId] ?? []
    if !t.contains(where: { $0.id == item.id }) { t.append(item) }
    threads[agentId] = t
  }

  func reduceThread(_ e: Envelope, runId: String?, agentId: String?) {
    guard let runId, let agentId else { return }
    let d = e.data, id = "\(e.scope):\(e.seq)"
    switch e.type {
    case "agent.started": appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .status("Started")))
    case "agent.failed": appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .status("Failed")))
    case "agent.notice":
      appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs,
        kind: .notice(kind: d["kind"]?.string ?? "notice", detail: UntrustedText(d["detail"]?.string ?? ""))))
    case "agent.checkpoint":
      appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs,
        kind: .checkpoint(reason: UntrustedText(d["reason"]?.string ?? ""), files: d["files"]?.int)))
    case "message.sent":
      let to = d["to"]?.string ?? d["to"]?["agentId"]?.string ?? agentId
      let text = d["text"]?.string.map(UntrustedText.init), att = AttachmentRef(d["attachment"])
      if text == nil && att == nil {
        appendThread(runId, to, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .steer(bytes: d["bytes"]?.int)))
      } else {
        let from = e.agentId ?? "operator", mid = d["seq"]?.int.map { "msg:\(from):\(to):\($0)" } ?? id
        let item = ThreadItem(id: mid, seq: e.seq, epochMs: e.epochMs, kind: .message(from: from, to: to, text: text, attachment: att), internal: d["internal"]?.bool == true)
        appendThread(runId, to, item); if from != to { appendThread(runId, from, item) }
      }
    case "agent.answered":
      guard let qid = d["questionId"]?.string, let by = d["by"]?.string else { return }
      let rec = AnsweredQuestion(questionId: qid, answer: d["answer"]?.string ?? "", recommended: d["recommended"]?.bool ?? false, by: by,
                                 note: d["note"]?.string, atMs: e.epochMs)
      let item = ThreadItem(id: "answered:\(qid):\(e.seq)", seq: e.seq, epochMs: e.epochMs, kind: .answered(rec, byName: runs[runId]?.agents[by]?.displayName))
      appendThread(runId, agentId, item)
      if by != agentId { appendThread(runId, by, item) }
    case "agent.woken":
      let name = runs[runId]?.agents[agentId]?.displayName ?? agentId
      appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .woke(Self.wokeLine(d, name: name))))
    case "agent.done":
      appendThread(runId, agentId, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .status("Finished")))
      guard let a = runs[runId]?.agents[agentId], let parent = a.parent else { return }
      let r = d["result"]
      let arts = (r?["artifacts"]?.array ?? []).compactMap { $0["name"]?.string ?? $0.string }.map(UntrustedText.init)
      appendThread(runId, parent, .init(id: id + ":handoff", seq: e.seq, epochMs: e.epochMs,
        kind: .handoff(childId: agentId, childName: a.displayName, summary: (r?["summary"]?.string ?? r?.string).map(UntrustedText.init), artifacts: arts)))
    default: break
    }
  }

  /// `snapshot.threads` entry: same id scheme as live `message.sent`, so a replayed one isn't shown twice.
  func appendMessage(_ m: SnapshotMessage) {
    guard let runId = runs.values.first(where: { $0.agents[m.to] != nil || $0.agents[m.from] != nil })?.id else { return }
    let ms = m.at.flatMap(Self.parseISO).map { Int($0.timeIntervalSince1970 * 1000) } ?? 0
    let item = ThreadItem(id: "msg:\(m.from):\(m.to):\(m.seq)", seq: m.seq, epochMs: ms,
                          kind: .message(from: m.from, to: m.to, text: m.text.map(UntrustedText.init), attachment: AttachmentRef(m.attachment)), internal: m.internal == true)
    appendThread(runId, m.to, item); if m.from != m.to { appendThread(runId, m.from, item) }
  }

  public func thread(agentId: String) -> [ThreadItem] { threads[agentId] ?? [] }

  /// agent.woken as one quiet line: what happened, without the op's id ("verify passed", "check failed", "its check-in
  /// came"), then who it woke. `text` is daemon-written ("verify vfy-… passed").
  nonisolated static func wokeLine(_ d: [String: JSONValue], name: String) -> String {
    let what: String
    switch d["by"]?.string {
    case "time": what = "check-in time"
    case "deadline": what = "wait ran out"
    default:
      let t = d["text"]?.string ?? "what it waited for happened"
      // "verify vfy-k12 passed" → "verify passed": the id is on the record, the line says what happened.
      what = t.replacingOccurrences(of: #"^(verify|check|merge) (vfy|chk|mrg)-\S+ "#, with: "$1 ", options: .regularExpression)
    }
    return "\(what) · woke \(name)"
  }
}

extension CapcomdStore {
  nonisolated static func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]; return f.date(from: s)
  }
}
