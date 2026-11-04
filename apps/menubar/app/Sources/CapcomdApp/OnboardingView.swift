#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdOnboarding

// The onboarding's screens (design/onboarding/onboarding.dc.html), laid out on its 1200×760 window as the prototype
// places them. The intro and the welcome bot are IntroCanvas (Core Animation) underneath.

struct OnboardingView: View {
  let model: OnboardingModel
  var body: some View {
    let step = model.flow.step
    ZStack(alignment: .topLeading) {
      IntroCanvas(model: model).frame(width: 1200, height: 760)
      TitleText(shown: model.chromeShown)
      if step.showsDots { StepDots(step: step, shown: model.chromeShown) }
      Group {
        switch step {
        case .welcome: WelcomeScreen(model: model)
        case .boot: BootScreen(model: model)
        case .crew: CrewScreen(model: model)
        case .project: ProjectScreen(model: model)
        case .goal: GoalScreen(model: model)
        case .launch: LaunchScreen(model: model)
        case .allSet: AllSetScreen(model: model)
        }
      }
      .id(step)
      if step.showsFooter { Footer(model: model) }
    }
    .frame(width: 1200, height: 760, alignment: .topLeading)
    .foregroundStyle(OnboardColor.text)
    .font(OnboardType.text(16))
    .environment(\.colorScheme, .dark)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Set up capcomd")
  }
}

/// "capcomd" over the title bar (the traffic lights are the window's own).
private struct TitleText: View {
  let shown: Bool
  var body: some View {
    Text("capcomd").font(OnboardType.text(13, 600)).foregroundStyle(OnboardColor.secondary)
      .frame(width: 1200, height: 40)
      .opacity(shown ? 1 : 0)
      .animation(.easeInOut(duration: 0.8).delay(0.35), value: shown)
      .accessibilityHidden(true)
  }
}

private struct StepDots: View {
  let step: OnboardStep
  let shown: Bool
  var body: some View {
    HStack(spacing: 10) {
      ForEach(Array(dots(step).enumerated()), id: \.offset) { _, d in
        Rectangle().fill(d == .on ? OnboardColor.orange : d == .done ? OnboardColor.purple : OnboardColor.dot).frame(width: 8, height: 8)
      }
    }
    .animation(.easeOut(duration: 0.3), value: step)
    .frame(width: 1200).offset(y: 56)
    .opacity(shown ? 1 : 0)
    .animation(.easeInOut(duration: 0.8).delay(0.35), value: shown)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(step.dotsLabel)
  }
}

/// The 32 pt title of a screen (`.disp2`), rising out of its mask.
private struct ScreenTitle: View {
  let text: String
  var body: some View {
    Text(verbatim: text).font(OnboardType.display(32)).tracking(OnboardType.tracking(32)).lineSpacing(2)
      .fixedSize(horizontal: false, vertical: true)
      .padding(.bottom, 2.5)
      .maskRise(0)
      .accessibilityAddTraits(.isHeader)
  }
}

private struct Lede: View {
  let text: Text
  var maxWidth: CGFloat? = nil
  var body: some View {
    text.font(OnboardType.text(16)).foregroundStyle(OnboardColor.secondary).lineSpacing(16 * 0.55 - 4)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: maxWidth, alignment: .leading)
  }
}

// MARK: Welcome

private struct WelcomeScreen: View {
  let model: OnboardingModel
  var body: some View {
    let top = WelcomeLayout.heroTop + WelcomeLayout.heroSide + 24 + 40
    let d = Intro.welcomeDelays(afterIntro: model.intro == .opened)
    ZStack(alignment: .topLeading) {
      // His place, for VoiceOver (he's drawn on the canvas underneath).
      Color.clear.frame(width: WelcomeLayout.heroSide, height: WelcomeLayout.heroSide)
        .accessibilityElement().accessibilityLabel("The capcomd bot").accessibilityAddTraits(.isImage)
        .offset(x: WelcomeLayout.heroLeft, y: WelcomeLayout.heroTop)
      if model.chromeShown {
        VStack(spacing: 0) {
          Text("Meet your crew.").font(OnboardType.display(64)).tracking(OnboardType.tracking(64))
            .frame(height: 64).maskRise(d.title, duration: 0.95)
            .accessibilityAddTraits(.isHeader)
          Text("Coding agents that build and check each other's work.")
            .font(OnboardType.text(19)).foregroundStyle(OnboardColor.soft)
            .frame(height: 28.5).padding(.top, 18).rise(d.sub)
          Button("Get started") { model.primary() }
            .buttonStyle(OnboardPrimaryStyle(height: 52, padding: 32))
            .keyboardShortcut(.defaultAction)
            .onboardFocusRing()
            .padding(.top, 36).rise(d.cta)
        }
        .frame(width: 1200)
        .offset(y: top)
        .id(model.welcomeSerial)
      }
    }
  }
}

