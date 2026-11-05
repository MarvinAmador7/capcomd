#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI
import CapcomdOnboarding

// Home (design/desktop/Home.dc.html, the owner's approved prototype): the onboarding bot's head as a quiet mark, "What
// are we building?", the composer, and the runs that are running. Shown whenever no project is open, and from the title
// bar's Home (⌘0) or + (⇧⌘N). What it says comes from the store (HomeRun, ModelMenu); this only lays it out.

struct HomeView: View {
  @Environment(DeskModel.self) private var model
  let np: NewProjectModel
  /// Home itself holds the keyboard when it opens (no field focused, no ring): AppKit would otherwise hand it to the
  /// goal field, the window's first text field. Typing here goes to the composer.
  @FocusState private var resting: Bool
  var body: some View {
    DeskProbe.body("HomeView")
    return ScrollView(.vertical) {
      VStack(spacing: 0) {
        HomeMark().padding(.bottom, Theme.Desk.Home.markGap)
        VStack(spacing: Theme.Desk.Home.subtitleGap) {
          Text("What are we building?")
            .font(Theme.Desk.Home.title).tracking(Theme.Desk.Home.titleTracking).foregroundStyle(Theme.Desk.Home.titleColor)
            .accessibilityAddTraits(.isHeader)
          Text("Describe it once. The planner splits it up and brings in a crew.")
            .font(Theme.Desk.Home.subtitle).foregroundStyle(Theme.Desk.tertiary)
        }
        .multilineTextAlignment(.center)
        .padding(.bottom, Theme.Desk.Home.titleGap)
        HomeComposer(np: np).zIndex(1)
        RunningSection().padding(.top, Theme.Desk.Home.runningTop)
      }
      .frame(maxWidth: Theme.Desk.Home.width)
      .padding(.horizontal, Theme.Desk.Home.gutter)
      .padding(.top, Theme.Desk.Home.top).padding(.bottom, Theme.Desk.Home.bottom)
      .frame(maxWidth: .infinity)
    }
    .scrollIndicators(.automatic)
    .focusable()
    .focusEffectDisabled()
    .focused($resting)
    .defaultFocus($resting, true)
    .onKeyPress(phases: .down) { press in
      guard resting, let text = HomeTyping.text(press.characters, command: press.modifiers.contains(.command),
                                                control: press.modifiers.contains(.control), option: press.modifiers.contains(.option)) else { return .ignored }
      model.typeIntoComposer(text)
      return .handled
    }
    .onAppear { if np.focusSerial == 0 { resting = true } }
    // The model menu floats over the window (a click outside closes it), from the button's bounds.
    .overlayPreferenceValue(ModelButtonBounds.self) { anchor in
      if np.modelMenuOpen, let anchor {
        GeometryReader { g in
          let r = g[anchor]
          ZStack(alignment: .topLeading) {
            Color.clear.contentShape(Rectangle()).onTapGesture { model.closeModelMenu() }
              .accessibilityHidden(true)
            ModelMenuView(revision: np.revision)
              .offset(x: r.minX, y: r.maxY + Theme.Desk.Home.menuGap)
          }
        }
      }
    }
  }
}

// MARK: the mark

/// The onboarding bot's head (rows 0–11 of its 16 × 16 sprite) in greys, 6 pt cells, a 1-pixel checker dither and 42 %
/// opacity: a mark, not a mascot. Drawn once into a bitmap (one pixel per point), shown without interpolation.
struct HomeMark: View {
  @MainActor static let image: NSImage? = {
    let g = Sprite.mark(), cell = Sprite.markCell, w = g.width * cell, h = g.height * cell
    var px = [UInt8](repeating: 0, count: w * h * 4)
    for c in g.cells {
      for y in c.y * cell..<(c.y + 1) * cell {
        for x in c.x * cell..<(c.x + 1) * cell {
          let a = Sprite.markAlpha(x: x, y: y), i = (y * w + x) * 4
          px[i] = UInt8(Double(c.color.r) * a); px[i + 1] = UInt8(Double(c.color.g) * a); px[i + 2] = UInt8(Double(c.color.b) * a)
          px[i + 3] = UInt8(255 * a)
        }
      }
    }
    guard let provider = CGDataProvider(data: Data(px) as CFData),
          let cg = CGImage(width: w, height: h, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: w * 4, space: CGColorSpace(name: CGColorSpace.sRGB)!,
                           bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.premultipliedLast.rawValue), provider: provider, decode: nil,
                           shouldInterpolate: false, intent: .defaultIntent) else { return nil }
    return NSImage(cgImage: cg, size: NSSize(width: w, height: h))
  }()
  var body: some View {
    let g = Sprite.mark()
    Group {
      if let img = Self.image { Image(nsImage: img).interpolation(.none).resizable() } else { Color.clear }
    }
    .frame(width: CGFloat(g.width * Sprite.markCell), height: CGFloat(g.height * Sprite.markCell))
    .opacity(Sprite.markOpacity)
    .accessibilityHidden(true)
  }
}

