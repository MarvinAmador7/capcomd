#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

// The composer's inline project setup (design/setup/InlineSetup, InlineAttention, InlinePublish; setup-spec.md): a
// picked folder that isn't a set-up capcomd project swaps the tool row for its next steps, inside the composer card.
// ProjectSetupFlow (CapcomdStore) decides what shows; these views draw its SetupScreen.

extension AppModel {
  /// The picked folder's next steps for the composer card, or nil (the tool row shows).
  func setupScreen(goal: String) -> SetupScreen? { _ = revision; return setup.screen(goal: goal, sandbox: startSandbox?.name) }
  /// The card shows a folder's next steps (not just looking at it).
  var setupShowing: Bool { _ = revision; return setup.screen(goal: "", sandbox: nil).map { $0.phase != .loading } ?? false }
  /// The + menu's Choose Project Folder…, and Choose Another Folder… on the card.
  func chooseProjectFolder() {
    Task { if let f = await ProjectFolderPicker.choose(prompt: "Choose the project's folder.") { await setup.pick(f) } }
  }
  func cancelSetup() { setup.cancel() }
  /// Settings › General › New projects.
  var gitignoreCapcomd: Bool {
    get { _ = revision; return store.prefs.gitignoreCapcomd }
    set { store.prefs.gitignoreCapcomd = newValue; bump() }
  }
  /// The daemon applies it (`projects.git`).
  var gitignoreSupported: Bool { _ = revision; return store.projectGitSupported }

  /// A button on the card. Set Up (and Start) answers how it ended, for the composer's focus.
  func setupAction(_ a: SetupAction, goal: String) async -> SetupOutcome {
    switch a {
    case .setUp, .setUpAndStart: return await setup.submit(goal: goal) { [weak self] g in await self?.startRun(g) ?? false }
    case .initializeGit: await setup.initializeGit()
    case .publish: await setup.publish()
    case .logInToGitHub: TerminalLauncher.githubLogin()
    case .openInTerminal: if let p = setup.path { TerminalLauncher.setUpProject(in: p) }
    case .tryAgain: if let p = setup.path { await setup.pick(p) }
    }
    return .showing
  }
}

/// The next steps under the goal (`.next`): a hairline across the card, the orange dot and what's needed, the rows or a
/// callout, then the buttons.
struct InlineSetupSection: View {
  @Environment(AppModel.self) private var model
  let screen: SetupScreen
  /// Return presses the primary (off while the goal field has focus: it sends Return through its own submit).
  var defaultKey = true
  /// The primary was pressed (the composer runs it: Set Up and Start needs its goal).
  let onPrimary: (SetupAction) -> Void

  var body: some View {
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
            SetupRowView(item: item)
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
        SetupNoteView(note: notice).padding(.top, Theme.Setup.calloutTop).padding(.bottom, -Theme.Setup.noteBottom)
      }
      HStack(spacing: Theme.Setup.actionGap) {
        if screen.chooseAnother { Button("Choose Another Folder…") { model.chooseProjectFolder() }.buttonStyle(SetupButtonStyle(kind: .secondary)) }
        Spacer(minLength: 0)
        if screen.cancel {
          Button("Cancel") { model.cancelSetup() }.buttonStyle(SetupButtonStyle(kind: .quiet))
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
      Rectangle().fill(Theme.Setup.divider).frame(height: 0.5).padding(.horizontal, -Theme.Composer2.padding.leading)
    }
  }
}

/// The 7 pt orange dot: on the chip and before the header, "not set up".
struct SetupDot: View {
  var body: some View {
    Circle().fill(Theme.Setup.orange).frame(width: Theme.Setup.dot, height: Theme.Setup.dot).accessibilityLabel("Not set up")
  }
}

