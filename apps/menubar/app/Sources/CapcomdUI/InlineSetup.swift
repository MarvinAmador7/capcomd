#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

// The composer's inline project setup (design/setup/InlineSetup, InlineAttention, InlinePublish; setup-spec.md): a
// picked folder that isn't a set-up capcomd project swaps the composer's tool row for its next steps, inside the composer
// card. ProjectSetupFlow (CapcomdStore) decides what shows; these views draw its SetupScreen. Shared by the menu bar's
// composer and the desktop's new project column, which say what Choose Another Folder…, Cancel and Log In… do.

/// The next steps under the goal (`.next`): a hairline across the card, the orange dot and what's needed, the rows or a
/// callout, then the buttons.
package struct InlineSetupSection: View {
  let screen: SetupScreen
  /// The setup the rows edit.
  let flow: ProjectSetupFlow
  /// Return presses the primary (off while the goal field has focus: it sends Return through its own submit).
  var defaultKey = true
  /// The card's side padding: the hairline runs its whole width.
  var cardInset = Theme.Composer2.padding.leading
  /// The primary was pressed (the composer runs it: Set Up and Start needs its goal).
  let onPrimary: (SetupAction) -> Void
  /// Choose Another Folder…, Cancel, and Log In… (the GitHub CLI's login, in Terminal).
  let onChooseAnother: () -> Void
  let onCancel: () -> Void
  let onLogIn: () -> Void
  package init(screen: SetupScreen, flow: ProjectSetupFlow, defaultKey: Bool = true, cardInset: CGFloat = Theme.Composer2.padding.leading,
               onPrimary: @escaping (SetupAction) -> Void, onChooseAnother: @escaping () -> Void, onCancel: @escaping () -> Void, onLogIn: @escaping () -> Void) {
    self.screen = screen; self.flow = flow; self.defaultKey = defaultKey; self.cardInset = cardInset; self.onPrimary = onPrimary
    self.onChooseAnother = onChooseAnother; self.onCancel = onCancel; self.onLogIn = onLogIn
  }

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: Theme.Setup.headerGap) {
        SetupDot()
        Text(verbatim: screen.header).font(Theme.Setup.headerFont).foregroundStyle(Theme.Setup.headerText).lineLimit(2)
      }
      .padding(.horizontal, Theme.Setup.inset)
      .accessibilityElement(children: .combine)
      if !screen.rows.isEmpty {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(Array(screen.rows.enumerated()), id: \.element.id) { n, item in
            SetupRowView(item: item, flow: flow, onLogIn: onLogIn)
              .overlay(alignment: .top) { if n > 0 { Rectangle().fill(Theme.Setup.rowDivider).frame(height: 0.5) } }
          }
        }
        .padding(.top, Theme.Setup.rowsTop)
        .opacity(screen.locked ? Theme.Setup.lockedOpacity : 1).disabled(screen.locked)
      }
      if let callout = screen.callout {
        SetupCallout(spans: callout).padding(.top, Theme.Setup.calloutTop).padding(.horizontal, Theme.Setup.inset)
      }
      if let notice = screen.notice {
        SetupNoteView(note: notice, onLogIn: onLogIn).padding(.top, Theme.Setup.calloutTop).padding(.bottom, -Theme.Setup.noteBottom)
      }
      HStack(spacing: Theme.Setup.actionGap) {
        if screen.chooseAnother { Button("Choose Another Folder…") { onChooseAnother() }.buttonStyle(SetupButtonStyle(kind: .secondary)) }
        Spacer(minLength: 0)
        if screen.cancel {
          Button("Cancel") { onCancel() }.buttonStyle(SetupButtonStyle(kind: .quiet))
        }
        if let p = screen.primary {
          Button { onPrimary(p.action) } label: {
            HStack(spacing: Theme.Setup.spinnerGap) {
              if p.busy { ProgressView().controlSize(.mini).frame(width: Theme.Setup.spinner, height: Theme.Setup.spinner).accessibilityHidden(true) }
              Text(verbatim: p.title)
            }
          }
          .buttonStyle(SetupButtonStyle(kind: .primary, dim: !p.enabled || p.busy))
          .disabled(!p.enabled || p.busy)
          .keyboardShortcut(defaultKey ? .defaultAction : nil)
        }
      }
      .padding(.top, Theme.Setup.actionsTop)
    }
    .padding(.top, Theme.Setup.top)
    .frame(maxWidth: .infinity, alignment: .leading)
    // The hairline runs the card's whole width (`.next` margin 0 -12px).
    .overlay(alignment: .top) {
      Rectangle().fill(Theme.Setup.divider).frame(height: 0.5).padding(.horizontal, -cardInset)
    }
  }
}

