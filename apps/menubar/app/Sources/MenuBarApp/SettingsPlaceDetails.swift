#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

/// Settings › Runs › a place's Details… (CloudExplore.dc.html; ADR-021 §6: phase 1 read-only plus Open in Terminal;
/// phase 2 a setting the daemon marks `editable` can be changed, with `sandboxes.settings` and the `configure` scope).
/// One generic screen for every place: the sections and their order are fixed here, as on the board; which rows appear
/// and what they say come from the daemon (`/v1/sandboxes/{name}`, `…/resources`, `/v1/logins`, `/v1/environments`).
/// It opens as a sheet on the Settings window (Details… on the place's status row, as Wi-Fi's Details…), Done or Esc
/// closes it; it is as tall as its content up to the screen's visible height, then scrolls.
struct PlaceDetailsView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  let name: String
  /// The machine whose terminal command is being asked for.
  @State private var opening: String?
  /// Why the last Open in Terminal didn't open.
  @State private var openProblem: String?

  var body: some View {
    let live = model.connection.live
    let d = model.descriptor(name)
    let place = model.sandboxes.first { $0.name == name }
    let title = d?.label ?? PlaceNames.title(name, label: place?.label)
    let sections = model.sandboxDetail(name).map(SandboxRows.sections) ?? DetailSections()
    let isDefault = model.defaultPlace?.name == name
    VStack(alignment: .leading, spacing: 0) {
      Form {
        Section {
          if let d { PlaceStatusRow(descriptor: d, place: place, isDefault: isDefault, canMakeDefault: place != nil) }
          ForEach(sections.status) { setting($0) }
          if let env = model.environmentRows?.first(where: { $0.sandbox == name }) { PlaceEnvironmentRow(env: env, title: title) }
        } header: {
          PlaceHeader(name: name, descriptor: d, fallbackLabel: place?.label)
        } footer: {
          VStack(alignment: .leading, spacing: 4) {
            if let w = model.handOffs.waiting(HandOffKey.environment(name)) ?? model.handOffs.waiting(HandOffKey.placeSetup(name)) {
              OpenedFoot(command: w.command)
            }
            if let foot = d.flatMap(SandboxRows.placeFootnote) { Foot(verbatim: foot) }
            if !model.resourcesSupported { Foot(verbatim: "Update capcomd to see machines here.") }
            if !live { Foot(verbatim: "Shown when capcomd is running.") }
          }
        }

        machines(d, idle: sections.machines)
        safety(d, rows: sections.safety)
        if !sections.more.isEmpty {
          Section("Options") { ForEach(sections.more) { setting($0) } }
        }
      }
      .formStyle(.grouped)
      .disabled(!live)
      .sheetFit(reserve: Theme.Settings.Details.actionsHeight)
      Divider()
      HStack {
        Spacer(minLength: 0)
        Button("Done") { dismiss() }
          .keyboardShortcut(.defaultAction)
      }
      .padding(.horizontal, Theme.Settings.Details.actionsPaddingH)
      .frame(height: Theme.Settings.Details.actionsHeight)
    }
    .frame(width: Theme.Settings.Details.sheetWidth)
    // The daemon caches provider calls, so the machines are cheap to read every few seconds while this shows.
    .task(id: name) {
      while !Task.isCancelled {
        await model.refreshSandbox(name)
        try? await Task.sleep(for: .seconds(Theme.Settings.poll))
      }
    }
    .onExitCommand { dismiss() }
  }

  /// A setting as the store says it can be shown here: a picker that changes it, or its value read-only.
  private func setting(_ field: SandboxField) -> some View {
    let name = name
    return FieldRow(field: field, control: model.fieldControl(name, field)) { model.changeSetting(name, id: field.id, to: $0) }
  }

  /// Machines: what capcomd runs at this place now, owned ones first, then any left behind; then the idle lifetime.
  @ViewBuilder private func machines(_ d: SandboxDescriptor?, idle: [SandboxField]) -> some View {
    if model.resourcesSupported {
      let fetched = model.sandboxResources(name)
      let page = fetched?.value
      Section {
        switch fetched {
        case .loaded(let page):
          let rows = SandboxRows.machines(page, descriptor: d)
          if rows.isEmpty { Text("No machines running.").foregroundStyle(.secondary) }
          ForEach(rows) { row in MachineRowView(row: row, opening: opening == row.id) { open(row) } }
        case .unavailable:
          LabeledContent("Machines") { StatusValue(.empty, "Couldn't list them just now") }
        case .loading, nil:
          HStack(spacing: Theme.Settings.valueGap) {
            ProgressView().controlSize(.small).accessibilityHidden(true)
            Text("Looking for machines…").foregroundStyle(.secondary)
          }
        }
        ForEach(idle) { setting($0) }
      } header: {
        Text("Machines")
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          if let page, page.stale { Foot(verbatim: Self.staleNote(d?.vendorName ?? name, asOf: page.asOf)) }
          if let page, page.next != nil { Foot(verbatim: "Showing the first \(page.resources.count) machines.") }
          if let openProblem { Foot(verbatim: openProblem) }
        }
      }
    } else if !idle.isEmpty {
      Section("Machines") { ForEach(idle) { setting($0) } }
    }
  }

  /// "Couldn't reach boxd just now. These are the machines it listed at 10:22."
  static func staleNote(_ provider: String, asOf: String?) -> String {
    let at = asOf.flatMap(SettingsRows.parseISO).map { " These are the machines it listed at \($0.formatted(date: .omitted, time: .shortened))." } ?? ""
    return "Couldn't reach \(provider) just now.\(at)"
  }

  /// Safety: Logins (from `/v1/logins` `hostBound` / `boundTo`), Checkpoints and other info rows from the daemon.
  @ViewBuilder private func safety(_ d: SandboxDescriptor?, rows: [SandboxField]) -> some View {
    let summary = SandboxRows.loginsSummary(model.loginList, sandbox: name)
    let loginField = rows.first { $0.id == SandboxRows.logins }
    let rest = summary == nil ? rows : rows.filter { $0.id != SandboxRows.logins }
    if summary != nil || !rest.isEmpty {
      Section {
        if let summary {
          LabeledContent {
            StatusValue(summary.tone.dot, summary.text)
          } label: {
            Text(verbatim: loginField?.label ?? "Logins")
            Text(verbatim: summary.sub)
          }
        }
        ForEach(rest) { FieldRow(field: $0) }
      } header: {
        Text("Safety")
      } footer: {
        if let foot = SandboxRows.bindingFootnote(model.sandboxDescriptors) { Foot(verbatim: foot) }
      }
    }
  }

  private func open(_ row: MachineRow) {
    opening = row.id; openProblem = nil
    Task {
      let result = await model.terminalCommand(sandbox: name, resource: row.id)
      opening = nil
      switch result {
      case .ready(let command):
        if !TerminalLauncher.shell(command, name: "shell-\(row.id)") { openProblem = "Couldn't open Terminal." }
      case .refused:
        NSSound.beep()
        openProblem = "capcomd sent a command this app doesn't run, so nothing was opened."
      case .unavailable(let why):
        openProblem = why
      }
    }
  }
}

