#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// Identity moments (brand direction B, design/brand/moments.png). Each plays once and never loops; the meaning is
/// in the text, the bots are decoration.

/// "Meet your team": a run's first seconds. The planner waves over the agents it spawns, joined by dotted pixel traces;
/// each child fades and rises 4 pt, 40 ms apart, 0.2 s each. Reduce Motion: one 150 ms crossfade. Then the card
/// becomes the agent tree.
struct MeetTeamView: View {
  @Environment(AppModel.self) private var model
  let runId: String

  var body: some View {
    let tree = model.tree(runId)
    let root = tree.first
    let kids = Array((root?.children ?? []).prefix(Theme.Moments.maxKids))
    VStack(spacing: 0) {
      if let root {
        let t = model.bot(runId: runId, agentId: root.id)
        ProvidedBot(traits: t.flatMap { try? withOverrides($0, pose: "wave") } ?? t, size: .full, cell: Theme.Moments.leadCell,
                    provider: model.provider(runId: runId, agentId: root.id)?.provider)
          .accessibilityHidden(true)
        label(root.name, t?.name, big: true).padding(.top, Theme.Moments.labelTop)
        if !kids.isEmpty {
          TeamTraces(count: kids.count).frame(height: Theme.Moments.traceHeight).padding(.top, Theme.Moments.traceTop)
          HStack(alignment: .top, spacing: 0) {
            ForEach(Array(kids.enumerated()), id: \.element.id) { i, k in
              TeamMember(index: i) {
                VStack(spacing: Theme.Moments.memberGap) {
                  ProvidedBot(traits: model.bot(runId: runId, agentId: k.id), size: .full, cell: 1, provider: model.provider(runId: runId, agentId: k.id)?.provider)
                  label(k.name, model.bot(runId: runId, agentId: k.id)?.name, big: false)
                }
              }
              .frame(maxWidth: .infinity)
            }
          }
        }
        HStack(spacing: Theme.Moments.statusGap) {
          StatusMark(status: .running)
          Text(verbatim: root.activity ?? "Planning").font(Theme.Moments.statusFont).foregroundStyle(Theme.Moments.statusText).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.top, Theme.Moments.statusTop)
      }
    }
    .padding(.vertical, Theme.Moments.padding)
    .accessibilityElement(children: .combine)
    .accessibilityLabel("Meet your team: " + ([root?.name].compactMap { $0 } + kids.map(\.name)).joined(separator: ", "))
  }

  private func label(_ role: String, _ name: String?, big: Bool) -> some View {
    Group {
      if big {
        HStack(spacing: 4) {
          Text(verbatim: role).foregroundStyle(Theme.Moments.roleText)
          if let name { Text(verbatim: name).foregroundStyle(Theme.Moments.nameText) }
        }
        .font(Theme.Moments.leadFont)
      } else {
        VStack(spacing: 0) {
          Text(verbatim: role).font(Theme.Moments.memberFont).foregroundStyle(Theme.Moments.roleText)
          if let name { Text(verbatim: name).font(Theme.Moments.memberFont).foregroundStyle(Theme.Moments.nameText) }
        }
      }
    }
    .lineLimit(1)
  }
}

/// One child's entrance: fade + rise 4 pt, staggered; a plain crossfade with Reduce Motion.
private struct TeamMember<Content: View>: View {
  let index: Int
  @ViewBuilder let content: () -> Content
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var shown = false
  var body: some View {
    content()
      .opacity(shown ? 1 : 0)
      .offset(y: shown || reduceMotion ? 0 : Theme.Moments.rise)
      .onAppear {
        let a: Animation = reduceMotion ? .easeOut(duration: Theme.Moments.reducedFade)
          : .easeOut(duration: Theme.Moments.memberFade).delay(Double(index) * Theme.Moments.stagger)
        withAnimation(a) { shown = true }
      }
  }
}

