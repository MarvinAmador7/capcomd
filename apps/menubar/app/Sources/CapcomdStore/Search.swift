import Foundation

// The desktop's Search ⌘K (design/desktop/rex/CommandK.dc.html, SPEC §2): one palette for what needs you, the agents,
// the projects and the commands, ranked in that order, over what the store already holds (no network search).
//
// Only titles and names are indexed. Each entry's text is folded (case and diacritics) once, when the entry is built,
// into one integer per character; a keystroke then compares small integer arrays and never reads a thread. The index
// is rebuilt per source (one run's agents, the asks, the projects, the commands), so a store change that names one run
// rebuilds that run's entries only.

/// The palette's groups, in the order they rank.
public enum SearchGroup: Int, Sendable, Hashable, Comparable, CaseIterable {
  case needsYou, recent, agents, projects, commands
  /// Sentence case, as the board's section headers.
  public var title: String {
    switch self {
    case .needsYou: "Needs you"; case .recent: "Recent"; case .agents: "Agents"; case .projects: "Projects"; case .commands: "Commands"
    }
  }
  public static func < (a: Self, b: Self) -> Bool { a.rawValue < b.rawValue }
}

/// What a result does when it's opened.
public enum SearchAction: Sendable, Hashable {
  /// That agent's column, in its project (the project opens first).
  case agent(runId: String, agentId: String)
  /// That project, at its ask if it has one.
  case project(runId: String)
  /// An item of the open project's menu (Message the planner…, Changes, Pause, Resume, Stop…, Fold, Copy run ID).
  case menu(ProjectMenu.Item)
  /// Approve the focused column's ask.
  case approve(approvalId: String)
  case newProject, home, settings
  case follow(Bool)
  /// The Needs you reel: show it (true) or leave it; ⌘J, the next ask.
  case needsReel(Bool)
  case nextAsk
}

/// The one icon a row shows.
public enum SearchIcon: Sendable, Hashable {
  /// The agent's catalog bot.
  case bot(runId: String, agentId: String)
  /// The project's place (Local or Cloud).
  case place(sandbox: String?)
  case symbol(String)
}

/// What sits at a row's trailing edge.
public enum SearchTrailing: Sendable, Hashable {
  case none
  /// A quiet word: "working", "queued", "done".
  case status(String)
  /// A decision waiting on you, in amber with the hand: "asks", "usage limit".
  case ask(String)
  /// The command's shortcut, as plain glyphs ("⌥⌘P").
  case shortcut(String)
  /// Changes: "+73 −5 · 3 files".
  case changes(added: Int?, removed: Int?, files: Int?)
  /// A short id (Copy run ID).
  case code(String)
}

/// Text folded for matching: one key per character (lowercased, without diacritics), and where words start.
public struct SearchText: Sendable, Hashable {
  public let text: String
  let chars: Int
  let keys: [UInt32]
  let starts: [Bool]

  public init(_ text: String) {
    self.text = text
    var keys: [UInt32] = [], starts: [Bool] = []
    keys.reserveCapacity(text.count); starts.reserveCapacity(text.count)
    var prevAlnum = false, prevLower = false
    for c in text {
      keys.append(Self.key(c))
      let alnum = c.isLetter || c.isNumber
      starts.append(alnum && (!prevAlnum || (prevLower && c.isUppercase)))
      prevAlnum = alnum; prevLower = c.isLowercase
    }
    self.keys = keys; self.starts = starts; chars = keys.count
  }

  /// A character's key: ASCII is lowercased directly; anything else is folded by Foundation.
  static func key(_ c: Character) -> UInt32 {
    if let a = c.asciiValue { return UInt32(a >= 65 && a <= 90 ? a + 32 : a) }
    return String(c).folding(options: [.caseInsensitive, .diacriticInsensitive], locale: nil).unicodeScalars.first?.value ?? 0
  }

  /// A query's words, folded.
  public static func tokens(_ query: String) -> [[UInt32]] {
    query.split(whereSeparator: \.isWhitespace).map { $0.map(key) }
  }