/// A place's section header: its mark and its kind of place ("Local", "Cloud"). Which provider is the default, and
/// Details…, are on the provider's status row below.
struct PlaceHeader: View {
  let name: String
  let descriptor: SandboxDescriptor?
  /// The place's label when there is no descriptor ("Local", from run-options).
  var fallbackLabel: String? = nil

  var body: some View {
    HStack(spacing: Theme.Settings.headerGap) {
      if let d = descriptor { PlaceMark(mark: d.mark ?? d.name, kind: d.kind) } else { PlaceMark(name: name) }
      Text(verbatim: descriptor?.label ?? PlaceNames.title(name, label: fallbackLabel))
    }
  }
}

/// A provider's name on its status row, with the Default badge when new runs start there.
struct PlaceRowLabel: View {
  let text: String
  let title: String
  let isDefault: Bool

  var body: some View {
    HStack(spacing: Theme.Settings.headerGap) {
      Text(verbatim: text)
      if isDefault { DefaultBadge().accessibilityLabel("\(title) is the default") }
    }
  }
}

/// The trailing controls every status row shares: Make Default where this isn't the default, then Details….
struct PlaceRowActions: View {
  @Environment(AppModel.self) private var model
  let name: String
  let title: String
  let canMakeDefault: Bool
  let showDetails: (() -> Void)?

  var body: some View {
    if canMakeDefault {
      Button("Make Default") { model.setDefaultPlace(name) }
        .accessibilityLabel("Make \(title) the default")
    }
    if let showDetails {
      Button("Details…", action: showDetails)
        .accessibilityLabel("\(title) details")
        .accessibilityHint("Shows its machines, logins and checkpoints.")
    }
  }
}

/// Whether a place can be used now, from its descriptor: "Running" / "Ready", or the daemon's reason, with Set Up…
/// when the reason names a capcomd command to run; then Make Default (or the Default badge by the name) and Details….
struct PlaceStatusRow: View {
  @Environment(AppModel.self) private var model
  let descriptor: SandboxDescriptor
  let place: SandboxInfo?
  let isDefault: Bool
  var canMakeDefault = true
  var showDetails: (() -> Void)? = nil

