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
  /// "" for none; nil: not sent, so the daemon uses the project's current check, else the one it suggests (`projects.git`).
  public var check: String?
  public var agents: [String]
  /// Only when the form asked for a cap (`budgetAsked(for: agents)`); nil: no limit.
  public var budgetUsd: Double?
  public var expectRepo: String?
  /// Make sure git ignores `.capcomd/` in the checkout (`projects.git`); sent only when true.
  public var gitignore: Bool
  public init(path: String, mode: String, target: String, check: String? = nil, agents: [String], budgetUsd: Double? = nil, expectRepo: String? = nil, gitignore: Bool = false) {
    self.path = path; self.mode = mode; self.target = target; self.check = check; self.agents = agents; self.budgetUsd = budgetUsd; self.expectRepo = expectRepo
    self.gitignore = gitignore
  }
  enum CodingKeys: String, CodingKey { case path, mode, target, check, agents, budgetUsd, expect, gitignore }
  struct Expect: Encodable { var repo: String?
    func encode(to encoder: Encoder) throws { var c = encoder.container(keyedBy: K.self); try c.encode(repo, forKey: .repo) }
    enum K: String, CodingKey { case repo } }
  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(path, forKey: .path); try c.encode(mode, forKey: .mode); try c.encode(target, forKey: .target)
    try c.encodeIfPresent(check, forKey: .check); try c.encode(agents, forKey: .agents)
    try c.encodeIfPresent(budgetUsd, forKey: .budgetUsd)
    if gitignore { try c.encode(true, forKey: .gitignore) }
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

/// One account a repository can be created as (`GET /v1/projects/publish-options` `accounts`).
public struct ProjectPublishAccount: Decodable, Sendable, Hashable, Identifiable {
  public var login: String
  /// "user" (the GitHub CLI's login) or "org" (an organization it belongs to).
  public var kind: String
  public var id: String { login }
  public var isOrganization: Bool { kind == "org" }
  public init(login: String, kind: String = "user") { self.login = login; self.kind = kind }
}

/// A file the first commit would publish that looks like it holds a secret.
public struct ProjectBlockedFile: Decodable, Sendable, Hashable, Identifiable {
  /// Relative to the checkout.
  public var path: String
  /// The daemon's words, e.g. "an environment file, which usually holds secrets".
  public var reason: String
  public var id: String { path }
  public init(path: String, reason: String) { self.path = path; self.reason = reason }
}

/// `GET /v1/projects/publish-options`: what the publish form needs for a checkout without origin.
public struct ProjectPublishOptions: Decodable, Sendable, Hashable {
  /// The GitHub CLI is logged in on the daemon's machine; false: publishing is refused (show how to log in).
  public var ghReady: Bool
  /// The gh user first, then its organizations; empty without `ghReady`.
  public var accounts: [ProjectPublishAccount]
  /// The folder's name as GitHub takes it.
  public var suggestedName: String
  /// false: publishing makes the first commit of `files` files.
  public var hasCommits: Bool
  /// What publishing puts on GitHub: the first commit's files, or HEAD's when there are commits.
  public var files: Int
  /// Likely secrets among them: without commits, publishing is refused while any is listed.
  public var blocked: [ProjectBlockedFile]
  /// The branch that is pushed.
  public var branch: String
  public var root: String?
  /// Publishing can go ahead as far as the daemon can tell before trying.
  public var canPublish: Bool { ghReady && !accounts.isEmpty && (hasCommits || (blocked.isEmpty && files > 0 && files <= Self.maxFirstCommitFiles)) }
  /// The most files a first commit may hold (the daemon refuses more: add a .gitignore).
  public static let maxFirstCommitFiles = 2000
  public init(ghReady: Bool, accounts: [ProjectPublishAccount] = [], suggestedName: String, hasCommits: Bool = false, files: Int = 0,
              blocked: [ProjectBlockedFile] = [], branch: String = "main", root: String? = nil) {
    self.ghReady = ghReady; self.accounts = accounts; self.suggestedName = suggestedName; self.hasCommits = hasCommits; self.files = files
    self.blocked = blocked; self.branch = branch; self.root = root
  }
  enum CodingKeys: String, CodingKey { case ghReady, accounts, suggestedName, hasCommits, files, blocked, branch, root }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    ghReady = try c.decodeIfPresent(Bool.self, forKey: .ghReady) ?? false
    accounts = try c.decodeIfPresent(Lossy<ProjectPublishAccount>.self, forKey: .accounts)?.items ?? []
    suggestedName = try c.decodeIfPresent(String.self, forKey: .suggestedName) ?? ""
    hasCommits = try c.decodeIfPresent(Bool.self, forKey: .hasCommits) ?? false
    files = try c.decodeIfPresent(Int.self, forKey: .files) ?? 0
    blocked = try c.decodeIfPresent(Lossy<ProjectBlockedFile>.self, forKey: .blocked)?.items ?? []
    branch = try c.decodeIfPresent(String.self, forKey: .branch) ?? "main"
    root = try c.decodeIfPresent(String.self, forKey: .root)
  }
}

