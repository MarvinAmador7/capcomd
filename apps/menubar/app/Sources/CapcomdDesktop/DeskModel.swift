#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import Observation
import CapcomdStore
import CapcomdLive
import CapcomdClient
import CapcomdThread
import CapcomdBot
import CapcomdUI

// State for the desktop window (design/desktop/SPEC.md §1, §6). The store reports what each change touched; this model
// keeps one small observable slice per agent and per thread, and assigns a slice only when its value differs. A view
// reads only its own slice, so a thread item arriving re-renders that column's rows and nothing else.

/// One agent as its column header and tab show it.
@Observable @MainActor
final class AgentSlice {
  let id: String
  private(set) var header: ColumnHeader
  private(set) var bot: BotTraits?
  /// The approval this agent waits on, if any.
  private(set) var approval: PendingApproval?
  /// Whether the column shows its thread (DeskModel's warm set); a cold column is its header and box only.
  private(set) var warm = false
  init(_ h: ColumnHeader) { id = h.agentId; header = h }
  func set(warm w: Bool) { if warm != w { warm = w } }
  func set(_ h: ColumnHeader) { if header != h { header = h } }
  func set(bot b: BotTraits?) { if bot != b { bot = b } }
  func set(approval a: PendingApproval?) { if approval != a { approval = a } }
}

/// One agent's thread as its column shows it.
@Observable @MainActor
final class ThreadSlice {
  private(set) var entries: [ThreadEntry] = []
  private(set) var pending: [PendingSteer] = []
  private(set) var unavailable: DetailUnavailable?
  func set(entries e: [ThreadEntry], pending p: [PendingSteer], unavailable u: DetailUnavailable?) {
    if entries != e { entries = e }
    if pending != p { pending = p }
    if unavailable != u { unavailable = u }
  }
}

/// Media bytes loaded through the daemon; rare, so one observed dictionary is enough.
@Observable @MainActor
final class MediaSlice { var items: [MediaKey: Fetched<Data>] = [:] }

@Observable @MainActor
final class DeskModel {
  enum Link: Equatable { case connecting, needsToken, ready }

  @ObservationIgnored private(set) var store: CapcomdStore
  @ObservationIgnored private var transport: UnixSocketTransport
  private(set) var link: Link = .connecting
  /// Every project with something to show, oldest first (never reordered by activity).
  private(set) var decks: [DeckInfo] = []
  /// The project the reel shows, and its run.
  private(set) var openProjectId: String?
  private(set) var openRunId: String?
  /// The open run's agents, in tree order: the reel's columns and the title bar's tabs.
  private(set) var columns: [String] = []
  /// The reel's leading on-screen column, as the reel reports it: once per column crossed, never per frame.
  private(set) var reelPosition: String?
  /// A scroll the reel carries out (a tab click, Follow, the keyboard, a project switch); `serial` makes a repeat count.
  private(set) var reelRequest: ReelRequest?
  var focusedAgent: String?
  /// Follow: an ask or a failure in the open project scrolls the reel to its column (SPEC §3).
  var follow = true
  /// Columns across the window (3, 2 or 1), set by the reel when its width crosses a step.
  var across = 3
  /// The column ids on screen, for the title bar's bracket: derived from the scroll position, never tracked per frame.
  var onScreen: Set<String> {
    let start = reelPosition.flatMap { columns.firstIndex(of: $0) } ?? 0
    return Set(columns.dropFirst(start).prefix(across))
  }

  @ObservationIgnored private var agents: [String: AgentSlice] = [:]
  @ObservationIgnored private var threads: [String: ThreadSlice] = [:]
  @ObservationIgnored let mediaSlice = MediaSlice()
  @ObservationIgnored private var teams: [String: (sig: String, bots: [String: BotTraits])] = [:]
  @ObservationIgnored private var knownAsks: Set<String> = []

  init() {
    (store, transport) = Connection.makeStore(token: "")
    if let env = ProcessInfo.processInfo.environment["CAPCOMD_TOKEN"], !env.isEmpty { connect(env); return }
    Task.detached(priority: .userInitiated) {
      let token = Keychain.token()
      await MainActor.run { [weak self] in self?.connect(token) }
    }
  }

  // MARK: connection

  private func connect(_ token: String?) {
    guard let token, !token.isEmpty else { link = .needsToken; return }
    let old = transport
    (store, transport) = Connection.makeStore(token: token)
    Task { try? await old.shutdown() }
    store.onChanges = { [weak self] keys in self?.apply(keys) }
    store.start()
    link = .ready
    apply([.all])
  }

  /// A pasted token: saved to the Keychain item the menu bar app uses too.
  func submit(token raw: String) -> Bool {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, Keychain.save(t) else { return false }
    store.stop(); connect(t); return true
  }

