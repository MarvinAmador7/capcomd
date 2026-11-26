import Foundation

// Team (design/desktop/team, SPEC §2.2): the agent profiles a run can use, by project, as the desktop's Team screen
// shows them. The wire types of GET /v1/profiles (capability profiles), GET/PUT /v1/profiles/{name} (profiles.edit),
// GET /v1/profiles/{name}/work (profiles.work), GET/PUT /v1/profiles/{name}/persona (profiles.persona), and the pure
// parts the screen is made from: a profile's role word, its settings summary, the roster by project. Foundation only.

extension Capability {
  /// `GET /v1/profiles`: every profile a run can use (the daemon's, or a project's with `repo`).
  public static let profiles = "profiles"
  /// `GET/PUT /v1/profiles/{name}`: one profile as typed rows, changed in its own file.
  public static let profilesEdit = "profiles.edit"
  /// `GET /v1/profiles/{name}/work`: the agents a profile ran lately, with their outcome.
  public static let profilesWork = "profiles.work"
  /// `GET/PUT /v1/profiles/{name}/persona`: a profile's persona text (SOUL.md).
  public static let profilesPersona = "profiles.persona"
  /// `avatarSeed` on profile rows, set with PUT's `identity.avatar.seed`: one face per profile.
  public static let profilesAvatar = "profiles.avatar"
  /// `POST /v1/runs` takes `planner`: a run planned by that profile.
  public static let runsPlanner = "runs.planner"
}

/// A skill a profile's agents are pinned with (names only, never their text).
public struct ProfileSkill: Codable, Sendable, Hashable {
  public var name: String
  public var trusted: Bool?
  public init(name: String, trusted: Bool? = nil) { self.name = name; self.trusted = trusted }
}

/// A file laid together to make a profile (`applied`): an `extends` ancestor, the profile itself, or an override.
public struct ProfileFile: Codable, Sendable, Hashable {
  public var `as`: String
  public var name: String
  public var layer: String?
  public var path: String?
  public init(as a: String, name: String, layer: String? = nil, path: String? = nil) { self.as = a; self.name = name; self.layer = layer; self.path = path }
}

/// One profile as GET /v1/profiles lists it. Every field but the name is optional: an older daemon sends fewer.
public struct ProfileRow: Codable, Sendable, Hashable {
  public var name: String
  public var version: Int?
  /// The layer it was found in: project, user, bundled (an unknown one reads as user).
  public var source: String?
  public var path: String?
  public var isDefault: Bool?
  public var description: String?
  public var tags: [String]?
  public var provider: String?
  public var model: String?
  public var effort: String?
  public var toolMode: String?
  public var canSpawn: Bool?
  public var canLead: String?
  public var does: String?
  public var ready: Bool?
  public var readiness: String?
  public var applied: [ProfileFile]?
  /// `identity.title` (profiles.facts): agent-written text, shown as plain text; nil: its name.
  public var title: String?
  public var fit: String?
  public var canReport: Bool?
  public var skills: [ProfileSkill]?
  /// Its bot's seed (profiles.avatar); nil: the app's own derivation.
  public var avatarSeed: String?
  enum CodingKeys: String, CodingKey {
    case name, version, source, path, isDefault = "default", description, tags, provider, model, effort, toolMode, canSpawn, canLead, does
    case ready, readiness, applied, title, fit, canReport, skills, avatarSeed
  }
  public init(name: String, version: Int? = nil, source: String? = nil, path: String? = nil, isDefault: Bool? = nil, description: String? = nil,
              tags: [String]? = nil, provider: String? = nil, model: String? = nil, effort: String? = nil, toolMode: String? = nil,
              canSpawn: Bool? = nil, canLead: String? = nil, does: String? = nil, ready: Bool? = nil, readiness: String? = nil,
              applied: [ProfileFile]? = nil, title: String? = nil, fit: String? = nil, canReport: Bool? = nil, skills: [ProfileSkill]? = nil,
              avatarSeed: String? = nil) {
    self.name = name; self.version = version; self.source = source; self.path = path; self.isDefault = isDefault; self.description = description
    self.tags = tags; self.provider = provider; self.model = model; self.effort = effort; self.toolMode = toolMode; self.canSpawn = canSpawn
    self.canLead = canLead; self.does = does; self.ready = ready; self.readiness = readiness; self.applied = applied; self.title = title
    self.fit = fit; self.canReport = canReport; self.skills = skills; self.avatarSeed = avatarSeed
  }

