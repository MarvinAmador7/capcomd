#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

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
    let ready = !goal.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !starting
    // A picked folder that isn't set up yet: its next steps take the tool row's place (design/setup).
    let setup = model.setupScreen(goal: goal).flatMap { $0.phase == .loading ? nil : $0 }
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
        Group {
          if let setup {
            InlineSetupSection(screen: setup, defaultKey: !focused, onPrimary: runPrimary).transition(.opacity)
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
      // The panel opens with nothing focused (idle look, ⌘K hint); ⌘K or a click focuses the field.
      .defaultFocus($focused, false)
      // AppKit makes the first text field first responder whenever the panel window becomes key; undo that on open.
      .onReceive(NotificationCenter.default.publisher(for: NSWindow.didBecomeKeyNotification)) { _ in
        DispatchQueue.main.async { if goal.isEmpty { focused = false; NSApp.keyWindow?.makeFirstResponder(nil) } }
        // Back from Terminal (a GitHub CLI login, `capcomd setup project`): look at the folder again.
        if model.setup.isOpen { Task { await model.setup.refresh() } }
      }
      line(state)
    }
    .task { await model.refreshDaemonInfo() }   // capabilities and drivers, for the driver chip
  }

  /// Where the run goes: the remembered project checkout (× forgets it), else the daemon's default project. While a
  /// picked folder is looked at or set up, that folder, with a spinner or the orange "not set up" dot; × cancels.
  @ViewBuilder private var folderChip: some View {
    if model.setup.isOpen, let path = model.setup.path {
      let screen = model.setupScreen(goal: "")
      Chip2(leading: AnyView(Image(systemName: "folder").font(.system(size: 11))), text: screen?.name ?? (path as NSString).lastPathComponent,
            onRemove: { model.cancelSetup() },
            trailing: AnyView(Group {
              if screen?.phase == .loading { ProgressView().controlSize(.mini).frame(width: Theme.Setup.spinner, height: Theme.Setup.spinner).accessibilityLabel("Looking at the folder") }
              else { SetupDot() }
            }))
        .help(path)
    } else if let repo = model.startRepo {
      Chip2(icon: "folder", text: (repo as NSString).lastPathComponent, onRemove: { model.startRepo = nil })
        .help(repo)
    } else {
      Button { model.chooseProjectFolder() } label: {
        Chip2(icon: "folder", text: "Default project", onRemove: nil)
      }
      .buttonStyle(.plain).help("capcomd's default project; click to choose a checkout")
    }
  }

  private func toolRow(ready: Bool, starting: Bool) -> some View {
    HStack(spacing: Theme.Composer2.chipGap) {
      addMenu
      sandboxSwitch
      Spacer(minLength: 0)
      driverChip   // who drives it sits by the send, like the reference's model menu
      if starting { ProgressView().controlSize(.small).accessibilityLabel("Starting") }
      SendCircle(ready: ready, stop: false, label: "Start project", action: submit)
    }
  }

  /// Where the run's agents work (owner's reference: the Web · Computer · Files group): Local (Docker on this Mac) or
  /// VM (boxd), as the daemon offers them. The pick is remembered; one it can't use now is dimmed, with its reason.
  @ViewBuilder private var sandboxSwitch: some View {
    if let current = model.startSandbox, model.sandboxes.count > 1 {
      HStack(spacing: 2) {
        ForEach(model.sandboxes) { s in
          let on = s.name == current.name
          Button { model.pickSandbox(s.name) } label: {
            // Icons only (owner's call); the name is the tooltip and what VoiceOver reads.
            Image(systemName: s.name == "boxd" ? "cloud" : "laptopcomputer").font(Theme.Composer2.segmentIcon)
              .foregroundStyle(on ? Color.white : Theme.Composer2.pillText)
              .frame(width: Theme.Composer2.segmentWidth, height: Theme.Composer2.pillHeight)
            .background {
              if on {
                Capsule().fill(Theme.Composer2.segmentOn)
                  .overlay(Capsule().strokeBorder(Theme.Composer2.segmentOnStroke, lineWidth: 0.5))
                  .shadow(color: .black.opacity(0.25), radius: 2, y: 1)
              }
            }
            .contentShape(Capsule())
          }
          .buttonStyle(PressableStyle()).disabled(!s.available).opacity(s.available ? 1 : 0.4)
          .help(s.available ? (s.name == "boxd" ? "\(s.label): agents run on boxd machines" : "\(s.label): agents run in Docker on this Mac")
                            : "\(s.label): \(s.reason ?? "unavailable")")
          .accessibilityLabel(s.label).accessibilityAddTraits(on ? .isSelected : [])
        }
      }
      .padding(3).background(Capsule().fill(Theme.Composer2.pillGroupFill))
      .fixedSize()
      .animation(Theme.Motion.fast, value: current.name)
      .accessibilityElement(children: .contain).accessibilityLabel("Where it runs")
    }
  }

  /// Who drives the run (the planner agent): Claude Code or Codex, as the daemon offers them (`runs.driver`). The
  /// choice is remembered; a driver the daemon reports unavailable is listed, disabled, with its reason.
  @ViewBuilder private var driverChip: some View {
    if let current = model.startDriver, let provider = Provider(wire: current.provider) {
      Menu {
        Picker("Driver", selection: Binding(get: { current.provider }, set: { model.pickDriver($0) })) {
          ForEach(model.drivers.filter(\.available)) { d in Text(verbatim: d.label + (d.model.map { " · \($0)" } ?? "")).tag(d.provider) }
        }
        .pickerStyle(.inline)
        ForEach(model.drivers.filter { !$0.available }) { d in
          Button(d.label + (d.reason.map { " (\($0))" } ?? " (unavailable)")) {}.disabled(true)
        }
        // Reasoning effort for the picked driver, lowest first; the bars show it on the chip.
        if let levels = current.efforts, !levels.isEmpty {
          Divider()
          Picker("Effort", selection: Binding(get: { model.startEffort ?? EffortBars.auto }, set: { model.pickEffort($0 == EffortBars.auto ? nil : $0) })) {
            // Auto: send nothing; the CLI picks (offered when the driver has no fixed default).
            if current.effort == nil { Text("Auto").tag(EffortBars.auto) }
            ForEach(Array(levels.enumerated()), id: \.element) { i, l in
              Label { Text(verbatim: EffortBars.title(l)) } icon: { Image(systemName: "cellularbars", variableValue: EffortBars.value(i, of: levels.count)) }.tag(l)
            }
          }
          .pickerStyle(.inline)
        }
      } label: {
        let effort = model.startEffort, levels = current.efforts ?? []
        Chip2(leading: ProviderMark(provider: provider, size: Theme.Provider.chipMark).foregroundStyle(ProviderMarks.badgeTint(provider)),
              text: current.label, chevron: true, onRemove: nil,
              trailing: effort.flatMap { levels.firstIndex(of: $0) }.map { AnyView(EffortBars(level: $0, of: levels.count)) })
      }
      .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
      .help(([current.label, current.model, model.startEffort.map { "\(EffortBars.title($0)) effort" }] as [String?]).compactMap { $0 }.joined(separator: " · "))
      .accessibilityLabel("Driver: \(current.label)" + (model.startEffort.map { ", \(EffortBars.title($0)) effort" } ?? ""))
    } else if let shown = model.drivers.first(where: { $0.isDefault == true }) ?? model.drivers.first, let provider = Provider(wire: shown.provider) {
      // No driver can run (no planner profile, no login): the chip stays, dimmed, and says why, instead of vanishing.
      Menu {
        ForEach(model.drivers) { d in Button(d.label + (d.reason.map { " (\($0))" } ?? " (unavailable)")) {}.disabled(true) }
      } label: {
        Chip2(leading: ProviderMark(provider: provider, size: Theme.Provider.chipMark).foregroundStyle(Theme.Composer2.chipX),
              text: shown.label, chevron: true, onRemove: nil)
          .opacity(Theme.Composer2.unavailableOpacity)
      }
      .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
      .help(shown.reason ?? "No AI can drive a run yet")
      .accessibilityLabel("Driver unavailable: \(shown.reason ?? "no AI can drive a run yet")")
    }
  }

  private var addMenu: some View {
    Menu {
      Button("Choose Project Folder…") { model.chooseProjectFolder() }
      if model.startRepo != nil { Button("Use the Default Project") { model.startRepo = nil } }
      Divider()
      Button("Settings…") { SettingsWindow.open(openSettings) }
    } label: {
      Image(systemName: "plus").font(Theme.Composer2.plusFont).foregroundStyle(.white)
        .frame(width: Theme.Composer2.round, height: Theme.Composer2.round)
        .background(Circle().fill(Theme.Composer2.roundFill)).overlay(Circle().strokeBorder(Theme.Composer2.roundStroke, lineWidth: 0.5))
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .accessibilityLabel("Add")
  }

  @ViewBuilder private func line(_ state: StartState) -> some View {
    switch state {
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
    Task { if await model.startRun(g) { goal = ""; focused = false } }
  }
}

/// Asks for a project checkout (a folder `capcomd setup project` ran in) when the daemon has no default repository.
enum ProjectFolderPicker {
  /// An accessory app can't become the active app on current macOS (see SettingsWindow), and an Open panel whose app
  /// can't become active is cancelled by the first click in it: no folder came back. So, as Settings does, the app is
  /// a regular app while the panel is up and an accessory again after. The menu bar panel closes first (it would stay
  /// on top); the composer shows what the picked folder needs the next time it opens.
  @MainActor static func choose(prompt: String = "capcomd has no default repository. Choose the project's checkout.") async -> String? {
    MenuBarPanel.close()
    let p = NSOpenPanel()
    p.canChooseDirectories = true; p.canChooseFiles = false; p.allowsMultipleSelection = false
    p.prompt = "Use This Project"; p.message = prompt
    p.level = .floating   // above the frontmost app's windows even before the app is active
    // Not just .accessory: a bare debug build starts as .prohibited, which can't become active either.
    let policy = NSApp.activationPolicy()
    if policy != .regular { NSApp.setActivationPolicy(.regular) }
    NSApp.activate()
    let path: String? = await withCheckedContinuation { done in
      p.begin { r in done.resume(returning: r == .OK ? p.url?.path : nil) }
      p.makeKeyAndOrderFront(nil)
    }
    if policy != .regular && !SettingsWindow.isOpen { NSApp.setActivationPolicy(policy) }
    return path
  }
}

/// The MenuBarExtra's panel (its window class is SwiftUI's MenuBarExtraWindow), closed as a click outside it would.
enum MenuBarPanel {
  @MainActor static func close() { for w in NSApp.windows where w.isVisible && isPanel(w) { w.close() } }
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

/// A context chip: icon or bot, text, an optional ×.
struct Chip2<Leading: View>: View {
  let leading: Leading
  let text: String
  var mono = false
  var tint: Color? = nil
  /// A dropdown chip: a small chevron after the text.
  var chevron = false
  let onRemove: (() -> Void)?
  /// Shown after the text, before the chevron (the driver chip's effort bars).
  var trailing: AnyView? = nil
  var body: some View {
    HStack(spacing: Theme.Composer2.chipInnerGap) {
      leading
      Text(verbatim: text).font(mono ? Theme.Composer2.chipMono : Theme.Composer2.chipFont).lineLimit(1)
      if let trailing { trailing }
      if chevron { Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Composer2.chipX) }
      if let onRemove {
        Button(action: onRemove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Composer2.chipX) }
          .buttonStyle(.plain).accessibilityLabel("Remove \(text)")
      }
    }
    .foregroundStyle(tint ?? .white)
    .padding(.horizontal, Theme.Composer2.chipPadding).frame(height: Theme.Composer2.chipHeight)
    .background(Capsule().fill(tint.map { $0.opacity(0.16) } ?? Theme.Composer2.chipFill))
    .overlay(Capsule().strokeBorder(tint == nil ? Theme.Composer2.chipStroke : .clear, lineWidth: 0.5))
  }
}
extension Chip2 where Leading == AnyView {
  init(icon: String, text: String, mono: Bool = false, tint: Color? = nil, onRemove: (() -> Void)?) {
    self.init(leading: AnyView(Image(systemName: icon).font(.system(size: 11))), text: text, mono: mono, tint: tint, chevron: false, onRemove: onRemove)
  }
}

