#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

// Under the launcher (CrewProfile `.cw-sheet`, CrewStates inset 3): SOUL.md, then one settings row built like the
// thread's call group that opens in place into the profile's rows (GET /v1/profiles/{name}), each written as it changes
// (PUT, no Save). Then Recent work and the foot.

struct TeamSheet: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let slice: TeamProfileSlice
  var body: some View {
    DeskProbe.body("TeamSheet", id: slice.key)
    let t = Theme.Desk.Team.self
    let shape = UnevenRoundedRectangle(bottomLeadingRadius: t.sheetRadius, bottomTrailingRadius: t.sheetRadius, style: .continuous)
    return VStack(alignment: .leading, spacing: 0) {
      if let p = slice.persona, p.text != nil { TeamSoul(slice: slice, persona: p) }
      TeamSettingsRow(slice: slice)
      if slice.settingsOpen, let d = slice.detail {
        TeamFieldRows(slice: slice, detail: d)
          .padding(.top, t.rowsTop).padding(.bottom, t.rowsBottom)
          .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4)))
      }
      if let why = slice.refusal {
        Text(verbatim: why).font(Theme.Setup.noteFont).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true).padding(.bottom, 8)
      }
    }
    .padding(t.sheetPadding)
    .background(shape.fill(t.sheetFill))
    .overlay(shape.stroke(t.sheetRing, lineWidth: 0.5))
    .padding(.horizontal, t.sheetInset)
    .padding(.top, -t.sheetTuck)
  }
}

// MARK: SOUL.md

/// The persona (capability profiles.persona): its file's name, two lines that fade out, and the expand button, which
/// opens it in place for editing (written as typing pauses, and when it closes).
struct TeamSoul: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let slice: TeamProfileSlice
  let persona: ProfilePersona
  @State private var draft = ""
  var body: some View {
    let t = Theme.Desk.Team.self
    let open = slice.soulOpen
    let editable = (persona.editable ?? false) && model.store.team.has(Capability.profilesPersona)
    let text = persona.text ?? ""
    return VStack(alignment: .leading, spacing: 2) {
      HStack(spacing: 0) {
        Text(verbatim: persona.fileName).font(t.soulFont).foregroundStyle(Theme.Affect.t3)
        Spacer(minLength: 0)
        Button {
          if open, editable { model.savePersona(slice.key, text: draft) }
          withAnimation(reduceMotion ? Theme.Motion.reduced : t.open) { slice.soulOpen.toggle() }
        } label: {
          Image(systemName: open ? "arrow.down.right.and.arrow.up.left" : "arrow.up.left.and.arrow.down.right")
            .font(t.smallIcon).foregroundStyle(Theme.Affect.t3)
            .frame(width: t.smallButton, height: t.smallButton).contentShape(Rectangle())
        }
        .buttonStyle(SideButtonStyle(radius: t.smallButtonRadius))
        .help(open ? "Close \(persona.fileName)" : editable ? "Expand \(persona.fileName) to edit" : "Expand \(persona.fileName)")
        .accessibilityLabel(open ? "Close \(persona.fileName)" : "Expand \(persona.fileName)")
      }
      .frame(height: t.soulHeader)
      if open && editable {
        TextEditor(text: $draft)
          .font(t.soulText).foregroundStyle(Theme.Affect.t1).lineSpacing(t.soulSpacing)
          .scrollContentBackground(.hidden)
          .frame(minHeight: t.soulEditorMin, maxHeight: t.soulEditorMax)
          .task(id: draft) {
            // Written as typing pauses: no Save button.
            try? await Task.sleep(for: .milliseconds(800))
            if !Task.isCancelled, draft != text { model.savePersona(slice.key, text: draft) }
          }
          .accessibilityLabel(persona.fileName)
          .transition(.opacity)
      } else {
        Text(verbatim: text).font(t.soulText).foregroundStyle(Theme.Affect.t2).lineSpacing(t.soulSpacing)
          .frame(maxWidth: .infinity, maxHeight: open ? nil : t.soulLines, alignment: .topLeading)
          .fixedSize(horizontal: false, vertical: open)
          .clipped()
          .mask {
            if open { Color.black } else {
              LinearGradient(stops: [.init(color: .black, location: 0), .init(color: .black, location: t.soulFadeFrom), .init(color: .clear, location: 1)],
                             startPoint: .top, endPoint: .bottom)
            }
          }
          .textSelection(.enabled)
      }
    }
    .padding(.bottom, t.soulBottom)
    .onAppear { draft = text }
    .onChange(of: persona.text) { _, v in if !slice.soulOpen { draft = v ?? "" } }
  }
}

