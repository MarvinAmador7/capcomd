#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdSettings

/// v5-a-final `.in`: "Start a project…" at the top of the panel (⌘K). Return starts a run on the goal (POST /v1/runs);
/// Esc clears, then leaves the field.
struct StartProjectField: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.openSettings) private var openSettings
  @FocusState private var focused: Bool
  @State private var goal = ""

  var body: some View {
    let state = model.startState
    let starting = state == .starting
    // A picked folder that isn't set up yet: its next steps take the tool row's place (design/setup).
    let setup = model.setupScreen(goal: goal).flatMap { $0.phase == .loading ? nil : $0 }
    // Goal branches: under the goal, the branch the work lands on and its base, as soon as a project folder is chosen
    // (the base menu fills at once; the branch name follows the goal once there is one).
    let branches = model.goalBranchesOffered && setup == nil && !model.setup.isOpen
    let showBranches = branches
    let ready = !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !starting && (!branches || model.goalSetup.canStart)
    VStack(alignment: .leading, spacing: 0) {
      // Composer board: the panel's centrepiece. Context chips, large text, a tool row, the white send.
      VStack(alignment: .leading, spacing: Theme.Composer2.gap) {
        HStack(spacing: Theme.Composer2.chipGap) {
          folderChip
          Spacer(minLength: 0)
          if !focused && !starting { KeyCap(text: "⌘K").accessibilityHidden(true) }
        }
        TextField("", text: $goal, axis: .vertical)
          .textFieldStyle(.plain).font(Theme.Composer2.projectFont).tracking(Theme.Composer2.projectTracking)
          .foregroundStyle(Theme.Composer.text).lineLimit(1...4)
          .background(alignment: .topLeading) {
            if goal.isEmpty { Text("Describe a project for your agents…").font(Theme.Composer2.projectFont).foregroundStyle(Theme.Composer.placeholder).allowsHitTesting(false) }
          }
          .padding(.horizontal, Theme.Composer2.textInset)
          .focused($focused).disabled(starting)
          .onSubmit(submit)
          .onKeyPress(.escape) {
            if model.setup.isOpen { model.cancelSetup(); return .handled }   // Esc cancels the setup, the goal stays
            if !goal.isEmpty { goal = ""; model.clearStart(); return .handled }
            focused = false; return .handled
          }
          .accessibilityLabel("Start a project")
        if showBranches { GoalBranchRows().disabled(starting).transition(.opacity) }
        Group {
          if let setup {
            InlineSetupSection(screen: setup, flow: model.setup, defaultKey: !focused, onPrimary: runPrimary,
                               onChooseAnother: { model.chooseProjectFolder() }, onCancel: { model.cancelSetup() },
                               onLogIn: { TerminalLauncher.githubLogin() })
              .transition(.opacity)
          } else {
            toolRow(ready: ready, starting: starting)
          }
        }
          // Its natural width, measured on a hidden copy: the panel widens to fit rather than squeezing it.
          .background(alignment: .leading) {
            toolRow(ready: ready, starting: starting).fixedSize().hidden().allowsHitTesting(false).accessibilityHidden(true)
              .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { model.composerRowWidth = $0 }
          }
      }
      .padding(Theme.Composer2.padding)
      .background { ComposerCard(focused: focused) }
      .contentShape(Rectangle())
      .onTapGesture { focused = true }
      .background { keyboardOnly("k") { focused = true } }
      .background {
        // Esc cancels the setup while the field isn't focused too (it handles Esc itself when it is).
        if model.setup.isOpen {
          Button { model.cancelSetup() } label: { EmptyView() }.keyboardShortcut(.cancelAction).opacity(0).frame(width: 0, height: 0).accessibilityHidden(true)
        }
      }
      .animation(Theme.Motion.fast, value: focused)
      .animation(Theme.Motion.fast, value: setup == nil)
      .animation(Theme.Motion.fast, value: showBranches)
      // The panel opens with nothing focused (idle look, ⌘K hint); ⌘K or a click focuses the field.
      .defaultFocus($focused, false)
      // AppKit makes the first text field first responder whenever the panel window becomes key; undo that on open.
      .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
        DispatchQueue.main.async { if goal.isEmpty { focused = false; NSApp.keyWindow?.makeFirstResponder(nil) } }
        // Back from Terminal (a GitHub CLI login, `capcomd setup project`): look at the folder again.
        if model.setup.isOpen { Task { await model.setup.refresh() } }
      }
      line(state, branches: showBranches)
    }
    .task { await model.refreshDaemonInfo() }   // capabilities and drivers, for the driver chip
    // The goal branch rows' checkout and goal; their question goes to the daemon when it changes: at once for a new
    // checkout, else 400 ms after the last keystroke.
    .task(id: branches ? model.startRepo : nil) { model.goalSetup.open(path: branches ? model.startRepo : nil); model.goalSetup.setGoal(goal) }
    .onChange(of: goal) { _, g in model.goalSetup.setGoal(g) }
    #if DEBUG
    .onReceive(NotificationCenter.default.publisher(for: MenuBarDebug.goal)) { goal = $0.object as? String ?? "" }
    .onReceive(NotificationCenter.default.publisher(for: MenuBarDebug.start)) { _ in submit() }
    #endif
    .task(id: model.goalSetup.query) {
      guard let q = model.goalSetup.query else { return }
      if !model.goalSetup.awaitingFirstAnswer { try? await Task.sleep(for: .milliseconds(400)) }
      guard !Task.isCancelled else { return }
      await model.loadBranches(q)
    }
  }

  /// Where the run goes: the remembered project checkout (× forgets it), else the daemon's default project. While a
  /// picked folder is looked at or set up, that folder, with a spinner or the orange "not set up" dot; × cancels.
  private var folderChip: some View {
    let place: ComposerFolderChip.Where
    if model.setup.isOpen, let path = model.setup.path {
      let screen = model.setupScreen(goal: "")
      place = .settingUp(name: screen?.name ?? (path as NSString).lastPathComponent, path: path, loading: screen?.phase == .loading)
    } else if let repo = model.startRepo {
      place = .checkout(path: repo)
    } else {
      place = .defaultProject
    }
    return ComposerFolderChip(place, remove: { if model.setup.isOpen { model.cancelSetup() } else { model.startRepo = nil } },
                              choose: { model.chooseProjectFolder() })
  }

  /// The composer's tool row (shared with the window's Home, CapcomdUI/ComposerToolRow.swift): + , where it runs, who
  /// drives it (by the send, like the reference's model menu), the mic, send.
  private func toolRow(ready: Bool, starting: Bool) -> some View {
    HStack(spacing: Theme.Composer2.chipGap) {
      addMenu
      ComposerPlaceSwitch(places: model.sandboxes, current: model.startSandbox?.name) { model.pickSandbox($0) }
      Spacer(minLength: 0)
      driverChip
      if starting { ProgressView().controlSize(.small).accessibilityLabel("Starting") }
      ComposerMicButton { focused = true }.disabled(starting)
      SendCircle(ready: ready, stop: false, label: "Start project", action: submit)
    }
  }

  /// Who drives the run (the planner agent) and on which model: each harness the daemon offers (`runs.driver`) with its
  /// models (`runs.options.models`), then the effort. The picks are remembered; a harness that can't run where the run
  /// would start stays listed, disabled, with the daemon's reason (always a menu, never a dead name). A daemon that
  /// offers no drivers (no `runs.options`): no chip.
  @ViewBuilder private var driverChip: some View {
    let m = model.modelMenu
    let levels = m.efforts
    if !m.sections.isEmpty {
      Menu {
        ForEach(m.sections) { s in
          Section(s.title) {
            ForEach(s.options) { o in
              Toggle(isOn: Binding(get: { o.checked }, set: { _ in model.pickModel(o) })) {
                Text(verbatim: o.note.isEmpty || o.note == s.title ? o.name : "\(o.name) · \(o.note)")
              }
              .disabled(!o.enabled)
            }
            if let why = s.reason { Button(why) {}.disabled(true) }
          }
        }
        // Reasoning effort for the picked driver, lowest first; the bars show it on the chip.
        if m.enabled, !levels.isEmpty {
          Divider()
          Picker("Effort", selection: Binding(get: { m.effort ?? EffortBars.auto }, set: { model.pickEffort($0 == EffortBars.auto ? nil : $0) })) {
            // Auto: send nothing; the CLI picks (offered when the driver has no fixed default).
            if m.offersAuto { Text("Auto").tag(EffortBars.auto) }
            ForEach(Array(levels.enumerated()), id: \.element) { i, l in
              Label { Text(verbatim: EffortBars.title(l)) } icon: { Image(systemName: "cellularbars", variableValue: EffortBars.value(i, of: levels.count)) }.tag(l)
            }
          }
          .pickerStyle(.inline)
        }
      } label: {
        DriverChipLabel(provider: Provider(wire: m.provider), text: m.chip, effort: m.effortIndex.map { ($0, levels.count) }, available: m.enabled)
      }
      .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
      .help(m.label)
      .accessibilityLabel(m.label)
    }
  }

  private var addMenu: some View {
    ComposerAddMenu {
      Button("Choose Project Folder…") { model.chooseProjectFolder() }
      if model.startRepo != nil { Button("Use the Default Project") { model.startRepo = nil } }
      Divider()
      Button("Settings…") { SettingsWindow.open(openSettings, host: model.settings.host) }
      // The menu bar item is the app's home: with no window open there's no app menu, so Quit lives here.
      Button("Quit capcomd") { NSApp.terminate(nil) }.keyboardShortcut("q", modifiers: .command)
    }
  }

  @ViewBuilder private func line(_ state: StartState, branches: Bool) -> some View {
    switch state {
    case .failed where branches && ["base", "goalBranch"].contains(model.startRefusedField ?? ""):
      EmptyView()   // shown under its field (GoalBranchRows)
    case .failed(let m), .needsRepo(let m):
      Text(verbatim: m).font(Theme.Composer.errorFont).foregroundStyle(Theme.red).lineLimit(3).help(m)   // the daemon's whole sentence on hover
        .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
        .transition(.opacity)
    case .started:
      Text("Started. It shows up below in a moment.").font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText)
        .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
        .transition(.opacity)
        .task { try? await Task.sleep(for: .seconds(4)); model.clearStart() }
    default: EmptyView()
    }
  }

  /// The card's primary (Set Up, Set Up and Start, Initialize Git, …). Set Up hands the field its focus back; Set Up and
  /// Start clears it, as a started run does.
  private func runPrimary(_ a: SetupAction) {
    let g = goal
    Task {
      switch await model.setupAction(a, goal: g) {
      case .setUp: focused = true
      case .started: goal = ""; focused = false
      case .startFailed, .showing: break
      }
    }
  }

  private func submit() {
    // Return while a folder's next steps show runs the card's primary when it's Set Up (or Set Up and Start).
    if let p = model.setupScreen(goal: goal)?.primary {
      if (p.action == .setUp || p.action == .setUpAndStart) && p.enabled && !p.busy { runPrimary(p.action) }
      return
    }
    if model.setup.isOpen { return }   // still looking at the folder
    let g = goal
    guard !g.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
    if model.goalBranchesOffered && !model.goalSetup.canStart { return }   // a base to pick first (the row says so)
    Task { if await model.startRun(g) { goal = ""; focused = false } }
  }
}

