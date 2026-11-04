#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// SPEC §4.4 / tree-card-v3: an outline with hairline guides. 26 pt rows: chevron · profile icon · name · title (the
/// suffix only when siblings share a title, or from an older daemon) · folder chip · status. Rename… (the row's context
/// menu) edits the title in place: Return saves, Esc cancels, an empty name clears yours. Under a row, at its name column: its approval when it waits, else its live activity. A
/// collapsed ancestor shows the amber hand when anything below it waits.
struct AgentTreeView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let runId: String
  var compact: Bool
  /// The approval under its waiting agent; off inside the Active card, whose body shows the ask (direction B).
  var showApprovals = true
  /// 26 pt (tree-card-v3), or 24 pt in the Active card's unfolded tree (design/active-card, `.b-tree`).
  var rowHeight: CGFloat = Theme.Tree.rowHeight
  @State private var collapsed: Set<String> = []

  var body: some View {
    let tree = model.tree(runId)
    let showFolders = tree.folders.count > 1   // one folder for the whole run: the card's scope chip already says it
    VStack(alignment: .leading, spacing: 0) {
      ForEach(tree.outline(collapsed: collapsed)) { line in
        AgentTreeRow(runId: runId, line: line, showFolder: showFolders, rowHeight: rowHeight) { toggle(line.node.id) }
        under(line)
      }
    }
  }

  @ViewBuilder private func under(_ line: TreeLine) -> some View {
    let node = line.node
    let approvals = model.approvals(runId).filter { $0.agentId == node.id }
    if showApprovals && !approvals.isEmpty {
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
  /// Where a row's elbow meets it: the middle of a 26 pt row (tree-card-v3), or of the 24 pt rows in the Active card.
  var elbowY: CGFloat = Theme.Tree.guideElbowY
  var body: some View {
    Canvas { ctx, size in
      for (i, g) in guides.enumerated() {
        let x = CGFloat(i) * Theme.Tree.indent + Theme.Tree.guideX
        var p = Path()
        switch g {
        case .blank: continue
        case .line: p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: size.height))
        case .tee, .elbow:
          let y = row ? elbowY : 0
          p.move(to: CGPoint(x: x, y: 0)); p.addLine(to: CGPoint(x: x, y: g == .tee ? size.height : y))
          if row { p.move(to: CGPoint(x: x, y: y)); p.addLine(to: CGPoint(x: x + Theme.Tree.guideArm, y: y)) }
        }
        // Circuit traces (Polish board, item 1): dotted guides, and a small square node where a branch splits off.
        ctx.stroke(p, with: .color(Theme.Tree.guide), style: StrokeStyle(lineWidth: Theme.Tree.guideWidth, dash: Theme.Polish.traceDash))
        if row, g == .tee || g == .elbow {
          let n = Theme.Polish.traceNode
          ctx.fill(Path(CGRect(x: x - n / 2, y: elbowY - n / 2, width: n, height: n)), with: .color(Theme.Tree.guide))
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
  /// Renaming it in place (agents.title): the field's draft, nil while it isn't.
  @State private var renaming: TitleEdit?
  @FocusState private var renameFocused: Bool
  let runId: String
  let line: TreeLine
  let showFolder: Bool
  var rowHeight: CGFloat = Theme.Tree.rowHeight
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
          .frame(width: Theme.Tree.chevron, height: rowHeight).contentShape(Rectangle())
      }
      .buttonStyle(.plain).disabled(node.children.isEmpty)
      .accessibilityLabel(line.collapsed ? "Expand \(node.name)" : "Collapse \(node.name)")
      avatar(node)   // the waiting state stays the amber mark
        .help(model.botName(runId: runId, agentId: node.id) ?? "")
        .frame(width: Theme.Tree.icon).padding(.leading, Theme.Tree.iconLeading).padding(.trailing, Theme.Tree.iconTrailing)
      // While it's renamed the row is the field, not a button (a click in the field would open the thread).
      if renaming != nil { rowContent(node).frame(maxWidth: .infinity, alignment: .leading) }
      else {
        Button { model.open(run: runId, agent: node.id) } label: { rowContent(node).contentShape(Rectangle()) }
          .buttonStyle(PressableStyle())
      }
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
    .frame(height: rowHeight)
    // The agent focused in the window (the store's selection).
    .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Theme.accent.opacity(0.14))
      .opacity(model.selection.map { $0.runId == runId && $0.agentId == node.id } == true ? 1 : 0))
    .padding(.leading, CGFloat(line.guides.count) * Theme.Tree.indent)
    .overlay(alignment: .topLeading) { TreeGuides(guides: line.guides, row: true, elbowY: rowHeight / 2) }
    .accessibilityElement(children: .combine)
    .accessibilityLabel(node.accessibilityLabel + (model.botName(runId: runId, agentId: node.id).map { ", \($0)" } ?? ""))
    .accessibilityHint("Opens its column in the capcomd window")
    .contextMenu { Button("Rename…") { beginRename() } }
    .accessibilityAction(named: "Rename") { beginRename() }
  }

  /// Name, title (or the rename field), suffix, folder chip.
  @ViewBuilder private func rowContent(_ node: AgentNode) -> some View {
    HStack(spacing: 0) {
      Text(verbatim: node.name)
        .font(node.status == .running ? Theme.Tree.nameRunningFont : Theme.Tree.nameFont)
        .foregroundStyle(node.status == .running ? Theme.Tree.nameRunning : node.status == .pending ? Theme.Tree.nameQueued : Theme.Tree.nameText)
        .lineLimit(1)
      if renaming != nil { renameField(node) }
      else if let t = node.title {
        // Agent-written: plain text, never markdown.
        Text(verbatim: t).font(Theme.Tree.titleFont).foregroundStyle(Theme.Tree.titleText).padding(.leading, Theme.Tree.titleLeading)
          .lineLimit(1).truncationMode(.tail).layoutPriority(-1)
      }
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
  }

  private func beginRename() { renaming = model.titleEdit(runId: runId, agentId: line.node.id); renameFocused = true }

  /// The title as a field: Return saves (a name capcomd would refuse keeps it open, outlined), Esc or a click
  /// elsewhere cancels.
  @ViewBuilder private func renameField(_ node: AgentNode) -> some View {
    let draft = Binding(get: { renaming?.draft ?? "" }, set: { renaming?.draft = $0 })
    TextField("Name", text: draft)
      .textFieldStyle(.plain).font(Theme.Tree.titleFont).lineLimit(1)
      .focused($renameFocused)
      .onSubmit {
        guard let e = renaming else { return }
        if case .invalid = e.commit { renameFocused = true; return }
        renaming = nil
        model.rename(runId: runId, agentId: node.id, e.commit)
      }
      .onExitCommand { renaming = nil }
      .onChange(of: renameFocused) { _, f in if !f { renaming = nil } }
      .padding(.horizontal, 3)
      .frame(width: Theme.Tree.titleField, height: 18)
      .overlay(RoundedRectangle(cornerRadius: 4).strokeBorder(renaming?.error != nil ? Theme.red.opacity(0.8) : Theme.accent.opacity(0.6), lineWidth: 1))
      .help(renaming?.error ?? "Return saves · Esc cancels · empty clears your name")
      .padding(.leading, Theme.Tree.titleLeading)
  }
}
#endif
