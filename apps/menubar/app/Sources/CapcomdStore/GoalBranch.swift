import Foundation

// Goal branches (capability `runs.goal_branch`): every run the app starts gets a branch of its own, cut from the base
// the person picked; reviewed work lands on it with no approval, and when the planner finishes the run is ready: the
// app shows the branch against its base, what landed and what didn't, and the planner's summary, and the person opens a
// pull request into the base or keeps the branch. These are the wire models and the store's reads and actions; every
// sentence shown about a branch is the daemon's.

/// A pull request opened from a goal branch.
public struct GoalPullRequest: Codable, Sendable, Hashable {
  public var number: Int
  /// Its page on GitHub; nil when the daemon can't tell.
  public var url: String?
  /// "open", "closed" or "merged" (`POST …/pull-request` only).
  public var state: String?
  public init(number: Int, url: String? = nil, state: String? = nil) { self.number = number; self.url = url; self.state = state }
}

/// `Run.goalBranch`: the run's goal branch and where it stands. Nil on a run without one (and from older daemons).
public struct GoalBranchSummary: Codable, Sendable, Hashable {
  public var branch: String
  public var base: String
  /// "working", "ready", "stopped", "pr_opened", "kept"; an unknown state reads as working.
  public var state: String
  public var readyAt: String?
  public var pullRequest: GoalPullRequest?
  public init(branch: String, base: String, state: String = GoalBranchSummary.working, readyAt: String? = nil, pullRequest: GoalPullRequest? = nil) {
    self.branch = branch; self.base = base; self.state = state; self.readyAt = readyAt; self.pullRequest = pullRequest
  }
  public static let working = "working", ready = "ready", stopped = "stopped", prOpened = "pr_opened", kept = "kept"
  /// The planner is done (or stopped) and the person hasn't decided: offer Open PR / Keep the branch.
  public var awaitsDecision: Bool { state == Self.ready || state == Self.stopped }
}

/// A child whose work landed on the goal branch.
public struct GoalLanded: Decodable, Sendable, Hashable, Identifiable {
  public struct Review: Decodable, Sendable, Hashable {
    public var passed: Bool; public var agentId: String?
    /// The reviewer agent's reasons (agent-written).
    public var reasons: [UntrustedText]
    enum CodingKeys: String, CodingKey { case passed, agentId, reasons }
    public init(passed: Bool, agentId: String? = nil, reasons: [String] = []) { self.passed = passed; self.agentId = agentId; self.reasons = reasons.map(UntrustedText.init) }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      passed = try c.decodeIfPresent(Bool.self, forKey: .passed) ?? false; agentId = try c.decodeIfPresent(String.self, forKey: .agentId)
      reasons = (try c.decodeIfPresent([String].self, forKey: .reasons) ?? []).map(UntrustedText.init)
    }
  }
  public var agentId: String; public var parent: String?; public var profile: String?
  /// The first line of its task (agent- or user-written).
  public var task: UntrustedText
  /// Its title (capability agents.title), what a row shows first; nil from older daemons.
  public var title: UntrustedText?
  /// The agents whose work this one carries on (`spawn --continue`); they aren't listed on their own.
  public var continues: [String] = []
  public var branch: String?; public var mergeId: String; public var sha: String?; public var verifyId: String?
  /// The agent that merged it (its lead or the planner).
  public var mergedBy: String?
  /// The project's checks on it; nil when none were recorded.
  public var checksPassed: Bool?
  /// The run's reviewer's verdict; nil when the run has no reviewer.
  public var review: Review?
  public var id: String { agentId }
  enum CodingKeys: String, CodingKey { case agentId, parent, profile, task, title, continues, branch, mergeId, sha, verifyId, mergedBy, checks, review }
  struct Checks: Decodable { var passed: Bool }
  public init(agentId: String, task: String, mergeId: String, branch: String? = nil, profile: String? = nil, checksPassed: Bool? = nil, review: Review? = nil) {
    self.agentId = agentId; self.task = UntrustedText(task); self.mergeId = mergeId; self.branch = branch; self.profile = profile; self.checksPassed = checksPassed; self.review = review
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agentId = try c.decode(String.self, forKey: .agentId); parent = try c.decodeIfPresent(String.self, forKey: .parent)
    profile = try c.decodeIfPresent(String.self, forKey: .profile); task = UntrustedText(try c.decodeIfPresent(String.self, forKey: .task) ?? "")
    title = try c.decodeIfPresent(String.self, forKey: .title).map(UntrustedText.init); continues = try c.decodeIfPresent([String].self, forKey: .continues) ?? []
    branch = try c.decodeIfPresent(String.self, forKey: .branch); mergeId = try c.decodeIfPresent(String.self, forKey: .mergeId) ?? ""
    sha = try c.decodeIfPresent(String.self, forKey: .sha); verifyId = try c.decodeIfPresent(String.self, forKey: .verifyId)
    mergedBy = try c.decodeIfPresent(String.self, forKey: .mergedBy)
    checksPassed = try c.decodeIfPresent(Checks.self, forKey: .checks)?.passed; review = try c.decodeIfPresent(Review.self, forKey: .review)
  }
}