// MARK: Boot

private struct BootScreen: View {
  let model: OnboardingModel
  var body: some View {
    let b = model.flow.boot
    HStack(alignment: .top, spacing: 72) {
      VStack(alignment: .leading, spacing: 0) {
        ScreenTitle(text: "Boot capcomd")
        Lede(text: Text("capcomd is the engine your crew runs on. It works in the background, on this Mac."), maxWidth: 480)
          .padding(.top, 12).enter(1)
        if b.cliMissing { MissingCLI(model: model).padding(.top, 30).enter(2) }
        else {
          BootSteps(boot: b, reduceMotion: model.reduceMotion).padding(.top, 30).enter(2)
          OnboardSwitch(label: "Start capcomd when I log in", on: Binding(get: { model.flow.boot.atLogin }, set: { model.setAtLogin($0) }))
            .disabled(!b.switchEnabled)
            .padding(.top, 14).enter(3)
        }
      }
      .frame(width: 568, alignment: .leading)
      VStack(spacing: 26) {
        OnboardBot(colorway: .orange, mood: b.done ? .happy : .smile, cell: 10).accessibilityHidden(true).enter(0)
        Bubble(text: b.bubble).enter(1)
      }
      .frame(width: 320).padding(.top, 20)
    }
    .offset(x: 120, y: 120)
  }
}

private struct MissingCLI: View {
  let model: OnboardingModel
  var body: some View {
    VStack(alignment: .leading, spacing: 14) {
      HStack(spacing: 12) {
        Rectangle().strokeBorder(OnboardColor.warn, lineWidth: 4).frame(width: 16, height: 16)
        Text("capcomd isn't installed yet").font(OnboardType.text(16, 600)).foregroundStyle(OnboardColor.warnText)
      }
      VStack(alignment: .leading, spacing: 14) {
        Text("Install it with Homebrew, then check again.").font(OnboardType.text(13)).foregroundStyle(OnboardColor.secondary)
        HStack(spacing: 12) {
          Text(verbatim: FirstRun.installCommand).font(OnboardType.code).foregroundStyle(OnboardColor.soft).textSelection(.enabled)
          Spacer(minLength: 0)
          Button(model.copied ? "Copied" : "Copy") { model.copyInstall() }
            .buttonStyle(OnboardGhostStyle(height: 32, padding: 12, size: 13)).onboardFocusRing()
            .accessibilityLabel(model.copied ? "Copied" : "Copy the install command")
        }
        .padding(.leading, 16).padding([.trailing, .vertical], 8)
        .background(OnboardColor.panel)
        Button("Check again") { model.checkAgain() }
          .buttonStyle(OnboardGhostStyle()).onboardFocusRing()
      }
      .padding(.leading, 28)
    }
    .frame(maxWidth: 520, alignment: .leading)
  }
}

/// The three steps on their stepped circuit line.
private struct BootSteps: View {
  let boot: Boot
  let reduceMotion: Bool
  var body: some View {
    ZStack(alignment: .topLeading) {
      Dashes(vertical: true, color: OnboardColor.lineOff).frame(width: 4, height: 120).offset(x: 6, y: 18)
      SteppedFill(target: boot.fill, steps: 8, duration: 0.9, reduceMotion: reduceMotion) { h in
        Dashes(vertical: true, color: OnboardColor.green).frame(width: 4, height: h)
      }
      .offset(x: 6, y: 18)
      VStack(alignment: .leading, spacing: 0) {
        ForEach(0..<3, id: \.self) { i in BootRow(row: boot.row(i), label: boot.label(i), detail: boot.detail(i), reduceMotion: reduceMotion) }
      }
    }
    .accessibilityElement(children: .contain)
  }
}