  // MARK: changes

  /// The store changed: refresh only what the keys name. `.all` refreshes everything, comparing before assigning.
  func apply(_ keys: Set<ChangeKey>) {
    if store.unauthorized { link = .needsToken; return }
    let all = keys.contains(.all)
    if all {
      let d = store.decks()
      if decks != d { decks = d }
      if openProjectId == nil || !d.contains(where: { $0.id == openProjectId }) { select(d.first(where: { $0.askingAgentId != nil })?.id ?? d.first?.id) }
      else if let deck = d.first(where: { $0.id == openProjectId }), deck.runId != openRunId { select(deck.id) }
    }
    guard let runId = openRunId else { return }
    let touchesRun = all || keys.contains(.run(runId))
    if touchesRun {
      let cols = store.reelColumns(runId: runId)
      let ids = cols.map(\.agentId)
      if columns != ids { columns = ids; warm(around: columns.firstIndex(of: reelPosition ?? "") ?? 0); startWarming() }
      let bots = all ? team(runId) : nil
      let asks = all ? Dictionary(store.approvals(forRun: runId).compactMap { a in a.agentId.map { ($0, a) } }, uniquingKeysWith: { a, _ in a }) : nil
      for h in cols where all || keys.contains(.agent(h.agentId)) {
        let s = agents[h.agentId] ?? { let n = AgentSlice(h); agents[h.agentId] = n; return n }()
        s.set(h)
        if let bots { s.set(bot: bots[h.agentId]) }
        if let asks { s.set(approval: asks[h.agentId]) }
      }
      if let asks { followAsks(Set(asks.keys)) }
    }
    for (id, t) in threads where all || keys.contains(.thread(id)) {
      t.set(entries: store.threadEntries(agentId: id), pending: store.pendingSteers(agentId: id), unavailable: store.threadUnavailable[id])
    }
    if all { for (k, v) in store.media where mediaSlice.items[k] != v { mediaSlice.items[k] = v } }
  }

  /// A new ask in the open project scrolls the reel to it while Follow is on; an answered ask never moves it.
  private func followAsks(_ asking: Set<String>) {
    let new = asking.subtracting(knownAsks)
    knownAsks = asking
    guard follow, let first = columns.first(where: new.contains) else { return }
    scroll(to: first)
  }

