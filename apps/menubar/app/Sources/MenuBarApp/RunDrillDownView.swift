#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot

/// SPEC §4.3 run drill-down (view-activity / view-trace / drill-collapsed / drill-a2-*): header, step bar, Activity or
/// Trace (remembered), Log | Files (remembered), then Pause · Stop · Open in terminal. Clicks animate; the same changes
/// from the keyboard (⌘1/⌘2, ⌘\, ⌘[) don't.
struct RunDrillDownView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  @State private var content: CGFloat = 0
  @State private var footer: CGFloat = 0

  var body: some View {
    let steps = model.steps(runId)
    VStack(alignment: .leading, spacing: 0) {
      DrillHeader(runId: runId, steps: steps)
      StepBar(steps: steps).padding(Theme.Drill.barPadding)
      Group {
        switch model.drillView {
        case .activity: ActivityView(runId: runId, steps: steps)
        case .trace: TraceView(runId: runId)
        }
      }
      .transition(.opacity)
      ForEach(model.approvals(runId)) { ApprovalCard(approval: $0) }
      DetailPane(runId: runId)
    }
    .padding([.top, .horizontal], Theme.Drill.padding)
    // Natural height (every region has a fixed height) plus the footer: the panel sizes to it.
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { content = $0; if model.path.last == .run(runId) { model.routeHeight = content + footer } }
    .frame(maxHeight: .infinity, alignment: .top)
    .safeAreaInset(edge: .bottom, spacing: 0) {
      DrillFooter(runId: runId).onGeometryChange(for: CGFloat.self) { $0.size.height } action: { footer = $0; if model.path.last == .run(runId) { model.routeHeight = content + footer } }
    }
    .navigationBarBackButtonHidden(true)
    .hiddenUnlessTop(.run(runId))
    .onChange(of: model.path.last == .run(runId)) { _, top in if top { model.routeHeight = content + footer } }   // back on top: its height again
    // Refresh the REST parts on screen; a change of view or tab refreshes at once.
    .task(id: "\(runId)|\(model.drillView.rawValue)|\(model.detailTab.rawValue)") {
      while !Task.isCancelled {
        let log = model.detailTab == .log ? model.focusAgent(runId)?.id : nil
        await model.refreshDetail(runId, trace: model.drillView == .trace, files: model.detailTab == .files, logAgent: log)
        try? await Task.sleep(for: .seconds(Theme.Drill.refreshSeconds))
      }
    }
  }
}

// MARK: header

struct DrillHeader: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  let steps: [Step]

  var body: some View {
    let run = model.run(runId)
    let current = steps.last(where: { $0.status == .running }) ?? steps.last(where: { $0.status == .waiting }) ?? steps.last
    HStack(spacing: Theme.Drill.headerGap) {
      Button { model.back() } label: {
        Image(systemName: "chevron.left").font(Theme.Drill.backIcon).foregroundStyle(Theme.Drill.switchOn)
          .frame(width: Theme.Drill.backSize, height: Theme.Drill.backSize)
          .background(ControlSurface(shape: Circle(), fallback: Theme.Drill.backFill))
      }
      .buttonStyle(PressableStyle()).accessibilityLabel("Back")
      .background { keyboardOnly("[") { withTransaction(Transaction(animation: nil)) { model.back() } } }
      VStack(alignment: .leading, spacing: Theme.Drill.titleTop) {
        Text(verbatim: run?.title ?? runId).font(Theme.Drill.crumbFont).foregroundStyle(Theme.Drill.crumbText).lineLimit(1)
        // An ended run is titled by how it ended, not by its last step ("Edited a file" said little); a run with no step
        // yet by that, not by its goal again (the line above is the goal).
        RedactableText(text: UntrustedText(run?.endedHead ?? current?.text ?? (run == nil ? runId : "Starting…")))
          .font(Theme.Drill.titleFont).tracking(Theme.Drill.titleTracking).foregroundStyle(Theme.Drill.switchOn).lineLimit(1)
      }
      Spacer(minLength: 0)
      HStack(spacing: Theme.Drill.switchGap) {
        switchButton("Activity", .activity, key: "1")
        Text(verbatim: "·").font(Theme.Drill.switchFont).foregroundStyle(Theme.Drill.switchOff).accessibilityHidden(true)
        switchButton("Trace", .trace, key: "2")
      }
      .padding(.trailing, Theme.Drill.switchTrailing)
      ElapsedTimer(run: run)
    }
    .padding(Theme.Drill.headerPadding)
  }

  /// Text-only switch: selected white, other tertiary; remembered globally (store prefs).
  private func switchButton(_ title: String, _ v: DrillView, key: KeyEquivalent) -> some View {
    Button { withAnimation(Theme.Motion.ease(reduceMotion)) { model.drillView = v } } label: {
      Text(title).font(Theme.Drill.switchFont).foregroundStyle(model.drillView == v ? Theme.Drill.switchOn : Theme.Drill.switchOff)
    }
    .buttonStyle(.plain)
    .background { keyboardOnly(key) { model.drillView = v } }
    .accessibilityAddTraits(model.drillView == v ? .isSelected : [])
  }
}