  /// Where `token` matches, and how well: the whole text starting with it, then a word starting with it, then it
  /// anywhere, then its characters in order from a word start (fuzzy). Nil: no match.
  func match(_ token: [UInt32]) -> (score: Int, at: [Int])? {
    let m = token.count, n = chars
    guard m > 0, m <= n else { return nil }
    let first = token[0]
    var best: (score: Int, start: Int)?
    var i = 0
    while i + m <= n {
      if keys[i] == first {
        var j = 1
        while j < m && keys[i + j] == token[j] { j += 1 }
        if j == m {
          let s = i == 0 ? 1000 : starts[i] ? 800 : 500
          if best == nil || s > best!.score { best = (s, i) }
          if s == 1000 { break }
        }
      }
      i += 1
    }
    if let b = best { return (b.score - min(n - m, 60), Array(b.start..<(b.start + m))) }
    guard m >= 2 else { return nil }
    // Fuzzy: from each word start that begins with the token's first character, take each next character at the
    // nearest word start that has it, else the nearest place; the best placement wins.
    var fuzzy: (score: Int, at: [Int])?
    for s in 0..<n where starts[s] && keys[s] == first {
      var at = [s]; at.reserveCapacity(m)
      var p = s + 1, ok = true
      for k in 1..<m {
        let want = token[k]
        var q = p, plain = -1, word = -1
        while q < n {
          if keys[q] == want {
            if plain < 0 { plain = q }
            if starts[q] { word = q; break }
            if q == plain && q == p { break }   // the very next character: keep the run going
          }
          q += 1
        }
        let pick = plain == p ? plain : word >= 0 ? word : plain
        guard pick >= 0 else { ok = false; break }
        at.append(pick); p = pick + 1
      }
      guard ok else { continue }
      var score = 300
      for (k, x) in at.enumerated() {
        if starts[x] { score += 20 }
        if k > 0 && at[k - 1] == x - 1 { score += 12 }
        if k > 0 { score -= min(x - at[k - 1] - 1, 8) }
      }
      score -= min(s, 20)
      if fuzzy == nil || score > fuzzy!.score { fuzzy = (score, at) }
    }
    return fuzzy
  }
}

/// One thing the palette can show.
public struct SearchItem: Sendable, Hashable, Identifiable {
  public var id: String
  public var group: SearchGroup
  public var title: SearchText
  /// Dimmed after the title (the project and profile of an agent, a project's place), searched too; it truncates first.
  public var subtitle: SearchText?
  public var icon: SearchIcon
  public var trailing: SearchTrailing
  /// Destructive (Stop…): drawn in system red.
  public var destructive = false
  public var action: SearchAction
  /// The agent it is about (an agent row, or the agent an ask waits on): one agent shows once.
  public var agentId: String?
  /// Shown before anything is typed (the common commands).
  public var common = false

  public init(id: String, group: SearchGroup, title: String, subtitle: String? = nil, icon: SearchIcon, trailing: SearchTrailing = .none,
              destructive: Bool = false, action: SearchAction, agentId: String? = nil, common: Bool = false) {
    self.id = id; self.group = group; self.title = SearchText(title); self.subtitle = subtitle.map(SearchText.init); self.icon = icon
    self.trailing = trailing; self.destructive = destructive; self.action = action; self.agentId = agentId; self.common = common
  }
}

/// A result: the item, which characters of its title and subtitle matched (to draw them bolder), and its score.
public struct SearchHit: Sendable, Hashable, Identifiable {
  public var item: SearchItem
  /// The group it shows under (an item from Recent keeps its own `group` for what it is).
  public var group: SearchGroup
  public var titleHits: [Int]
  public var subtitleHits: [Int]
  public var score: Int
  public var id: String { "\(group.rawValue).\(item.id)" }
}

public struct SearchSection: Sendable, Hashable, Identifiable {
  public var group: SearchGroup
  public var hits: [SearchHit]
  public var id: Int { group.rawValue }
}

