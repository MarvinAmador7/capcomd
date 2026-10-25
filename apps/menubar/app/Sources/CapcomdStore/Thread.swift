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
    /// Steer sent to this agent. `message.sent` has no body in the contract, only `bytes`.
    case steer(bytes: Int?)
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
      appendThread(runId, to, .init(id: id, seq: e.seq, epochMs: e.epochMs, kind: .steer(bytes: d["bytes"]?.int)))
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

  public func thread(agentId: String) -> [ThreadItem] { threads[agentId] ?? [] }
}
