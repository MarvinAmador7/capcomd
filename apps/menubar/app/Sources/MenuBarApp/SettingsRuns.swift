#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

/// Settings › Runs (Runs.dc.html; States: building an agent environment): what new runs start with, and each place
/// agents can run, with its agent environment. "Runs on" and each place's Default / Make Default are one setting,
/// the composer's starting place, which the composer's Local / Cloud switch changes too. A place's Details… (daemons
/// with `sandboxes`) pushes its details screen in place of the pane (SettingsPlaceDetails.swift); back returns here.
struct RunsPane: View {
  @Environment(AppModel.self) private var model
  private static let chooseFolder = "\u{1}choose"
  /// The place whose details are pushed, if any.
  @State private var details: String?

  var body: some View {
    Group {
      if let name = details {
        PlaceDetailsView(name: name) { details = nil }
      } else {
        runs
      }
    }
    // A new identity per screen: the window fits each one afresh (PaneFit), and the pushed screen starts its own polling.
    .paneFit()
    .id(details ?? "")
  }

  @ViewBuilder private var runs: some View {
    let live = model.connection.live
    let places = model.hasRunOptions ? model.sandboxes : []
    let envs = model.environmentRows
    Form {
      Section {
        projectRow
        if model.hasRunOptions {
          driverRow
          effortRow
          placeRow
        }
      } header: {
        Text("New runs")
      } footer: {
        Foot(verbatim: model.hasRunOptions ? "The composer starts with these. Picking something else there changes them here too."
                                           : "This version of capcomd can't list drivers or places to run. Update capcomd to choose them here.")
      }

      ForEach(Array(places.enumerated()), id: \.element.id) { i, place in
        PlaceSection(place: place, descriptor: model.descriptor(place.name), env: envs?.first { $0.sandbox == place.name },
                     isDefault: model.defaultPlace?.name == place.name, last: i == places.count - 1,
                     environmentsUnsupported: model.environmentsUnsupported, live: live) { details = place.name }
      }
    }
    .formStyle(.grouped)
  }

  /// The project checkout new runs go to (the composer's folder chip), or capcomd's default project.
  private var projectRow: some View {
    Picker(selection: Binding(get: { model.startRepo ?? "" }, set: { v in
      if v == Self.chooseFolder {
        if let f = ProjectFolderPicker.choose(prompt: "Choose the project's checkout.") { model.startRepo = f }
      } else {
        model.startRepo = v.isEmpty ? nil : v
      }
    })) {
      Label("Default project", systemImage: "folder").tag("")
      if let repo = model.startRepo { Label((repo as NSString).lastPathComponent, systemImage: "folder").tag(repo) }
      Divider()
      Text("Choose Folder…").tag(Self.chooseFolder)
    } label: {
      Text("Project")
    }
    .pickerStyle(.menu)
    .help(model.startRepo ?? "capcomd's default project")
  }

  /// Who drives new runs as their planner, as the default place has them; one that can't run there is disabled.
  @ViewBuilder private var driverRow: some View {
    let drivers = model.defaultPlaceDrivers
    let current = model.startDriver?.provider ?? ""
    Picker(selection: Binding(get: { current }, set: { model.pickDriver($0) })) {
      if current.isEmpty { Text("None available").tag("") }
      ForEach(drivers) { d in
        Label { Text(verbatim: d.label) } icon: { Provider(wire: d.provider).map(MenuMarks.provider) }
          .tag(d.provider).disabled(!d.available)
      }
    } label: {
      Text("Driven by")
    }
    .pickerStyle(.menu)
    .help(drivers.filter { !$0.available }.map { "\($0.label): \($0.reason ?? "unavailable")" }.joined(separator: "\n"))
  }

