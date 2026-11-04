#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import CapcomdUI
import CapcomdDesk
import CapcomdOnboarding

/// The onboarding window's state and work (design/onboarding/onboarding.dc.html). `Flow` (CapcomdOnboarding) decides what
/// shows; this does what each step names with the app's own first-run code: AppSession finds the CLI, starts capcomd
/// and pairs, AppModel's Settings glue reads and starts logins, the menu bar's project setup takes the project, and the
/// store starts the run.
@Observable @MainActor
final class OnboardingModel {
  enum IntroPhase: Equatable { case none, playing, opened }

  var flow: Flow
  /// The intro: playing until the window opens at 3.7 s, then opened; none when it didn't play.
  private(set) var intro: IntroPhase = .none
  /// Bumped each time the welcome screen appears, so its title and lines come in again.
  private(set) var welcomeSerial = 0
  private(set) var copied = false
  private(set) var repos: [FoundRepo] = []
  private(set) var reposLoaded = false
  private(set) var projectChecking = false
  /// The launch screen's clock and the crew as it arrives.
  private(set) var launchStart: Date?
  private(set) var planner: CrewMember?
  private(set) var workers: [CrewMember] = []
  /// When each worker first showed up (ms into the launch).
  private(set) var arrivals: [Int] = []
  private(set) var launching = false

  struct CrewMember: Equatable { var name: String; var status: String }

  @ObservationIgnored weak var canvas: IntroCanvasView? { didSet { if canvas != nil { canvasReady() } } }
  @ObservationIgnored let session: AppSession
  @ObservationIgnored let app: AppModel
  @ObservationIgnored let desk: DeskModel
  @ObservationIgnored private let defaults: UserDefaults
  @ObservationIgnored private var timers: [Task<Void, Never>] = []
  @ObservationIgnored private var bootTask: Task<Void, Never>?
  @ObservationIgnored private var pendingIntro: Bool
  @ObservationIgnored let reduceMotion: Bool
  /// The window closes: finished (Open capcomd, with the run to open), or just closed.
  @ObservationIgnored var onClose: (_ finished: Bool, _ runId: String?) -> Void = { _, _ in }
  @ObservationIgnored let frames = FrameCounter()
  @ObservationIgnored var framesReport: String?

  var store: CapcomdStore { app.store }

  init(session: AppSession, app: AppModel, desk: DeskModel, step: OnboardStep, intro: Bool, defaults: UserDefaults = .standard) {
    self.session = session; self.app = app; self.desk = desk; self.defaults = defaults
    reduceMotion = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion
    flow = Flow(step: step)
    pendingIntro = intro && !reduceMotion
    if pendingIntro && step == .welcome { self.intro = .playing }
    var r = record; r.seen = true; record = r
  }

  var record: Record {
    get { Record { defaults.bool(forKey: $0) } }
    set { newValue.write { defaults.set($1, forKey: $0) } }
  }

  // MARK: The intro

  private func canvasReady() {
    if flow.step == .welcome { showWelcome(intro: pendingIntro) } else { canvas?.settle() }
    pendingIntro = false
  }

  private func showWelcome(intro play: Bool) {
    welcomeSerial &+= 1
    canvas?.showWelcome(intro: play, still: reduceMotion)
    guard play else { intro = .none; return }
    intro = .playing
    if let c = canvas, ProcessInfo.processInfo.environment["CAPCOMD_ONBOARDING_CONTROL"] != nil {
      frames.start(on: c, for: Intro.propsGone + 0.3) { [weak self] r in self?.framesReport = r }
    }
    later(Intro.windowOpens) { [weak self] in self?.intro = .opened }
    later(Intro.windowOpens + 1.1) { [weak self] in self?.windowOpened() }
    later(Intro.propsGone) { [weak self] in self?.canvas?.dropProps() }
  }
  /// The backdrop has filled the window: it's a window now (its shadow on).
  @ObservationIgnored var windowOpened: () -> Void = {}

  private func later(_ s: Double, _ f: @escaping @MainActor () -> Void) {
    timers.append(Task { @MainActor in
      try? await Task.sleep(for: .seconds(s))
      if !Task.isCancelled { f() }
    })
  }

  /// The window's chrome (title bar, dots, the traces' fade) shows: not while the intro hasn't opened the window.
  var chromeShown: Bool { intro != .playing }

  // MARK: Moving between screens

  func go(_ step: OnboardStep) {
    let was = flow.step
    guard flow.go(step) else { return }
    if was == .welcome && step != .welcome { canvas?.hideWelcome(); canvas?.settle(); intro = .none }
    if step == .welcome && was != .welcome { showWelcome(intro: false) }
    entered(step)
  }

  func back() {
    guard let p = flow.step.previous, flow.backEnabled || flow.step == .allSet else { return }
    go(p)
  }

