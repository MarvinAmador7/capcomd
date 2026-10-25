import Foundation

/// The menu bar app's state, fed by per-scope event streams. Platform-neutral (no SwiftUI/Observation: Observation
/// doesn't link on the Linux toolchain here). The macOS app mirrors `onChange` into an `@Observable` model.
@MainActor
public final class CapcomdStore {
  // MARK: state
  public private(set) var runs: [String: Run] = [:]
  public private(set) var approvals: [String: PendingApproval] = [:]
  public private(set) var openRunId: String?
  public private(set) var lastSeq: [String: Int] = [:]
  public private(set) var resetCount = 0
  public internal(set) var threads: [String: [ThreadItem]] = [:]
  public let prefs: UIPreferences
  public var onChange: (@MainActor () -> Void)?

  let subscriber: StreamSubscribing?
  let decider: ApprovalDeciding?
  let clientId: String
  var subs: [String: SubscriptionHandle] = [:]
  var pendingReset: [String: ResetBuffer] = [:]
  var approvalSeq: [String: Int] = [:]
  var keyCounter = 0
  let makeKey: () -> String

  struct ResetBuffer { var snapshotSeq: Int?; var runs: [SnapshotRun] = []; var agents: [SnapshotAgent] = []; var approvals: [SnapshotApproval] = [] }

  public init(subscriber: StreamSubscribing? = nil, decider: ApprovalDeciding? = nil, prefs: PreferenceStoring = InMemoryPreferences(),
              clientId: String = "menubar", makeKey: (() -> String)? = nil) {
    self.subscriber = subscriber; self.decider = decider; self.prefs = UIPreferences(store: prefs); self.clientId = clientId
    self.makeKey = makeKey ?? { "\(clientId)-\(UUID().uuidString.lowercased())" }
  }

  // MARK: derived views
  /// Project cards: running first, then most recent event (SPEC §4.1).
  public var projects: [Project] {
    let grouped = Dictionary(grouping: runs.values) { $0.projectId ?? $0.id }
    return grouped.map { id, rs in
      let sorted = rs.sorted { $0.lastEventMs > $1.lastEventMs }
      return Project(id: id, goal: sorted.first(where: { $0.goal != nil })?.goal, runs: sorted)
    }.sorted { ($0.isRunning ? 1 : 0, $0.lastEventMs, $0.id) > ($1.isRunning ? 1 : 0, $1.lastEventMs, $1.id) }
  }
  /// Undecided approvals in request order.
  public var pendingApprovals: [PendingApproval] {
    approvals.values.sorted { (approvalSeq[$0.id] ?? 0, $0.id) < (approvalSeq[$1.id] ?? 0, $1.id) }
  }
  /// The one allowed number: the menu bar badge.
  public var badgeCount: Int { approvals.values.filter { if case .decided = $0.decision { return false }; return true }.count }
  public func approvals(forRun id: String) -> [PendingApproval] { pendingApprovals.filter { $0.runId == id } }
  public func steps(forRun id: String) -> [Step] { runs[id]?.steps ?? [] }

