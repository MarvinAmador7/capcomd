import Foundation
import CapcomdStore

// The Team screen's fixture (design/desktop/team, CrewProfile.dc.html's roster): two projects with profiles of their
// own and the user's two, answered as the daemon's profile routes would (GET /v1/profiles[?repo=], GET/PUT
// /v1/profiles/{name}, …/work, …/persona), with run options for the model menu. No daemon: the bench and the tests
// drive the screen on it, and `capabilities` says which routes this daemon has (a part whose route is missing is left
// out, never faked). client/mock/profiles.ts serves the same roster to the app itself.

/// A daemon with the profile routes. Its changes last for its own life (PUT writes, bumps the version and the rev).
public final class TeamFixtureDaemon: ProfilesPort, DaemonInfoFetching, KnownProjectsListing, @unchecked Sendable {
  public static let all: Set<String> = [Capability.profiles, Capability.profilesEdit, Capability.profilesWork, Capability.profilesPersona,
                                        Capability.profilesAvatar, Capability.runsPlanner, Capability.projectsKnown, Capability.runsOptions,
                                        Capability.runsOptionsModels, "profiles.facts"]
  public let capabilities: Set<String>
  private let lock = NSLock()
  private var profilesByScope: [String: [ProfileRow]]
  private var details: [String: ProfileDetail] = [:]
  private var personas: [String: ProfilePersona] = [:]
  /// What each PUT sent: the profile, its values, the rev.
  public private(set) var puts: [(name: String, values: [String: String?], rev: String)] = []
  /// Answers for the next PUTs, in order (an error to throw, or nil to apply it); none left: apply it.
  public var putAnswers: [Error?] = []

  public static let projects = [KnownProject(name: "capcomd", path: "/Users/dev/capcomd", isDefault: true),
                                KnownProject(name: "capcomd-site", path: "/Users/dev/capcomd-site", isDefault: false)]

  public init(capabilities: Set<String> = TeamFixtureDaemon.all) {
    self.capabilities = capabilities
    let avatars = capabilities.contains(Capability.profilesAvatar)
    func p(_ name: String, _ source: String, title: String? = nil, tags: [String] = [], model: String = "claude-opus-5-5", effort: String? = "high",
           mode: String = "execute", lead: String? = nil, fit: String = "edits and runs code", skills: [String] = [], version: Int = 1,
           extends: String? = nil, repo: String? = nil, provider: String = "claude") -> ProfileRow {
      let dir = repo.map { "\($0)/.capcomd/profiles" } ?? "/Users/dev/.capcomd/profiles"
      var applied = extends.map { [ProfileFile(as: "extends", name: $0, layer: "bundled", path: nil)] } ?? []
      applied.append(ProfileFile(as: "profile", name: name, layer: source, path: "\(dir)/\(name).yaml"))
      return ProfileRow(name: name, version: version, source: source, path: "\(dir)/\(name).yaml", isDefault: false, description: nil, tags: tags,
                        provider: provider, model: model, effort: effort, toolMode: mode, canSpawn: lead != nil || mode == "orchestrate", canLead: lead,
                        does: fit, ready: true, readiness: "ready", applied: applied, title: title, fit: fit, canReport: true,
                        skills: skills.map { ProfileSkill(name: $0, trusted: true) }, avatarSeed: avatars ? "\(name)-seed" : nil)
    }
    let a = Self.projects[0].path, b = Self.projects[1].path
    let bundled = [p("worker", "bundled"), p("reviewer", "bundled", fit: "read-only; answers with a report")]
    let mine = [p("security-critic", "user", title: "Security critic", tags: ["review", "security"], fit: "read-only; answers with a report",
                  skills: ["threat-model", "owasp-top-10"], version: 3, extends: "reviewer"),
                p("tern", "user", model: "claude-sonnet-5-5", effort: "medium")]
    profilesByScope = [
      a: [p("signal", "project", mode: "orchestrate", fit: "orchestrates: sees everything, runs nothing", repo: a),
          p("atlas", "project", lead: "up to 3 worker helpers, one level", repo: a),
          p("forge", "project", effort: "medium", repo: a),
          p("warden", "project", fit: "read-only; answers with a report", skills: ["review-checklist"], repo: a)] + mine + bundled,
      b: [p("beacon", "project", mode: "orchestrate", fit: "orchestrates: sees everything, runs nothing", repo: b),
          p("pixel", "project", model: "gpt-5-codex", effort: nil, repo: b, provider: "codex"),
          p("quill", "project", tags: ["docs"], model: "claude-sonnet-5-5", repo: b)] + mine + bundled,
      "": mine + bundled,
    ]
    for (scope, rows) in profilesByScope {
      for r in rows where r.source != "bundled" {
        let k = Self.key(r.name, scope)
        details[k] = Self.detail(r, rev: 1)
        let soul = r.name == "security-critic"
          ? "You are Security critic. You read a change against the goal it was made for and look for what an attacker would use: injection in queries and shell calls, secrets in logs and errors, auth checks a new route skips, limits a missing key bypasses. You never edit code."
          : "You are \(r.displayName). You take one part of the goal, make it work with its tests, and hand back what changed and what you checked."
        personas[k] = ProfilePersona(file: r.path.map { (($0 as NSString).deletingLastPathComponent as NSString).appendingPathComponent("SOUL.md") },
                                     text: soul, hash: "sha256:\(r.name)-1", layer: r.source, editable: true, why: nil, trusted: true)
      }
    }
  }