public enum ProjectWire {
  public static func inspection(_ data: Data) throws -> ProjectInspection { try JSONDecoder().decode(ProjectInspection.self, from: data) }
  public static func result(_ data: Data) throws -> ProjectSetupResult { try JSONDecoder().decode(ProjectSetupResult.self, from: data) }
  public static func body(_ r: ProjectSetupRequest) throws -> Data { try JSONEncoder().encode(r) }
  public static func publishOptions(_ data: Data) throws -> ProjectPublishOptions { try JSONDecoder().decode(ProjectPublishOptions.self, from: data) }
  public static func gitInitBody(path: String) throws -> Data { try JSONSerialization.data(withJSONObject: ["path": path], options: [.sortedKeys]) }
  public static func publishBody(path: String, owner: String, name: String, visibility: String) throws -> Data {
    try JSONSerialization.data(withJSONObject: ["path": path, "owner": owner, "name": name, "visibility": visibility], options: [.sortedKeys])
  }
}

/// Publishing the inspected checkout to GitHub (and starting its repository: `initGit` reports refusals here too).
public enum ProjectPublishState: Sendable, Hashable {
  case idle
  case loadingOptions
  case ready(ProjectPublishOptions)
  case publishing
  /// The daemon said no: its sentence, and the field it is about when it says (owner, name, visibility, files, identity,
  /// gh, path).
  case refused(message: String, field: String?)
  /// It didn't happen (capcomd unreachable or too old, the GitHub CLI failed): the sentence to show.
  case failed(String)
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

  /// The daemon can start a folder's repository and publish it to GitHub (`projects.git`).
  public var projectGitSupported: Bool { capabilities.contains(Capability.projectsGit) }
  public static let projectGitNeedsUpdate = "Update capcomd to publish projects from here."

  /// Starts a git repository in the inspected folder (`POST /v1/projects/git-init`, for a folder inspect said isn't a
  /// checkout). `initializingGit` while on its way; then `projectInspect` is `.loaded` with the folder as it is now (its
  /// problem is no_origin: publish it next), or `projectPublish` says why not (`.refused` with the daemon's sentence and
  /// field, or `.failed`).
  public func initGit(path: String) async {
    await ensureCapabilities()
    guard let projectSetter, projectGitSupported else { projectPublish = .failed(Self.projectGitNeedsUpdate); changed(); return }
    if configureDenied { projectPublish = .refused(message: Self.projectSetupNeedsConfigure, field: nil); changed(); return }
    if initializingGit { return }
    initializingGit = true; projectPublish = .idle; projectSetup = .idle; changed()
    do {
      let i = try await projectSetter.initGit(path: path)
      initializingGit = false
      projectInspect = .loaded(i); changed()
    } catch {
      initializingGit = false
      await gitRefused(error, path: path, unreachable: Self.projectsUnreachable)
    }
  }

  /// Reads what the publish form needs (`GET /v1/projects/publish-options`): `.loadingOptions`, then `.ready(options)`
  /// (also kept in `projectPublishOptions`), or `.refused` / `.failed` with a sentence.
  public func loadPublishOptions(path: String) async {
    await ensureCapabilities()
    guard let projectSetter, projectGitSupported else { projectPublish = .failed(Self.projectGitNeedsUpdate); changed(); return }
    projectPublish = .loadingOptions; changed()
    do {
      let o = try await projectSetter.publishOptions(path: path)
      guard case .loadingOptions = projectPublish else { return }   // published or reset meanwhile
      projectPublishOptions = o; projectPublish = .ready(o); changed()
    } catch {
      guard case .loadingOptions = projectPublish else { return }
      await gitRefused(error, path: path, unreachable: "Couldn't read this folder's publish options just now. Try again.")
    }
  }

