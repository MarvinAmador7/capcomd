import Foundation

/// Where a Pause / Resume / Stop stands for one run. `requested` holds until the lifecycle confirms it (run.paused,
/// run.resumed, a terminal state), so the button doesn't flip back while a running agent is still stopping.
public enum ControlState: Sendable, Hashable {
  case idle, submitting(RunControl), requested(RunControl), failed(String)
}

extension CapcomdStore {
  /// The Log pane keeps the newest lines only.
  public static let logTail = 200

  /// The agent the drill-down follows: the one working now (latest activity first), else the one that changed last.
  public func focusAgent(runId: String) -> Agent? {
    guard let run = runs[runId] else { return nil }
    let all = run.agents.values
    let byRecency: (Agent, Agent) -> Bool = { ($0.updatedAtMs ?? $0.spawnedAtMs, $0.id) < ($1.updatedAtMs ?? $1.spawnedAtMs, $1.id) }
    return all.filter { $0.status == .running }.max(by: byRecency) ?? all.max(by: byRecency)
  }

  public func refreshTrace(_ runId: String) async {
    guard let detail else { return }
    do { traces[runId] = .loaded(try await detail.trace(runId: runId)) }
    catch { record(error) { traces[runId] = .unavailable($0) } }
    changed()
  }

  public func refreshFiles(_ runId: String) async {
    guard let detail else { return }
    do { files[runId] = .loaded(try await detail.files(runId: runId)) }
    catch { record(error) { files[runId] = .unavailable($0) } }
    changed()
  }

  /// Reads the agent's transcript from its cursor to the end (pages of 500), keeping the last `logTail` lines.
  public func refreshLog(runId: String, agentId: String) async {
    guard let detail else { return }
    var after = logCursor[agentId], lines = logs[agentId] ?? []
    do {
      for _ in 0..<50 {   // bounded: a huge transcript catches up over a few refreshes
        let page = try await detail.transcript(runId: runId, agentId: agentId, after: after, limit: 500)
        for i in page.items { lines.append(LogLine(seq: i.seq, atMs: epochMs(iso: i.at) ?? 0, text: UntrustedText(i.text))) }
        if lines.count > Self.logTail { lines.removeFirst(lines.count - Self.logTail) }
        after = page.items.last?.seq ?? after
        guard let next = page.next else { break }
        after = next
      }
      logs[agentId] = lines; logCursor[agentId] = after; logUnavailable[agentId] = nil
    } catch { record(error) { logUnavailable[agentId] = $0 } }
    changed()
  }

  /// Trace rows: the run's kept spans, then agents running or queued with no span yet (spans are written when they end).
  public func traceRows(runId: String, nowMs: Int, collapsed: Set<String> = []) -> [TraceRow] {
    let spans = traces[runId]?.value ?? []
    let steps = steps(forRun: runId)
    let pending = steps.filter { $0.status == .running || $0.status == .queued || $0.status == .waiting }.map { s in
      (id: s.id, label: s.text, kind: s.kind, status: s.status, startMs: s.epochMs)
    }
    return TraceShape.rows(spans: spans, pending: pending, nowMs: nowMs, collapsed: collapsed)
  }

  /// The footer's primary control for a run: Resume once it is paused, else Pause.
  public func pauseAction(runId: String) -> RunControl {
    if runs[runId]?.state == "paused" { return .resume }
    if case .requested(.pause) = controlState[runId] { return .resume }
    return .pause
  }

  /// Pause, resume or stop a run. A fresh Idempotency-Key per tap: each tap is a new request, and the daemon replays a
  /// retried one.
  @discardableResult
  public func control(_ runId: String, _ action: RunControl) async -> ControlState {
    guard let controls else { return .failed("unavailable") }
    if case .submitting = controlState[runId] { return controlState[runId]! }
    controlState[runId] = .submitting(action); changed()
    let result: ControlState
    do { try await controls.control(runId: runId, action, idempotencyKey: makeKey()); result = .requested(action) }
    catch let e as ControlRefused { result = .failed(e.message) }
    catch is Unauthorized { unauthorized = true; result = .failed("capcomd rejected the token") }
    catch DetailUnavailable.unsupported { result = .failed("This capcomd can't \(action == .cancel ? "stop" : action.rawValue) runs yet") }
    catch { result = .failed("Couldn't reach capcomd") }
    controlState[runId] = result; changed()
    return result
  }

