import Foundation

// The goal branch's ready card (capability `runs.goal_branch`): docked at the planner's column foot in the desktop
// window, and folded to one line on the menu bar's run. Once the planner is done (or stopped) it shows the branch
// against its base, the planner's summary, the compare line, what landed and what didn't, and Open PR · View diff ·
// Keep branch; after the person chose, the pull request's link or "Kept on <branch>". `GoalCard.make` decides all of it
// from the run's goal branch, its goal view and the last action; the views only draw it.

public struct GoalCard: Sendable, Hashable {
  public enum Phase: Sendable, Hashable {
    /// The planner works: only the branch name shows, quietly, so the person knows where work lands.
    case working
    /// Ready or stopped, and nobody chose yet: the card with its three actions.
    case deciding
    case prOpened, kept
  }
  /// A child's work: its task, and how it was checked (landed) or why it didn't land.
  public struct Row: Sendable, Hashable, Identifiable {
    public var id: String
    /// Agent- or user-written.
    public var task: UntrustedText
    /// "checks passed · reviewed", or the reason in words ("Its checks failed").
    public var status: String
    /// Not landed: the failing check's reason, the reviewer's reasons, the agent's error (agent-written).
    public var detail: UntrustedText?
    public var landed: Bool
  }
  public enum OpenPR: Sendable, Hashable {
    case button(busy: Bool)
    /// The daemon's sentence saying why not, in the button's place.
    case unavailable(String)
    case hidden
  }
  /// What a tap on Open PR does: ask the daemon's question first (a stopped run), or open it.
  public enum OpenTap: Sendable, Hashable { case ask(String), open }
  public enum Outcome: Sendable, Hashable {
    case pullRequest(number: Int, url: URL?)
    /// "Kept on capcomd/add-x".
    case kept(String)
    /// The daemon's (or the app's) sentence: Open PR or Keep didn't go through.
    case refused(String)
  }

  public var runId: String, branch: String, base: String
  public var phase: Phase
  /// The planner stopped before it finished (failed or cancelled).
  public var stopped: Bool
  /// "capcomd/add-x → dev".
  public var title: String { "\(branch) → \(base)" }
  /// The planner's own summary (agent-written): first.
  public var summary: UntrustedText?
  /// "3 commits · 2 files · +24 −3", or why the branches couldn't be compared.
  public var compareLine: String?
  public var compareError: String?
  public var landed: [Row], notLanded: [Row]
  public var openPR: OpenPR
  public var openTap: OpenTap
  /// The daemon's question about a stopped run, asked now: the card shows it with Cancel and Open PR.
  public var confirm: String?
  public var keepShown: Bool, keepBusy: Bool
  /// The compare on GitHub; nil when the repository isn't on GitHub (or the view hasn't loaded): the files show inline.
  public var diffURL: URL?
  public var files: [GoalCompare.File]
  public var filesMore: Int
  public var outcome: Outcome?
  /// The goal view is still on its way (the card shows what Run.goalBranch says meanwhile).
  public var loading: Bool
  /// Reading the goal view failed: its sentence.
  public var problem: String?

  /// Rows past this fold behind "Show all".
  public static let rowsFolded = 4
  public static let filesShown = 6
  public var collapsible: Bool { landed.count + notLanded.count > Self.rowsFolded }
  /// The card docks at the column's foot (or unfolds on the menu bar): a decision to make, or a question asked.
  public var docks: Bool { phase == .deciding || confirm != nil }

