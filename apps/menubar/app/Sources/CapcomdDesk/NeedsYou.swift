#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import CapcomdBot
import CapcomdUI
import PerfLoopProbe

// The Needs you reel (design/desktop SPEC "Needs you reel", rex/RexNeedsReel.dc.html): every agent that waits on the
// user, across all projects, one column per ask, oldest first, each the approved Reel column with its ask bar. It runs
// on the reel's own AppKit machinery (ReelView, with this reel as its driver) and the same column renderer.
//
// The seam (the sidebar's hand and its "Needs you" heading call these): `DeskModel.openNeedsReel()`,
// `closeNeedsReel()`, `toggleNeedsReel()` and `nextAsk()` (⌘J). The list comes from the store's keyed changes
// (`CapcomdStore.needsAsks()` on an unnarrowed change, which is how approvals and pauses arrive), never a global
// revision; a narrowed change refreshes only the columns it names.

/// What a reel reports to and reads from the model it shows (ReelView): its leading column, whether it moves, the
/// columns across, and whether it is the one in front (a hidden reel takes no swipes).
@MainActor protocol ReelDriver: AnyObject {
  var reelMoving: Bool { get set }
  var across: Int { get set }
  var reelPosition: String? { get }
  /// The reel shows on screen: only then does it take sideways swipes over its area.
  var reelActive: Bool { get }
  func reelScrolled(toIndex i: Int)
  /// The person scrolled the reel to another column themselves.
  func scrolledByHand()
}

extension DeskModel: ReelDriver {
  var reelActive: Bool { !needs.isOpen }
  /// Scrolling yourself to another column turns Follow off (SPEC §3).
  func scrolledByHand() { if follow { follow = false } }
}

extension EnvironmentValues {
  /// The column is in the Needs you reel: every column there asks, so the amber ring is dropped (the ask bar carries
  /// it) and the column says which project it is from.
  @Entry var needsReel = false
}

/// Where an asking agent is from, as its column's context line says it ("migrate matchkey · worker").
package struct NeedsPlace: Equatable {
  package var project: String
  package var sandbox: String?
  package var role: String
}