/// Every searchable item, by source, and the query over them.
public struct SearchIndex: Sendable {
  public private(set) var asks: [SearchItem] = []
  /// Each shown project's agents, by run, and the runs in the projects' order.
  public private(set) var agents: [String: [SearchItem]] = [:]
  public private(set) var runs: [String] = []
  public private(set) var projects: [SearchItem] = []
  public private(set) var commands: [SearchItem] = []
  /// Bumped on every change, so a narrowed query knows its candidates are still the index's.
  public private(set) var version = 0
  /// At most this many rows per group once something is typed: the list stays a list, and a keystroke never lays out
  /// hundreds of rows.
  public static let groupCap = 24
  /// Before anything is typed: the recent items and the common commands.
  public static let recentCap = 3, commonCap = 6

  public init() {}

  public mutating func set(asks a: [SearchItem]) { if asks != a { asks = a; version &+= 1 } }
  public mutating func set(projects p: [SearchItem]) { if projects != p { projects = p; version &+= 1 } }
  public mutating func set(commands c: [SearchItem]) { if commands != c { commands = c; version &+= 1 } }
  public mutating func set(agents a: [SearchItem], run: String) { if agents[run] != a { agents[run] = a; version &+= 1 } }
  /// The shown projects' runs, in order; agents of runs no longer shown leave the index.
  public mutating func set(runs r: [String]) {
    guard runs != r else { return }
    runs = r
    let keep = Set(r)
    agents = agents.filter { keep.contains($0.key) }
    version &+= 1
  }

  public var count: Int { asks.count + agents.values.reduce(0) { $0 + $1.count } + projects.count + commands.count }

  /// Everything, in rank order: what needs you, the agents (their projects' order, then tree order), the projects,
  /// the commands. An agent that needs you shows there only.
  public var all: [SearchItem] {
    let asking = Set(asks.compactMap(\.agentId))
    return asks + runs.flatMap { agents[$0] ?? [] }.filter { !asking.contains($0.agentId ?? "") } + projects + commands
  }

  /// The query's results by group. `among`: only these items can match (the previous, shorter query's hits: a longer
  /// query never matches more); nil, all of them.
  public func search(_ query: String, among: Set<String>? = nil) -> (sections: [SearchSection], matched: Set<String>) {
    let tokens = SearchText.tokens(query)
    guard !tokens.isEmpty else { return ([], []) }
    var byGroup: [SearchGroup: [(hit: SearchHit, order: Int)]] = [:]
    var matched = Set<String>()
    for (order, item) in all.enumerated() {
      if let among, !among.contains(item.id) { continue }
      guard let h = Self.match(tokens, item) else { continue }
      matched.insert(item.id)
      byGroup[item.group, default: []].append((h, order))
    }
    let sections = SearchGroup.allCases.compactMap { g -> SearchSection? in
      guard let list = byGroup[g], !list.isEmpty else { return nil }
      let ranked = list.sorted { ($0.hit.score, -$0.order) > ($1.hit.score, -$1.order) }.prefix(Self.groupCap).map(\.hit)
      return SearchSection(group: g, hits: Array(ranked))
    }
    return (sections, matched)
  }

  /// Before anything is typed (the board's inset): what needs you, then the recent items (`recent`, newest first, by
  /// item id; topped up with other projects), then the common commands.
  public func empty(recent: [String], exclude: Set<String> = []) -> [SearchSection] {
    var out: [SearchSection] = []
    let hit: (SearchItem, SearchGroup) -> SearchHit = { SearchHit(item: $0, group: $1, titleHits: [], subtitleHits: [], score: 0) }
    if !asks.isEmpty { out.append(SearchSection(group: .needsYou, hits: asks.prefix(Self.groupCap).map { hit($0, .needsYou) })) }
    let asking = Set(asks.compactMap(\.agentId))
    var byId: [String: SearchItem] = [:]
    for i in projects { byId[i.id] = i }
    for r in runs { for i in agents[r] ?? [] { byId[i.id] = i } }
    var seen = Set<String>()
    var recentItems: [SearchItem] = []
    for id in recent where recentItems.count < Self.recentCap {
      guard let i = byId[id], !exclude.contains(id), !asking.contains(i.agentId ?? ""), seen.insert(id).inserted else { continue }
      recentItems.append(i)
    }
    for p in projects where recentItems.count < Self.recentCap && !exclude.contains(p.id) && seen.insert(p.id).inserted { recentItems.append(p) }
    if !recentItems.isEmpty { out.append(SearchSection(group: .recent, hits: recentItems.map { hit($0, .recent) })) }
    let common = commands.filter(\.common).prefix(Self.commonCap)
    if !common.isEmpty { out.append(SearchSection(group: .commands, hits: common.map { hit($0, .commands) })) }
    return out
  }

