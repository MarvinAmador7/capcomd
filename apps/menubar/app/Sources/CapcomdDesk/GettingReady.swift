#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdUI
import CapcomdBot

/// Getting an agent ready, or waking it, compact (DurableWaking-v3 on the design canvas): one quiet 28 pt line where its
/// turn begins (its bot twinkling, who, the current phase shimmering, the share copied, a clock), a 3 pt strip of the
/// setup's phases under it, the steps in a light card on a click. A reel column says the same in one line with a
/// segmented ring. What it shows is only what the daemon reported (capability agents.setup): no phase is guessed.
///
/// The steps come from the setup's trail (the agent lifecycle's `SetupTrail`, feat/idle-not-done): without one the
/// line has no steps, and a strip only while a copy's share is known.
package struct SetupLineModel: Hashable, Sendable {
  package enum StepState: Hashable, Sendable { case done, now, next }
  package struct Step: Hashable, Sendable {
    package var line: String
    package var state: StepState
    /// A done step's length.
    package var ms: Int?
    /// When the current step began (its time runs from it).
    package var atMs: Int?
    package init(line: String, state: StepState, ms: Int? = nil, atMs: Int? = nil) { self.line = line; self.state = state; self.ms = ms; self.atMs = atMs }
  }
  /// How its column names it ("planner").
  package var name: String
  /// A message woke it (it is being set up again); else it is starting for the first time.
  package var waking: Bool
  /// The current phase, "Copying the repository".
  package var phase: String
  /// The copy's bytes, "53% · 56 of 105 MB".
  package var detail: String?
  /// The current phase's share done, 0...1, when the daemon sent a total.
  package var fraction: Double?
  /// When this setup began: the clock.
  package var sinceMs: Int?
  package var steps: [Step]
  /// Waking: nothing is drawn before this instant (a parked machine is back in about 0.2 s), then the line fades in.
  package var showsAtMs: Int?

  package init(name: String, waking: Bool = false, phase: String, detail: String? = nil, fraction: Double? = nil, sinceMs: Int? = nil,
               steps: [Step] = [], showsAtMs: Int? = nil) {
    self.name = name; self.waking = waking; self.phase = phase; self.detail = detail; self.fraction = fraction; self.sinceMs = sinceMs
    self.steps = steps; self.showsAtMs = showsAtMs
  }

  /// From what the daemon reports now. `steps`: the setup's trail, when known.
  package static func of(_ p: Preparing, name: String, waking: Bool = false, steps: [Step] = [], showsAtMs: Int? = nil) -> SetupLineModel {
    SetupLineModel(name: name, waking: waking, phase: p.line, detail: p.detail, fraction: p.fraction, sinceMs: p.sinceMs, steps: steps,
                   showsAtMs: showsAtMs)
  }

  /// "Waking planner", "Starting planner".
  package var title: String { waking ? "Waking \(name)" : "Starting \(name)" }
  /// The phase, unless it only says the title again ("Starting planner").
  package var phaseShown: String? { phase == title ? nil : phase }
  package var percent: Int? { fraction.map { Int(($0 * 100).rounded(.down)) } }
  package var current: Int? { steps.firstIndex { $0.state == .now } }
  /// "2/4"
  package var stepCount: String? { current.map { "\($0 + 1)/\(steps.count)" } }

  /// For VoiceOver: "Waking planner: copying the repository, 53 percent, step 2 of 4".
  package var spoken: String {
    var s = title
    if let p = phaseShown { s += ": " + p.lowercased() }
    if let pc = percent { s += ", \(pc) percent" }
    if let c = current { s += ", step \(c + 1) of \(steps.count)" }
    return s
  }

  /// m:ss
  package static func clock(_ ms: Int) -> String { let s = max(0, ms) / 1000; return "\(s / 60):" + String(format: "%02d", s % 60) }
  /// A step's time: "2.1s" under ten seconds, "57s" under a minute, "1:15" from one.
  package static func stepTime(_ ms: Int) -> String {
    if ms < 10_000 { let s = String(format: "%.1f", Double(max(0, ms)) / 1000); return (s.hasSuffix(".0") ? String(s.dropLast(2)) : s) + "s" }
    if ms < 60_000 { return "\(ms / 1000)s" }
    return clock(ms)
  }
}