private struct BootRow: View {
  let row: Boot.Row
  let label: String
  let detail: String?
  let reduceMotion: Bool
  var body: some View {
    HStack(alignment: .top, spacing: 16) {
      Node(row: row, reduceMotion: reduceMotion).padding(.top, 2)
      VStack(alignment: .leading, spacing: 4) {
        Text(verbatim: label).font(OnboardType.text(16, 500)).foregroundStyle(color)
        if let detail {
          Text(verbatim: detail).font(OnboardType.text(13)).foregroundStyle(isFailed ? OnboardColor.warnText : OnboardColor.secondary)
            .lineLimit(isFailed ? 2 : 1).truncationMode(.middle).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            .rise(0, duration: 0.5).id(detail)
        }
      }
    }
    .frame(height: 68, alignment: .top)
    .accessibilityElement(children: .combine)
    .accessibilityValue(accessibilityState)
  }
  private var isFailed: Bool { if case .failed = row { return true }; return false }
  private var color: Color {
    switch row {
    case .waiting: return OnboardColor.muted
    case .running: return OnboardColor.amber
    case .done: return OnboardColor.text
    case .failed: return OnboardColor.warnText
    }
  }
  private var accessibilityState: String {
    switch row { case .waiting: "Not started"; case .running: "In progress"; case .done: "Done"; case .failed: "Failed" }
  }
}

/// A step's node: hollow while waiting, a blinking orange ring while it runs, filled green when done, amber on a failure.
private struct Node: View {
  let row: Boot.Row
  let reduceMotion: Bool
  var body: some View {
    switch row {
    case .waiting: square(OnboardColor.node, fill: OnboardColor.ground)
    case .done: square(OnboardColor.green, fill: OnboardColor.green)
    case .failed: square(OnboardColor.warn, fill: OnboardColor.ground)
    case .running:
      TimelineView(.periodic(from: .now, by: 0.4)) { tl in
        let dim = !reduceMotion && Int(tl.date.timeIntervalSinceReferenceDate / 0.4) % 2 == 1
        square(dim ? OnboardColor.hex(0x5A3A14) : OnboardColor.orange, fill: OnboardColor.ground).opacity(dim ? 0.45 : 1)
      }
    }
  }
  private func square(_ border: Color, fill: Color) -> some View {
    Rectangle().fill(fill).overlay(Rectangle().strokeBorder(border, lineWidth: 4)).frame(width: 16, height: 16)
      .animation(.easeOut(duration: 0.3), value: border)
  }
}

/// A 4-on, 4-off dashed line.
private struct Dashes: View {
  let vertical: Bool
  let color: Color
  var body: some View {
    Canvas { ctx, size in
      let n = Int(((vertical ? size.height : size.width) / 8).rounded(.up))
      for i in 0..<n {
        let r = vertical ? CGRect(x: 0, y: CGFloat(i) * 8, width: size.width, height: min(4, size.height - CGFloat(i) * 8))
                         : CGRect(x: CGFloat(i) * 8, y: 0, width: min(4, size.width - CGFloat(i) * 8), height: size.height)
        if r.width > 0 && r.height > 0 { ctx.fill(Path(r), with: .color(color)) }
      }
    }
  }
}

/// A length that moves to its target in `steps` jumps over `duration` (CSS steps()).
private struct SteppedFill<Content: View>: View {
  let target: Double
  let steps: Int
  let duration: Double
  let reduceMotion: Bool
  @ViewBuilder let content: (CGFloat) -> Content
  @State private var shown: Double = 0
  @State private var stepping: Task<Void, Never>?
  var body: some View {
    content(CGFloat(shown))
      .onAppear { shown = target }
      .onChange(of: target) { from, to in
        stepping?.cancel()
        guard !reduceMotion else { shown = to; return }
        let start = shown
        stepping = Task { @MainActor in
          for k in 1...steps {
            try? await Task.sleep(for: .seconds(duration / Double(steps)))
            if Task.isCancelled { return }
            shown = start + (to - start) * Double(k) / Double(steps)
          }
        }
      }
  }
}

/// The bot's speech bubble, its pointer up at him.
private struct Bubble: View {
  let text: String
  var body: some View {
    Text(verbatim: text).font(OnboardType.text(16, 500)).foregroundStyle(OnboardColor.soft).multilineTextAlignment(.center)
      .padding(.horizontal, 16).padding(.vertical, 12)
      .frame(width: 280).frame(minHeight: 50)
      .background(OnboardColor.panel)
      .overlay(Rectangle().strokeBorder(OnboardColor.dot, lineWidth: 3))
      .overlay(alignment: .top) {
        Path { p in p.move(to: CGPoint(x: 6, y: 0)); p.addLine(to: CGPoint(x: 12, y: 9)); p.addLine(to: CGPoint(x: 0, y: 9)); p.closeSubpath() }
          .fill(OnboardColor.dot).frame(width: 12, height: 9).offset(y: -9)
      }
      .accessibilityLabel(text)
      .accessibilityAddTraits(.updatesFrequently)
  }
}

