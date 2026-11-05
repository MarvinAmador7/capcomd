import Foundation

// The desktop window's actions (design/desktop/SPEC.md §2, boards Home and ReelMenu): Home's composer, the
// open project's menu and the ⌘K palette, as data. Each offers only what this daemon and app can do; the views draw it.

extension Capability {
  /// `POST /v1/runs/{runId}/pause`, `/resume` and `/cancel`.
  public static let runControls = "run.controls"
}

// MARK: the new project column

/// Home's composer (Home.dc.html; before, the new project column): the goal, the planner-to-be's face (named in
/// the debug state), and where Start stands. The goal branch row is
/// the store's `GoalBranchSetup`; the folder's inline setup is `ProjectSetupFlow`.
public struct NewProjectForm: Sendable, Hashable {
  public enum Phase: Sendable, Hashable {
    case editing, starting
    /// The daemon took it: the column waits for the run's planner, then becomes its column.
    case started(runId: String)
  }
  public private(set) var goal = ""
  /// The planner-to-be smiles once something is typed: one change, and it never goes back to sleep.
  public private(set) var smiling = false
  public private(set) var phase: Phase = .editing
  /// The daemon's sentence about the last Start, and the field it names ("base", "goalBranch"; nil: the goal itself).
  public private(set) var refusal: String?
  public private(set) var refusedField: String?
  /// The goal branch row's choices for the checkout the run starts in.
  public var goalSetup = GoalBranchSetup()

  public init() {}

  public mutating func type(_ g: String) {
    goal = g
    if !isEmpty { smiling = true }
    goalSetup.setGoal(g)
  }
  /// An edit to a branch field puts away the last Start's refusal when it was about that field.
  public mutating func editedBranchField() { if refusedField != nil { refusal = nil; refusedField = nil } }

  public var isEmpty: Bool { goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
  /// Esc closes the column only while nothing is typed (and nothing is starting).
  public var escCloses: Bool { isEmpty && phase == .editing }

  /// Start can go: a goal, nothing starting already, no folder's next steps in the tool row's place, and, when the
  /// branch row shows, a base picked (never a guessed main) and no known problem with either name.
  public func canStart(branches: Bool, setupShowing: Bool) -> Bool {
    phase == .editing && !isEmpty && !setupShowing && (!branches || goalSetup.canStart)
  }

  public mutating func starting() { phase = .starting; refusal = nil; refusedField = nil }
  /// How Start ended: started (the column waits for its planner) or refused, with the daemon's sentence under the field
  /// it names.
  public mutating func finished(_ s: StartState, field: String?) {
    switch s {
    case .started(let id): phase = .started(runId: id)
    case .failed(let m), .needsRepo(let m): phase = .editing; refusal = m; refusedField = field
    case .idle, .starting: phase = .editing
    }
  }

  /// Under the goal: a refusal that isn't about a branch field shown in the row.
  public func goalLine(branches: Bool) -> String? {
    guard let r = refusal else { return nil }
    if branches, ["base", "goalBranch"].contains(refusedField ?? "") { return nil }
    return r
  }
  public var baseLine: GoalSetupLine? { goalSetup.baseLine(refusedField: refusedField, refusal: refusal) }
  public var branchLine: GoalSetupLine? { goalSetup.branchLine(refusedField: refusedField, refusal: refusal) }
}

// MARK: the project menu

/// The open project's menu (ReelMenu): what the project is (its goal, repos and place), then only the actions the
/// daemon and the app have. Trace and Browse the workspace aren't offered: the desktop has no view for either yet.
public struct ProjectMenu: Sendable, Hashable {
  public enum Item: Sendable, Hashable {
    /// Focus the planner's message box (its column comes on screen).
    case messagePlanner
    /// The run's changes, counted when the daemon said, opened as the goal branch against its base on GitHub.
    case changes(added: Int?, removed: Int?, files: Int?, url: URL)
    case pause, resume
    /// Asks first: it cancels every agent.
    case stop
    /// Fold the running project back into its deck; a finished one is removed from the title bar until it has news.
    case fold, remove
    case copyRunId(short: String)

    public var title: String {
      switch self {
      case .messagePlanner: "Message the planner…"
      case .changes: "Changes"
      case .pause: "Pause project"
      case .resume: "Resume project"
      case .stop: "Stop project…"
      case .fold: "Fold into the title bar"
      case .remove: "Remove from the title bar"
      case .copyRunId: "Copy run ID"
      }
    }
    public var shortcut: String? {
      switch self {
      case .messagePlanner: "⌘L"
      case .pause, .resume: "⌥⌘P"
      case .fold, .remove: "⌘W"
      case .changes, .stop, .copyRunId: nil
      }
    }
    /// A stable name (palette ids, the debug control file).
    public var name: String {
      switch self {
      case .messagePlanner: "message"; case .changes: "changes"; case .pause: "pause"; case .resume: "resume"; case .stop: "stop"
      case .fold: "fold"; case .remove: "remove"; case .copyRunId: "copy"
      }
    }
  }

  public var projectId: String
  public var runId: String
  /// The whole goal, as typed.
  public var goal: String
  /// The folders its agents work in.
  public var repos: [String]
  /// Where it runs ("docker", "boxd", …; nil when the daemon doesn't say), how many agents, when it started.
  public var sandbox: String?
  public var agents: Int
  public var startedAtMs: Int?
  /// The planner (the root agent), whose box Message the planner focuses.
  public var plannerId: String?
  /// Groups, separated in the menu: work with it, control it, its place in the title bar.
  public var sections: [[Item]]
  /// A Pause, Resume or Stop on its way, or why the last didn't go through.
  public var control: ControlState
  public var items: [Item] { sections.flatMap { $0 } }

