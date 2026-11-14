#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdStore
import CapcomdBot
import CapcomdUI
import PerfLoopProbe

// The desktop's own actions (SPEC §2, §4; boards Home and ReelMenu): Home and starting a project from its composer,
// the open project's menu, the ⌘K palette, and folding projects into the title bar. What each offers is decided in the
// store (NewProjectForm, ProjectMenu, Palette); this is the model's side: state, and the calls the views make.

/// Home's composer while Home shows (Home.dc.html): its form, and the planner-to-be (named in the debug state).
@Observable @MainActor
package final class NewProjectModel {
  package internal(set) var form = NewProjectForm() { didSet { Mutations.record("NewProject.form") } }
  /// Bumped when what the composer shows from the store changes (run options, branches, the folder's setup, runs).
  package internal(set) var revision = 0 { didSet { Mutations.record("NewProject.revision") } }
  /// Bumped to put the focus in the goal field (+ and ⇧⌘N, Set Up done); 0: Home showed without taking it.
  package internal(set) var focusSerial = 0
  /// The model menu is open (it closes on a pick of a model, Esc or a click outside).
  package internal(set) var modelMenuOpen = false { didSet { Mutations.record("NewProject.modelMenuOpen") } }
  /// The planner-to-be: a bot of its own, sleepy until something is typed, then smiling (one change, no loop).
  @ObservationIgnored package let sleepy: BotTraits
  @ObservationIgnored package let happy: BotTraits
  package var face: BotTraits { form.smiling ? happy : sleepy }
  package var name: String { sleepy.name }

  package init(seed: String = "new-project-\(UUID().uuidString.prefix(8))") {
    let t = botTraits(seed: seed, role: "planner")
    sleepy = (try? withOverrides(t, mood: .sleepy)) ?? t
    happy = (try? withOverrides(t, mood: .happy)) ?? t
  }
}

extension DeskModel {
  // MARK: Home and its composer

  /// + (or ⇧⌘N): Home, with the composer focused. On Home already: the focus goes to the goal.
  package func openNewProject() { openHome(focus: true) }

  /// The title bar's Home (⌘0), and the window with nothing open: Home shows, the reel stays built under it, every
  /// project shows as a deck. `focus`: the goal field takes the keyboard.
  package func openHome(focus: Bool) {
    menuOpen = false; paletteOpen = false; stopAsked = false
    needs.close(restore: false)
    if let np = newProject { if focus { np.focusSerial += 1 }; return }
    let np = newProjectDraft ?? NewProjectModel()
    newProjectDraft = nil
    if focus { np.focusSerial += 1 }
    newProject = np
    home.set(store.homeRuns())
    syncBranches()
    Task { [weak self] in
      await self?.store.refreshDaemonInfo()   // capabilities and run options, for the branch row and the tool row
      self?.syncBranches()
    }
  }

  /// A key typed while Home holds the keyboard (nothing focused): it starts (or continues) the goal, and the goal field
  /// takes the keyboard for the rest.
  package func typeIntoComposer(_ text: String) {
    guard let np = newProject, np.form.phase == .editing else { return }
    np.modelMenuOpen = false
    typeGoal(np.form.goal + text)
    np.focusSerial += 1
  }

  /// Home's button (⌘0): Home, or back to the project under it.
  package func toggleHome() { if homeShown { closeNewProject() } else { openHome(focus: false) } }

  /// Esc (with nothing typed), ⌘W or the pressed Home button: back to the open project. With none open, Home stays:
  /// it is the window's screen then. A goal that didn't start is kept for next time.
  package func closeNewProject() {
    guard openRunId != nil else { return }
    leaveHome()
  }

  /// A project opens (a deck, a card, ⌘1–9, a run that started from Home): Home goes, keeping a draft.
  func leaveHome() {
    guard let np = newProject else { return }
    np.modelMenuOpen = false
    if case .started = np.form.phase { newProjectDraft = nil } else { newProjectDraft = np }
    newProject = nil
  }

  /// Esc in the goal field: the model menu closes first, then a folder's setup is cancelled (the goal stays); else an
  /// empty composer goes back to the open project. A typed goal is never thrown away by Esc.
  package func newProjectEscape() {
    if newProject?.modelMenuOpen == true { newProject?.modelMenuOpen = false; return }
    if setupFlow.isOpen { cancelSetup(); return }
    if newProject?.form.escCloses == true { closeNewProject() }
  }

  // MARK: the model menu