  /// What the app calls it: its title when it has one, else its name.
  public var displayName: String {
    let t = title?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return t.isEmpty ? name : t
  }
  /// The layer as the roster files it: project, bundled, else user (an unknown layer is the user's, as the contract says).
  public var layer: String {
    switch source { case "project": "project"; case "bundled": "bundled"; default: "user" }
  }
  /// It can't edit files: the daemon's own words say so (`fit` starts with "read-only"; older daemons' `does`).
  public var readOnly: Bool {
    if let fit { return fit.hasPrefix("read-only") }
    return does?.contains("read-only") ?? false
  }
  public var orchestrates: Bool { toolMode == "orchestrate" }
}

/// `GET /v1/profiles[?repo=]`.
public struct ProfileList: Codable, Sendable, Hashable {
  public var file: String?
  public var profiles: [ProfileRow]
  public var error: String?
  public init(file: String? = nil, profiles: [ProfileRow], error: String? = nil) { self.file = file; self.profiles = profiles; self.error = error }
}

/// One of a profile's rows (GET /v1/profiles/{name} `fields`), typed like a place's settings.
public struct ProfileField: Codable, Sendable, Hashable, Identifiable {
  public struct Choice: Codable, Sendable, Hashable { public var value: String; public var label: String
    public init(value: String, label: String) { self.value = value; self.label = label } }
  public var id: String
  /// choice, toggle, number, text, list, info; an unknown type is shown read-only.
  public var type: String
  public var label: String
  public var help: String?
  /// The value as PUT takes it (a list is a JSON array of strings); nil when unset.
  public var value: String?
  public var display: String
  public var choices: [Choice]?
  /// unset, inherited, profile, override.
  public var source: String?
  /// The index in the profile's `applied` of the file that sets it.
  public var from: Int?
  public var editable: Bool?
  public var untrusted: Bool?
  public init(id: String, type: String, label: String, help: String? = nil, value: String? = nil, display: String, choices: [Choice]? = nil,
              source: String? = nil, from: Int? = nil, editable: Bool? = nil, untrusted: Bool? = nil) {
    self.id = id; self.type = type; self.label = label; self.help = help; self.value = value; self.display = display; self.choices = choices
    self.source = source; self.from = from; self.editable = editable; self.untrusted = untrusted
  }
  /// A list's values (its `value` is a JSON array of strings).
  public var listValues: [String] {
    guard let value, let d = value.data(using: .utf8), let a = try? JSONDecoder().decode([String].self, from: d) else { return [] }
    return a
  }
  public static func encodeList(_ a: [String]) -> String {
    (try? String(data: JSONEncoder().encode(a), encoding: .utf8)) ?? "[]"
  }
}

/// `GET /v1/profiles/{name}` (and PUT's answer).
public struct ProfileDetail: Codable, Sendable, Hashable {
  public var profile: ProfileRow
  public var fields: [ProfileField]
  public var rev: String
  public var writesTo: String?
  public init(profile: ProfileRow, fields: [ProfileField], rev: String, writesTo: String? = nil) {
    self.profile = profile; self.fields = fields; self.rev = rev; self.writesTo = writesTo
  }
  public func field(_ id: String) -> ProfileField? { fields.first { $0.id == id } }
}

/// An agent a profile ran (`GET /v1/profiles/{name}/work`).
public struct ProfileWorkItem: Codable, Sendable, Hashable, Identifiable {
  public var agentId: String
  public var runId: String
  public var title: String?
  public var project: String?
  /// running, idle, merged, passed, found_issues, failed, cancelled.
  public var outcome: String
  /// Epoch ms (the daemon may send ISO 8601; both decode).
  public var endedAtMs: Int?
  public var updatedAtMs: Int?
  public var id: String { agentId }
  enum CodingKeys: String, CodingKey { case agentId, runId, title, project, outcome, endedAt, updatedAt }
  public init(agentId: String, runId: String, title: String?, project: String?, outcome: String, endedAtMs: Int?, updatedAtMs: Int?) {
    self.agentId = agentId; self.runId = runId; self.title = title; self.project = project; self.outcome = outcome
    self.endedAtMs = endedAtMs; self.updatedAtMs = updatedAtMs
  }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    agentId = try c.decode(String.self, forKey: .agentId); runId = try c.decode(String.self, forKey: .runId)
    title = try c.decodeIfPresent(String.self, forKey: .title); project = try c.decodeIfPresent(String.self, forKey: .project)
    outcome = try c.decode(String.self, forKey: .outcome)
    endedAtMs = Self.time(c, .endedAt); updatedAtMs = Self.time(c, .updatedAt)
  }
  public func encode(to e: Encoder) throws {
    var c = e.container(keyedBy: CodingKeys.self)
    try c.encode(agentId, forKey: .agentId); try c.encode(runId, forKey: .runId); try c.encode(title, forKey: .title)
    try c.encode(project, forKey: .project); try c.encode(outcome, forKey: .outcome)
    try c.encode(endedAtMs, forKey: .endedAt); try c.encode(updatedAtMs, forKey: .updatedAt)
  }
  static func time(_ c: KeyedDecodingContainer<CodingKeys>, _ k: CodingKeys) -> Int? {
    if let n = try? c.decodeIfPresent(Double.self, forKey: k) { return Int(n) }
    guard let s = try? c.decodeIfPresent(String.self, forKey: k) else { return nil }
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return Int(d.timeIntervalSince1970 * 1000) }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s).map { Int($0.timeIntervalSince1970 * 1000) }
  }
  /// The outcome as the row says it, and how it is coloured (only the word is).
  public enum Tone: Sendable, Hashable { case plain, ok, bad }
  public var outcomeWord: (String, Tone) {
    switch outcome {
    case "running": ("Working", .plain)
    case "idle": ("Idle", .plain)
    case "merged": ("Merged", .ok)
    case "passed": ("Passed", .ok)
    case "found_issues": ("Found issues", .bad)
    case "failed": ("Failed", .bad)
    case "cancelled": ("Stopped", .plain)
    default: (outcome.replacingOccurrences(of: "_", with: " ").capitalized, .plain)
    }
  }
}