/// Asks for a project checkout (a folder `capcomd setup project` ran in) when the daemon has no default repository.
enum ProjectFolderPicker {
  /// An Open panel whose app isn't active is cancelled by the first click in it, so the app activates first (it's a
  /// regular app; a bare debug build starts as .prohibited, which can't, so it becomes regular too).
  /// The Open panel sits above the menu bar panel's level so the panel can't cover its buttons; the menu bar panel
  /// closes at the first click in the Open panel and opens again after a pick, on what the folder needs.
  @MainActor static func choose(prompt: String = "capcomd has no default repository. Choose the project's checkout.") async -> String? {
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
    p.prompt = "Use This Project"; p.message = prompt
    p.level = NSWindow.Level(NSWindow.Level.popUpMenu.rawValue + 1)   // above other apps' windows and the menu bar panel
    if NSApp.activationPolicy() != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate()
    let fromMenuBar = MenuBarPanel.isOpen
    let path: String? = await withCheckedContinuation { done in
      p.begin { r in done.resume(returning: r == .OK ? p.url?.path : nil) }
      p.makeKeyAndOrderFront(nil)
    }
    // The first click in the Open panel closed the menu bar panel: open it again on the picked folder's next steps.
    if fromMenuBar && path != nil { MenuBarPanel.open() }
    return path
  }
}

