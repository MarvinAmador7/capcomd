import XCTest
import Foundation
@testable import CapcomdStore

/// The run setup's goal branch rows and the ready card's model (GoalSetup.swift, GoalCard.swift).
final class GoalSetupTests: XCTestCase {
  func answer(base: String? = "dev", suggested: String? = "capcomd/add-x", problem: String? = nil, baseProblem: String? = nil, source: String = "github", note: String? = nil) -> ProjectBranches {
    var a = ProjectBranches(path: "/src/app", root: "/src/app", source: source, defaultBranch: "main", branches: ["dev", "main"], projectTarget: base,
                            suggestedBase: base, suggestedGoalBranch: suggested, goalBranchProblem: problem, baseProblem: baseProblem)
    a.note = note
    return a
  }

  func testTheGoalBranchFollowsTheSuggestionUntilTyped() {
    var s = GoalBranchSetup(); s.open(path: "/src/app")
    XCTAssertTrue(s.awaitingFirstAnswer)
    s.setGoal("Add x")
    XCTAssertEqual(s.query, .init(path: "/src/app", goal: "Add x"))
    s.receive(.loaded(answer()), for: s.query!)
    XCTAssertEqual(s.goalBranch, "capcomd/add-x"); XCTAssertTrue(s.followsSuggestion)
    // The goal changes: the field follows the new suggestion.
    s.setGoal("Add x and y"); s.receive(.loaded(answer(suggested: "capcomd/add-x-and-y")), for: s.query!)
    XCTAssertEqual(s.goalBranch, "capcomd/add-x-and-y")
    // Typed: it stays, whatever the daemon suggests next; the name is checked against the base.
    s.typeBranch("feature/mine")
    XCTAssertEqual(s.query, .init(path: "/src/app", goal: "Add x and y", goalBranch: "feature/mine", base: "dev"))
    s.setGoal("Something else"); s.receive(.loaded(answer(suggested: "capcomd/something-else")), for: s.query!)
    XCTAssertEqual(s.goalBranch, "feature/mine"); XCTAssertFalse(s.followsSuggestion)
    XCTAssertEqual(s.choice.goalBranch, "feature/mine")
    // Emptied: back to the suggestion.
    s.typeBranch("  ")
    XCTAssertEqual(s.goalBranch, "capcomd/something-else")
  }

  func testNeverMainByItselfAndStartWaitsForAPick() {
    var s = GoalBranchSetup(); s.open(path: "/src/app"); s.setGoal("Add x")
    XCTAssertFalse(s.canStart)                                  // still reading: nothing starts on a guess
    // The remote's default branch is main, but the daemon suggests no base: nothing is picked for the person.
    s.receive(.loaded(answer(base: nil)), for: s.query!)
    XCTAssertNil(s.base)
    XCTAssertFalse(s.canStart)
    XCTAssertEqual(s.baseLine(refusedField: nil, refusal: nil), GoalSetupLine(GoalBranchSetup.pickBase, warn: true))
    XCTAssertEqual(s.choice.base, nil)
    s.pickBase("main")                                          // the person may pick it themselves
    XCTAssertEqual(s.base, "main"); XCTAssertTrue(s.canStart)
    XCTAssertNil(s.baseLine(refusedField: nil, refusal: nil))
    XCTAssertEqual(s.query?.base, "main")
  }

  func testTheDaemonsProblemsShowWhileTheyStillApply() {
    var s = GoalBranchSetup(); s.open(path: "/src/app"); s.setGoal("Add x")
    s.receive(.loaded(answer()), for: s.query!)
    s.typeBranch("dev")
    let why = "The goal branch can't be the base (dev) itself: work lands on the goal branch, and the pull request goes from it into the base."
    s.receive(.loaded(answer(problem: why)), for: s.query!)
    XCTAssertEqual(s.branchLine(refusedField: nil, refusal: nil), GoalSetupLine(why, warn: true))
    XCTAssertFalse(s.canStart)
    // Typing on: the sentence was about the old name, so it goes until the daemon answers again.
    s.typeBranch("dev-2")
    XCTAssertNil(s.branchLine(refusedField: nil, refusal: nil)); XCTAssertTrue(s.canStart)
    // A picked base the daemon doesn't take.
    s.pickBase("nope..x"); s.receive(.loaded(answer(baseProblem: "\"nope..x\" isn't a branch name.")), for: s.query!)
    XCTAssertEqual(s.baseLine(refusedField: nil, refusal: nil)?.text, "\"nope..x\" isn't a branch name.")
    XCTAssertEqual(s.branches.first, "nope..x")
  }