  /// Outline tree for a run, orchestrator first. Approvals bubble to ancestors.
  public func agentTree(runId: String) -> [AgentNode] {
    guard let run = runs[runId] else { return [] }
    let waiting = Set(approvals.values.compactMap { $0.runId == runId || $0.runId == nil ? $0.agentId : nil })
    let byParent = Dictionary(grouping: run.agents.values) { a -> String in
      if let p = a.parent, run.agents[p] != nil { return p }; return ""
    }
    func build(_ parent: String, depth: Int) -> [AgentNode] {
      let kids = (byParent[parent] ?? []).sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) }
      let suffixes = Self.disambiguate(kids)
      return kids.map { a in
        let children = build(a.id, depth: depth + 1)
        let w = waiting.contains(a.id)
        return AgentNode(id: a.id, name: a.displayName, suffix: suffixes[a.id], kind: a.kind, status: a.status, activity: a.activity, depth: depth,
                         waiting: w, descendantWaiting: children.contains { $0.waiting || $0.descendantWaiting }, children: children)
      }
    }
    return build("", depth: 0)
  }

  /// Siblings sharing a profile get a suffix: repo if each has a distinct one, else short task id, else last 4 of agentId.
  nonisolated static func disambiguate(_ sibs: [Agent]) -> [String: String] {
    var out: [String: String] = [:]
    for (_, group) in Dictionary(grouping: sibs, by: { ($0.profile ?? "").lowercased() }) where group.count > 1 {
      let repos = group.compactMap(\.repo)
      let keys = group.compactMap { $0.key.map(shortId) }
      let useRepo = repos.count == group.count && Set(repos).count == group.count
      let useKey = !useRepo && keys.count == group.count && Set(keys).count == group.count
      for a in group { out[a.id] = useRepo ? a.repo! : useKey ? shortId(a.key!) : String(a.id.suffix(4)) }
    }
    return out
  }
  nonisolated static func shortId(_ s: String) -> String {
    let alnum = s.filter { $0.isLetter || $0.isNumber }; return String(alnum.suffix(4))
  }

  // MARK: subscriptions
  /// Subscribe to the `daemon` scope (project list, approvals).
  public func start() { subscribe("daemon") }
  /// Open a run scope when the user drills in; closes any previous run scope.
  public func openRun(_ runId: String) {
    if let old = openRunId, old != runId { closeRun() }
    openRunId = runId; subscribe(runId.hasPrefix("run-") ? runId : "run-\(runId)"); changed()
  }
  public func closeRun() {
    guard let id = openRunId else { return }
    let scope = id.hasPrefix("run-") ? id : "run-\(id)"
    subs.removeValue(forKey: scope)?.cancel(); openRunId = nil; changed()
  }
  public func stop() { subs.values.forEach { $0.cancel() }; subs = [:] }
  public var activeScopes: [String] { subs.keys.sorted() }

  func subscribe(_ scope: String) {
    guard subs[scope] == nil, let subscriber else { return }
    subs[scope] = subscriber.subscribe(scope: scope, after: lastSeq[scope] ?? 0) { [weak self] f in
      await self?.receive(f, scope: scope)
    }
  }

  // MARK: frames
  public func receive(_ frame: StreamFrame, scope: String) {
    switch frame {
    case .event(let e):
      if pendingReset[scope] != nil, let s = pendingReset[scope]?.snapshotSeq, e.seq <= s { return }
      guard e.seq > (lastSeq[scope] ?? 0) else { return }      // dedupe by seq per scope
      lastSeq[scope] = e.seq
      apply(e)
    case .reset(let s, _):
      pendingReset[scope] = ResetBuffer(snapshotSeq: s)
      return
    case .snapshotRun(let r): pendingReset[scope, default: ResetBuffer()].runs.append(r); return
    case .snapshotAgents(let a): pendingReset[scope, default: ResetBuffer()].agents += a; return
    case .snapshotApprovals(let a): pendingReset[scope, default: ResetBuffer()].approvals += a; return
    case .snapshotEnd(let s):
      let buf = pendingReset.removeValue(forKey: scope) ?? ResetBuffer()
      rebuild(scope: scope, from: buf, snapshotSeq: s)
    case .ignored: return
    }
    changed()
  }

  /// Drop local state owned by `scope` and apply the snapshot (handles both `compacted` and `overflow`).
  func rebuild(scope: String, from b: ResetBuffer, snapshotSeq: Int) {
    resetCount += 1
    let owned: Set<String> = scope == "daemon" ? Set(runs.keys) : [scope]
    let keepOpen = scope == "daemon" ? openRunId : nil   // the open run's own stream owns its detail
    for id in owned where id != keepOpen { runs[id]?.agents.keys.forEach { threads.removeValue(forKey: $0) }; runs.removeValue(forKey: id) }
    for (id, a) in approvals where a.runId.map(owned.contains) ?? (scope == "daemon") { if a.runId != keepOpen || a.runId == nil { approvals.removeValue(forKey: id) } }
    for r in b.runs {
      var run = runs[r.id] ?? Run(id: r.id, projectId: r.projectId, label: r.label, goal: nil, state: r.state, startedAtMs: nil, lastEventMs: 0)
      run.projectId = r.projectId; run.label = r.label; run.state = r.state; run.goal = r.goal.map(UntrustedText.init)
      runs[r.id] = run
    }
    let agentRuns = Set(b.agents.map(\.runId))
    for rid in agentRuns { runs[rid, default: Run(id: rid, projectId: nil, label: nil, goal: nil, state: "running", startedAtMs: nil, lastEventMs: 0)].agents = [:]; runs[rid]?.steps = [] }
    for (i, a) in b.agents.enumerated() {
      let ag = Agent(id: a.id, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: AgentStatus(wire: a.status),
                     task: a.task.map(UntrustedText.init), key: nil, repo: nil, spawnedAtMs: i, activity: a.text)
      runs[a.runId]?.agents[a.id] = ag
      // One Activity row per agent: the daemon's `text` is the activity line, the (untrusted) task is the detail.
      // TODO: snapshot.steps carries real step history (phase 1); not rendered yet.
      upsertStep(runId: a.runId, Step(id: "agent:\(a.id)", seq: snapshotSeq, epochMs: 0, agentId: a.id, kind: .agent, phase: Self.phase(ag.kind),
                                      text: a.text ?? ag.displayName, detail: ag.task, status: Self.stepStatus(ag.status)))
    }
    for a in b.approvals where a.status == "pending" {
      let rid = a.requestedBy?.runId ?? (scope.hasPrefix("run-") ? scope : nil)
      approvals[a.approvalId] = PendingApproval(id: a.approvalId, runId: rid, agentId: a.requestedBy?.agentId, kind: a.kind,
                                                question: UntrustedText(a.question), branchLine: Self.branchLine(kind: a.kind, subject: a.subject ?? [:]))
      approvalSeq[a.approvalId] = snapshotSeq
    }
    lastSeq[scope] = snapshotSeq
  }

  // MARK: reducer
  func apply(_ e: Envelope) {
    let d = e.data
    let runId = e.runId ?? d["runId"]?.string ?? (e.scope.hasPrefix("run-") ? e.scope : nil)
    if let runId {
      var r = runs[runId] ?? Run(id: runId, projectId: e.projectId, label: nil, goal: nil, state: "running", startedAtMs: e.epochMs, lastEventMs: e.epochMs)
      r.lastEventMs = max(r.lastEventMs, e.epochMs); if r.projectId == nil { r.projectId = e.projectId }
      runs[runId] = r
    }
    let agentId = e.agentId ?? d["agentId"]?.string
    defer { reduceThread(e, runId: runId, agentId: agentId) }
    switch e.type {
    case "run.created":
      guard let runId else { return }
      runs[runId]?.goal = d["goal"]?.string.map(UntrustedText.init); runs[runId]?.startedAtMs = e.epochMs
    case "run.new":
      guard let runId else { return }
      runs[runId]?.label = d["label"]?.string
    case "agent.spawned":
      guard let runId, let id = agentId ?? Optional(e.entity) else { return }
      let parent = d["parent"]?.string
      let profile = d["profile"]?.string ?? d["profile"]?["name"]?.string ?? d["agent"]?["profile"]?.string
      let depth = d["depth"]?.int ?? parent.flatMap { runs[runId]?.agents[$0].map { $0.depth + 1 } } ?? 0
      let a = Agent(id: id, runId: runId, parent: parent, depth: depth, profile: profile, status: .pending,
                    task: d["task"]?.string.map(UntrustedText.init), key: d["key"]?.string,
                    repo: d["repo"]?.string ?? d["agent"]?["repo"]?.string, spawnedAtMs: e.epochMs)
      runs[runId]?.agents[id] = a
      upsertStep(runId: runId, Step(id: "agent:\(id)", seq: e.seq, epochMs: e.epochMs, agentId: id, kind: .agent,
                                    phase: Self.phase(a.kind), text: a.displayName, detail: a.task, status: .queued))
    case "agent.started", "agent.resumed": setStatus(runId, agentId, .running, e)
    case "agent.status_changed", "agent.status": setStatus(runId, agentId, AgentStatus(wire: d["status"]?.string), e)
    case "agent.done": setStatus(runId, agentId, .done, e)
    case "agent.failed", "drive.failed": setStatus(runId, agentId, .failed, e)
    case "agent.cancelled", "agent.reaped": setStatus(runId, agentId, .cancelled, e)
    case "agent.paused": setStatus(runId, agentId, .paused, e)
    case "verify.started", "verify.passed", "verify.failed":
      guard let runId else { return }
      let st: StepStatus = e.type == "verify.started" ? .running : e.type == "verify.passed" ? .done : .failed
      let text = e.type == "verify.started" ? "Verifying" : e.type == "verify.passed" ? "Verified" : "Verification failed"
      upsertStep(runId: runId, Step(id: "verify:\(e.entity)", seq: e.seq, epochMs: e.epochMs, agentId: agentId, kind: .verify, phase: .ship, text: text, detail: nil, status: st))
    case "merge.started", "merge.succeeded", "merge.failed", "merge.approval_requested", "merge.awaiting_approval", "merge.approved", "merge.denied":
      guard let runId else { return }
      let key = d["id"]?.string ?? e.entity
      let (st, text): (StepStatus, String) = switch e.type {
        case "merge.started": (.running, "Merging")
        case "merge.succeeded": (.done, "Merged")
        case "merge.failed": (.failed, "Merge failed")
        case "merge.approval_requested", "merge.awaiting_approval": (.waiting, "Waiting for merge approval")
        case "merge.approved": (.running, "Merge approved")
        default: (.failed, "Merge denied")
      }
      let line = Self.branchLine(kind: "merge", subject: d)
      upsertStep(runId: runId, Step(id: "merge:\(key)", seq: e.seq, epochMs: e.epochMs, agentId: agentId, kind: .git, phase: .ship,
                                    text: line.map { "\(text) \($0)" } ?? text, detail: d["reason"]?.string.map(UntrustedText.init), status: st))
    case "approval.requested":
      guard let id = d["approvalId"]?.string else { return }
      let rid = d["requestedBy"]?["runId"]?.string ?? runId
      let aid = d["requestedBy"]?["agentId"]?.string ?? agentId
      let kind = d["kind"]?.string ?? "custom"
      let q = d["question"]?.string ?? d["summary"]?.string ?? "Approve \(kind)?"
      var subject: [String: JSONValue] = [:]; if case .object(let o)? = d["subject"] { subject = o }
      approvals[id] = PendingApproval(id: id, runId: rid, agentId: aid, kind: kind, question: UntrustedText(q), branchLine: Self.branchLine(kind: kind, subject: subject))
      approvalSeq[id] = e.seq
      if let rid { upsertStep(runId: rid, Step(id: "approval:\(id)", seq: e.seq, epochMs: e.epochMs, agentId: aid, kind: .approval, phase: .ship,
                                               text: "Waiting for approval", detail: UntrustedText(q), status: .waiting)) }
    case "approval.decided":
      guard let id = d["approvalId"]?.string else { return }
      let rid = approvals[id]?.runId ?? runId
      approvals.removeValue(forKey: id)
      let status = d["status"]?.string ?? (d["decision"]?.string == "deny" ? "denied" : "approved")
      if let rid, let i = runs[rid]?.steps.firstIndex(where: { $0.id == "approval:\(id)" }) {
        runs[rid]?.steps[i].status = status == "approved" ? .done : .failed
        runs[rid]?.steps[i].text = status == "approved" ? "Approved" : status.prefix(1).uppercased() + status.dropFirst()
      }
    default: break   // unknown types are ignored (payloads and type set are open)
    }
  }

  func setStatus(_ runId: String?, _ agentId: String?, _ s: AgentStatus, _ e: Envelope) {
    guard let runId, let agentId, runs[runId]?.agents[agentId] != nil else { return }
    runs[runId]?.agents[agentId]?.status = s
    if let i = runs[runId]?.steps.firstIndex(where: { $0.id == "agent:\(agentId)" }) {
      runs[runId]?.steps[i].status = Self.stepStatus(s); runs[runId]?.steps[i].epochMs = e.epochMs
    }
  }
  func upsertStep(runId: String, _ s: Step) {
    if let i = runs[runId]?.steps.firstIndex(where: { $0.id == s.id }) { runs[runId]?.steps[i] = s } else { runs[runId]?.steps.append(s) }
  }
  nonisolated static func stepStatus(_ s: AgentStatus) -> StepStatus {
    switch s { case .running: .running; case .done, .handedOff: .done; case .failed, .cancelled: .failed; case .pending, .paused, .unknown: .queued }
  }
  nonisolated static func phase(_ k: ProfileKind) -> Phase { switch k { case .planner: .plan; case .critic: .ship; default: .build } }
  /// "fix/backfill → main" for merges; host/name for other kinds. Built only from structured subject fields.
  nonisolated static func branchLine(kind: String, subject: [String: JSONValue]) -> String? {
    func str(_ v: JSONValue?) -> String? { v?.string ?? v?["name"]?.string ?? v?["branch"]?.string }
    switch kind {
    case "merge":
      let ref = str(subject["ref"]), target = str(subject["target"])
      if let ref, let target { return UntrustedText("\(ref) → \(target)").plain }
      return (ref ?? target).map { UntrustedText($0).plain }
    case "egress": return subject["host"]?.string.map { UntrustedText($0).plain }
    case "secret": return subject["name"]?.string.map { UntrustedText($0).plain }
    default: return nil
    }
  }

  // MARK: actions
  /// Approve or deny. Retries of the same (approval, decision) reuse one Idempotency-Key, so a lost response
  /// replays the first result instead of deciding twice.
  @discardableResult
  public func decide(_ approvalId: String, _ decision: ApprovalDecision) async -> DecisionState {
    guard var a = approvals[approvalId], let decider else { return .failed("unavailable") }
    if case .decided = a.decision { return a.decision }
    if case .submitting = a.decision { return a.decision }
    let key = a.idempotencyKeys[decision] ?? makeKey()
    a.idempotencyKeys[decision] = key; a.decision = .submitting(decision); approvals[approvalId] = a; changed()
    let result: DecisionState
    do {
      switch try await decider.decide(approvalId: approvalId, decision: decision, idempotencyKey: key) {
      case .decided(let r): result = .decided(status: r.status, by: r.decidedBy?.principal, alreadyDecided: false)
      case .alreadyDecided(let r): result = .decided(status: r?.status ?? "decided", by: r?.decidedBy?.principal, alreadyDecided: true)
      case .idempotencyConflict(let m):
        approvals[approvalId]?.idempotencyKeys[decision] = nil   // key is poisoned; next tap mints a fresh one
        result = .failed(m)
      }
    } catch { result = .failed("Couldn't reach capcomd") }   // key kept for a safe retry
    approvals[approvalId]?.decision = result
    changed()
    return result
  }

  func changed() { onChange?() }
}