  /// Every word typed must match the title or the subtitle; a title match counts double.
  static func match(_ tokens: [[UInt32]], _ item: SearchItem) -> SearchHit? {
    var score = 0, th: [Int] = [], sh: [Int] = []
    for t in tokens {
      let a = item.title.match(t), b = item.subtitle?.match(t)
      switch (a, b) {
      case let (a?, b?) where b.score > a.score * 2: score += b.score; sh += b.at
      case let (a?, _): score += a.score * 2; th += a.at
      case let (nil, b?): score += b.score; sh += b.at
      case (nil, nil): return nil
      }
    }
    return SearchHit(item: item, group: item.group, titleHits: th, subtitleHits: sh, score: score)
  }
}

// MARK: building the entries from the store

extension CapcomdStore {
  /// What an agent's row says it is doing.
  public static func searchStatus(_ s: AgentStatus, limit: String?) -> String {
    switch s {
    case .running: "working"; case .pending: "queued"; case .paused: limit == "quota" ? "usage limit" : "paused"
    case .done, .handedOff: "done"; case .failed: "failed"; case .cancelled: "stopped"; case .unknown: ""
    }
  }

  /// A project's agents, in tree order: the title (its own lowercase words), then the project and the profile.
  public func searchAgents(deck: DeckInfo) -> [SearchItem] {
    let agents = runs[deck.runId]?.agents ?? [:]
    return reelColumns(runId: deck.runId).map { h in
      let status = Self.searchStatus(h.status, limit: agents[h.agentId]?.limit)
      return SearchItem(id: "agent.\(h.agentId)", group: .agents, title: h.tabLabel, subtitle: "\(deck.title) · \(h.name)",
                        icon: .bot(runId: deck.runId, agentId: h.agentId), trailing: status.isEmpty ? .none : .status(status),
                        action: .agent(runId: deck.runId, agentId: h.agentId), agentId: h.agentId)
    }
  }

  /// What needs you, as the Needs you reel lists it (`needsAsks()`, oldest first): each agent's approval ("asks", or
  /// "question"), and each run's usage limit ("usage limit"), on the agent whose column shows it.
  public func searchAsks(decks: [DeckInfo]) -> [SearchItem] {
    let titles = Dictionary(decks.map { ($0.runId, $0.title) }, uniquingKeysWith: { a, _ in a })
    return needsAsks().compactMap { ask in
      guard let h = columnHeader(runId: ask.runId, agentId: ask.agentId) else { return nil }
      let project = titles[ask.runId] ?? runs[ask.runId]?.title ?? ""
      let word = ask.limit != nil ? "usage limit" : ask.approval?.kind == "question" ? "question" : "asks"
      let id = ask.approval.map { "ask.\($0.id)" } ?? "limit.\(ask.agentId)"
      return SearchItem(id: id, group: .needsYou, title: h.tabLabel, subtitle: "\(project) · \(h.name)", icon: .bot(runId: ask.runId, agentId: ask.agentId),
                        trailing: .ask(word), action: .agent(runId: ask.runId, agentId: ask.agentId), agentId: ask.agentId)
    }
  }

  /// The shown projects: name, then where it runs and its crew or how it ended.
  public static func searchProjects(_ decks: [DeckInfo]) -> [SearchItem] {
    decks.map { d in
      let place: String? = switch d.sandbox { case "docker"?, "fake-host"?: "Local"; case "boxd"?: "Cloud"; default: nil }
      let n = d.agentIds.count
      let what = d.endedHead.map { $0.prefix(1).lowercased() + $0.dropFirst() } ?? "\(n) \(n == 1 ? "agent" : "agents")"
      let trailing: SearchTrailing = d.askingAgentId != nil ? .ask("asks") : d.endedHead.map { .status($0.hasPrefix("Done") ? "done" : $0.hasPrefix("Failed") ? "failed" : $0.hasPrefix("Stopped") ? "stopped" : "ended") } ?? .none
      return SearchItem(id: "project.\(d.id)", group: .projects, title: d.title, subtitle: ([place, what] as [String?]).compactMap { $0 }.joined(separator: " · "),
                        icon: .place(sandbox: d.sandbox), trailing: trailing, action: .project(runId: d.runId))
    }
  }
}