/// A zero-size button that only answers a ⌘-shortcut, so the keyboard path can skip the click's animation.
@ViewBuilder func keyboardOnly(_ key: KeyEquivalent, _ action: @escaping () -> Void) -> some View {
  Button(action: action) { EmptyView() }.keyboardShortcut(key, modifiers: .command).opacity(0).frame(width: 0, height: 0)
    .accessibilityHidden(true)
}

/// Elapsed mono timer: ticks while the run is active, frozen at its duration once it ended.
struct ElapsedTimer: View {
  let run: Run?
  var body: some View {
    if let start = run?.startedAtMs {
      TimelineView(.periodic(from: .now, by: 1)) { ctx in
        let end = run.flatMap { $0.isActive ? nil : $0.endedAtMs } ?? Int(ctx.date.timeIntervalSince1970 * 1000)
        Text(verbatim: clockDuration(ms: end - start)).font(Theme.Drill.timerFont).foregroundStyle(Theme.Drill.timerText)
          .monospacedDigit()
      }
      .accessibilityLabel("Elapsed")
    }
  }
}

/// One segment per step, no numbers: done blue, current dimmed blue, upcoming grey; amber waits, red failures.
struct StepBar: View {
  let steps: [Step]
  var body: some View {
    HStack(spacing: Theme.Drill.barGap) {
      ForEach(steps) { s in RoundedRectangle(cornerRadius: Theme.Drill.barRadius, style: .continuous).fill(color(s.status)).frame(height: Theme.Drill.barHeight) }
    }
    .accessibilityHidden(true)
  }
  func color(_ s: StepStatus) -> Color {
    switch s { case .done: Theme.Drill.barDone; case .running: Theme.Drill.barCurrent; case .failed: Theme.red; case .waiting: Theme.amber; case .queued, .paused, .stopped: Theme.Drill.barQueued }
  }
}

// MARK: activity

/// Step icon: the activity's glyph, or the agent's profile icon for an agent step with no activity yet.
struct StepIcon: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let step: Step
  var body: some View {
    let tint: Color = switch step.status {
      case .running: Theme.accent; case .failed: Theme.red; case .waiting: Theme.amber; case .queued, .paused, .stopped: Theme.Drill.rowQueued; case .done: Theme.Drill.iconText
    }
    let profile = step.agentId.flatMap { model.run(runId)?.agents[$0]?.kind }
    Group {
      // Who did it leads the row: the agent's bot ("[bot] Ran the tests"), for its own steps and for the verify, merge and
      // approval of its work, as in Trace rows (SPEC: bots replace the profile icons). Steps of the run itself keep
      // their event icon.
      if let id = step.agentId, let bot = model.bot(runId: runId, agentId: id) { BotAvatar(traits: bot, size: .xs) }
      else if step.status == .waiting { Image(systemName: "hand.raised") }
      else if step.kind == .agent, let k = profile { ZStack { Image(systemName: k.symbol); if k.hasCentreDot { Circle().frame(width: 3, height: 3) } } }
      else { Image(systemName: step.kind.symbol) }
    }
    .font(Theme.Drill.iconFont).foregroundStyle(tint)
    .accessibilityHidden(true)
  }
}