/// A child with work that isn't on the goal branch, and why.
public struct GoalNotLanded: Decodable, Sendable, Hashable, Identifiable {
  public var agentId: String; public var parent: String?; public var profile: String?
  public var task: UntrustedText
  public var title: UntrustedText?
  public var continues: [String] = []
  public var branch: String?; public var status: String
  /// checks_failed, review_failed, merge_failed, denied, awaiting_approval, verifying, not_verified, not_merged, failed,
  /// cancelled, still_working; an unknown one is "not landed" for a reason the app doesn't know (`reasonText`).
  public var reason: String
  /// The failing check's reason, the reviewer's reasons, the agent's error (agent-written).
  public var detail: UntrustedText?
  public var id: String { agentId }
  enum CodingKeys: String, CodingKey { case agentId, parent, profile, task, title, continues, branch, status, reason, detail }
  public init(agentId: String, task: String, reason: String, status: String = "done", detail: String? = nil) {
    self.agentId = agentId; self.task = UntrustedText(task); self.reason = reason; self.status = status; self.detail = detail.map(UntrustedText.init)
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    agentId = try c.decode(String.self, forKey: .agentId); parent = try c.decodeIfPresent(String.self, forKey: .parent)
    profile = try c.decodeIfPresent(String.self, forKey: .profile); task = UntrustedText(try c.decodeIfPresent(String.self, forKey: .task) ?? "")
    title = try c.decodeIfPresent(String.self, forKey: .title).map(UntrustedText.init); continues = try c.decodeIfPresent([String].self, forKey: .continues) ?? []
    branch = try c.decodeIfPresent(String.self, forKey: .branch); status = try c.decodeIfPresent(String.self, forKey: .status) ?? "done"
    reason = try c.decodeIfPresent(String.self, forKey: .reason) ?? "unknown"; detail = try c.decodeIfPresent(String.self, forKey: .detail).map(UntrustedText.init)
  }
  /// The reason in words, for a row ("Its checks failed").
  public var reasonText: String {
    switch reason {
    case "checks_failed": "Its checks failed"
    case "review_failed": "The review didn't pass"
    case "merge_failed": "Its merge failed"
    case "denied": "Its merge was denied"
    case "awaiting_approval": "Waiting for an approval"
    case "verifying": "Still being verified"
    case "not_verified": "Never verified"
    case "not_merged": "Verified, never merged"
    case "failed": "The agent failed"
    case "cancelled": "Cancelled"
    case "still_working": "Still working"
    default: "Not landed"
    }
  }
}