  /// Publishes the inspected checkout to GitHub (`POST /v1/projects/publish`; `visibility` "private" or "public"):
  /// `.publishing`, then `projectInspect` is `.loaded` with the checkout as it is now (`github` set: set it up next) and
  /// `projectPublish` is `.idle`; or `.refused` with the daemon's sentence and field (`name` when it is taken, `files`
  /// for likely secrets or too many files, `identity`, `gh`, `owner`), or `.failed` (the GitHub CLI failed, capcomd
  /// unreachable). A 409 without a field (it has an origin now) inspects the folder again.
  public func publishProject(path: String, owner: String, name: String, visibility: String) async {
    await ensureCapabilities()
    guard let projectSetter, projectGitSupported else { projectPublish = .failed(Self.projectGitNeedsUpdate); changed(); return }
    if configureDenied { projectPublish = .refused(message: Self.projectSetupNeedsConfigure, field: nil); changed(); return }
    if case .publishing = projectPublish { return }
    projectPublish = .publishing; changed()
    do {
      let i = try await projectSetter.publishProject(path: path, owner: owner, name: name, visibility: visibility)
      projectPublish = .idle; projectPublishOptions = nil; projectSetup = .idle
      projectInspect = .loaded(i); changed()
    } catch {
      await gitRefused(error, path: path, unreachable: Self.projectsUnreachable)
    }
  }

  /// A git-init / publish error as `projectPublish`.
  func gitRefused(_ error: Error, path: String, unreachable: String) async {
    switch error {
    case ProjectSetupRefused.forbidden:
      configureDenied = true; projectPublish = .refused(message: Self.projectSetupNeedsConfigure, field: nil)
    case ProjectSetupRefused.invalid(let message, let field):
      projectPublish = .refused(message: message, field: field)
    case ProjectSetupRefused.conflict(let message, _):
      // The folder changed since it was inspected (a checkout now, an origin now): show it as it is.
      let refusal = ProjectPublishState.refused(message: message, field: "path")
      projectPublish = refusal; changed()
      await inspectProject(path: path)
      projectPublish = refusal
    case is Unauthorized:
      unauthorized = true; projectPublish = .failed(Self.tokenRejected)
    case DetailUnavailable.unsupported:
      projectPublish = .failed(Self.projectGitNeedsUpdate)
    case let m as MessageRefused:
      projectPublish = .failed(m.message)
    default:
      projectPublish = .failed(unreachable)
    }
    changed()
  }

  /// Sets the inspected folder up (`POST /v1/projects`) with the form's answers; `expectRepo` is the inspected origin.
  /// `.saving`, then `.done` (new runs go to the project: `prefs.startRepo` becomes its root and the run options are
  /// read for it) or `.refused` with the daemon's sentence and field. A 409 (the folder changed) inspects it again. A
  /// token without `configure`: "Reset your token in Settings to set up projects." A retry of the same answers after a
  /// lost answer reuses its Idempotency-Key, so it is set up once.
  /// `check` nil: not sent (the project's current check, else the one the daemon suggests; needs `projects.git`).
  /// `gitignore`: make sure git ignores `.capcomd/` in the checkout (`projects.git`).
  public func setUpProject(path: String, mode: String, target: String, check: String? = nil, agents: [String], budgetUsd: Double? = nil, gitignore: Bool = false) async {
    await ensureCapabilities()
    guard let projectSetter, projectSetupSupported else { projectSetup = .refused(message: Self.projectSetupNeedsUpdate, field: nil); changed(); return }
    if configureDenied { projectSetup = .refused(message: Self.projectSetupNeedsConfigure, field: nil); changed(); return }
    if case .saving = projectSetup { return }
    var expect: String?, check = check
    if case .loaded(let i) = projectInspect, i.path == path || i.root == path {
      expect = i.repo
      // A daemon from before projects.git needs a check: the one it would have used.
      if check == nil, !projectGitSupported { check = i.values?.check ?? i.suggestedCheck }
    }
    if check == nil, !projectGitSupported { check = "" }
    let request = ProjectSetupRequest(path: path, mode: mode, target: target, check: check, agents: agents, budgetUsd: budgetUsd, expectRepo: expect, gitignore: gitignore)
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
  public func resetProjectSetup() {
    projectInspect = .idle; projectSetup = .idle; pendingSetupKey = nil
    projectPublish = .idle; projectPublishOptions = nil
    changed()
  }

  /// Capabilities come with the first daemon read; a window opened before it asks for them itself.
  func ensureCapabilities() async {
    guard capabilities.isEmpty, let daemonInfo, let h = try? await daemonInfo.health() else { return }
    capabilities = h.capabilities; daemonVersion = h.version
  }
}