/// The 7 pt orange dot: on the chip and before the header, "not set up".
package struct SetupDot: View {
  package init() {}
  package var body: some View {
    Circle().fill(Theme.Setup.orange).frame(width: Theme.Setup.dot, height: Theme.Setup.dot).accessibilityLabel("Not set up")
  }
}

/// A row (`.r`): its label in an 84 pt column, the value on the right; a note under it (`.rn`) when there is one.
package struct SetupRowView: View {
  let item: SetupRowItem
  let flow: ProjectSetupFlow
  let onLogIn: () -> Void
  package init(item: SetupRowItem, flow: ProjectSetupFlow, onLogIn: @escaping () -> Void) { self.item = item; self.flow = flow; self.onLogIn = onLogIn }
  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: Theme.Setup.rowGap) {
        Text(verbatim: label).font(Theme.Setup.labelFont).foregroundStyle(Theme.Setup.labelText)
          .frame(width: Theme.Setup.labelWidth, alignment: .leading)
        Spacer(minLength: 0)
        value
      }
      .padding(.vertical, Theme.Setup.rowPaddingV).padding(.horizontal, Theme.Setup.inset)
      .frame(minHeight: Theme.Setup.rowHeight)   // border-box: the 32 pt include the padding
      if let note = item.note { SetupNoteView(note: note, onLogIn: onLogIn) }
    }
  }

  private var label: String {
    switch item.row {
    case .repository: "Repository"; case .target: "Target branch"; case .mode: "Changes land as"; case .agents: "Agents"
    case .spendCap: "Spend cap"; case .account: "Account"; case .name: "Name"; case .visibility: "Visibility"
    }
  }

  @ViewBuilder private var value: some View {
    switch item.row {
    case .repository(let repo):
      HStack(spacing: Theme.Setup.valueGap) {
        SVGShape(path: ProviderMarks.github, viewBox: 24).frame(width: Theme.Setup.githubMark, height: Theme.Setup.githubMark).accessibilityHidden(true)
        Text(verbatim: repo).font(Theme.Setup.valueFont).lineLimit(1).truncationMode(.middle)
      }
      .foregroundStyle(Theme.Setup.valueText)
      .accessibilityElement(children: .combine).accessibilityLabel("Repository: \(repo)")
    case .target(let target, let choices):
      SetupPopup(text: target, accessibility: "Target branch: \(target)") {
        Section("Branches") {
          ForEach(choices, id: \.self) { b in
            Toggle(isOn: Binding(get: { b == target }, set: { _ in flow.setTarget(b) })) { Text(verbatim: b) }
          }
        }
      }
    case .mode(let mode, let target, let pullRequests):
      let title = mode == "pr" ? "Pull requests" : "Pushes to \(target)"
      SetupPopup(text: title, accessibility: "Changes land as: \(title)") {
        Toggle(isOn: Binding(get: { mode == "pr" }, set: { _ in flow.setMode("pr") })) { Text("Pull requests") }.disabled(!pullRequests)
        Toggle(isOn: Binding(get: { mode == "direct" }, set: { _ in flow.setMode("direct") })) { Text(verbatim: "Pushes to \(target)") }
      }
    case .agents(let chips):
      HStack(spacing: Theme.Setup.valueGap) {
        ForEach(chips) { c in SetupAgentChipView(chip: c) { flow.toggleAgent(c.provider) } }
      }
    case .spendCap(let text, let valid):
      SetupField(prefix: "$", text: Binding(get: { text }, set: { flow.setBudget($0) }), width: Theme.Setup.capWidth,
                 error: !valid || item.note?.warn == true, accessibility: "Spend cap in US dollars")
    case .account(let owner, let accounts):
      let you = accounts.filter { !$0.isOrganization }, orgs = accounts.filter(\.isOrganization)
      SetupPopup(text: owner, github: true, accessibility: "Account: \(owner)") {
        ForEach(you) { a in Toggle(isOn: Binding(get: { a.login == owner }, set: { _ in flow.setOwner(a.login) })) { Text(verbatim: a.login) } }
        if !orgs.isEmpty {
          Divider()
          Section("Organizations") {
            ForEach(orgs) { a in Toggle(isOn: Binding(get: { a.login == owner }, set: { _ in flow.setOwner(a.login) })) { Text(verbatim: a.login) } }
          }
        }
      }
    case .name(let name, let valid):
      SetupField(text: Binding(get: { name }, set: { flow.setName($0) }), width: Theme.Setup.nameWidth,
                 error: !valid || item.note?.warn == true, accessibility: "Repository name")
    case .visibility(let v):
      let title = v == "public" ? "Public" : "Private"
      SetupPopup(text: title, accessibility: "Visibility: \(title)") {
        Toggle(isOn: Binding(get: { v != "public" }, set: { _ in flow.setVisibility("private") })) { Text("Private") }
        Toggle(isOn: Binding(get: { v == "public" }, set: { _ in flow.setVisibility("public") })) { Text("Public") }
      }
    }
  }
}

