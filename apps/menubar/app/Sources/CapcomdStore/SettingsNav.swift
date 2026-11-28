// The Settings window's navigation and search (design/desktop/settings): one window, a sidebar of pages and a pane;
// a place on Runs pushes its own page; Back and Forward walk pages and pushed pages alike; search lists every row's
// label with its page, and opening a result rings the card it is on. Pure, so it is tested here.

/// A page in the sidebar. `status` is the capcomd status row's page (the service and this app's token).
public enum SettingsPage: String, CaseIterable, Sendable, Hashable {
  case status, general, notifications, interface, shortcuts, runs, accounts, about

  public var title: String {
    switch self {
    case .status: "capcomd"; case .general: "General"; case .notifications: "Notifications"; case .interface: "Interface"
    case .shortcuts: "Shortcuts"; case .runs: "Runs"; case .accounts: "Accounts"; case .about: "About"
    }
  }
  /// The sidebar's groups, in order (General · Notifications | Interface · Shortcuts | Runs · Accounts | About).
  public static let groups: [[SettingsPage]] = [[.general, .notifications], [.interface, .shortcuts], [.runs, .accounts], [.about]]
}

/// Where the pane is: a page, or a place's own page pushed from Runs (by the place's name: "docker", "boxd").
public enum SettingsRoute: Sendable, Hashable {
  case page(SettingsPage)
  case place(String)

  /// The sidebar row that stays selected (a place belongs to Runs).
  public var page: SettingsPage {
    switch self { case .page(let p): p; case .place: .runs }
  }
}

/// Back and Forward (⌘[ ⌘]) over every page and pushed page shown.
public struct SettingsNav: Sendable, Hashable {
  public private(set) var current: SettingsRoute
  public private(set) var back: [SettingsRoute] = []
  public private(set) var forward: [SettingsRoute] = []
  public static let limit = 50

  public init(_ start: SettingsRoute = .page(.general)) { current = start }

  public var canGoBack: Bool { !back.isEmpty }
  public var canGoForward: Bool { !forward.isEmpty }

  /// Shows `route`; the one before goes on the Back list and Forward is cleared. The same route again does nothing.
  public mutating func go(_ route: SettingsRoute) {
    guard route != current else { return }
    back.append(current)
    if back.count > Self.limit { back.removeFirst(back.count - Self.limit) }
    forward = []
    current = route
  }
  public mutating func goBack() {
    guard let r = back.popLast() else { return }
    forward.append(current)
    current = r
  }
  public mutating func goForward() {
    guard let r = forward.popLast() else { return }
    back.append(current)
    current = r
  }
}

/// Settings search: every row's label and its page, plus the places and logins the store holds.
public enum SettingsSearch {
  public struct Entry: Sendable, Hashable, Identifiable {
    /// What the result reads ("Claude Code logins", "Logins · Cloud").
    public var title: String
    public var route: SettingsRoute
    /// The card it rings when opened.
    public var card: String
    /// Other words that find it ("dock" finds Show app icon).
    public var keywords: [String] = []
    public var id: String { "\(card)/\(title)" }
    public init(_ title: String, _ route: SettingsRoute, card: String, keywords: [String] = []) {
      self.title = title; self.route = route; self.card = card; self.keywords = keywords
    }
    /// The page the result names on its right ("Accounts"; a place's rows "Runs").
    public var pageTitle: String { route.page.title }
  }

  /// A result: the entry, and where the query matched in its title (nil: it matched a keyword).
  public struct Result: Sendable, Hashable, Identifiable {
    public var entry: Entry
    public var match: Range<Int>?
    public var id: String { entry.id }
  }

  /// The fixed rows of every page, in page order.
  public static let fixed: [Entry] = {
    func g(_ t: String, _ card: String, _ k: [String] = []) -> Entry { Entry(t, .page(.general), card: card, keywords: k) }
    func n(_ t: String, _ card: String, _ k: [String] = []) -> Entry { Entry(t, .page(.notifications), card: card, keywords: k) }
    func i(_ t: String, _ card: String, _ k: [String] = []) -> Entry { Entry(t, .page(.interface), card: card, keywords: k) }
    func s(_ t: String, _ card: String) -> Entry { Entry(t, .page(.shortcuts), card: card, keywords: ["shortcut", "keyboard"]) }
    func r(_ t: String, _ card: String, _ k: [String] = []) -> Entry { Entry(t, .page(.runs), card: card, keywords: k) }
    func c(_ t: String, _ card: String, _ k: [String] = []) -> Entry { Entry(t, .page(.status), card: card, keywords: k) }
    var out: [Entry] = [
      c("Keep capcomd running", "status.service", ["service", "background", "daemon"]),
      c("App token", "status.app", ["token", "reset", "keychain"]),
      g("Version", "general.version", ["update", "capcomd"]),
      g("Dock icon", "general.appIcon", ["app icon", "orange", "night", "mono"]),
      g("Menu bar icon", "general.appIcon", ["app icon", "dome", "antenna", "ring", "mark"]),
      g("Show app icon", "general.appIcon", ["dock", "menu bar"]),
      g("Menu bar moods", "general.appIcon", ["bot faces", "face"]),
      g("Open at login", "general.launch", ["launch", "startup"]),
      g("Keep .capcomd/ out of git", "general.newProjects", ["gitignore", "new projects"]),
      g("Show Onboarding Again", "general.onboarding", ["welcome", "intro"]),
      n("Approval requests", "notifications.notify", ["notify", "merge"]),
      n("Usage limits", "notifications.notify", ["notify", "quota"]),
      n("Finished runs", "notifications.notify", ["notify", "failed", "stopped"]),
      n("Badge app icon", "notifications.badge", ["dock", "needs you", "count"]),
      i("Layout", "interface.layout", ["reel", "sidebar", "tabs", "tab bar", "hover", "behavior"]),
      i("Columns across", "interface.reel", ["reel", "columns"]),
      i("Crew tabs", "interface.reel", ["reel", "tabs", "bot"]),
      i("Follow asks and failures", "interface.reel", ["follow"]),
      r("Project", "runs.newRuns", ["new runs", "folder", "repository"]),
      r("Driven by", "runs.newRuns", ["new runs", "driver", "planner"]),
      r("Model", "runs.newRuns", ["new runs", "planner"]),
      r("Effort", "runs.newRuns", ["new runs", "reasoning"]),
      r("Runs on", "runs.newRuns", ["new runs", "place", "local", "cloud", "default"]),
      r("Places", "runs.places", ["local", "cloud", "docker", "boxd"]),
    ]
    for group in Shortcuts.groups { for row in group.rows { out.append(s(row.title, "shortcuts.\(group.id)")) } }
    out.append(Entry("About capcomd", .page(.about), card: "about", keywords: ["version", "license", "github", "changelog"]))
    return out
  }()