/// Activity: phase-grouped 18 pt rows in a 172 pt region, or one 30 pt strip of icon cells when collapsed (remembered).
struct ActivityView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  let steps: [Step]
  @State private var focus: String?

  var body: some View {
    Group {
      if model.activityCollapsed { strip.transition(.opacity.combined(with: .offset(y: reduceMotion ? 0 : -4))) }
      else { expanded.transition(.opacity) }
    }
    .background { keyboardOnly("\\") { model.activityCollapsed.toggle() } }
  }

  private var grouped: [(Phase, [Step])] {
    Phase.allCases.compactMap { p in let s = steps.filter { $0.phase == p }; return s.isEmpty ? nil : (p, s) }
  }

  private func setCollapsed(_ c: Bool) { withAnimation(Theme.Motion.ease(reduceMotion)) { model.activityCollapsed = c } }

  private var expanded: some View {
    ScrollViewReader { proxy in
      ScrollView(showsIndicators: false) {
        VStack(alignment: .leading, spacing: 0) {
          if steps.isEmpty {
            Text("Nothing has happened yet.").font(Theme.Drill.emptyFont).foregroundStyle(Theme.Drill.emptyText)
              .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Theme.Drill.rowPadding).frame(height: Theme.Drill.spanHeight)
          }
          ForEach(grouped, id: \.0) { phase, rows in
            Text(phase.rawValue).font(Theme.Drill.phaseFont).foregroundStyle(Theme.Drill.phaseText)
              .frame(height: Theme.Drill.phaseHeight).padding(.horizontal, Theme.Drill.rowPadding)
            ForEach(rows) { s in ActivityRow(runId: runId, step: s).id(s.id) }
          }
        }
      }
      .frame(height: Theme.Drill.regionHeight)
      .onAppear {
        if let f = focus { proxy.scrollTo(f, anchor: .center); focus = nil }
        else if let cur = steps.last(where: { $0.status == .running }) { proxy.scrollTo(cur.id, anchor: .center) }
      }
    }
    .overlay(alignment: .topTrailing) {
      chevron(up: true).frame(height: Theme.Drill.phaseHeight)
    }
    .padding(.top, Theme.Drill.regionTop)
  }

  private var strip: some View {
    HStack(spacing: 0) {
      ScrollViewReader { proxy in
        ScrollView(.horizontal, showsIndicators: false) {
          HStack(spacing: Theme.Drill.cellGap) {
            ForEach(Array(grouped.enumerated()), id: \.element.0) { i, g in
              if i > 0 {
                Rectangle().fill(Theme.Drill.divider).frame(width: Theme.Drill.dividerWidth, height: Theme.Drill.dividerHeight)
                  .padding(.horizontal, Theme.Drill.dividerMargin)
              }
              ForEach(g.1) { s in
                Button { focus = s.id; setCollapsed(false) } label: { StripCell(runId: runId, step: s) }
                  .buttonStyle(PressableStyle()).id(s.id)
                  .help(Text(verbatim: "\(s.text) · \(relativeAgo(ms: s.epochMs, nowMs: nowMs))"))
              }
            }
          }
          .padding(.horizontal, Theme.Drill.stripPadding)
        }
        .onAppear { if let cur = steps.last(where: { $0.status == .running || $0.status == .waiting }) { proxy.scrollTo(cur.id, anchor: .trailing) } }
      }
      .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: Theme.Drill.edgeFade / 300)],
                           startPoint: .leading, endPoint: .trailing))
      chevron(up: false)
        .frame(width: Theme.Drill.chevronColumn, height: Theme.Drill.stripHeight)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.Drill.chevronDivider).frame(width: 0.5) }
    }
    .frame(height: Theme.Drill.stripHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Drill.stripRadius, style: .continuous).fill(Theme.Drill.stripFill))
    .clipShape(RoundedRectangle(cornerRadius: Theme.Drill.stripRadius, style: .continuous))
    .padding(.top, Theme.Drill.stripTop)
  }

  private var nowMs: Int { Int(Date().timeIntervalSince1970 * 1000) }

  private func chevron(up: Bool) -> some View {
    Button { setCollapsed(up) } label: {
      Image(systemName: up ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.Drill.iconText)
        .frame(width: Theme.Drill.cell, height: Theme.Drill.cell).contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(up ? "Collapse timeline" : "Expand timeline")
  }
}

