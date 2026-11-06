import Foundation

// The run setup's goal branch (capability `runs.goal_branch`): under the goal in the composer, the branch the run's
// work lands on and the base it's cut from. The base menu lists the repository's branches with the daemon's
// suggestion preselected (the project's target, else the remote's default branch); when the daemon knows none, nothing
// is selected and Start waits for a pick: never a guessed main. The goal branch follows the daemon's suggestion for the
// goal until the person types in it. `GoalBranchSetup` holds those choices and what the daemon last said; the view
// only draws it and asks `query` (debounced) whenever it changes.

/// A sentence under a field: orange when it's something to fix, dimmed when it only informs.
public struct GoalSetupLine: Sendable, Hashable {
  public var text: String; public var warn: Bool
  public init(_ text: String, warn: Bool) { self.text = text; self.warn = warn }
}

public struct GoalBranchSetup: Sendable, Hashable {
  /// `GET /v1/projects/branches`'s question: nil fields aren't sent.
  public struct Query: Sendable, Hashable {
    public var path: String; public var goal: String?; public var goalBranch: String?; public var base: String?
    public init(path: String, goal: String? = nil, goalBranch: String? = nil, base: String? = nil) { self.path = path; self.goal = goal; self.goalBranch = goalBranch; self.base = base }
  }

  public static let pickBase = "Pick the branch this work starts from"

  /// The project checkout the run starts in; nil: no setup (the daemon's default project, or an older daemon).
  public private(set) var path: String?
  public private(set) var goal = ""
  /// The base the person picked; nil: the daemon's suggestion.
  public private(set) var pickedBase: String?
  /// The goal branch as typed; nil: the daemon's suggestion. An emptied field stays empty and shows the suggestion as
  /// its placeholder (Start then lets the daemon name it).
  public private(set) var typedBranch: String?
  /// The daemon's latest answer, and the question it answered (its problems are about that question's names).
  public private(set) var answer: ProjectBranches?
  public private(set) var answered: Query?
  /// The branches couldn't be read (the daemon's or the app's sentence); Start is left to the daemon then.
  public private(set) var failure: String?

  public init() {}

  /// The setup is for `path` (nil: none). Another checkout starts over; the same one keeps the person's choices.
  public mutating func open(path p: String?) {
    guard p != path else { return }
    self = GoalBranchSetup(); path = p
  }
  public mutating func setGoal(_ g: String) { goal = g }
  public mutating func pickBase(_ b: String) { pickedBase = b }
  public mutating func typeBranch(_ t: String) { typedBranch = t.trimmingCharacters(in: .whitespaces) }

  /// What to ask the daemon now. A typed name is checked against the base it would be cut from, and a picked base is
  /// checked too; otherwise only the goal goes, so the daemon suggests both.
  public var query: Query? {
    guard let path else { return nil }
    let g = goal.trimmingCharacters(in: .whitespacesAndNewlines)
    let typed = typedBranch.flatMap { $0.isEmpty ? nil : $0 }
    return Query(path: path, goal: g.isEmpty ? nil : g, goalBranch: typed, base: pickedBase ?? (typed != nil ? base : nil))
  }

  /// The daemon answered `q` (or reading failed). An answer about another checkout is dropped.
  public mutating func receive(_ f: Fetched<ProjectBranches>, for q: Query) {
    guard q.path == path else { return }
    switch f {
    case .loaded(let a): answer = a; answered = q; failure = nil
    case .unavailable(.failed(let why)): failure = why
    case .unavailable(.unsupported): failure = nil; answer = nil
    case .loading: break
    }
  }

  /// The first answer for this checkout hasn't come yet: ask at once rather than after the debounce.
  public var awaitingFirstAnswer: Bool { answer == nil && failure == nil }

  /// The base the run starts from: the person's pick, else the daemon's suggestion; nil: they must pick.
  public var base: String? { pickedBase ?? answer?.suggestedBase }
  /// The base menu: the repository's branches, with a picked one the daemon didn't list (it says what's wrong with it).
  public var branches: [String] {
    let b = answer?.branches ?? []
    if let p = pickedBase, !b.contains(p) { return [p] + b }
    return b
  }
  /// The goal branch field's text: as typed, else the suggestion for the goal (empty without a goal yet).
  public var goalBranch: String { typedBranch ?? answer?.suggestedGoalBranch ?? "" }
  public var followsSuggestion: Bool { typedBranch == nil }
  /// The field's placeholder: the suggestion (what Start gets with the field empty), else a hint at the shape.
  public var placeholder: String { answer?.suggestedGoalBranch ?? "capcomd/…" }

  /// The daemon's sentence about the typed name, while it's still the name in the field.
  var branchProblem: String? {
    guard let t = typedBranch, !t.isEmpty, answered?.goalBranch == t, answered?.base == query?.base else { return nil }
    return answer?.goalBranchProblem
  }
  var baseProblem: String? {
    guard let b = pickedBase, answered?.base == b else { return nil }
    return answer?.baseProblem
  }

  /// Under the base menu: the refusal of the last Start when it was about the base, else the daemon's sentence about the
  /// picked base, else "Pick the branch this work starts from" when nothing can be preselected.
  public func baseLine(refusedField: String?, refusal: String?) -> GoalSetupLine? {
    if refusedField == "base", let r = refusal { return GoalSetupLine(r, warn: true) }
    if let p = baseProblem { return GoalSetupLine(p, warn: true) }
    if answer != nil, base == nil { return GoalSetupLine(Self.pickBase, warn: true) }
    return nil
  }
  /// Under the goal branch field: the refusal of the last Start when it was about the name, else the daemon's sentence.
  public func branchLine(refusedField: String?, refusal: String?) -> GoalSetupLine? {
    if refusedField == "goalBranch", let r = refusal { return GoalSetupLine(r, warn: true) }
    return branchProblem.map { GoalSetupLine($0, warn: true) }
  }
  /// Where the branches came from when the forge's service didn't answer (`git` or `local`: the daemon's note), or why
  /// they couldn't be read: dimmed. Any other source is the forge's name (github, or a forge plugin's own): no note.
  public var note: GoalSetupLine? {
    if let f = failure { return GoalSetupLine(f, warn: false) }
    guard let a = answer, a.source == "git" || a.source == "local", let n = a.note else { return nil }
    return GoalSetupLine(n, warn: false)
  }

  /// Start can go: a base is chosen and neither name has a known problem. Without an answer (still reading, or reading
  /// failed) the base is the daemon's call; while the first read is out it waits, so nothing starts on a guess.
  public var canStart: Bool {
    if failure != nil && answer == nil { return true }
    return base != nil && branchProblem == nil && baseProblem == nil
  }

  /// What Start sends: the base and the goal branch as shown (nil: the daemon picks; it refuses with field base when it
  /// can't tell).
  public var choice: (base: String?, goalBranch: String?) {
    let b = goalBranch
    return (base, b.isEmpty ? nil : b)
  }
}
