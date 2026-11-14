import Foundation

// "Needs you" (design/desktop SPEC, Needs you reel): every agent waiting on the user, across all projects, oldest
// first. Built here from the store so it can be tested without a window; the desktop's reel and its ⌘J read it.

/// One agent waiting on the user: an approval it asked for (a merge, a question, any kind the daemon asks), or the
/// usage-limit pause its run is in. One ask per agent: its oldest.
public struct NeedsAsk: Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable {
    case approval(PendingApproval)
    case limit(NeedsLimit)
  }
  /// Oldest first: when it asked, then the order the daemon sent it in, then the agent (stable for equal times).
  public struct Key: Sendable, Hashable, Comparable {
    public var askedAtMs: Int
    public var seq: Int
    public var agentId: String
    public init(askedAtMs: Int, seq: Int, agentId: String) { self.askedAtMs = askedAtMs; self.seq = seq; self.agentId = agentId }
    public static func < (a: Key, b: Key) -> Bool { (a.askedAtMs, a.seq, a.agentId) < (b.askedAtMs, b.seq, b.agentId) }
  }
  public var id: String { agentId }
  /// The agent whose column shows the ask (an approval's waiting agent: a merge's asker).
  public var agentId: String
  public var runId: String
  public var kind: Kind
  public var key: Key
  public var approval: PendingApproval? { if case .approval(let a) = kind { return a }; return nil }
  public var limit: NeedsLimit? { if case .limit(let l) = kind { return l }; return nil }
}

/// A run its provider's usage limit paused (`agent.paused` with limit "quota"): resume it now, or let it pick up again
/// by itself when the limit resets.
public struct NeedsLimit: Sendable, Hashable {
  public var runId: String
  /// The agents the limit paused, in spawn order (the first one's column shows the ask).
  public var agentIds: [String]
  public var provider: Provider?
  /// When they pick up again by themselves; nil when the provider didn't say.
  public var resumesAtMs: Int?
}

extension CapcomdStore {
  /// Every agent waiting on the user, oldest first: each undecided approval's waiting agent (its oldest approval), and
  /// one ask per run a usage limit paused. Cheap: the approvals and the runs' agents are read once and the few asks
  /// sorted; nothing here builds a tree.
  public func needsAsks() -> [NeedsAsk] {
    var out: [NeedsAsk] = []
    for a in approvals.values {
      if case .decided = a.decision { continue }
      guard let agent = waitingAgent(a) else { continue }
      let runId = a.runId ?? runs.values.first { $0.agents[agent] != nil }?.id
      guard let runId, let run = runs[runId], run.agents[agent] != nil else { continue }
      out.append(NeedsAsk(agentId: agent, runId: runId, kind: .approval(a),
                          key: .init(askedAtMs: a.requestedAtMs ?? run.lastEventMs, seq: approvalSeq[a.id] ?? 0, agentId: agent)))
    }
    for run in runs.values where !Run.terminalStates.contains(run.state) {
      let paused = run.agents.values.filter { $0.status == .paused && $0.limit == "quota" }.sorted(by: Self.spawnOrder)
      guard let first = paused.first else { continue }
      let at = paused.map { $0.updatedAtMs ?? $0.activityAtMs ?? $0.spawnedAtMs }.min() ?? first.spawnedAtMs
      out.append(NeedsAsk(agentId: first.id, runId: run.id,
                          kind: .limit(NeedsLimit(runId: run.id, agentIds: paused.map(\.id), provider: paused.compactMap(\.provider).first,
                                                  resumesAtMs: paused.compactMap(\.resetAtMs).min())),
                          key: .init(askedAtMs: at, seq: Int.max, agentId: first.id)))
    }
    out.sort { $0.key < $1.key }
    var seen: Set<String> = []
    return out.filter { seen.insert($0.agentId).inserted }
  }
}