  /// The driver's reasoning effort, lowest first; Auto when the driver has no default (Claude Code picks per model).
  @ViewBuilder private var effortRow: some View {
    if let d = model.startDriver, let levels = d.efforts, !levels.isEmpty {
      Picker(selection: Binding(get: { model.startEffort ?? EffortBars.auto }, set: { model.pickEffort($0 == EffortBars.auto ? nil : $0) })) {
        if d.effort == nil {
          Label { Text("Auto") } icon: { Image(systemName: "cellularbars", variableValue: 0.25) }.tag(EffortBars.auto)
        }
        ForEach(Array(levels.enumerated()), id: \.element) { i, l in
          Label { Text(verbatim: EffortBars.title(l)) } icon: { Image(systemName: "cellularbars", variableValue: EffortBars.value(i, of: levels.count)) }.tag(l)
        }
      } label: {
        Text("Effort")
        Text(verbatim: "How hard the planner thinks." + (d.effort == nil ? " Auto lets \(d.label) decide." : ""))
      }
      .pickerStyle(.menu)
    }
  }

  /// The default place, as a popup of every place the daemon lists (more clouds join it as capcomd adds them).
  private var placeRow: some View {
    Picker(selection: Binding(get: { model.defaultPlace?.name ?? "" }, set: { model.setDefaultPlace($0) })) {
      if model.defaultPlace == nil { Text("None").tag("") }
      ForEach(model.sandboxes) { s in
        let d = model.descriptor(s.name)
        Label { Text(verbatim: d.map(\.displayTitle) ?? PlaceNames.menu(s)) } icon: { MenuMarks.place(d?.mark ?? s.name, kind: d?.kind) }.tag(s.name)
      }
    } label: {
      Text("Runs on")
      Text("Where new runs go. More clouds show here as capcomd supports them.")
    }
    .pickerStyle(.menu)
  }
}

/// One place agents run: whether it can be used now, and its agent environment. With a descriptor (daemons with
/// `sandboxes`) everything provider-specific comes from it; without one, the names docker and boxd decide, as before.
struct PlaceSection: View {
  @Environment(AppModel.self) private var model
  let place: SandboxInfo
  let descriptor: SandboxDescriptor?
  let env: EnvironmentRow?
  let isDefault: Bool
  let last: Bool
  let environmentsUnsupported: Bool
  let live: Bool
  /// Details…: pushes the place's details screen.
  let showDetails: () -> Void

  var body: some View {
    let title = descriptor?.label ?? PlaceNames.title(place.name, label: place.label)
    Section {
      statusRow
      if let env { PlaceEnvironmentRow(env: env, title: title) }
    } header: {
      PlaceHeader(name: place.name, descriptor: descriptor, fallbackTitle: PlaceNames.header(place), fallbackLabel: place.label, isDefault: isDefault, showDetails: descriptor == nil ? nil : showDetails)
    } footer: {
      VStack(alignment: .leading, spacing: 4) {
        if let w = model.handOffs.waiting(HandOffKey.environment(place.name)) ?? model.handOffs.waiting(setupKey) {
          OpenedFoot(command: w.command)
        }
        if env?.state == .building {
          Foot(verbatim: "Runs on \(title) start once it's built.")
        } else if let foot = descriptor.map(SandboxRows.placeFootnote) ?? (place.name == "docker" ? "Agents work in containers on this Mac." : nil) {
          Foot(verbatim: foot)
        }
        if last {
          if env != nil { Foot(verbatim: "An agent environment holds the agents' tools, built once for each place they run. It never holds logins or keys.") }
          else if environmentsUnsupported { Foot(verbatim: "Update capcomd to see each place's agent environment here.") }
        }
        if !live { Foot(verbatim: "Shown when capcomd is running.") }
      }
    }
    .disabled(!live)
  }

  /// The hand-off a Set Up… on the status row starts.
  private var setupKey: String { descriptor == nil ? (place.name == "boxd" ? HandOffKey.boxdKey : HandOffKey.placeSetup(place.name)) : HandOffKey.placeSetup(place.name) }

  @ViewBuilder private var statusRow: some View {
    if let descriptor { PlaceStatusRow(descriptor: descriptor, place: place) } else { legacyStatusRow }
  }

