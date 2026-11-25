import Foundation

/// What the pane's model chip says for one agent, and what its menu offers: the agent's own harness (it can't change
/// mid-run), that harness's models and effort levels, and the pick for its next turn. Read-only (`editable` false) on a
/// daemon that can't take a model with a message.
public struct AgentModelChoice: Sendable, Hashable {
  public var provider: Provider?
  /// "Claude Code".
  public var harness: String?
  /// The model as the chip names it ("Opus 4.5"): the pick for its next turn, else what it runs on now.
  public var chip: String
  /// The harness's models, in menu order (empty: the daemon lists none).
  public var models: [ModelInfo]
  /// The model the chip names (its id), if known.
  public var model: String?
  /// Effort levels, lowest first (empty: not settable), and the one picked (nil: as it is).
  public var efforts: [String]
  public var effort: String?
  /// The daemon takes `model` / `effort` with a message.
  public var editable: Bool
  /// A pick waits for the agent's next turn.
  public var pending: Bool
  /// For VoiceOver: "Claude Code, Opus 4.5, high effort, from its next turn".
  public var label: String
  public var effortIndex: Int? { effort.flatMap { efforts.firstIndex(of: $0) } }
}

/// The model and effort picked for an agent's next turn (sent with the next message).
public struct NextTurn: Sendable, Hashable {
  public var model: String?
  public var effort: String?
  public init(model: String? = nil, effort: String? = nil) { self.model = model; self.effort = effort }
}

extension CapcomdStore {
  public func agentModelChoice(runId: String, agentId: String) -> AgentModelChoice? {
    guard let a = runs[runId]?.agents[agentId] else { return nil }
    let driver = runOptions.drivers.first { Provider(wire: $0.provider) == a.provider && a.provider != nil }
    let pick = nextTurn[agentId]
    let model = pick?.model ?? a.model
    let models = capabilities.contains(Capability.runsOptionsModels) ? (driver?.models ?? []) : []
    let name: String = {
      if let m = model, let listed = models.first(where: { $0.id == m }) { return listed.name }
      if let d = driver { return ModelMenu.name(d, model: model) }
      return ModelMenu.displayName(model: model) ?? model ?? a.provider?.displayName ?? "Agent"
    }()
    let efforts = driver?.efforts ?? []
    let editable = capabilities.contains(Capability.agentsMessagesModel) && driver != nil
    let effort = pick?.effort
    let harness = driver?.label ?? a.provider.map { $0 == .claude ? "Claude Code" : "Codex" }
    let pending = pick != nil && (pick?.model != nil && pick?.model != a.model || pick?.effort != nil)
    let spoken = ([harness, name, effort.map { EffortWords.title($0).lowercased() + " effort" }, pending ? "from its next turn" : nil] as [String?]).compactMap { $0 }
    return AgentModelChoice(provider: a.provider, harness: harness, chip: name, models: models, model: model, efforts: efforts, effort: effort,
                            editable: editable, pending: pending, label: spoken.joined(separator: ", "))
  }

  /// Picks the model (nil: keep) and effort for the agent's next turn; it goes with the next message sent to it.
  public func setNextTurn(agentId: String, model: String?? = nil, effort: String?? = nil) {
    var t = nextTurn[agentId] ?? NextTurn()
    if let model { t.model = model }
    if let effort { t.effort = effort }
    nextTurn[agentId] = t.model == nil && t.effort == nil ? nil : t
    changed()
  }
}

/// What an agent's pane composer shows: its placeholder, whether the agent is working (the send circle becomes Stop
/// while the box is empty), whether its run is archived (a Restore line instead of the box), and its model chip. One
/// value, made by `paneComposer`: the agent lifecycle (idle, archived, waking) changes what goes in it, not the view.
///
/// Its first five fields come from the agent lifecycle's `ComposerState` (`composerState(runId:agentId:name:)`).
public struct PaneComposerState: Sendable, Hashable {
  /// "Tell planner…", or "planner is idle. Send to continue."
  public var placeholder: String
  /// Its run is archived: the box is replaced by a line saying so, with Restore when `canRestore`.
  public var isArchived: Bool
  /// Working on a turn (or waking): Stop is offered while nothing is typed; Return still sends (the daemon delivers it
  /// as it can). Waiting between turns, idle or done: not working.
  public var isWorking: Bool
  public var isWaking: Bool
  /// Its turn ended: a message continues it.
  public var isIdle: Bool
  /// Restore is offered (capability runs.archive).
  public var canRestore: Bool
  /// Stop pauses the agent (capability agent.pause: its work is committed and pushed, Resume continues it).
  public var canStop: Bool
  /// The daemon delivers the message (false: nothing would read it, so the box doesn't send).
  public var canSend: Bool
  /// The skills the + menu attaches (capability steer.skills); empty: none to offer.
  public var skills: [String]
  public var model: AgentModelChoice?
  public init(placeholder: String, isArchived: Bool = false, isWorking: Bool = false, isWaking: Bool = false, isIdle: Bool = false,
              canRestore: Bool = false, canStop: Bool = false, canSend: Bool = true, skills: [String] = [], model: AgentModelChoice? = nil) {
    self.placeholder = placeholder; self.isArchived = isArchived; self.isWorking = isWorking; self.isWaking = isWaking; self.isIdle = isIdle
    self.canRestore = canRestore; self.canStop = canStop; self.canSend = canSend; self.skills = skills; self.model = model
  }
}

extension CapcomdStore {
  /// The pane composer's state for one agent (`name`: how its column names it, "planner").
  public func paneComposer(runId: String, agentId: String, name: String) -> PaneComposerState {
    let a = runs[runId]?.agents[agentId]
    let status = a?.status ?? .unknown
    let life = composerState(runId: runId, agentId: agentId, name: name)
    let working = (life.isWaking || status == .running) && a?.wake == nil && a?.limit == nil
    let skills: [String] = {
      guard capabilities.contains(Capability.steerSkills), case .loaded(let list)? = self.skills else { return [] }
      return list.map(\.name)
    }()
    // An idle agent takes messages where the daemon continues it (agents.idle); an older one refuses them, so an ended
    // agent's box doesn't send there. An archived run's take none until it is restored.
    let continues = capabilities.contains(Capability.agentsIdle)
    let canSend = !life.isArchived && (!status.isTerminal || continues)
    return PaneComposerState(placeholder: life.isIdle && !continues ? "Tell \(name)…" : life.placeholder, isArchived: life.isArchived,
                             isWorking: working, isWaking: life.isWaking, isIdle: life.isIdle && continues,
                             canRestore: life.isArchived && capabilities.contains(Capability.runsArchive),
                             canStop: working && capabilities.contains(Capability.agentPause), canSend: canSend,
                             skills: skills, model: agentModelChoice(runId: runId, agentId: agentId))
  }
}