/// Once the setup is done, its line folds into one record above the first thing its turn did, never vanishes: "Set up
/// in 1:15 · 4 steps" (a click shows the steps and their times).
package struct SetupRecord: Hashable, Sendable {
  package var elapsedMs: Int
  package var steps: [SetupLineModel.Step]
  /// The thread row it goes above (the first of the new turn); nil: the top of the thread (a first start).
  package var beforeRow: String?
  package init(elapsedMs: Int, steps: [SetupLineModel.Step], beforeRow: String? = nil) { self.elapsedMs = elapsedMs; self.steps = steps; self.beforeRow = beforeRow }
  package var label: String { "Set up in \(SetupLineModel.clock(elapsedMs))" + (steps.isEmpty ? "" : " · \(steps.count) step\(steps.count == 1 ? "" : "s")") }
}

/// The thread's foot while its agent isn't taking a turn: getting ready or waking (the compact line), or waiting
/// between turns (one 44 pt card). In a warm thread it is the last row; a cold reel column (no thread read) shows it
/// at its top. Reads only its agent's slice, so a phase or a second changing re-renders this and nothing else.
struct ThreadTail: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.needsReel) private var inNeeds
  let agentId: String
  /// A reel column: one line with a ring, no strip.
  var compact = false
  var body: some View {
    if let a = model.agent(agentId, inNeeds: inNeeds) {
      if let s = a.setupLine {
        SetupDelay(showsAtMs: s.showsAtMs) { SetupLine(model: s, bot: a.bot, compact: compact) }
          .padding(.top, 4).padding(.bottom, Theme.Rows.bottom)
      } else if a.header.status == .running, let w = a.header.waitLine {
        WaitingRow(line: w, sinceMs: a.header.waitSinceMs).padding(.top, 4).padding(.bottom, Theme.Rows.bottom)
      }
    }
  }
}

/// Nothing before `showsAtMs`, then its content fades in.
struct SetupDelay<Content: View>: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let showsAtMs: Int?
  @ViewBuilder let content: () -> Content
  @State private var shown = false
  var body: some View {
    let due = showsAtMs.map { Double($0) / 1000 - Date().timeIntervalSince1970 } ?? 0
    Group {
      if due <= 0 || shown { content().transition(.opacity) }
    }
    .task(id: showsAtMs) {
      guard due > 0 else { return }
      try? await Task.sleep(for: .seconds(due))
      withAnimation(reduceMotion ? nil : Theme.Affect.ease(Theme.Ready.fadeIn)) { shown = true }
    }
  }
}

/// The line, its strip, and on a click its steps (a card in a pane; under the line in a column).
struct SetupLine: View {
  let model: SetupLineModel
  let bot: BotTraits?
  var compact = false
  @State private var open: Bool
  init(model: SetupLineModel, bot: BotTraits?, compact: Bool = false, open: Bool = false) {
    self.model = model; self.bot = bot; self.compact = compact; _open = State(initialValue: open)
  }
  var body: some View {
    Group {
      if open && !compact {
        VStack(alignment: .leading, spacing: Theme.Ready.lineGap) {
          head
          if !model.steps.isEmpty || model.fraction != nil { SetupStrip(model: model) }
          SetupSteps(steps: model.steps, detail: model.detail, small: false).padding(.top, 3)
        }
        .padding(Theme.Ready.cardPadding)
        .background(RoundedRectangle(cornerRadius: Theme.Ready.cardRadius, style: .continuous).fill(Theme.Ready.card)
          .shadow(color: Theme.Affect.cardShadow, radius: 1, y: 1))
        .overlay(RoundedRectangle(cornerRadius: Theme.Ready.cardRadius, style: .continuous).strokeBorder(Theme.Ready.cardStroke, lineWidth: Theme.Affect.hairline))
        .modifier(RiseIn())
      } else {
        VStack(alignment: .leading, spacing: Theme.Ready.lineGap) {
          line
          if !compact, !model.steps.isEmpty || model.fraction != nil { SetupStrip(model: model) }
          if compact && open { SetupSteps(steps: model.steps, detail: nil, small: true).modifier(RiseIn()) }
        }
      }
    }
    .accessibilityElement(children: .contain)
    .accessibilityAddTraits(.updatesFrequently)
  }

  private var canOpen: Bool { !model.steps.isEmpty }