@Observable @MainActor
package final class NeedsReel {
  @ObservationIgnored weak var model: DeskModel?
  /// How many asks there are (the hand's count), kept current whether the reel is open or not.
  package private(set) var count = 0 { didSet { Mutations.record("NeedsReel.count") } }
  package private(set) var isOpen = false { didSet { Mutations.record("NeedsReel.isOpen") } }
  /// The reel's columns: asking agents in the order they joined, oldest first; a newcomer joins at the end.
  package private(set) var columns: [String] = [] { didSet { Mutations.record("NeedsReel.columns") } }
  package private(set) var reelRequest: ReelRequest? { didSet { Mutations.record("NeedsReel.reelRequest") } }
  /// The leading column on screen, as the reel reports it.
  package private(set) var reelPosition: String? { didSet { Mutations.record("NeedsReel.reelPosition") } }
  /// "Back to fix email join": where Esc and Back go.
  package private(set) var backLabel = "Back" { didSet { Mutations.record("NeedsReel.backLabel") } }

  /// Every ask, oldest first (⌘J's order), as of the last unnarrowed change.
  @ObservationIgnored package private(set) var asks: [NeedsAsk] = []
  @ObservationIgnored private(set) var slices: [String: AgentSlice] = [:]
  /// Columns sliding out keep their slices until they're gone, so they don't go blank as they leave.
  @ObservationIgnored private var leaving: [String: AgentSlice] = [:]
  @ObservationIgnored private var threads: [String: ThreadSlice] = [:]
  @ObservationIgnored private(set) var places: [String: NeedsPlace] = [:]
  @ObservationIgnored private var followed: Set<String> = []
  @ObservationIgnored package var reelMoving = false
  @ObservationIgnored package var across = 3
  /// Whether the reel's next removal slides (an ask answered with the pointer, or elsewhere) or not (from the
  /// keyboard: keyboard actions never animate).
  @ObservationIgnored package private(set) var animatesRemoval = true
  @ObservationIgnored private var keyboardAnswers: Set<String> = []
  /// ⌘J's place: the last ask it opened.
  @ObservationIgnored package var cursor: NeedsAsk.Key?
  @ObservationIgnored private var back: (home: Bool, focused: String?)?
  static let holder = "needs:"

  init() {}

  func slice(_ id: String) -> AgentSlice? { slices[id] ?? leaving[id] }
  func place(_ id: String) -> NeedsPlace? { places[id] }
  package func ask(_ agentId: String) -> NeedsAsk? { asks.first { $0.agentId == agentId } }

  /// The column's thread when it isn't the open project's (whose threads the model keeps).
  func thread(_ id: String) -> ThreadSlice? {
    guard let model, slice(id) != nil else { return nil }
    if let t = threads[id] { return t }
    let s = model.store
    let t = ThreadSlice(agentId: id); threads[id] = t
    t.set(entries: s.threadEntries(agentId: id), pending: s.pendingSteers(agentId: id), unavailable: s.threadUnavailable[id],
          top: s.threadTop(agentId: id), loadingEarlier: s.threadLoadingEarlier.contains(id))
    return t
  }

  // MARK: changes

  /// The store changed. Approvals and pauses arrive unnarrowed, so the list is read again only then; a narrowed change
  /// (an activity line, a thread item) refreshes just the columns it names.
  func apply(_ keys: Set<ChangeKey>) {
    guard let model else { return }
    let all = keys.contains(.all)
    if all {
      asks = model.store.needsAsks()
      if count != asks.count { count = asks.count }
      if isOpen { reconcile() }
    }
    guard isOpen else { return }
    let touched = all ? columns : columns.filter { keys.contains(.agent($0)) }
    if !touched.isEmpty { refresh(touched, bots: all) }
    let s = model.store
    for (id, t) in threads where all || keys.contains(.thread(id)) {
      t.set(entries: s.threadEntries(agentId: id), pending: s.pendingSteers(agentId: id), unavailable: s.threadUnavailable[id],
            top: s.threadTop(agentId: id), loadingEarlier: s.threadLoadingEarlier.contains(id))
    }
  }

  /// The asks changed while the reel is open: answered ones leave (the next column takes the place), new ones join at
  /// the end, oldest first. Nothing else moves, so the column you are reading stays where it is.
  private func reconcile() {
    guard let model else { return }
    let now = Set(asks.map(\.agentId))
    let gone = columns.filter { !now.contains($0) }
    let added = asks.map(\.agentId).filter { !columns.contains($0) }
    guard !gone.isEmpty || !added.isEmpty else { return }
    animatesRemoval = !gone.contains(where: keyboardAnswers.contains)
    keyboardAnswers.subtract(gone)
    let old = columns
    let next = old.filter(now.contains) + added
    for g in gone { if let s = slices.removeValue(forKey: g) { leaving[g] = s } }
    if !gone.isEmpty {
      // A leaving column is drawn until its slide ends (≤ 0.3 s); its slice goes after.
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: .milliseconds(600))
        guard let self else { return }
        for g in gone where self.slices[g] == nil { self.leaving[g] = nil; self.threads[g] = nil }
      }
    }
    adopt(added)
    columns = next
    if !added.isEmpty { startWarming() }
    if let f = model.focusedAgent, gone.contains(f), let i = old.firstIndex(of: f) {
      // The column that takes the answered one's place takes its focus (Return answers it next).
      let before = old[..<i].filter(now.contains).count
      model.focusedAgent = next.isEmpty ? nil : next[min(before, next.count - 1)]
    }
    follow()
  }

  /// Slices for new columns, the reel's own (an agent of the open project too: its column here starts cold and warms
  /// in turn, and its thread data is the project reel's).
  private func adopt(_ ids: [String]) {
    guard let model, !ids.isEmpty else { return }
    for id in ids where slices[id] == nil {
      if let s = leaving.removeValue(forKey: id) { slices[id] = s; continue }
      guard let a = ask(id), let h = model.store.columnHeader(runId: a.runId, agentId: id) else { continue }
      slices[id] = AgentSlice(h)
    }
    refresh(ids, bots: true)
    let projects = model.store.projects
    for id in ids {
      guard let a = ask(id), let run = model.store.runs[a.runId] else { continue }
      let p = projects.first { $0.runs.contains { $0.id == a.runId } }
      places[id] = NeedsPlace(project: p?.title ?? run.titled?.text ?? RunTitle.untitled, sandbox: run.sandbox,
                              role: slices[id]?.header.name ?? run.agents[id]?.displayName ?? "agent")
    }
  }

  /// Header, bot, ask and focus for these columns, read once per run.
  private func refresh(_ ids: [String], bots: Bool) {
    guard let model else { return }
    var headers: [String: [String: ColumnHeader]] = [:]
    for id in ids {
      guard let s = slices[id], let a = ask(id) else { continue }
      if headers[a.runId] == nil {
        headers[a.runId] = Dictionary(model.store.reelColumns(runId: a.runId).map { ($0.agentId, $0) }, uniquingKeysWith: { a, _ in a })
      }
      if let h = headers[a.runId]?[id] { s.set(h) }
      if bots { s.set(bot: model.team(a.runId)[id]) }
      s.set(approval: a.approval)
      s.set(limit: a.limit)
      s.set(focused: id == model.focusedAgent)
    }
  }

  /// Each run with a column follows its live thread items while the reel is open (one stream per run, SPEC §1).
  private func follow() {
    guard let model else { return }
    let want = isOpen ? Set(columns.compactMap { ask($0)?.runId }) : []
    for r in followed.subtracting(want) { model.store.followThreads(runId: nil, holder: Self.holder + r) }
    for r in want.subtracting(followed) { model.store.followThreads(runId: r, holder: Self.holder + r) }
    followed = want
  }

  /// The focus flags of this reel's columns (the model's focus is the window's one focus).
  func syncFocus(_ focused: String?) { for (id, s) in slices { s.set(focused: id == focused) } }

  // MARK: open and close

  func open() {
    guard let model, !isOpen else { return }
    let home = model.homeShown
    back = (home, model.focusedAgent)
    backLabel = home ? "Home" : model.focusedAgent.flatMap { model.agent($0)?.header.tabLabel }
      ?? model.decks.first { $0.id == model.openProjectId }?.title ?? "Back"
    if home { model.leaveHome() }
    if model.menuOpen { model.menuOpen = false }
    if model.paletteOpen { model.paletteOpen = false }
    asks = model.store.needsAsks()
    if count != asks.count { count = asks.count }
    animatesRemoval = true; keyboardAnswers = []
    let ids = asks.map(\.agentId)
    adopt(ids)
    columns = ids
    isOpen = true
    reelPosition = ids.first
    reelRequest = ReelRequest(agentId: ids.first, animated: false, serial: (reelRequest?.serial ?? 0) + 1)
    model.focusedAgent = ids.first
    follow()
    startWarming()
  }

  // MARK: warming

  /// The reel opens with its columns' heads and ask bars; their threads (the costly part) are built after, one column
  /// per turn while the reel stands still, nearest the leading column first, as the project reel warms its columns
  /// (DeskModel.startWarming). Building every thread on screen in the opening frame took that frame past 200 ms.
  @ObservationIgnored private var warmer: Task<Void, Never>?
  private func startWarming() {
    warmer?.cancel()
    warmer = Task { [weak self] in
      while !Task.isCancelled {
        try? await Task.sleep(for: .milliseconds(40))
        guard let self, self.isOpen else { return }
        if self.reelMoving { continue }
        let at = self.columns.firstIndex(of: self.reelPosition ?? "") ?? 0
        let cold = self.columns.indices.filter { self.slices[self.columns[$0]]?.warm == false }
        guard let next = cold.min(by: { abs($0 - at) < abs($1 - at) }) else { return }
        self.slices[self.columns[next]]?.set(warm: true)
        // One column per frame: the next waits until this one's update has gone out (a busy main thread otherwise
        // let several sets pile up into one long frame).
        await withCheckedContinuation { c in DispatchQueue.main.async { c.resume() } }
      }
    }
  }

  /// `restore`: back to what the window showed (Esc, Back); false when something else takes the window (a project
  /// picked in the title bar, Home).
  func close(restore: Bool = true) {
    guard let model, isOpen else { return }
    isOpen = false
    warmer?.cancel()
    let b = back
    back = nil
    follow()
    // `columns` stays as it was: the reel's view goes with `isOpen`, and emptying it first made the reel slide every
    // column out (and show "Nothing needs you.") on its way out. The next open sets it.
    slices = [:]; leaving = [:]; threads = [:]; places = [:]
    guard restore, let b else { return }
    if b.home { model.openHome(focus: false) }
    model.focusedAgent = b.focused
  }

  // MARK: moving through it

  /// Puts a column first on screen, not animated (the bench's starting point).
  package func lead(_ id: String) {
    guard columns.contains(id) else { return }
    reelPosition = id
    reelRequest = ReelRequest(agentId: id, animated: false, serial: (reelRequest?.serial ?? 0) + 1)
  }

  /// Focus a column, scrolling only as far as it takes to show it (never animated: it is the keyboard's).
  package func focus(_ id: String) {
    guard let model, let i = columns.firstIndex(of: id) else { return }
    model.focusedAgent = id
    let start = columns.firstIndex(of: reelPosition ?? "") ?? 0
    guard i < start || i >= start + across else { return }
    let target = columns[i < start ? i : max(0, i - across + 1)]
    reelPosition = target
    reelRequest = ReelRequest(agentId: target, animated: false, serial: (reelRequest?.serial ?? 0) + 1)
  }

  func moveFocus(_ by: Int) {
    guard let model, !columns.isEmpty else { return }
    let i = model.focusedAgent.flatMap { columns.firstIndex(of: $0) } ?? 0
    focus(columns[min(max(0, i + by), columns.count - 1)])
  }

  /// An ask was answered from its bar: from the keyboard (Return), its column leaves without sliding.
  func answered(agentId: String) {
    if NSApp?.currentEvent?.type == .keyDown { keyboardAnswers.insert(agentId) } else { keyboardAnswers.remove(agentId) }
  }
}

