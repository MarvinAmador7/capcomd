import Foundation

// The composer's inline project setup (design/setup/*.dc.html, spec design/setup/setup-spec.md): picking a folder that
// isn't a set-up capcomd project swaps the composer's tool row for that folder's next steps. `ProjectSetupFlow` runs it
// (pick → inspect → set up, or Initialize Git → Publish to GitHub → set up) and `SetupScreen` says what the card shows,
// so the view only draws. Platform-neutral, like the rest of the store.

extension UIPreferences {
  /// Settings › General › New projects: add `.capcomd/` to a project's .gitignore when the app sets it up. Off by
  /// default (commit it, so everyone on the project shares the setup).
  public var gitignoreCapcomd: Bool {
    get { store.string(forKey: "gitignoreCapcomd") == "1" }
    set { store.set(newValue ? "1" : "0", forKey: "gitignoreCapcomd") }
  }
}

// MARK: what the card shows

/// A run of callout text; `mono` spans are paths, commands and repositories.
public struct SetupSpan: Sendable, Hashable {
  public var text: String; public var mono: Bool
  public init(_ text: String, mono: Bool = false) { self.text = text; self.mono = mono }
}
/// A line under a row (`.rn`): grey, or orange (`warn`) for what needs doing; `logIn` adds the Log In… mini button
/// (the GitHub CLI, in Terminal).
public struct SetupNote: Sendable, Hashable {
  public var text: String; public var warn: Bool; public var logIn: Bool
  public init(_ text: String, warn: Bool = false, logIn: Bool = false) { self.text = text; self.warn = warn; self.logIn = logIn }
}
/// An agent chip in the Agents row.
public struct SetupAgentChip: Sendable, Hashable, Identifiable {
  public var provider: String; public var label: String
  /// Chosen.
  public var on: Bool
  /// Logged in somewhere: it can be chosen.
  public var enabled: Bool
  public var id: String { provider }
}
public enum SetupRow: Sendable, Hashable {
  /// "acme/my-app", with the GitHub mark.
  case repository(String)
  case target(String, choices: [String])
  /// "pr" or "direct"; pull requests can be picked only with `pullRequests`.
  case mode(String, target: String, pullRequests: Bool)
  case agents([SetupAgentChip])
  /// The field's text (USD); `valid`: empty or an amount over 0.
  case spendCap(String, valid: Bool)
  case account(String, accounts: [ProjectPublishAccount])
  case name(String, valid: Bool)
  /// "private" or "public".
  case visibility(String)
  public var id: String {
    switch self {
    case .repository: "repository"; case .target: "target"; case .mode: "mode"; case .agents: "agents"; case .spendCap: "budgetUsd"
    case .account: "owner"; case .name: "name"; case .visibility: "visibility"
    }
  }
}
public struct SetupRowItem: Sendable, Hashable, Identifiable {
  public var row: SetupRow; public var note: SetupNote?
  public var id: String { row.id }
}
/// What the buttons do.
public enum SetupAction: Sendable, Hashable { case setUp, setUpAndStart, initializeGit, openInTerminal, publish, logInToGitHub, tryAgain }
public struct SetupButton: Sendable, Hashable {
  public var title: String; public var action: SetupAction
  public var enabled: Bool
  /// Working: a spinner before the title, and it can't be pressed.
  public var busy: Bool
  public init(_ title: String, _ action: SetupAction, enabled: Bool = true, busy: Bool = false) { self.title = title; self.action = action; self.enabled = enabled; self.busy = busy }
}

/// The folder's next steps, under the goal in the composer card.
public struct SetupScreen: Sendable, Hashable {
  public enum Phase: Sendable, Hashable {
    /// Still looking at the folder: the tool row stays, the chip shows a spinner.
    case loading
    /// The setup form (Repository, Target branch, Changes land as, Agents, Spend cap).
    case form
    /// Something to do first (not a git checkout, not on GitHub, a sentence from the daemon).
    case attention
    /// Publish to GitHub (Account, Name, Visibility).
    case publish
  }
  public var phase: Phase
  /// The folder's name, on the chip and in the header.
  public var name: String
  /// The header line after the orange dot (`.nh`).
  public var header: String
  public var callout: [SetupSpan]?
  public var rows: [SetupRowItem] = []
  /// The rows are locked while publishing (dimmed, not editable).
  public var locked = false
  /// A refusal that isn't about one row, over the buttons.
  public var notice: SetupNote?
  /// Choose Another Folder… on the left.
  public var chooseAnother = false
  public var cancel = false
  public var primary: SetupButton?
}