  /// Folded: bot, who (a pane), the phase (the only shimmer), its share, the clock, a chevron.
  private var line: some View {
    SetupButton(enabled: canOpen, toggle: { open.toggle() }) {
      HStack(spacing: Theme.Ready.gap) {
        SetupBot(bot: bot)
        if !compact {
          Text(verbatim: model.title).foregroundStyle(Theme.Ready.text).fixedSize()
          if let p = model.phaseShown {
            Text(verbatim: "·").foregroundStyle(Theme.Ready.dim)
            Text(verbatim: p).lineLimit(1).truncationMode(.tail).modifier(Shimmer(true))
          }
          if let pc = model.percent { Text(verbatim: "\(pc)%").monospacedDigit().foregroundStyle(Theme.Ready.dim).fixedSize() }
        } else {
          Text(verbatim: model.phaseShown ?? model.title).lineLimit(1).truncationMode(.tail).modifier(Shimmer(true))
          if model.steps.count > 1 || model.fraction != nil { SetupRing(model: model) }
        }
        Spacer(minLength: Theme.Ready.clockLead)
        if let since = model.sinceMs { SetupClock(sinceMs: since) }
        if canOpen { Chevron(open: open && compact) }
      }
    }
    .accessibilityLabel(model.spoken).accessibilityHint(canOpen ? "Shows the steps" : "")
  }

  /// Open: who, step 2/4 and the clock (the phase moves off the header: the list shows it).
  private var head: some View {
    SetupButton(enabled: true, toggle: { open.toggle() }) {
      HStack(spacing: Theme.Ready.gap) {
        SetupBot(bot: bot)
        Text(verbatim: model.title).foregroundStyle(Theme.Ready.text).fixedSize()
        Spacer(minLength: Theme.Ready.clockLead)
        HStack(spacing: 4) {
          if let n = model.stepCount { Text(verbatim: n) }
          if let since = model.sinceMs { SetupClock(sinceMs: since) }
        }
        .font(Theme.Ready.clock).foregroundStyle(Theme.Ready.clockText)
        Chevron(open: true)
      }
    }
    .accessibilityLabel(model.spoken).accessibilityHint("Folds the steps")
  }
}

/// The line as a button (Space or a click opens it), with the thread's hover.
private struct SetupButton<Label: View>: View {
  let enabled: Bool
  let toggle: () -> Void
  @ViewBuilder let label: () -> Label
  @State private var hover = false
  var body: some View {
    Button { withTransaction(Transaction(animation: nil)) { toggle() } } label: {
      label()
        .font(Theme.Ready.font).lineLimit(1)
        .frame(height: Theme.Ready.line)
        .padding(.horizontal, Theme.Ready.hoverInset)
        .background(RoundedRectangle(cornerRadius: Theme.Ready.hoverRadius, style: .continuous).fill(hover && enabled ? Theme.Ready.hover : .clear))
        .contentShape(Rectangle())
        .padding(.horizontal, -Theme.Ready.hoverInset)
    }
    .buttonStyle(.plain)
    .disabled(!enabled)
    .onHover { hover = $0 }
  }
}

private struct SetupBot: View {
  let bot: BotTraits?
  var body: some View {
    if let bot {
      BotAvatar(traits: bot, size: .xs).frame(width: Theme.Ready.bot, height: Theme.Ready.bot).modifier(Twinkle(true))
    }
  }
}

private struct Chevron: View {
  let open: Bool
  var body: some View {
    Image(systemName: "chevron.right").font(Theme.Ready.chevron).foregroundStyle(Theme.Ready.chevronText)
      .rotationEffect(.degrees(open ? 90 : 0)).accessibilityHidden(true)
  }
}

/// m:ss since `sinceMs`, once a second (only this text re-renders).
struct SetupClock: View {
  let sinceMs: Int
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { t in
      Text(verbatim: SetupLineModel.clock(Int(t.date.timeIntervalSince1970 * 1000) - sinceMs))
    }
    .font(Theme.Ready.clock).foregroundStyle(Theme.Ready.clockText).fixedSize()
  }
}

