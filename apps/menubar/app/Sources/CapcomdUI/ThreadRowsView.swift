#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdThread
import CapcomdBot

// Thread v2 (canvas ThreadPolish-v2): a tool call as one grey line with its status on the right, finished calls in a
// row folded into "Used N tools", thinking in a row merged into "Thinking · 5s", the reviewer's seal. Only a status word
// and its glyph take colour; the row stays grey. Every string is agent text, shown verbatim.

/// The icon a call's kind gets (SF Symbols, drawn muted). A shell command reads as one (`>_`) whatever it runs;
/// capcomd's own commands (spawn, wait, verify, merge…) and other tools keep their kind's icon.
package enum ToolIcon {
  package static func symbol(_ tool: CapcomdThread.Item.Tool?) -> String {
    let shell: Set<String> = ["Bash", "BashOutput", "KillShell", "KillBash", "command_execution", "shell"]
    let capcomd: Set<String> = ["spawn", "wait", "message", "verify", "merge", "report", "delegate"]
    if let tool, shell.contains(tool.name), !capcomd.contains(tool.kind) { return "terminal" }
    switch tool?.kind {
    case "read"?: return "doc"
    case "search"?: return "magnifyingglass"
    case "spawn"?: return "hexagon"
    case "wait"?: return "hourglass"
    default: return StepKind(activityKind: tool?.kind).symbol
    }
  }
}

// MARK: - Status glyphs

/// Done: a blue disc with a white tick. When the call finishes in view, the disc pops in and the tick draws itself
/// (460 / 360 ms, the thread's ease); with Reduce Motion it fades in. A row that appears already done shows it still.
package struct DoneGlyph: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  /// The call finished while this row was on screen: play the pop once.
  package let animate: Bool
  @State private var scale: CGFloat = 1
  @State private var drawn: CGFloat = 1
  @State private var shown: Double = 1
  package init(animate: Bool) { self.animate = animate }
  package var body: some View {
    let s = Theme.Rows.done
    ZStack {
      Circle().fill(Theme.Affect.info)
      TickShape().trim(from: 0, to: drawn)
        .stroke(Theme.Rows.tick, style: StrokeStyle(lineWidth: Theme.Rows.tickWidth * s / 16, lineCap: .round, lineJoin: .round))
    }
    .frame(width: s, height: s)
    .scaleEffect(scale).opacity(shown)
    .onAppear {
      guard animate else { return }
      if reduceMotion {
        shown = 0
        withAnimation(Theme.Affect.ease(Theme.Affect.short)) { shown = 1 }
      } else {
        scale = 0.4; drawn = 0
        withAnimation(.spring(duration: Theme.Affect.checkPop, bounce: 0.35)) { scale = 1 }
        withAnimation(Theme.Affect.ease(Theme.Affect.tickDraw).delay(0.08)) { drawn = 1 }
      }
    }
    .accessibilityHidden(true)
  }
}

/// The tick of the done disc and the seal, in a 16 pt box (affect.css: m5 8.2 2 2 4-4.2).
package struct TickShape: Shape {
  package var points: [CGPoint] = [CGPoint(x: 5, y: 8.2), CGPoint(x: 7, y: 10.2), CGPoint(x: 11, y: 6)]
  package init(points: [CGPoint]? = nil) { if let points { self.points = points } }
  package func path(in r: CGRect) -> Path {
    var p = Path()
    let k = r.width / 16
    for (n, pt) in points.enumerated() {
      let q = CGPoint(x: r.minX + pt.x * k, y: r.minY + pt.y * k)
      if n == 0 { p.move(to: q) } else { p.addLine(to: q) }
    }
    return p
  }
}