// MARK: the composer

/// The new-project composer with Home's lift: the folder and branch chips, the goal (15 pt), then + , Local / Cloud, the
/// model button, the mic and Start. A folder that isn't set up swaps the tool row for its next steps (the menu bar's
/// inline setup). The goal is the field's own state, handed to the model as it changes (the branch suggestion).
struct HomeComposer: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let np: NewProjectModel
  @FocusState private var focused: Bool
  @State private var goal = ""

  var body: some View {
    DeskProbe.body("HomeComposer")
    _ = np.revision
    let form = np.form
    let busy = form.phase != .editing
    let setup = model.newProjectSetup()
    let branches = model.newProjectBranches
    let shape = RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius, style: .continuous)
    return VStack(alignment: .leading, spacing: Theme.Desk.Home.cardGap) {
      HStack(spacing: 4) {
        FolderChip(revision: np.revision)
        if branches { BaseChip(form: form) }
        Spacer(minLength: 0)
      }
      if branches { GoalBranchName(form: form); BranchLines(form: form) }
      TextField("", text: $goal, axis: .vertical)
        .textFieldStyle(.plain).font(Theme.Desk.Home.goalFont).tracking(Theme.Desk.Home.goalTracking).foregroundStyle(Theme.Desk.text)
        .lineLimit(2...8).lineSpacing(4)
        .frame(minHeight: 50, alignment: .topLeading)
        .background(alignment: .topLeading) {
          if goal.isEmpty {
            Text("Describe a project for your agents…").font(Theme.Desk.Home.goalFont).tracking(Theme.Desk.Home.goalTracking)
              .foregroundStyle(Theme.Desk.tertiary).allowsHitTesting(false).accessibilityHidden(true)
          }
        }
        .padding(4)
        .focused($focused).disabled(busy)
        .onSubmit(submit)
        .onKeyPress(.escape) { model.newProjectEscape(); return .handled }
        .accessibilityLabel("Describe a project for your agents")
      if let line = form.goalLine(branches: branches) {
        Text(verbatim: line).font(Theme.Setup.noteFont).foregroundStyle(Theme.red).fixedSize(horizontal: false, vertical: true)
          .textSelection(.enabled).padding(.horizontal, 4)
      }
      if let setup {
        InlineSetupSection(screen: setup, flow: model.setupFlow, defaultKey: !focused, cardInset: Theme.Desk.Home.cardPadding.leading,
                           onPrimary: { model.setupAction($0) }, onChooseAnother: { model.chooseProjectFolder() },
                           onCancel: { model.cancelSetup() }, onLogIn: { SetupTerminal.githubLogin() })
          .transition(.opacity)
      } else {
        toolRow(busy: busy)
      }
    }
    .padding(Theme.Desk.Home.cardPadding)
    .background {
      ZStack {
        // The blue ring outside the card while the goal has the keyboard (the card is opaque: only 3 pt of it shows).
        RoundedRectangle(cornerRadius: Theme.Desk.Home.cardRadius + Theme.Desk.Home.focusWidth, style: .continuous)
          .fill(Theme.Desk.Home.focusRing).padding(-Theme.Desk.Home.focusWidth).opacity(focused ? 1 : 0)
        shape.fill(Theme.Desk.Home.cardFill)
          .shadow(color: .black.opacity(0.5), radius: 16, x: 0, y: 14)
      }
    }
    .overlay(shape.strokeBorder(Theme.Desk.Home.cardRing, lineWidth: 0.5))
    .contentShape(Rectangle())
    .onTapGesture { focused = true }
    .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: focused)
    .animation(Theme.Motion.fast, value: setup == nil)
    .accessibilityElement(children: .contain).accessibilityLabel("New project")
    .onAppear { goal = form.goal; if np.focusSerial > 0 { takeFocus() } }
    .onChange(of: goal) { _, g in model.typeGoal(g) }
    .onChange(of: np.focusSerial) { _, _ in takeFocus() }
    .onChange(of: form.goal) { _, g in if g != goal { goal = g } }   // the debug control file types into the model
  }

  /// + / ⇧⌘N, typing on Home, Set Up done: the goal takes the keyboard with the caret after what's there (a field that
  /// takes focus selects all its text, and the next key would replace what was just typed). SwiftUI applies a focus
  /// change only while the app is active; when it didn't (a window driven without activating the app), AppKit hands the
  /// field the keyboard directly, as the bench does.
  private func takeFocus() {
    focused = true
    DispatchQueue.main.async {
      let w = NSApp.keyWindow ?? NSApp.windows.first { $0.isVisible && $0.firstResponder != nil && Self.goalField(in: $0.contentView) != nil }
      guard let w else { return }
      if !(w.firstResponder is NSTextView), let f = Self.goalField(in: w.contentView) { w.makeFirstResponder(f) }
      guard let tv = w.firstResponder as? NSTextView else { return }
      tv.setSelectedRange(NSRange(location: (tv.string as NSString).length, length: 0))
    }
  }

  /// The goal field's AppKit view: Home's one editable field that wraps (the goal grows to 8 lines; the goal branch
  /// field and the setup's fields are single-line).
  static func goalField(in v: NSView?) -> NSTextField? {
    guard let v else { return nil }
    if let f = v as? NSTextField, f.isEditable, f.cell?.wraps == true || !f.usesSingleLineMode, !f.isHiddenOrHasHiddenAncestor { return f }
    for s in v.subviews { if let f = goalField(in: s) { return f } }
    return nil
  }

  private func toolRow(busy: Bool) -> some View {
    HStack(spacing: 6) {
      AddMenu(revision: np.revision)
      PlaceSwitch(revision: np.revision)
      ModelButton(np: np)
      Spacer(minLength: 0)
      if busy { ProgressView().controlSize(.small).accessibilityLabel("Starting") }
      MicButton { focused = true }
      StartButton(ready: model.newProjectCanStart) { submit() }
    }
    .frame(height: Theme.Desk.Home.toolRow)
  }

  private func submit() {
    // Return while a folder's next steps show presses Set Up (or Set Up and Start), as the menu bar's composer does.
    if let p = model.newProjectSetup()?.primary {
      if (p.action == .setUp || p.action == .setUpAndStart) && p.enabled && !p.busy { model.setupAction(p.action) }
      return
    }
    Task { await model.startNewProject() }
  }
}