  /// "run-7f3a2c1d…" → "run-7f3a2c": what the menu shows of the id (the whole id is copied).
  public static func shortId(_ id: String) -> String { id.count > 12 ? String(id.prefix(10)) : id }
}

extension CapcomdStore {
  /// The menu for the project's run. Pause / Resume and Stop need `run.controls` and a run that hasn't ended; Changes
  /// needs the run's goal branch on GitHub (its counts once the goal view is read); Message the planner needs a planner
  /// that still reads messages.
  public func projectMenu(projectId: String, runId: String) -> ProjectMenu? {
    guard let run = runs[runId] else { return nil }
    let cols = reelColumns(runId: runId)
    let planner = cols.first
    let ended = Run.terminalStates.contains(run.state) || !run.isActive
    var work: [ProjectMenu.Item] = []
    if !ended, let p = planner, !p.status.isTerminal { work.append(.messagePlanner) }
    if let card = goalCard(runId: runId), let url = card.diffURL {
      let c = goalViews[runId]?.value?.compare
      work.append(.changes(added: c?.added, removed: c?.removed, files: c.flatMap { $0.filesTotal ?? ($0.files.isEmpty ? nil : $0.files.count) }, url: url))
    }
    var control: [ProjectMenu.Item] = []
    if !ended, capabilities.contains(Capability.runControls) {
      control.append(pauseAction(runId: runId) == .resume ? .resume : .pause)
      control.append(.stop)
    }
    let place: [ProjectMenu.Item] = [ended ? .remove : .fold, .copyRunId(short: ProjectMenu.shortId(runId))]
    let repos = projects.first { $0.id == projectId }?.scopes ?? []
    return ProjectMenu(projectId: projectId, runId: runId, goal: run.goal?.plain ?? run.title, repos: repos, sandbox: run.sandbox,
                       agents: run.agents.count, startedAtMs: run.startedAtMs, plannerId: planner?.agentId,
                       sections: [work, control, place].filter { !$0.isEmpty }, control: controlState[runId] ?? .idle)
  }
}

// MARK: the ⌘K palette

/// What a palette entry does.
public enum PaletteAction: Sendable, Hashable {
  case menu(ProjectMenu.Item)
  /// Open that project (a deck's id).
  case project(String)
  case newProject
  /// Home (⌘0).
  case home
  case follow(Bool)
  /// Bring that agent's column on screen and focus it.
  case agent(String)
}

public struct PaletteEntry: Sendable, Hashable, Identifiable {
  public var id: String
  public var title: String
  /// Dimmed after the title (the project's place in the title bar, an agent's profile).
  public var detail: String?
  public var shortcut: String?
  public var action: PaletteAction
  public init(id: String, title: String, detail: String? = nil, shortcut: String? = nil, action: PaletteAction) {
    self.id = id; self.title = title; self.detail = detail; self.shortcut = shortcut; self.action = action
  }
}

/// The ⌘K palette's entries: the open project's menu, then new project and Follow, then switching projects and agents.
public enum Palette {
  public static func entries(menu: ProjectMenu?, decks: [DeckInfo], openProjectId: String?, agents: [ColumnHeader], follow: Bool) -> [PaletteEntry] {
    var out: [PaletteEntry] = []
    for item in menu?.items ?? [] {
      let detail: String? = if case .copyRunId(let s) = item { s } else { nil }
      out.append(PaletteEntry(id: "menu.\(item.name)", title: item.title, detail: detail, shortcut: item.shortcut, action: .menu(item)))
    }
    out.append(PaletteEntry(id: "home", title: "Home", shortcut: "⌘0", action: .home))
    out.append(PaletteEntry(id: "new", title: "New project", shortcut: "⇧⌘N", action: .newProject))
    out.append(PaletteEntry(id: "follow", title: follow ? "Turn Follow off" : "Turn Follow on", shortcut: "⇧⌘F", action: .follow(!follow)))
    for (n, d) in decks.enumerated() where d.id != openProjectId {
      out.append(PaletteEntry(id: "project.\(d.id)", title: "Switch to \(d.title)", shortcut: n < 9 ? "⌘\(n + 1)" : nil, action: .project(d.id)))
    }
    for (n, h) in agents.enumerated() {
      out.append(PaletteEntry(id: "agent.\(h.agentId)", title: "Focus \(h.tabLabel)", detail: h.title == nil ? nil : h.name,
                              shortcut: n < 9 ? "⌃\(n + 1)" : nil, action: .agent(h.agentId)))
    }
    return out
  }

  /// The entries whose words hold every word typed, in order: those whose title starts with what's typed first.
  public static func filter(_ entries: [PaletteEntry], _ query: String) -> [PaletteEntry] {
    let q = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
    guard !q.isEmpty else { return entries }
    let hits = entries.filter { e in
      let words = ([e.title] + (e.detail.map { [$0] } ?? [])).joined(separator: " ").lowercased()
        .split(whereSeparator: { !$0.isLetter && !$0.isNumber }).map(String.init)
      return q.allSatisfy { t in words.contains { $0.hasPrefix(t) } }
    }
    let lead = q.joined(separator: " ")
    return hits.filter { $0.title.lowercased().hasPrefix(lead) } + hits.filter { !$0.title.lowercased().hasPrefix(lead) }
  }
}