/// × in a 16 pt box (m4 4 8 8 M12 4l-8 8), or the seal's (4.5 → 11.5).
package struct CrossShape: Shape {
  package var inset: CGFloat = 4
  package init(inset: CGFloat = 4) { self.inset = inset }
  package func path(in r: CGRect) -> Path {
    let k = r.width / 16, a = inset * k, b = (16 - inset) * k
    var p = Path()
    p.move(to: CGPoint(x: r.minX + a, y: r.minY + a)); p.addLine(to: CGPoint(x: r.minX + b, y: r.minY + b))
    p.move(to: CGPoint(x: r.minX + b, y: r.minY + a)); p.addLine(to: CGPoint(x: r.minX + a, y: r.minY + b))
    return p
  }
}

/// Running: a quarter arc on a faint track, turning (still under Reduce Motion).
package struct RunningGlyph: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var turn = false
  package init() {}
  package var body: some View {
    let s = Theme.Rows.running, w = Theme.Rows.arcWidth
    ZStack {
      Circle().inset(by: s / 8).stroke(Theme.Rows.arcTrack, lineWidth: w)
      Circle().inset(by: s / 8).trim(from: 0, to: 0.25).stroke(Theme.Affect.info, style: StrokeStyle(lineWidth: w, lineCap: .round))
        .rotationEffect(.degrees(turn ? 270 : -90))
    }
    .frame(width: s, height: s)
    .onAppear {
      guard !reduceMotion else { return }
      withAnimation(.linear(duration: Theme.Rows.spin).repeatForever(autoreverses: false)) { turn = true }
    }
    .accessibilityHidden(true)
  }
}

/// The status at a call's right edge: the glyph, the word when it is a failure or a refusal, then the time.
package struct ToolStatusView: View {
  package let status: ToolStatus
  package let duration: String?
  /// It finished while on screen (the done disc pops).
  package let finishedNow: Bool
  package init(status: ToolStatus, duration: String?, finishedNow: Bool = false) { self.status = status; self.duration = duration; self.finishedNow = finishedNow }
  package var body: some View {
    HStack(spacing: Theme.Rows.statusGap) {
      switch status {
      case .running: RunningGlyph()
      case .done: DoneGlyph(animate: finishedNow)
      case .failed:
        HStack(spacing: Theme.Rows.statusWordGap) {
          CrossShape().stroke(Theme.Affect.bad, style: StrokeStyle(lineWidth: Theme.Rows.crossWidth * Theme.Rows.failed / 16, lineCap: .round))
            .frame(width: Theme.Rows.failed, height: Theme.Rows.failed)
          Text("Failed").font(Theme.Rows.statusWord).foregroundStyle(Theme.Affect.bad)
        }
      case .notAllowed:
        HStack(spacing: Theme.Rows.statusWordGap) {
          NotAllowedShape().stroke(Theme.Affect.bad, lineWidth: Theme.Rows.refusedWidth * Theme.Rows.refused / 16)
            .frame(width: Theme.Rows.refused, height: Theme.Rows.refused)
          Text("Not allowed").font(Theme.Rows.statusWord).foregroundStyle(Theme.Affect.bad)
        }
      }
      // A refused call never ran: it has no time to show.
      if status != .notAllowed, let duration { Text(verbatim: duration).font(Theme.Rows.status).foregroundStyle(Theme.Rows.statusText) }
    }
    .fixedSize()
  }
}

/// ⊘ in a 16 pt box (circle r 6, m3.8 12.2 8.4-8.4).
package struct NotAllowedShape: Shape {
  package init() {}
  package func path(in r: CGRect) -> Path {
    let k = r.width / 16
    var p = Path(ellipseIn: CGRect(x: r.minX + 2 * k, y: r.minY + 2 * k, width: 12 * k, height: 12 * k))
    p.move(to: CGPoint(x: r.minX + 3.8 * k, y: r.minY + 12.2 * k)); p.addLine(to: CGPoint(x: r.minX + 12.2 * k, y: r.minY + 3.8 * k))
    return p
  }
}

// MARK: - Shimmer and twinkle (only while an agent works; Reduce Motion: neither moves)