/// The goal branch against its base, as a pull request would show it.
public struct GoalCompare: Decodable, Sendable, Hashable {
  public struct Commit: Decodable, Sendable, Hashable, Identifiable {
    public var sha: String
    /// Agent-written.
    public var subject: UntrustedText
    public var at: String?
    public var id: String { sha }
    enum CodingKeys: String, CodingKey { case sha, subject, at }
    public init(sha: String, subject: String, at: String? = nil) { self.sha = sha; self.subject = UntrustedText(subject); self.at = at }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      sha = try c.decode(String.self, forKey: .sha); subject = UntrustedText(try c.decodeIfPresent(String.self, forKey: .subject) ?? ""); at = try c.decodeIfPresent(String.self, forKey: .at)
    }
  }
  public struct File: Decodable, Sendable, Hashable, Identifiable {
    /// Agent-written paths.
    public var path: UntrustedText; public var oldPath: UntrustedText?
    public var status: String
    /// nil for a binary file.
    public var added: Int?, removed: Int?
    public var id: String { path.plain }
    enum CodingKeys: String, CodingKey { case path, oldPath, status, added, removed }
    public init(path: String, status: String = "modified", added: Int? = nil, removed: Int? = nil) { self.path = UntrustedText(path); self.status = status; self.added = added; self.removed = removed }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      path = UntrustedText(try c.decode(String.self, forKey: .path)); oldPath = try c.decodeIfPresent(String.self, forKey: .oldPath).map(UntrustedText.init)
      status = try c.decodeIfPresent(String.self, forKey: .status) ?? "unknown"; added = try c.decodeIfPresent(Int.self, forKey: .added); removed = try c.decodeIfPresent(Int.self, forKey: .removed)
    }
  }
  public var baseSha: String?, headSha: String?
  /// Commits on the goal branch the base doesn't have; commits on the base since it was cut.
  public var ahead: Int?, behind: Int?
  public var commits: [Commit]
  public var commitsTotal: Int?
  /// The files it changes (the most changed first), their count, and the lines across all of them.
  public var files: [File]
  public var filesTotal: Int?, added: Int?, removed: Int?
  /// Why the branches couldn't be compared (the daemon's words); the rest of the view still holds.
  public var error: String?
  enum CodingKeys: String, CodingKey { case baseSha, headSha, ahead, behind, commits, commitsTotal, files, filesTotal, added, removed, error }
  public init(ahead: Int? = nil, files: [File] = [], filesTotal: Int? = nil, added: Int? = nil, removed: Int? = nil, commits: [Commit] = [], error: String? = nil) {
    self.ahead = ahead; self.files = files; self.filesTotal = filesTotal; self.added = added; self.removed = removed; self.commits = commits; self.commitsTotal = ahead; self.error = error
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    baseSha = try c.decodeIfPresent(String.self, forKey: .baseSha); headSha = try c.decodeIfPresent(String.self, forKey: .headSha)
    ahead = try c.decodeIfPresent(Int.self, forKey: .ahead); behind = try c.decodeIfPresent(Int.self, forKey: .behind)
    commits = try c.decodeIfPresent(Lossy<Commit>.self, forKey: .commits)?.items ?? []; commitsTotal = try c.decodeIfPresent(Int.self, forKey: .commitsTotal)
    files = try c.decodeIfPresent(Lossy<File>.self, forKey: .files)?.items ?? []; filesTotal = try c.decodeIfPresent(Int.self, forKey: .filesTotal)
    added = try c.decodeIfPresent(Int.self, forKey: .added); removed = try c.decodeIfPresent(Int.self, forKey: .removed); error = try c.decodeIfPresent(String.self, forKey: .error)
  }
}

