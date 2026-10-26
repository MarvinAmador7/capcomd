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
        VStack(alignment: .leading, spacing: Theme.cardGap) {
          Text("Active").font(Theme.caption).foregroundStyle(.tertiary).padding(.top, 4)
          ForEach(model.projects) { p in
            if p.isRunning { ProjectCard(project: p) } else { FinishedRow(project: p) }
          }
          if model.projects.isEmpty {
            Text("No projects yet").font(Theme.body).foregroundStyle(.secondary).frame(maxWidth: .infinity).padding(.vertical, 24)
          }
        }
        .padding(Theme.inset)
      }
      .navigationDestination(for: AppModel.Route.self) { r in
        switch r {
        case .run(let id): RunDrillDownView(runId: id)
        case .thread(let runId, let agentId): ThreadView(runId: runId, agentId: agentId)
        }
      }
      .safeAreaInset(edge: .bottom) { footer }
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

/// Running project card: goal, scope chips, runs. No counts; state via amber tint, status marks, step bar.
struct ProjectCard: View {
  @Environment(AppModel.self) private var model
  let project: Project
  var body: some View {
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: project.title).font(Theme.cardTitle).lineLimit(2)   // untrusted goal: verbatim, never markdown
      HStack(spacing: 4) {
        Chip(text: project.id)                    // scope chip (prj-…/run-…); repo chips await G1
      }
      ForEach(project.runs) { run in
        let approvals = model.approvals(run.id)
        VStack(alignment: .leading, spacing: 6) {
          Button { model.open(run: run.id) } label: {
            HStack(spacing: 6) {
              Text(verbatim: run.label ?? run.id).font(Theme.chip.monospaced()).foregroundStyle(.secondary)
              Spacer()
              StatusMark(status: approvals.isEmpty ? (run.isRunning ? .running : nil) : .waiting)
            }
          }
          .buttonStyle(.plain)
          StepBar(steps: model.steps(run.id))
          AgentTreeView(runId: run.id, compact: true)
          ForEach(approvals) { ApprovalCard(approval: $0).padding(.leading, 20) }   // indented to the name column
        }
      }
    }
    .padding(Theme.cardPadding)
    .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.cardFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.cardRadius)
      .strokeBorder(project.runs.contains { !model.approvals($0.id).isEmpty } ? Theme.amber.opacity(0.35) : Theme.hairline, lineWidth: 0.5))
  }
}

/// Thin segmented bar, one segment per step, no numbers.
struct StepBar: View {
  let steps: [Step]
  var body: some View {
    HStack(spacing: 2) {
      ForEach(steps) { s in
        Capsule().fill(color(s.status)).frame(height: 3)
      }
    }
    .accessibilityHidden(true)
  }
  func color(_ s: StepStatus) -> Color {
    switch s { case .done: .secondary.opacity(0.5); case .running: Theme.accent; case .failed: Theme.red; case .waiting: Theme.amber; case .queued: .white.opacity(0.08) }
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