/// The mic: focuses the goal and starts macOS dictation into it (Edit › Start Dictation), until the app has voice input
/// of its own.
struct MicButton: View {
  let focus: () -> Void
  var body: some View {
    Button {
      focus()
      DispatchQueue.main.async { NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil) }
    } label: {
      Image(systemName: "mic").font(.system(size: 13.5, weight: .regular)).foregroundStyle(Theme.Desk.secondary)
        .frame(width: Theme.Desk.Home.go, height: Theme.Desk.Home.go).contentShape(Circle())
    }
    .buttonStyle(PressableStyle())
    .help("Dictate")
    .accessibilityLabel("Dictate the goal")
  }
}

/// Start: the white round arrow; dim while there's nothing to start.
struct StartButton: View {
  let ready: Bool
  let action: () -> Void
  var body: some View {
    Button(action: action) {
      Image(systemName: "arrow.up").font(.system(size: 12, weight: .bold)).foregroundStyle(Theme.Desk.Home.goArrow)
        .frame(width: Theme.Desk.Home.go, height: Theme.Desk.Home.go)
        .background(Circle().fill(Theme.Desk.Home.goFill))
        .contentShape(Circle())
    }
    .buttonStyle(PressableStyle())
    .disabled(!ready).opacity(ready ? 1 : 0.3)
    .help("Start (Return)")
    .accessibilityLabel("Start the project")
  }
}

// MARK: the model button and its menu

struct ModelButtonBounds: PreferenceKey {
  static let defaultValue: Anchor<CGRect>? = nil
  static func reduce(value: inout Anchor<CGRect>?, nextValue: () -> Anchor<CGRect>?) { value = value ?? nextValue() }
}

