import XCTest
import Foundation
@testable import CapcomdStore

/// A daemon with the profile routes (Team.swift), or with some of them: what each call sent, and answers to give.
final class FakeProfilesDaemon: ProfilesPort, DaemonInfoFetching, KnownProjectsListing, @unchecked Sendable {
  var caps: Set<String> = [Capability.profiles, Capability.profilesEdit, Capability.profilesWork, Capability.profilesPersona, Capability.projectsKnown]
  var lists: [String: ProfileList] = [:]
  var details: [String: ProfileDetail] = [:]
  var projects = [KnownProject(name: "capcomd", path: "/p/capcomd", isDefault: true)]
  var puts: [(name: String, repo: String?, values: [String: String?], rev: String)] = []
  var putAnswers: [Error?] = []
  var personaPuts: [(text: String, rev: String)] = []
  var detailReads = 0
  func capabilities() async throws -> Set<String> { caps }
  func health() async throws -> DaemonHealth { DaemonHealth(version: "test", capabilities: caps) }
  func skills() async throws -> [SkillInfo] { [] }
  func knownProjects() async throws -> [KnownProject] { projects }
  func profiles(repo: String?) async throws -> ProfileList { lists[repo ?? ""] ?? ProfileList(profiles: []) }
  func profile(_ name: String, repo: String?) async throws -> ProfileDetail {
    detailReads += 1
    guard let d = details[name] else { throw ProfileRefused.invalid("profile \"\(name)\" not found") }
    return d
  }
  func updateProfile(_ name: String, repo: String?, values: [String: String?], rev: String, idempotencyKey: String) async throws -> ProfileDetail {
    puts.append((name, repo, values, rev))
    if !putAnswers.isEmpty, let e = putAnswers.removeFirst() { throw e }
    var d = details[name]!
    for (id, v) in values { if let i = d.fields.firstIndex(where: { $0.id == id }) { d.fields[i].value = v; d.fields[i].source = v == nil ? "unset" : "profile" } }
    if let t = values["identity.title"] { d.profile.title = t }
    d.rev = d.rev + "+"
    details[name] = d
    return d
  }
  func profileWork(_ name: String, repo: String?, limit: Int) async throws -> [ProfileWorkItem] {
    [ProfileWorkItem(agentId: "agt-1", runId: "run-1", title: "review email join", project: "matchkey", outcome: "passed", endedAtMs: 1000, updatedAtMs: 1000)]
  }
  func persona(_ name: String, repo: String?) async throws -> ProfilePersona { ProfilePersona(file: "/p/SOUL.md", text: "You are \(name).", hash: "h1", editable: true) }
  func updatePersona(_ name: String, repo: String?, text: String, rev: String) async throws -> ProfilePersona {
    personaPuts.append((text, rev))
    return ProfilePersona(file: "/p/SOUL.md", text: text, hash: "h2", editable: true)
  }
}

final class TeamFakeStarter: RunStarting, @unchecked Sendable {
  var choices: [RunChoice] = []
  func start(goal: String, choice: RunChoice, idempotencyKey: String) async throws -> String { choices.append(choice); return "run-new" }
}

func teamRow(_ name: String, _ source: String, title: String? = nil, tags: [String] = [], mode: String = "execute", lead: String? = nil,
         fit: String = "edits and runs code", report: Bool? = true, model: String? = "claude-opus-5-5", effort: String? = "high", skills: Int = 0) -> ProfileRow {
  ProfileRow(name: name, version: 1, source: source, path: "/p/\(name).yaml", tags: tags, provider: "claude", model: model, effort: effort, toolMode: mode,
             canLead: lead, does: fit, ready: true, readiness: "ready", applied: [ProfileFile(as: "extends", name: "reviewer", layer: "bundled"), ProfileFile(as: "profile", name: name, layer: source, path: "/p/\(name).yaml")],
             title: title, fit: fit, canReport: report, skills: (0..<skills).map { ProfileSkill(name: "s\($0)") })
}