  static func key(_ name: String, _ repo: String?) -> String { "\(repo ?? "")|\(name)" }

  /// A profile's rows as the daemon serves them, in its order.
  static func detail(_ r: ProfileRow, rev: Int) -> ProfileDetail {
    let inherits = (r.applied ?? []).contains { $0.as == "extends" }
    let own = "profile"
    var fields: [ProfileField] = [
      ProfileField(id: "identity.title", type: "text", label: "Title", value: r.title, display: r.title ?? "Its name", source: r.title == nil ? "unset" : own, editable: true, untrusted: true),
      ProfileField(id: "description", type: "text", label: "Description", value: nil, display: "None", source: "unset", editable: true, untrusted: true),
      ProfileField(id: "tags", type: "list", label: "Tags", value: (r.tags ?? []).isEmpty ? nil : ProfileField.encodeList(r.tags ?? []),
                   display: (r.tags ?? []).isEmpty ? "None" : (r.tags ?? []).joined(separator: ", "), source: (r.tags ?? []).isEmpty ? "unset" : own, editable: true),
      ProfileField(id: "harness.provider", type: "choice", label: "Agent", value: r.provider, display: r.provider == "codex" ? "Codex" : "Claude Code",
                   choices: [.init(value: "claude", label: "Claude Code"), .init(value: "codex", label: "Codex")], source: own, from: inherits ? 0 : 0, editable: true),
      ProfileField(id: "harness.model", type: "text", label: "Model", value: r.model, display: r.model ?? "The agent's default", source: own, editable: true),
      ProfileField(id: "harness.effort", type: "choice", label: "Effort", value: r.effort, display: r.effort.map { $0.capitalized } ?? "The agent's default",
                   choices: ["low", "medium", "high", "xhigh"].map { .init(value: $0, label: $0.capitalized) }, source: r.effort == nil ? "unset" : own, editable: true),
      ProfileField(id: "sandbox.provider", type: "choice", label: "Runs on", value: "boxd", display: "Cloud · boxd",
                   choices: [.init(value: "docker", label: "This Mac · Docker"), .init(value: "boxd", label: "Cloud · boxd")], source: "inherited", from: 0, editable: true),
      ProfileField(id: "tools.mode", type: "choice", label: "Works by", value: r.toolMode, display: r.orchestrates ? "Orchestrating: sees everything, runs nothing" : "Executing: edits and runs code",
                   choices: [.init(value: "execute", label: "Executing: edits and runs code"), .init(value: "orchestrate", label: "Orchestrating: sees everything, runs nothing")],
                   source: r.orchestrates ? own : "unset", editable: true),
      ProfileField(id: "permissions.report", type: "toggle", label: "May answer with a report", value: "true", display: "Yes", source: "unset", editable: true),
      ProfileField(id: "limits.maxTurns", type: "number", label: "Turns", value: "40", display: "40 turns", source: inherits ? "inherited" : own, from: 0, editable: true),
      ProfileField(id: "limits.timeoutMs", type: "number", label: "Time limit", value: "1800000", display: "30 min", source: own, editable: true),
      ProfileField(id: "limits.maxBudgetUsd", type: "number", label: "Budget", value: nil, display: "No limit", source: "unset", editable: true),
      ProfileField(id: "prompt.append", type: "info", label: "Added to the prompt", value: nil, display: "Nothing", source: "unset", editable: false),
    ]
    if r.name == "security-critic" {
      fields.append(ProfileField(id: "sharing.source", type: "info", label: "sharing.source", value: "acme/capcomd-profiles", display: "acme/capcomd-profiles", source: "profile", editable: false, untrusted: true))
    }
    return ProfileDetail(profile: r, fields: fields, rev: "rev-\(r.name)-\(rev)", writesTo: r.path)
  }

  // MARK: DaemonInfoFetching

  public func capabilities() async throws -> Set<String> { capabilities }
  public func health() async throws -> DaemonHealth { DaemonHealth(version: "fixture", capabilities: capabilities) }
  public func skills() async throws -> [SkillInfo] { [] }
  public func runOptions(repo: String?) async throws -> RunOptions {
    let claude = [ModelInfo(id: "claude-opus-5-5", name: "Opus 5.5", note: "Most capable"), ModelInfo(id: "claude-sonnet-5-5", name: "Sonnet 5.5", note: "Fast")]
    return RunOptions(drivers: [DriverInfo(provider: "claude", label: "Claude Code", model: "claude-opus-5-5", isDefault: true, efforts: ["low", "medium", "high", "xhigh"], effort: "high", models: claude),
                                DriverInfo(provider: "codex", label: "Codex", model: "gpt-5-codex", efforts: ["low", "medium", "high"], effort: "medium",
                                           models: [ModelInfo(id: "gpt-5-codex", name: "GPT-5 Codex", note: "Codex")])],
                      sandboxes: [SandboxInfo(name: "docker", label: "This Mac"), SandboxInfo(name: "boxd", label: "Cloud", isDefault: true)])
  }
  public func knownProjects() async throws -> [KnownProject] {
    guard capabilities.contains(Capability.projectsKnown) else { throw DetailUnavailable.unsupported }
    return Self.projects
  }