  package func toggleModelMenu() { if let np = newProject { np.modelMenuOpen.toggle(); if np.modelMenuOpen { menuOpen = false; paletteOpen = false } } }
  package func closeModelMenu() { newProject?.modelMenuOpen = false }
  /// A model in the menu: its driver drives new runs, on that model (nil: the driver's own). The menu closes.
  package func pickModel(_ o: ModelMenu.Option) {
    guard o.enabled else { return }
    store.pickModel(o.model, driver: o.provider)
    newProject?.modelMenuOpen = false
    newProjectChanged()
  }
  /// The menu's Effort control (nil: Auto). The menu stays open.
  package func pickEffort(_ e: String?) {
    store.pickEffort(e)
    newProjectChanged()
  }

  // MARK: Running (Home's cards)

  /// A Running card: its project opens in the reel (at its ask, if it asks).
  package func openCard(_ projectId: String) { open(project: projectId) }
  /// The bots of a Running card's crew, as its deck stacks them (cached per run until its agents change).
  package func heads(run runId: String, agents ids: [String]) -> [BotTraits] {
    let t = team(runId)
    return ids.compactMap { t[$0] }
  }

  /// The goal field changed: the bot wakes up at the first word, and the goal branch suggestion follows the goal.
  package func typeGoal(_ g: String) {
    guard let np = newProject, np.form.goal != g else { return }
    np.form.type(g)
    syncBranches()
  }

  /// The branch row shows: a daemon with goal branches, a project folder chosen, and no folder setup open.
  package var newProjectBranches: Bool { store.goalBranchesOffered && !setupFlow.isOpen }
  /// A picked folder's next steps, in the tool row's place (none while the folder is still being looked at).
  package func newProjectSetup() -> SetupScreen? {
    setupFlow.screen(goal: newProject?.form.goal ?? "", sandbox: store.startSandbox?.name).flatMap { $0.phase == .loading ? nil : $0 }
  }
  package var newProjectCanStart: Bool {
    newProject?.form.canStart(branches: newProjectBranches, setupShowing: newProjectSetup() != nil || setupFlow.isOpen) ?? false
  }

  /// The base menu's pick and the goal branch field's edits.
  package func pickBase(_ b: String) {
    guard let np = newProject else { return }
    np.form.goalSetup.pickBase(b); np.form.editedBranchField(); syncBranches()
  }
  package func typeBranch(_ t: String) {
    guard let np = newProject else { return }
    np.form.goalSetup.typeBranch(t); np.form.editedBranchField(); syncBranches()
  }

  /// The goal branch row's setup follows the checkout and the goal; its question goes to the daemon when it changes: at
  /// once for a new checkout, else 400 ms after the last change (as the menu bar's composer asks).
  func syncBranches() {
    guard let np = newProject else { return }
    np.form.goalSetup.open(path: newProjectBranches ? store.prefs.startRepo : nil)
    guard let q = np.form.goalSetup.query, q != branchesAsked else { return }
    branchesAsked = q
    let now = np.form.goalSetup.awaitingFirstAnswer
    branchTask?.cancel()
    branchTask = Task { [weak self] in
      if !now { try? await Task.sleep(for: .milliseconds(400)) }
      guard !Task.isCancelled, let self else { return }
      if let f = await self.store.loadProjectBranches(path: q.path, goal: q.goal, goalBranch: q.goalBranch, base: q.base) {
        self.newProject?.form.goalSetup.receive(f, for: q)
      }
    }
  }

  /// The store or the folder's setup changed: the open column redraws what it shows from them, and a project that
  /// started from it takes over once its planner is there.
  func newProjectChanged() {
    guard let np = newProject else { return }
    np.revision &+= 1
    adoptStartedRun()
  }

  /// Start (Return, the white arrow): the same start as the menu bar's composer (the store's run choice, with the base
  /// and goal branch). A daemon with no default project asks for the folder once. Started, the column waits for the
  /// run's planner and becomes its column; refused, it stays with the daemon's sentence under the field it names.
  package func startNewProject() async {
    guard let np = newProject, newProjectCanStart else { return }
    await start(np, goal: np.form.goal)
  }

  @discardableResult
  private func start(_ np: NewProjectModel, goal: String) async -> Bool {
    np.form.starting()
    var state = await store.startRun(goal: goal, store.newRunChoice(goalSetup: np.form.goalSetup))
    if case .needsRepo = state, let folder = await chooseFolder() {
      // A folder that isn't set up shows its next steps (the goal stays: Set Up and Start); a set-up one takes the run.
      if await setupFlow.pick(folder) {
        syncBranches()
        state = await store.startRun(goal: goal, store.newRunChoice(goalSetup: nil))
      } else { state = .idle }
    }
    np.form.finished(state, field: store.startRefusedField)
    store.clearStart()
    adoptStartedRun()
    if case .started = state { return true }
    return false
  }