/// A row (`.r`): its label in an 84 pt column, the value on the right; a note under it (`.rn`) when there is one.
struct SetupRowView: View {
  @Environment(AppModel.self) private var model
  let item: SetupRowItem
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: Theme.Setup.rowGap) {
        Text(verbatim: label).font(Theme.Setup.labelFont).foregroundStyle(Theme.Setup.labelText)
          .frame(width: Theme.Setup.labelWidth, alignment: .leading)
        Spacer(minLength: 0)
        value
      }
      .padding(.vertical, Theme.Setup.rowPaddingV).padding(.horizontal, Theme.Setup.inset)
      .frame(minHeight: Theme.Setup.rowHeight)   // border-box: the 32 pt include the padding
      if let note = item.note { SetupNoteView(note: note) }
    }
  }

  private var label: String {
    switch item.row {
    case .repository: "Repository"; case .target: "Target branch"; case .mode: "Changes land as"; case .agents: "Agents"
    case .spendCap: "Spend cap"; case .account: "Account"; case .name: "Name"; case .visibility: "Visibility"
    }
  }

  @ViewBuilder private var value: some View {
    let flow = model.setup
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
struct SetupNoteView: View {
  let note: SetupNote
  var body: some View {
    HStack(alignment: .center, spacing: Theme.Setup.noteGap) {
      Text(verbatim: note.text).font(Theme.Setup.noteFont).lineSpacing(Theme.Setup.noteLineSpacing)
        .foregroundStyle(note.warn ? Theme.Setup.orange : Theme.Setup.noteText)
        .frame(maxWidth: .infinity, alignment: .leading).fixedSize(horizontal: false, vertical: true)
      if note.logIn {
        Button("Log In…") { TerminalLauncher.githubLogin() }.buttonStyle(SetupButtonStyle(kind: .mini))
          .help("Opens Terminal to log the GitHub CLI in (gh auth login)")
      }
    }
    .padding(.horizontal, Theme.Setup.inset).padding(.bottom, Theme.Setup.noteBottom)
  }
}

/// The callout (`.callout`): what's needed, in a sentence, with paths and commands in mono.
struct SetupCallout: View {
  let spans: [SetupSpan]
  var body: some View {
    spans.reduce(Text(verbatim: "")) { t, s in t + Text(verbatim: s.text).font(s.mono ? Theme.Setup.monoFont : Theme.Setup.calloutFont) }
      .foregroundStyle(Theme.Setup.calloutText).lineSpacing(Theme.Setup.calloutLineSpacing)
      .fixedSize(horizontal: false, vertical: true)
      .textSelection(.enabled)
  }
}

/// A value that edits in place (`.pop`): the value and the up/down chevrons on a 22 pt pill; a menu.
struct SetupPopup<Content: View>: View {
  let text: String
  var github = false
  let accessibility: String
  @ViewBuilder let content: () -> Content
  var body: some View {
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
struct SetupField: View {
  var prefix: String? = nil
  @Binding var text: String
  let width: CGFloat
  var error = false
  let accessibility: String
  var body: some View {
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
struct SetupAgentChipView: View {
  let chip: SetupAgentChip
  let toggle: () -> Void
  var body: some View {
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
struct SetupButtonStyle: ButtonStyle {
  enum Kind { case primary, secondary, quiet, mini }
  let kind: Kind
  var dim = false
  func makeBody(configuration: Configuration) -> some View {
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

extension TerminalLauncher {
  /// Log In… / Log In to GitHub… on the card: the GitHub CLI's own login, in Terminal (the app never sees the token).
  @discardableResult
  static func githubLogin() -> Bool {
    script(name: "gh-login", """
      gh auth login
      echo
      echo "When you're logged in, open capcomd from the menu bar again."
      """)
  }

  /// Open in Terminal for a checkout that isn't on GitHub: `capcomd setup project` in the folder the person picked.
  @discardableResult
  static func setUpProject(in folder: String) -> Bool {
    let quoted = "'" + folder.replacingOccurrences(of: "'", with: "'\\''") + "'"
    return script(name: "setup-project", """
      cd \(quoted) || exit 1
      capcomd setup project
      """)
  }
}
#endif