// MARK: the settings row

/// The thread's call group, for the profile's settings: stacked tiles (its harness, where it runs, read-only, its limits,
/// its skills), the summary ("Opus 5.5 · high · Cloud · read-only · alone · 40 turns · 30 min · 2 skills") and the
/// chevron. A click opens its rows in place.
struct TeamSettingsRow: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let slice: TeamProfileSlice
  @State private var hover = false
  var body: some View {
    let t = Theme.Desk.Team.self
    let s = model.store
    let names = Dictionary(s.runOptions.drivers.flatMap { $0.models ?? [] }.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    let row = slice.row ?? ProfileRow(name: TeamKey.split(slice.key).name)
    let summary = TeamSummary.line(row, detail: slice.detail, models: names)
    let tiles = Self.tiles(row, detail: slice.detail)
    let open = slice.settingsOpen
    let canOpen = slice.detail != nil
    return Button {
      withAnimation(reduceMotion ? Theme.Motion.reduced : t.open) { slice.settingsOpen.toggle() }
    } label: {
      HStack(spacing: t.settingsGap) {
        GroupTileStack(count: tiles.count) { i in
          GroupTile(ground: t.sheetFill) {
            switch tiles[i] {
            case .provider(let p): ProviderMark(provider: p, size: t.tileMark).foregroundStyle(ProviderMarks.badgeTint(p))
            case .symbol(let name): Image(systemName: name).font(t.tileIcon).foregroundStyle(Theme.Rows.tileText)
            }
          }
        }
        Text(verbatim: summary).font(t.summaryFont).foregroundStyle(hover ? Theme.Affect.t1 : Theme.Affect.t2)
          .lineLimit(1).truncationMode(.tail)
          .frame(maxWidth: .infinity, alignment: .leading)
        if canOpen {
          Image(systemName: "chevron.right").font(t.chevron).foregroundStyle(Theme.Affect.t4)
            .rotationEffect(.degrees(open ? 90 : 0))
        }
      }
      .frame(height: t.settingsRow)
      .overlay(alignment: .top) { t.line.frame(height: 0.5) }
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!canOpen)
    .onHover { hover = $0 && canOpen }
    .accessibilityLabel("Settings: \(summary)")
    .accessibilityValue(open ? "open" : "closed")
  }

  enum Tile: Hashable { case provider(Provider), symbol(String) }
  static func tiles(_ r: ProfileRow, detail: ProfileDetail?) -> [Tile] {
    var out: [Tile] = []
    if let p = Provider(wire: r.provider) { out.append(.provider(p)) }
    if let place = detail?.field("sandbox.provider")?.value { out.append(.symbol(ComposerPlaceSwitch.symbol(place))) }
    if r.orchestrates || r.readOnly { out.append(.symbol("eye")) }
    if detail?.field("limits.maxTurns")?.value != nil || detail?.field("limits.timeoutMs")?.value != nil { out.append(.symbol("gauge.with.needle")) }
    if !(r.skills ?? []).isEmpty { out.append(.symbol("doc.text")) }
    return out
  }
}

// MARK: the rows, opened

/// Every row the daemon serves for the profile (but those the page shows elsewhere), in its order, in one card: its
/// label, where its value comes from (with Reset where its own file overrides one), its control.
struct TeamFieldRows: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  let detail: ProfileDetail
  var body: some View {
    DeskProbe.body("TeamFieldRows", id: slice.key)
    let rows = TeamFields.rows(detail)
    let applied = detail.profile.applied ?? []
    let editable = model.store.team.editable
    let r = RoundedRectangle(cornerRadius: Theme.Affect.cardRadius, style: .continuous)
    return VStack(spacing: 0) {
      ForEach(Array(rows.enumerated()), id: \.element.id) { i, f in
        TeamFieldRow(key: slice.key, field: f, value: slice.value(f), pending: slice.pending[f.id] != nil,
                     caption: TeamFields.caption(f, applied: applied), resettable: editable && TeamFields.resettable(f, applied: applied),
                     editable: editable && (f.editable ?? false))
          .equatable()
          .overlay(alignment: .top) { if i > 0 { Theme.Desk.Team.line.frame(height: 0.5) } }
      }
    }
    .background(r.fill(Theme.Affect.card).shadow(color: Theme.Affect.cardShadow, radius: 1, y: 1))
    .overlay(r.strokeBorder(Theme.Affect.cardStroke, lineWidth: 0.5))
  }
}