extension NeedsReel: ReelDriver {
  var reelActive: Bool { isOpen }
  func reelScrolled(toIndex i: Int) {
    let id = columns.indices.contains(i) ? columns[i] : columns.last
    if reelPosition != id { reelPosition = id }
  }
  func scrolledByHand() {}
}

// MARK: the seam

extension DeskModel {
  /// The Needs you hand, or the "Needs you" heading: every asking agent as a reel, oldest first.
  package func openNeedsReel() {
    if stopAsked { stopAsked = false }
    collapsePane()   // the reel takes the pane's place beside the sidebar
    needs.open()
  }
  /// Esc or Back: the window goes back to what it showed before.
  package func closeNeedsReel() { needs.close() }
  package func toggleNeedsReel() { if needs.isOpen { needs.close() } else { openNeedsReel() } }

  /// ⌘J: the next ask, oldest first, one at a time, from anywhere. Outside the reel it opens that agent in its project
  /// (as a row does); in the reel it focuses the next column. After the newest it starts again from the oldest.
  package func nextAsk() {
    let asks = needs.asks
    guard !asks.isEmpty else { return }
    if needs.isOpen {
      guard !needs.columns.isEmpty else { return }
      let i = focusedAgent.flatMap { needs.columns.firstIndex(of: $0) } ?? -1
      needs.focus(needs.columns[(i + 1) % needs.columns.count])
      return
    }
    // From the ask in front of you, if you are looking at one; else from the last one ⌘J opened.
    let here = homeShown ? nil : asks.first { $0.agentId == focusedAgent && $0.runId == openRunId }?.key
    let from = here ?? needs.cursor
    let next = from.flatMap { f in asks.first { $0.key > f } } ?? asks[0]
    needs.cursor = next.key
    show(run: next.runId, agent: next.agentId)
    if columns.contains(next.agentId) { focusedAgent = next.agentId }
  }