  /// Bots for every agent of the run, made distinct as a team; recomputed only when the run's agents change, so a
  /// newcomer never changes an earlier agent's bot.
  private func team(_ runId: String) -> [String: BotTraits] {
    guard let run = store.runs[runId] else { return [:] }
    let list = run.agents.values.sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) }
    let sig = list.map { "\($0.id):\($0.kind.rawValue)" }.joined(separator: ",")
    if let t = teams[runId], t.sig == sig { return t.bots }
    let traits = botTeam(list.map { (seed: $0.id, role: Optional($0.kind.rawValue)) })
    let bots = Dictionary(uniqueKeysWithValues: zip(list.map(\.id), traits))
    teams[runId] = (sig, bots)
    return bots
  }

  // MARK: projects and columns

  /// Show a project (a deck click, ⌘1–9). Keyboard switches don't animate; the reel starts at its ask, if any.
  func open(project id: String?) {
    guard select(id) else { return }
    apply([.all])
  }

  /// Switches the reel to the project's run without refreshing; returns whether the run changed.
  @discardableResult private func select(_ id: String?) -> Bool {
    let deck = decks.first { $0.id == id }
    openProjectId = deck?.id
    let run = deck?.runId
    guard run != openRunId else { return false }
    openRunId = run
    agents = [:]; threads = [:]; columns = []; warmOrder = []
    knownAsks = Set(deck?.askingAgentId.map { [$0] } ?? [])
    reelPosition = deck?.askingAgentId; focusedAgent = deck?.askingAgentId
    reelRequest = ReelRequest(agentId: deck?.askingAgentId, animated: false, serial: (reelRequest?.serial ?? 0) + 1)
    store.followThreads(runId: run, holder: CapcomdStore.reelHolder)
    return true
  }

  func agent(_ id: String) -> AgentSlice? { agents[id] }

  /// A folded deck's heads: its run's bots, cached per run until its agents change.
  func heads(_ deck: DeckInfo) -> [BotTraits] { let t = team(deck.runId); return deck.agentIds.compactMap { t[$0] } }

  /// Bring a column on screen and focus it. `animated` only for Follow and clicks, never for the keyboard (SPEC §4).
  func scroll(to agentId: String, animated: Bool = true) {
    focusedAgent = agentId
    guard !onScreen.contains(agentId) else { return }
    // Keep the column where it lands: the reel's leading column moves only as far as needed.
    let i = columns.firstIndex(of: agentId) ?? 0, start = columns.firstIndex(of: reelPosition ?? "") ?? 0
    let target = columns[i < start ? i : max(0, i - across + 1)]
    reelPosition = target
    reelRequest = ReelRequest(agentId: target, animated: animated, serial: (reelRequest?.serial ?? 0) + 1)
  }

  /// The reel's leading column changed (it scrolled, by hand or by request).
  func reelScrolled(toIndex i: Int) {
    let id = columns.indices.contains(i) ? columns[i] : columns.last
    if reelPosition != id { reelPosition = id }
    warm(around: i)
  }

  // MARK: warm columns

  // Every column of the open run exists for as long as the run is open, so scrolling only moves them. A column's
  // thread (the costly part to build) is made once, when the column is "warmed", and kept: the on-screen columns and
  // one each side at once, the rest one at a time while the reel stands still, nearest first, up to `warmCap`. Past
  // the cap the least recently shown thread is let go (its data stays in the store).

  static let warmCap = 32
  /// Set by the reel: warming waits while it moves, so it never competes with a scroll for a frame.
  @ObservationIgnored var reelMoving = false
  @ObservationIgnored private var warmOrder: [String] = []
  @ObservationIgnored private var warmer: Task<Void, Never>?

  private func warm(around i: Int) {
    guard !columns.isEmpty else { return }
    let lo = max(0, i - 1), hi = min(columns.count - 1, i + across)
    if lo <= hi { for id in columns[lo...hi] { warm(id) } }
  }

  private func warm(_ id: String) {
    guard let a = agents[id] else { return }
    a.set(warm: true)
    if warmOrder.last != id { warmOrder.removeAll { $0 == id }; warmOrder.append(id) }
    while warmOrder.count > Self.warmCap { agents[warmOrder.removeFirst()]?.set(warm: false) }
  }

  private func startWarming() {
    warmer?.cancel()
    warmer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(40))
        guard let self else { return }
        if self.reelMoving { continue }
        let at = self.columns.firstIndex(of: self.reelPosition ?? "") ?? 0
        let cold = self.columns.indices.filter { self.agents[self.columns[$0]]?.warm == false }
        guard self.warmOrder.count < Self.warmCap, let next = cold.min(by: { abs($0 - at) < abs($1 - at) }) else { return }
        self.warm(self.columns[next])
      }
    }
  }

  func goToProject(_ n: Int) { if decks.indices.contains(n) { open(project: decks[n].id) } }
  func goToAgent(_ n: Int) { if columns.indices.contains(n) { scroll(to: columns[n], animated: false) } }
  func moveFocus(_ by: Int) {
    let i = focusedAgent.flatMap { columns.firstIndex(of: $0) } ?? 0
    let j = min(max(0, i + by), columns.count - 1)
    if columns.indices.contains(j) { scroll(to: columns[j], animated: false) }
  }

  /// The column's thread, created when the column first shows (its pages load then, not before).
  func thread(_ agentId: String) -> ThreadSlice {
    if let t = threads[agentId] { return t }
    let t = ThreadSlice(); threads[agentId] = t
    t.set(entries: store.threadEntries(agentId: agentId), pending: store.pendingSteers(agentId: agentId), unavailable: store.threadUnavailable[agentId])
    return t
  }

  /// Read the column's thread from the route, then again slowly in case the stream dropped a frame.
  func keepThreadFresh(agentId: String) async {
    guard let runId = openRunId else { return }
    while !Task.isCancelled {
      await store.refreshThread(runId: runId, agentId: agentId)
      try? await Task.sleep(for: .seconds(15))
    }
  }

  func steer(agentId: String, body: String) {
    guard let runId = openRunId else { return }
    Task { await store.steer(runId: runId, agentId: agentId, body: body) }
  }

  func decide(_ approvalId: String, _ d: ApprovalDecision) { Task { _ = await store.decide(approvalId, d) } }
}

struct ReelRequest: Equatable {
  /// nil: the first column.
  var agentId: String?
  var animated: Bool
  var serial: Int
}

extension DeskModel: ThreadHost {
  func bot(runId: String, agentId: String) -> BotTraits? { agents[agentId]?.bot }
  func agentProvider(runId: String, agentId: String) -> Provider? { agents[agentId]?.header.provider }
  func role(runId: String, agentId: String) -> String? { agents[agentId]?.header.name }
  func media(_ key: MediaKey) -> Fetched<Data>? { mediaSlice.items[key] }
  func loadMedia(_ key: MediaKey) async { await store.loadMedia(key); mediaSlice.items[key] = store.media[key] }
  func openAgent(runId: String, agentId: String) { scroll(to: agentId) }
}
#endif
