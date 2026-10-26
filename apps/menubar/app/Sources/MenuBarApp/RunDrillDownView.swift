#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §4.3: header (back, breadcrumb, current step, Activity · Trace switch, elapsed mono timer).
struct RunDrillDownView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String

  var body: some View {
    let run = model.run(runId)
    let steps = model.steps(runId)
    VStack(alignment: .leading, spacing: 10) {
      header(run: run, steps: steps)
      Group {
        switch model.drillView {
        case .activity: ActivityView(steps: steps)
        case .trace: AgentTreeView(runId: runId, compact: false)
        }
      }
      .transition(.opacity)
      ForEach(model.approvals(runId)) { ApprovalCard(approval: $0) }
      Spacer(minLength: 0)
    }
    .padding(Theme.inset)
    .navigationBarBackButtonHidden(true)
    .animation(reduceMotion ? .easeInOut(duration: 0.15) : .easeInOut(duration: 0.15), value: model.drillView)
  }

  @ViewBuilder private func header(run: Run?, steps: [Step]) -> some View {
    @Bindable var model = model
    HStack(spacing: 6) {
      Button { model.back() } label: { Image(systemName: "chevron.left") }
        .buttonStyle(.plain).keyboardShortcut("[", modifiers: .command).accessibilityLabel("Back")
      Text(verbatim: run?.title ?? runId).font(Theme.chip).foregroundStyle(.secondary).lineLimit(1)
      Spacer()
      // Text-only switch: selected white, other tertiary. Choice remembered globally via store prefs.
      HStack(spacing: 10) {
        switchButton("Activity", .activity, key: "1")
        switchButton("Trace", .trace, key: "2")
      }
      if let start = run?.startedAtMs {
        ElapsedTimer(startMs: start)
      }
    }
    if let current = steps.last(where: { $0.status == .running }) ?? steps.last {
      Text(verbatim: current.detail?.firstLine ?? current.text).font(Theme.panelTitle).lineLimit(2)
    }
  }

  private func switchButton(_ title: String, _ v: DrillView, key: KeyEquivalent) -> some View {
    Button { model.drillView = v } label: {
      Text(title).font(Theme.chip.weight(.medium)).foregroundStyle(model.drillView == v ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
    }
    .buttonStyle(.plain).keyboardShortcut(key, modifiers: .command)
    .accessibilityAddTraits(model.drillView == v ? .isSelected : [])
  }
}

struct ElapsedTimer: View {
  let startMs: Int
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let s = max(0, Int(ctx.date.timeIntervalSince1970) - startMs / 1000)
      Text(verbatim: String(format: "%d:%02d", s / 60, s % 60)).font(Theme.monoTime).foregroundStyle(.secondary)
    }
  }
}

/// Activity: 172 pt scroll region with phase labels, or one 30 pt row of icon cells when collapsed (remembered).
struct ActivityView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let steps: [Step]
  @State private var scrollTarget: String?

  var body: some View {
    ZStack(alignment: .topTrailing) {
      if model.activityCollapsed { strip } else { expanded }
    }
    .animation(.capcomd(reduceMotion, spring: 0.3), value: model.activityCollapsed)
  }

  private var grouped: [(Phase, [Step])] {
    Phase.allCases.compactMap { p in let s = steps.filter { $0.phase == p }; return s.isEmpty ? nil : (p, s) }
  }

  private var expanded: some View {
    ScrollViewReader { proxy in
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(grouped, id: \.0) { phase, rows in
            Text(phase.rawValue).font(Theme.caption).foregroundStyle(.tertiary).padding(.top, 6).padding(.bottom, 2)
            ForEach(rows) { s in ActivityRow(step: s).id(s.id) }
          }
        }
      }
      .frame(height: Theme.activityRegion)
      .onAppear { if let t = scrollTarget { proxy.scrollTo(t, anchor: .center) } }
    }
    .overlay(alignment: .topTrailing) { collapseButton(up: true) }
  }

  private var strip: some View {
    ScrollViewReader { proxy in
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 0) {
          ForEach(Array(grouped.enumerated()), id: \.element.0) { i, g in
            if i > 0 { Rectangle().fill(Theme.hairline).frame(width: 1, height: 12).padding(.horizontal, 4) }
            ForEach(g.1) { s in
              Button { scrollTarget = s.id; model.activityCollapsed = false } label: { StripCell(step: s) }
                .buttonStyle(.plain).id(s.id)
                .help(Text(verbatim: s.detail?.firstLine ?? s.text))    // tooltip: step text (plain)
            }
          }
          collapseButton(up: false)
        }
      }
      .frame(height: Theme.stripHeight)
      .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: 0.06)], startPoint: .leading, endPoint: .trailing))
      .onAppear { if let cur = steps.last(where: { $0.status == .running }) { proxy.scrollTo(cur.id, anchor: .trailing) } }
    }
  }

  private func collapseButton(up: Bool) -> some View {
    Button { model.activityCollapsed.toggle() } label: {
      Image(systemName: up ? "chevron.up" : "chevron.down").font(.system(size: 10)).foregroundStyle(.tertiary).frame(width: Theme.stripCell, height: Theme.stripCell)
    }
    .buttonStyle(.plain).keyboardShortcut("\\", modifiers: .command)
    .accessibilityLabel(up ? "Collapse timeline" : "Expand timeline")
  }
}

struct ActivityRow: View {
  let step: Step
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: step.kind.symbol).font(.system(size: 11))
        .foregroundStyle(Theme.color(step.status == .done ? .grey : step.status.tint)).frame(width: 14)
      Text(verbatim: step.detail.map { "\(step.text) · \($0.firstLine)" } ?? step.text)
        .font(Theme.activityFont).lineLimit(1)
        .foregroundStyle(step.status == .running ? AnyShapeStyle(.primary) : step.status == .queued ? AnyShapeStyle(.tertiary)
                         : step.status == .failed ? AnyShapeStyle(Theme.red) : AnyShapeStyle(.secondary))
      Spacer()
      StatusMark(status: step.status)
      Text(Date(timeIntervalSince1970: Double(step.epochMs) / 1000), style: .relative).font(Theme.monoTime).foregroundStyle(.tertiary)
    }
    .frame(height: Theme.activityRow)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(step.detail?.firstLine ?? step.text), \(String(describing: step.status))")
  }
}

struct StripCell: View {
  let step: Step
  var body: some View {
    let sym = step.status == .waiting ? "hand.raised" : step.kind.symbol
    Image(systemName: sym).font(.system(size: 11))
      .foregroundStyle(step.status == .done ? AnyShapeStyle(.tertiary) : AnyShapeStyle(Theme.color(step.status.tint)))
      .frame(width: Theme.stripCell, height: Theme.stripCell)
      .background(RoundedRectangle(cornerRadius: 5).fill(step.status == .running ? Theme.accentTint : .clear))
      .accessibilityLabel("\(step.detail?.firstLine ?? step.text), \(String(describing: step.status))")
  }
}
#endif
