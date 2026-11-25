import Foundation

/// ADR-026 §1: an agent is idle, not done. What a person sees of an agent, apart from how its last attempt ended
/// (outcomes stay visible on child rows: landed, stopped, passed): working, waking (a message woke it and it is being
/// set up again), idle (its turn ended; a message continues it), or archived (its run is read-only until restored).
public enum AgentLife: Sendable, Hashable {
  /// Pending, running, paused, or waiting between turns: its own status says which.
  case active
  /// A message woke it (agent.continued) and it is still being set up (machine, workspace, `restore`), for longer than
  /// `AgentLife.wakingDelayMs`: "waking". Shorter wakes (a parked machine, ~0.2 s) never flash it.
  case waking
  /// Its attempt ended (done, failed, cancelled) in a run that isn't archived: any message starts its next turn.
  case idle
  /// Its run is archived: the one state that takes no messages (Restore).
  case archived
  /// ADR-026 §4: it asked a question and stopped until it is answered (its turn ended, idle-like): a message to it is
  /// its answer and continues it.
  case asked

  /// "Waking…" shows only after this long (ADR-026 §9.6).
  public static let wakingDelayMs = 1000

  /// The state word a header or a root row shows for it, or nil when its status says it (working, queued, paused…).
  public var word: String? {
    switch self { case .active: nil; case .waking: "waking"; case .idle: "idle"; case .archived: "archived"; case .asked: "asked" }
  }
}

extension Agent {
  /// A message woke it into this attempt and it hasn't reported a step of its own yet (its activity is still setup).
  public var isWakingUp: Bool { status == .running && continuedAtMs != nil && activityKind == "setup" }

  /// What a person sees of it now (`nowMs`: the clock, for the waking delay); `archived`: its run is.
  public func life(archived: Bool, nowMs: Int) -> AgentLife {
    if archived { return .archived }
    if asked != nil { return .asked }
    switch status {
    case .done, .failed, .cancelled, .handedOff: return .idle
    default: break
    }
    if isWakingUp, let at = continuedAtMs, nowMs - at >= AgentLife.wakingDelayMs { return .waking }
    return .active
  }

  /// When "waking" may show (the end of the 1 s delay), while it is waking up; nil otherwise. A view schedules its
  /// refresh for this instant instead of polling.
  public var wakingShowsAtMs: Int? { isWakingUp ? continuedAtMs.map { $0 + AgentLife.wakingDelayMs } : nil }
}

/// The agent pane's message box, as the store decides it (the view that draws it is the thread's; it takes these as
/// parameters): its placeholder, whether it is replaced by Restore (archived), and whether the agent works now (the
/// send button may become Stop).
public struct ComposerState: Sendable, Hashable {
  /// "Tell planner…", "planner is idle. Send to continue.", or, archived, the line beside Restore.
  public var placeholder: String
  /// The run is archived: no text field, "This run is archived." and Restore (`CapcomdStore.restoreRun`).
  public var isArchived: Bool
  /// Working (or waking, or waiting between turns): a message is read as its next turn.
  public var isWorking: Bool
  /// Waking (after the 1 s delay): the box stays open throughout.
  public var isWaking: Bool
  /// Idle (or asked): a message continues it as a new attempt.
  public var isIdle: Bool

  public static func of(name: String, life: AgentLife, status: AgentStatus) -> ComposerState {
    switch life {
    case .archived: return .init(placeholder: "This run is archived.", isArchived: true, isWorking: false, isWaking: false, isIdle: false)
    case .idle: return .init(placeholder: "\(name) is idle. Send to continue.", isArchived: false, isWorking: false, isWaking: false, isIdle: true)
    // ADR-026 §9.4: a plain message to an asked agent is its answer.
    case .asked: return .init(placeholder: "Answer \(name)…", isArchived: false, isWorking: false, isWaking: false, isIdle: true)
    case .waking: return .init(placeholder: "Tell \(name)…", isArchived: false, isWorking: true, isWaking: true, isIdle: false)
    case .active: return .init(placeholder: "Tell \(name)…", isArchived: false, isWorking: status == .running, isWaking: false, isIdle: false)
    }
  }
}

/// Restoring an archived run (capability runs.archive): the Restore button's state.
public enum RestoreState: Sendable, Hashable { case idle, restoring, failed(String) }

extension CapcomdStore {
  /// The agent's state for its header, row and composer (`nowMs` defaults to now).
  public func agentLife(runId: String, agentId: String, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> AgentLife {
    guard let run = runs[runId], let a = run.agents[agentId] else { return .active }
    return a.life(archived: run.archived, nowMs: nowMs)
  }

  /// The pane's message box for this agent; `name` is how its pane names it ("planner").
  public func composerState(runId: String, agentId: String, name: String, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> ComposerState {
    let status = runs[runId]?.agents[agentId]?.status ?? .unknown
    return .of(name: name, life: agentLife(runId: runId, agentId: agentId, nowMs: nowMs), status: status)
  }

  /// The waking card's line: "Waking planner", with the setup phase the daemon reports (`preparing`, which includes
  /// `restore`: "Restoring the conversation"); nil while it isn't waking (or within its first second).
  public func wakingLine(runId: String, agentId: String, name: String, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> String? {
    agentLife(runId: runId, agentId: agentId, nowMs: nowMs) == .waking ? "Waking \(name)" : nil
  }

  /// Restore an archived run (capability runs.archive): its agents take messages again. The run.restored event (or a
  /// refresh) clears `Run.archived`; until it comes the run reads restored here.
  public func restoreRun(runId: String) async {
    guard let archiver else { restoreStates[runId] = .failed("This capcomd can't restore runs"); changed(); return }
    restoreStates[runId] = .restoring; changed()
    do {
      try await archiver.restore(runId: runId, idempotencyKey: makeKey())
      setArchived(runId: runId, false)
      restoreStates[runId] = nil
    } catch let e as MessageRefused { restoreStates[runId] = .failed(e.message) }
    catch is Unauthorized { unauthorized = true; restoreStates[runId] = .failed("capcomd rejected the token") }
    catch { restoreStates[runId] = .failed("Couldn't reach capcomd") }
    changed()
  }
}

/// `POST /v1/runs/{runId}/restore` (and `/archive`), capability runs.archive.
public protocol RunArchiving: Sendable {
  func restore(runId: String, idempotencyKey: String) async throws
  func archive(runId: String, idempotencyKey: String) async throws
}