/// `.shim`: the words at 46 % with a brighter band sweeping across them every 1.6 s.
package struct Shimmer: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  package let on: Bool
  @State private var phase: CGFloat = 0
  package init(_ on: Bool) { self.on = on }
  package func body(content: Content) -> some View {
    if on && !reduceMotion {
      content.foregroundStyle(Theme.Affect.shimmerBase)
        .overlay {
          GeometryReader { g in
            let w = g.size.width
            LinearGradient(stops: [.init(color: .clear, location: 0), .init(color: Theme.Affect.shimmerHighlight, location: 0.5), .init(color: .clear, location: 1)],
                           startPoint: .leading, endPoint: .trailing)
              .frame(width: w * 0.6)
              .offset(x: -w * 0.6 + phase * w * 1.6)
          }
          .mask(content)
          .allowsHitTesting(false)
        }
        .onAppear { withAnimation(.linear(duration: Theme.Affect.shimmer).repeatForever(autoreverses: false)) { phase = 1 } }
    } else {
      content
    }
  }
}

/// `.tw`: a working bot twinkles: alternate 2 pt cells of it fade to the background and back, in two halves out of step.
package struct Twinkle: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  package let on: Bool
  package let ground: Color
  @State private var phase = false
  package init(_ on: Bool, ground: Color = Theme.Affect.ground) { self.on = on; self.ground = ground }
  package func body(content: Content) -> some View {
    if on && !reduceMotion {
      content.overlay {
        ZStack {
          Checker(odd: false).fill(ground).opacity(phase ? Theme.Affect.twinkleMax : 0)
          Checker(odd: true).fill(ground).opacity(phase ? 0 : Theme.Affect.twinkleMax)
        }
        .allowsHitTesting(false)
        .onAppear { withAnimation(.easeInOut(duration: Theme.Affect.twinkle).repeatForever(autoreverses: true)) { phase = true } }
      }
    } else {
      content
    }
  }
  struct Checker: Shape {
    let odd: Bool
    func path(in r: CGRect) -> Path {
      let c = Theme.Affect.twinkleCell
      var p = Path()
      var y: CGFloat = 0, row = 0
      while y < r.height {
        var x: CGFloat = 0, col = 0
        while x < r.width {
          if (row + col) % 2 == (odd ? 1 : 0) { p.addRect(CGRect(x: r.minX + x, y: r.minY + y, width: c, height: c)) }
          x += c; col += 1
        }
        y += c; row += 1
      }
      return p
    }
  }
}

/// Rise-in: what a click opens comes up 4 pt as it fades in (the thread's ease, 220 ms); the height itself snaps, as a
/// thought's does. Reduce Motion: a fade only.
package struct RiseIn: ViewModifier {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false
  package init() {}
  package func body(content: Content) -> some View {
    content
      .opacity(shown ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : Theme.Affect.riseIn)
      .onAppear { withAnimation(Theme.Affect.ease(Theme.Affect.medium)) { shown = true } }
  }
}

// MARK: - A call group