// MARK: Crew

private struct CrewScreen: View {
  let model: OnboardingModel
  var body: some View {
    _ = model.app.revision
    return VStack(alignment: .leading, spacing: 0) {
      ScreenTitle(text: "Who's on your crew?")
      Lede(text: Text("Your agents use the accounts you already have. One is enough to start.")).padding(.top, 12).enter(1)
      Grid(horizontalSpacing: 16) {
        GridRow {
          AgentCard(model: model, provider: "claude", name: "Claude Code", account: "Anthropic · your Claude account").stagger(0)
          AgentCard(model: model, provider: "codex", name: "Codex", account: "OpenAI · your ChatGPT account").stagger(1)
        }
      }
      .padding(.top, 26).enter(2)
      Text("Where they work").font(OnboardType.text(19, 600)).padding(.top, 36).enter(3).accessibilityAddTraits(.isHeader)
      Grid(horizontalSpacing: 16) {
        GridRow {
          PlaceCard(model: model, name: "docker").stagger(0)
          PlaceCard(model: model, name: "boxd").stagger(1)
        }
      }
      .padding(.top, 14).enter(4)
    }
    .frame(width: 760, alignment: .leading)
    .offset(x: 220, y: 104)
  }
}

private struct AgentCard: View {
  let model: OnboardingModel
  let provider: String, name: String, account: String
  var body: some View {
    let state = model.signIn(provider)
    HStack(spacing: 16) {
      ZStack {
        Rectangle().fill(provider == "claude" ? OnboardColor.hex(0xD97757, 0.12) : Color.white.opacity(0.08))
        if provider == "claude" { OnboardGlyph(path: ProviderMarks.claude, size: 30, color: Theme.Provider.claude) }
        else { OnboardGlyph(path: ProviderMarks.openai, size: 30, color: OnboardColor.text) }
      }
      .frame(width: 56, height: 56).accessibilityHidden(true)
      VStack(alignment: .leading, spacing: 6) {
        Text(verbatim: name).font(OnboardType.text(19, 600)).tracking(-0.19)
        Text(verbatim: account).font(OnboardType.text(13)).foregroundStyle(OnboardColor.muted)
        Group {
          switch state {
          case .signedIn: Pill(text: "Signed in", waiting: false)
          case .waiting: Pill(text: "Finish in Terminal…", waiting: true)
          case .signedOut:
            Button("Sign in") { model.startSignIn(provider) }
              .buttonStyle(OnboardGhostStyle(height: 32, padding: 14, size: 13)).onboardFocusRing()
              .accessibilityLabel("Sign in to \(name)").accessibilityHint("Opens Terminal to sign in.")
          }
        }
        .padding(.top, 4)
      }
      Spacer(minLength: 0)
    }
    .padding(18)
    .background(OnboardColor.card)
    .accessibilityElement(children: .contain)
  }
}

private struct Pill: View {
  let text: String
  let waiting: Bool
  var body: some View {
    HStack(spacing: 8) {
      if waiting {
        TimelineView(.periodic(from: .now, by: 0.4)) { tl in
          Rectangle().fill(OnboardColor.amber).frame(width: 6, height: 6).opacity(Int(tl.date.timeIntervalSinceReferenceDate / 0.4) % 2 == 1 ? 0.45 : 1)
        }
        .frame(width: 6, height: 6)
      } else {
        Rectangle().fill(OnboardColor.greenText).frame(width: 6, height: 6)
      }
      Text(verbatim: text).font(OnboardType.text(13, 500))
    }
    .foregroundStyle(waiting ? OnboardColor.amber : OnboardColor.greenText)
    .padding(.horizontal, 12).frame(height: 28)
    .background(waiting ? OnboardColor.hex(0xFF8A1F, 0.13) : OnboardColor.hex(0x30D158, 0.13))
    .accessibilityElement(children: .combine)
  }
}