  // MARK: ProfilesPort

  private func need(_ c: String) throws { if !capabilities.contains(c) { throw DetailUnavailable.unsupported } }

  public func profiles(repo: String?) async throws -> ProfileList {
    try need(Capability.profiles)
    return lock.withLock {
      let scope = repo ?? ""
      let rows = (profilesByScope[scope] ?? []).map { r in details[Self.key(r.name, repo)]?.profile ?? detailFor(r.name, otherThan: repo) ?? r }
      return ProfileList(file: repo.map { "\($0)/.capcomd/agents.json" } ?? "/Users/dev/.capcomd/agents.json", profiles: rows)
    }
  }
  /// A user profile changed through one scope is the same file seen from every scope.
  private func detailFor(_ name: String, otherThan repo: String?) -> ProfileRow? {
    details.first { $0.key.hasSuffix("|\(name)") && $0.value.profile.source == "user" }?.value.profile
  }
  public func profile(_ name: String, repo: String?) async throws -> ProfileDetail {
    try need(Capability.profilesEdit)
    return try lock.withLock {
      guard let d = details[Self.key(name, repo)] else { throw ProfileRefused.invalid("profile \"\(name)\" not found") }
      return d
    }
  }
  public func updateProfile(_ name: String, repo: String?, values: [String: String?], rev: String, idempotencyKey: String) async throws -> ProfileDetail {
    try need(Capability.profilesEdit)
    return try lock.withLock {
      puts.append((name, values, rev))
      if !putAnswers.isEmpty, let e = putAnswers.removeFirst() { throw e }
      let k = Self.key(name, repo)
      guard var d = details[k] else { throw ProfileRefused.invalid("profile \"\(name)\" not found") }
      guard d.rev == rev else { throw ProfileRefused.conflict(rev: d.rev) }
      var r = d.profile
      for (id, v) in values {
        switch id {
        case "identity.title": r.title = v ?? nil
        case "identity.avatar.seed": r.avatarSeed = v ?? nil
        case "harness.model": r.model = v ?? nil
        case "harness.effort": r.effort = v ?? nil
        case "tools.mode": r.toolMode = v ?? "execute"
        default: break
        }
      }
      r.version = (r.version ?? 1) + 1
      let n = (Int(d.rev.split(separator: "-").last ?? "1") ?? 1) + 1
      let old = d.fields
      d = Self.detail(r, rev: n)
      // Values the catalog rows hold keep what was written.
      for (i, f) in d.fields.enumerated() {
        if let v = values[f.id] {
          d.fields[i].value = v
          d.fields[i].source = v == nil ? "unset" : "profile"
          d.fields[i].display = v.map { nv in f.type == "number" ? TeamFields.display(f, value: nv) : f.choices?.first { $0.value == nv }?.label ?? nv } ?? f.display
        } else if let o = old.first(where: { $0.id == f.id }) { d.fields[i] = o }
      }
      details[k] = d
      return d
    }
  }
  public func profileWork(_ name: String, repo: String?, limit: Int) async throws -> [ProfileWorkItem] {
    try need(Capability.profilesWork)
    let t = Int(Date().timeIntervalSince1970 * 1000)
    let items = [ProfileWorkItem(agentId: "agt-\(name)-1", runId: "run-work-1", title: "review invoice rounding", project: "fix proration", outcome: "found_issues", endedAtMs: t - 2 * 3_600_000, updatedAtMs: t - 2 * 3_600_000),
                 ProfileWorkItem(agentId: "agt-\(name)-2", runId: "run-work-2", title: "review email join", project: "migrate matchkey", outcome: "passed", endedAtMs: t - 5 * 3_600_000, updatedAtMs: t - 5 * 3_600_000)]
    return Array(items.prefix(limit))
  }
  public func persona(_ name: String, repo: String?) async throws -> ProfilePersona {
    try need(Capability.profilesPersona)
    return lock.withLock { personas[Self.key(name, repo)] ?? ProfilePersona() }
  }
  public func updatePersona(_ name: String, repo: String?, text: String, rev: String) async throws -> ProfilePersona {
    try need(Capability.profilesPersona)
    return try lock.withLock {
      let k = Self.key(name, repo)
      guard var p = personas[k] else { throw ProfileRefused.invalid("profile \"\(name)\" has no persona") }
      guard p.hash == rev else { throw ProfileRefused.conflict(rev: p.hash) }
      p.text = text; p.hash = "sha256:\(name)-\(text.count)"
      personas[k] = p
      return p
    }
  }
}