/// One row: label (and its caption), then the control its type takes. Equatable on what it draws.
struct TeamFieldRow: View, Equatable {
  @Environment(DeskModel.self) private var model
  let key: String
  let field: ProfileField
  let value: String?
  let pending: Bool
  let caption: String?
  let resettable: Bool
  let editable: Bool
  static func == (a: Self, b: Self) -> Bool {
    a.key == b.key && a.field == b.field && a.value == b.value && a.pending == b.pending && a.caption == b.caption && a.resettable == b.resettable && a.editable == b.editable
  }
  var body: some View {
    let t = Theme.Desk.Team.self
    return HStack(spacing: t.fieldGap) {
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: field.label).font(t.label).foregroundStyle(Theme.Affect.t1).lineLimit(1)
        if caption != nil || resettable {
          HStack(spacing: 4) {
            if let caption { Text(verbatim: caption).foregroundStyle(Theme.Affect.t3) }
            if caption != nil && resettable { Text(verbatim: "·").foregroundStyle(Theme.Affect.t3) }
            if resettable {
              Button("Reset") { set(nil) }.buttonStyle(.plain).foregroundStyle(Theme.Affect.info)
                .help("Back to the value it would have without this profile's own")
            }
          }
          .font(t.caption).lineLimit(1)
        }
      }
      .frame(maxWidth: .infinity, alignment: .leading)
      control
    }
    .padding(t.fieldPadding)
    .frame(minHeight: t.fieldRow)
    .opacity(pending ? 0.8 : 1)
    .help(field.help ?? "")
    .accessibilityElement(children: .contain)
    .accessibilityLabel(field.label)
  }

  private func set(_ v: String?) { model.setProfile(key, [field.id: v]) }

  /// What the row shows for its value now (a change on its way shows before the answer).
  private var shown: String {
    guard pending else { return field.display }
    switch field.type {
    case "number": return TeamFields.display(field, value: value)
    case "choice": return field.choices?.first { $0.value == value }?.label ?? value ?? field.display
    case "toggle": return value == "true" ? "Yes" : "No"
    default: return value ?? field.display
    }
  }

  @ViewBuilder private var control: some View {
    let t = Theme.Desk.Team.self
    if !editable {
      Text(verbatim: field.display).font(t.controlFont).foregroundStyle(Theme.Affect.t2).lineLimit(1).truncationMode(.tail)
    } else {
      switch field.type {
      case "choice":
        Menu {
          ForEach(field.choices ?? [], id: \.value) { c in
            Toggle(isOn: Binding(get: { c.value == value }, set: { _ in set(c.value) })) { Text(verbatim: c.label) }
          }
        } label: { TeamPop(text: shown) }
          .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
      case "toggle":
        Toggle("", isOn: Binding(get: { value == "true" }, set: { set($0 ? "true" : "false") }))
          .toggleStyle(.switch).controlSize(.mini).labelsHidden()
      case "number":
        TeamStepper(text: shown, less: { TeamFields.stepped(field, by: -1).map { set($0) } }, more: { TeamFields.stepped(field, by: 1).map { set($0) } })
      case "text":
        TeamTextField(value: value ?? "", placeholder: field.display) { set($0.isEmpty ? nil : $0) }
      case "list":
        TeamList(values: pending ? ProfileField(id: field.id, type: "list", label: "", value: value, display: "").listValues : field.listValues) {
          set($0.isEmpty ? nil : ProfileField.encodeList($0))
        }
      default:
        Text(verbatim: field.display).font(t.controlFont).foregroundStyle(Theme.Affect.t2).lineLimit(1)
      }
    }
  }
}

/// A pop-up's face (`.cs-pop`): 24 pt, 5 pt corners, the segment fill, the value and a small chevron.
struct TeamPop: View {
  let text: String
  var body: some View {
    let t = Theme.Desk.Team.self
    HStack(spacing: 6) {
      Text(verbatim: text).font(t.controlFont).foregroundStyle(Theme.Affect.t1).lineLimit(1)
      Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Affect.t3)
    }
    .padding(t.controlPadding)
    .frame(height: t.control)
    .background(RoundedRectangle(cornerRadius: t.controlRadius, style: .continuous).fill(t.seg))
    .contentShape(Rectangle())
  }
}