private struct PlaceCard: View {
  let model: OnboardingModel
  let name: String
  var body: some View {
    let picked = model.flow.place == name
    Button { model.pickPlace(name) } label: {
      HStack(alignment: .top, spacing: 14) {
        if name == "docker" { OnboardGlyph(path: ProviderMarks.docker, size: 26, color: OnboardColor.hex(0x2496ED)) }
        else { OnboardGlyph(path: OnboardGlyphs.cloud, size: 24, color: OnboardColor.lilac, stroke: 1.6).padding(.top, 1) }
        VStack(alignment: .leading, spacing: 4) {
          Text(verbatim: name == "docker" ? "Docker on this Mac" : "boxd in the cloud").font(OnboardType.text(16, 600)).foregroundStyle(OnboardColor.text)
          Text(verbatim: sub).font(OnboardType.text(13)).foregroundStyle(OnboardColor.secondary).lineSpacing(13 * 0.45 - 3)
            .multilineTextAlignment(.leading).fixedSize(horizontal: false, vertical: true)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 18).padding(.vertical, 16)
    }
    .buttonStyle(OnboardOptionStyle(picked: picked))
    .onboardFocusRing()
    .accessibilityAddTraits(picked ? [.isSelected] : [])
  }
  private var sub: String {
    let p = model.place(name)
    if name == "docker" {
      let state = p.map { $0.available ? "Docker is running." : Self.sentence($0.reason ?? "Docker isn't running") } ?? "Docker is running."
      return "Each agent gets its own container. \(state)"
    }
    return p?.available == true ? "Each agent gets its own VM, so your Mac stays free."
                                : "Each agent gets its own VM, so your Mac stays free. Needs a boxd account."
  }
  static func sentence(_ s: String) -> String { s.hasSuffix(".") ? s : s + "." }
}

// MARK: Project

private struct ProjectScreen: View {
  let model: OnboardingModel
  var body: some View {
    _ = model.app.revision
    let repos = model.repos
    return VStack(alignment: .leading, spacing: 0) {
      ScreenTitle(text: "Pick a first project")
      Lede(text: Text(repos.isEmpty && model.reposLoaded ? "capcomd didn't find a Git repository in the usual folders. Choose one."
                                                          : "These are the Git repositories capcomd found on this Mac."))
        .padding(.top, 12).enter(1)
      let list = VStack(spacing: 8) {
        ForEach(Array(repos.prefix(RepoScan.maxFound).enumerated()), id: \.element.path) { i, r in RepoRow(model: model, repo: r).stagger(min(i, 4)) }
        Button { model.chooseFolder() } label: {
          Text("Choose another folder…").font(OnboardType.text(16)).foregroundStyle(OnboardColor.quiet)
            .padding(.horizontal, 18).padding(.vertical, 16)
        }
        .buttonStyle(OnboardOptionStyle(picked: false)).onboardFocusRing()
        .stagger(min(repos.count, 5))
      }
      .padding(4)
      // Up to four fit as they are (the prototype's three); more scroll.
      let fits = repos.count <= (model.setupScreen == nil ? 4 : 2)
      Group {
        if fits { list } else { ScrollView { list }.frame(height: model.setupScreen == nil ? 368 : 220) }
      }
      .padding(.top, 20).padding(.horizontal, -4)
      .accessibilityElement(children: .contain).accessibilityLabel("Projects")
      if let setup = model.setupScreen {
        InlineSetupSection(screen: setup, flow: model.app.setup, defaultKey: false, cardInset: 16,
                           onPrimary: { model.setupAction($0) }, onChooseAnother: { model.chooseFolder() },
                           onCancel: { model.app.cancelSetup() }, onLogIn: { TerminalLauncher.githubLogin() })
          .padding(.vertical, 12).padding(.horizontal, 16)
          .background(OnboardColor.card)
          .padding(.top, 12)
          .environment(\.colorScheme, .dark)
          .rise(0)
      }
      Text("Agents work on branches of their own. Nothing reaches your main branch unless you merge it.")
        .font(OnboardType.text(13)).foregroundStyle(OnboardColor.muted).padding(.top, 18).enter(3)
    }
    .frame(width: 680, alignment: .leading)
    .offset(x: 260, y: 104)
  }
}

private struct RepoRow: View {
  let model: OnboardingModel
  let repo: FoundRepo
  var body: some View {
    let picked = model.flow.project == repo.path
    Button { Task { await model.pick(repo.path) } } label: {
      HStack(spacing: 14) {
        OnboardGlyph(path: OnboardGlyphs.folder, size: 22, color: OnboardColor.secondary, stroke: 1.6)
        VStack(alignment: .leading, spacing: 3) {
          Text(verbatim: repo.name).font(OnboardType.text(16, 600)).foregroundStyle(OnboardColor.text)
          Text(verbatim: OnboardingModel.display(repo.path)).font(OnboardType.text(13)).foregroundStyle(OnboardColor.secondary).lineLimit(1).truncationMode(.middle)
        }
        Spacer(minLength: 8)
        if picked && model.projectChecking { ProgressView().controlSize(.small) }
        if let b = repo.branch {
          Text(verbatim: b).font(OnboardType.text(13, 500)).foregroundStyle(OnboardColor.lavender).lineLimit(1)
            .padding(.horizontal, 10).padding(.vertical, 5).background(OnboardColor.hex(0x9B6BFF, 0.14))
        }
      }
      .padding(.horizontal, 18).padding(.vertical, 14)
    }
    .buttonStyle(OnboardOptionStyle(picked: picked))
    .onboardFocusRing()
    .accessibilityLabel("\(repo.name), \(OnboardingModel.display(repo.path))\(repo.branch.map { ", on \($0)" } ?? "")")
    .accessibilityAddTraits(picked ? [.isSelected] : [])
  }
}

// MARK: Goal

private struct GoalScreen: View {
  let model: OnboardingModel
  @FocusState private var focused: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ScreenTitle(text: "What should your crew build first?")
      Lede(text: Text("Say it the way you'd tell a teammate. The planner splits it up and brings in the right team for ")
           + Text(verbatim: model.projectName).foregroundColor(OnboardColor.text) + Text("."))
        .padding(.top, 12).enter(1)
      TextField("", text: Binding(get: { model.flow.goal }, set: { model.setGoal($0) }), axis: .vertical)
        .textFieldStyle(.plain).font(OnboardType.text(19)).foregroundStyle(OnboardColor.text)
        .lineLimit(3...3).lineSpacing(19 * 0.5 - 5)
        .focused($focused)
        .onSubmit { model.primary() }
        .background(alignment: .topLeading) {
          if model.flow.goal.isEmpty {
            Text(verbatim: Launch.suggestions[0]).font(OnboardType.text(19)).foregroundStyle(OnboardColor.placeholder).allowsHitTesting(false)
          }
        }
        .padding(.horizontal, 20).padding(.vertical, 18)
        .frame(height: 132, alignment: .topLeading)
        .background(OnboardColor.card)
        .overlay(Rectangle().strokeBorder(focused ? OnboardColor.orange : Color.white.opacity(0.12), lineWidth: 1))
        .animation(.easeOut(duration: 0.18), value: focused)
        .padding(.top, 24).enter(2)
        .accessibilityLabel("What should your crew build first?")
      FlowRow(spacing: 8) {
        ForEach(Array(Launch.suggestions.enumerated()), id: \.offset) { i, s in
          Button(s) { model.setGoal(s); focused = true }.buttonStyle(OnboardChipStyle()).onboardFocusRing().stagger(i)
        }
      }
      .padding(.top, 14)
    }
    .frame(width: 720, alignment: .leading)
    .offset(x: 240, y: 112)
    .onAppear { focused = true }
  }
}

