#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// A place's own page, pushed from Runs (SettingsStates.dc.html, "a place opened"; ADR-021 §6: read-only plus Open in
/// Terminal; a setting the daemon marks `editable` can be changed with `sandboxes.settings`; Delete… on a machine whose
/// actions include delete, with `sandboxes.actions`, after the daemon's question). One generic page for every place:
/// the groups and their order are fixed here, as on the board; which rows appear and what they say come from the
/// daemon (`/v1/sandboxes/{name}`, `…/resources`, `/v1/logins`, `/v1/environments`). Back (⌘[) returns to Runs.
struct PlacePage: View {
  @Environment(SettingsModel.self) private var model
  let name: String
  @State private var opening: String?
  @State private var openProblem: String?
  @State private var confirming: MachineRow?

  var body: some View {
    let live = model.connection.live
    let d = model.descriptor(name)
    let place = model.sandboxes.first { $0.name == name }
    let title = model.placeTitle(name)
    let sections = model.sandboxDetail(name).map(SandboxRows.sections) ?? DetailSections()
    let isDefault = model.defaultPlace?.name == name
    let env = model.environmentRows?.first { $0.sandbox == name }
    SPage {
      SGroup(id: "place.status") {
        statusRow(d, place: place, isDefault: isDefault)
        ForEach(sections.status) { f in SSep(); setting(f) }
        if let env { SSep(); PlaceEnvironmentRow(env: env, title: title) }
      } foot: {
        if let w = model.handOffs.waiting(HandOffKey.environment(name)) ?? model.handOffs.waiting(HandOffKey.placeSetup(name)) ?? (d == nil && name == "boxd" ? model.handOffs.waiting(HandOffKey.boxdKey) : nil) {
          OpenedFoot(command: w.command)
        }
        if env?.state == .building { SFoot(verbatim: "Runs on \(title) start once it's built.") }
        if model.environmentsUnsupported { SFoot(verbatim: "Update capcomd to see each place's agent environment here.") }
        if !live { SFoot(verbatim: "Shown when capcomd is running.") }
      }
      machines(d, idle: sections.machines)
      safety(rows: sections.safety)
      if !sections.more.isEmpty {
        SGroup("Options", id: "place.options") {
          ForEach(Array(sections.more.enumerated()), id: \.element.id) { i, f in
            if i > 0 { SSep() }
            setting(f)
          }
        }
      }
    }
    .disabled(!live)
    .confirmationDialog(question.title, isPresented: confirmShown, titleVisibility: .visible, presenting: confirming) { row in
      Button(question.button, role: .destructive) { model.deleteMachine(name, row.id) }
      Button("Cancel", role: .cancel) {}
    } message: { _ in
      if let m = question.message { Text(verbatim: m) }
    }
    // The daemon caches provider calls, so the machines are cheap to read every few seconds while this shows.
    .task(id: name) {
      while !Task.isCancelled {
        await model.refreshSandbox(name)
        try? await Task.sleep(for: .seconds(ST.poll))
      }
    }
  }