/// `.ar`: icon · text · relative time (+ status). Finished steps show no status mark. A row of an agent opens its
/// thread: once a run has ended its card is gone, and this is the way back to what each agent said.
struct ActivityRow: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let step: Step
  var body: some View {
    if let id = step.agentId, model.run(runId)?.agents[id] != nil {
      Button { model.path.append(.thread(runId: runId, agentId: id)) } label: { row.contentShape(Rectangle()) }
        .buttonStyle(PressableStyle())
        .accessibilityHint("Opens its thread")
    } else {
      row
    }
  }

  @ViewBuilder private var row: some View {
    let color: Color = switch step.status {
      case .running: Theme.Drill.switchOn; case .queued: Theme.Drill.rowQueued; case .failed: Theme.Drill.rowFailed; default: Theme.Drill.rowText
    }
    HStack(spacing: Theme.Drill.rowGap) {
      StepIcon(runId: runId, step: step).frame(width: Theme.Drill.iconColumn)
      RedactableText(text: UntrustedText(step.text))
        .font(step.status == .running ? Theme.Drill.rowNowFont : Theme.Drill.rowFont).foregroundStyle(color).lineLimit(1)
      Spacer(minLength: 0)
      HStack(spacing: Theme.Drill.timeGap) {
        if step.status != .queued {
          TimelineView(.periodic(from: .now, by: 30)) { ctx in
            Text(verbatim: step.status == .running ? "now" : relativeAgo(ms: step.epochMs, nowMs: Int(ctx.date.timeIntervalSince1970 * 1000)))
              .font(Theme.Drill.timeFont).foregroundStyle(step.status == .running ? Theme.Drill.switchOn : Theme.Drill.timeText)
              .frame(minWidth: Theme.Drill.timeColumn, alignment: .trailing)
          }
        }
        StatusMark(status: step.status == .done ? nil : step.status)
      }
    }
    .frame(height: Theme.Drill.rowHeight)
    .padding(.horizontal, Theme.Drill.rowPadding)
    .help(who.map { a in [model.botName(runId: runId, agentId: a.id), a.displayName].compactMap { $0 }.joined(separator: " · ") } ?? "")
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("\(who.map { "\($0.displayName): " } ?? "")\(step.text), \(String(describing: step.status))")
  }

  /// The agent that did this step (or whose work it was: verify, merge, approval), if the run knows it; its bot leads
  /// the row, and its name and role are the tooltip.
  private var who: Agent? { step.agentId.flatMap { model.run(runId)?.agents[$0] } }
}

/// `.si2`: a 24 pt icon cell; the current step on a faint blue tile, an approval amber, finished muted.
struct StripCell: View {
  let runId: String
  let step: Step
  @State private var hover = false
  var body: some View {
    StepIcon(runId: runId, step: step)
      .frame(width: Theme.Drill.cell, height: Theme.Drill.cell)
      .background(RoundedRectangle(cornerRadius: Theme.Drill.cellRadius, style: .continuous)
        .fill(step.status == .running ? Theme.Drill.cellNow : hover ? Theme.Drill.cellHover : .clear))
      .onHover { hover = $0 }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel("\(step.text), \(String(describing: step.status))")
  }
}

// MARK: trace

