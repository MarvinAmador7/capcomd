import Foundation

/// An Active card (design/active-card, direction B "The ask leads"): one sentence while nothing needs the user, and the
/// ask, the failure or the usage-limit pause when something does. Built here from the store so it can be tested; the
/// SwiftUI card only lays it out.
public struct ActiveCard: Sendable, Hashable {
  /// An agent as the card names it: its profile, with the tree's suffix when siblings share it ("worker d3ce").
  public struct Member: Sendable, Hashable, Identifiable {
    public var runId: String
    public var agentId: String
    public var name: String
    public var id: String { agentId }
  }
  /// "worker d3ce" + " is editing 3 files". `who` is nil when no agent is named ("Starting").
  public struct Sentence: Sendable, Hashable {
    public var who: Member?
    public var rest: String
    public var text: String { (who?.name ?? "") + rest }
  }
  public struct Ask: Sendable, Hashable {
    public var approval: PendingApproval
    public var asker: Member?
    /// Client-worded from structured fields for a merge ("Merge worker's work into main?"), else the approval's own
    /// question (untrusted: shown as plain text).
    public var question: String
    /// Agents that can't go on until this is decided: the asker's live ancestors and the agents still queued.
    public var waiters: [Member]
  }
  public struct Failure: Sendable, Hashable {
    public var agent: Member
    /// True when its checks failed (verification), not the agent itself.
    public var checksFailed: Bool
    /// The line that says why: the check output naming the failure, else how the checks failed, else the agent's error.
    public var detail: UntrustedText?
  }
  public struct Pause: Sendable, Hashable {
    public var agents: [Member]
    public var provider: Provider?
    /// When they pick up again by themselves; nil when the provider didn't say.
    public var resumesAtMs: Int?
  }
  public enum Body: Sendable, Hashable {
    case working
    case ask(Ask)
    case failed(Failure)
    case paused(Pause)
  }

  public var projectId: String
  public var title: String
  /// The run the card speaks for: the one asking, failing or paused, else the newest active one.
  public var runId: String
  /// Every active run of the project: the unfolded tree shows each.
  public var runIds: [String]
  public var startedAtMs: Int?
  /// The crew heads: the first `crewShown` agents of `runId` in spawn order, and how many it has.
  public var crew: [Member]
  public var crewTotal: Int
  public var sentence: Sentence
  public var body: Body
  /// What unfolded the card ("ask:apr-…", "failed:agt-…", "paused:run-…"): a fold the user chose sticks until the
  /// reason changes. Nil while it only works.
  public var reason: String?

  public static let crewShown = 5
  public var crewMore: Int { max(0, crewTotal - crew.count) }
}

/// A finished project's outcome (the newest Recent row, unfolded): how its latest run ended, then what landed.
public struct CardOutcome: Sendable, Hashable {
  public var runId: String
  /// "Merged into main", or "Done", "Failed", "Stopped".
  public var head: String
  public var durationMs: Int?
  public var crew: [ActiveCard.Member]
  /// From the run's files (GET …/files) once read: how many files and lines.
  public var files: Int?
  public var added: Int?
  public var removed: Int?
  /// Every verified agent passed (true), one didn't (false), or none was verified (nil).
  public var checksPassed: Bool?
  /// What it cost in API spend; nil when nothing was billed (a subscription run reports no spend).
  public var costUsd: Double?
  /// A failed run: the line that says why.
  public var failure: UntrustedText?
}