  func skip() { if flow.step.canSkip { go(.allSet); finish(record: true) } }

  /// The primary button.
  func primary() {
    guard flow.primaryEnabled, let p = flow.primary else { return }
    switch p {
    case .getStarted: go(.boot)
    case .boot, .retry: boot()
    case .booting: break
    case .next: if let n = flow.step.next { go(n) }
    case .launch: Task { await launch() }
    case .openCapcomd: open()
    }
  }

  private func entered(_ step: OnboardStep) {
    switch step {
    case .boot: if !flow.boot.done { lookForCLI() }
    case .crew: startPolling()
    case .project: if !reposLoaded { Task { await loadRepos() } }
    default: break
    }
  }

  // MARK: Boot

  /// On the boot screen: is there a CLI? (The session looked at launch; this looks once more if it found none.)
  private func lookForCLI() {
    Task {
      let found = await session.locate()
      if found == nil, !session.lookingForCLI { flow.boot.cliMissing = true } else { flow.boot.cliMissing = false; noteCLI() }
    }
  }
  private func noteCLI() {
    flow.boot.version = session.cliVersion
    flow.boot.path = session.cli.map { RepoScan.display($0, home: NSHomeDirectory()) }
  }

  /// Copy (the brew command).
  func copyInstall() {
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setString(FirstRun.installCommand, forType: .string)
    copied = true
    later(1.4) { [weak self] in self?.copied = false }
  }

  /// Check again: found, the steps show and Boot can run.
  func checkAgain() {
    Task {
      let found = await session.locate(again: true)
      flow.boot.cliMissing = found == nil
      if found != nil { noteCLI() }
    }
  }

  /// Debug only (OnboardingDebug `missing`): the no-CLI state, to look at, without hiding a CLI from the app.
  func debugShowMissingCLI() { flow.boot = Boot(); flow.boot.cliMissing = true }

  func setAtLogin(_ on: Bool) { if flow.boot.switchEnabled { flow.boot.atLogin = on } }

  /// Boot capcomd (or Try again): the three steps in order, each shown for at least as long as the prototype paces
  /// it, the first failure stopping on its row.
  func boot() {
    guard !flow.boot.running else { return }
    if flow.boot.failure != nil { flow.boot.retry() } else { flow.boot.begin() }
    bootTask = Task { await runBoot() }
  }

  private enum StepResult { case ok, failed(String), missing }
  private static let pacing: [Double] = [1.1, 1.2, 1.0]

  private func runBoot() async {
    while flow.boot.stage >= 1 && flow.boot.stage <= 3 {
      let s = flow.boot.stage, began = Date()
      let r: StepResult
      switch s {
      case 1: r = await find()
      case 2: r = await start()
      default: r = await pair()
      }
      let left = Self.pacing[s - 1] - Date().timeIntervalSince(began)
      if left > 0 { try? await Task.sleep(for: .seconds(left)) }
      switch r {
      case .ok: flow.boot.advance()
      case .failed(let m): flow.boot.fail(m); announce(flow.boot.bubble); return
      case .missing: flow.boot = { var b = flow.boot; b.stage = 0; b.cliMissing = true; return b }(); announce(flow.boot.bubble); return
      }
      announce(flow.boot.bubble)
    }
    // Ready for the next screens: the logins, the places and the projects.
    Task { await store.refreshDaemonInfo(); await app.refreshSettings() }
    Task { await loadRepos() }
  }

  private func find() async -> StepResult {
    guard await session.locate(again: true) != nil else { return .missing }
    noteCLI()
    return .ok
  }

  /// Already answering: nothing to start (the switch shows whether its login service is installed). Else the login
  /// service, at login or now only.
  private func start() async -> StepResult {
    if await SocketProbe.answers(Connection.socketPath) {
      if let installed = await session.serviceInstalled() { flow.boot.atLogin = installed }
      return .ok
    }
    if let why = await session.startDaemon(atLogin: flow.boot.atLogin) { return .failed(why) }
    for _ in 0..<40 where !(await SocketProbe.answers(Connection.socketPath)) { try? await Task.sleep(for: .milliseconds(250)) }
    return .ok
  }

  /// A token the daemon takes already: done (a new pairing would revoke it). Else pair with the CLI.
  private func pair() async -> StepResult {
    if session.current != nil, await connectedSoon() { return .ok }
    session.pair()
    for _ in 0..<600 {
      switch session.token {
      case .ready: return await connectedSoon() ? .ok : .failed("capcomd didn't accept the new pairing. Try again.")
      case .failed(let m): return .failed(m)
      case .needsCLI: return .missing
      case .rejected: return .failed("capcomd didn't accept this Mac. Try again.")
      case .pairing, .reading: try? await Task.sleep(for: .milliseconds(100))
      }
    }
    return .failed("Pairing took too long. Try again.")
  }