// MARK: the flow

/// The answers in the setup form; filled from the inspection, then the person's.
public struct SetupAnswers: Sendable, Hashable {
  public var target: String
  /// "pr" or "direct".
  public var mode: String
  public var agents: [String]
  /// The spend cap field's text, in USD ("" for no limit).
  public var budget: String
  public static let defaultBudget = "5.00"
  public init(target: String, mode: String, agents: [String], budget: String = SetupAnswers.defaultBudget) {
    self.target = target; self.mode = mode; self.agents = agents; self.budget = budget
  }
  /// What the folder suggests: its default branch, pull requests when they can be used, the logged-in agents it suggests.
  public init(_ i: ProjectInspection) {
    let loggedIn = Set(i.agents.filter(\.loggedIn).map(\.provider))
    let known = Set(i.agents.map(\.provider))
    // An agent the daemon didn't describe can't be judged: keep the suggestion.
    let agents = i.suggestedAgents.filter { loggedIn.contains($0) || !known.contains($0) }
    self.init(target: i.values?.target ?? i.defaultBranch, mode: i.pullRequestsAvailable ? i.suggestedMode : "direct", agents: agents)
  }
  /// The cap as sent: nil for none (empty), or the amount; `.invalid` when it isn't one.
  public enum Budget: Sendable, Hashable { case none, amount(Double), invalid }
  public var budgetValue: Budget {
    let t = budget.trimmingCharacters(in: .whitespaces).replacingOccurrences(of: "$", with: "").trimmingCharacters(in: .whitespaces)
    if t.isEmpty { return .none }
    guard let v = Double(t), v > 0, v.isFinite else { return .invalid }
    return .amount(v)
  }
}

public struct PublishAnswers: Sendable, Hashable {
  public var owner: String; public var name: String
  /// "private" or "public".
  public var visibility: String
  public init(owner: String, name: String, visibility: String = "private") { self.owner = owner; self.name = name; self.visibility = visibility }
  public init(_ o: ProjectPublishOptions) {
    self.init(owner: (o.accounts.first { !$0.isOrganization } ?? o.accounts.first)?.login ?? "", name: o.suggestedName)
  }
  /// A name GitHub takes: letters, digits, ".", "_" and "-".
  public var nameValid: Bool {
    !name.isEmpty && name.count <= 100 && name != "." && name != ".." && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._-".contains($0)) }
  }
}

/// How a press of the primary ended, for the composer.
public enum SetupOutcome: Sendable, Hashable {
  /// Set up: the tool row is back; focus the goal.
  case setUp
  /// Set up and the run started with the goal.
  case started
  /// Set up, but the run didn't start (the composer's line says why).
  case startFailed
  /// Still showing (refused, or nothing to do).
  case showing
}

/// The inline setup for the folder picked in the composer. New runs keep going to the previous project until the folder
/// is set up; Cancel (or Esc, or the chip's ×) goes back to it.
@MainActor
public final class ProjectSetupFlow {
  struct Session {
    let id: Int
    var path: String
    /// The project new runs went to before the first pick: Cancel goes back to it.
    let previousRepo: String?
    var inspection: ProjectInspection?
    var answers: SetupAnswers?
    var publish: PublishAnswers?
    /// The last refusal, shown under its row until that answer changes (and while trying again).
    var refusal: (message: String, field: String?)?
    /// Published from here: "Published just now, private." under Repository.
    var published: String?
    var initFailed: String?
    /// The answers the person changed: a newer inspection keeps those and takes its own suggestions for the rest.
    var touched: Set<String> = []
  }
  let store: CapcomdStore
  var session: Session?
  var nextId = 0
  /// Something the card shows changed (the store's own changes come through its `onChange`).
  public var onChange: (() -> Void)?

  public init(store: CapcomdStore) { self.store = store }
  /// Initialize Git, Publish to GitHub and "Keep .capcomd/ out of git" need `projects.git`; without it the card shows the
  /// daemon's sentence for those folders, with Choose Another Folder… only.
  public var gitSupported: Bool { store.projectGitSupported }