  /// The place's provider and whether it can be used now: "boxd · Default … Ready", Set Up… when the daemon names a
  /// command for it, Make Default where it isn't.
  @ViewBuilder private func statusRow(_ d: SandboxDescriptor?, place: SandboxInfo?, isDefault: Bool) -> some View {
    let key = d == nil && name == "boxd" ? HandOffKey.boxdKey : HandOffKey.placeSetup(name)
    let waiting = model.handOffs.waiting(key) != nil
    SRow {
      HStack(spacing: 6) {
        PlaceMark(kind: d?.kind ?? PlaceNames.kind(name)).foregroundStyle(ST.t2)
        Text(verbatim: d?.vendorName ?? PlaceNames.engine(name))
        if isDefault { DefaultBadge().accessibilityLabel("the default") }
      }
    } value: {
      if waiting {
        WaitingValue()
        Button("Show Terminal") { TerminalLauncher.showTerminal() }
      } else if let d {
        let s = SandboxRows.status(d, place: place)
        StatusValue(s.tone.dot, s.text)
        if let command = s.setupCommand {
          Button("Set Up…") { model.handOff(key, command: command, baseline: s.fingerprint) }
            .prominent().accessibilityHint("Opens Terminal to set up \(d.vendorName).")
        }
      } else if let place {
        if place.available {
          StatusValue(.ok, name == "docker" ? "Running" : "Ready")
        } else if name == "boxd" {
          StatusValue(.empty, PlaceNames.reason(place.reason) ?? "No boxd API key")
          Button("Set Up…") { model.handOff(HandOffKey.boxdKey, command: SettingsRows.boxdKeyCommand, baseline: "\(model.boxdKey)") }.prominent()
        } else {
          StatusValue(.bad, PlaceNames.reason(place.reason) ?? "Can't be used now")
        }
      }
      if !isDefault && place != nil {
        Button("Make Default") { model.setDefaultPlace(name) }.accessibilityLabel("Make \(model.placeTitle(name)) the default")
      }
    }
  }

  private func setting(_ field: SandboxField) -> some View {
    let name = name
    return FieldRow(field: field, control: model.fieldControl(name, field)) { model.changeSetting(name, id: field.id, to: $0) }
  }

  /// Machines: what capcomd runs at this place now, owned ones first, then any left behind; then the idle lifetime.
  @ViewBuilder private func machines(_ d: SandboxDescriptor?, idle: [SandboxField]) -> some View {
    if model.resourcesSupported {
      let fetched = model.sandboxResources(name)
      let page = fetched?.value
      SGroup("Machines", id: "place.machines") {
        switch fetched {
        case .loaded:
          let rows = model.machineRows(name)
          if rows.isEmpty { SRow("No machines running") { EmptyView() } }
          ForEach(Array(rows.enumerated()), id: \.element.id) { i, row in
            if i > 0 { SSep() }
            MachineRowView(row: row, opening: opening == row.id, deletion: model.machineDeletion(name, row.id),
                           open: { open(row) }, delete: { confirming = row })
          }
        case .unavailable:
          SRow("Machines") { StatusValue(.empty, "Couldn't list them just now") }
        case .loading, nil:
          SRow { Text("Looking for machines…").foregroundStyle(ST.t3) } value: { ProgressView().controlSize(.small) }
        }
        ForEach(idle) { f in SSep(); setting(f) }
      } foot: {
        if let page, page.stale { SFoot(verbatim: Self.staleNote(d?.vendorName ?? name, asOf: page.asOf)) }
        if let page, page.next != nil { SFoot(verbatim: "Showing the first \(page.resources.count) machines.") }
        if let openProblem { SFoot(verbatim: openProblem) }
      }
    } else if !idle.isEmpty {
      SGroup("Machines", id: "place.machines") {
        ForEach(Array(idle.enumerated()), id: \.element.id) { i, f in
          if i > 0 { SSep() }
          setting(f)
        }
      } foot: {
        SFoot(verbatim: "Update capcomd to see machines here.")
      }
    }
  }

  private var question: DeleteQuestion { DeleteQuestion.from(confirming?.confirm) }
  private var confirmShown: Binding<Bool> { Binding(get: { confirming != nil }, set: { if !$0 { confirming = nil } }) }

  /// "Couldn't reach boxd just now. These are the machines it listed at 10:22."
  static func staleNote(_ provider: String, asOf: String?) -> String {
    let at = asOf.flatMap(SettingsRows.parseISO).map { " These are the machines it listed at \($0.formatted(date: .omitted, time: .shortened))." } ?? ""
    return "Couldn't reach \(provider) just now.\(at)"
  }

