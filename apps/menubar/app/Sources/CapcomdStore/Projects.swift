import Foundation

// Setting a folder up as a capcomd project from the app (capability `projects.setup`): `GET /v1/projects/inspect` fills
// the form and says what blocks it, `POST /v1/projects` writes what `capcomd setup project` writes. The window draws
// these states; every sentence it shows about the folder is the daemon's.

/// What a project has now (`values`), or what a setup wrote.
public struct ProjectSettings: Decodable, Sendable, Hashable {
  public var repo: String?
  /// "pr" or "direct".
  public var mode: String?
  public var target: String?
  /// "" for none.
  public var check: String
  /// "claude" and/or "codex".
  public var agents: [String]
  public var budgetUsd: Double?
  enum CodingKeys: String, CodingKey { case repo, mode, target, check, agents, budgetUsd }
  public init(repo: String? = nil, mode: String? = nil, target: String? = nil, check: String = "", agents: [String] = [], budgetUsd: Double? = nil) {
    self.repo = repo; self.mode = mode; self.target = target; self.check = check; self.agents = agents; self.budgetUsd = budgetUsd
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    repo = try c.decodeIfPresent(String.self, forKey: .repo); mode = try c.decodeIfPresent(String.self, forKey: .mode)
    target = try c.decodeIfPresent(String.self, forKey: .target); check = try c.decodeIfPresent(String.self, forKey: .check) ?? ""
    agents = try c.decodeIfPresent([String].self, forKey: .agents) ?? []; budgetUsd = try c.decodeIfPresent(Double.self, forKey: .budgetUsd)
  }
}

/// Something that blocks setting the folder up: a stable `code` and the daemon's sentence to show.
public struct ProjectProblem: Decodable, Sendable, Hashable {
  /// not_found, not_git, home, no_origin, not_github; an unknown code is shown by its message.
  public var code: String
  public var message: String
  public init(code: String, message: String) { self.code = code; self.message = message }
  /// The codes the daemon sends today.
  public static let notFound = "not_found", notGit = "not_git", home = "home", noOrigin = "no_origin", notGitHub = "not_github"
}

/// One AI the project can have workers for, with how its profiles would log in.
public struct ProjectAgent: Decodable, Sendable, Hashable, Identifiable {
  public struct Place: Decodable, Sendable, Hashable {
    public var sandbox: String; public var loggedIn: Bool
    /// "plan", "api_key", or nil when not logged in there.
    public var how: String?
    public init(sandbox: String, loggedIn: Bool, how: String? = nil) { self.sandbox = sandbox; self.loggedIn = loggedIn; self.how = how }
  }
  /// "claude" or "codex".
  public var provider: String
  public var label: String
  /// Logged in somewhere.
  public var loggedIn: Bool
  /// "subscription" or "apikey" (it bills per use: the form asks for a spend cap).
  public var auth: String
  public var places: [Place]
  public var id: String { provider }
  public var billsAPIKey: Bool { auth == "apikey" }
  public init(provider: String, label: String, loggedIn: Bool = false, auth: String = "subscription", places: [Place] = []) {
    self.provider = provider; self.label = label; self.loggedIn = loggedIn; self.auth = auth; self.places = places
  }
  enum CodingKeys: String, CodingKey { case provider, label, loggedIn, auth, places }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    provider = try c.decode(String.self, forKey: .provider); label = try c.decodeIfPresent(String.self, forKey: .label) ?? provider
    loggedIn = try c.decodeIfPresent(Bool.self, forKey: .loggedIn) ?? false; auth = try c.decodeIfPresent(String.self, forKey: .auth) ?? "subscription"
    places = try c.decodeIfPresent([Place].self, forKey: .places) ?? []
  }
}