/// `.strip`: one 3 pt segment per phase, done filled, the current one to its share (a transform, never a width), the
/// rest empty. Without a trail, one segment: the copy's share.
struct SetupStrip: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let model: SetupLineModel
  var body: some View {
    let steps = model.steps.isEmpty ? [SetupLineModel.Step(line: model.phase, state: .now)] : model.steps
    HStack(spacing: Theme.Ready.stripGap) {
      ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
        let f: Double = s.state == .done ? 1 : s.state == .now ? (model.fraction ?? 0) : 0
        RoundedRectangle(cornerRadius: Theme.Ready.strip / 2 + 0.5).fill(Theme.Ready.stripTrack)
          .overlay(alignment: .leading) {
            RoundedRectangle(cornerRadius: Theme.Ready.strip / 2 + 0.5).fill(Theme.Ready.stripFill)
              .scaleEffect(x: max(0.0001, f), y: 1, anchor: .leading)
              .animation(reduceMotion ? nil : Theme.Affect.ease(Theme.Affect.long), value: f)
          }
          .clipShape(RoundedRectangle(cornerRadius: Theme.Ready.strip / 2 + 0.5))
      }
    }
    .frame(height: Theme.Ready.strip)
    .accessibilityHidden(true)
  }
}

/// A reel column's ring: the strip's segments around a 16 pt circle.
struct SetupRing: View {
  let model: SetupLineModel
  var body: some View {
    let steps = model.steps.isEmpty ? [SetupLineModel.Step(line: model.phase, state: .now)] : model.steps
    let n = Double(steps.count), gap = steps.count > 1 ? Theme.Ready.ringGap / n : 0, seg = 1 / n - gap
    ZStack {
      ForEach(Array(steps.enumerated()), id: \.offset) { i, s in
        let from = Double(i) / n + gap / 2
        Circle().trim(from: from, to: from + seg).stroke(Theme.Ready.stripTrack, lineWidth: Theme.Ready.ringWidth)
        let f: Double = s.state == .done ? 1 : s.state == .now ? (model.fraction ?? 0) : 0
        if f > 0 { Circle().trim(from: from, to: from + seg * f).stroke(Theme.Ready.stripFill, lineWidth: Theme.Ready.ringWidth) }
      }
    }
    .rotationEffect(.degrees(-90))
    .padding(Theme.Ready.ringWidth)
    .frame(width: Theme.Ready.ring, height: Theme.Ready.ring)
    .accessibilityHidden(true)
  }
}

/// The steps (.trail): a blue tick and its time for each done, the current one bright with the shimmer (its bytes under
/// it), the next ones faint. `small`: 24 pt rows in 12 pt (a column, a record).
struct SetupSteps: View {
  let steps: [SetupLineModel.Step]
  let detail: String?
  let small: Bool
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(Array(steps.enumerated()), id: \.offset) { _, s in
        HStack(spacing: Theme.Ready.stepGap) {
          StepMark(state: s.state)
          Text(verbatim: s.line).lineLimit(1).modifier(Shimmer(s.state == .now))
          Spacer(minLength: 16)
          if let ms = s.ms { Text(verbatim: SetupLineModel.stepTime(ms)).font(Theme.Ready.stepTime).foregroundStyle(Theme.Ready.clockText) }
          else if s.state == .now, let at = s.atMs { StepClock(sinceMs: at) }
        }
        .font(small ? Theme.Ready.stepSmallFont : Theme.Ready.font)
        .foregroundStyle(s.state == .done ? Theme.Ready.stepDone : s.state == .now ? Theme.Ready.stepNow : Theme.Ready.stepText)
        .frame(height: small ? Theme.Ready.stepSmall : Theme.Ready.step)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(s.line + (s.state == .done ? ", done" + (s.ms.map { " in " + SetupLineModel.stepTime($0) } ?? "") : s.state == .now ? ", now" : ", next"))
        if s.state == .now, let d = detail {
          Text(verbatim: d).font(Theme.Affect.small).monospacedDigit().foregroundStyle(Theme.Ready.dim)
            .padding(.leading, Theme.Ready.detailIndent).padding(.top, -4).padding(.bottom, 4)
        }
      }
    }
  }
}

/// The current step's own time, "6.8s", once a second.
private struct StepClock: View {
  let sinceMs: Int
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { t in
      Text(verbatim: SetupLineModel.stepTime(Int(t.date.timeIntervalSince1970 * 1000) - sinceMs))
    }
    .font(Theme.Ready.stepTime).foregroundStyle(Theme.Ready.clockText)
  }
}