  /// A folder is being looked at or set up.
  public var isOpen: Bool { session != nil }
  /// The folder being set up.
  public var path: String? { session?.path }
  public var answers: SetupAnswers? { session?.answers }
  public var publishAnswers: PublishAnswers? { session?.publish }

  /// The person picked `path` (the + menu's Choose Project Folder…, Choose Another Folder…, or the folder asked for when
  /// capcomd has no default project). A set-up project becomes where new runs go at once; any other folder shows its
  /// next steps. An older capcomd (no `projects.setup`) takes the folder as before. Returns true when new runs now go
  /// to it.
  @discardableResult
  public func pick(_ path: String) async -> Bool {
    nextId += 1
    let id = nextId
    session = Session(id: id, path: path, previousRepo: session?.previousRepo ?? store.prefs.startRepo)
    store.clearStart()
    changed()
    await store.inspectProject(path: path)
    guard session?.id == id else { return false }   // cancelled or another folder picked since
    switch store.projectInspect {
    case .failed(let m) where m == CapcomdStore.projectSetupNeedsUpdate:
      return await use(path)
    case .loaded(let i) where i.configured && i.canSetUp:
      return await use(i.root ?? path)
    case .loaded(let i):
      await take(i)
    default: break
    }
    changed()
    return false
  }

  /// Cancel, Esc or the chip's ×: back to the previous project, which new runs never stopped going to.
  public func cancel() {
    guard session != nil else { return }
    session = nil
    store.resetProjectSetup()
    changed()
  }

  /// Looks at the folder again (back from Terminal after a GitHub CLI login): the answers stay where they still apply.
  public func refresh() async {
    guard let s = session, s.inspection != nil, !isSaving, !isPublishing else { return }
    await store.inspectProject(path: s.path)
    guard session?.id == s.id, case .loaded(let i) = store.projectInspect else { changed(); return }
    // Set up in Terminal meanwhile (Open in Terminal): it's the project now.
    if i.configured && i.canSetUp { _ = await use(i.root ?? s.path); return }
    await take(i)
    changed()
  }

  // MARK: answers

  public func setTarget(_ t: String) { edit("target") { $0.target = t } }
  public func setMode(_ m: String) { edit("mode") { $0.mode = m } }
  public func toggleAgent(_ provider: String) {
    edit("agents") { a in if a.agents.contains(provider) { a.agents.removeAll { $0 == provider } } else { a.agents.append(provider) } }
  }
  public func setBudget(_ b: String) { edit("budgetUsd") { $0.budget = b } }
  public func setOwner(_ o: String) { editPublish("owner") { $0.owner = o } }
  public func setName(_ n: String) { editPublish("name") { $0.name = n } }
  public func setVisibility(_ v: String) { editPublish("visibility") { $0.visibility = v } }

  private func edit(_ field: String, _ f: (inout SetupAnswers) -> Void) {
    guard var a = session?.answers else { return }
    f(&a); session?.answers = a; session?.touched.insert(field)
    if session?.refusal?.field == field { session?.refusal = nil }
    changed()
  }
  private func editPublish(_ field: String, _ f: (inout PublishAnswers) -> Void) {
    guard var a = session?.publish else { return }
    f(&a); session?.publish = a
    if session?.refusal?.field == field { session?.refusal = nil }
    changed()
  }

  // MARK: actions

  /// Set Up, or Set Up and Start when a goal is typed: sets the folder up with the answers (no check: the daemon keeps
  /// the project's or uses its suggestion), then starts the run on `goal` with `start`. A refusal stays on the card under
  /// its row.
  public func submit(goal: String, start: (String) async -> Bool) async -> SetupOutcome {
    guard let s = session, let i = s.inspection, let a = s.answers, primaryEnabled(i, a, sandbox: nil) else { return .showing }
    let budget: Double?
    if spendCapShown(i, a, sandbox: store.startSandbox?.name), case .amount(let v) = a.budgetValue { budget = v } else { budget = nil }
    changed()
    await store.setUpProject(path: s.path, mode: a.mode, target: a.target, agents: a.agents, budgetUsd: budget,
                             gitignore: store.projectGitSupported && store.prefs.gitignoreCapcomd)
    guard session?.id == s.id else {
      // Cancelled while it was on its way: it may have been set up, but new runs go back to the previous project.
      if case .done = store.projectSetup { store.prefs.startRepo = s.previousRepo; store.resetProjectSetup(); await store.refreshRunOptions() }
      return .showing
    }
    switch store.projectSetup {
    case .done:
      session = nil; store.resetProjectSetup(); changed()
      let g = goal.trimmingCharacters(in: .whitespacesAndNewlines)
      if g.isEmpty { return .setUp }
      return await start(goal) ? .started : .startFailed
    case .refused(let message, let field):
      session?.refusal = (message, field)
      // A 409 inspected the folder again: show it as it is now.
      if case .loaded(let now) = store.projectInspect, now.path == s.path { sync(now) }
    default: break
    }
    changed()
    return .showing
  }