/// A line under a row (`.rn`), grey or orange, with Log In… for the GitHub CLI.
package struct SetupNoteView: View {
  let note: SetupNote
  let onLogIn: () -> Void
  package init(note: SetupNote, onLogIn: @escaping () -> Void) { self.note = note; self.onLogIn = onLogIn }
  package var body: some View {
    HStack(alignment: .center, spacing: Theme.Setup.noteGap) {
      Text(verbatim: note.text).font(Theme.Setup.noteFont).lineSpacing(Theme.Setup.noteLineSpacing)
        .foregroundStyle(note.warn ? Theme.Setup.orange : Theme.Setup.noteText)
        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
      if note.logIn {
        Button("Log In…") { onLogIn() }.buttonStyle(SetupButtonStyle(kind: .mini))
          .help("Opens Terminal to log the GitHub CLI in (gh auth login)")
      }
    }
    .padding(.horizontal, Theme.Setup.inset).padding(.bottom, Theme.Setup.noteBottom)
  }
}

/// The callout (`.callout`): what's needed, in a sentence, with paths and commands in mono.
package struct SetupCallout: View {
  let spans: [SetupSpan]
  package init(spans: [SetupSpan]) { self.spans = spans }
  package var body: some View {
    spans.reduce(Text(verbatim: "")) { t, s in t + Text(verbatim: s.text).font(s.mono ? Theme.Setup.monoFont : Theme.Setup.calloutFont) }
      .foregroundStyle(Theme.Setup.calloutText).lineSpacing(Theme.Setup.calloutLineSpacing)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }
}

/// A value that edits in place (`.pop`): the value and the up/down chevrons on a 22 pt pill; a menu.
package struct SetupPopup<Content: View>: View {
  let text: String
  var github = false
  let accessibility: String
  @ViewBuilder let content: () -> Content
  package init(text: String, github: Bool = false, accessibility: String, @ViewBuilder content: @escaping () -> Content) {
    self.text = text; self.github = github; self.accessibility = accessibility; self.content = content
  }
  package var body: some View {
    Menu(content: content) {
      HStack(spacing: Theme.Setup.popGap) {
        if github { SVGShape(path: ProviderMarks.github, viewBox: 24).frame(width: Theme.Setup.githubMark, height: Theme.Setup.githubMark) }
        Text(verbatim: text).font(Theme.Setup.valueFont).lineLimit(1)
        Image(systemName: "chevron.up.chevron.down").font(Theme.Setup.popChevron)
      }
      .foregroundStyle(Theme.Setup.valueText)
      .padding(.leading, Theme.Setup.popLeading).padding(.trailing, Theme.Setup.popTrailing).frame(height: Theme.Setup.controlHeight)
      .background(RoundedRectangle(cornerRadius: Theme.Setup.controlRadius, style: .continuous).fill(Theme.Setup.popFill))
      .contentShape(RoundedRectangle(cornerRadius: Theme.Setup.controlRadius, style: .continuous))
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .accessibilityLabel(accessibility)
  }
}

/// A text value (`.fld`): mono on a dark well; orange edge and ring when it's refused or not a value.
package struct SetupField: View {
  var prefix: String? = nil
  @Binding var text: String
  let width: CGFloat
  var error = false
  let accessibility: String
  package init(prefix: String? = nil, text: Binding<String>, width: CGFloat, error: Bool = false, accessibility: String) {
    self.prefix = prefix; self._text = text; self.width = width; self.error = error; self.accessibility = accessibility
  }
  package var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Setup.controlRadius, style: .continuous)
    HStack(spacing: Theme.Setup.prefixGap) {
      if let prefix { Text(verbatim: prefix).accessibilityHidden(true) }
      TextField("", text: $text).textFieldStyle(.plain).accessibilityLabel(accessibility)
    }
    .font(Theme.Setup.fieldFont).foregroundStyle(Theme.Setup.valueText)
    .padding(.horizontal, Theme.Setup.fieldPadding).frame(width: width, height: Theme.Setup.controlHeight)
    .background(shape.fill(Theme.Setup.fieldFill))
    .overlay(shape.strokeBorder(error ? Theme.Setup.orange : Theme.Setup.fieldStroke, lineWidth: 0.5))
    .background(shape.stroke(Theme.Setup.orange.opacity(Theme.Setup.errorRingOpacity), lineWidth: Theme.Setup.errorRing)
      .padding(-Theme.Setup.errorRing / 2).opacity(error ? 1 : 0))
  }
}

