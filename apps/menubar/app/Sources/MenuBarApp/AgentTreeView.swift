#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// SPEC §4.4 / tree-card-v3: an outline with hairline guides. 26 pt rows: chevron · profile icon · name · suffix ·
/// folder chip · status. Under a row, at its name column: its approval when it waits, else its live activity. A
/// collapsed ancestor shows the amber hand when anything below it waits.
struct AgentTreeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  var compact: Bool
  @State private var collapsed: Set<String> = []

  var body: some View {
    let tree = model.tree(runId)
    let showFolders = tree.folders.count > 1   // one folder for the whole run: the card's scope chip already says it
    VStack(alignment: .leading, spacing: 0) {
      ForEach(tree.outline(collapsed: collapsed)) { line in
        AgentTreeRow(runId: runId, line: line, showFolder: showFolders) { toggle(line.node.id) }
        under(line)
      }
    }
  }

  @ViewBuilder private func under(_ line: TreeLine) -> some View {
    let node = line.node
    let approvals = model.approvals(runId).filter { $0.agentId == node.id }
    if !approvals.isEmpty {
      ForEach(approvals) { ApprovalCard(approval: $0) }
        .padding(.leading, Theme.Tree.nameInset(node.depth) + Theme.Approval.leadingExtra)
        .overlay(alignment: .topLeading) { TreeGuides(guides: line.below, row: false) }
    } else if node.status == .running, let act = node.activity {
      // Daemon-written (trusted), still verbatim: never markdown.
      Text(verbatim: act).font(Theme.Tree.activityFont).foregroundStyle(Theme.Tree.activityText)
        .lineLimit(1).truncationMode(.tail)
        .frame(height: Theme.Tree.activityHeight)
        .padding(.leading, Theme.Tree.nameInset(node.depth))
        .padding(.top, Theme.Tree.activityTop).padding(.bottom, Theme.Tree.activityBottom)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(alignment: .topLeading) { TreeGuides(guides: line.below, row: false) }
        .transition(.opacity)
    }
  }

  private func toggle(_ id: String) {
    withAnimation(Theme.Motion.ease(reduceMotion)) { if collapsed.contains(id) { collapsed.remove(id) } else { collapsed.insert(id) } }
  }
}

/// `.gd` columns, drawn to the full height of whatever they sit beside: a line straight through, a tee into this row,
/// or an elbow for a last child (rows only).
struct TreeGuides: View {
  let guides: [TreeGuide]
  let row: Bool
  var body: some View {
    Canvas { ctx, size in
      for (i, g) in guides.enumerated() {
        let x = CGFloat(i) * Theme.Tree.indent + Theme.Tree.guideX
        var p = Path()
        switch g {
        case .blank: continue
        case .line: p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: size.height))
        case .tee, .elbow:
          let y = row ? Theme.Tree.guideElbowY : 0
          p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: g == .tee ? size.height : y))
          if row { p.move(to: CGPoint(x: x, y: y)); p.addLine(to: CGPoint(x: x + Theme.Tree.guideArm, y: y)) }
        }
        // Circuit traces (Polish board, item 1): dotted guides, and a small square node where a branch splits off.
        ctx.stroke(p, with: .color(Theme.Tree.guide), style: StrokeStyle(lineWidth: Theme.Tree.guideWidth, dash: Theme.Polish.traceDash))
        if row, g == .tee || g == .elbow {
          let n = Theme.Polish.traceNode
          ctx.fill(Path(CGRect(x: x - n / 2, y: Theme.Tree.guideElbowY - n / 2, width: n, height: n)), with: .color(Theme.Tree.guide))
        }
      }
    }
    .frame(width: CGFloat(guides.count) * Theme.Tree.indent)
    .allowsHitTesting(false)
    .accessibilityHidden(true)
  }
}