/// The white round send (Composer board); the stop square while the agent works; dim when there's nothing to send.
struct SendCircle: View {
  let ready: Bool
  let stop: Bool
  let label: String
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      ZStack {
        // Always a white surface (owner's call); with nothing to send only the arrow dims.
        Circle().fill(Color.white)
        if stop { RoundedRectangle(cornerRadius: 1.5, style: .continuous).fill(Color.black).frame(width: 9, height: 9) }
        else { Image(systemName: "arrow.up").font(Theme.Composer2.sendIcon).foregroundStyle(Color.black.opacity(ready ? 1 : Theme.Composer2.sendArrowIdle)) }
      }
      .frame(width: Theme.Composer2.send, height: Theme.Composer2.send)
      .shadow(color: .black.opacity(0.35), radius: 6, y: 3)
    }
    .buttonStyle(PressableStyle())
    .disabled(!(ready || stop))
    .accessibilityLabel(label)
  }
}

/// Reasoning effort as signal bars (owner's pick, after the reference's "Deep" control): `cellularbars` filled to the
/// level's place among the driver's levels, so 4 levels fill 1–4 bars and 3 levels 2–4.
struct EffortBars: View {
  let level: Int
  let of: Int
  var body: some View {
    Image(systemName: "cellularbars", variableValue: Self.value(level, of: of))
      .font(Theme.Composer2.effortFont).foregroundStyle(Theme.Composer2.effortText)
      .accessibilityHidden(true)
  }
  /// The bar fill for level `i` of `n` (lowest first), spread over four bars: the top level fills all four; with more
  /// than four levels the top two share four bars (Claude's xhigh and max).
  static func value(_ i: Int, of n: Int) -> Double { n <= 1 ? 1 : Double(max(1, Int((Double(i + 1) * 4 / Double(n)).rounded(.up)))) / 4 }
  static func title(_ level: String) -> String {
    switch level { case "xhigh": "Extra high"; case "max": "Max"; default: level.prefix(1).uppercased() + level.dropFirst() }
  }
  /// The stored pick for "let the CLI choose".
  static let auto = UIPreferences.autoEffort
}

/// A keycap (⌘K, ⌥, Space).
struct KeyCap: View {
  let text: String
  var body: some View {
    Text(verbatim: text).font(Theme.Composer2.keyFont).foregroundStyle(Theme.Composer2.keyText)
      .padding(.horizontal, 6).padding(.vertical, 2)
      .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.Composer2.keyStroke, lineWidth: 0.5))
  }
}
#endif