  /// Called on lifecycle transitions: a requested control is done once the run's state reflects it.
  func settleControl(runId: String) {
    guard case .requested(let a) = controlState[runId], let state = runs[runId]?.state else { return }
    let done = switch a {
      case .pause: state == "paused"
      case .resume: state == "running"
      case .cancel: Run.terminalStates.contains(state)
    }
    if done { controlState[runId] = .idle }
  }

  /// Pause or resume one agent and its subtree (capability `agent.pause`). The same key discipline as run controls: a
  /// fresh Idempotency-Key per tap; `requested` holds until the agent's lifecycle confirms it.
  @discardableResult
  public func controlAgent(runId: String, agentId: String, _ action: RunControl) async -> ControlState {
    guard let controls else { return .failed("unavailable") }
    if case .submitting = agentControlState[agentId] { return agentControlState[agentId]! }
    agentControlState[agentId] = .submitting(action); changed()
    let result: ControlState
    do { try await controls.control(runId: runId, agentId: agentId, action, idempotencyKey: makeKey()); result = .requested(action) }
    catch let e as ControlRefused { result = .failed(e.message) }
    catch is Unauthorized { unauthorized = true; result = .failed("capcomd rejected the token") }
    catch DetailUnavailable.unsupported { result = .failed("This capcomd can't \(action.rawValue) one agent yet") }
    catch { result = .failed("Couldn't reach capcomd") }
    agentControlState[agentId] = result; changed()
    return result
  }

  func settleAgentControl(agentId: String, status: AgentStatus) {
    guard case .requested(let a) = agentControlState[agentId] else { return }
    let done = switch a {
      case .pause: status == .paused || status.isTerminal
      case .resume: status == .running || status.isTerminal
      case .cancel: status.isTerminal
    }
    if done { agentControlState[agentId] = .idle }
  }

  private func record(_ error: Error, _ set: (DetailUnavailable) -> Void) {
    if error is Unauthorized { unauthorized = true; return }
    set(error as? DetailUnavailable ?? .failed("Couldn't reach capcomd"))
  }
}

/// Where a "Start a project…" submission stands.
public enum StartState: Sendable, Hashable { case idle, starting, started(runId: String), needsRepo(String), failed(String) }

extension CapcomdStore {
  /// Start a run on `goal`. One Idempotency-Key per submission, reused if the same goal is retried after a transport
  /// failure, so a lost response doesn't start it twice.
  @discardableResult
  public func startRun(goal raw: String, repo: String? = nil, driver: String? = nil, sandbox: String? = nil, effort: String? = nil) async -> StartState {
    await startRun(goal: raw, RunChoice(repo: repo, driver: driver, sandbox: sandbox, effort: effort))
  }
  @discardableResult
  public func startRun(goal raw: String, _ choice: RunChoice) async -> StartState {
    let goal = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let starter, !goal.isEmpty else { return .idle }
    let key = pendingStartKey.flatMap { $0.goal == goal && $0.choice == choice ? $0.key : nil } ?? makeKey()
    pendingStartKey = (goal, choice, key)
    startState = .starting; changed()
    do {
      let id = try await starter.start(goal: goal, choice: choice, idempotencyKey: key)
      pendingStartKey = nil; startState = .started(runId: id)
    } catch let e as StartRefused {
      pendingStartKey = nil; startState = e.needsRepo ? .needsRepo(e.message) : .failed(e.message)
    } catch is Unauthorized { unauthorized = true; startState = .failed("capcomd rejected the token") }
    catch DetailUnavailable.unsupported { pendingStartKey = nil; startState = .failed("This capcomd can't start runs from here yet") }
    catch { startState = .failed("Couldn't reach capcomd") }   // key kept: a retry replays instead of starting twice
    changed()
    return startState
  }
  public func clearStart() { startState = .idle; changed() }
}