extension CapcomdStore {
  /// The card for an active project at `nowMs` (see ActiveCard).
  public func activeCard(_ p: Project, nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> ActiveCard {
    let active = p.runs.filter { $0.outcome(nowMs: nowMs) == .active }
    let runs = active.isEmpty ? Array(p.runs.prefix(1)) : active
    let asks = runs.compactMap { r in approvals(forRun: r.id).first.map { (r, $0) } }.first
    let failed = runs.lazy.compactMap { r in Self.latest(r.agents.values.filter { $0.status == .failed }).map { (r, $0) } }.first
    let paused = runs.lazy.compactMap { r -> (Run, [Agent])? in
      let q = r.agents.values.filter { $0.status == .paused && $0.limit == "quota" }.sorted(by: Self.spawnOrder)
      return q.isEmpty ? nil : (r, q)
    }.first
    let run = asks?.0 ?? failed?.0 ?? paused?.0 ?? runs[0]
    let names = memberNames(run.id)
    func member(_ id: String) -> ActiveCard.Member { ActiveCard.Member(runId: run.id, agentId: id, name: names[id] ?? run.agents[id]?.displayName ?? "agent") }
    let ordered = run.agents.values.sorted(by: Self.spawnOrder)

    var body = ActiveCard.Body.working, reason: String?
    if let (_, a) = asks {
      let asker = a.agentId.flatMap { run.agents[$0] != nil ? member($0) : nil }
      let question = a.kind == "merge" && asker != nil && a.target != nil ? "Merge \(asker!.name)'s work into \(a.target!)?" : a.question.plain
      body = .ask(ActiveCard.Ask(approval: a, asker: asker, question: question, waiters: waiters(run, asker: a.agentId).map(member)))
      reason = "ask:\(a.id)"
    } else if let (_, ag) = failed {
      let checksFailed = ag.checks.map { !$0.passed } ?? false
      body = .failed(ActiveCard.Failure(agent: member(ag.id), checksFailed: checksFailed,
                                        detail: checksFailed ? (ag.checks?.excerpt ?? ag.checks?.reason ?? ag.error) : (ag.error ?? ag.checks?.excerpt)))
      reason = "failed:\(ag.id)"
    } else if let (_, ags) = paused {
      body = .paused(ActiveCard.Pause(agents: ags.map { member($0.id) }, provider: ags.compactMap(\.provider).first,
                                      resumesAtMs: ags.compactMap(\.resetAtMs).min()))
      reason = "paused:\(run.id):" + ags.map(\.id).joined(separator: ",")
    }
    return ActiveCard(projectId: p.id, title: p.title, runId: run.id, runIds: runs.map(\.id), startedAtMs: run.startedAtMs,
                      crew: ordered.prefix(ActiveCard.crewShown).map { member($0.id) }, crewTotal: ordered.count,
                      sentence: sentence(run, member: member), body: body, reason: reason)
  }

  /// The outcome of a finished project's latest run.
  public func outcome(_ p: Project) -> CardOutcome? {
    guard let run = p.latestRun, !p.isActive else { return nil }
    let names = memberNames(run.id)
    let agents = run.agents.values.sorted(by: Self.spawnOrder)
    let merged = agents.last { $0.merge?.state == "merged" }?.merge
    let verb: String = switch run.outcome { case .failed: "Failed"; case .stopped: "Stopped"; default: "Done" }
    let head = run.outcome == .done && merged != nil ? "Merged into \(merged!.target ?? "the target")" : verb
    let took = run.startedAtMs.flatMap { s in run.endedAtMs.flatMap { e in e >= s ? e - s : nil } }
    let checked = agents.compactMap(\.checks)
    let cost = agents.compactMap(\.costUsd).reduce(0, +)
    var out = CardOutcome(runId: run.id, head: head, durationMs: took,
                          crew: agents.prefix(ActiveCard.crewShown).map { ActiveCard.Member(runId: run.id, agentId: $0.id, name: names[$0.id] ?? $0.displayName) },
                          checksPassed: checked.isEmpty ? nil : checked.allSatisfy(\.passed), costUsd: cost > 0 ? cost : nil)
    // No files (nothing pushed, or nothing the mirror could read) says nothing rather than "0 files".
    if case .loaded(let f)? = files[run.id], f.total > 0 {
      out.files = f.total
      out.added = f.files.compactMap(\.added).reduce(0, +); out.removed = f.files.compactMap(\.removed).reduce(0, +)
    }
    // The failed agent that says why (its parent may have failed after it with nothing to add).
    if run.outcome == .failed { out.failure = Self.latest(agents.filter { $0.status == .failed && ($0.error ?? $0.checks?.excerpt) != nil }).flatMap { $0.error ?? $0.checks?.excerpt } }
    return out
  }

  // MARK: helpers
  /// Who the folded card names: the working agent whose activity changed last (the deeper one on a tie), else a paused
  /// one, else a queued one.
  func sentence(_ run: Run, member: (String) -> ActiveCard.Member) -> ActiveCard.Sentence {
    let working = run.agents.values.filter { $0.status == .running }
    if let a = working.max(by: { ($0.activityAtMs ?? $0.updatedAtMs ?? $0.spawnedAtMs, $0.depth, $1.id) < ($1.activityAtMs ?? $1.updatedAtMs ?? $1.spawnedAtMs, $1.depth, $0.id) }) {
      return ActiveCard.Sentence(who: member(a.id), rest: a.activity.map(Self.predicate) ?? " is working")
    }
    if let a = run.agents.values.filter({ $0.status == .paused }).sorted(by: Self.spawnOrder).first { return .init(who: member(a.id), rest: " is paused") }
    if let a = run.agents.values.filter({ $0.status == .pending }).sorted(by: Self.spawnOrder).first { return .init(who: member(a.id), rest: " is queued") }
    if run.agents.isEmpty { return .init(who: nil, rest: "Starting") }
    return .init(who: nil, rest: "Wrapping up")
  }

  /// "Reading 4 files" → " is reading 4 files"; a line that isn't progressive ("Read 4 files") follows a colon.
  nonisolated static func predicate(_ activity: String) -> String {
    let first = activity.prefix { !$0.isWhitespace }
    guard first.count > 3, first.lowercased().hasSuffix("ing"), let c = activity.first else { return ": \(activity)" }
    return " is " + c.lowercased() + activity.dropFirst()
  }

  /// The agents an approval holds up: the asker's live ancestors (they wait on their children), then the agents still
  /// queued outside the asker's own subtree, in spawn order.
  func waiters(_ run: Run, asker: String?) -> [String] {
    guard let asker, run.agents[asker] != nil else { return [] }
    var mine: Set<String> = [asker], grew = true
    while grew { grew = false; for a in run.agents.values where a.parent.map(mine.contains) == true && !mine.contains(a.id) { mine.insert(a.id); grew = true } }
    var up: [String] = [], p = run.agents[asker]?.parent
    while let id = p, let a = run.agents[id] { if !a.status.isTerminal { up.append(id) }; p = a.parent }
    let queued = run.agents.values.filter { $0.status == .pending && !mine.contains($0.id) }.sorted(by: Self.spawnOrder).map(\.id)
    let ancestors = up.reversed().compactMap { run.agents[$0] }.sorted(by: Self.spawnOrder).map(\.id)
    return ancestors + queued.filter { !ancestors.contains($0) }
  }

  /// Each agent's name as its tree row shows it: the profile, plus the suffix siblings of one profile get.
  func memberNames(_ runId: String) -> [String: String] {
    var out: [String: String] = [:]
    func walk(_ ns: [AgentNode]) { for n in ns { out[n.id] = n.name + (n.suffix.map { " \($0)" } ?? ""); walk(n.children) } }
    walk(agentTree(runId: runId))
    return out
  }

  nonisolated static func spawnOrder(_ a: Agent, _ b: Agent) -> Bool { (a.spawnedAtMs, a.id) < (b.spawnedAtMs, b.id) }
  nonisolated static func latest(_ agents: [Agent]) -> Agent? { agents.max { ($0.updatedAtMs ?? $0.spawnedAtMs, $0.id) < ($1.updatedAtMs ?? $1.spawnedAtMs, $1.id) } }
}

/// The card's elapsed time in tabular figures: "0:42", "4:12", "1:02:09".
public func elapsedClock(ms: Int) -> String {
  let s = max(0, ms / 1000), h = s / 3600, m = (s % 3600) / 60, sec = s % 60
  return h > 0 ? String(format: "%d:%02d:%02d", h, m, sec) : String(format: "%d:%02d", m, sec)
}

/// "planner", "planner and reviewer", "planner, lead and 2 others": names in a sentence.
public func namesPhrase(_ names: [String], max: Int = 2) -> String {
  switch names.count {
  case 0: return ""
  case 1: return names[0]
  case 2 where max >= 2: return "\(names[0]) and \(names[1])"
  default:
    let shown = names.prefix(max), rest = names.count - shown.count
    return rest == 0 ? shown.dropLast().joined(separator: ", ") + " and " + shown.last! : shown.joined(separator: ", ") + " and \(rest) other\(rest == 1 ? "" : "s")"
  }
}