/// Trace: the run's spans as an outline with timing lanes, newest at the bottom. Follows live; scrolling away shows a
/// blue "Jump to now" pill.
struct TraceView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  @State private var collapsed: Set<String> = []
  @State private var following = true
  @State private var viewport: CGFloat = 0

  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { ctx in
      let rows = model.traceRows(runId, nowMs: Int(ctx.date.timeIntervalSince1970 * 1000), collapsed: collapsed)
      ScrollViewReader { proxy in
        ScrollView(showsIndicators: false) {
          VStack(spacing: 0) {
            if rows.isEmpty { emptyState }
            ForEach(rows) { r in SpanRow(runId: runId, row: r, collapsed: collapsed.contains(r.id)) { toggle(r.id) }.id(r.id) }
            // Bottom sentinel: while it sits inside the viewport, the view is following.
            Color.clear.frame(height: 1).id("end")
              .background(GeometryReader { g in Color.clear.preference(key: TraceBottomKey.self, value: g.frame(in: .named("trace")).maxY) })
          }
        }
        .coordinateSpace(name: "trace")
        .defaultScrollAnchor(.bottom)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { viewport = $0 }
        // Until the viewport is measured, assume the view follows (no pill on first layout).
        .onPreferenceChange(TraceBottomKey.self) { bottom in following = viewport == 0 || bottom <= viewport + 4 }
        .onChange(of: rows.count) { if following { proxy.scrollTo("end", anchor: .bottom) } }
        .overlay(alignment: .bottom) {
          if !following {
            Button { withAnimation(Theme.Motion.ease(reduceMotion)) { proxy.scrollTo("end", anchor: .bottom) } } label: {
              Label("Jump to now", systemImage: "arrow.down").font(Theme.Drill.pillFont).foregroundStyle(Theme.Drill.switchOn)
                .padding(Theme.Drill.pillPadding).frame(height: Theme.Drill.pillHeight)
                .background(Capsule().fill(Theme.accent))
                .shadow(color: .black.opacity(0.35), radius: 6, y: 4)
            }
            .buttonStyle(PressableStyle())
            .padding(.bottom, Theme.Drill.pillBottom)
            .transition(.opacity)
          }
        }
      }
    }
    .frame(height: Theme.Drill.regionHeight)
    .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: Theme.Drill.traceFade / Theme.Drill.regionHeight)],
                         startPoint: .top, endPoint: .bottom))
    .padding(.top, Theme.Drill.traceTop)
    .animation(Theme.Motion.fast, value: following)
  }

  @ViewBuilder private var emptyState: some View {
    let text: String = switch model.traceState(runId) {
      case .unavailable(.unsupported): "This capcomd doesn't serve traces."
      case .unavailable: "Couldn't load the trace."
      case .loaded: "Nothing traced yet."
      default: "Loading the trace…"
    }
    Text(text).font(Theme.Drill.emptyFont).foregroundStyle(Theme.Drill.emptyText)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Theme.Drill.rowPadding).frame(height: Theme.Drill.spanHeight)
  }

  private func toggle(_ id: String) {
    withAnimation(Theme.Motion.ease(reduceMotion)) { if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) } }
  }
}

private struct TraceBottomKey: PreferenceKey {
  static let defaultValue: CGFloat = 0
  static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// `.sp`: icon · (fold) name · lane · duration (+ status). Current row white with a ringed blue lane; failures red;
/// queued dashed with "–".
struct SpanRow: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let row: TraceRow
  let collapsed: Bool
  let onToggle: () -> Void

  var body: some View {
    let now = row.status == .running
    let color: Color = row.status == .failed ? Theme.red : now ? Theme.Drill.switchOn : Theme.Drill.spanText
    HStack(spacing: Theme.Drill.spanGap) {
      icon.frame(width: Theme.Drill.iconColumn)
      HStack(spacing: 0) {
        if row.hasChildren {
          Button(action: onToggle) {
            Text(verbatim: collapsed ? "▸" : "▾").font(Theme.Drill.foldFont)
              .opacity(collapsed ? Theme.Drill.foldOpacity : Theme.Drill.foldOpenOpacity)
          }
          .buttonStyle(.plain).padding(.trailing, Theme.Drill.foldTrailing)
          .accessibilityLabel(collapsed ? "Expand \(row.label)" : "Collapse \(row.label)")
        }
        Text(verbatim: row.label).lineLimit(1).truncationMode(.tail)   // daemon/span names, never markdown
      }
      .font(Theme.Drill.rowFont).foregroundStyle(color)
      .padding(.leading, CGFloat(row.depth) * Theme.Drill.spanIndent)
      .frame(width: Theme.Drill.nameColumn, alignment: .leading)
      lane
      HStack(spacing: Theme.Drill.timeGap) {
        Text(verbatim: row.status == .queued ? "–" : clockDuration(ms: row.durationMs ?? (Int(Date().timeIntervalSince1970 * 1000) - row.startMs)))
          .font(Theme.Drill.durationFont).foregroundStyle(row.status == .failed ? Theme.red : now ? Theme.Drill.durationNow : Theme.Drill.durationText)
        StatusMark(status: row.status == .done ? nil : row.status)
      }
      .frame(width: Theme.Drill.durationColumn, alignment: .trailing)
    }
    .frame(height: Theme.Drill.spanHeight)
    .padding(.horizontal, Theme.Drill.rowPadding)
    .accessibilityElement(children: .combine)
  }