/// The planner's model with its effort as bars: opens the model menu. With no harness that can run here it stays a
/// menu, dimmed, whose sections say why.
struct ModelButton: View {
  @Environment(DeskModel.self) private var model
  let np: NewProjectModel
  @State private var hovering = false
  var body: some View {
    _ = np.revision
    let m = model.store.modelMenu
    let open = np.modelMenuOpen
    return Button { model.toggleModelMenu() } label: {
      HStack(spacing: 6) {
        Text(verbatim: m.chip).font(Theme.Desk.Home.drvFont).lineLimit(1)
        if let bars = m.bars { EffortBarsMark(lit: bars) }
        Image(systemName: "chevron.down").font(.system(size: 7, weight: .bold))
      }
      .foregroundStyle(open || hovering ? Theme.Desk.text : m.enabled ? Theme.Desk.secondary : Theme.Desk.tertiary)
      .padding(.horizontal, 8).frame(height: Theme.Desk.Home.drvHeight)
      .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(open || hovering ? Theme.Desk.Home.drvHover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .onHover { hovering = $0 }
    .fixedSize()
    .anchorPreference(key: ModelButtonBounds.self, value: .bounds) { $0 }
    .help(m.label)
    .accessibilityLabel(m.label)
    .accessibilityHint("Opens the planner's models and effort")
    .accessibilityAddTraits(open ? .isSelected : [])
  }
}

/// Three rising bars (the prototype's 12 × 10 glyph): `lit` of them in the text colour, the rest faint.
struct EffortBarsMark: View {
  let lit: Int
  var body: some View {
    Canvas { ctx, _ in
      let bars: [(x: CGFloat, y: CGFloat, h: CGFloat)] = [(0.5, 6, 3.5), (4.3, 3.5, 6), (8.1, 1, 8.5)]
      for (i, b) in bars.enumerated() {
        let p = Path(roundedRect: CGRect(x: b.x, y: b.y, width: 2.4, height: b.h), cornerRadius: 0.5)
        ctx.fill(p, with: i < lit ? .foreground : .color(Theme.Desk.Home.barOff))
      }
    }
    .frame(width: 12, height: 10)
    .accessibilityHidden(true)
  }
}

/// The model menu (Home.dc.html, "Planner model"): Claude Code's models, Codex's, then Effort. ↑ ↓ move, Return picks,
/// ← → change the effort, Esc closes. A harness that can't run where the run would start says why, its models dimmed.
struct ModelMenuView: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// Home's revision: what this shows is read from the store, which isn't observed.
  let revision: Int
  @FocusState private var focused: Bool
  @State private var selection: String?
  @State private var hover: String?
  @State private var shown = false

  var body: some View {
    let m = model.store.modelMenu
    let options = m.sections.flatMap(\.options)
    let levels: [String?] = (m.offersAuto ? [nil] : []) + m.efforts.map { Optional($0) }
    let width = levels.count > 4 ? Theme.Desk.Home.menuWidth + 80 : Theme.Desk.Home.menuWidth
    return VStack(alignment: .leading, spacing: 0) {
      ForEach(m.sections) { s in
        Text(verbatim: s.title).font(Theme.Desk.Home.menuHeader).foregroundStyle(Theme.Desk.tertiary)
          .padding(.horizontal, 9).padding(.top, 7).padding(.bottom, 3)
          .accessibilityAddTraits(.isHeader)
        if let why = s.reason {
          Text(verbatim: why).font(Theme.Desk.Home.menuNote).foregroundStyle(Theme.Desk.tertiary)
            .fixedSize(horizontal: false, vertical: true).padding(.horizontal, 9).padding(.bottom, 3)
        }
        ForEach(s.options) { o in item(o) }
      }
      if !levels.isEmpty {
        Rectangle().fill(Theme.Desk.Home.separator).frame(height: 0.5).padding(.vertical, 5).padding(.horizontal, 4)
        Text("Effort").font(Theme.Desk.Home.menuHeader).foregroundStyle(Theme.Desk.tertiary)
          .padding(.horizontal, 9).padding(.top, 7).padding(.bottom, 3)
          .accessibilityAddTraits(.isHeader)
        EffortSegments(levels: levels, picked: m.effort) { model.pickEffort($0) }
          .padding(.horizontal, 6).padding(.top, 4).padding(.bottom, 6)
      }
    }
    .padding(Theme.Desk.Home.menuPadding)
    .frame(width: width, alignment: .leading)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.Home.menuRadius, style: .continuous).fill(Theme.Desk.Home.menuFill)
      .shadow(color: .black.opacity(0.55), radius: 16, y: 12))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.Home.menuRadius, style: .continuous).strokeBorder(Theme.Desk.Home.menuRing, lineWidth: 0.5))
    .opacity(shown ? 1 : 0).offset(y: shown || reduceMotion ? 0 : -3)
    .onAppear {
      withAnimation(reduceMotion ? Theme.Motion.reduced : .easeOut(duration: 0.14)) { shown = true }
      selection = options.first(where: \.checked)?.id ?? options.first(where: \.enabled)?.id
      focused = true
    }
    .focusable()
    .focused($focused)
    .focusEffectDisabled()
    .onKeyPress(.downArrow) { move(1, options); return .handled }
    .onKeyPress(.upArrow) { move(-1, options); return .handled }
    .onKeyPress(.leftArrow) { stepEffort(-1, levels, m.effort); return .handled }
    .onKeyPress(.rightArrow) { stepEffort(1, levels, m.effort); return .handled }
    .onKeyPress(.return) { if let o = options.first(where: { $0.id == selection }) { model.pickModel(o) }; return .handled }
    .onKeyPress(.escape) { model.closeModelMenu(); return .handled }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Planner model")
    .accessibilityAddTraits(.isModal)
  }

  private func item(_ o: ModelMenu.Option) -> some View {
    let lit = o.enabled && (hover == o.id || (hover == nil && selection == o.id))
    return Button { model.pickModel(o) } label: {
      HStack(spacing: 8) {
        Text(o.checked ? "✓" : "").font(Theme.Desk.Home.menuItem).frame(width: 12)
        Text(verbatim: o.name).font(Theme.Desk.Home.menuItem).lineLimit(1)
        Spacer(minLength: 8)
        Text(verbatim: o.note).font(Theme.Desk.Home.menuNote).foregroundStyle(lit ? Color.white.opacity(0.8) : Theme.Desk.tertiary).lineLimit(1)
      }
      .foregroundStyle(Theme.Desk.text)
      .padding(.horizontal, 9).frame(height: Theme.Desk.Home.itemHeight)
      .background(RoundedRectangle(cornerRadius: Theme.Desk.Home.itemRadius, style: .continuous).fill(lit ? Theme.Desk.Home.itemHighlight : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .disabled(!o.enabled).opacity(o.enabled ? 1 : 0.4)
    .onHover { h in if h { hover = o.id; selection = o.id } else if hover == o.id { hover = nil } }
    .accessibilityLabel("\(o.name), \(o.note)")
    .accessibilityAddTraits(o.checked ? .isSelected : [])
  }

  private func move(_ by: Int, _ options: [ModelMenu.Option]) {
    let pickable = options.filter(\.enabled)
    guard !pickable.isEmpty else { return }
    hover = nil
    let i = pickable.firstIndex { $0.id == selection } ?? (by > 0 ? -1 : pickable.count)
    selection = pickable[min(max(0, i + by), pickable.count - 1)].id
  }
  private func stepEffort(_ by: Int, _ levels: [String?], _ picked: String?) {
    guard let i = levels.firstIndex(of: picked) ?? levels.firstIndex(of: nil) else { return }
    let j = min(max(0, i + by), levels.count - 1)
    if j != i { model.pickEffort(levels[j]) }
  }
}

/// The menu's Effort segmented control (and the composer's Local / Cloud look): Auto, then the driver's levels.
struct EffortSegments: View {
  let levels: [String?]
  let picked: String?
  let pick: (String?) -> Void
  var body: some View {
    HStack(spacing: 0) {
      ForEach(Array(levels.enumerated()), id: \.offset) { _, l in
        let on = l == picked
        let title = l.map(EffortWords.title) ?? "Auto"
        Button { pick(l) } label: {
          Text(verbatim: title).font(.system(size: 12, weight: on ? .medium : .regular)).lineLimit(1).minimumScaleFactor(0.8)
            .foregroundStyle(on ? Theme.Desk.text : Theme.Desk.tertiary)
            .frame(maxWidth: .infinity).frame(height: 24)
            .background { if on { Capsule().fill(Theme.Desk.Home.segmentOn).shadow(color: .black.opacity(0.35), radius: 1, y: 1) } }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(title) effort").accessibilityAddTraits(on ? .isSelected : [])
      }
    }
    .padding(2)
    .background(Capsule().fill(Color.black.opacity(0.28)))
    .overlay(Capsule().strokeBorder(Color.white.opacity(0.08), lineWidth: 0.5))
    .accessibilityElement(children: .contain).accessibilityLabel("Effort")
  }
}

// MARK: Running

/// "Running" and its count, then one card per running run in the store's live order. Absent with nothing running.
struct RunningSection: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    DeskProbe.body("RunningSection")
    let runs = model.home.runs
    return Group {
      if !runs.isEmpty {
        VStack(alignment: .leading, spacing: Theme.Desk.Home.runningGap) {
          HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text("Running").font(Theme.Desk.Home.header).foregroundStyle(Theme.Desk.secondary).accessibilityAddTraits(.isHeader)
            Text(verbatim: "\(runs.count)").font(Theme.Desk.Home.count).foregroundStyle(Theme.Desk.tertiary)
              .accessibilityLabel("\(runs.count) running")
          }
          .padding(.horizontal, 4).padding(.bottom, 2)
          ForEach(runs) { r in
            RunCard(run: r)
              .transition(reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -6)))
          }
        }
        .animation(reduceMotion ? Theme.Motion.reduced : .spring(duration: 0.35, bounce: 0), value: runs.map(\.id))
      }
    }
  }
}