  /// Initialize Git: then the folder is a checkout with no origin, and publishing comes next.
  public func initializeGit() async {
    guard let s = session, gitSupported, !store.initializingGit else { return }
    session?.initFailed = nil; changed()
    await store.initGit(path: s.path)
    guard session?.id == s.id else { return }
    switch store.projectPublish {
    case .refused(let m, _), .failed(let m): session?.initFailed = m
    default: break
    }
    // The store has the folder as it is now (a checkout without origin), or looked again after a 409.
    if case .loaded(let i) = store.projectInspect, i.path == s.path { await take(i) }
    changed()
  }

  /// Publish to GitHub: creates the repository and pushes; then the usual setup, with the new repository filled in.
  public func publish() async {
    guard let s = session, let p = s.publish, p.nameValid, !p.owner.isEmpty, !isPublishing else { return }
    session?.refusal = nil; changed()
    await store.publishProject(path: s.path, owner: p.owner, name: p.name, visibility: p.visibility)
    guard session?.id == s.id else { return }
    switch store.projectPublish {
    case .refused(let m, let f):
      session?.refusal = (m, f)
      // A 409 about the folder (it has an origin now): the store looked again; show it as it is.
      if f == "path", case .loaded(let i) = store.projectInspect, i.path == s.path, i.github != nil { await take(i) }
      changed(); return
    case .failed(let m): session?.refusal = (m, nil); changed(); return
    default: break
    }
    // Published: the store has the checkout as it is now (on GitHub), ready for the usual setup.
    session?.published = p.visibility
    if case .loaded(let i) = store.projectInspect, i.path == s.path { await take(i) }
    changed()
  }

  // MARK: helpers

  var isSaving: Bool { if case .saving = store.projectSetup { return true }; return false }
  var isPublishing: Bool { if case .publishing = store.projectPublish { return true }; return false }

  /// Takes a newer inspection of the folder: answers that still apply stay.
  private func sync(_ i: ProjectInspection) {
    guard let touched = session?.touched else { return }
    var fresh = SetupAnswers(i)
    if let before = session?.answers {
      if touched.contains("target"), Self.targets(i).contains(before.target) { fresh.target = before.target }
      if touched.contains("mode"), before.mode == "direct" || i.pullRequestsAvailable { fresh.mode = before.mode }
      if touched.contains("agents") {
        let usable = Set(i.agents.filter(\.loggedIn).map(\.provider))
        fresh.agents = before.agents.filter { usable.contains($0) || i.agents.isEmpty }
      }
      fresh.budget = before.budget
    }
    session?.inspection = i
    session?.answers = fresh
  }
  /// Takes the inspection, then reads what publishing would do when the folder has no origin yet.
  private func take(_ i: ProjectInspection) async {
    sync(i)
    if Self.problem(i) == ProjectProblem.noOrigin, gitSupported { await loadPublish(i.path) }
  }
  private func loadPublish(_ path: String) async {
    guard session?.path == path else { return }
    await store.loadPublishOptions(path: path)
    guard session?.path == path else { return }
    if case .ready(let o) = store.projectPublish {
      if session?.publish == nil || !(o.accounts.contains { $0.login == session?.publish?.owner }) { session?.publish = PublishAnswers(o) }
      // Read again (back from Terminal): what the last publish said no to may be fixed now.
      if let f = session?.refusal?.field, ["gh", "files", "identity", "owner"].contains(f) { session?.refusal = nil }
    }
    changed()
  }

  private func use(_ root: String) async -> Bool {
    session = nil
    store.resetProjectSetup()
    store.prefs.startRepo = root
    changed()
    await store.refreshRunOptions()
    return true
  }