/// `.tg`: finished calls in a row as one line: up to three of their icons stacked, "Used 3 tools", what failed or was
/// refused said in words ("2 not allowed", in the danger colour: only those words), their time, a chevron. Folded by
/// default; a click opens the calls under it, each a row of its own (a click on one shows its arguments and result).
package struct ToolGroupRow: View {
  package let run: ToolRun
  /// Expanded pane: the line keeps to the reading column (the calls' results run wide).
  package var proseWidth: CGFloat? = nil
  package init(run: ToolRun, proseWidth: CGFloat? = nil) { self.run = run; self.proseWidth = proseWidth }
  @State private var open = false
  @State private var hover = false

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: { line }
        .buttonStyle(.plain).onHover { hover = $0 }
        .padding(.horizontal, -Theme.Rows.hoverInset)
        .accessibilityLabel(run.spoken)
        .accessibilityHint(open ? "Hides the calls" : "Shows the calls")
        .modifier(ProseColumn(proseWidth))
      if open {
        VStack(alignment: .leading, spacing: 0) {
          ForEach(run.items, id: \.id) { i in ToolCallRow(item: i, inGroup: true) }
        }
        .padding(.leading, Theme.Rows.groupIndent)
        .modifier(RiseIn())
      }
    }
    .padding(.bottom, Theme.Rows.bottom)
  }

  private var line: some View {
    HStack(spacing: Theme.Rows.gap) {
      HStack(spacing: -Theme.Rows.tileOverlap) {
        ForEach(Array(run.stacked.enumerated()), id: \.offset) { n, i in tile(i).zIndex(Double(-n)) }
      }
      HStack(spacing: 0) {
        Text(verbatim: run.title).foregroundStyle(Theme.Rows.groupText)
        ForEach(run.notes, id: \.self) { note in
          Text(verbatim: " · ").foregroundStyle(Theme.Rows.groupNote)
          Text(verbatim: note).foregroundStyle(Theme.Affect.bad)
        }
        if let d = run.duration { Text(verbatim: " · " + d).foregroundStyle(Theme.Rows.groupNote).monospacedDigit() }
      }
      .font(Theme.Affect.body).lineLimit(1)
      Image(systemName: "chevron.right").font(Theme.Rows.chevron).foregroundStyle(Theme.Rows.groupChevron)
        .rotationEffect(.degrees(open ? 90 : 0))
      Spacer(minLength: 0)
    }
    .frame(height: Theme.Rows.height).padding(.horizontal, Theme.Rows.hoverInset)
    .background(RoundedRectangle(cornerRadius: Theme.Rows.hoverRadius, style: .continuous).fill(hover ? Theme.Rows.hover : .clear))
    .contentShape(Rectangle())
  }

  private func tile(_ i: CapcomdThread.Item) -> some View {
    let r = RoundedRectangle(cornerRadius: Theme.Rows.tileRadius, style: .continuous)
    return Image(systemName: ToolIcon.symbol(i.tool)).font(Theme.Rows.tileIcon).foregroundStyle(Theme.Rows.tileText)
      .frame(width: Theme.Rows.tile, height: Theme.Rows.tile)
      .background(r.fill(Theme.Rows.tileFill))
      .overlay(r.strokeBorder(Theme.Rows.tileStroke, lineWidth: Theme.Affect.hairline))
      .background(r.inset(by: -Theme.Rows.tileRing).fill(Theme.Affect.ground))
  }
}

// MARK: - Thinking

/// `.think`: thoughts in a row as one line, "› Thinking · 5s". While the agent thinks: its bot twinkling, "Thinking"
/// shimmering, the seconds running. A click opens the thoughts under a hairline; a thought the CLI hid says so there.
package struct ThinkingRunRow: View {
  @Environment(\.threadHost) private var host
  package let runId: String
  package let agentId: String
  package let run: ThinkingRun
  package init(runId: String, agentId: String, run: ThinkingRun) { self.runId = runId; self.agentId = agentId; self.run = run }
  @State private var open = false

  package var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      Button { withTransaction(Transaction(animation: nil)) { open.toggle() } } label: {
        HStack(spacing: Theme.Rows.thinkGap) {
          if run.open {
            if let bot = host?.host.bot(runId: runId, agentId: agentId) {
              BotAvatar(traits: bot, size: .xs).frame(width: Theme.Rows.thinkBot, height: Theme.Rows.thinkBot).modifier(Twinkle(true))
            }
            Text("Thinking").modifier(Shimmer(true))
            if let start = run.items.last?.atMs, start > 0 { ThinkingClock(sinceMs: start) }
          } else {
            Image(systemName: "chevron.right").font(Theme.Rows.chevron).rotationEffect(.degrees(open ? 90 : 0))
            Text(verbatim: run.label).monospacedDigit()
          }
        }
        .font(Theme.Rows.thinkFont).foregroundStyle(Theme.Rows.thinkText)
        .frame(height: Theme.Rows.thinkHeight).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(run.open)
      .accessibilityLabel(run.spoken).accessibilityHint(open ? "Hides the reasoning" : "Shows the reasoning")
      if open && !run.open {
        VStack(alignment: .leading, spacing: Theme.Content.thoughtSpacing) {
          ForEach(run.items, id: \.id) { i in
            if i.redacted || (i.blocks.isEmpty && i.text.isEmpty) {
              Text(verbatim: Theme.Rows.hiddenNote).font(Theme.Content.thoughtFont).foregroundStyle(Theme.Rows.thinkText)
            } else if i.blocks.isEmpty {
              Text(verbatim: i.text).font(Theme.Content.thoughtFont).foregroundStyle(Theme.Content.thoughtText).textSelection(.enabled)
            } else {
              BlocksView(runId: runId, agentId: agentId, blocks: i.blocks, font: Theme.Content.thoughtFont, color: Theme.Content.thoughtText, spacing: Theme.Content.thoughtSpacing)
            }
          }
        }
        .padding(.leading, Theme.Content.thoughtIndent)
        .overlay(alignment: .leading) { Rectangle().fill(Theme.Content.thoughtRule).frame(width: Theme.Affect.hairline * 2) }
        .padding(Theme.Content.thoughtMargin)
        .modifier(RiseIn())
      }
    }
    .padding(.bottom, Theme.Rows.bottom)
  }
}