/// What the commands depend on in the window: the open project's menu (none while Home shows), the focused column's ask,
/// Follow.
public struct SearchCommandContext: Sendable, Hashable {
  public var menu: ProjectMenu?
  public var projectTitle: String?
  /// The focused column's ask: its approval and how the agent is named.
  public var focusedAsk: String?
  public var follow: Bool
  public var homeShown: Bool
  /// How many asks wait (the Needs you reel and ⌘J have something to show), and whether the reel is open.
  public var asks: Int
  public var needsReelOpen: Bool
  public init(menu: ProjectMenu?, projectTitle: String?, focusedAsk: String?, follow: Bool, homeShown: Bool, asks: Int = 0, needsReelOpen: Bool = false) {
    self.menu = menu; self.projectTitle = projectTitle; self.focusedAsk = focusedAsk; self.follow = follow; self.homeShown = homeShown
    self.asks = asks; self.needsReelOpen = needsReelOpen
  }
}

public enum SearchCommands {
  /// Only what the daemon and the app can do now, each with its shortcut. The open project's are named with it ("Pause
  /// migrate matchkey"), so typing the project finds them.
  public static func make(_ c: SearchCommandContext) -> [SearchItem] {
    var out: [SearchItem] = []
    func add(_ id: String, _ title: String, _ symbol: String, _ trailing: SearchTrailing = .none, destructive: Bool = false,
             _ action: SearchAction, common: Bool = false) {
      out.append(SearchItem(id: "command.\(id)", group: .commands, title: title, icon: .symbol(symbol), trailing: trailing, destructive: destructive,
                            action: action, common: common))
    }
    add("new", "New project", "plus", .shortcut("⇧⌘N"), .newProject, common: true)
    if let ask = c.focusedAsk { add("approve", "Approve the focused ask", "checkmark", .shortcut("↩"), .approve(approvalId: ask), common: true) }
    if c.asks > 0 {
      add("next-ask", "Next ask", "arrow.turn.down.right", .shortcut("⌘J"), .nextAsk, common: true)
      if !c.needsReelOpen { add("needs", "Show what needs you", "hand.raised", .none, .needsReel(true)) }
    }
    if c.needsReelOpen { add("needs-close", "Leave Needs you", "chevron.backward", .shortcut("esc"), .needsReel(false)) }
    let p = c.projectTitle ?? "the project"
    for item in c.menu?.items ?? [] {
      let key = item.shortcut.map(SearchTrailing.shortcut) ?? .none
      switch item {
      case .messagePlanner: add("message", "Message the planner of \(p)…", "bubble.left", key, .menu(item), common: true)
      case .changes(let a, let r, let f, _): add("changes", "Changes in \(p)", "plus.forwardslash.minus", .changes(added: a, removed: r, files: f), .menu(item))
      case .pause: add("pause", "Pause \(p)", "pause", key, .menu(item), common: true)
      case .resume: add("resume", "Resume \(p)", "play", key, .menu(item), common: true)
      case .stop: add("stop", "Stop \(p)…", "stop", destructive: true, .menu(item))
      case .fold: add("fold", "Fold \(p) into the title bar", "chevron.down", key, .menu(item))
      case .remove: add("remove", "Remove \(p) from the title bar", "eye.slash", key, .menu(item))
      case .copyRunId(let short): add("copy", "Copy the run ID of \(p)", "doc.on.doc", .code(short), .menu(item))
      }
    }
    add("home", "Home", "house", .shortcut("⌘0"), .home, common: !c.homeShown)
    add("follow", c.follow ? "Turn Follow off" : "Turn Follow on", "eye", .shortcut("⇧⌘F"), .follow(!c.follow))
    add("settings", "Settings", "gearshape", .shortcut("⌘,"), .settings, common: true)
    return out
  }
}