func teamDetail(_ r: ProfileRow, rev: String = "r1") -> ProfileDetail {
  ProfileDetail(profile: r, fields: [
    ProfileField(id: "identity.title", type: "text", label: "Title", value: r.title, display: r.title ?? "Its name", source: "unset", editable: true),
    ProfileField(id: "sandbox.provider", type: "choice", label: "Runs on", value: "boxd", display: "Cloud · boxd", source: "inherited", from: 0, editable: true),
    ProfileField(id: "limits.maxTurns", type: "number", label: "Turns", value: "40", display: "40 turns", source: "inherited", from: 0, editable: true),
    ProfileField(id: "limits.timeoutMs", type: "number", label: "Time limit", value: "1800000", display: "30 min", source: "profile", from: 1, editable: true),
    ProfileField(id: "limits.maxBudgetUsd", type: "number", label: "Budget", value: nil, display: "No limit", source: "unset", editable: true),
  ], rev: rev)
}

@MainActor
final class TeamTests: XCTestCase {
  // MARK: the pure parts

  func testRoleWords() {
    XCTAssertEqual(TeamRole.of(teamRow("signal", "project", mode: "orchestrate")), .plans)
    XCTAssertEqual(TeamRole.of(teamRow("beacon", "project", tags: ["plan"])), .plans)
    XCTAssertEqual(TeamRole.of(teamRow("atlas", "project", lead: "up to 3 worker helpers, one level")), .leads)
    XCTAssertEqual(TeamRole.of(teamRow("warden", "project", fit: "read-only; answers with a report")), .reviews)
    XCTAssertEqual(TeamRole.of(teamRow("critic", "user", tags: ["review"])), .reviews)
    XCTAssertEqual(TeamRole.of(teamRow("warden2", "project", fit: "read-only", report: false)), .builds, "read-only but never reports: not a reviewer")
    XCTAssertEqual(TeamRole.of(teamRow("forge", "project")), .builds)
    XCTAssertEqual(TeamRole.of(ProfileRow(name: "old", does: "reads and runs its allowed commands (read-only: a reviewer); can't spawn helpers")), .reviews, "an older daemon's `does`")
    XCTAssertEqual(TeamRole.plans.botRole, "planner")
  }

  func testDisplayNameIsTheTitleElseTheName() {
    XCTAssertEqual(teamRow("security-critic", "user", title: "Security critic").displayName, "Security critic")
    XCTAssertEqual(teamRow("signal", "project", title: "  ").displayName, "signal")
    XCTAssertEqual(teamRow("signal", "project").displayName, "signal")
  }

  func testTheSummaryLineSaysOnlyWhatItSets() {
    let r = teamRow("security-critic", "user", fit: "read-only; answers with a report", skills: 2)
    XCTAssertEqual(TeamSummary.line(r, detail: teamDetail(r), models: ["claude-opus-5-5": "Opus 5.5"]),
                   "Opus 5.5 · high · Cloud · read-only · alone · 40 turns · 30 min · 2 skills")
    // No detail (profiles.edit missing): what the row says.
    XCTAssertEqual(TeamSummary.line(r, detail: nil), "claude-opus-5-5 · high · read-only · alone · 2 skills")
    let lead = teamRow("atlas", "project", lead: "up to 3", model: nil, effort: nil)
    XCTAssertEqual(TeamSummary.line(lead, detail: nil), "Claude Code · leads")
    XCTAssertEqual(TeamSummary.line(teamRow("signal", "project", mode: "orchestrate", skills: 1), detail: nil), "claude-opus-5-5 · high · orchestrates · alone · 1 skill")
  }

  /// fx is a harness of its own; a provider the app doesn't know keeps its wire name (a generic mark), never dropped.
  func testProvidersFromTheWire() {
    XCTAssertEqual(Provider(wire: "claude-code"), .claude)
    XCTAssertEqual(Provider(wire: "codex"), .codex)
    XCTAssertEqual(Provider(wire: "fx"), .fx)
    XCTAssertEqual(Provider(wire: "acme"), .other("acme"))
    XCTAssertNil(Provider(wire: "fake")); XCTAssertNil(Provider(wire: nil)); XCTAssertNil(Provider(wire: " "))
    XCTAssertEqual([Provider.claude, .codex, .fx, .other("acme")].map(\.harnessName), ["Claude Code", "Codex", "fx", "acme"])
    XCTAssertEqual([Provider.claude, .codex, .fx, .other("acme")].map(\.wire), ["claude", "codex", "fx", "acme"])
    XCTAssertEqual(TeamSummary.providerLabel("fx"), "fx")
    XCTAssertEqual(TeamSummary.providerLabel("acme"), "acme")
    XCTAssertEqual(TeamSummary.providerLabel("claude"), "Claude Code")
  }

