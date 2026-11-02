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
  /// The agent whose approval waits (the first, by request order), and how it is named ("lead · login redirect", or
  /// with an older daemon its tree name with suffix, "worker 4423").
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
  /// Its title (`Agent.title`): the crew tab's label, and the header's after the profile. Nil from older daemons.
  public var title: String? = nil
  /// With a title, only when a sibling shares it; else the old tie-breaker (see `CapcomdStore.disambiguate`).
  public var suffix: String?
  /// The person named it (titleSource user): an emptied rename field clears their name.
  public var userTitled: Bool = false
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

extension ColumnHeader {
  /// The crew tab's label: its title, else (older daemons) the suffix that tells siblings apart, else the profile.
  public var tabLabel: String { title.map { t in suffix.map { "\(t) \($0)" } ?? t } ?? suffix ?? name }
  /// How text names the agent ("lead · login redirect").
  public var label: String { AgentTitle.label(name: name, title: title, suffix: suffix) }
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
      let asking = approvals(forRun: run.id).compactMap { waitingAgent($0) }.first
      return DeckInfo(id: p.id, runId: run.id, title: p.title, startedAtMs: run.startedAtMs,
                      endedHead: run.endedHead, isRunning: run.isRunning, sandbox: run.sandbox,
                      askingAgentId: asking, askingName: asking.flatMap { columnHeader(runId: run.id, agentId: $0) }.map(\.label),
                      agentIds: ids)
    }
  }

  /// The agent an approval waits on, whose column shows it: a merge's asker (the lead or planner merging its child's
  /// work), else the parent of the agent whose work merges (older daemons), else that agent.
  public func waitingAgent(_ a: PendingApproval) -> String? {
    guard let runId = a.runId ?? a.agentId.flatMap({ id in runs.values.first { $0.agents[id] != nil }?.id }),
          let run = runs[runId], let id = a.agentId else { return a.askedBy }
    if let asker = a.askedBy, run.agents[asker] != nil { return asker }
    if a.kind == "merge", let p = run.agents[id]?.parent, run.agents[p] != nil { return p }
    return run.agents[id] != nil ? id : nil
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
    ColumnHeader(agentId: a.id, runId: runId, name: n.name, title: n.title, suffix: n.suffix, userTitled: a.titleSource == "user", kind: n.kind, status: n.status, waiting: n.waiting,
                 activity: n.activity, repo: n.repo, spawnedAtMs: a.spawnedAtMs, startedAtMs: a.createdAtMs, provider: a.provider, depth: n.depth)
  }
}

extension CapcomdStore {
  /// The composer's goal branch row shows: a daemon with goal branches and a project checkout to start in (the default
  /// project and older daemons keep the composer as it was).
  public var goalBranchesOffered: Bool { capabilities.contains(Capability.runsGoalBranch) && prefs.startRepo != nil }

  /// What Start sends beside the goal: the remembered project, driver, place and effort, and, with goal branches, the
  /// base and branch `goalSetup` chose for that checkout. The menu bar's composer and the desktop's new project column
  /// both start runs this way.
  public func newRunChoice(goalSetup: GoalBranchSetup?) -> RunChoice {
    var c = RunChoice(repo: prefs.startRepo, driver: startDriver?.provider, sandbox: startSandbox?.name, effort: startEffort)
    if goalBranchesOffered, let g = goalSetup, g.path == c.repo { (c.base, c.goalBranch) = g.choice }
    return c
  }
}
