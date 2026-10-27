import Foundation
import CapcomdThread

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
  /// Resume cursor per subscription key: the last SSE `id:` seen (shared-seq groups carry it on the last frame only).
  public private(set) var cursor: [String: Int] = [:]
  /// Frames dropped because their envelope id was already applied (a resumed group re-sends earlier members).
  public private(set) var duplicatesDropped = 0
  /// The daemon rejected the token (401 on a stream or a decision). The app reopens the token prompt.
  public internal(set) var unauthorized = false
  /// Live lifecycle events worth a notification (approval requested, run completed/failed). Never fired for snapshots.
  public var onNotify: (@MainActor (Notice) -> Void)?
  public internal(set) var threads: [String: [ThreadItem]] = [:]
  /// Structured thread items per agent (harness #59; StoreThreadItems.swift), the route's cursor, and whether it works.
  public internal(set) var books: [String: Book] = [:]
  var threadCursor: [String: Int] = [:]
  public internal(set) var threadUnavailable: [String: DetailUnavailable] = [:]
  public internal(set) var media: [MediaKey: Fetched<Data>] = [:]
  /// The run whose lifecycle feed carries `thread=1` (the open thread's run), and the agent shown.
  public internal(set) var threadStreamRun: String?
  public internal(set) var openThreadAgent: String?
  public let prefs: UIPreferences
  public var onChange: (@MainActor () -> Void)?

  // Run detail (drill-down): fetched over REST while a run is open; see StoreDetail.swift.
  public internal(set) var traces: [String: Fetched<[TraceSpan]>] = [:]
  public internal(set) var files: [String: Fetched<RunFiles>] = [:]
  /// Log tail per agent (newest last, at most `logTail` lines), the transcript cursor, and whether the route works.
  public internal(set) var logs: [String: [LogLine]] = [:]
  public internal(set) var logUnavailable: [String: DetailUnavailable] = [:]
  var logCursor: [String: Int] = [:]
  public internal(set) var controlState: [String: ControlState] = [:]
  /// Pause / resume of one agent (and its subtree), keyed by agent id; settles on agent.paused / agent.resumed.
  public internal(set) var agentControlState: [String: ControlState] = [:]
  public internal(set) var startState: StartState = .idle
  /// Steers typed in a thread, per agent, until confirmed (StoreThread.swift).
  public internal(set) var outbox: [String: [PendingSteer]] = [:]
  public internal(set) var capabilities: Set<String> = []
  public internal(set) var skills: Fetched<[SkillInfo]>?
  /// Who can drive a new run and where it can run (`runs.options`); empty when the daemon can't be asked.
  public internal(set) var runOptions = RunOptions()
  var pendingStartKey: (goal: String, choice: RunChoice, key: String)?

  let subscriber: StreamSubscribing?
  let decider: ApprovalDeciding?
  let detail: RunDetailFetching?
  let controls: RunControlling?
  let starter: RunStarting?
  let messenger: AgentMessaging?
  let daemonInfo: DaemonInfoFetching?
  let threadSource: ThreadFetching?
  let clientId: String
  var subs: [String: SubscriptionHandle] = [:]
  var pendingReset: [String: ResetBuffer] = [:]
  /// Envelope ids already applied per key (id → seq). Dedupe is by id, not seq: a group shares one seq.
  var seen: [String: [String: Int]] = [:]
  /// Events at or below the last snapshot's seq are already folded into it.
  var floor: [String: Int] = [:]
  var approvalSeq: [String: Int] = [:]
  var keyCounter = 0
  let makeKey: () -> String

  struct ResetBuffer {
    var snapshotSeq: Int?; var runs: [SnapshotRun] = []; var agents: [SnapshotAgent] = []; var approvals: [SnapshotApproval] = []
    var steps: [Envelope] = []; var messages: [SnapshotMessage] = []
  }
  /// Subscription key for a run's lifecycle feed.
  public nonisolated static func lifecycleKey(_ runId: String) -> String { "lifecycle:\(runId)" }
  nonisolated static func lifecycleRun(_ key: String) -> String? { key.hasPrefix("lifecycle:") ? String(key.dropFirst(10)) : nil }
  /// At most this many runs keep a lifecycle feed open (most recent, not finished).
  public static let maxLifecycleFeeds = 16

  public init(subscriber: StreamSubscribing? = nil, decider: ApprovalDeciding? = nil, detail: RunDetailFetching? = nil, controls: RunControlling? = nil,
              starter: RunStarting? = nil, messenger: AgentMessaging? = nil, daemonInfo: DaemonInfoFetching? = nil, thread: ThreadFetching? = nil,
              prefs: PreferenceStoring = InMemoryPreferences(), clientId: String = "menubar", makeKey: (() -> String)? = nil) {
    self.subscriber = subscriber; self.decider = decider; self.detail = detail; self.controls = controls; self.starter = starter
    self.messenger = messenger; self.daemonInfo = daemonInfo; self.threadSource = thread; self.prefs = UIPreferences(store: prefs); self.clientId = clientId
    self.makeKey = makeKey ?? { "\(clientId)-\(UUID().uuidString.lowercased())" }
  }

  // MARK: derived views
  /// Project cards: running first, then most recent event (SPEC §4.1). The daemon's `projectId` is the repository
  /// (a hash of it), but a card is one goal: runs group by repository and goal, so each goal started from the composer
  /// is its own card and reruns of a goal stay together. A run whose goal hasn't arrived yet joins its repository's
  /// newest card.
  public var projects: [Project] {
    func goalKey(_ r: Run) -> String? { r.goal.map { $0.plain.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() } }
    var newestGoal: [String: (key: String, at: Int)] = [:]
    for r in runs.values { if let g = goalKey(r), let p = r.projectId, r.recencyMs >= (newestGoal[p]?.at ?? .min) { newestGoal[p] = (g, r.recencyMs) } }
    let grouped = Dictionary(grouping: runs.values) { r -> String in
      guard let p = r.projectId else { return r.id }
      guard let g = goalKey(r) ?? newestGoal[p]?.key else { return r.id }
      return "\(p)|\(Self.fnv1a(g))"
    }
    return grouped.map { id, rs in
      let sorted = rs.sorted { ($0.recencyMs, $0.id) > ($1.recencyMs, $1.id) }
      return Project(id: id, goal: sorted.first(where: { $0.goal != nil })?.goal, runs: sorted)
    }.sorted { ($0.isActive ? 1 : 0, $0.recencyMs, $0.id) > ($1.isActive ? 1 : 0, $1.recencyMs, $1.id) }
  }
  /// A short, stable hash for card ids (the goal can be 16 KB).
  static func fnv1a(_ s: String) -> String {
    var h: UInt64 = 0xcbf2_9ce4_8422_2325
    for b in s.utf8 { h ^= UInt64(b); h &*= 0x0000_0100_0000_01b3 }
    return String(h, radix: 36)
  }
  /// Undecided approvals in request order.
  public var pendingApprovals: [PendingApproval] {
    approvals.values.sorted { (approvalSeq[$0.id] ?? 0, $0.id) < (approvalSeq[$1.id] ?? 0, $1.id) }
  }
  /// The one allowed number: the menu bar badge.
  public var badgeCount: Int { approvals.values.filter { if case .decided = $0.decision { return false }; return true }.count }
  public func approvals(forRun id: String) -> [PendingApproval] { pendingApprovals.filter { $0.runId == id } }
  /// Activity rows. An agent's row reads as its activity line ("Read 4 files", "Writing parquet shards to R2") with the
  /// activity's icon when the daemon reports one; otherwise its task's first line, else its profile.
  public func steps(forRun id: String) -> [Step] {
    guard let run = runs[id] else { return [] }
    return run.steps.map { s in
      guard s.kind == .agent, let aid = s.agentId, let a = run.agents[aid] else { return s }
      var s = s
      if let act = a.activity { s.text = act; s.kind = StepKind(activityKind: a.activityKind) }
      else if let t = a.task?.firstLine, !t.isEmpty { s.text = t }
      return s
    }
  }

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
        var node = AgentNode(id: a.id, name: a.displayName, suffix: suffixes[a.id], kind: a.kind, status: a.status, activity: a.activity, depth: depth,
                             waiting: w, descendantWaiting: children.contains { $0.waiting || $0.descendantWaiting }, children: children)
        node.repo = a.repo
        return node
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

  /// Badge and notifications come from each run's lifecycle feed (`?feed=lifecycle`): one per known, unfinished run.
  func syncLifecycleFeeds() {
    guard subscriber != nil, subs["daemon"] != nil else { return }
    // Active runs first: the daemon reports a finished run as `idle`, not a terminal state, so old ones mustn't crowd out new.
    let want = runs.values.filter { !Run.terminalStates.contains($0.state) }
      .sorted { ($0.isActive ? 1 : 0, $0.lastEventMs, $0.id) > ($1.isActive ? 1 : 0, $1.lastEventMs, $1.id) }.prefix(Self.maxLifecycleFeeds).map(\.id)
    for id in want { subscribe(Self.lifecycleKey(id), scope: id, feed: "lifecycle") }   // live activity rides along (Live adds ?activity=1)
  }
  public var activeScopes: [String] { subs.keys.sorted() }

  func subscribe(_ scope: String) { subscribe(scope, scope: scope, feed: nil) }
  func subscribe(_ key: String, scope: String, feed: String?) {
    guard subs[key] == nil, let subscriber else { return }
    let after = cursor[key] ?? 0
    let onFrame: @Sendable (StreamFrame) async -> Void = { [weak self] f in await self?.receive(f, scope: key) }
    let thread = feed != nil && Self.lifecycleRun(key) == threadStreamRun   // the open thread's run: live thread items too
    subs[key] = feed == nil ? subscriber.subscribe(scope: scope, after: after, onFrame: onFrame)
                            : subscriber.subscribe(scope: scope, feed: feed, thread: thread, after: after, onFrame: onFrame)
  }

  // MARK: frames
  public func receive(_ frame: StreamFrame, scope: String) {
    switch frame {
    case .event(let e) where e.durability == "ephemeral":
      apply(e)   // live-only: its seq is the last durable one, so it never touches dedupe or the cursor
    case .event(let e):
      if pendingReset[scope] != nil, let s = pendingReset[scope]?.snapshotSeq, e.seq <= s { return }
      if e.seq <= (floor[scope] ?? 0) { return }                 // already in the snapshot
      if seen[scope]?[e.id] != nil { duplicatesDropped += 1; return }   // dedupe by envelope id (groups share a seq)
      let top = max(lastSeq[scope] ?? 0, e.seq)
      seen[scope, default: [:]][e.id] = e.seq
      if seen[scope]!.count > 512 { seen[scope] = seen[scope]!.filter { $0.value >= top } }  // a resend never goes below the cursor
      lastSeq[scope] = top
      apply(e)
      if Self.lifecycleRun(scope) != nil { notify(e) }
      if scope == "daemon" || e.type == "run.created" { syncLifecycleFeeds() }
    case .cursor(let n):
      cursor[scope] = n; return
    case .unauthorized:
      unauthorized = true
    case .snapshotSteps(let st): pendingReset[scope, default: ResetBuffer()].steps += st; return
    case .snapshotThreads(let m): pendingReset[scope, default: ResetBuffer()].messages += m; return
    case .reset(let s, _):
      pendingReset[scope] = ResetBuffer(snapshotSeq: s)
      return
    case .snapshotRun(let r): pendingReset[scope, default: ResetBuffer()].runs.append(r); return
    case .snapshotAgents(let a): pendingReset[scope, default: ResetBuffer()].agents += a; return
    case .snapshotApprovals(let a): pendingReset[scope, default: ResetBuffer()].approvals += a; return
    case .snapshotEnd(let s):
      let buf = pendingReset.removeValue(forKey: scope) ?? ResetBuffer()
      if let rid = Self.lifecycleRun(scope) { mergeLifecycle(runId: rid, key: scope, from: buf, snapshotSeq: s) }
      else { rebuild(scope: scope, from: buf, snapshotSeq: s) }
      floor[scope] = s; seen[scope] = [:]; cursor[scope] = max(cursor[scope] ?? 0, s)
      if scope == "daemon" { syncLifecycleFeeds() }
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
      run.startedAtMs = run.startedAtMs ?? epochMs(iso: r.createdAt)
      runs[r.id] = run
    }
    let agentRuns = Set(b.agents.map(\.runId)).union(b.steps.compactMap { $0.runId ?? ($0.scope.hasPrefix("run-") ? $0.scope : nil) })
    for rid in agentRuns {
      runs[rid]?.agents.keys.forEach { threads.removeValue(forKey: $0) }
      runs[rid, default: Run(id: rid, projectId: nil, label: nil, goal: nil, state: "running", startedAtMs: nil, lastEventMs: 0)].agents = [:]
      runs[rid]?.steps = []; runs[rid]?.lifecycle = []
    }
    // Activity: replay snapshot.steps (real step history, oldest first) through the reducer.
    let state = Dictionary(b.runs.map { ($0.id, $0.state) }, uniquingKeysWith: { $1 })
    for e in b.steps.sorted(by: { $0.seq < $1.seq }) { apply(e) }
    for (rid, st) in state { runs[rid]?.state = st }          // the snapshot's state wins over replayed transitions
    // Agents: the snapshot is authoritative for status/text/task; replay supplies key/repo/spawn order.
    for (i, a) in b.agents.enumerated() {
      let old = runs[a.runId]?.agents[a.id]
      var ag = Agent(id: a.id, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: AgentStatus(wire: a.status),
                     task: a.task.map(UntrustedText.init), key: old?.key, repo: a.workspace?.label ?? old?.repo, spawnedAtMs: old?.spawnedAtMs ?? i, activity: a.activity?.text)
      ag.taskAttachment = AttachmentRef(a.taskAttachment); ag.updatedAtMs = epochMs(iso: a.updatedAt) ?? old?.updatedAtMs
      ag.activityKind = a.activity?.kind
      ag.resultSummary = (a.result?["summary"]?.string).map(UntrustedText.init) ?? old?.resultSummary
      ag.provider = Provider(wire: a.provider) ?? old?.provider; ag.model = a.model ?? old?.model
      runs[a.runId]?.agents[a.id] = ag
      if let j = runs[a.runId]?.steps.firstIndex(where: { $0.id == "agent:\(a.id)" }) { runs[a.runId]?.steps[j].status = Self.stepStatus(ag.status) }
    }
    // Replayed approval.requested may be stale; snapshot.approvals is the pending set.
    for (id, a) in approvals where a.runId.map(agentRuns.contains) ?? false { approvals.removeValue(forKey: id) }
    for m in b.messages { appendMessage(m) }
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
      if let l = d["label"]?.string { runs[runId]?.label = l }
    case "run.started", "run.paused", "run.resumed", "run.completed", "run.failed", "run.cancelled", "run.deleted":
      guard let runId else { return }
      let t = RunTransition(type: e.type, cause: d["cause"]?.string, agentId: d["agentId"]?.string ?? e.agentId, seq: e.seq, epochMs: e.epochMs)
      runs[runId]?.state = t.state; runs[runId]?.lifecycle.append(t)
      settleControl(runId: runId)
      if e.type == "run.deleted" {
        runs[runId]?.agents.keys.forEach { threads.removeValue(forKey: $0) }
        runs.removeValue(forKey: runId)
        for (id, a) in approvals where a.runId == runId { approvals.removeValue(forKey: id) }
        subs.removeValue(forKey: Self.lifecycleKey(runId))?.cancel()
      }
    case "run.new":
      guard let runId else { return }
      runs[runId]?.label = d["label"]?.string
    case "agent.spawned":
      guard let runId, let id = agentId ?? Optional(e.entity) else { return }
      let parent = d["parent"]?.string
      let profile = d["profile"]?.string ?? d["profile"]?["name"]?.string ?? d["agent"]?["profile"]?.string
      let depth = d["depth"]?.int ?? parent.flatMap { runs[runId]?.agents[$0].map { $0.depth + 1 } } ?? 0
      var a = Agent(id: id, runId: runId, parent: parent, depth: depth, profile: profile, status: .pending,
                    task: d["task"]?.string.map(UntrustedText.init), key: d["key"]?.string,
                    repo: d["workspace"]?["label"]?.string ?? d["repo"]?.string ?? d["agent"]?["repo"]?.string, spawnedAtMs: e.epochMs)
      a.taskAttachment = AttachmentRef(d["taskAttachment"])
      a.provider = Provider(wire: d["agent"]?["provider"]?.string ?? d["agent"]?["kind"]?.string)
      a.model = d["agent"]?["model"]?.string
      runs[runId]?.agents[id] = a
      upsertStep(runId: runId, Step(id: "agent:\(id)", seq: e.seq, epochMs: e.epochMs, agentId: id, kind: .agent,
                                    phase: Self.phase(a.kind), text: a.displayName, detail: a.task, status: .queued))
    case "agent.started", "agent.resumed": setStatus(runId, agentId, .running, e)
    case "agent.status_changed", "agent.status": setStatus(runId, agentId, AgentStatus(wire: d["status"]?.string), e)
    case "agent.done":
      setStatus(runId, agentId, .done, e)
      if let runId, let agentId, let sum = d["result"]?["summary"]?.string { runs[runId]?.agents[agentId]?.resultSummary = UntrustedText(sum) }
    case "agent.failed", "drive.failed": setStatus(runId, agentId, .failed, e)
    case "agent.cancelled", "agent.reaped": setStatus(runId, agentId, .cancelled, e)
    case "agent.paused": setStatus(runId, agentId, .paused, e)
    case "agent.thread_item_changed": applyThreadFrame(runId: runId, agentId: agentId, d)
    case "agent.activity_changed":
      guard let runId, let agentId, runs[runId]?.agents[agentId] != nil else { return }
      runs[runId]?.agents[agentId]?.activity = d["activity"]?["text"]?.string
      runs[runId]?.agents[agentId]?.activityKind = d["activity"]?["kind"]?.string
      if let st = d["status"]?.string { runs[runId]?.agents[agentId]?.status = AgentStatus(wire: st) }
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

  func notify(_ e: Envelope) {
    guard let onNotify else { return }
    switch e.type {
    case "approval.requested":
      guard let id = e.data["approvalId"]?.string, let a = approvals[id] else { return }
      onNotify(.approvalRequested(approvalId: id, runId: a.runId, question: a.question))
    case "run.completed", "run.failed":
      guard let rid = e.runId ?? e.data["runId"]?.string else { return }
      onNotify(.runFinished(runId: rid, type: e.type, title: runs[rid]?.title ?? rid))
    default: return
    }
  }

  /// Lifecycle feed snapshot: run state, agent statuses and pending approvals for one run. Leaves Activity alone
  /// (the run stream owns it when open).
  func mergeLifecycle(runId: String, key: String, from b: ResetBuffer, snapshotSeq: Int) {
    for r in b.runs {
      var run = runs[r.id] ?? Run(id: r.id, projectId: r.projectId, label: r.label, goal: nil, state: r.state, startedAtMs: nil, lastEventMs: 0)
      run.projectId = r.projectId ?? run.projectId; run.label = r.label ?? run.label; run.state = r.state
      if let g = r.goal { run.goal = UntrustedText(g) }
      run.startedAtMs = run.startedAtMs ?? epochMs(iso: r.createdAt)
      runs[r.id] = run
    }
    for (i, a) in b.agents.enumerated() where runs[a.runId] != nil {
      if var old = runs[a.runId]?.agents[a.id] {
        old.status = AgentStatus(wire: a.status); old.activity = a.activity?.text; old.activityKind = a.activity?.kind
        if let sum = a.result?["summary"]?.string { old.resultSummary = UntrustedText(sum) }
        old.updatedAtMs = epochMs(iso: a.updatedAt) ?? old.updatedAtMs; old.repo = a.workspace?.label ?? old.repo
        old.provider = Provider(wire: a.provider) ?? old.provider; old.model = a.model ?? old.model
        runs[a.runId]?.agents[a.id] = old
      } else {
        var ag = Agent(id: a.id, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: AgentStatus(wire: a.status),
                       task: a.task.map(UntrustedText.init), key: nil, repo: a.workspace?.label, spawnedAtMs: i, activity: a.activity?.text)
        ag.taskAttachment = AttachmentRef(a.taskAttachment); ag.resultSummary = (a.result?["summary"]?.string).map(UntrustedText.init)
        ag.updatedAtMs = epochMs(iso: a.updatedAt); ag.activityKind = a.activity?.kind
        ag.provider = Provider(wire: a.provider); ag.model = a.model
        runs[a.runId]?.agents[a.id] = ag
      }
    }
    for a in b.approvals where a.status == "pending" && approvals[a.approvalId] == nil {
      approvals[a.approvalId] = PendingApproval(id: a.approvalId, runId: a.requestedBy?.runId ?? runId, agentId: a.requestedBy?.agentId, kind: a.kind,
                                                question: UntrustedText(a.question), branchLine: Self.branchLine(kind: a.kind, subject: a.subject ?? [:]))
      approvalSeq[a.approvalId] = approvalSeq[a.approvalId] ?? snapshotSeq
    }
    lastSeq[key] = snapshotSeq
  }

  func setStatus(_ runId: String?, _ agentId: String?, _ s: AgentStatus, _ e: Envelope) {
    guard let runId, let agentId, runs[runId]?.agents[agentId] != nil else { return }
    runs[runId]?.agents[agentId]?.status = s; runs[runId]?.agents[agentId]?.updatedAtMs = e.epochMs
    settleAgentControl(agentId: agentId, status: s)
    if let i = runs[runId]?.steps.firstIndex(where: { $0.id == "agent:\(agentId)" }) {
      runs[runId]?.steps[i].status = Self.stepStatus(s); runs[runId]?.steps[i].epochMs = e.epochMs
    }
  }
  func upsertStep(runId: String, _ s: Step) {
    if let i = runs[runId]?.steps.firstIndex(where: { $0.id == s.id }) { runs[runId]?.steps[i] = s } else { runs[runId]?.steps.append(s) }
  }
  nonisolated static func stepStatus(_ s: AgentStatus) -> StepStatus {
    switch s { case .running: .running; case .done, .handedOff: .done; case .failed, .cancelled: .failed; case .paused: .paused; case .pending, .unknown: .queued }
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
    } catch is Unauthorized { unauthorized = true; result = .failed("capcomd rejected the token") }
    catch { result = .failed("Couldn't reach capcomd") }   // key kept for a safe retry
    approvals[approvalId]?.decision = result
    changed()
    return result
  }

  func changed() { onChange?() }
}
