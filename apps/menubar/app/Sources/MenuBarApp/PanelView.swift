#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// MenuBarExtra panel: project cards (SPEC §4.1). 380 pt wide on a HUD material.
struct PanelView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion

  var body: some View {
    @Bindable var model = model
    if model.needsToken {
      TokenPrompt(rejected: model.store.unauthorized)
        .frame(width: Theme.panelWidth).background(.ultraThinMaterial)
    } else {
    NavigationStack(path: $model.path) {
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          Text("Active").font(Theme.Card.sectionFont).foregroundStyle(Theme.Card.sectionText)
            .padding(.top, Theme.Card.sectionTop).padding(.leading, Theme.Card.sectionLeading).padding(.bottom, Theme.Card.sectionBottom)
          ForEach(model.projects) { p in
            Group {
              if p.isRunning { ProjectCard(project: p) } else { FinishedRow(project: p) }
            }
            .padding(.bottom, Theme.cardGap)
            .transition(.opacity)
          }
          if model.projects.isEmpty {
            Text("No projects yet").font(Theme.body).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 24)
          }
        }
        .padding(Theme.Card.listPadding)
        .animation(Theme.Motion.ease(reduceMotion), value: model.projects.map(\.id))
      }
      .safeAreaInset(edge: .bottom) { footer }
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
    .frame(width: Theme.panelWidth, height: 520)
    .background(.ultraThinMaterial)   // HUD-style vibrancy; MenuBarExtra(.window) supplies the 16 pt rounded window
    .animation(.capcomd(reduceMotion), value: model.path)
    }
  }

  private var footer: some View {
    HStack {
      Text("Open capcomd").font(Theme.chip).foregroundStyle(.secondary)
      Spacer()
      Text("Summon ⌥Space").font(Theme.chip).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, Theme.inset).padding(.vertical, 8)
    .overlay(alignment: .top) { Rectangle().fill(Theme.hairline).frame(height: 0.5) }
  }
}

/// Project card (tree-card-v3): the goal as title, scope chips, then each run's agent tree, grouped by project id.
/// No counts or progress text: state shows as the amber tint (an approval is waiting) and the tree's status marks.
/// Run ids stay in the drill-down.
struct ProjectCard: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let project: Project

  var body: some View {
    let needsApproval = project.runs.contains { !model.approvals($0.id).isEmpty }
    VStack(alignment: .leading, spacing: 0) {
      Button(action: open) { header }
        .buttonStyle(PressableStyle())
        .accessibilityLabel(project.title + (needsApproval ? ", waiting for approval" : ""))
        .accessibilityHint("Opens the run")
      VStack(alignment: .leading, spacing: 0) {
        ForEach(project.runs) { run in
          AgentTreeView(runId: run.id, compact: true)
          // Approvals sit under their waiting agent; one with no agent in the tree goes under the run's tree.
          let inTree = Set(model.tree(run.id).flatMap(\.subtreeIds))
          ForEach(model.approvals(run.id).filter { !inTree.contains($0.agentId ?? "") }) {
            ApprovalCard(approval: $0).padding(.leading, Theme.Tree.nameInset(0) + Theme.Approval.leadingExtra)
          }
        }
      }
      .padding(.top, Theme.Card.treeInnerTop)
      .overlay(alignment: .top) {
        Rectangle().fill(Theme.Card.divider).frame(height: Theme.Card.stroke).padding(.horizontal, -Theme.Card.treeBleed)
      }
      .padding(.top, Theme.Card.treeTop)
    }
    .padding(.top, Theme.Card.paddingTop).padding(.horizontal, Theme.Card.paddingHorizontal).padding(.bottom, Theme.Card.paddingBottom)
    .background {
      // The tint crossfades (opacity only) instead of animating the fill colour.
      let shape = RoundedRectangle(cornerRadius: Theme.cardRadius)
      ZStack {
        shape.fill(Theme.cardFill).opacity(needsApproval ? 0 : 1)
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
    if let run = project.runs.first(where: \.isRunning) ?? project.runs.first { model.open(run: run.id) }
  }
}

/// Finished project: one line, title + "Done" (tertiary). No counts.
struct FinishedRow: View {
  let project: Project
  var body: some View {
    HStack {
      Text(verbatim: project.title).font(Theme.body).lineLimit(1)
      Spacer()
      Text("Done").font(Theme.chip).foregroundStyle(.tertiary)
    }
    .padding(.horizontal, Theme.cardPadding).frame(height: 28)
  }
}
#endif