  /// Safety: Logins (from `/v1/logins` `hostBound` / `boundTo`), Checkpoints and other info rows from the daemon.
  @ViewBuilder private func safety(rows: [SandboxField]) -> some View {
    let summary = SandboxRows.loginsSummary(model.loginList, sandbox: name)
    let loginField = rows.first { $0.id == SandboxRows.logins }
    let rest = summary == nil ? rows : rows.filter { $0.id != SandboxRows.logins }
    if summary != nil || !rest.isEmpty {
      SGroup("Safety", id: "place.safety") {
        if let summary {
          SRow(loginField?.label ?? "Logins") { StatusValue(summary.tone.dot, summary.text).help(summary.sub) }
        }
        ForEach(Array(rest.enumerated()), id: \.element.id) { i, f in
          if i > 0 || summary != nil { SSep() }
          FieldRow(field: f)
        }
      } foot: {
        if let foot = SandboxRows.bindingFootnote(model.sandboxDescriptors) { SFoot(verbatim: foot) }
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

/// A place's agent environment: ready (its tools' versions under it), not built, building, failed, or waiting on
/// Terminal.
struct PlaceEnvironmentRow: View {
  @Environment(SettingsModel.self) private var model
  let env: EnvironmentRow
  let title: String

  var body: some View {
    let key = HandOffKey.environment(env.sandbox)
    let build = { (command: String) in _ = model.handOff(key, command: command, baseline: env.fingerprint) }
    if model.handOffs.waiting(key) != nil {
      SRow { SLabel(title: "Agent environment", sub: "The build runs in the Terminal window.") } value: {
        WaitingValue()
        Button("Show Terminal") { TerminalLauncher.showTerminal() }
      }
    } else {
      switch env.state {
      case .building:
        SRow { SLabel(title: "Agent environment", sub: "Installing Claude Code, Codex and fx") } value: {
          ProgressView().progressViewStyle(.linear).frame(width: 150).accessibilityLabel("Building the agent environment")
          if TerminalLauncher.terminalRunning { Button("Show Log") { TerminalLauncher.showTerminal() } }
        }
      case .ready:
        SRow { SLabel(title: "Agent environment", sub: Self.summary(env)) } value: {
          StatusValue(.ok, "Ready")
          Button("Rebuild…") { build(env.rebuildCommand) }.accessibilityHint("Opens Terminal to rebuild it.")
        }
      case .missing:
        SRow { SLabel(title: "Agent environment", sub: "Runs on \(title) start once it's built") } value: {
          StatusValue(.warn, "Not built")
          Button("Build…") { build(env.command) }.prominent().accessibilityHint("Opens Terminal to build it.")
        }
      case .failed:
        SRow { SLabel(title: "Agent environment", sub: "The last build didn't finish") } value: {
          StatusValue(.bad, "Failed")
          Button("Try Again…") { build(env.command) }.prominent().accessibilityHint("Opens Terminal to build it again.")
        }
      case .unknown:
        SRow("Agent environment") {
          StatusValue(.empty, "Unknown")
          Button("Build…") { build(env.command) }
        }
      }
    }
  }

  /// "Claude Code 2.1.303 · Codex 0.163.0 · built Nov 24".
  static func summary(_ env: EnvironmentRow) -> String {
    var parts = env.versions.map { "\($0.tool) \($0.version)" }
    if let at = env.builtAt { parts.append("\(parts.isEmpty ? "Built" : "built") \(at.formatted(.dateTime.month(.abbreviated).day()))") }
    return parts.isEmpty ? "Built" : parts.joined(separator: " · ")
  }
}

/// One row the daemon describes, by type: `choice` a popup, `toggle` a switch, `info` / `status` a value; any type this
/// app doesn't know shows its label and the daemon's text, read-only. A choice can be changed only when the store says
/// so (`FieldControl`), and the row shows the choice on its way until the daemon answers.
struct FieldRow: View {
  let field: SandboxField
  var control: FieldControl? = nil
  var pick: ((String) -> Void)? = nil

  var body: some View {
    SRow { label } value: {
      switch field.kind {
      case .choice where !field.fromEnvironment && !field.choices.isEmpty:
        let current = control?.selection ?? field.value.text ?? ""
        let editable = control?.editable == true && pick != nil
        Picker(field.label, selection: Binding(get: { current }, set: { v in if v != current { pick?(v) } })) {
          ForEach(field.choices, id: \.value) { c in Text(verbatim: c.label).tag(c.value) }
          if !field.choices.contains(where: { $0.value == current }) { Text(verbatim: field.shown).tag(current) }
        }
        .labelsHidden().pickerStyle(.menu).fixedSize()
        .disabled(!editable)
        .accessibilityHint(control?.saving == true ? "Saving." : "")
      case .toggle where !field.fromEnvironment:
        SSwitch(title: field.label, isOn: .constant(field.value.bool ?? false)).disabled(true)
      case .status:
        StatusValue(Self.tone(field.state).dot, field.shown)
      default:
        StatusValue(nil, field.shown)
      }
    }
  }

  @ViewBuilder private var label: some View {
    let sub = [field.help, control?.note].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " ")
    SLabel(title: field.label, sub: sub.isEmpty ? nil : sub)
  }

  static func tone(_ state: String?) -> Tone {
    switch state { case "ok": .ok; case "warn": .warn; case "bad", "error": .bad; case "empty", "none": .empty; default: .none }
  }
}

/// A machine: its state's dot, who uses it, its age, Open in Terminal when it can be opened, and Delete… when the
/// daemon offers it. A Delete that didn't go through shows the daemon's sentence under the row.
struct MachineRowView: View {
  let row: MachineRow
  let opening: Bool
  var deletion: MachineDeletion? = nil
  let open: () -> Void
  var delete: () -> Void = {}

  var body: some View {
    VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 10) {
        if let dot = row.tone.dot { StatusDot(kind: dot) }
        Text(verbatim: row.title).font(ST.label).foregroundStyle(ST.t1).lineLimit(1).truncationMode(.tail)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(verbatim: trailing).font(ST.mono).foregroundStyle(ST.t3)
        if row.canOpenTerminal {
          if opening { ProgressView().controlSize(.mini).accessibilityHidden(true) }
          Button("Open in Terminal", action: open).controlSize(.small).disabled(opening)
            .accessibilityHint("Opens a shell in this machine in Terminal.")
        }
        if row.canDelete {
          let busy = deletion?.deleting == true
          if busy { ProgressView().controlSize(.mini).accessibilityHidden(true) }
          Button("Delete…", action: delete).controlSize(.small).disabled(busy)
            .accessibilityHint("Asks first, then deletes this machine.")
        }
      }
      if let why = deletion?.error {
        Text(verbatim: why).font(ST.foot).foregroundStyle(ST.t3).fixedSize(horizontal: false, vertical: true)
      }
    }
    .padding(.vertical, ST.rowPadV).padding(.horizontal, ST.rowPadH)
    .frame(minHeight: ST.rowMin)
    .help(help)
    .accessibilityElement(children: .contain)
    .accessibilityLabel(help)
  }

  /// Its age, or for a parked machine "parked · deletes at 10:22".
  private var trailing: String {
    guard row.parked else { return row.age }
    return row.deleteAfter.map { "parked · deletes at \(Self.when($0))" } ?? "parked"
  }

  /// "10:22", or "Thu 10:22" when it isn't today (a parked machine is kept up to 7 days).
  static func when(_ at: Date) -> String {
    Calendar.current.isDateInToday(at) ? at.formatted(date: .omitted, time: .shortened)
      : at.formatted(.dateTime.weekday(.abbreviated).hour().minute())
  }

  private var help: String {
    var parts = [row.title, row.id]
    if !row.age.isEmpty { parts.append(row.age == "now" ? "started just now" : "started \(row.age) ago") }
    if let at = row.deleteAfter { parts.append(row.parked ? "parked, deleted at \(Self.when(at))" : "deleted at \(at.formatted(date: .omitted, time: .shortened)) if left idle") }
    return parts.joined(separator: " · ")
  }
}
#endif
