#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// MenuBarExtra panel: project cards (SPEC §4.1). 380 pt wide on a HUD material.
struct PanelView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var listContent: CGFloat = 0
  @State private var footerHeight: CGFloat = 0

  /// The visible screen's content height, clamped to Theme.Panel and the screen.
  private var panelHeight: CGFloat {
    let ideal = model.path.isEmpty ? model.listHeight : model.routeHeight
    let screen = (NSScreen.main?.visibleFrame.height ?? 900) - Theme.Panel.screenMargin
    guard ideal > 0 else { return min(Theme.Panel.initialHeight, screen) }
    return min(max(ideal, Theme.Panel.minHeight), Theme.Panel.maxHeight, screen)
  }

  var body: some View {
    @Bindable var model = model
    if model.needsToken {
      TokenPrompt(rejected: model.store.unauthorized)
        .frame(width: Theme.panelWidth).background(.ultraThinMaterial)
    } else {
    NavigationStack(path: $model.path) {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          let projects = model.projects
          // A project whose run just completed stays up as its celebration for a moment, then drops to the finished rows.
          let active = projects.filter { $0.isActive || model.celebrating($0) != nil }
          let finished = Array(projects.filter { !$0.isActive && model.celebrating($0) == nil }.prefix(Theme.Finished.maxRows))
          StartProjectField().padding(.top, Theme.Composer.sectionTop)
          Text("Active").font(Theme.Card.sectionFont).foregroundStyle(Theme.Card.sectionText)
            .padding(.top, Theme.Card.sectionTop).padding(.leading, Theme.Card.sectionLeading).padding(.bottom, Theme.Card.sectionBottom)
          ForEach(active) { p in
            Group {
              if let r = model.celebrating(p) { CelebrationCard(project: p, run: r) } else { ProjectCard(project: p) }
            }
            .padding(.bottom, Theme.cardGap).transition(.opacity)
          }
          if active.isEmpty {
            VStack(spacing: 10) {
              PixelWordmark()   // Polish board, item 7
              Text(projects.isEmpty ? "No projects yet" : "Nothing running").font(Theme.Finished.titleFont).foregroundStyle(Theme.Finished.trailingText)
            }
            .frame(maxWidth: .infinity)
              .padding(.vertical, Theme.Finished.paddingVertical).padding(.horizontal, Theme.Finished.paddingHorizontal)
          }
          // Finished and failed projects leave the Active cards: the latest few stay as one-line rows.
          ForEach(finished) { p in FinishedRow(project: p).transition(.opacity) }
        }
        .padding(Theme.Card.listPadding)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listContent = $0; model.listHeight = listContent + footerHeight }
        .animation(Theme.Motion.ease(reduceMotion), value: model.projects.map { "\($0.id)\($0.isActive)\(model.celebrating($0) != nil)" })
      }
      .safeAreaInset(edge: .bottom) {
        footer.onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footerHeight = $0; model.listHeight = listContent + footerHeight }
      }
      // macOS keeps the root under a pushed view, and pushed views are clear (a material would only blur the list
      // behind it), so the list steps out entirely while anything is pushed.
      .opacity(model.path.isEmpty ? 1 : 0)
      .allowsHitTesting(model.path.isEmpty)
      .accessibilityHidden(!model.path.isEmpty)
      .navigationDestination(for: AppModel.Route.self) { r in
        switch r {
        case .run(let id): RunDrillDownView(runId: id)
        case .thread(let runId, let agentId): ThreadView(runId: runId, agentId: agentId)
        }
      }
    }
    .frame(width: Theme.panelWidth, height: panelHeight)
    .transaction(value: panelHeight) { $0.animation = nil }   // layout changes snap (SPEC §7); only content fades
    // MenuBarExtra(.window) sizes its window once; resize it ourselves, top edge pinned under the menu bar.
    .background(PanelWindowSizer(height: panelHeight))
    .background { if reduceTransparency { Theme.Craft.solidPanel } else { Rectangle().fill(.ultraThinMaterial) } }   // HUD vibrancy; solid with Reduce Transparency
    .animation(Theme.Motion.push(reduceMotion), value: model.path)   // keyboard back (⌘[) runs in a no-animation transaction
    }
  }

  /// v5-a-final `.ft`: a `.bar` material under a hairline, so cards scrolling beneath blur instead of showing through.
  private var footer: some View {
    HStack(spacing: 0) {
      Text("Open capcomd").font(Theme.Footer.font).foregroundStyle(Theme.Footer.text)
      Spacer(minLength: 0)
      (Text("Summon ").font(Theme.Footer.font) + Text(verbatim: "⌥Space").font(Theme.Footer.monoFont))
        .foregroundStyle(Theme.Footer.hintText)
        .accessibilityLabel("Summon with Option Space")
    }
    .padding(.horizontal, Theme.Footer.paddingHorizontal).padding(.vertical, Theme.Footer.paddingVertical)
    .frame(maxWidth: .infinity)
    .background(ControlSurface(shape: Rectangle(), fallback: Theme.Footer.material))
    .overlay(alignment: .top) { DitherLine() }   // Polish board, item 5
  }
}