/// `.mk`: done, a tick on the info tint; now, a 1.5 pt info ring; next, a faint 1 pt ring.
struct StepMark: View {
  let state: SetupLineModel.StepState
  var body: some View {
    ZStack {
      switch state {
      case .done:
        Circle().fill(Theme.Ready.markDone)
        TickShape(points: [CGPoint(x: 3.5, y: 8.5), CGPoint(x: 6.5, y: 11.5), CGPoint(x: 12.5, y: 5)])
          .stroke(Theme.Ready.markDoneGlyph, style: StrokeStyle(lineWidth: 2.2 * Theme.Ready.markGlyph / 16, lineCap: .round, lineJoin: .round))
          .frame(width: Theme.Ready.markGlyph, height: Theme.Ready.markGlyph)
      case .now: Circle().strokeBorder(Theme.Ready.markNow, lineWidth: Theme.Ready.markNowWidth)
      case .next: Circle().strokeBorder(Theme.Ready.markNext, lineWidth: Theme.Ready.markNextWidth)
      }
    }
    .frame(width: Theme.Ready.mark, height: Theme.Ready.mark)
    .accessibilityHidden(true)
  }
}

/// "Set up in 1:15 · 4 steps": where the line was, once the turn's first item is in. A click shows the steps.
struct SetupRecordRow: View {
  let record: SetupRecord
  @State private var open: Bool
  @State private var hover = false
  init(record: SetupRecord, open: Bool = false) { self.record = record; _open = State(initialValue: open) }
  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: {
        HStack(spacing: 6) {
          Chevron(open: open)
          Text(verbatim: record.label).monospacedDigit()
        }
        .font(Theme.Ready.recordFont).foregroundStyle(hover ? Theme.Ready.recordHover : Theme.Ready.recordText)
        .frame(height: Theme.Ready.record)
        .padding(.horizontal, Theme.Ready.hoverInset)
        .background(RoundedRectangle(cornerRadius: Theme.Ready.hoverRadius, style: .continuous).fill(hover ? Theme.Ready.hover : .clear))
        .contentShape(Rectangle())
        .padding(.horizontal, -Theme.Ready.hoverInset)
      }
      .buttonStyle(.plain).disabled(record.steps.isEmpty)
      .onHover { hover = $0 }
      .accessibilityLabel(record.label).accessibilityHint(open ? "Hides the steps" : "Shows the steps")
      if open { SetupSteps(steps: record.steps, detail: nil, small: true).padding(.leading, 2).modifier(RiseIn()) }
    }
    .padding(.bottom, Theme.Rows.bottom)
  }
}

/// Waiting between turns (capability agents.wake, DurableWaiting-v2): one 44 pt card with a static clock icon, what it
/// waits for, and how long; under it, that its turn has ended. No spinner and no shimmer: nothing is running.
struct WaitingRow: View {
  /// "waiting for verify vfy-3f9a"
  let line: String
  let sinceMs: Int?
  var body: some View {
    VStack(alignment: .leading, spacing: 4) {
      HStack(spacing: Theme.Ready.waitGap) {
        Image(systemName: "clock").font(.system(size: 13)).foregroundStyle(Theme.Ready.dim)
          .frame(width: Theme.Ready.waitIcon, height: Theme.Ready.waitIcon)
        Text(verbatim: line.prefix(1).uppercased() + line.dropFirst()).font(Theme.Ready.font).foregroundStyle(Theme.Ready.text).lineLimit(1)
        Spacer(minLength: Theme.Ready.clockLead)
        if let sinceMs { SetupClock(sinceMs: sinceMs) }
      }
      .padding(.horizontal, Theme.Ready.waitPadding)
      .frame(height: Theme.Ready.wait)
      .background(RoundedRectangle(cornerRadius: Theme.Ready.cardRadius, style: .continuous).fill(Theme.Ready.card)
        .shadow(color: Theme.Affect.cardShadow, radius: 1, y: 1))
      .overlay(RoundedRectangle(cornerRadius: Theme.Ready.cardRadius, style: .continuous).strokeBorder(Theme.Ready.cardStroke, lineWidth: Theme.Affect.hairline))
      Text("Its turn has ended. The result wakes it, or a message from you does.")
        .font(Theme.Ready.waitSub).foregroundStyle(Theme.Ready.waitSubText).padding(.leading, Theme.Ready.waitSubIndent)
    }
    .accessibilityElement(children: .combine)
    .accessibilityAddTraits(.updatesFrequently)
  }
}
#endif