/// The MenuBarExtra's panel (its window class is SwiftUI's MenuBarExtraWindow).
enum MenuBarPanel {
  @MainActor static var isOpen: Bool { NSApp.windows.contains { $0.isVisible && isPanel($0) } }
  /// Closed as a click outside it would.
  @MainActor static func close() { for w in NSApp.windows where w.isVisible && isPanel(w) { w.close() } }

  /// Opens the panel as a click on the menu bar item does. SwiftUI has no API for it. On macOS 27 a window-style
  /// MenuBarExtra is presented through AppKit's (SPI) expanded interface session and its status button has no
  /// target or action, so a simulated click does nothing: begin the session, as MenuBarExtraAccess does
  /// (github.com/orchetect/MenuBarExtraAccess, MIT). The begin call drops a timestamp older than the last session's
  /// end, so it gets the largest one. Before macOS 27 the button's own action opens it.
  @MainActor static func open() {
    guard !isOpen, let item = statusItem else { return }
    let begin = NSSelectorFromString("_beginExpandedInterfaceSession:"), delegate = NSSelectorFromString("expandedInterfaceDelegate")
    if item.responds(to: begin), item.responds(to: delegate), item.perform(delegate)?.takeUnretainedValue() != nil,
       let imp = item.method(for: begin) {
      typealias Begin = @convention(c) (NSStatusItem, Selector, TimeInterval) -> Void
      unsafeBitCast(imp, to: Begin.self)(item, begin, .greatestFiniteMagnitude)
    } else {
      item.button?.performClick(nil)
    }
  }
  /// The status item behind the menu bar icon (a private key of its NSStatusBarWindow).
  @MainActor private static var statusItem: NSStatusItem? {
    NSApp.windows.lazy.filter { String(describing: type(of: $0)).contains("NSStatusBarWindow") }
      .compactMap { $0.value(forKey: "statusItem") as? NSStatusItem }.first
  }
  private static func isPanel(_ w: NSWindow) -> Bool { String(describing: type(of: w)).contains("MenuBarExtra") }
}

/// Composer board: the 20 pt composer card (glass on macOS 26+), its inner hairline and the soft blue focus ring.
struct ComposerCard: View {
  let focused: Bool
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Composer2.radius, style: .continuous)
    ControlSurface(shape: shape, fallback: Theme.Composer2.fill)
      .overlay(shape.strokeBorder(Theme.Composer2.stroke, lineWidth: 0.5))
      .background(shape.stroke(Theme.Composer2.ring, lineWidth: Theme.Composer2.ringWidth).padding(-Theme.Composer2.ringWidth / 2).opacity(focused ? 1 : 0))
  }
}

#endif