/// Project card (tree-card-v3): the goal as title, scope chips, then each run's agent tree, grouped by project id.
/// No counts or progress text: state shows as the amber tint (an approval is waiting) and the tree's status marks.
/// Run ids stay in the drill-down.
struct ProjectCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.colorSchemeContrast) private var contrast
  let project: Project

  var body: some View {
    let needsApproval = project.runs.contains { !model.approvals($0.id).isEmpty }
    VStack(alignment: .leading, spacing: 0) {
      Button(action: open) { header }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(project.title + (needsApproval ? ", waiting for approval" : ""))
        .accessibilityHint("Opens the run")
      VStack(alignment: .leading, spacing: 0) {
        ForEach(project.activeRuns) { run in   // finished and failed runs leave the card
          if model.meeting(project)?.id == run.id { MeetTeamView(runId: run.id).transition(.opacity) } else { AgentTreeView(runId: run.id, compact: true) }
          // Approvals sit under their waiting agent; one with no agent in the tree goes under the run's tree.
          let inTree = Set(model.tree(run.id).flatMap(\.subtreeIds))
          ForEach(model.approvals(run.id).filter { !inTree.contains($0.agentId ?? "") }) {
            ApprovalCard(approval: $0).padding(.leading, Theme.Tree.nameInset(0) + Theme.Approval.leadingExtra)
          }
        }
      }
      .padding(.top, Theme.Card.treeInnerTop)   // no hairline above the tree: the chips lead straight into it
      .padding(.top, Theme.Card.treeTop)
    }
    .padding(.top, Theme.Card.paddingTop).padding(.horizontal, Theme.Card.paddingHorizontal).padding(.bottom, Theme.Card.paddingBottom)
    .background {
      // The tint crossfades (opacity only) instead of animating the fill colour.
      let shape = RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous)
      ZStack {
        shape.fill(Theme.cardFill).opacity(needsApproval ? 0 : 1)
          .overlay(shape.strokeBorder(Theme.Craft.contrastStroke, lineWidth: Theme.Craft.contrastStrokeWidth).opacity(contrast == .increased && !needsApproval ? 1 : 0))
        shape.fill(Theme.Card.approvalFill)
          .overlay(shape.strokeBorder(Theme.Card.approvalStroke, lineWidth: Theme.Card.stroke))
          .opacity(needsApproval ? 1 : 0)
      }
      .animation(Theme.Motion.ease(reduceMotion), value: needsApproval)
    }
  }

  private var header: some View {
    let scopes = project.scopes
    return VStack(alignment: .leading, spacing: 0) {
      Text(verbatim: project.title)   // untrusted goal: verbatim, never markdown
        .font(Theme.Card.titleFont).tracking(Theme.Card.titleTracking).foregroundStyle(Theme.Card.titleText)
        .lineLimit(2).multilineTextAlignment(.leading)
      if !scopes.isEmpty {
        HStack(spacing: Theme.Card.chipGap) {
          ForEach(scopes.prefix(Theme.Card.maxChips), id: \.self) { ScopeChip(text: $0) }
          if scopes.count > Theme.Card.maxChips { ScopeChip(text: "+\(scopes.count - Theme.Card.maxChips)", folder: false) }
        }
        .padding(.top, Theme.Card.chipsTop)
      }
    }
    .frame(maxWidth: .infinity, alignment: .leading)
  }

  /// Opens the run that is doing something now, else the most recent one.
  private func open() {
    if let run = project.activeRuns.first ?? project.runs.first { model.open(run: run.id) }
  }
}

/// Finished project (v5-a-final `.done`): its goal, then how its latest run ended and how long it took, and its folders
/// ("Done in 4m · 3 repos"). Click opens that run.
struct FinishedRow: View {
  @Environment(AppModel.self) private var model
  let project: Project
  var body: some View {
    let line = project.endedLine ?? "Done"
    Button {
      if let run = project.latestRun { model.open(run: run.id) }
    } label: {
      HStack(spacing: Theme.Finished.gap) {
        Text(verbatim: project.title)   // untrusted goal: verbatim, never markdown
          .font(Theme.Finished.titleFont).foregroundStyle(Theme.Finished.titleText).lineLimit(1).truncationMode(.tail)
          .padding(.leading, Theme.Finished.titleIndent)
        Spacer(minLength: 0)
        FinishSparkle(endedAtMs: project.latestRun?.lastEventMs)
        Text(verbatim: line).font(Theme.Finished.trailingFont).foregroundStyle(Theme.Finished.trailingText)
          .lineLimit(1).fixedSize()
      }
      .padding(.vertical, Theme.Finished.paddingVertical).padding(.horizontal, Theme.Finished.paddingHorizontal)
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel("\(project.title), \(spoken(line))")
    .accessibilityHint("Opens the run")
  }

  /// "Done in 4m · 3 repos" → "Done in 4 minutes, 3 repos" for VoiceOver.
  private func spoken(_ line: String) -> String {
    var s = line.replacingOccurrences(of: " · ", with: ", ")
    if let ms = project.endedDurationMs {
      let f = DateComponentsFormatter(); f.unitsStyle = .full; f.allowedUnits = [.day, .hour, .minute, .second]; f.maximumUnitCount = 2
      if let full = f.string(from: Double(ms) / 1000) { s = s.replacingOccurrences(of: shortDuration(ms: ms), with: full) }
    }
    return s
  }
}
#endif

#if canImport(SwiftUI) && os(macOS)
/// Keeps the MenuBarExtra window as tall as the panel's content: the window keeps its top edge (under the status
/// item) and grows or shrinks downward, without animation (SPEC §7: layout changes snap).
struct PanelWindowSizer: NSViewRepresentable {
  let height: CGFloat
  func makeNSView(context: Context) -> NSView { NSView() }
  func updateNSView(_ view: NSView, context: Context) {
    let h = height
    DispatchQueue.main.async {
      guard let window = view.window else { return }
      let content = window.contentRect(forFrameRect: window.frame)
      guard abs(content.height - h) > 0.5 else { return }
      var frame = window.frameRect(forContentRect: NSRect(x: content.minX, y: content.maxY - h, width: content.width, height: h))
      frame.origin.y = window.frame.maxY - frame.height   // pin the top
      window.setFrame(frame, display: true, animate: false)
    }
  }
}
#endif