  private func changed() { onChange?() }

  static func problem(_ i: ProjectInspection) -> String? { i.problems.first?.code }
  /// The branches the target menu offers: the checkout's, with its default branch and the current pick.
  static func targets(_ i: ProjectInspection, current: String? = nil) -> [String] {
    var out: [String] = []
    for b in [i.defaultBranch] + i.branches + [current].compactMap({ $0 }) where !b.isEmpty && !out.contains(b) { out.append(b) }
    return out
  }

  /// The agents among `answers` that would bill an API key where new runs go (`sandbox`, the composer's Local / Cloud):
  /// only then is the spend cap asked. An agent the daemon says logs in by plan anywhere never bills a key.
  public static func billing(_ i: ProjectInspection, _ a: SetupAnswers, sandbox: String?) -> [ProjectAgent] {
    i.agents.filter { ag in
      a.agents.contains(ag.provider) && ag.billsAPIKey
        && (sandbox == nil || !ag.places.contains { $0.sandbox == sandbox } || ag.places.contains { $0.sandbox == sandbox && $0.how == "api_key" })
    }
  }
  func spendCapShown(_ i: ProjectInspection, _ a: SetupAnswers, sandbox: String?) -> Bool { !Self.billing(i, a, sandbox: sandbox).isEmpty }

  func primaryEnabled(_ i: ProjectInspection, _ a: SetupAnswers, sandbox: String?) -> Bool {
    guard i.canSetUp, !a.agents.isEmpty, !a.target.trimmingCharacters(in: .whitespaces).isEmpty, !isSaving else { return false }
    if a.mode == "pr" && !i.pullRequestsAvailable { return false }
    if spendCapShown(i, a, sandbox: sandbox ?? store.startSandbox?.name), a.budgetValue == .invalid { return false }
    return true
  }

  // MARK: the screen

  /// What the composer card shows for the picked folder, or nil when no folder is being set up. `goal`: the composer's
  /// text (a goal makes the primary Set Up and Start); `sandbox`: where new runs go (for the spend cap).
  public func screen(goal: String, sandbox: String?) -> SetupScreen? {
    guard let s = session else { return nil }
    let fallbackName = (s.path as NSString).lastPathComponent
    guard let i = s.inspection else {
      if case .failed(let m) = store.projectInspect {
        return SetupScreen(phase: .attention, name: fallbackName, header: "\(fallbackName) couldn't be checked.", callout: [SetupSpan(m)],
                           chooseAnother: true, primary: SetupButton("Try Again", .tryAgain))
      }
      return SetupScreen(phase: .loading, name: fallbackName, header: "")
    }
    let name = i.name ?? (i.root.map { ($0 as NSString).lastPathComponent }) ?? fallbackName
    switch Self.problem(i) {
    case nil: return form(i, s, name: name, goal: goal, sandbox: sandbox)
    case ProjectProblem.notGit:
      if gitSupported {
        let busy = store.initializingGit
        return SetupScreen(phase: .attention, name: name, header: "\(name) isn't a git checkout.",
                           callout: [SetupSpan("Initialize Git to start a repository in this folder, or choose your repository's folder.")],
                           notice: s.initFailed.map { SetupNote($0, warn: true) }, chooseAnother: true,
                           primary: SetupButton(busy ? "Initializing…" : "Initialize Git", .initializeGit, enabled: !busy, busy: busy))
      }
      return SetupScreen(phase: .attention, name: name, header: "\(name) isn't a git checkout.", callout: [SetupSpan(i.problems[0].message)], chooseAnother: true)
    case ProjectProblem.notGitHub:
      let where_ = Self.shortRepo(i.repo)
      let callout: [SetupSpan] = where_.map {
        [SetupSpan("Its repository is "), SetupSpan($0, mono: true), SetupSpan(". The app sets up GitHub projects; for others, run "),
         SetupSpan("capcomd setup project", mono: true), SetupSpan(" in Terminal.")]
      } ?? [SetupSpan("The app sets up GitHub projects; for others, run "), SetupSpan("capcomd setup project", mono: true), SetupSpan(" in Terminal.")]
      return SetupScreen(phase: .attention, name: name, header: "\(name) isn't on GitHub.", callout: callout, chooseAnother: true,
                         primary: SetupButton("Open in Terminal", .openInTerminal))
    case ProjectProblem.noOrigin:
      if gitSupported { return publishScreen(i, s, name: name) }
      return SetupScreen(phase: .attention, name: name, header: "\(name) isn't on GitHub yet.", callout: [SetupSpan(i.problems[0].message)], chooseAnother: true)
    default:
      return SetupScreen(phase: .attention, name: name, header: "\(name) can't be set up.", callout: [SetupSpan(i.problems[0].message)], chooseAnother: true)
    }
  }