/// A profile's persona (`GET /v1/profiles/{name}/persona`): its SOUL.md, or none.
public struct ProfilePersona: Codable, Sendable, Hashable {
  public var file: String?
  public var text: String?
  public var hash: String?
  public var layer: String?
  public var editable: Bool?
  public var why: String?
  public var trusted: Bool?
  public init(file: String? = nil, text: String? = nil, hash: String? = nil, layer: String? = nil, editable: Bool? = nil, why: String? = nil, trusted: Bool? = nil) {
    self.file = file; self.text = text; self.hash = hash; self.layer = layer; self.editable = editable; self.why = why; self.trusted = trusted
  }
  /// The file's name as the block's header shows it ("SOUL.md").
  public var fileName: String { file.map { ($0 as NSString).lastPathComponent } ?? "SOUL.md" }
}

/// A profile change the daemon refused.
public enum ProfileRefused: Error, Sendable, Hashable {
  /// 403: this app's token lacks the `configure` scope.
  case forbidden
  /// 409: the files changed since `rev` was read; the current rev when the daemon says.
  case conflict(rev: String?)
  /// 422 or 404: the daemon's sentence.
  case invalid(String)
}

/// The profile routes. Every call throws `DetailUnavailable.unsupported` on a daemon without the route, `Unauthorized`
/// for a refused token, `ProfileRefused` for a refused change.
public protocol ProfilesPort: Sendable {
  func profiles(repo: String?) async throws -> ProfileList
  func profile(_ name: String, repo: String?) async throws -> ProfileDetail
  /// PUT: `values` by field id; nil removes the value from the profile's own file.
  func updateProfile(_ name: String, repo: String?, values: [String: String?], rev: String, idempotencyKey: String) async throws -> ProfileDetail
  func profileWork(_ name: String, repo: String?, limit: Int) async throws -> [ProfileWorkItem]
  func persona(_ name: String, repo: String?) async throws -> ProfilePersona
  func updatePersona(_ name: String, repo: String?, text: String, rev: String) async throws -> ProfilePersona
}

/// The bodies the profile routes take, shared by the live adapter and the tests.
public enum ProfileWire {
  public static func update(values: [String: String?], rev: String) throws -> Data {
    let v: [String: Any] = values.mapValues { $0.map { $0 as Any } ?? NSNull() }
    return try JSONSerialization.data(withJSONObject: ["values": v, "rev": rev] as [String: Any], options: [.sortedKeys])
  }
  public static func persona(text: String, rev: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["text": text, "rev": rev] as [String: Any], options: [.sortedKeys])
  }
  public static func work(_ data: Data) throws -> [ProfileWorkItem] {
    struct Page: Decodable { var items: [ProfileWorkItem] }
    return try JSONDecoder().decode(Page.self, from: data).items
  }
}

// MARK: - what the screen is made from