  /// A usage-limit ask's Resume: the run's agents run again now (POST …/resume), as the menu bar card's Resume now.
  package func resumeLimit(_ l: NeedsLimit) {
    if let id = l.agentIds.first { needs.answered(agentId: id) }
    Task { _ = await store.control(l.runId, .resume) }
  }
}

// MARK: views

/// The main area while the reel is open: its strip ("Needs you · 3 oldest first … Back esc"), then the columns, or
/// "Nothing needs you." once none are left. Board: rex/RexNeedsReel.dc.html (and RexStates' Needs you reel).
struct NeedsReelScreen: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    DeskProbe.body("NeedsReel")
    let n = model.needs
    let empty = n.columns.isEmpty
    return VStack(spacing: 0) {
      NeedsStrip(count: n.columns.count, back: n.backLabel)
      ZStack {
        NeedsReelRepresentable(model: model, needs: n, columns: n.columns, request: n.reelRequest, reduceMotion: reduceMotion)
          .accessibilityHidden(empty)
        if empty { NothingNeedsYou(back: n.backLabel) }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Needs you")
  }
}

/// The reel's strip: 36 pt, the heading in amber (grey at zero), the count, "oldest first", and Back (Esc).
struct NeedsStrip: View {
  @Environment(DeskModel.self) private var model
  let count: Int
  let back: String
  var body: some View {
    HStack(spacing: 0) {
      Text(verbatim: "Needs you").font(.system(size: 13, weight: .semibold)).foregroundStyle(count > 0 ? Theme.amber : Theme.Desk.secondary)
      Text(verbatim: " · \(count)").font(.system(size: 13)).foregroundStyle(count > 0 ? Theme.Desk.secondary : Theme.Desk.tertiary).monospacedDigit()
      if count > 0 { Text(verbatim: "oldest first").font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary).padding(.leading, 12) }
      Spacer(minLength: 0)
      if count > 0 {
        Button { model.closeNeedsReel() } label: {
          Text(verbatim: "Back").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.Desk.secondary)
            .padding(.horizontal, 6).frame(height: 30).contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .modifier(EscLeaves())
        .accessibilityLabel("Back to \(back)")
        .help("Back to \(back) (Esc)")
        Text(verbatim: "esc").font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary).padding(.leading, 2).accessibilityHidden(true)
      }
    }
    .padding(.leading, ReelGeometry.inset + 6).padding(.trailing, ReelGeometry.inset + 4)
    .frame(height: 36)
    .padding(.bottom, 4)
  }
}