struct AgentTreeRow: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var blinking = false
  let runId: String
  let line: TreeLine
  let showFolder: Bool
  let onToggle: () -> Void

  /// The bot, with a still glow behind its visor while it runs (item 2) and a blink when the pointer arrives (item 3).
  @ViewBuilder private func avatar(_ node: AgentNode) -> some View {
    let traits = model.bot(runId: runId, agentId: node.id)
    let shown = blinking ? traits.flatMap { try? withOverrides($0, mood: .sleepy) } : traits
    BotAvatar(traits: shown, size: .xs)
      .background {
        if node.status == .running, let t = traits, let glow = BotVisor.glow(t, size: .xs) {
          let side = CGFloat(BotAvatar.cells(.xs))
          Ellipse().fill(RadialGradient(colors: [glow.color.opacity(Theme.Polish.glowOpacity), glow.color.opacity(0)], center: .center,
                                        startRadius: 0, endRadius: Theme.Polish.glowSize.width / 2))
            .frame(width: Theme.Polish.glowSize.width, height: Theme.Polish.glowSize.height)
            .offset(x: glow.center.x - side / 2, y: glow.center.y - side / 2)
            .allowsHitTesting(false)
        }
      }
      .onHover { inside in
        guard inside, !reduceMotion, !blinking else { return }
        blinking = true
        Task { try? await Task.sleep(for: .seconds(Theme.Polish.blink)); blinking = false }
      }
  }

  var body: some View {
    let node = line.node
    let bubbled = line.collapsed && node.descendantWaiting && !node.waiting
    HStack(spacing: 0) {
      Button(action: onToggle) {
        Image(systemName: "chevron.right").font(Theme.Tree.chevronFont).foregroundStyle(Theme.Tree.chevronText)
          .rotationEffect(.degrees(line.collapsed ? 0 : 90)).opacity(node.children.isEmpty ? 0 : 1)
          .frame(width: Theme.Tree.chevron, height: Theme.Tree.rowHeight).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(node.children.isEmpty)
      .accessibilityLabel(line.collapsed ? "Expand \(node.name)" : "Collapse \(node.name)")
      avatar(node)   // the waiting state stays the amber mark
        .help(model.botName(runId: runId, agentId: node.id) ?? "")
        .frame(width: Theme.Tree.icon).padding(.leading, Theme.Tree.iconLeading).padding(.trailing, Theme.Tree.iconTrailing)
      Button { model.path.append(.thread(runId: runId, agentId: node.id)) } label: {
        HStack(spacing: 0) {
          Text(verbatim: node.name)
            .font(node.status == .running ? Theme.Tree.nameRunningFont : Theme.Tree.nameFont)
            .foregroundStyle(node.status == .running ? Theme.Tree.nameRunning : node.status == .pending ? Theme.Tree.nameQueued : Theme.Tree.nameText)
            .lineLimit(1)
          if let s = node.suffix {
            Text(verbatim: s).font(Theme.Tree.suffixFont).foregroundStyle(Theme.Tree.suffixText).padding(.leading, Theme.Tree.suffixLeading).lineLimit(1)
          }
          Spacer(minLength: 0)
          if showFolder, let repo = node.repo, repo != node.suffix {
            HStack(spacing: Theme.Tree.chipGap) {
              Image(systemName: "folder").font(Theme.Tree.chipIcon)
              Text(verbatim: repo).font(Theme.Tree.chipFont).lineLimit(1)
            }
            .foregroundStyle(Theme.Tree.chipText)
            .padding(.leading, Theme.Tree.chipLeading)
          }
        }
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      if let p = model.provider(runId: runId, agentId: node.id) {
        ProviderMark(provider: p.provider, size: Theme.Provider.rowSize).foregroundStyle(Theme.Provider.rowText)
          .padding(.leading, Theme.Provider.rowLeading)
          .help([p.provider.displayName, p.model].compactMap { $0 }.joined(separator: " · "))
      }
      // The column is kept on every row (an ended agent has no mark), so chips and provider marks line up.
      Color.clear.frame(width: Theme.Tree.statusColumn, height: 1)
        .overlay(alignment: .trailing) { StatusMark(status: bubbled ? .waiting : node.statusSymbol) }
        .padding(.leading, Theme.Tree.statusLeading)
    }
    .frame(height: Theme.Tree.rowHeight)
    .padding(.leading, CGFloat(line.guides.count) * Theme.Tree.indent)
    .overlay(alignment: .topLeading) { TreeGuides(guides: line.guides, row: true) }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(node.accessibilityLabel + (model.botName(runId: runId, agentId: node.id).map { ", \($0)" } ?? ""))
    .accessibilityHint("Opens its thread")
  }
}
#endif