/// An agent (`.ag`): on is an accent capsule; one that isn't logged in anywhere is dimmed and can't be chosen.
package struct SetupAgentChipView: View {
  let chip: SetupAgentChip
  let toggle: () -> Void
  package init(chip: SetupAgentChip, toggle: @escaping () -> Void) { self.chip = chip; self.toggle = toggle }
  package var body: some View {
    Button(action: toggle) {
      HStack(spacing: Theme.Setup.agentGap) {
        if let p = Provider(wire: chip.provider) {
          // Claude's spark keeps its coral (the board's `.ag svg`); Codex's glyph takes the chip's text colour.
          ProviderMark(provider: p, size: Theme.Setup.agentMark).foregroundStyle(p == .claude ? ProviderMarks.badgeTint(p) : (chip.on ? .white : Theme.Setup.agentText))
        }
        Text(verbatim: chip.label).font(Theme.Setup.agentFont)
      }
      .foregroundStyle(chip.on ? Color.white : Theme.Setup.agentText)
      .padding(.leading, Theme.Setup.agentLeading).padding(.trailing, Theme.Setup.agentTrailing).frame(height: Theme.Setup.agentHeight)
      .background(Capsule().fill(chip.on ? Theme.Setup.agentOnFill : Theme.Setup.agentFill))
      .overlay(Capsule().strokeBorder(chip.on ? Theme.Setup.agentOnStroke : Theme.Setup.agentStroke, lineWidth: 0.5))
      .opacity(chip.enabled ? 1 : Theme.Setup.agentDisabledOpacity)
    }
    .buttonStyle(PressableStyle()).disabled(!chip.enabled)
    .help(chip.enabled ? "" : "\(chip.label) isn't logged in. Log in from Settings › Accounts.")
    .accessibilityLabel(chip.label).accessibilityAddTraits(.isToggle).accessibilityValue(chip.on ? "On" : "Off")
  }
}

/// The card's buttons (`.b`): primary blue, secondary grey, quiet text (Cancel), and the small Log In… (`.mini`).
package struct SetupButtonStyle: ButtonStyle {
  package enum Kind { case primary, secondary, quiet, mini }
  let kind: Kind
  var dim = false
  package init(kind: Kind, dim: Bool = false) { self.kind = kind; self.dim = dim }
  package func makeBody(configuration: Configuration) -> some View {
    let mini = kind == .mini
    let shape = RoundedRectangle(cornerRadius: mini ? Theme.Setup.miniRadius : Theme.Setup.buttonRadius, style: .continuous)
    configuration.label
      .font(mini ? Theme.Setup.miniFont : Theme.Setup.buttonFont)
      .foregroundStyle(kind == .primary ? Color.white : kind == .quiet ? Theme.Setup.quietText : Theme.Setup.valueText)
      .padding(.horizontal, mini ? Theme.Setup.miniPadding : kind == .quiet ? Theme.Setup.quietPadding : Theme.Setup.buttonPadding)
      .frame(height: mini ? Theme.Setup.miniHeight : Theme.Setup.buttonHeight)
      .background(shape.fill(kind == .primary ? Theme.accent : kind == .quiet ? Color.clear : Theme.Setup.buttonFill))
      .contentShape(shape)
      .opacity(dim ? Theme.Setup.offOpacity : 1)
      .fixedSize()
      .modifier(PressFeedback(isPressed: configuration.isPressed))
  }
}

/// The goal branch's name: mono on the setup's dark well, the daemon's suggestion as its placeholder, orange when the
/// daemon said it can't be used.
package struct GoalBranchField: View {
  @Binding var text: String
  let placeholder: String
  var error = false
  package init(text: Binding<String>, placeholder: String, error: Bool = false) { self._text = text; self.placeholder = placeholder; self.error = error }
  package var body: some View {
    let shape = RoundedRectangle(cornerRadius: Theme.Setup.controlRadius, style: .continuous)
    TextField("", text: $text).textFieldStyle(.plain)
      .font(Theme.Setup.fieldFont).foregroundStyle(Theme.Setup.valueText)
      .background(alignment: .leading) {
        if text.isEmpty { Text(verbatim: placeholder).font(Theme.Setup.fieldFont).foregroundStyle(Theme.Setup.noteText).lineLimit(1).allowsHitTesting(false) }
      }
      .padding(.horizontal, Theme.Setup.fieldPadding).frame(maxWidth: .infinity).frame(height: Theme.Setup.controlHeight)
      .background(shape.fill(Theme.Setup.fieldFill))
      .overlay(shape.strokeBorder(error ? Theme.Setup.orange : Theme.Setup.fieldStroke, lineWidth: 0.5))
      .background(shape.stroke(Theme.Setup.orange.opacity(Theme.Setup.errorRingOpacity), lineWidth: Theme.Setup.errorRing)
        .padding(-Theme.Setup.errorRing / 2).opacity(error ? 1 : 0))
      .accessibilityLabel("Goal branch").accessibilityValue(text.isEmpty ? placeholder : text)
      .help("Reviewed work lands on this branch; when the planner is done you choose whether to open a pull request from it")
  }
}

#endif
