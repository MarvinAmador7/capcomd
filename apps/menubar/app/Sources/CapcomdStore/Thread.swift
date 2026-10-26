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
    /// Child handed back: `agent.done.result` (ChildResult {summary, artifacts[{name,ref}]}).
    case handoff(childId: String, childName: String, summary: UntrustedText?, artifacts: [UntrustedText])
  }
  public var id: String
  public var seq: Int
  public var epochMs: Int
  public var kind: Kind
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
        let item = ThreadItem(id: mid, seq: e.seq, epochMs: e.epochMs, kind: .message(from: from, to: to, text: text, attachment: att))
        appendThread(runId, to, item); if from != to { appendThread(runId, from, item) }
      }
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
                          kind: .message(from: m.from, to: m.to, text: m.text.map(UntrustedText.init), attachment: AttachmentRef(m.attachment)))
    appendThread(runId, m.to, item); if m.from != m.to { appendThread(runId, m.from, item) }
  }

  public func thread(agentId: String) -> [ThreadItem] { threads[agentId] ?? [] }
}

extension CapcomdStore {
  nonisolated static func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]; return f.date(from: s)
  }
}