/// A number's value with − and + (`.cs-num`).
struct TeamStepper: View {
  let text: String
  let less: () -> Void
  let more: () -> Void
  var body: some View {
    let t = Theme.Desk.Team.self
    HStack(spacing: 0) {
      Text(verbatim: text).font(t.controlFont).monospacedDigit().foregroundStyle(Theme.Affect.t1).padding(.horizontal, 10)
      ForEach([("−", "Less", less), ("+", "More", more)], id: \.0) { glyph, label, act in
        Button(action: act) {
          Text(verbatim: glyph).font(t.controlFont).foregroundStyle(Theme.Affect.t3)
            .frame(width: t.stepWidth, height: t.control).contentShape(Rectangle())
            .overlay(alignment: .leading) { t.stepRule.frame(width: 0.5) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
      }
    }
    .frame(height: t.control)
    .background(RoundedRectangle(cornerRadius: t.controlRadius, style: .continuous).fill(t.seg))
    .clipShape(RoundedRectangle(cornerRadius: t.controlRadius, style: .continuous))
    .fixedSize()
  }
}

/// A text value edited in place: written on Return and when the field lets the keyboard go.
struct TeamTextField: View {
  let value: String
  let placeholder: String
  let commit: (String) -> Void
  @State private var text = ""
  @FocusState private var editing: Bool
  @State private var hover = false
  var body: some View {
    let t = Theme.Desk.Team.self
    TextField("", text: $text, prompt: Text(verbatim: placeholder).foregroundStyle(Theme.Affect.t3))
      .textFieldStyle(.plain).font(t.controlFont).foregroundStyle(Theme.Affect.t1)
      .multilineTextAlignment(.trailing)
      .padding(.horizontal, 8).frame(width: t.fieldWidth, height: t.control)
      .background(RoundedRectangle(cornerRadius: t.controlRadius, style: .continuous).strokeBorder(hover || editing ? t.titleRing : .clear, lineWidth: 0.5))
      .focused($editing)
      .onHover { hover = $0 }
      .onSubmit { send() }
      .onChange(of: editing) { _, on in if !on { send() } }
      .onAppear { text = value }
      .onChange(of: value) { _, v in if !editing { text = v } }
  }
  private func send() {
    let v = text.trimmingCharacters(in: .whitespacesAndNewlines)
    if v != value { commit(v) }
  }
}

/// A list's values as tags (`.cw-tag`; × on hover takes one out) and Add, which turns into a field.
struct TeamList: View {
  let values: [String]
  let commit: ([String]) -> Void
  @State private var adding = false
  @State private var draft = ""
  @FocusState private var focused: Bool
  var body: some View {
    let t = Theme.Desk.Team.self
    HStack(spacing: 6) {
      ForEach(values, id: \.self) { v in TeamTag(text: v) { commit(values.filter { $0 != v }) } }
      if adding {
        TextField("", text: $draft).textFieldStyle(.plain).font(t.controlFont).frame(width: 120, height: t.tagHeight)
          .focused($focused)
          .onSubmit { add() }
          .onChange(of: focused) { _, on in if !on { add() } }
          .onAppear { focused = true }
      } else {
        Button("Add") { adding = true }.buttonStyle(.plain).font(t.controlFont).foregroundStyle(Theme.Affect.t3)
      }
    }
    .fixedSize()
  }
  private func add() {
    let v = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    adding = false; draft = ""
    if !v.isEmpty, !values.contains(v) { commit(values + [v]) }
  }
}

struct TeamTag: View {
  let text: String
  let remove: () -> Void
  @State private var hover = false
  var body: some View {
    let t = Theme.Desk.Team.self
    HStack(spacing: 4) {
      Text(verbatim: text).font(.system(size: 12, design: .monospaced)).foregroundStyle(Theme.Affect.t1).lineLimit(1)
      if hover {
        Button(action: remove) { Image(systemName: "xmark").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Affect.t3) }
          .buttonStyle(.plain).accessibilityLabel("Remove \(text)")
      }
    }
    .padding(.horizontal, 8).frame(height: t.tagHeight)
    .background(RoundedRectangle(cornerRadius: t.controlRadius, style: .continuous).fill(t.tag))
    .onHover { hover = $0 }
  }
}

// MARK: Recent work and the foot

/// The agents it ran lately (capability profiles.work): its bot, what each was, its project, the outcome (only the word
/// is coloured) and how long ago. A row opens that agent.
struct TeamWork: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  let items: [ProfileWorkItem]
  var body: some View {
    DeskProbe.body("TeamWork", id: slice.key)
    let t = Theme.Desk.Team.self
    let name = TeamKey.split(slice.key).name
    let bot = model.team.bot(name: name, role: slice.row.map(TeamRole.of) ?? .builds, seed: slice.avatarSeed)
    let r = RoundedRectangle(cornerRadius: Theme.Affect.cardRadius, style: .continuous)
    let now = Int(Date().timeIntervalSince1970 * 1000)
    return VStack(alignment: .leading, spacing: t.sectionGap) {
      Text("Recent work").textCase(.uppercase).font(t.sectionFont).tracking(t.sectionTracking).foregroundStyle(Theme.Affect.t3)
        .padding(.horizontal, 2).accessibilityAddTraits(.isHeader)
      VStack(spacing: 0) {
        ForEach(Array(items.enumerated()), id: \.element.id) { i, w in
          let (word, tone) = w.outcomeWord
          Button { model.show(run: w.runId, agent: w.agentId) } label: {
            HStack(spacing: t.fieldGap) {
              BotAvatar(traits: bot, size: .xs, cell: 1).frame(width: t.rowBot, height: t.rowBot)
              (Text(verbatim: w.title ?? word).foregroundColor(Theme.Affect.t1)
               + Text(verbatim: w.project.map { " · " + $0 } ?? "").foregroundColor(Theme.Affect.t3))
                .font(t.workFont).lineLimit(1).truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
              HStack(spacing: 6) {
                Text(verbatim: word).foregroundStyle(tone == .ok ? Theme.Affect.ok : tone == .bad ? Theme.Affect.bad : Theme.Affect.t3)
                if let at = w.endedAtMs ?? w.updatedAtMs { Text(verbatim: "· " + teamAge(ms: at, now: now)).monospacedDigit().foregroundStyle(Theme.Affect.t3) }
              }
              .font(t.workMeta).fixedSize()
            }
            .padding(t.fieldPadding).frame(minHeight: t.fieldRow)
            .contentShape(Rectangle())
          }
          .buttonStyle(.plain)
          .overlay(alignment: .top) { if i > 0 { t.line.frame(height: 0.5) } }
          .accessibilityLabel([w.title, w.project, word].compactMap { $0 }.joined(separator: ", "))
        }
      }
      .background(r.fill(Theme.Affect.card).shadow(color: Theme.Affect.cardShadow, radius: 1, y: 1))
      .overlay(r.strokeBorder(Theme.Affect.cardStroke, lineWidth: 0.5))
    }
    .padding(.top, t.sectionTop)
  }
}