/// `GET /v1/runs/{runId}/goal`: what the planner's column and the run's ready card show.
public struct GoalView: Decodable, Sendable, Hashable {
  public struct OpenPullRequest: Decodable, Sendable, Hashable {
    /// Open PR can be offered now.
    public var available: Bool
    /// Why not, the daemon's sentence that says what to do (not on GitHub: it names the branch; no `gh` login; the
    /// planner still working; nothing landed). Show it in place of the button.
    public var reason: String?
    /// "owner/name" on GitHub.
    public var repo: String?
    /// A stopped run (the planner failed or was cancelled): the daemon's question to ask before opening one with what
    /// landed; then `openPullRequest(runId:stopped: true)`. Nil otherwise (and from older daemons).
    public var confirm: String?
    public init(available: Bool, reason: String? = nil, repo: String? = nil, confirm: String? = nil) { self.available = available; self.reason = reason; self.repo = repo; self.confirm = confirm }
  }
  public struct Decision: Decodable, Sendable, Hashable { public var choice: String; public var by: String; public var at: String? }
  public var runId: String; public var branch: String; public var base: String
  /// As `GoalBranchSummary.state`.
  public var state: String
  /// The run's goal, as typed.
  public var goal: UntrustedText?
  public var readyAt: String?
  public var plannerId: String?
  /// The planner's own summary (agent-written): what the card shows first.
  public var summary: UntrustedText?
  public var compare: GoalCompare
  public var landed: [GoalLanded]
  public var notLanded: [GoalNotLanded]
  public var pullRequest: GoalPullRequest?
  public var openPullRequest: OpenPullRequest
  /// "pull_request" or "keep", once the person chose.
  public var decision: Decision?
  public var awaitsDecision: Bool { state == GoalBranchSummary.ready || state == GoalBranchSummary.stopped }
  enum CodingKeys: String, CodingKey { case runId, branch, base, state, goal, readyAt, plannerId, summary, compare, landed, notLanded, pullRequest, openPullRequest, decision }
  public init(runId: String, branch: String, base: String, state: String = GoalBranchSummary.ready, summary: String? = nil, compare: GoalCompare = GoalCompare(),
              landed: [GoalLanded] = [], notLanded: [GoalNotLanded] = [], pullRequest: GoalPullRequest? = nil, openPullRequest: OpenPullRequest = OpenPullRequest(available: true)) {
    self.runId = runId; self.branch = branch; self.base = base; self.state = state; self.summary = summary.map(UntrustedText.init); self.compare = compare
    self.landed = landed; self.notLanded = notLanded; self.pullRequest = pullRequest; self.openPullRequest = openPullRequest
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    runId = try c.decode(String.self, forKey: .runId); branch = try c.decode(String.self, forKey: .branch); base = try c.decode(String.self, forKey: .base)
    state = try c.decodeIfPresent(String.self, forKey: .state) ?? GoalBranchSummary.working
    goal = try c.decodeIfPresent(String.self, forKey: .goal).map(UntrustedText.init); readyAt = try c.decodeIfPresent(String.self, forKey: .readyAt)
    plannerId = try c.decodeIfPresent(String.self, forKey: .plannerId); summary = try c.decodeIfPresent(String.self, forKey: .summary).map(UntrustedText.init)
    compare = try c.decodeIfPresent(GoalCompare.self, forKey: .compare) ?? GoalCompare()
    landed = try c.decodeIfPresent(Lossy<GoalLanded>.self, forKey: .landed)?.items ?? []
    notLanded = try c.decodeIfPresent(Lossy<GoalNotLanded>.self, forKey: .notLanded)?.items ?? []
    pullRequest = try c.decodeIfPresent(GoalPullRequest.self, forKey: .pullRequest)
    openPullRequest = try c.decodeIfPresent(OpenPullRequest.self, forKey: .openPullRequest) ?? OpenPullRequest(available: false)
    decision = try c.decodeIfPresent(Decision.self, forKey: .decision)
  }
}

/// `GET /v1/projects/branches`: the setup screen's base menu and goal branch field.
public struct ProjectBranches: Decodable, Sendable, Hashable {
  public var path: String; public var root: String?; public var github: String?
  /// "github" (the GitHub API with the person's gh login), "git" (`git ls-remote`), "local" (the checkout's refs; `note` says why).
  public var source: String
  public var note: String?
  /// The repository's default branch as the remote reports it; nil when it doesn't (never a guessed main).
  public var defaultBranch: String?
  public var branches: [String]
  public var projectTarget: String?
  /// What to preselect in the base menu; nil: the person must pick one.
  public var suggestedBase: String?
  /// capcomd/<goal-slug> for the goal sent, never an existing branch; nil without a goal.
  public var suggestedGoalBranch: String?
  /// The daemon's sentence under the goal branch field (or the base menu); nil when fine.
  public var goalBranchProblem: String?, baseProblem: String?
  enum CodingKeys: String, CodingKey { case path, root, github, source, note, defaultBranch, branches, projectTarget, suggestedBase, suggestedGoalBranch, goalBranchProblem, baseProblem }
  public init(path: String, root: String? = nil, source: String = "git", defaultBranch: String? = nil, branches: [String] = [], projectTarget: String? = nil,
              suggestedBase: String? = nil, suggestedGoalBranch: String? = nil, goalBranchProblem: String? = nil, baseProblem: String? = nil) {
    self.path = path; self.root = root; self.source = source; self.defaultBranch = defaultBranch; self.branches = branches; self.projectTarget = projectTarget
    self.suggestedBase = suggestedBase; self.suggestedGoalBranch = suggestedGoalBranch; self.goalBranchProblem = goalBranchProblem; self.baseProblem = baseProblem
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    path = try c.decode(String.self, forKey: .path); root = try c.decodeIfPresent(String.self, forKey: .root); github = try c.decodeIfPresent(String.self, forKey: .github)
    source = try c.decodeIfPresent(String.self, forKey: .source) ?? "local"; note = try c.decodeIfPresent(String.self, forKey: .note)
    defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch); branches = try c.decodeIfPresent([String].self, forKey: .branches) ?? []
    projectTarget = try c.decodeIfPresent(String.self, forKey: .projectTarget); suggestedBase = try c.decodeIfPresent(String.self, forKey: .suggestedBase)
    suggestedGoalBranch = try c.decodeIfPresent(String.self, forKey: .suggestedGoalBranch)
    goalBranchProblem = try c.decodeIfPresent(String.self, forKey: .goalBranchProblem); baseProblem = try c.decodeIfPresent(String.self, forKey: .baseProblem)
  }
}