  /// The run started from Home is listed with its planner: its project opens in the reel on the planner's column.
  func adoptStartedRun() {
    guard let np = newProject, case .started(let runId) = np.form.phase,
          let deck = decks.first(where: { $0.runId == runId }), !store.reelColumns(runId: runId).isEmpty else { return }
    newProjectDraft = nil
    newProject = nil
    folded = false
    open(project: deck.id)
    if let planner = columns.first { scroll(to: planner, animated: false) }
  }

  /// + › Choose Project Folder…, and Choose Another Folder… on the setup: a set-up project becomes where new runs go;
  /// any other folder shows its next steps in the tool row's place.
  package func chooseProjectFolder() {
    Task { [weak self] in
      guard let self, let f = await self.chooseFolder() else { return }
      await self.pickFolder(f)
    }
  }
  package func pickFolder(_ path: String) async {
    _ = await setupFlow.pick(path)
    syncBranches()
    newProjectChanged()
  }
  /// + › Use the Default Project, and the folder chip's ×.
  package func useDefaultProject() {
    store.prefs.startRepo = nil
    syncBranches()
    Task { await store.refreshRunOptions() }
  }
  package func cancelSetup() { setupFlow.cancel(); syncBranches() }

  /// A button on the folder's setup. Set Up and Start starts the run as Start does.
  package func setupAction(_ a: SetupAction) {
    guard let np = newProject else { return }
    Task { [weak self] in
      guard let self else { return }
      switch a {
      case .setUp, .setUpAndStart:
        let outcome = await self.setupFlow.submit(goal: np.form.goal) { [weak self] g in
          guard let self else { return false }
          return await self.start(np, goal: g)
        }
        if outcome == .setUp { np.focusSerial += 1 }
        self.syncBranches()
      case .initializeGit: await self.setupFlow.initializeGit()
      case .publish: await self.setupFlow.publish()
      case .logInToGitHub: SetupTerminal.githubLogin()
      case .openInTerminal: if let p = self.setupFlow.path { SetupTerminal.setUpProject(in: p) }
      case .tryAgain: if let p = self.setupFlow.path { _ = await self.setupFlow.pick(p) }
      }
      self.newProjectChanged()
    }
  }

  // MARK: the project menu

  /// The open project's menu (nil with no project open). Its Changes counts come from the goal view, read when the menu
  /// opens.
  package var projectMenu: ProjectMenu? {
    _ = actionsRevision
    guard let p = openProjectId, let r = openRunId else { return nil }
    return store.projectMenu(projectId: p, runId: r)
  }

  /// A click on the open project's name.
  package func toggleMenu() {
    guard openRunId != nil, newProject == nil else { menuOpen = false; return }
    menuOpen.toggle()
    paletteOpen = false
    if menuOpen, let r = openRunId, store.runs[r]?.goalBranch != nil, store.goalViews[r] == nil {
      Task { await store.loadGoal(runId: r) }
    }
  }
  package func closeMenu() { menuOpen = false }

  /// Runs a menu item (from the menu, the palette or a shortcut). Stop asks first.
  package func perform(_ item: ProjectMenu.Item) {
    menuOpen = false; paletteOpen = false
    guard let runId = openRunId else { return }
    switch item {
    case .messagePlanner: if let p = projectMenu?.plannerId { focusBox(p) }
    case .changes(_, _, _, let url): openURL(url)
    case .pause: Task { await store.control(runId, .pause) }
    case .resume: Task { await store.control(runId, .resume) }
    case .stop: stopAsked = true
    case .fold: fold()
    case .remove: removeFromTitleBar()
    case .copyRunId: copyText(runId)
    }
  }
  /// Stop project…: the person said yes. It cancels every agent.
  package func confirmStop() {
    stopAsked = false
    guard let runId = openRunId else { return }
    Task { await store.control(runId, .cancel) }
  }
  package func cancelStop() { stopAsked = false }

  /// The menu's item by name, if the menu has it now (the shortcuts and the debug control file).
  package func menuItem(_ name: String) -> ProjectMenu.Item? { projectMenu?.items.first { $0.name == name } }

  /// ⌘W: Home goes back to the open project; else the open project folds into its deck (it keeps running), or a
  /// finished one is removed from the title bar.
  package func foldShortcut() {
    if newProject != nil { closeNewProject(); return }
    if let i = menuItem("fold") ?? menuItem("remove") { perform(i) }
  }
  /// ⌥⌘P.
  package func pauseShortcut() { if let i = menuItem("pause") ?? menuItem("resume") { perform(i) } }
  /// ⌘L.
  package func messagePlannerShortcut() { if let i = menuItem("message") { perform(i) } }

  /// The planner's message box takes the focus: its column comes on screen first.
  func focusBox(_ agentId: String) {
    scroll(to: agentId, animated: false)
    boxFocusPending = agentId
    agent(agentId)?.focusBox()
  }
  /// The box asks once when it shows or is bumped: true the first time after Message the planner….
  package func takeBoxFocus(_ agentId: String) -> Bool {
    guard boxFocusPending == agentId else { return false }
    boxFocusPending = nil
    return true
  }

