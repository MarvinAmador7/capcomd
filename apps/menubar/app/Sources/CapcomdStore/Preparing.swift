import Foundation

/// What an agent's thread shows while it has nothing in it yet: the daemon getting the agent ready (capability
/// agents.setup: its machine, its workspace, the repository's copy, its CLI), or, from a daemon that doesn't say, only
/// that it is starting. Only what the daemon reported: no phase is guessed and no progress made up.
public struct Preparing: Sendable, Hashable {
  public enum Phase: String, Sendable, Hashable { case queued, starting, machine, workspace, fetch, copy, install, restore, agent, other }
  public var phase: Phase
  /// The line, sentence case, without the trailing ellipsis: "Starting the machine", "Copying the repository",
  /// "Starting planner".
  public var line: String
  /// The copy's progress, when the daemon sent its total: "53% · 56 of 105 MB"; without one, "12 MB"; nil otherwise.
  public var detail: String?
  /// The copy's share sent, 0...1, when the total is known.
  public var fraction: Double?
  /// When the agent was spawned (the elapsed clock); nil when the daemon didn't say.
  public var sinceMs: Int?

  /// The daemon is setting the agent up (an activity of kind setup), not merely starting it.
  public var isSetup: Bool { phase != .queued && phase != .starting }

  /// Nil once the agent stopped, or once it reported a step of its own (its activity isn't setup any more).
  public static func of(status: AgentStatus, activityKind: String?, activity: String?, setup: AgentSetup?, name: String, sinceMs: Int?) -> Preparing? {
    switch status { case .running, .pending, .unknown: break; default: return nil }
    if activityKind == "setup", let s = setup {
      let phase = Phase(rawValue: s.phase) ?? .other
      switch phase {
      case .machine: return .init(phase: phase, line: "Starting the machine", sinceMs: sinceMs)
      case .workspace: return .init(phase: phase, line: "Preparing the workspace", sinceMs: sinceMs)
      case .fetch: return .init(phase: phase, line: "Fetching the repository", sinceMs: sinceMs)
      case .install: return .init(phase: phase, line: "Installing the agent's CLI", sinceMs: sinceMs)
      // ADR-026 §5: a woken agent's conversation (its saved session, or one rebuilt from its thread).
      case .restore: return .init(phase: phase, line: "Restoring the conversation", sinceMs: sinceMs)
      case .agent: return .init(phase: phase, line: "Starting \(name)", sinceMs: sinceMs)
      case .copy:
        let bytes = s.bytes, total = s.totalBytes.flatMap { $0 > 0 ? $0 : nil }
        guard let bytes else { return .init(phase: phase, line: "Copying the repository", sinceMs: sinceMs) }
        guard let total else { return .init(phase: phase, line: "Copying the repository", detail: "\(mb(bytes)) MB", sinceMs: sinceMs) }
        let f = min(1, max(0, Double(bytes) / Double(total)))
        return .init(phase: phase, line: "Copying the repository", detail: "\(Int(f * 100))% · \(mb(min(bytes, total))) of \(mb(total)) MB", fraction: f, sinceMs: sinceMs)
      default:   // a phase this app doesn't know: the daemon's own line
        return .init(phase: .other, line: activity ?? "Getting ready", sinceMs: sinceMs)
      }
    }
    // No step reported yet (an older daemon says nothing about its setup): it is starting, or waiting its turn.
    guard activityKind == nil, activity == nil else { return nil }
    return status == .pending ? .init(phase: .queued, line: "Waiting for its turn to start", sinceMs: sinceMs)
                              : .init(phase: .starting, line: "Starting \(name)", sinceMs: sinceMs)
  }

  /// Megabytes as the daemon writes them: one decimal under 10 MB, whole above.
  static func mb(_ b: Int) -> String {
    let m = Double(b) / 1_048_576
    if m >= 10 { return String(Int(m.rounded())) }
    let s = String(format: "%.1f", m)
    return s.hasSuffix(".0") ? String(s.dropLast(2)) : s
  }
}

/// A setup phase the daemon reported for an agent's current attempt, and when (the waking component's trail: done
/// steps with their time, the current one, the rest).
public struct SetupMark: Sendable, Hashable { public var phase: String; public var atMs: Int }

/// The trail of an attempt's setup, for the compact waking/setup component: each phase seen (with how long it took),
/// the current one, and the phases still expected after it.
public struct SetupTrail: Sendable, Hashable {
  public struct Step: Sendable, Hashable { public var phase: Preparing.Phase; public var line: String; public var state: State; public var ms: Int? }
  public enum State: Sendable, Hashable { case done, now, next }
  public var steps: [Step]
  /// From the first phase to now (or to the last step's end): "Set up in 1:15".
  public var elapsedMs: Int
  /// The phases an attempt's setup goes through, in order (fetch and install only when the daemon reports them).
  public static let order: [Preparing.Phase] = [.machine, .workspace, .fetch, .copy, .install, .restore, .agent]
  static func line(_ p: Preparing.Phase) -> String {
    switch p {
    case .machine: "Starting a machine"; case .workspace: "Preparing the workspace"; case .fetch: "Fetching the repository"
    case .copy: "Copying the repository"; case .install: "Installing the agent's CLI"; case .restore: "Restoring the conversation"
    case .agent: "Starting the agent"; default: "Getting ready"
    }
  }
  /// `marks` in order; `woken`: a continued attempt (restore is expected); `current`: the phase now, nil once it ended.
  public static func of(marks: [SetupMark], current: String?, woken: Bool, nowMs: Int) -> SetupTrail? {
    guard let first = marks.first else { return nil }
    var steps: [Step] = []
    for (i, m) in marks.enumerated() {
      let p = Preparing.Phase(rawValue: m.phase) ?? .other
      let end = i + 1 < marks.count ? marks[i + 1].atMs : nowMs
      let isNow = i == marks.count - 1 && current == m.phase
      steps.append(Step(phase: p, line: line(p), state: isNow ? .now : .done, ms: isNow ? nil : max(0, end - m.atMs)))
    }
    let seen = Set(steps.map(\.phase))
    let last = steps.last.flatMap { s in order.firstIndex(of: s.phase) } ?? -1
    for p in order.enumerated() where p.offset > last && !seen.contains(p.element) && p.element != .fetch && p.element != .install && (woken || p.element != .restore) {
      steps.append(Step(phase: p.element, line: line(p.element), state: .next, ms: nil))
    }
    return SetupTrail(steps: steps, elapsedMs: max(0, nowMs - first.atMs))
  }
}

extension CapcomdStore {
  /// The setup trail of the agent's current attempt (waking or first start), for the compact setup component; nil
  /// before the daemon reported a phase.
  public func setupTrail(runId: String, agentId: String, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> SetupTrail? {
    guard let a = runs[runId]?.agents[agentId] else { return nil }
    return SetupTrail.of(marks: a.setupMarks, current: a.activityKind == "setup" ? a.setup?.phase : nil, woken: a.continuedAtMs != nil, nowMs: nowMs)
  }

  /// The agent's getting-ready state, for its empty thread (`Preparing.of`); `name` is how its column names it.
  public func preparing(runId: String, agentId: String, name: String) -> Preparing? {
    guard let a = runs[runId]?.agents[agentId] else { return nil }
    return Preparing.of(status: a.status, activityKind: a.activityKind, activity: a.activity, setup: a.setup, name: name, sinceMs: a.createdAtMs)
  }
}