/// Chips that wrap onto the next line.
private struct FlowRow: Layout {
  var spacing: CGFloat
  func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
    let w = proposal.width ?? 720
    var x: CGFloat = 0, y: CGFloat = 0, line: CGFloat = 0
    for s in subviews {
      let z = s.sizeThatFits(.unspecified)
      if x > 0 && x + z.width > w { x = 0; y += line + spacing; line = 0 }
      x += z.width + spacing; line = max(line, z.height)
    }
    return CGSize(width: w, height: y + line)
  }
  func placeSubviews(in b: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
    var x = b.minX, y = b.minY, line: CGFloat = 0
    for s in subviews {
      let z = s.sizeThatFits(.unspecified)
      if x > b.minX && x + z.width > b.maxX { x = b.minX; y += line + spacing; line = 0 }
      s.place(at: CGPoint(x: x, y: y), proposal: .unspecified)
      x += z.width + spacing; line = max(line, z.height)
    }
  }
}

// MARK: Launch

/// The crew comes in (the prototype's launch()): the planner drops in, the circuit grows, the workers land as the run
/// has them, their statuses type themselves out. One clock (the screen's), so every piece is where it should be at
/// any moment; with Reduce Motion everything is where it ends.
private struct LaunchScreen: View {
  let model: OnboardingModel
  var body: some View {
    if let why = model.flow.launchFailure {
      VStack(spacing: 0) {
        ScreenTitle(text: "The crew couldn't start.")
        Lede(text: Text(verbatim: why)).multilineTextAlignment(.center).padding(.top, 10).frame(maxWidth: 560).enter(1)
        Button("Back") { model.launchBack() }.buttonStyle(OnboardGhostStyle()).onboardFocusRing().keyboardShortcut(.cancelAction).padding(.top, 22).enter(2)
      }
      .frame(width: 1200).offset(y: 300)
    } else {
      TimelineView(.animation(paused: model.reduceMotion)) { tl in
        let ms = model.reduceMotion ? 100_000 : Int(((model.launchStart.map { tl.date.timeIntervalSince($0) }) ?? 0) * 1000)
        LaunchStage(model: model, ms: ms, now: tl.date.timeIntervalSinceReferenceDate)
      }
    }
  }
}