/// Where it came from: "Installed from <source> · version N" with Check for updates (an installed profile), and Show in
/// Finder for any profile with a file.
struct TeamFoot: View {
  @Environment(DeskModel.self) private var model
  let slice: TeamProfileSlice
  var body: some View {
    let t = Theme.Desk.Team.self
    let source = slice.detail?.field("sharing.source")?.value
    let path = slice.row?.path
    return Group {
      if source != nil || path != nil {
        HStack(spacing: 8) {
          if let source {
            (Text(verbatim: "Installed from ") + Text(verbatim: source).font(t.footMono).foregroundColor(Theme.Affect.t2)
             + Text(verbatim: slice.row?.version.map { " · version \($0)" } ?? ""))
              .lineLimit(1).truncationMode(.middle)
          }
          Spacer(minLength: 0)
          if source != nil { TeamGhostButton(title: "Check for updates") { model.checkProfileUpdates(slice.key) } }
          if let path { TeamGhostButton(title: "Show in Finder") { model.showProfileFile(path) } }
        }
        .font(t.footFont).foregroundStyle(Theme.Affect.t3)
        .padding(.leading, 4)
        .padding(.top, t.footTop)
      }
    }
  }
}

/// `.btn.sm.ghost`: 24 pt, no fill until hovered, 12 pt secondary.
struct TeamGhostButton: View {
  let title: String
  let action: () -> Void
  var body: some View {
    let t = Theme.Desk.Team.self
    Button(action: action) {
      Text(verbatim: title).font(t.ghostFont).foregroundStyle(Theme.Affect.t2)
        .padding(.horizontal, t.ghostPadding).frame(height: t.smallButton).contentShape(Rectangle())
    }
    .buttonStyle(SideButtonStyle(radius: t.smallButtonRadius))
  }
}
#endif