  /// Everything search looks through: each AI's logins and the boxd key (Accounts) first, then every page's fixed rows,
  /// then each place's page.
  public static func entries(providers: [(id: String, name: String)], places: [(name: String, title: String)], boxd: Bool) -> [Entry] {
    var out: [Entry] = providers.map { Entry("\($0.name) logins", .page(.accounts), card: "accounts.\($0.id)", keywords: ["login", "log in", "account"]) }
    if boxd { out.append(Entry("boxd API key", .page(.accounts), card: "accounts.boxd", keywords: ["key", "cloud"])) }
    out += fixed
    for p in places {
      out.append(Entry(p.title, .place(p.name), card: "place.status", keywords: [p.name, "place", "set up", "default"]))
      out.append(Entry("Agent environment · \(p.title)", .place(p.name), card: "place.status", keywords: ["build", "rebuild", "environment"]))
      out.append(Entry("Machines · \(p.title)", .place(p.name), card: "place.machines", keywords: ["terminal", "delete", "idle"]))
      out.append(Entry("Logins · \(p.title)", .place(p.name), card: "place.safety", keywords: ["safety", "login"]))
      out.append(Entry("Checkpoints · \(p.title)", .place(p.name), card: "place.safety", keywords: ["safety"]))
    }
    return out
  }

  /// The entries that match `query` (case and accents ignored): titles that match at the start of a word first, then
  /// anywhere in the title, then by keyword; each group in page order. An empty query matches nothing.
  public static func results(_ query: String, in entries: [Entry], limit: Int = 12) -> [Result] {
    let q = fold(query.trimmingCharacters(in: .whitespacesAndNewlines))
    guard !q.isEmpty else { return [] }
    var word: [Result] = [], inner: [Result] = [], key: [Result] = []
    for e in entries {
      let t = fold(e.title)
      if let r = t.range(of: q) {
        let start = t.distance(from: t.startIndex, to: r.lowerBound), len = t.distance(from: r.lowerBound, to: r.upperBound)
        let atWord = start == 0 || !t[t.index(before: r.lowerBound)].isLetter
        let res = Result(entry: e, match: start..<(start + len))
        if atWord { word.append(res) } else { inner.append(res) }
      } else if e.keywords.contains(where: { fold($0).contains(q) }) {
        key.append(Result(entry: e, match: nil))
      }
    }
    var seen = Set<String>()
    return (word + inner + key).filter { seen.insert($0.id).inserted }.prefix(limit).map { $0 }
  }

  static func fold(_ s: String) -> String { s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil) }
}

/// Shortcuts, read-only (design/desktop/settings, Shortcuts): the window's menu items as DeskCommands binds them.
public enum Shortcuts {
  public struct Row: Sendable, Hashable { public var title: String; public var keys: String }
  public struct Group: Sendable, Hashable, Identifiable { public var id: String; public var title: String; public var rows: [Row] }

  public static let groups: [Group] = [
    Group(id: "window", title: "Window", rows: [
      Row(title: "Search", keys: "⌘K"), Row(title: "Home", keys: "⌘0"), Row(title: "New Project", keys: "⇧⌘N"),
      Row(title: "Toggle Sidebar", keys: "⌃⌘S"), Row(title: "Follow", keys: "⇧⌘F"),
    ]),
    Group(id: "panes", title: "Panes", rows: [
      Row(title: "Split Right", keys: "⌘D"), Row(title: "Split Down", keys: "⇧⌘D"), Row(title: "Expand Pane", keys: "⇧⌘↩"),
      Row(title: "Fold or Close", keys: "⌘W"),
    ]),
    Group(id: "projects", title: "Projects", rows: [
      Row(title: "Project 1–9", keys: "⌘1 – ⌘9"), Row(title: "Message the Planner", keys: "⌘L"), Row(title: "Pause or Resume", keys: "⌥⌘P"),
    ]),
    Group(id: "agents", title: "Agents", rows: [
      Row(title: "Agent 1–9", keys: "⌃1 – ⌃9"), Row(title: "Previous / Next Agent", keys: "⌃← ⌃→"), Row(title: "Next Ask", keys: "⌘J"),
      Row(title: "Approve", keys: "↩"),
    ]),
  ]
}