/// Esc leaves the reel, unless something above it takes Esc (the palette, the menu, a rename field, the Stop question).
struct EscLeaves: ViewModifier {
  @Environment(DeskModel.self) private var model
  func body(content: Content) -> some View {
    let free = !model.paletteOpen && !model.menuOpen && !model.stopAsked && model.renamingAgent == nil
    content.keyboardShortcut(free ? .cancelAction : nil)
  }
}

/// The end state: one grey line and the way back to what you came from. No amber, no illustration.
struct NothingNeedsYou: View {
  @Environment(DeskModel.self) private var model
  let back: String
  var body: some View {
    DeskProbe.body("NothingNeedsYou")
    return VStack(spacing: 12) {
      Text(verbatim: "Nothing needs you.").font(.system(size: 13)).foregroundStyle(Theme.Desk.tertiary)
      HStack(spacing: 8) {
        Button { model.closeNeedsReel() } label: {
          Text(verbatim: "Back to \(back)").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.Desk.text).lineLimit(1)
            .padding(.horizontal, 13).frame(height: 30)
            .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(Color.white.opacity(0.24), lineWidth: 0.5))
            .contentShape(Rectangle())
        }
        .buttonStyle(PressableStyle())
        .modifier(EscLeaves())
        Text(verbatim: "esc").font(.system(size: 12)).foregroundStyle(Theme.Desk.tertiary).accessibilityHidden(true)
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).fill(Theme.Desk.column))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).strokeBorder(Theme.Desk.columnStroke, lineWidth: 0.5))
    .padding(.horizontal, ReelGeometry.inset).padding(.bottom, Theme.Desk.gap)
  }
}