  /// The session's store reached the daemon with its token (not refused) within a few seconds.
  private func connectedSoon() async -> Bool {
    for _ in 0..<80 {
      let s = session.store
      if s.unauthorized { return false }
      if s.daemonLoaded && !s.daemonUnreachable { return true }
      try? await Task.sleep(for: .milliseconds(100))
    }
    return false
  }

  /// The bot's comment, read out by VoiceOver as it changes.
  private func announce(_ s: String) {
    NSAccessibility.post(element: NSApp.keyWindow as Any, notification: .announcementRequested,
                         userInfo: [.announcement: s, .priority: NSAccessibilityPriorityLevel.medium.rawValue])
  }

  // MARK: Crew

  @ObservationIgnored private var polling: Task<Void, Never>?
  private func startPolling() {
    polling?.cancel()
    if flow.place.isEmpty || !placeChosen { flow.place = initialPlace() }
    polling = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.flow.step == .crew else { return }
        await self.store.refreshRunOptions()
        await self.app.refreshSettings()
        if !self.placeChosen { self.flow.place = self.initialPlace() }
        try? await Task.sleep(for: .seconds(2))
      }
    }
  }
  @ObservationIgnored private var placeChosen = false

  private func initialPlace() -> String {
    if let d = store.defaultPlace?.name, ["docker", "boxd"].contains(d) { return d }
    let places = store.runOptions.sandboxes
    if places.first(where: { $0.name == "docker" })?.available == true { return "docker" }
    if places.first(where: { $0.name == "boxd" })?.available == true { return "boxd" }
    return "docker"
  }

  /// Where they work: the user's default place (Settings › Runs).
  func pickPlace(_ name: String) {
    placeChosen = true
    flow.place = name
    store.setDefaultPlace(name)
  }

  /// A place as the card says it: Docker's real state; boxd's needs-an-account.
  func place(_ name: String) -> SandboxInfo? { store.runOptions.sandboxes.first { $0.name == name } }

  enum SignIn: Equatable { case signedIn, waiting, signedOut }
  func login(_ provider: String) -> LoginRow? { app.loginRows.first { $0.provider == provider && $0.sandbox == flow.place } }
  func signIn(_ provider: String) -> SignIn {
    guard let r = login(provider) else { return .signedOut }
    if app.handOffs.waiting(HandOffKey.login(r)) != nil { return .waiting }
    return r.isLoggedIn ? .signedIn : .signedOut
  }
  /// Sign in: the existing login (Terminal runs `capcomd auth login <ai> --sandbox <place>`).
  func startSignIn(_ provider: String) {
    if let r = login(provider) { app.handOff(HandOffKey.login(r), command: r.command, baseline: r.fingerprint); return }
    app.handOff(HandOffKey.login(provider: provider, sandbox: flow.place),
                command: SettingsRows.loginCommand(provider: provider, sandbox: flow.place), baseline: "")
  }

  // MARK: Project

  func loadRepos() async {
    let home = Self.scanHome
    var known = await store.knownProjects().map(\.path)
    if let r = store.prefs.startRepo { known.insert(r, at: 0) }
    let scanned = await Task.detached(priority: .userInitiated) { RepoScan.scan(home: home) }.value
    let merged = RepoScan.merge(known: known, scanned: scanned, home: home)
    repos = merged
    reposLoaded = true
    if flow.project == nil, let first = merged.first { await pick(first.path) }
  }

  /// The home the scan looks through (`-capcomd.onboarding.home` points it at another, for checks).
  static var scanHome: String { UserDefaults.standard.string(forKey: "capcomd.onboarding.home") ?? NSHomeDirectory() }
  static func display(_ path: String) -> String { RepoScan.display(path, home: scanHome) }

  /// Picking a project runs its setup (the menu bar's): a set-up project is where the run goes; another shows its next
  /// steps under the list.
  func pick(_ path: String) async {
    flow.project = path; flow.projectReady = false
    projectChecking = true
    let ok = await app.setup.pick(path)
    projectChecking = false
    guard flow.project == path else { return }
    flow.projectReady = ok
  }

  var setupScreen: SetupScreen? {
    guard flow.project != nil, !flow.projectReady else { return nil }
    return app.setupScreen(goal: "").flatMap { $0.phase == .loading ? nil : $0 }
  }

  func setupAction(_ a: SetupAction) {
    Task {
      let outcome = await app.setupAction(a, goal: "")
      if outcome == .setUp || (!app.setup.isOpen && app.startRepo != nil) { flow.projectReady = true; flow.project = app.startRepo ?? flow.project }
    }
  }

  /// Choose another folder…
  func chooseFolder() {
    Task {
      guard let f = await ProjectFolderPicker.choose(prompt: "Choose the project's folder.") else { return }
      if !repos.contains(where: { $0.path == f }) {
        repos.insert(FoundRepo(path: f, name: (f as NSString).lastPathComponent, branch: RepoScan.branch(of: f), known: false, modified: nil), at: 0)
      }
      await pick(f)
    }
  }

  var projectName: String { flow.project.map { ($0 as NSString).lastPathComponent } ?? "your project" }

  // MARK: Goal and launch

  func setGoal(_ g: String) { flow.goal = g }

  /// Launch crew: a planner-driven run on the project with the goal (the app's own start), then the crew comes in.
  func launch() async {
    guard !launching, flow.go(.launch) else { return }
    launching = true
    flow.runId = nil; flow.launchFailure = nil; planner = nil; workers = []; arrivals = []
    launchStart = Date()
    let goal = flow.goal.trimmingCharacters(in: .whitespacesAndNewlines)
    let state = await store.startRun(goal: goal, store.newRunChoice(goalSetup: nil))
    store.clearStart()
    launching = false
    switch state {
    case .started(let id): flow.runId = id; followCrew(id)
    case .failed(let m), .needsRepo(let m): flow.launchFailure = m
    case .idle, .starting: flow.launchFailure = "The run didn't start. Try again."
    }
  }

  @ObservationIgnored private var crewTask: Task<Void, Never>?
  /// The planner and its first workers, by their own names and what they're doing, as the store hears of them.
  private func followCrew(_ runId: String) {
    crewTask?.cancel()
    crewTask = Task { [weak self] in
      while !Task.isCancelled {
        guard let self, self.flow.step == .launch else { return }
        let cols = self.store.reelColumns(runId: runId)
        if let p = cols.first(where: { $0.kind == .planner }) ?? cols.first {
          self.planner = CrewMember(name: "Planner", status: Self.status(p))
          let rest = cols.filter { $0.agentId != p.agentId }.prefix(3)
          let next = rest.map { CrewMember(name: $0.title ?? $0.label, status: Self.status($0)) }
          if next.count > self.arrivals.count, let s = self.launchStart {
            let now = Int(Date().timeIntervalSince(s) * 1000)
            self.arrivals += Array(repeating: now, count: next.count - self.arrivals.count)
          }
          if next != self.workers { self.workers = next }
        }
        try? await Task.sleep(for: .milliseconds(300))
      }
    }
  }

  static func status(_ h: ColumnHeader) -> String {
    if h.waiting { return "Waiting on you" }
    if let a = h.activity, !a.isEmpty { return a }
    switch h.status {
    case .running: return "Working"
    case .pending: return "Queued"
    case .done: return "Done"
    case .failed: return "Failed"
    case .paused: return "Paused"
    case .cancelled: return "Stopped"
    case .handedOff: return "Handed back"
    default: return "Starting"
    }
  }

  /// When worker `i` lands: its slot's time, or when the run had it if that was later.
  func arrival(_ i: Int) -> Int {
    let slot = Launch.times[2 + min(i, 2)].ms
    return i < arrivals.count ? max(slot, arrivals[i]) : slot
  }

  func launchBack() { flow.launchFailure = nil; go(.goal) }

  // MARK: Finishing

  /// Finishing or skipping is stored, so later launches go straight to the window.
  func finish(record finished: Bool) { var r = record; r.seen = true; if finished { r.finished = true }; record = r }

  /// Open capcomd: the window, on the run that was launched.
  func open() {
    finish(record: true)
    stop()
    onClose(true, flow.runId)
  }

  /// The window closed some other way (its close button).
  func closed() {
    stop()
  }

  func stop() {
    for t in timers { t.cancel() }
    timers = []
    bootTask?.cancel(); polling?.cancel(); crewTask?.cancel()
  }
}

/// Whether something answers on the daemon's socket (no token needed: a connect, closed at once).
enum SocketProbe {
  static func answers(_ path: String) async -> Bool {
    await Task.detached { connect(path) }.value
  }
  nonisolated static func connect(_ path: String) -> Bool {
    let fd = socket(AF_UNIX, SOCK_STREAM, 0)
    guard fd >= 0 else { return false }
    defer { close(fd) }
    var addr = sockaddr_un()
    addr.sun_family = sa_family_t(AF_UNIX)
    let bytes = Array(path.utf8)
    guard bytes.count < MemoryLayout.size(ofValue: addr.sun_path) else { return false }
    withUnsafeMutableBytes(of: &addr.sun_path) { p in
      for (i, b) in bytes.enumerated() { p[i] = b }
      p[bytes.count] = 0
    }
    let len = socklen_t(MemoryLayout<sockaddr_un>.size)
    return withUnsafePointer(to: &addr) { $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { Darwin.connect(fd, $0, len) == 0 } }
  }
}
#endif