/// `GET /v1/projects/inspect`: the folder's checkout, origin, branches, a check and the agents, and what blocks setup.
public struct ProjectInspection: Decodable, Sendable, Hashable {
  public var path: String
  /// The checkout the folder is in (a folder inside one resolves to it); nil when it isn't in one.
  public var root: String?
  /// Its name in capcomd's projects.
  public var name: String?
  public var configured: Bool
  /// When configured: what it has now, to prefill the form.
  public var values: ProjectSettings?
  /// origin as an https URL: the repository setup uses (never typed in the app).
  public var repo: String?
  /// "owner/name" when origin is on GitHub.
  public var github: String?
  /// `gh` is logged in on the daemon's machine: pull requests can be used.
  public var ghReady: Bool
  public var defaultBranch: String
  public var branches: [String]
  /// "" for none.
  public var suggestedCheck: String
  public var suggestedMode: String
  public var suggestedAgents: [String]
  public var agents: [ProjectAgent]
  /// For `suggestedAgents`; for another choice ask `budgetAsked(for:)`.
  public var budgetAsked: Bool
  public var problems: [ProjectProblem]
  /// Nothing blocks it: the form can be submitted.
  public var canSetUp: Bool { problems.isEmpty && root != nil }
  /// Mode "pr" can be chosen (a GitHub origin and `gh` logged in); otherwise only "direct".
  public var pullRequestsAvailable: Bool { ghReady && github != nil }
  /// Whether the form asks for a spend cap when these agents are chosen (one of them bills an API key).
  public func budgetAsked(for chosen: [String]) -> Bool { agents.contains { chosen.contains($0.provider) && $0.billsAPIKey } }

  public init(path: String, root: String? = nil, name: String? = nil, configured: Bool = false, values: ProjectSettings? = nil, repo: String? = nil,
              github: String? = nil, ghReady: Bool = false, defaultBranch: String = "main", branches: [String] = [], suggestedCheck: String = "",
              suggestedMode: String = "direct", suggestedAgents: [String] = ["claude"], agents: [ProjectAgent] = [], budgetAsked: Bool = false, problems: [ProjectProblem] = []) {
    self.path = path; self.root = root; self.name = name; self.configured = configured; self.values = values; self.repo = repo; self.github = github
    self.ghReady = ghReady; self.defaultBranch = defaultBranch; self.branches = branches; self.suggestedCheck = suggestedCheck; self.suggestedMode = suggestedMode
    self.suggestedAgents = suggestedAgents; self.agents = agents; self.budgetAsked = budgetAsked; self.problems = problems
  }
  enum CodingKeys: String, CodingKey { case path, root, name, configured, values, repo, github, ghReady, defaultBranch, branches, suggestedCheck, suggestedMode, suggestedAgents, agents, budgetAsked, problems }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    path = try c.decode(String.self, forKey: .path)
    root = try c.decodeIfPresent(String.self, forKey: .root); name = try c.decodeIfPresent(String.self, forKey: .name)
    configured = try c.decodeIfPresent(Bool.self, forKey: .configured) ?? false; values = try c.decodeIfPresent(ProjectSettings.self, forKey: .values)
    repo = try c.decodeIfPresent(String.self, forKey: .repo); github = try c.decodeIfPresent(String.self, forKey: .github)
    ghReady = try c.decodeIfPresent(Bool.self, forKey: .ghReady) ?? false; defaultBranch = try c.decodeIfPresent(String.self, forKey: .defaultBranch) ?? "main"
    branches = try c.decodeIfPresent([String].self, forKey: .branches) ?? []; suggestedCheck = try c.decodeIfPresent(String.self, forKey: .suggestedCheck) ?? ""
    suggestedMode = try c.decodeIfPresent(String.self, forKey: .suggestedMode) ?? "direct"
    suggestedAgents = try c.decodeIfPresent([String].self, forKey: .suggestedAgents) ?? ["claude"]
    agents = try c.decodeIfPresent(Lossy<ProjectAgent>.self, forKey: .agents)?.items ?? []
    budgetAsked = try c.decodeIfPresent(Bool.self, forKey: .budgetAsked) ?? false
    problems = try c.decodeIfPresent(Lossy<ProjectProblem>.self, forKey: .problems)?.items ?? []
  }
}