  @ViewBuilder private var icon: some View {
    let tint: Color = row.status == .failed ? Theme.red : row.status == .running ? Theme.accent : Theme.Drill.iconText
    let agentId = row.id.hasPrefix("pending:agent:") ? String(row.id.dropFirst("pending:agent:".count)) : nil
    if row.kind == .agent, let id = agentId, model.run(runId)?.agents[id] != nil {
      BotAvatar(traits: model.bot(runId: runId, agentId: id), size: .xs).help(model.botName(runId: runId, agentId: id) ?? "")
    } else {
      Image(systemName: row.kind.symbol).font(Theme.Drill.iconFont).foregroundStyle(tint).accessibilityHidden(true)
    }
  }

  private var lane: some View {
    GeometryReader { g in
      let x = g.size.width * row.laneStart
      let w = max(Theme.Drill.laneMin, g.size.width * row.laneWidth)
      let shape = Capsule()
      Group {
        switch row.status {
        case .queued:
          shape.strokeBorder(Theme.Drill.laneFill, style: StrokeStyle(lineWidth: 0.5, dash: [2, 2])).frame(width: max(w, 16))
        case .running:
          shape.fill(Theme.accent).frame(width: w)
            .overlay(shape.stroke(Theme.Drill.laneRing, lineWidth: Theme.Drill.laneRingWidth))
        case .failed: shape.fill(Theme.red).frame(width: w)
        default: shape.fill(Theme.Drill.laneFill).frame(width: w)
        }
      }
      .frame(height: Theme.Drill.laneHeight)
      .offset(x: min(x, g.size.width - w), y: (g.size.height - Theme.Drill.laneHeight) / 2)
    }
    .frame(height: Theme.Drill.spanHeight)
    .accessibilityHidden(true)
  }
}

// MARK: log | files