  public static func make(runId: String, summary g: GoalBranchSummary, view: Fetched<GoalView>?, action: GoalActionState?) -> GoalCard {
    let v = view?.value
    let phase: Phase = switch g.state {
    case GoalBranchSummary.prOpened: .prOpened
    case GoalBranchSummary.kept: .kept
    case GoalBranchSummary.ready, GoalBranchSummary.stopped: .deciding
    default: .working
    }
    let action = action ?? .idle
    var card = GoalCard(runId: runId, branch: g.branch, base: g.base, phase: phase, stopped: g.state == GoalBranchSummary.stopped,
                        summary: v?.summary, compareLine: nil, compareError: nil, landed: [], notLanded: [], openPR: .hidden, openTap: .open,
                        confirm: nil, keepShown: phase == .deciding, keepBusy: action == .keeping, diffURL: nil, files: [], filesMore: 0,
                        outcome: nil, loading: view == nil || view == .loading, problem: nil)
    if case .unavailable(.failed(let why))? = view { card.problem = why }
    if let v {
      let c = v.compare
      if let e = c.error { card.compareError = e } else { card.compareLine = compareLine(c, base: g.base) }
      card.landed = v.landed.map { l in
        let checks = l.checksPassed.map { $0 ? "checks passed" : "checks failed" } ?? "no checks"
        let review = l.review.map { $0.passed ? "reviewed" : "review didn't pass" }
        return Row(id: l.id, task: l.task, status: [checks, review].compactMap { $0 }.joined(separator: " · "), detail: nil, landed: true)
      }
      card.notLanded = v.notLanded.map { Row(id: $0.id, task: $0.task, status: $0.reasonText, detail: $0.detail, landed: false) }
      card.files = Array(c.files.prefix(filesShown))
      card.filesMore = max(0, (c.filesTotal ?? c.files.count) - card.files.count)
      card.diffURL = compareURL(repo: v.openPullRequest.repo, base: g.base, branch: g.branch, pullRequestURL: g.pullRequest?.url ?? v.pullRequest?.url)
      if let q = v.openPullRequest.confirm, card.stopped { card.openTap = .ask(q) }
    }
    // Open PR: while deciding, and after Keep (a pull request can still be opened).
    if phase == .deciding || phase == .kept {
      if let v, !v.openPullRequest.available { card.openPR = .unavailable(v.openPullRequest.reason ?? "A pull request can't be opened right now.") }
      else { card.openPR = .button(busy: action == .openingPullRequest) }
    }
    switch action {
    case .confirmStopped(let q): card.confirm = q
    case .opened(let r): card.outcome = .pullRequest(number: r.pullRequest.number, url: r.pullRequest.url.flatMap(URL.init(string:)))
    case .kept: card.outcome = .kept("Kept on \(g.branch)")
    case .refused(let m), .failed(let m): card.outcome = .refused(m)
    case .idle, .openingPullRequest, .keeping: break
    }
    if card.outcome == nil {
      if phase == .prOpened, let pr = g.pullRequest ?? v?.pullRequest { card.outcome = .pullRequest(number: pr.number, url: pr.url.flatMap(URL.init(string:))) }
      else if phase == .kept { card.outcome = .kept("Kept on \(g.branch)") }
    }
    if phase == .prOpened { card.openPR = .hidden; card.keepShown = false }
    return card
  }

  /// "3 commits · 2 files · +24 −3 · 1 behind dev"; nil when the daemon counted nothing.
  static func compareLine(_ c: GoalCompare, base: String) -> String? {
    var parts: [String] = []
    if let n = c.commitsTotal ?? c.ahead { parts.append("\(n) \(n == 1 ? "commit" : "commits")") }
    if let n = c.filesTotal ?? (c.files.isEmpty ? nil : c.files.count) { parts.append("\(n) \(n == 1 ? "file" : "files")") }
    if c.added != nil || c.removed != nil { parts.append("+\(c.added ?? 0) −\(c.removed ?? 0)") }
    if let b = c.behind, b > 0 { parts.append("\(b) behind \(base)") }
    return parts.isEmpty ? nil : parts.joined(separator: " · ")
  }

  /// The branch against its base on GitHub: `https://github.com/<owner>/<name>/compare/<base>...<branch>`, on the host the
  /// pull request lives on when there is one (GitHub Enterprise). Nil without a GitHub repository.
  public static func compareURL(repo: String?, base: String, branch: String, pullRequestURL: String? = nil) -> URL? {
    guard let repo, case let parts = repo.split(separator: "/"), parts.count == 2 else { return nil }
    let host = pullRequestURL.flatMap { URL(string: $0)?.host } ?? "github.com"
    var allowed = CharacterSet.urlPathAllowed; allowed.remove(charactersIn: "?#%")
    func seg(_ s: Substring) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed.subtracting(CharacterSet(charactersIn: "/"))) ?? String(s) }
    // Branch names keep their slashes (GitHub reads capcomd/add-x as one name in a compare).
    func ref(_ s: String) -> String { s.addingPercentEncoding(withAllowedCharacters: allowed) ?? s }
    return URL(string: "https://\(host)/\(seg(parts[0]))/\(seg(parts[1]))/compare/\(ref(base))...\(ref(branch))")
  }
}

extension CapcomdStore {
  /// The run's goal card, or nil for a run without a goal branch. Reads the goal view once a decision is up (or made).
  public func goalCard(runId: String) -> GoalCard? {
    guard let g = runs[runId]?.goalBranch else { return nil }
    return GoalCard.make(runId: runId, summary: g, view: goalViews[runId], action: goalActions[runId])
  }
}