/// `POST /v1/projects`: the form's answers. The repository is never sent: it is the folder's origin, and `expectRepo`
/// (inspect's `repo`) lets the daemon refuse when that changed since.
public struct ProjectSetupRequest: Encodable, Sendable, Hashable {
  public var path: String
  /// "pr" or "direct".
  public var mode: String
  public var target: String
  /// "" for none.
  public var check: String
  public var agents: [String]
  /// Only when the form asked for a cap (`budgetAsked(for: agents)`); nil: no limit.
  public var budgetUsd: Double?
  public var expectRepo: String?
  public init(path: String, mode: String, target: String, check: String, agents: [String], budgetUsd: Double? = nil, expectRepo: String? = nil) {
    self.path = path; self.mode = mode; self.target = target; self.check = check; self.agents = agents; self.budgetUsd = budgetUsd; self.expectRepo = expectRepo
  }
  enum CodingKeys: String, CodingKey { case path, mode, target, check, agents, budgetUsd, expect }
  struct Expect: Encodable { var repo: String?
    func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: K.self); try c.encode(repo, forKey: .repo) }
    enum K: String, CodingKey { case repo } }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(path, forKey: .path); try c.encode(mode, forKey: .mode); try c.encode(target, forKey: .target)
    try c.encode(check, forKey: .check); try c.encode(agents, forKey: .agents)
    try c.encodeIfPresent(budgetUsd, forKey: .budgetUsd)
    // Only what the form was filled from: without an inspection there is nothing to compare, so no `expect`.
    if let expectRepo { try c.encode(Expect(repo: expectRepo), forKey: .expect) }
  }
}

/// `POST /v1/projects` 200: the project as it is now, and whether anything changed.
public struct ProjectSetupResult: Decodable, Sendable, Hashable {
  public struct Project: Decodable, Sendable, Hashable {
    public var path: String
    /// The checkout: what runs are started in (`RunChoice.repo`, `prefs.startRepo`).
    public var root: String
    public var name: String
    public var configured: Bool
    public var values: ProjectSettings
    public init(path: String, root: String, name: String, configured: Bool = true, values: ProjectSettings) {
      self.path = path; self.root = root; self.name = name; self.configured = configured; self.values = values
    }
  }
  public var project: Project
  public var changed: Bool
  public init(project: Project, changed: Bool) { self.project = project; self.changed = changed }
}

public enum ProjectWire {
  public static func inspection(_ data: Data) throws -> ProjectInspection { try JSONDecoder().decode(ProjectInspection.self, from: data) }
  public static func result(_ data: Data) throws -> ProjectSetupResult { try JSONDecoder().decode(ProjectSetupResult.self, from: data) }
  public static func body(_ r: ProjectSetupRequest) throws -> Data { try JSONEncoder().encode(r) }
}

/// The folder the window shows.
public enum ProjectInspectState: Sendable, Hashable {
  case idle
  case loading(path: String)
  case loaded(ProjectInspection)
  /// It couldn't be read (an older capcomd, the token, the daemon down): the sentence to show.
  case failed(String)
}

/// The setup itself.
public enum ProjectSetupState: Sendable, Hashable {
  case idle
  case saving
  /// The daemon (or the app) said no: its sentence, and the form field it is about when it says (path, mode, target,
  /// check, agents, budgetUsd).
  case refused(message: String, field: String?)
  /// Set up: new runs now go to `result.project.root`.
  case done(ProjectSetupResult)
}

extension CapcomdStore {
  public static let projectSetupNeedsUpdate = "Update capcomd to set up projects here."
  public static let projectSetupNeedsConfigure = "Reset your token in Settings to set up projects."
  static let projectsUnreachable = "Couldn't reach capcomd. Try again."
  static let tokenRejected = "capcomd rejected this app's token."

  /// The daemon can set projects up (`projects.setup`).
  public var projectSetupSupported: Bool { capabilities.contains(Capability.projectsSetup) }