/// The orchestration board's dotted pixel traces: a stem from the planner, a bus, and a drop to each child.
private struct TeamTraces: View {
  let count: Int
  var body: some View {
    Canvas { ctx, size in
      let style = StrokeStyle(lineWidth: Theme.Moments.traceWidth, dash: Theme.Polish.traceDash)
      let slot = size.width / CGFloat(count), xs = (0..<count).map { (CGFloat($0) + 0.5) * slot }
      let mid = size.height / 2
      var p = Path()
      p.move(to: CGPoint(x: size.width / 2, y: 0)); p.addLine(to: CGPoint(x: size.width / 2, y: mid))
      if let first = xs.first, let last = xs.last { p.move(to: CGPoint(x: first, y: mid)); p.addLine(to: CGPoint(x: last, y: mid)) }
      for x in xs { p.move(to: CGPoint(x: x, y: mid)); p.addLine(to: CGPoint(x: x, y: size.height)) }
      ctx.stroke(p, with: .color(Theme.Polish.brand.opacity(Theme.Moments.traceOpacity)), style: style)
    }
    .accessibilityHidden(true)
  }
}

/// "Run finished": once, for about 2 s, then the card collapses to its finished line. The team switches to the cheer
/// pose and a happy face; non-orchestrators put on party hats; confetti is static, laid out by mulberry32 seeded by
/// the run id. Never on failure.
struct CelebrationCard: View {
  @Environment(AppModel.self) private var model
  let project: Project
  let run: Run

  var body: some View {
    let parts = (project.endedLine ?? "Done").components(separatedBy: " · ")
    let team = members()
    VStack(alignment: .leading, spacing: 0) {
      HStack(alignment: .firstTextBaseline) {
        Text(verbatim: project.title).font(Theme.Card.titleFont).tracking(Theme.Card.titleTracking).foregroundStyle(Theme.Card.titleText).lineLimit(1)
        Spacer(minLength: 8)
        Text(verbatim: parts[0]).font(Theme.Finished.trailingFont).foregroundStyle(Theme.Finished.trailingText)
      }
      HStack(spacing: Theme.Moments.cheerGap) {
        ForEach(team, id: \.self) { t in BotAvatar(traits: t, size: .full, cell: team.count <= Theme.Moments.maxCheer ? 2 : 1) }
      }
      .frame(maxWidth: .infinity)
      .padding(.vertical, Theme.Moments.cheerPadding)
      .overlay { Confetti(seed: run.id) }
      HStack(spacing: 6) {
        Image(systemName: "checkmark").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.Moments.statusText)
        Text(verbatim: (["Finished"] + parts.dropFirst()).joined(separator: " · ")).font(Theme.Moments.statusFont).foregroundStyle(Theme.Moments.statusText)
      }
    }
    .padding(.top, Theme.Card.paddingTop).padding(.horizontal, Theme.Card.paddingHorizontal).padding(.bottom, Theme.Moments.cheerBottom)
    .background(RoundedRectangle(cornerRadius: Theme.cardRadius, style: .continuous).fill(Theme.cardFill))
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(project.title) finished, \(parts.joined(separator: ", "))")
  }

  /// Orchestrators first (they keep their crown and flag), then the rest in spawn order.
  private func members() -> [BotTraits] {
    let agents = run.agents.values.sorted { a, b in
      let oa = a.kind == .planner || a.kind == .lead, ob = b.kind == .planner || b.kind == .lead
      return oa != ob ? oa : (a.spawnedAtMs, a.id) < (b.spawnedAtMs, b.id)
    }
    return agents.prefix(Theme.Moments.maxCheer).compactMap { a in
      guard let t = model.bot(runId: run.id, agentId: a.id) else { return nil }
      let orchestrator = a.kind == .planner || a.kind == .lead
      return (try? withOverrides(t, mood: .happy, pose: "cheer", accessory: orchestrator ? nil : "party")) ?? t
    }
  }
}

/// Static confetti: small brand-coloured squares, placed by mulberry32 seeded by the run, so a run always throws the same.
private struct Confetti: View {
  let seed: String
  var body: some View {
    Canvas { ctx, size in
      var rng = botRNG(seed: seed, stream: "confetti")
      let colors = Theme.Moments.confetti
      for _ in 0..<Theme.Moments.confettiCount {
        let x = CGFloat(rng.next() % 10_000) / 10_000 * size.width, y = CGFloat(rng.next() % 10_000) / 10_000 * size.height
        let s: CGFloat = rng.next() % 2 == 0 ? 2 : 3
        ctx.fill(Path(CGRect(x: x.rounded(), y: y.rounded(), width: s, height: s)), with: .color(colors[Int(rng.next() % UInt32(colors.count))]))
      }
    }
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}
#endif