/// `POST /v1/runs/{runId}/pull-request` 200.
public struct GoalPullRequestResult: Decodable, Sendable, Hashable {
  public var runId: String; public var branch: String; public var base: String
  /// This call opened it; false: it was there already.
  public var created: Bool
  public var pullRequest: GoalPullRequest
  public init(runId: String, branch: String, base: String, created: Bool, pullRequest: GoalPullRequest) {
    self.runId = runId; self.branch = branch; self.base = base; self.created = created; self.pullRequest = pullRequest
  }
}

/// The daemon said no to Open PR or Keep the branch (409 `conflict`, 404 for a run without a goal branch): its sentence.
/// `code` "stopped": the planner stopped before it finished, and the sentence is the question to ask the person.
public struct GoalActionRefused: Error, Sendable, Hashable {
  public var message: String; public var code: String?
  public init(_ m: String, code: String? = nil) { message = m; self.code = code }
  public static let stopped = "stopped"
}

/// Goal branch reads and actions (capability `runs.goal_branch`). Reads need `read`; the two actions need `steer` and an
/// Idempotency-Key. Throws `GoalActionRefused`, `Unauthorized`, or `DetailUnavailable` (`.unsupported` on daemons
/// without the routes).
public protocol GoalBranchActing: Sendable {
  func goal(runId: String) async throws -> GoalView
  /// `stopped`: the person agreed to open one for a run whose planner stopped (`{"stopped": true}`).
  func openPullRequest(runId: String, stopped: Bool, idempotencyKey: String) async throws -> GoalPullRequestResult
  func keepBranch(runId: String, idempotencyKey: String) async throws
  /// `GET /v1/projects/branches`: nil fields aren't sent.
  func projectBranches(path: String, goal: String?, goalBranch: String?, base: String?) async throws -> ProjectBranches
}

public enum GoalWire {
  public static func view(_ data: Data) throws -> GoalView { try JSONDecoder().decode(GoalView.self, from: data) }
  public static func branches(_ data: Data) throws -> ProjectBranches { try JSONDecoder().decode(ProjectBranches.self, from: data) }
  public static func pullRequest(_ data: Data) throws -> GoalPullRequestResult { try JSONDecoder().decode(GoalPullRequestResult.self, from: data) }
  /// The query of `GET /v1/projects/branches`.
  public static func branchesQuery(path: String, goal: String?, goalBranch: String?, base: String?) -> String {
    var c = URLComponents(); c.queryItems = [URLQueryItem(name: "path", value: path)]
    for (k, v) in [("goal", goal), ("goalBranch", goalBranch), ("base", base)] { if let v { c.queryItems!.append(URLQueryItem(name: k, value: v)) } }
    // `+` and `&` inside values must not read as separators.
    return (c.percentEncodedQuery ?? "").replacingOccurrences(of: "+", with: "%2B")
  }
}