  func testARefusedStartShowsUnderItsField() {
    var s = GoalBranchSetup(); s.open(path: "/src/app"); s.setGoal("Add x"); s.receive(.loaded(answer()), for: s.query!)
    XCTAssertEqual(s.baseLine(refusedField: "base", refusal: "base dev isn't a branch of acme/app"), GoalSetupLine("base dev isn't a branch of acme/app", warn: true))
    XCTAssertNil(s.branchLine(refusedField: "base", refusal: "base dev isn't a branch of acme/app"))
    XCTAssertEqual(s.branchLine(refusedField: "goalBranch", refusal: "capcomd/add-x exists on the remote")?.text, "capcomd/add-x exists on the remote")
    XCTAssertNil(s.baseLine(refusedField: "goalBranch", refusal: "capcomd/add-x exists on the remote"))
  }

  func testTheNoteAndAnotherCheckout() {
    var s = GoalBranchSetup(); s.open(path: "/src/app"); s.setGoal("Add x")
    s.receive(.loaded(answer(source: "git", note: "GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)")), for: s.query!)
    XCTAssertEqual(s.note, GoalSetupLine("GitHub: no login (GITHUB_TOKEN, GH_TOKEN or `gh auth login`)", warn: false))
    s.receive(.loaded(answer(source: "github", note: "ignored")), for: s.query!)
    XCTAssertNil(s.note)
    // An answer about another checkout is dropped; opening another one starts over, the same one keeps the choices.
    s.pickBase("main")
    s.receive(.loaded(answer(base: "other")), for: .init(path: "/src/other"))
    XCTAssertEqual(s.base, "main")
    s.open(path: "/src/app"); XCTAssertEqual(s.base, "main")
    s.open(path: "/src/other"); XCTAssertNil(s.base); XCTAssertTrue(s.awaitingFirstAnswer); XCTAssertEqual(s.goal, "")
    // Reading failed: say so, and leave the base to the daemon.
    s.receive(.unavailable(.failed("Couldn't read the repository's branches just now")), for: .init(path: "/src/other"))
    XCTAssertEqual(s.note?.text, "Couldn't read the repository's branches just now"); XCTAssertTrue(s.canStart)
  }
}

final class GoalCardTests: XCTestCase {
  let summary = GoalBranchSummary(branch: "capcomd/add-x", base: "dev", state: GoalBranchSummary.ready)
  func view(_ mutate: (inout GoalView) -> Void = { _ in }) throws -> GoalView { var v = try GoalWire.view(Data(goalJSON.utf8)); mutate(&v); return v }

  func testWorkingShowsOnlyTheBranch() {
    let c = GoalCard.make(runId: "run-g", summary: GoalBranchSummary(branch: "capcomd/add-x", base: "dev"), view: nil, action: nil)
    XCTAssertEqual(c.phase, .working); XCTAssertFalse(c.docks)
    XCTAssertEqual(c.title, "capcomd/add-x → dev")
    XCTAssertEqual(c.openPR, .hidden); XCTAssertFalse(c.keepShown); XCTAssertNil(c.outcome)
  }

  func testReadyWithItsView() throws {
    let c = GoalCard.make(runId: "run-g", summary: summary, view: .loaded(try view()), action: nil)
    XCTAssertTrue(c.docks); XCTAssertFalse(c.loading)
    XCTAssertEqual(c.summary?.plain, "Added x.\nLeft: docs.")
    XCTAssertEqual(c.compareLine, "2 commits · 1 file · +3 −0")
    XCTAssertEqual(c.landed.map(\.status), ["checks passed · reviewed"])
    XCTAssertEqual(c.notLanded.map(\.status), ["The agent failed", "Not landed"])
    XCTAssertEqual(c.notLanded.first?.detail?.plain, "boom")
    XCTAssertEqual(c.openPR, .button(busy: false)); XCTAssertEqual(c.openTap, .open)
    XCTAssertTrue(c.keepShown)
    XCTAssertEqual(c.diffURL?.absoluteString, "https://github.com/acme/app/compare/dev...capcomd/add-x")
    XCTAssertFalse(c.collapsible)
    // Before the view: what Run.goalBranch says, and Open PR lets the daemon answer.
    let early = GoalCard.make(runId: "run-g", summary: summary, view: .loading, action: nil)
    XCTAssertTrue(early.loading); XCTAssertEqual(early.openPR, .button(busy: false)); XCTAssertNil(early.diffURL)
  }

  func testOpenPRUnavailableShowsTheReasonAndNoGitHubShowsTheFiles() throws {
    let why = "The repository (/srv/app.git) isn't on GitHub, so capcomd can't open a pull request. The work is on capcomd/add-x: open one or merge it with your own tools."
    let c = GoalCard.make(runId: "run-g", summary: summary, view: .loaded(try view { $0.openPullRequest = .init(available: false, reason: why, repo: nil) }), action: nil)
    XCTAssertEqual(c.openPR, .unavailable(why))
    XCTAssertNil(c.diffURL)
    XCTAssertEqual(c.files.map(\.path.plain), ["src/x.ts"]); XCTAssertEqual(c.filesMore, 0)
    let e = GoalCard.make(runId: "run-g", summary: summary, view: .loaded(try view { $0.compare.error = "the remote is unreachable" }), action: nil)
    XCTAssertEqual(e.compareError, "the remote is unreachable"); XCTAssertNil(e.compareLine)
  }