struct NeedsReelRepresentable: NSViewRepresentable {
  let model: DeskModel
  let needs: NeedsReel
  let columns: [String]
  let request: ReelRequest?
  let reduceMotion: Bool
  func makeNSView(context: Context) -> ReelView { ReelView(model: model, driver: needs, kind: .needs) }
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: ReelView, context: Context) -> CGSize? {
    proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
  }
  func updateNSView(_ v: ReelView, context: Context) {
    v.reduceMotion = reduceMotion
    v.animatesRemovals = needs.animatesRemoval
    v.show(columns)
    if let request { v.perform(request) }
    DeskProbe.event("needs.shown", columns.count)
  }
}

/// A Needs you column's context line: the project it is from (with its place) and the agent's profile.
struct NeedsPlaceLine: View {
  let place: NeedsPlace
  var body: some View {
    HStack(spacing: 6) {
      if let p = Place(sandbox: place.sandbox) { Image(systemName: p.symbol).font(.system(size: 10, weight: .medium)).accessibilityLabel(p.word) }
      Text(verbatim: "\(place.project) · \(place.role)").lineLimit(1).truncationMode(.tail)
    }
    .font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary)
    .frame(maxWidth: .infinity, alignment: .leading)
    .padding(.horizontal, 16).padding(.top, 2).padding(.bottom, 2)
    // Opaque and above the thread: a thread rests scrolled to its foot, and nothing of it shows through the line.
    .background(Theme.Desk.column)
    .zIndex(1)
    .accessibilityElement(children: .combine)
  }
}

/// A usage limit, docked at the column's foot as a decision is: what happened, when it picks up by itself, and Resume
/// now (Return, while its column has focus).
struct LimitBar: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.needsReel) private var inNeeds
  let limit: NeedsLimit
  let focused: Bool
  var body: some View {
    DeskProbe.body("LimitBar")
    let when = limit.resumesAtMs.map { Date(timeIntervalSince1970: Double($0) / 1000).formatted(date: .omitted, time: .shortened) }
    let n = limit.agentIds.count
    return VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: when.map { "Usage limit reached. It resumes at \($0)." } ?? "Usage limit reached.").font(Theme.Desk.question).foregroundStyle(Theme.Desk.text)
        .fixedSize(horizontal: false, vertical: true)
      Text(verbatim: [limit.provider.map { $0 == .claude ? "Claude Code" : "Codex" }, n == 1 ? "1 agent is paused" : "\(n) agents are paused"].compactMap { $0 }.joined(separator: " · "))
        .font(.system(size: 12.5)).foregroundStyle(Theme.Desk.secondary)
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button { model.resumeLimit(limit) } label: {
          HStack(spacing: 6) { Text("Resume now"); Text("↩").font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.12))) }
        }
        .buttonStyle(DeskButton(kind: .primary))
        .keyboardShortcut(focused && model.returnApproves && model.needs.isOpen == inNeeds ? .defaultAction : nil)
      }
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.Desk.decisionFill)
  }
}

/// View › Needs You and View › Next Ask (⌘J).
package struct NeedsYouCommands: Commands {
  let model: DeskModel
  package init(model: DeskModel) { self.model = model }
  package var body: some Commands {
    CommandGroup(before: .toolbar) {
      Button("Needs You") { model.toggleNeedsReel() }
      Button("Next Ask") { model.nextAsk() }.keyboardShortcut("j", modifiers: .command)
      Divider()
    }
  }
}
#endif