  var body: some View {
    let s = SandboxRows.status(descriptor, place: place)
    let key = HandOffKey.placeSetup(descriptor.name)
    LabeledContent {
      HStack(spacing: Theme.Settings.rowGap) {
        if model.handOffs.waiting(key) != nil {
          WaitingValue()
          Button("Show Terminal") { TerminalLauncher.showTerminal() }
        } else {
          StatusValue(s.tone.dot, s.text)
          if let command = s.setupCommand {
            Button("Set Up…") { model.handOff(key, command: command, baseline: s.fingerprint) }
              .prominent()
              .accessibilityHint("Opens Terminal to set up \(descriptor.vendorName).")
          }
        }
        PlaceRowActions(name: descriptor.name, title: descriptor.label, canMakeDefault: canMakeDefault && !isDefault, showDetails: showDetails)
      }
    } label: {
      PlaceRowLabel(text: descriptor.vendorName, title: descriptor.label, isDefault: isDefault)
    }
  }
}

/// One row the daemon describes, by type: `choice` a popup, `toggle` a switch, `info` / `status` a value; any type
/// this app doesn't know shows its label and the daemon's text, read-only. A value set in capcomd's environment shows
/// the daemon's text instead of a control. A popup can be used only when the store says so (`FieldControl`); a choice
/// sends `pick`, and the row shows the choice on its way until the daemon answers. The store's note (the daemon's
/// refusal, or "Reset your token to change these") goes under the label.
struct FieldRow: View {
  let field: SandboxField
  var control: FieldControl? = nil
  var pick: ((String) -> Void)? = nil

  var body: some View {
    switch field.kind {
    case .choice where !field.fromEnvironment && !field.choices.isEmpty:
      let current = control?.selection ?? field.value.text ?? ""
      let editable = control?.editable == true && pick != nil
      Picker(selection: Binding(get: { current }, set: { v in if v != current { pick?(v) } })) {
        ForEach(field.choices, id: \.value) { c in Text(verbatim: c.label).tag(c.value) }
        if !field.choices.contains(where: { $0.value == current }) { Text(verbatim: field.shown).tag(current) }
      } label: {
        label
      }
      .pickerStyle(.menu)
      .disabled(!editable)
      .accessibilityHint(control?.saving == true ? "Saving." : "")
    case .toggle where !field.fromEnvironment:
      Toggle(isOn: .constant(field.value.bool ?? false)) { label }
        .disabled(true)
    case .status:
      LabeledContent { StatusValue(Self.tone(field.state).dot, field.shown) } label: { label }
    default:
      LabeledContent { StatusValue(nil, field.shown) } label: { label }
    }
  }

  @ViewBuilder private var label: some View {
    Text(verbatim: field.label)
    if let help = field.help, !help.isEmpty { Text(verbatim: help) }
    if let note = control?.note { Text(verbatim: note) }
  }

  static func tone(_ state: String?) -> Tone {
    switch state { case "ok": .ok; case "warn": .warn; case "bad", "error": .bad; case "empty", "none": .empty; default: .none }
  }
}

extension AppModel {
  /// How a place's setting shows here (CapcomdStore.fieldControl): a picker or read-only, and the note under it.
  func fieldControl(_ sandbox: String, _ field: SandboxField) -> FieldControl { _ = revision; return store.fieldControl(sandbox: sandbox, field) }
  /// Sends a new value for a place's setting (`PATCH …/settings`); the row follows the store.
  func changeSetting(_ sandbox: String, id: String, to value: String) {
    let s = store
    Task { await s.changeSetting(sandbox: sandbox, id: id, to: value) }
  }
}

/// A machine (`.mrow`): its state's dot, who uses it, its age, and Open in Terminal when it can be opened.
struct MachineRowView: View {
  let row: MachineRow
  let opening: Bool
  let open: () -> Void

  var body: some View {
    HStack(spacing: Theme.Settings.Details.machineGap) {
      if let dot = row.tone.dot { StatusDot(kind: dot) }
      Text(verbatim: row.title).lineLimit(1).truncationMode(.tail)
        .frame(maxWidth: .infinity, alignment: .leading)
      Text(verbatim: row.age).font(Theme.Settings.Details.ageFont).foregroundStyle(.secondary)
      if row.canOpenTerminal {
        if opening { ProgressView().controlSize(.mini).accessibilityHidden(true) }
        Button("Open in Terminal", action: open)
          .controlSize(.small)
          .disabled(opening)
          .accessibilityHint("Opens a shell in this machine in Terminal.")
      }
    }
    .font(Theme.Settings.Details.machineFont)
    .help(help)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(help)
  }

  /// "relay-3f9c2a1b · started 4 min ago · deleted at 10:22 if left idle".
  private var help: String {
    var parts = [row.title, row.id]
    if !row.age.isEmpty { parts.append(row.age == "now" ? "started just now" : "started \(row.age) ago") }
    if let at = row.deleteAfter { parts.append("deleted at \(at.formatted(date: .omitted, time: .shortened)) if left idle") }
    return parts.joined(separator: " · ")
  }
}
#endif