  func testTheRosterIsByProjectThenAllProjects() {
    let list = ProfileList(file: "/p/capcomd/.capcomd/agents.json", profiles: [teamRow("signal", "project"), teamRow("forge", "project"), teamRow("tern", "user"), teamRow("worker", "bundled")])
    let other = ProfileList(profiles: [teamRow("tern", "user"), teamRow("worker", "bundled")])
    let own = ProfileList(file: "/home/.capcomd/agents.json", profiles: [teamRow("tern", "user"), teamRow("x-custom", "installed"), teamRow("worker", "bundled")])
    let g = TeamRoster.make(projects: [("capcomd", "/p/capcomd", list), ("empty", "/p/empty", other)], own: own)
    XCTAssertEqual(g.map(\.title), ["capcomd", "All projects"], "a project with none of its own has no label")
    XCTAssertEqual(g[0].members.map(\.name), ["signal", "forge"])
    XCTAssertEqual(g[0].members[0].id, TeamKey.make(repo: "/p/capcomd", name: "signal"))
    XCTAssertEqual(g[1].members.map(\.name), ["tern", "x-custom"], "an unknown layer is the user's; capcomd's own aren't listed")
    XCTAssertTrue(g[1].everywhere)
    XCTAssertNil(g[1].members[0].repo)
    // The daemon's own project (no known projects): its project layer is a group named after its checkout.
    let solo = TeamRoster.make(projects: [], own: ProfileList(file: "/p/solo/.capcomd/agents.json", profiles: [teamRow("w", "project")]))
    XCTAssertEqual(solo.map(\.title), ["solo"])
    XCTAssertEqual(TeamKey.split(TeamKey.make(repo: nil, name: "tern")).name, "tern")
    XCTAssertNil(TeamKey.split(TeamKey.make(repo: nil, name: "tern")).repo)
    XCTAssertEqual(TeamKey.split(TeamKey.make(repo: "/p/a", name: "b")).repo, "/p/a")
  }

  func testRowsCaptionsResetAndSteps() {
    let r = teamRow("security-critic", "user")
    let d = teamDetail(r)
    let applied = r.applied ?? []
    XCTAssertEqual(TeamFields.rows(d).map(\.id), ["sandbox.provider", "limits.maxTurns", "limits.timeoutMs", "limits.maxBudgetUsd"], "the title is the header's")
    XCTAssertEqual(TeamFields.caption(d.field("limits.maxTurns")!, applied: applied), "from reviewer")
    XCTAssertNil(TeamFields.caption(d.field("limits.timeoutMs")!, applied: applied))
    XCTAssertTrue(TeamFields.resettable(d.field("limits.timeoutMs")!, applied: applied))
    XCTAssertFalse(TeamFields.resettable(d.field("limits.maxTurns")!, applied: applied))
    var o = d.field("limits.timeoutMs")!; o.source = "override"; o.from = 1
    var proj = applied; proj[1].layer = "project"
    XCTAssertEqual(TeamFields.caption(o, applied: proj), "this project")
    XCTAssertEqual(TeamFields.stepped(d.field("limits.maxTurns")!, by: 1), "45")
    XCTAssertEqual(TeamFields.stepped(d.field("limits.timeoutMs")!, by: -1), "1500000")
    XCTAssertEqual(TeamFields.stepped(d.field("limits.maxBudgetUsd")!, by: 1), "1", "an unset number starts from nothing")
    XCTAssertNil(TeamFields.stepped(d.field("limits.maxBudgetUsd")!, by: -1))
    XCTAssertEqual(TeamFields.display(d.field("limits.maxTurns")!, value: "45"), "45 turns")
    XCTAssertEqual(TeamFields.display(d.field("limits.timeoutMs")!, value: "2100000"), "35 min")
    XCTAssertEqual(TeamFields.display(d.field("limits.maxBudgetUsd")!, value: "2.5"), "$2.5")
  }

