import Foundation

// The desktop window's read model (design/desktop/SPEC.md). Small Equatable snapshots, so the app can assign them to
// observable slices only when they actually differ: a view re-renders when what it shows changed, not on every frame.

/// One project in the title bar: the open one's group, or a folded deck.
public struct DeckInfo: Sendable, Hashable, Identifiable {
  public var id: String
  /// The run the reel shows: the newest active run, else the newest.
  public var runId: String
  public var title: String
  public var startedAtMs: Int?
  /// Ended runs show how they ended instead of a clock: the menu bar's words ("Done in 4m", "Failed after 12m").
  public var endedHead: String?
  public var isRunning: Bool
  /// Where it runs: "docker" (Local), "boxd" (Cloud), another place, or nil when the daemon doesn't say.
  public var sandbox: String?
  /// The agent whose approval waits (the first, by request order), and its tree name with suffix ("worker 4423").
  public var askingAgentId: String?
  public var askingName: String?
  /// Every agent, in tree order (the folded deck stacks these heads).
  public var agentIds: [String]
}

/// A reel column's header: everything it shows about its agent, nothing about the thread.
public struct ColumnHeader: Sendable, Hashable, Identifiable {
  public var id: String { agentId }
  public var agentId: String
  public var runId: String
  public var name: String
  public var suffix: String?
  public var kind: ProfileKind
  public var status: AgentStatus
  public var waiting: Bool
  public var activity: String?
  public var repo: String?
  public var spawnedAtMs: Int
  /// When it was spawned, when known: the header's elapsed clock (none when the daemon didn't say).
  public var startedAtMs: Int?
  public var provider: Provider?
  public var depth: Int
}

extension CapcomdStore {
  /// The projects with something to show, oldest first: a project keeps its place as others start and finish
  /// (SPEC §2: nothing jumps). Finished projects drop out once they're no longer the newest outcome.
  public func decks() -> [DeckInfo] {
    let ps = projects.filter { $0.isActive || $0.latestRun.map { !$0.isActive } == true }
    let firstStart: (Project) -> Int = { $0.runs.compactMap(\.startedAtMs).min() ?? $0.lastEventMs }
    return ps.sorted { (firstStart($0), $0.id) < (firstStart($1), $1.id) }.compactMap { p in
      guard let run = p.activeRuns.max(by: { ($0.recencyMs, $0.id) < ($1.recencyMs, $1.id) }) ?? p.latestRun else { return nil }
      let ids = agentTree(runId: run.id).flatMap(\.subtreeIds)
      let asking = approvals(forRun: run.id).compactMap(\.agentId).first { run.agents[$0] != nil }
      return DeckInfo(id: p.id, runId: run.id, title: p.title, startedAtMs: run.startedAtMs,
                      endedHead: run.endedHead, isRunning: run.isRunning, sandbox: run.sandbox,
                      askingAgentId: asking, askingName: asking.flatMap { columnHeader(runId: run.id, agentId: $0) }.map { h in [h.name, h.suffix].compactMap { $0 }.joined(separator: " ") },
                      agentIds: ids)
    }
  }

  /// The reel's columns for a run, in tree order (a parent before its children, siblings by spawn time).
  public func reelColumns(runId: String) -> [ColumnHeader] {
    func flat(_ ns: [AgentNode]) -> [AgentNode] { ns.flatMap { [$0] + flat($0.children) } }
    guard let run = runs[runId] else { return [] }
    return flat(agentTree(runId: runId)).compactMap { n in run.agents[n.id].map { header(n, $0, runId) } }
  }

  public func columnHeader(runId: String, agentId: String) -> ColumnHeader? {
    reelColumns(runId: runId).first { $0.agentId == agentId }
  }

  func header(_ n: AgentNode, _ a: Agent, _ runId: String) -> ColumnHeader {
    ColumnHeader(agentId: a.id, runId: runId, name: n.name, suffix: n.suffix, kind: n.kind, status: n.status, waiting: n.waiting,
                 activity: n.activity, repo: n.repo, spawnedAtMs: a.spawnedAtMs, startedAtMs: a.createdAtMs, provider: a.provider, depth: n.depth)
  }
}