/// Log | Files: one at a time (remembered). Log tails the agent the run is following; Files lists what the run changed.
struct DetailPane: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      segmented
      Group {
        switch model.detailTab {
        case .log: log
        case .files: files
        }
      }
      .transition(.opacity)
    }
  }

  private var segmented: some View {
    HStack(spacing: 0) {
      seg("Log", .log); seg("Files", .files)
    }
    .padding(Theme.Drill.segInset)
    .frame(width: Theme.Drill.segWidth)
    .background(RoundedRectangle(cornerRadius: Theme.Drill.segRadius, style: .continuous).fill(Theme.Drill.segFill))
    .padding(Theme.Drill.segPadding)
  }

  private func seg(_ title: String, _ tab: DetailTab) -> some View {
    let on = model.detailTab == tab
    return Button { withAnimation(Theme.Motion.ease(reduceMotion)) { model.detailTab = tab } } label: {
      Text(title).font(Theme.Drill.segFont).foregroundStyle(on ? Theme.Drill.switchOn : Theme.Drill.segOff)
        .frame(maxWidth: .infinity).frame(height: Theme.Drill.segItemHeight)
        .background(RoundedRectangle(cornerRadius: Theme.Drill.segItemRadius, style: .continuous).fill(on ? Theme.Drill.segOnFill : .clear)
          .shadow(color: .black.opacity(on ? 0.3 : 0), radius: 1, y: 1))
        .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .accessibilityAddTraits(on ? .isSelected : [])
  }

  @ViewBuilder private var log: some View {
    let agent = model.focusAgent(runId)
    let lines = agent.map { model.log($0.id) } ?? []
    Group {
      if lines.isEmpty {
        let unsupported = agent.flatMap { model.logUnavailable($0.id) } != nil
        empty(unsupported ? "Couldn't load this agent's output." : "No output yet.")
      } else {
        ScrollView(showsIndicators: false) {
          VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(lines.enumerated()), id: \.element.id) { i, l in
              HStack(spacing: Theme.Drill.tailTimeGap) {
                Text(verbatim: Self.clock(l.atMs)).foregroundStyle(Theme.Drill.tailTime)
                Text(verbatim: l.text.firstLine)   // agent output: plain text, first line only
                  .foregroundStyle(i == lines.count - 1 ? Theme.Drill.tailLast : Theme.Drill.tailText)
                  .lineLimit(1).truncationMode(.tail)
              }
              .frame(height: Theme.Drill.tailLine)
            }
          }
          .font(Theme.Drill.tailFont)
          .frame(maxWidth: .infinity, alignment: .leading)
        }
        .defaultScrollAnchor(.bottom)
        .textSelection(.enabled)
        // Older lines scroll out under a short fade instead of a hard cut (as the Trace region does).
        .mask(LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: .black, location: Theme.Drill.tailFade / Theme.Drill.paneHeight)],
                             startPoint: .top, endPoint: .bottom))
      }
    }
    .padding(Theme.Drill.tailPadding)
    .frame(height: Theme.Drill.tailHeight, alignment: .top)
    .background(RoundedRectangle(cornerRadius: Theme.Drill.tailRadius, style: .continuous).fill(Theme.Drill.tailFill))
    .padding(.bottom, Theme.Drill.paneHeight - Theme.Drill.tailHeight)   // .pane is 94; its .tail box is 84
  }

  @ViewBuilder private var files: some View {
    Group {
      switch model.filesState(runId) {
      case .loaded(let f) where !f.files.isEmpty:
        ScrollView(showsIndicators: false) {
          VStack(spacing: 0) {
            // Which agent changed it: two agents can change one path on their own branches (two rows, two bots).
            let several = Set(f.files.map(\.agentId)).count > 1
            ForEach(f.files, id: \.self) { file in
              FileRow(file: file, bot: several ? model.bot(runId: runId, agentId: file.agentId) : nil,
                      who: model.botName(runId: runId, agentId: file.agentId))
            }
            if f.truncated { empty("\(f.total - f.files.count) more not shown") }
          }
        }
      case .loaded: empty("No changes yet.")
      case .unavailable(.unsupported): empty("This capcomd doesn't report changed files yet.")
      case .unavailable: empty("Couldn't load the changed files.")
      default: empty("Loading…")
      }
    }
    .frame(height: Theme.Drill.paneHeight, alignment: .top)
  }

  private func empty(_ s: String) -> some View {
    Text(s).font(Theme.Drill.emptyFont).foregroundStyle(Theme.Drill.emptyText)
      .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Theme.Drill.rowPadding).frame(height: Theme.Drill.fileHeight)
  }

  static func clock(_ ms: Int) -> String {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss"
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }
}

/// `.f`: status glyph · path (mono, middle-truncated) · the agent's bot when several agents changed files · +n · −n.
struct FileRow: View {
  let file: RunFiles.File
  var bot: BotTraits? = nil
  var who: String? = nil
  var body: some View {
    HStack(spacing: Theme.Drill.fileGap) {
      Image(systemName: symbol).font(Theme.Drill.iconFont).foregroundStyle(Theme.Drill.iconText).frame(width: Theme.Drill.fileIcon)
      Text(verbatim: UntrustedText(file.path).plain).font(Theme.Drill.fileFont).foregroundStyle(Theme.Drill.fileText)
        .lineLimit(1).truncationMode(.middle)
      Spacer(minLength: 0)
      if let bot { BotAvatar(traits: bot, size: .xs).help(who ?? "") }
      if let a = file.added { Text(verbatim: "+\(a)").font(Theme.Drill.fileCountFont).foregroundStyle(Theme.green) }
      if let r = file.removed { Text(verbatim: "−\(r)").font(Theme.Drill.fileCountFont).foregroundStyle(Theme.red) }
      if file.added == nil && file.removed == nil { Text("binary").font(Theme.Drill.fileCountFont).foregroundStyle(Theme.Drill.emptyText) }
    }
    .frame(height: Theme.Drill.fileHeight)
    .padding(.horizontal, Theme.Drill.rowPadding)
    .accessibilityElement(children: .combine)
    .accessibilityHint(who.map { "Changed by \($0)" } ?? "")
  }
  private var symbol: String {
    switch file.status { case "added": "doc.badge.plus"; case "deleted": "trash"; case "renamed", "copied": "arrow.right.doc.on.clipboard"; default: "square.and.pencil" }
  }
}