/// One running run: its place, its title, " · " and what the crew is doing, the crew's heads, the elapsed time. One
/// that asks has the amber ring and a second line: the question, the evidence, Deny and Approve ↩ (Return approves
/// while the card has focus; Esc never denies). A click, Space or Return on a card that doesn't ask opens the project.
struct RunCard: View {
  @Environment(DeskModel.self) private var model
  let run: HomeRun
  @State private var hovering = false
  @FocusState private var focused: Bool
  var body: some View {
    let _ = DeskProbe.body("RunCard", id: run.id)
    let shape = RoundedRectangle(cornerRadius: Theme.Desk.Home.runRadius, style: .continuous)
    let place = Place(sandbox: run.sandbox)
    VStack(alignment: .leading, spacing: 0) {
      Button { model.openCard(run.id) } label: {
        HStack(spacing: 10) {
          if let place {
            Image(systemName: place.symbol).font(.system(size: 12)).foregroundStyle(Theme.Desk.Home.placeTint).frame(width: 16)
          }
          (Text(verbatim: run.title).font(Theme.Desk.Home.runTitle).foregroundColor(Theme.Desk.text)
           + Text(verbatim: run.phrase.isEmpty ? "" : " · " + run.phrase).font(Theme.Desk.Home.runPhrase).foregroundColor(Theme.Desk.secondary))
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          CrewStack(runId: run.runId, agentIds: run.agentIds)
          RunClock(since: run.startedAtMs)
        }
        .padding(.horizontal, 14).frame(height: Theme.Desk.Home.runHeight)
        .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(spoken(place))
      .accessibilityHint("Opens it in the reel")
      if let a = run.ask {
        HStack(spacing: 8) {
          (Text(verbatim: a.question).font(Theme.Desk.Home.question).foregroundColor(Theme.Desk.text)
           + Text(verbatim: a.evidence.map { " " + $0 } ?? "").font(Theme.Desk.Home.runPhrase).foregroundColor(Theme.Desk.secondary))
            .lineLimit(1).truncationMode(.tail)
            .frame(maxWidth: .infinity, alignment: .leading)
          Button { model.decide(a.approvalId, .deny) } label: { DecisionLabel(title: "Deny", primary: false) }
            .buttonStyle(PressableStyle()).disabled(a.busy)
          Button { model.decide(a.approvalId, .approve) } label: { DecisionLabel(title: "Approve", primary: true) }
            .buttonStyle(PressableStyle()).disabled(a.busy)
            .accessibilityHint("Return approves while the card is focused")
        }
        .padding(.leading, 40).padding(.trailing, 10).padding(.bottom, 10).padding(.top, -4)
      }
    }
    .background(shape.fill(hovering ? Theme.Desk.Home.runHover : Theme.Desk.column))
    .overlay {
      if run.ask != nil { shape.strokeBorder(Theme.Desk.Home.askRing, lineWidth: 1) }
      else { shape.strokeBorder(Theme.Desk.Home.runRing, lineWidth: 0.5) }
    }
    .clipShape(shape)
    .onHover { hovering = $0 }
    .animation(.easeOut(duration: 0.15), value: hovering)
    .focusable(interactions: .activate)
    .focused($focused)
    .onKeyPress(.return) {
      if let a = run.ask { if !a.busy { model.decide(a.approvalId, .approve) } } else { model.openCard(run.id) }
      return .handled
    }
    .onKeyPress(.space) { model.openCard(run.id); return .handled }
    .accessibilityElement(children: .contain)
    .accessibilityLabel(run.title + (run.ask != nil ? ", asks" : ""))
    .modifier(RunAskActions(ask: run.ask))
  }

  private func spoken(_ place: Place?) -> String {
    var parts = [run.title]
    if !run.phrase.isEmpty { parts.append(run.phrase) }
    if let place { parts.append(place.word) }
    if let s = run.startedAtMs { parts.append("running for \(elapsedClock(ms: Int(Date().timeIntervalSince1970 * 1000) - s))") }
    return parts.joined(separator: ", ")
  }
}

/// VoiceOver's Approve and Deny on a card that asks (the buttons are there too; these act from the card itself).
struct RunAskActions: ViewModifier {
  @Environment(DeskModel.self) private var model
  let ask: HomeRun.Ask?
  func body(content: Content) -> some View {
    if let a = ask {
      content
        .accessibilityAction(named: "Approve") { model.decide(a.approvalId, .approve) }
        .accessibilityAction(named: "Deny") { model.decide(a.approvalId, .deny) }
    } else { content }
  }
}

/// Deny (an outline) and Approve ↩ (the inverted fill).
struct DecisionLabel: View {
  let title: String
  let primary: Bool
  var body: some View {
    HStack(spacing: 6) {
      Text(title).font(primary ? Theme.Desk.Home.button.weight(.semibold) : Theme.Desk.Home.button)
      if primary {
        Text("↩").font(.system(size: 11)).padding(.horizontal, 4).frame(height: 18)
          .background(RoundedRectangle(cornerRadius: 4, style: .continuous).fill(Color.black.opacity(0.12)))
          .accessibilityHidden(true)
      }
    }
    .foregroundStyle(primary ? Theme.Desk.Home.approveText : Theme.Desk.text)
    .padding(.horizontal, 12).frame(height: Theme.Desk.Home.buttonHeight)
    .background { if primary { RoundedRectangle(cornerRadius: Theme.Desk.Home.buttonRadius, style: .continuous).fill(Theme.Desk.Home.approveFill) } }
    .overlay { if !primary { RoundedRectangle(cornerRadius: Theme.Desk.Home.buttonRadius, style: .continuous).strokeBorder(Theme.Desk.Home.buttonRing, lineWidth: 0.5) } }
    .contentShape(Rectangle())
  }
}

/// The crew's heads stacked, as the title bar's decks stack them (the catalog bots, drawn once per agent).
struct CrewStack: View {
  @Environment(DeskModel.self) private var model
  let runId: String
  let agentIds: [String]
  var body: some View {
    HStack(spacing: -Theme.Desk.Home.headOverlap) {
      ForEach(Array(model.heads(run: runId, agents: agentIds).enumerated()), id: \.offset) { _, t in
        BotAvatar(traits: t, size: .xs, cell: 1.5)
          .frame(width: Theme.Desk.Home.head, height: Theme.Desk.Home.head)
          .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Theme.Desk.Home.headFill))
          .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.Desk.ground, lineWidth: 1.5))
      }
    }
    .accessibilityHidden(true)
  }
}

/// The elapsed time in mono, ticking once a second. Every card's clock ticks on the whole second, so the cards update
/// in one commit a second rather than one each.
struct RunClock: View {
  static let epoch = Date(timeIntervalSinceReferenceDate: 0)
  let since: Int?
  var body: some View {
    Group {
      if let since {
        TimelineView(.periodic(from: Self.epoch, by: 1)) { ctx in
          Text(verbatim: elapsedClock(ms: Int(ctx.date.timeIntervalSince1970 * 1000) - since))
        }
      } else { Text(verbatim: "") }
    }
    .font(Theme.Desk.Home.runClock).foregroundStyle(Theme.Desk.tertiary).monospacedDigit()
    .frame(minWidth: 40, alignment: .trailing)
    .accessibilityHidden(true)
  }
}
#endif