/// Open PR or Keep the branch for one run: on its way, done, or refused / failed with the sentence to show.
/// `confirmStopped`: the planner stopped before it finished; ask the person the daemon's question before opening one.
public enum GoalActionState: Sendable, Hashable {
  case idle, openingPullRequest, keeping
  case confirmStopped(String)
  case opened(GoalPullRequestResult)
  case kept
  case refused(String)
  case failed(String)
}

extension CapcomdStore {
  public static let goalBranchNeedsUpdate = "Update capcomd to use goal branches."
  /// The daemon has goal branches (`runs.goal_branch`).
  public var goalBranchSupported: Bool { capabilities.contains(Capability.runsGoalBranch) }

  /// Reads the run's goal view (`GET /v1/runs/{runId}/goal`) into `goalViews`. The store refetches an open run's view
  /// on run.goal_completed, run.pr_opened and run.branch_kept; call it when the planner's column or the ready card shows.
  public func loadGoal(runId: String) async {
    await ensureCapabilities()
    guard let goalActor, goalBranchSupported else { goalViews[runId] = .unavailable(.unsupported); changed(); return }
    if goalViews[runId]?.value == nil { goalViews[runId] = .loading; changed() }
    do { goalViews[runId] = .loaded(try await goalActor.goal(runId: runId)) }
    catch is Unauthorized { unauthorized = true; goalViews[runId] = .unavailable(.failed(Self.tokenRejected)) }
    catch let e as DetailUnavailable { goalViews[runId] = .unavailable(e) }
    catch let e as GoalActionRefused { goalViews[runId] = .unavailable(.failed(e.message)) }
    catch { goalViews[runId] = .unavailable(.failed("Couldn't reach capcomd")) }
    changed()
  }

  /// Opens the pull request from the run's goal branch into its base (one Idempotency-Key per tap, reused on a retry
  /// after a transport failure). `goalActions[runId]` is `.opened` with it (also when it was open already), `.refused`
  /// with the daemon's sentence, or `.failed`. The run's `goalBranch` follows from run.pr_opened. A run whose planner
  /// stopped is `.confirmStopped` with the daemon's question until it's asked again with `stopped` (the person said yes).
  @discardableResult
  public func openPullRequest(runId: String, stopped: Bool = false) async -> GoalActionState {
    await ensureCapabilities()
    guard let goalActor, goalBranchSupported else { goalActions[runId] = .failed(Self.goalBranchNeedsUpdate); changed(); return goalActions[runId]! }
    if goalActions[runId] == .openingPullRequest { return .openingPullRequest }
    // Its own key with the person's yes: that's another request to the daemon.
    let slot = "pr:\(runId)" + (stopped ? ":stopped" : "")
    let key = pendingGoalKeys[slot] ?? makeKey()
    pendingGoalKeys[slot] = key
    goalActions[runId] = .openingPullRequest; changed()
    let next: GoalActionState
    do {
      let r = try await goalActor.openPullRequest(runId: runId, stopped: stopped, idempotencyKey: key)
      pendingGoalKeys[slot] = nil; next = .opened(r)
      updateGoalBranch(runId) { $0?.state = GoalBranchSummary.prOpened; $0?.pullRequest = r.pullRequest }
    } catch let e as GoalActionRefused {
      pendingGoalKeys[slot] = nil; next = e.code == GoalActionRefused.stopped && !stopped ? .confirmStopped(e.message) : .refused(e.message)
    }
    catch is Unauthorized { unauthorized = true; next = .failed(Self.tokenRejected) }
    catch DetailUnavailable.unsupported { pendingGoalKeys[slot] = nil; next = .failed(Self.goalBranchNeedsUpdate) }
    catch { next = .failed("Couldn't reach capcomd") }   // key kept: a retry replays instead of asking twice
    goalActions[runId] = next; changed()
    if case .opened = next, goalViews[runId] != nil { await loadGoal(runId: runId) }
    return next
  }

  /// Asks the person the daemon's question about a stopped run (from the goal view, before any call), or puts it away
  /// (Cancel): the card shows it until they answer.
  public func askToOpenStoppedPullRequest(runId: String, question: String) { goalActions[runId] = .confirmStopped(question); changed() }
  public func cancelGoalAction(runId: String) { if goalActions[runId] != .openingPullRequest && goalActions[runId] != .keeping { goalActions[runId] = .idle; changed() } }