  /// Daemons without `sandboxes`: the row as it was, by name.
  @ViewBuilder private var legacyStatusRow: some View {
    let reason = PlaceNames.reason(place.reason)
    LabeledContent(PlaceNames.engine(place.name)) {
      HStack(spacing: Theme.Settings.rowGap) {
        if place.name == "boxd" && model.handOffs.waiting(HandOffKey.boxdKey) != nil {
          WaitingValue()
          Button("Show Terminal") { TerminalLauncher.showTerminal() }
        } else if place.available {
          StatusValue(.ok, place.name == "docker" ? "Running" : "Ready")
        } else if place.name == "boxd" {
          StatusValue(.empty, reason ?? "No boxd API key")
          Button("Set Up…") { model.handOff(HandOffKey.boxdKey, command: SettingsRows.boxdKeyCommand, baseline: "\(model.boxdKey)") }
            .prominent()
            .accessibilityHint("Opens Terminal to set the boxd API key.")
        } else {
          StatusValue(.bad, reason ?? "Can't be used now")
        }
      }
    }
  }
}

/// A place's agent environment: ready, not built, building, failed, or waiting on Terminal.
struct PlaceEnvironmentRow: View {
  @Environment(AppModel.self) private var model
  let env: EnvironmentRow
  let title: String

  var body: some View {
    let key = HandOffKey.environment(env.sandbox)
    let build = { (command: String) in _ = model.handOff(key, command: command, baseline: env.fingerprint) }
    if model.handOffs.waiting(key) != nil {
      LabeledContent {
        HStack(spacing: Theme.Settings.rowGap) {
          WaitingValue()
          Button("Show Terminal") { TerminalLauncher.showTerminal() }
        }
      } label: {
        Text("Agent environment")
        Text("The build runs in the Terminal window.")
      }
    } else {
      switch env.state {
      case .building:
        LabeledContent {
          HStack(spacing: Theme.Settings.rowGap) {
            ProgressView().progressViewStyle(.linear).frame(width: Theme.Settings.progressWidth)
              .accessibilityLabel("Building the agent environment")
            if TerminalLauncher.terminalRunning { Button("Show Log") { TerminalLauncher.showTerminal() } }
          }
        } label: {
          Text("Agent environment")
          Text("Installing Claude Code and Codex. This takes a few minutes; you can close Settings.")
        }
      case .ready:
        LabeledContent {
          HStack(spacing: Theme.Settings.rowGap) {
            StatusValue(.ok, "Ready")
            Button("Rebuild…") { build(env.rebuildCommand) }.accessibilityHint("Opens Terminal to rebuild it.")
          }
        } label: {
          Text("Agent environment")
          Text(verbatim: Self.summary(env))
        }
      case .missing:
        LabeledContent {
          HStack(spacing: Theme.Settings.rowGap) {
            StatusValue(.warn, "Not built")
            Button("Build…") { build(env.command) }.prominent().accessibilityHint("Opens Terminal to build it.")
          }
        } label: {
          Text("Agent environment")
          Text(verbatim: "Not built yet: runs on \(title) can't start until it is.")
        }
      case .failed:
        LabeledContent {
          HStack(spacing: Theme.Settings.rowGap) {
            StatusValue(.bad, "Failed")
            Button("Try Again…") { build(env.command) }.prominent().accessibilityHint("Opens Terminal to build it again.")
          }
        } label: {
          Text("Agent environment")
          Text("The last build didn't finish. Terminal shows why when you try again.")
        }
      case .unknown:
        LabeledContent("Agent environment") {
          HStack(spacing: Theme.Settings.rowGap) {
            StatusValue(.empty, "Unknown")
            Button("Build…") { build(env.command) }
          }
        }
      }
    }
  }

  /// "Claude Code 2.1.303 · Codex 0.163.0 · built Oct 24".
  static func summary(_ env: EnvironmentRow) -> String {
    var parts = env.versions.map { "\($0.tool) \($0.version)" }
    if let at = env.builtAt { parts.append("\(parts.isEmpty ? "Built" : "built") \(at.formatted(.dateTime.month(.abbreviated).day()))") }
    return parts.isEmpty ? "Built" : parts.joined(separator: " · ")
  }
}
#endif