/// A profile's role word (the roster's and the pane's): plans (orchestrates, or tagged plan), leads (it can lead a part),
/// reviews (read-only and may report, or tagged review), else builds.
public enum TeamRole: String, Sendable, Hashable, CaseIterable {
  case plans, leads, builds, reviews
  public static func of(_ p: ProfileRow) -> TeamRole {
    let tags = Set((p.tags ?? []).map { $0.lowercased() })
    if p.orchestrates || tags.contains("plan") || tags.contains("planner") { return .plans }
    if p.canLead != nil { return .leads }
    if (p.canReport ?? true) && p.readOnly || tags.contains("review") || tags.contains("reviewer") { return .reviews }
    return .builds
  }
  /// The bot catalog's role for its face.
  public var botRole: String { switch self { case .plans: "planner"; case .leads: "lead"; case .builds: "worker"; case .reviews: "critic" } }
}

/// One profile in the roster.
public struct TeamMember: Sendable, Hashable, Identifiable {
  /// `TeamKey.make(repo:name:)`.
  public var id: String
  public var name: String
  public var title: String
  public var role: TeamRole
  /// The project it belongs to (its checkout); nil for the user's own, which apply everywhere.
  public var repo: String?
  public var provider: String?
  /// The daemon's seed for its bot (profiles.avatar), else nil.
  public var avatarSeed: String?
  public var ready: Bool
  public var readiness: String?
  public init(row: ProfileRow, repo: String?) {
    id = TeamKey.make(repo: repo, name: row.name); name = row.name; title = row.displayName; role = TeamRole.of(row); self.repo = repo
    provider = row.provider; avatarSeed = row.avatarSeed; ready = row.ready ?? true; readiness = row.readiness
  }
}

/// A profile's key in the app: its project (nil: the daemon's own list) and its name.
public enum TeamKey {
  public static func make(repo: String?, name: String) -> String { "\(repo ?? "~")\u{1F}\(name)" }
  public static func split(_ key: String) -> (repo: String?, name: String) {
    let p = key.split(separator: "\u{1F}", maxSplits: 1, omittingEmptySubsequences: false).map(String.init)
    guard p.count == 2 else { return (nil, key) }
    return (p[0] == "~" ? nil : p[0], p[1])
  }
}

/// A group of the roster: one project's own profiles, or the user's (`All projects`).
public struct TeamGroup: Sendable, Hashable, Identifiable {
  public var id: String
  public var title: String
  /// The user's own profiles, which every project can use.
  public var everywhere: Bool
  public var members: [TeamMember]
  public init(id: String, title: String, everywhere: Bool, members: [TeamMember]) { self.id = id; self.title = title; self.everywhere = everywhere; self.members = members }
}

public enum TeamRoster {
  /// One group per project with profiles of its own (in the order given), then the user's own as "All projects". A
  /// project's list also has the user's and capcomd's: only its project layer is its own. The daemon's own list gives
  /// the user's; its project layer (the daemon's own repository) is a group too when no listed project is that one.
  public static func make(projects: [(name: String, path: String, list: ProfileList?)], own: ProfileList?) -> [TeamGroup] {
    var groups: [TeamGroup] = []
    for p in projects {
      let members = (p.list?.profiles ?? []).filter { $0.layer == "project" }.map { TeamMember(row: $0, repo: p.path) }
      if !members.isEmpty { groups.append(TeamGroup(id: p.path, title: p.name, everywhere: false, members: members)) }
    }
    if let own {
      let ownProject = own.profiles.filter { $0.layer == "project" }
      let root = own.file.map { projectRoot(of: $0) }
      if !ownProject.isEmpty, let root, !projects.contains(where: { $0.path == root }) {
        groups.append(TeamGroup(id: root, title: (root as NSString).lastPathComponent, everywhere: false, members: ownProject.map { TeamMember(row: $0, repo: nil) }))
      }
      let mine = own.profiles.filter { $0.layer == "user" }.map { TeamMember(row: $0, repo: nil) }
      if !mine.isEmpty { groups.append(TeamGroup(id: "~", title: "All projects", everywhere: true, members: mine)) }
    }
    return groups
  }
  /// `<checkout>/.capcomd/agents.json` → `<checkout>`.
  static func projectRoot(of file: String) -> String {
    let dir = (file as NSString).deletingLastPathComponent
    return (dir as NSString).lastPathComponent == ".capcomd" ? (dir as NSString).deletingLastPathComponent : dir
  }
}