  /// Keeps the goal branch without a pull request, so the app stops asking.
  @discardableResult
  public func keepBranch(runId: String) async -> GoalActionState {
    await ensureCapabilities()
    guard let goalActor, goalBranchSupported else { goalActions[runId] = .failed(Self.goalBranchNeedsUpdate); changed(); return goalActions[runId]! }
    if goalActions[runId] == .keeping { return .keeping }
    let key = pendingGoalKeys["keep:\(runId)"] ?? makeKey()
    pendingGoalKeys["keep:\(runId)"] = key
    goalActions[runId] = .keeping; changed()
    let next: GoalActionState
    do {
      try await goalActor.keepBranch(runId: runId, idempotencyKey: key)
      pendingGoalKeys["keep:\(runId)"] = nil; next = .kept; updateGoalBranch(runId) { $0?.state = GoalBranchSummary.kept }
    } catch let e as GoalActionRefused { pendingGoalKeys["keep:\(runId)"] = nil; next = .refused(e.message) }
    catch is Unauthorized { unauthorized = true; next = .failed(Self.tokenRejected) }
    catch DetailUnavailable.unsupported { pendingGoalKeys["keep:\(runId)"] = nil; next = .failed(Self.goalBranchNeedsUpdate) }
    catch { next = .failed("Couldn't reach capcomd") }
    goalActions[runId] = next; changed()
    return next
  }

  /// Reads the setup screen's branches for a project checkout (`GET /v1/projects/branches`) into `projectBranches`:
  /// the base menu, what to preselect, the suggested goal branch for `goal`, and the daemon's checks of a typed
  /// `goalBranch` / `base`. An answer to an older question than the latest asked is dropped (and nil returned); else it is
  /// returned too, for the setup screen to file against what it asked.
  @discardableResult
  public func loadProjectBranches(path: String, goal: String? = nil, goalBranch: String? = nil, base: String? = nil) async -> Fetched<ProjectBranches>? {
    await ensureCapabilities()
    guard let goalActor, goalBranchSupported else { projectBranches = .unavailable(.unsupported); changed(); return projectBranches }
    let ask = [path, goal ?? "", goalBranch ?? "", base ?? ""].joined(separator: "\u{0}")
    branchesAsked = ask
    if projectBranches?.value?.path != path { projectBranches = .loading; changed() }
    let next: Fetched<ProjectBranches>
    do { next = .loaded(try await goalActor.projectBranches(path: path, goal: goal, goalBranch: goalBranch, base: base)) }
    catch is Unauthorized { unauthorized = true; next = .unavailable(.failed(Self.tokenRejected)) }
    catch let e as DetailUnavailable { next = .unavailable(e) }
    catch { next = .unavailable(.failed("Couldn't read the repository's branches just now")) }
    guard branchesAsked == ask else { return nil }
    projectBranches = next; changed()
    return next
  }

  /// run.goal_completed / run.pr_opened / run.branch_kept: the run's goal branch moves on, and an open goal view is read again.
  func applyGoalEvent(_ e: Envelope, runId: String) {
    let d = e.data
    var g = runs[runId]?.goalBranch ?? GoalBranchSummary(branch: d["branch"]?.string ?? "", base: d["base"]?.string ?? "")
    switch e.type {
    case "run.goal_completed": if g.state == GoalBranchSummary.working || g.state == GoalBranchSummary.stopped { g.state = GoalBranchSummary.ready }; g.readyAt = g.readyAt ?? ISO8601DateFormatter().string(from: Date(timeIntervalSince1970: Double(e.epochMs) / 1000))
    case "run.pr_opened": g.state = GoalBranchSummary.prOpened; g.pullRequest = d["number"]?.int.map { GoalPullRequest(number: $0, url: d["url"]?.string) } ?? g.pullRequest
    case "run.branch_kept": if g.state != GoalBranchSummary.prOpened { g.state = GoalBranchSummary.kept }
    default: return
    }
    updateGoalBranch(runId) { $0 = g }
    if goalViews[runId] != nil { Task { await self.loadGoal(runId: runId) } }
  }
}