private struct LaunchStage: View {
  let model: OnboardingModel
  let ms: Int
  let now: Double
  var body: some View {
    let workers = model.workers
    ZStack(alignment: .topLeading) {
      if Launch.showsPlanner(atMs: ms) {
        let p = progress(from: 250, 900)
        OnboardBot(colorway: .orange, mood: .smile, cell: 7).accessibilityHidden(true)
          .opacity(p).offset(x: 544, y: 92 - 32 * (1 - p))
        VStack(spacing: 6) {
          Text("Planner").font(OnboardType.text(16, 600)).foregroundStyle(OnboardColor.amber)
          HStack(spacing: 4) {
            Typed(text: model.planner?.status ?? "Planning…", from: 250 + 350, ms: ms)
            Rectangle().fill(OnboardColor.cyan).frame(width: 7, height: 13).opacity(ms / 500 % 2 == 0 ? 1 : 0)
          }
        }
        .frame(width: 300).opacity(p).offset(x: 450, y: 216 - 32 * (1 - p))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Planner, \(model.planner?.status ?? "planning")")
      }
      // The circuit: down from the planner, across, and down to each place (CSS steps(7) over 0.5 s).
      Dashes(vertical: true, color: OnboardColor.purple).frame(width: 4, height: 54)
        .scaleEffect(x: 1, y: stepped(from: 1000, 500, 7), anchor: .top).offset(x: 598, y: 266)
      ZStack(alignment: .leading) {
        Dashes(vertical: false, color: OnboardColor.purple).frame(width: 544, height: 4)
          .scaleEffect(x: stepped(from: 1300, 500, 7), y: 1, anchor: .center)
        if Launch.showsPackets(atMs: ms) {
          ForEach(0..<2, id: \.self) { k in
            let phase = (Double(ms - 2100) / 1800 + Double(k) * 0.5).truncatingRemainder(dividingBy: 1)
            Rectangle().fill(OnboardColor.cyan).frame(width: 4, height: 4).offset(x: (phase * 30).rounded(.down) / 30 * 544)
          }
        }
      }
      .frame(width: 544, height: 4, alignment: .leading).offset(x: 328, y: 320)
      ForEach(0..<3, id: \.self) { i in
        let cx = Launch.slots[i]
        Dashes(vertical: true, color: OnboardColor.purple).frame(width: 4, height: 44)
          .scaleEffect(x: 1, y: stepped(from: 1650, 500, 7), anchor: .top).offset(x: cx - 2, y: 320)
        if Launch.showsWorker(i, atMs: ms, workers: workers.count) {
          WorkerSlot(member: workers[i], index: i, cx: cx, appeared: model.arrival(i), ms: ms, now: now)
        } else if stepped(from: 1650, 500, 7) >= 1 {
          // Not here yet: the place it will land.
          Rectangle().strokeBorder(OnboardColor.node, lineWidth: 4).frame(width: 16, height: 16).offset(x: cx - 8, y: 364)
            .accessibilityHidden(true)
        }
      }
      if Launch.showsDone(atMs: ms) {
        VStack(spacing: 0) {
          ScreenTitle(text: "Your crew is on it.")
          Lede(text: Text("Each agent gets a column of its own. capcomd lets you know when something needs you.")).multilineTextAlignment(.center)
            .frame(maxWidth: 560).padding(.top, 10).enter(1)
          Button("Open capcomd") { model.open() }
            .buttonStyle(OnboardPrimaryStyle()).keyboardShortcut(.defaultAction).onboardFocusRing()
            .disabled(model.flow.runId == nil)
            .padding(.top, 22).enter(2)
        }
        .frame(width: 1200).offset(y: 566)
      }
    }
    .frame(width: 1200, height: 760, alignment: .topLeading)
  }