/// The settings row's one line (the thread's tool group, "Used 3 tools"): model · effort · place · how it works · who it
/// leads · turns · time · skills. Only what the profile says; a part it doesn't set is left out.
public enum TeamSummary {
  public static func line(_ p: ProfileRow, detail: ProfileDetail?, models: [String: String] = [:]) -> String {
    var parts: [String] = []
    if let m = p.model { parts.append(models[m] ?? m) } else if let pr = p.provider { parts.append(providerLabel(pr)) }
    if let e = p.effort { parts.append(e.lowercased()) }
    if let place = detail?.field("sandbox.provider")?.value { parts.append(placeWord(place)) }
    if p.orchestrates { parts.append("orchestrates") } else if p.readOnly { parts.append("read-only") }
    parts.append(p.canLead == nil ? "alone" : "leads")
    if let f = detail?.field("limits.maxTurns"), f.value != nil { parts.append(f.display) }
    if let f = detail?.field("limits.timeoutMs"), f.value != nil { parts.append(f.display) }
    let skills = p.skills?.count ?? 0
    if skills > 0 { parts.append(skills == 1 ? "1 skill" : "\(skills) skills") }
    return parts.joined(separator: " · ")
  }
  public static func providerLabel(_ p: String) -> String {
    switch p { case "claude": "Claude Code"; case "codex": "Codex"; case "fx": "fx"; default: p }
  }
  /// A place as the composer's pills name it: boxd is Cloud, Docker and the fake host are This Mac.
  public static func placeWord(_ name: String) -> String { name == "boxd" ? "Cloud" : name == "docker" || name == "fake-host" ? "This Mac" : name }
}

/// The settings rows (GET /v1/profiles/{name} `fields`, less the ones the page shows elsewhere) and how each says where its
/// value comes from.
public enum TeamFields {
  /// Shown elsewhere on the page: the title (the header), the bot, the persona (SOUL.md).
  public static let elsewhere: Set<String> = ["identity.title", "identity.avatar.seed", "identity.persona"]
  public static func rows(_ d: ProfileDetail) -> [ProfileField] { d.fields.filter { !elsewhere.contains($0.id) } }

  /// The caption under a row's label: the profile it inherits the value from ("from reviewer"), or the layer of the
  /// override that sets it ("this project", "yours"); nil when its own file sets it or nothing does.
  public static func caption(_ f: ProfileField, applied: [ProfileFile]) -> String? {
    let file = f.from.flatMap { applied.indices.contains($0) ? applied[$0] : nil }
    switch f.source {
    case "inherited": return file.map { "from \($0.name)" } ?? "inherited"
    case "override": return file?.layer == "project" ? "this project" : "yours"
    default: return nil
    }
  }
  /// Reset (PUT null) where the profile's own file sets a value it would otherwise inherit.
  public static func resettable(_ f: ProfileField, applied: [ProfileFile]) -> Bool {
    f.source == "profile" && (f.editable ?? false) && applied.contains { $0.as == "extends" }
  }

  /// A number row's step for − and +, by its id (the daemon's units: ms, turns, dollars, shares, counts).
  public static func step(_ id: String) -> Double {
    if id.hasSuffix("Ms") { return 300_000 }
    if id == "limits.maxTurns" { return 5 }
    if id == "children.budgetShare" { return 0.1 }
    return 1
  }
  /// The next value of a number row after − or +, as PUT takes it; nil leaves it as it is. Never below zero.
  public static func stepped(_ f: ProfileField, by sign: Int) -> String? {
    let s = step(f.id)
    let now = f.value.flatMap(Double.init) ?? (sign > 0 ? 0 : -1)
    if now < 0 { return nil }
    let next = max(0, now + Double(sign) * s)
    if next == now { return nil }
    let rounded = (next * 100).rounded() / 100
    return rounded == rounded.rounded() ? String(Int(rounded)) : String(rounded)
  }
  /// A number as the daemon would show it once set, so the row shows the change before the answer.
  public static func display(_ f: ProfileField, value: String?) -> String {
    guard let value, let n = Double(value) else { return f.display }
    let whole = n == n.rounded() ? String(Int(n)) : String(n)
    if f.id.hasSuffix("Ms") {
      if Int(n) % 60_000 == 0 { return "\(Int(n) / 60_000) min" }
      return Int(n) % 1000 == 0 ? "\(Int(n) / 1000) s" : "\(whole) ms"
    }
    switch f.id {
    case "limits.maxTurns": return "\(whole) turns"
    case "limits.maxBudgetUsd": return "$\(whole)"
    case "children.budgetShare": return "\(Int((n * 100).rounded()))%"
    case "limits.stuckRepeats": return "\(whole) repeats"
    default: return whole
    }
  }
}

/// When a Recent work row's agent last moved, as a short age ("now", "4 min", "2 h", "3 d").
public func teamAge(ms: Int, now: Int) -> String {
  let s = max(0, (now - ms) / 1000)
  if s < 60 { return "now" }
  if s < 3600 { return "\(s / 60) min" }
  if s < 86_400 { return "\(s / 3600) h" }
  return "\(s / 86_400) d"
}