  /// Reads what the form needs for `path` (`GET /v1/projects/inspect`): `.loading`, then `.loaded` (with `problems` when
  /// it can't be set up) or `.failed` with a sentence. An answer for a folder that's no longer the one asked about is
  /// dropped. Without `projects.setup`: "Update capcomd to set up projects here."
  public func inspectProject(path: String) async {
    await ensureCapabilities()
    guard let projectSetter, projectSetupSupported else { projectInspect = .failed(Self.projectSetupNeedsUpdate); changed(); return }
    projectInspect = .loading(path: path); projectSetup = .idle; changed()
    let next: ProjectInspectState
    do { next = .loaded(try await projectSetter.inspectProject(path: path)) }
    catch is Unauthorized { unauthorized = true; next = .failed(Self.tokenRejected) }
    catch DetailUnavailable.unsupported { next = .failed(Self.projectSetupNeedsUpdate) }
    catch { next = .failed("Couldn't look at this folder just now. Try again.") }
    guard case .loading(let asked) = projectInspect, asked == path else { return }   // another folder was picked since
    projectInspect = next; changed()
  }

  /// Sets the inspected folder up (`POST /v1/projects`) with the form's answers; `expectRepo` is the inspected origin.
  /// `.saving`, then `.done` (new runs go to the project: `prefs.startRepo` becomes its root and the run options are
  /// read for it) or `.refused` with the daemon's sentence and field. A 409 (the folder changed) inspects it again. A
  /// token without `configure`: "Reset your token in Settings to set up projects." A retry of the same answers after a
  /// lost answer reuses its Idempotency-Key, so it is set up once.
  public func setUpProject(path: String, mode: String, target: String, check: String, agents: [String], budgetUsd: Double? = nil) async {
    await ensureCapabilities()
    guard let projectSetter, projectSetupSupported else { projectSetup = .refused(message: Self.projectSetupNeedsUpdate, field: nil); changed(); return }
    if configureDenied { projectSetup = .refused(message: Self.projectSetupNeedsConfigure, field: nil); changed(); return }
    if case .saving = projectSetup { return }
    var expect: String?
    if case .loaded(let i) = projectInspect, i.path == path || i.root == path { expect = i.repo }
    let request = ProjectSetupRequest(path: path, mode: mode, target: target, check: check, agents: agents, budgetUsd: budgetUsd, expectRepo: expect)
    let key = pendingSetupKey.flatMap { $0.request == request ? $0.key : nil } ?? makeKey()
    pendingSetupKey = (request, key)
    projectSetup = .saving; changed()
    do {
      let r = try await projectSetter.setUpProject(request, idempotencyKey: key)
      pendingSetupKey = nil
      prefs.startRepo = r.project.root
      projectSetup = .done(r); changed()
      await refreshRunOptions()
      return
    } catch ProjectSetupRefused.forbidden {
      pendingSetupKey = nil; configureDenied = true
      projectSetup = .refused(message: Self.projectSetupNeedsConfigure, field: nil)
    } catch ProjectSetupRefused.invalid(let message, let field) {
      pendingSetupKey = nil; projectSetup = .refused(message: message, field: field)
    } catch ProjectSetupRefused.conflict(let message, _) {
      pendingSetupKey = nil; projectSetup = .refused(message: message, field: "path"); changed()
      // Show the folder as it is now (its new origin); the refusal stays until the person tries again.
      let refusal = projectSetup
      await inspectProject(path: path)
      projectSetup = refusal
    } catch is Unauthorized {
      unauthorized = true; projectSetup = .refused(message: Self.tokenRejected, field: nil)
    } catch DetailUnavailable.unsupported {
      pendingSetupKey = nil; projectSetup = .refused(message: Self.projectSetupNeedsUpdate, field: nil)
    } catch {
      projectSetup = .refused(message: Self.projectsUnreachable, field: nil)   // key kept: the same answers retry safely
    }
    changed()
  }

  /// Back to no folder (the window closed).
  public func resetProjectSetup() { projectInspect = .idle; projectSetup = .idle; pendingSetupKey = nil; changed() }

  /// Capabilities come with the first daemon read; a window opened before it asks for them itself.
  func ensureCapabilities() async {
    guard capabilities.isEmpty, let daemonInfo, let h = try? await daemonInfo.health() else { return }
    capabilities = h.capabilities; daemonVersion = h.version
  }
}