/// The seconds a thought has run, "2s", once a second (only the open thought's row has one).
struct ThinkingClock: View {
  let sinceMs: Int
  var body: some View {
    TimelineView(.periodic(from: .now, by: 1)) { t in
      Text(verbatim: "\(max(0, Int(t.date.timeIntervalSince1970 * 1000) - sinceMs) / 1000)s").monospacedDigit()
    }
  }
}

// MARK: - Seal

/// `.seal`: a 16 pt disc on the success tint with a tick (passed), or on the danger tint with × (didn't pass).
package struct Seal: View {
  package let passed: Bool
  package init(passed: Bool) { self.passed = passed }
  package var body: some View {
    let g = Theme.Rows.sealGlyph
    ZStack {
      Circle().fill(passed ? Theme.Affect.okTint : Theme.Affect.badTint)
      if passed {
        TickShape(points: [CGPoint(x: 3.5, y: 8.5), CGPoint(x: 6.5, y: 11.5), CGPoint(x: 12.5, y: 5)])
          .stroke(Theme.Affect.ok, style: StrokeStyle(lineWidth: Theme.Rows.sealTickWidth * g / 16, lineCap: .round, lineJoin: .round))
          .frame(width: g, height: g)
      } else {
        CrossShape(inset: 4.5).stroke(Theme.Affect.bad, style: StrokeStyle(lineWidth: Theme.Rows.sealCrossWidth * g / 16, lineCap: .round))
          .frame(width: g, height: g)
      }
    }
    .frame(width: Theme.Rows.seal, height: Theme.Rows.seal)
    .accessibilityHidden(true)
  }
}

/// The seal and its words: "Passed review" / "Didn't pass review".
package struct VerdictLine: View {
  package let verdict: Verdict
  package init(verdict: Verdict) { self.verdict = verdict }
  package var body: some View {
    HStack(spacing: Theme.Rows.verdictGap) {
      Seal(passed: verdict.passed)
      Text(verbatim: verdict.title).font(Theme.Rows.verdictFont).foregroundStyle(Theme.Rows.verdictText)
    }
    .accessibilityElement(children: .combine)
  }
}

/// A reviewer's reasons as a list (13/20, 18 pt indent).
package struct ReasonsList: View {
  package let reasons: [String]
  package init(reasons: [String]) { self.reasons = reasons }
  package var body: some View {
    VStack(alignment: .leading, spacing: Theme.Rows.bulletGap) {
      ForEach(Array(reasons.enumerated()), id: \.offset) { _, r in
        HStack(alignment: .firstTextBaseline, spacing: 0) {
          Text(verbatim: "•").frame(width: Theme.Rows.bulletIndent, alignment: .leading).accessibilityHidden(true)
          Text(verbatim: r).textSelection(.enabled).fixedSize(horizontal: false, vertical: true)
        }
      }
    }
    .font(Theme.Rows.cardFont).foregroundStyle(Theme.Rows.cardText).lineSpacing(Theme.Affect.bodySpacing)
  }
}
#endif