  /// Fold into the title bar: the project goes back to its deck and keeps running; no project is open until one is
  /// picked.
  package func fold() {
    guard openProjectId != nil else { return }
    folded = true
    menuOpen = false
    open(project: nil)
  }
  /// Remove from the title bar (a finished project): hidden until it has news.
  package func removeFromTitleBar() {
    guard let p = openProjectId, let r = openRunId else { return }
    hidden[p] = r
    fold()
    apply([.all])
  }
  /// The decks to show: a removed project stays away while its deck still shows the same finished run with nothing to
  /// ask; any news (a new run, an ask, work again) brings it back.
  func shown(_ all: [DeckInfo]) -> [DeckInfo] {
    guard !hidden.isEmpty else { return all }
    return all.filter { d in
      guard let r = hidden[d.id] else { return true }
      if d.runId == r, !d.isRunning, d.askingAgentId == nil { return false }
      hidden[d.id] = nil
      return true
    }
  }

  // MARK: the ⌘K palette

  /// ⌘K or the title bar's ⌘ button: opens on an empty query (`query` from the debug control file).
  package func togglePalette(query: String = "") {
    if paletteOpen && query.isEmpty { paletteOpen = false; return }
    menuOpen = false; stopAsked = false
    paletteQuery = query; paletteSelection = 0
    paletteOpen = true
  }
  /// What the query shows, in order.
  package var paletteShown: [PaletteEntry] { Palette.filter(paletteEntries, paletteQuery) }
  /// ↑ ↓: the selection moves, and stops at either end.
  package func movePaletteSelection(_ by: Int) {
    let n = paletteShown.count
    paletteSelection = n == 0 ? 0 : min(max(0, paletteSelection + by), n - 1)
  }
  /// Return: the selected entry runs (nothing when nothing matches).
  package func runPaletteSelection() {
    let shown = paletteShown
    guard shown.indices.contains(paletteSelection) else { return }
    run(shown[paletteSelection].action)
  }
  package func closePalette() { paletteOpen = false }

  package var paletteEntries: [PaletteEntry] {
    _ = actionsRevision
    return Palette.entries(menu: newProject == nil ? projectMenu : nil, decks: decks, openProjectId: newProject == nil ? openProjectId : nil,
                           agents: newProject == nil ? columns.compactMap { agent($0)?.header } : [], follow: follow)
  }

  package func run(_ a: PaletteAction) {
    paletteOpen = false
    switch a {
    case .menu(let item): perform(item)
    case .project(let id): open(project: id)
    case .newProject: openNewProject()
    case .home: openHome(focus: false)
    case .follow(let on): follow = on
    case .agent(let id): scroll(to: id, animated: false)
    }
  }
}

/// Asks for a project folder. The window takes a click while another app is in front, and a panel begun then opened
/// behind that app's windows (or, in an accessory app, was cancelled by its first click): the app becomes regular and
/// active first, and the panel comes to the front (Presence.beforeOpenPanel).
@MainActor enum DeskFolderPicker {
  static func choose() async -> String? {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
    p.prompt = "Use This Project"; p.message = "Choose the project's folder."
    let steps = Presence.beforeOpenPanel(regular: NSApp.activationPolicy() == .regular, active: NSApp.isActive)
    if steps.becomeRegular { NSApp.setActivationPolicy(.regular) }
    if steps.activate { NSApp.activate() }
    return await withCheckedContinuation { done in
      p.begin { r in done.resume(returning: r == .OK ? p.url?.path : nil) }
      if steps.orderFront { p.makeKeyAndOrderFront(nil); p.orderFrontRegardless() }
    }
  }
}

/// The folder setup's Terminal steps (a throwaway .command file; no Automation permission needed): the GitHub CLI's own
/// login, and `capcomd setup project` in a folder that isn't on GitHub.
enum SetupTerminal {
  @discardableResult
  static func githubLogin() -> Bool {
    script(name: "gh-login", """
      gh auth login
      echo
      echo "When you're logged in, go back to capcomd."
      """)
  }
  @discardableResult
  static func setUpProject(in folder: String) -> Bool {
    let quoted = "'" + folder.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return script(name: "setup-project", """
      cd \(quoted) || exit 1
      capcomd setup project
      """)
  }
  private static func script(name: String, _ body: String) -> Bool {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-desktop-\(name).command")
    do {
      try "#!/bin/zsh -l\n\(body)\n".write(to: url, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
      NSWorkspace.shared.open(url)
      return true
    } catch { NSSound.beep(); return false }
  }
}
#endif