  /// Expo-out progress of an arrival that starts at `start` ms and lasts `d`.
  private func progress(from start: Int, _ d: Int) -> Double {
    model.reduceMotion ? 1 : Curve.expo.apply(Double(ms - start) / Double(d))
  }
  private func stepped(from start: Int, _ d: Int, _ n: Int) -> Double {
    model.reduceMotion ? 1 : Curve.steps(n).apply(Double(ms - start) / Double(d))
  }
}

private struct WorkerSlot: View {
  let member: OnboardingModel.CrewMember
  let index: Int
  let cx: Double
  let appeared: Int
  let ms: Int
  let now: Double
  var body: some View {
    let p = Curve.expo.apply(Double(ms - appeared) / 900)
    let color = Launch.slotColorways[index] == .orange ? OnboardColor.amber : OnboardColor.lilac
    Group {
      OnboardBot(colorway: Launch.slotColorways[index], mood: .smile, cell: 6, bobDelay: [0.6, 1.4, 2.1][index]).accessibilityHidden(true)
        .opacity(p).offset(x: cx - 48, y: 368 - 32 * (1 - p))
      VStack(spacing: 6) {
        Text(verbatim: member.name).font(OnboardType.text(16, 600)).foregroundStyle(color).lineLimit(1)
        Typed(text: member.status, from: appeared + 350, ms: ms)
      }
      .frame(width: 240).opacity(p).offset(x: cx - 120, y: 476 - 32 * (1 - p))
      .accessibilityElement(children: .ignore).accessibilityLabel("\(member.name), \(member.status)")
    }
  }
}

/// A status typing itself out (CSS steps(18) over 1.1 s).
private struct Typed: View {
  let text: String
  let from: Int
  let ms: Int
  var body: some View {
    let p = Curve.steps(18).apply(Double(ms - from) / 1100)
    Text(verbatim: text).font(OnboardType.text(13)).foregroundStyle(OnboardColor.quiet).lineLimit(1).fixedSize()
      .mask(alignment: .leading) { GeometryReader { g in Rectangle().frame(width: g.size.width * p) } }
  }
}

// MARK: All set

private struct AllSetScreen: View {
  let model: OnboardingModel
  var body: some View {
    VStack(spacing: 0) {
      OnboardBot(colorway: .orange, mood: .happy, cell: 10).accessibilityHidden(true).enter(0)
      ScreenTitle(text: "You're all set.").padding(.top, 36)
      Text("Start a run whenever you like: from this window, from the menu bar, or by asking your coding agent to use capcomd.")
        .font(OnboardType.text(19)).foregroundStyle(OnboardColor.soft).multilineTextAlignment(.center).lineSpacing(19 * 0.5 - 5)
        .frame(maxWidth: 540).fixedSize(horizontal: false, vertical: true).padding(.top, 14).enter(2)
      HStack(spacing: 12) {
        Button("Open capcomd") { model.open() }.buttonStyle(OnboardPrimaryStyle()).keyboardShortcut(.defaultAction).onboardFocusRing()
        Button("Give the crew a goal") { model.back() }.buttonStyle(OnboardLinkStyle()).onboardFocusRing()
      }
      .padding(.top, 30).enter(3)
    }
    .frame(width: 1200, height: 680)
    .offset(y: 40)
  }
}

// MARK: Footer

private struct Footer: View {
  let model: OnboardingModel
  var body: some View {
    let f = model.flow
    HStack(spacing: 12) {
      Button("Back") { model.back() }.buttonStyle(OnboardGhostStyle()).onboardFocusRing().disabled(!f.backEnabled)
      Spacer()
      if f.step.canSkip { Button("Skip for now") { model.skip() }.buttonStyle(OnboardLinkStyle()).onboardFocusRing() }
      if let p = f.primary {
        Button(p.label) { model.primary() }
          .buttonStyle(OnboardPrimaryStyle()).keyboardShortcut(.defaultAction).onboardFocusRing()
          .disabled(!f.primaryEnabled)
      }
    }
    .padding(.horizontal, 48).frame(width: 1200, height: 88)
    .offset(y: 760 - 88)
  }
}
#endif