  private func form(_ i: ProjectInspection, _ s: Session, name: String, goal: String, sandbox: String?) -> SetupScreen {
    let a = s.answers ?? SetupAnswers(i)
    let note: (String) -> SetupNote? = { f in s.refusal.flatMap { $0.field == f ? SetupNote($0.message, warn: true) : nil } }
    var rows: [SetupRowItem] = []
    if let gh = i.github {
      rows.append(SetupRowItem(row: .repository(gh), note: s.published.map { SetupNote("Published just now, \($0 == "public" ? "public" : "private").") }))
    }
    rows.append(SetupRowItem(row: .target(a.target, choices: Self.targets(i, current: a.target)), note: note("target")))
    let ghNote = i.github != nil && !i.ghReady ? SetupNote("Pull requests need the GitHub CLI logged in.", warn: true, logIn: true) : nil
    rows.append(SetupRowItem(row: .mode(a.mode, target: a.target, pullRequests: i.pullRequestsAvailable), note: note("mode") ?? ghNote))
    let chips = i.agents.map { SetupAgentChip(provider: $0.provider, label: $0.label, on: a.agents.contains($0.provider), enabled: $0.loggedIn) }
    let nobody = !i.agents.isEmpty && !i.agents.contains(where: \.loggedIn)
    rows.append(SetupRowItem(row: .agents(chips), note: note("agents") ?? (nobody ? SetupNote("Log in to Claude Code or Codex in Settings › Accounts first.", warn: true) : nil)))
    let billing = Self.billing(i, a, sandbox: sandbox)
    if !billing.isEmpty {
      let who = billing.map(\.label).joined(separator: " and ")
      let sub = billing.count == 1 ? "\(who) bills your API key. A run stops at this amount." : "\(who) bill your API keys. A run stops at this amount."
      rows.append(SetupRowItem(row: .spendCap(a.budget, valid: a.budgetValue != .invalid),
                               note: note("budgetUsd") ?? (a.budgetValue == .invalid ? SetupNote("An amount in USD over 0, or empty for no limit.", warn: true) : SetupNote(sub))))
    }
    let shown = Set(rows.map(\.id))
    // A refusal about something without a row (the folder, the check), or about nothing in particular.
    let general = s.refusal.flatMap { r in r.field.map { shown.contains($0) ? nil : SetupNote(r.message, warn: true) } ?? SetupNote(r.message, warn: true) }
    let saving = isSaving
    let start = !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    let primary = saving ? SetupButton("Setting Up…", start ? .setUpAndStart : .setUp, enabled: false, busy: true)
      : SetupButton(start ? "Set Up and Start" : "Set Up", start ? .setUpAndStart : .setUp, enabled: primaryEnabled(i, a, sandbox: sandbox))
    return SetupScreen(phase: .form, name: name, header: "\(name) isn't set up for capcomd yet.", rows: rows, notice: general, cancel: true, primary: primary)
  }