  func testWireShapes() throws {
    let body = try JSONSerialization.jsonObject(with: ProfileWire.update(values: ["limits.maxTurns": "45", "identity.title": nil], rev: "r1")) as! [String: Any]
    XCTAssertEqual(body["rev"] as? String, "r1")
    let v = body["values"] as! [String: Any]
    XCTAssertEqual(v["limits.maxTurns"] as? String, "45")
    XCTAssertTrue(v["identity.title"] is NSNull, "null removes it from the profile's own file")
    let work = try ProfileWire.work(Data(#"{"items":[{"agentId":"a","runId":"r","title":null,"project":"p","outcome":"found_issues","endedAt":"2026-11-25T10:00:00.000Z","updatedAt":1795600800000}]}"#.utf8))
    XCTAssertEqual(work.count, 1)
    XCTAssertEqual(work[0].endedAtMs, 1_795_600_800_000)
    XCTAssertEqual(work[0].updatedAtMs, 1_795_600_800_000)
    XCTAssertEqual(work[0].outcomeWord.0, "Found issues")
    XCTAssertEqual(work[0].outcomeWord.1, .bad)
    let list = try JSONDecoder().decode(ProfileList.self, from: Data(#"{"file":"/f","profiles":[{"name":"w","default":true,"source":"user","avatarSeed":"w-1"}],"error":null}"#.utf8))
    XCTAssertEqual(list.profiles[0].isDefault, true)
    XCTAssertEqual(list.profiles[0].avatarSeed, "w-1")
    XCTAssertEqual(teamAge(ms: 0, now: 2 * 3_600_000 + 5), "2 h")
    XCTAssertEqual(teamAge(ms: 0, now: 30_000), "now")
    let start = try JSONSerialization.jsonObject(with: StartWire.body(goal: "g", choice: RunChoice(repo: "/p", profile: "warden"))) as! [String: Any]
    XCTAssertEqual(start["profile"] as? String, "warden")
    XCTAssertNil(start["planner"])
  }

  // MARK: the TeamStore

  func team(_ f: FakeProfilesDaemon, starter: TeamFakeStarter? = nil) async -> CapcomdStore {
    let s = CapcomdStore(starter: starter, daemonInfo: f)
    await s.refreshDaemonInfo()
    return s
  }

  func fixture() -> FakeProfilesDaemon {
    let f = FakeProfilesDaemon()
    let signal = teamRow("signal", "project", mode: "orchestrate"), warden = teamRow("warden", "project", fit: "read-only; answers with a report")
    f.lists["/p/capcomd"] = ProfileList(profiles: [signal, warden, teamRow("tern", "user")])
    f.lists[""] = ProfileList(file: "/home/.capcomd/agents.json", profiles: [teamRow("tern", "user")])
    f.details = ["signal": teamDetail(signal), "warden": teamDetail(warden), "tern": teamDetail(teamRow("tern", "user"))]
    return f
  }

  func testRefreshReadsEveryProjectAndTheUsersOwn() async {
    let f = fixture()
    let s = await team(f)
    var changes: [TeamStore.Change] = []
    s.team.onChange = { changes.append($0) }
    XCTAssertTrue(s.team.available)
    await s.team.refresh()
    XCTAssertEqual(s.team.roster.map(\.title), ["capcomd", "All projects"])
    XCTAssertEqual(s.team.roster[0].members.map(\.role), [.plans, .reviews])
    XCTAssertEqual(changes.first, .roster)
    let key = TeamKey.make(repo: "/p/capcomd", name: "warden")
    await s.team.load(key)
    XCTAssertEqual(s.team.details[key]?.rev, "r1")
    XCTAssertEqual(s.team.work[key]?.count, 1)
    XCTAssertEqual(s.team.personas[key]?.text, "You are warden.")
    XCTAssertEqual(changes.last, .profile(key))
  }

  func testWithoutTheCapabilitiesNothingIsAsked() async {
    let f = fixture()
    f.caps = [Capability.profiles]   // only the list: no rows, no work, no persona
    let s = await team(f)
    await s.team.refresh()
    let key = TeamKey.make(repo: nil, name: "tern")
    await s.team.load(key)
    XCTAssertNil(s.team.details[key])
    XCTAssertNil(s.team.work[key])
    XCTAssertNil(s.team.personas[key])
    XCTAssertEqual(f.detailReads, 0)
    XCTAssertFalse(s.team.editable)
    await s.team.set(key, ["limits.maxTurns": "45"])
    XCTAssertTrue(f.puts.isEmpty, "no profiles.edit: nothing is written")
    f.caps = []
    let none = await team(f)
    XCTAssertFalse(none.team.available)
  }

  func testAChangeIsWrittenAndAConflictReadsAgainAndRetriesOnce() async {
    let f = fixture()
    let s = await team(f)
    await s.team.refresh()
    let key = TeamKey.make(repo: "/p/capcomd", name: "warden")
    await s.team.load(key)
    await s.team.set(key, ["limits.maxTurns": "45"])
    XCTAssertEqual(f.puts.count, 1)
    XCTAssertEqual(f.puts[0].repo, "/p/capcomd")
    XCTAssertEqual(f.puts[0].rev, "r1")
    XCTAssertEqual(s.team.details[key]?.field("limits.maxTurns")?.value, "45")
    XCTAssertNil(s.team.pending[key])
    // The file changed underneath: 409, then the row is read again and the same change sent on the new rev.
    f.details["warden"]!.rev = "r9"
    f.putAnswers = [ProfileRefused.conflict(rev: "r9")]
    await s.team.set(key, ["limits.maxTurns": "50"])
    XCTAssertEqual(f.puts.map(\.rev), ["r1", "r1+", "r9"])
    XCTAssertEqual(s.team.details[key]?.field("limits.maxTurns")?.value, "50")
    // Refused: the daemon's sentence; forbidden: read-only from then on.
    f.putAnswers = [ProfileRefused.invalid("limits.maxTurns must be a whole number")]
    await s.team.set(key, ["limits.maxTurns": "x"])
    XCTAssertEqual(s.team.refusals[key], "limits.maxTurns must be a whole number")
    f.putAnswers = [ProfileRefused.forbidden]
    await s.team.set(key, ["limits.maxTurns": "55"])
    XCTAssertTrue(s.team.readOnly)
    XCTAssertFalse(s.team.editable)
    XCTAssertNil(s.team.pending[key])
  }

  func testATitleChangeReachesTheRoster() async {
    let f = fixture()
    let s = await team(f)
    await s.team.refresh()
    let key = TeamKey.make(repo: "/p/capcomd", name: "warden")
    await s.team.set(key, ["identity.title": "Warden"])
    XCTAssertEqual(s.team.roster[0].members[1].title, "Warden")
  }

  func testThePersonaIsWrittenOverTheHashItWasReadAt() async {
    let f = fixture()
    let s = await team(f)
    let key = TeamKey.make(repo: "/p/capcomd", name: "warden")
    await s.team.load(key)
    await s.team.savePersona(key, text: "You are warden. You never edit code.")
    XCTAssertEqual(f.personaPuts.map(\.rev), ["h1"])
    XCTAssertEqual(s.team.personas[key]?.hash, "h2")
    await s.team.savePersona(key, text: "You are warden. You never edit code.")
    XCTAssertEqual(f.personaPuts.count, 1, "the same text again writes nothing")
  }

  func testStartingSendsProfileForAWorkerAndPlannerOnlyWhereTheDaemonTakesIt() async {
    let f = fixture()
    let starter = TeamFakeStarter()
    let s = await team(f, starter: starter)
    await s.team.refresh()
    let warden = TeamKey.make(repo: "/p/capcomd", name: "warden"), signal = TeamKey.make(repo: "/p/capcomd", name: "signal")
    XCTAssertTrue(s.team.canStart(warden))
    XCTAssertFalse(s.team.canStart(signal), "a planner without runs.planner has no send")
    let st = await s.team.start(warden, goal: "review the join", sandbox: "boxd")
    XCTAssertEqual(st, .started(runId: "run-new"))
    XCTAssertEqual(starter.choices.last?.profile, "warden")
    XCTAssertNil(starter.choices.last?.planner)
    XCTAssertEqual(starter.choices.last?.repo, "/p/capcomd")
    XCTAssertEqual(starter.choices.last?.sandbox, "boxd")
    f.caps.insert(Capability.runsPlanner)
    await s.refreshDaemonInfo()
    XCTAssertTrue(s.team.canStart(signal))
    _ = await s.team.start(signal, goal: "plan it", sandbox: nil)
    XCTAssertEqual(starter.choices.last?.planner, "signal")
    XCTAssertNil(starter.choices.last?.profile)
    // The user's own runs where the composer's project is.
    s.prefs.startRepo = "/p/other"
    _ = await s.team.start(TeamKey.make(repo: nil, name: "tern"), goal: "g", sandbox: nil)
    XCTAssertEqual(starter.choices.last?.repo, "/p/other")
  }
}