  func testEachActionResult() throws {
    let v = try view()
    let pr = GoalPullRequestResult(runId: "run-g", branch: "capcomd/add-x", base: "dev", created: true, pullRequest: GoalPullRequest(number: 7, url: "https://github.com/acme/app/pull/7", state: "open"))
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: summary, view: .loaded(v), action: .openingPullRequest).openPR, .button(busy: true))
    XCTAssertTrue(GoalCard.make(runId: "run-g", summary: summary, view: .loaded(v), action: .keeping).keepBusy)
    var opened = summary; opened.state = GoalBranchSummary.prOpened; opened.pullRequest = pr.pullRequest
    let o = GoalCard.make(runId: "run-g", summary: opened, view: .loaded(v), action: .opened(pr))
    XCTAssertEqual(o.outcome, .pullRequest(number: 7, url: URL(string: "https://github.com/acme/app/pull/7")))
    XCTAssertEqual(o.openPR, .hidden); XCTAssertFalse(o.keepShown); XCTAssertFalse(o.docks)
    var kept = summary; kept.state = GoalBranchSummary.kept
    let k = GoalCard.make(runId: "run-g", summary: kept, view: .loaded(v), action: .kept)
    XCTAssertEqual(k.outcome, .kept("Kept on capcomd/add-x"))
    XCTAssertEqual(k.openPR, .button(busy: false))           // a pull request can still be opened later
    XCTAssertFalse(k.keepShown)
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: summary, view: .loaded(v), action: .refused("GitHub refused it")).outcome, .refused("GitHub refused it"))
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: summary, view: .loaded(v), action: .failed("Couldn't reach capcomd")).outcome, .refused("Couldn't reach capcomd"))
    // pr_opened from the feed (another client opened it): the run's link, no action needed.
    let feed = GoalCard.make(runId: "run-g", summary: opened, view: nil, action: nil)
    XCTAssertEqual(feed.outcome, .pullRequest(number: 7, url: URL(string: "https://github.com/acme/app/pull/7")))
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: kept, view: nil, action: nil).outcome, .kept("Kept on capcomd/add-x"))
  }

  func testAStoppedRunAsksFirst() throws {
    let ask = "The planner stopped before it finished (it failed): 1 of 3 tasks landed on capcomd/add-x. Open a pull request with what landed?"
    var stopped = summary; stopped.state = GoalBranchSummary.stopped
    let v = try view { $0.state = GoalBranchSummary.stopped; $0.openPullRequest = .init(available: true, repo: "acme/app", confirm: ask) }
    let c = GoalCard.make(runId: "run-g", summary: stopped, view: .loaded(v), action: nil)
    XCTAssertTrue(c.stopped); XCTAssertTrue(c.docks)
    XCTAssertEqual(c.openTap, .ask(ask)); XCTAssertNil(c.confirm)
    let asking = GoalCard.make(runId: "run-g", summary: stopped, view: .loaded(v), action: .confirmStopped(ask))
    XCTAssertEqual(asking.confirm, ask)
    // Before the view: Open PR goes to the daemon, whose 409 `stopped` is the question.
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: stopped, view: nil, action: nil).openTap, .open)
    XCTAssertEqual(GoalCard.make(runId: "run-g", summary: stopped, view: nil, action: .confirmStopped(ask)).confirm, ask)
  }

  func testLongListsFoldAndTheCompareURLEncodes() throws {
    let many = try view { v in v.notLanded = (1...5).map { GoalNotLanded(agentId: "agt-\($0)", task: "task \($0)", reason: "failed") } }
    XCTAssertTrue(GoalCard.make(runId: "run-g", summary: summary, view: .loaded(many), action: nil).collapsible)
    XCTAssertEqual(GoalCard.compareURL(repo: "acme/app", base: "release/2026 q4", branch: "capcomd/fix#1")?.absoluteString,
                   "https://github.com/acme/app/compare/release/2026%20q4...capcomd/fix%231")
    XCTAssertEqual(GoalCard.compareURL(repo: "acme/app", base: "dev", branch: "x", pullRequestURL: "https://ghe.acme.io/acme/app/pull/3")?.host, "ghe.acme.io")
    XCTAssertNil(GoalCard.compareURL(repo: nil, base: "dev", branch: "x"))
    XCTAssertNil(GoalCard.compareURL(repo: "not-a-repo", base: "dev", branch: "x"))
  }
}