// MARK: footer

/// `.acts`: Pause/Resume · Stop · Open in terminal, under a hairline. Stop asks once, inline, before it stops the run.
struct DrillFooter: View {
  @Environment(AppModel.self) private var model
  let runId: String
  @State private var confirmStop = false

  private var active: Bool { model.run(runId)?.isActive ?? false }
  private var busy: Bool { if case .submitting = model.controlState(runId) { return true }; return false }
  private var failure: String? { if case .failed(let m) = model.controlState(runId) { return m }; return nil }

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      if let msg = failure {
        Text(verbatim: msg).font(Theme.Drill.errorFont).foregroundStyle(Theme.red).lineLimit(2)
          .padding(.horizontal, Theme.Drill.footerPadding.leading).padding(.bottom, 6)
      }
      bar
    }
    .padding(.top, Theme.Drill.footerTop)
  }

  private var bar: some View {
    HStack(spacing: Theme.Drill.footerGap) {
      if active { pauseButton; stopButton }   // an ended run has nothing to pause or stop
      Spacer(minLength: 0)
      terminalButton
    }
    .padding(Theme.Drill.footerPadding)
    .frame(maxWidth: .infinity)
    .background(ControlSurface(shape: Rectangle(), fallback: Theme.Footer.material))
    .overlay(alignment: .top) { DitherLine() }
  }

  private var pauseButton: some View {
    let pause = model.pauseAction(runId)
    return actionButton(pause == .resume ? "Resume" : "Pause") { model.control(runId, pause) }.disabled(!active || busy)
  }

  private var stopButton: some View {
    actionButton(confirmStop ? "Stop run?" : "Stop", fill: confirmStop ? Theme.Drill.stopConfirmFill : Theme.Drill.actionFill) {
      if confirmStop { confirmStop = false; model.control(runId, .cancel); return }
      confirmStop = true
      DispatchQueue.main.asyncAfter(deadline: .now() + Theme.Drill.stopConfirmSeconds) { confirmStop = false }
    }
    .disabled(!active || busy)
  }

  private var terminalButton: some View {
    Button { TerminalLauncher.openTUI(runId: runId) } label: {
      Label("Open in terminal", systemImage: "apple.terminal").font(Theme.Drill.actionFont).foregroundStyle(Theme.Drill.terminalText)
        .padding(.horizontal, Theme.Drill.terminalPadding).frame(height: Theme.Drill.actionHeight)
    }
    .buttonStyle(PressableStyle())
  }

  private func actionButton(_ title: String, fill: Color = Theme.Drill.actionFill, _ run: @escaping () -> Void) -> some View {
    Button(action: run) {
      Text(title).font(Theme.Drill.actionFont).foregroundStyle(Theme.Drill.actionText)
        .padding(.horizontal, Theme.Drill.actionPadding).frame(height: Theme.Drill.actionHeight)
        .background(RoundedRectangle(cornerRadius: Theme.Drill.actionRadius, style: .continuous).fill(fill))
    }
    .buttonStyle(PressableStyle())
  }
}

/// "Open in terminal": runs `capcomd tui <runId>` in Terminal through a throwaway .command file (no Automation
/// permission needed). The run id is reduced to [A-Za-z0-9_-] before it reaches the shell.
enum TerminalLauncher {
  static func openTUI(runId: String) {
    let safe = String(runId.filter { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") })
    guard !safe.isEmpty else { return }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("capcomd-\(safe).command")
    let script = "#!/bin/zsh -l\nexec capcomd tui \(safe)\n"
    do {
      try script.write(to: url, atomically: true, encoding: .utf8)
      try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: url.path)
      NSWorkspace.shared.open(url)
    } catch { NSSound.beep() }
  }
}
#endif