  private func publishScreen(_ i: ProjectInspection, _ s: Session, name: String) -> SetupScreen {
    let header = "\(name) isn't on GitHub yet."
    let refusal = s.refusal
    // The options last read: the store keeps them through a refusal and while publishing, so the rows stay put.
    guard let o = store.projectPublishOptions, o.root == nil || o.root == i.root || o.root == i.path else {
      switch store.projectPublish {
      case .refused(let m, _), .failed(let m):
        return SetupScreen(phase: .publish, name: name, header: header, notice: SetupNote(m, warn: true), chooseAnother: true,
                           primary: SetupButton("Try Again", .tryAgain))
      default:
        return SetupScreen(phase: .publish, name: name, header: header, chooseAnother: true,
                           primary: SetupButton("Publish to GitHub", .publish, enabled: false, busy: true))
      }
    }
    // The GitHub CLI is logged out (or the daemon just said so): log in first, then publish.
    if !o.ghReady || refusal?.field == "gh" {
      return SetupScreen(phase: .publish, name: name, header: header, callout: [SetupSpan("Publishing needs the GitHub CLI logged in on this Mac.")],
                         chooseAnother: true, primary: SetupButton("Log In to GitHub…", .logInToGitHub))
    }
    let p = s.publish ?? PublishAnswers(o)
    let note: (String) -> SetupNote? = { f in refusal.flatMap { $0.field == f ? SetupNote($0.message, warn: true) : nil } }
    let rows = [
      SetupRowItem(row: .account(p.owner, accounts: o.accounts), note: note("owner")),
      SetupRowItem(row: .name(p.name, valid: p.nameValid), note: note("name")),
      SetupRowItem(row: .visibility(p.visibility), note: note("visibility")),
    ]
    let repo = "github.com/\(p.owner)/\(p.name)", branch = o.branch
    let publishing = isPublishing
    let callout: [SetupSpan]
    if publishing {
      callout = [SetupSpan("Pushing "), SetupSpan(branch, mono: true), SetupSpan(" to "), SetupSpan(repo, mono: true), SetupSpan("…")]
    } else if o.hasCommits {
      callout = [SetupSpan("Creates "), SetupSpan(repo, mono: true), SetupSpan(" and pushes "), SetupSpan(branch, mono: true), SetupSpan(".")]
    } else {
      callout = [SetupSpan("Creates "), SetupSpan(repo, mono: true), SetupSpan(", commits the folder's \(o.files) \(o.files == 1 ? "file" : "files") as the first commit, and pushes "),
                 SetupSpan(branch, mono: true), SetupSpan(".")]
    }
    // What the daemon said no to that has no row (files, identity, the folder), else what it would refuse before trying.
    let rowFields: Set<String> = ["owner", "name", "visibility"]
    let general = refusal.flatMap { r in r.field.map { rowFields.contains($0) ? nil : SetupNote(r.message, warn: true) } ?? SetupNote(r.message, warn: true) }
      ?? Self.firstCommitProblem(o, name: name).map { SetupNote($0, warn: true) }
    let primary = publishing ? SetupButton("Publishing…", .publish, enabled: false, busy: true)
      : SetupButton("Publish to GitHub", .publish, enabled: o.canPublish && p.nameValid && !p.owner.isEmpty)
    return SetupScreen(phase: .publish, name: name, header: header, callout: callout, rows: rows, locked: publishing, notice: general,
                       chooseAnother: !publishing, primary: primary)
  }

  /// Why the daemon would refuse the first commit (`canPublish` false), in its words: likely secrets, too many files, none.
  static func firstCommitProblem(_ o: ProjectPublishOptions, name: String) -> String? {
    guard !o.hasCommits else { return nil }
    if !o.blocked.isEmpty {
      let one = o.blocked.count == 1
      let names = o.blocked.prefix(5).map(\.path).joined(separator: ", ") + (o.blocked.count > 5 ? " and \(o.blocked.count - 5) more" : "")
      return "\(names) \(one ? "looks like it holds" : "look like they hold") secrets, and the first commit would publish \(one ? "it" : "them"). Add \(one ? "it" : "them") to .gitignore, then publish."
    }
    if o.files > ProjectPublishOptions.maxFirstCommitFiles {
      return "The first commit would hold \(o.files) files (more than \(ProjectPublishOptions.maxFirstCommitFiles)), which usually means dependencies or build output are in it. Add a .gitignore for them, then publish."
    }
    if o.files == 0 { return "\(name) has no files to commit yet. Add your project's files, then publish." }
    return nil
  }

  /// "https://gitlab.com/acme/docs-site.git" → "gitlab.com/acme/docs-site".
  public static func shortRepo(_ url: String?) -> String? {
    guard var s = url, !s.isEmpty else { return nil }
    for p in ["https://", "http://", "ssh://", "git@"] where s.hasPrefix(p) { s.removeFirst(p.count) }
    if let at = s.firstIndex(of: "@"), s[..<at].allSatisfy({ $0 != "/" }) { s = String(s[s.index(after: at)...]) }
    if s.hasSuffix(".git") { s.removeLast(4) }
    return s.replacingOccurrences(of: ":", with: "/")
  }
}
