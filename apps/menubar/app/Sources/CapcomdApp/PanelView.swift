#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// MenuBarExtra panel: project cards (SPEC §4.1). 380 pt wide on a HUD material.
struct PanelView: View {
  @Environment(AppModel.self) private var model
  @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @State private var listContent: CGFloat = 0

  /// 380 pt, or wider when the composer's tool row needs it (a long driver name), never past the screen.
  private var panelWidth: CGFloat {
    let need = model.composerRowWidth + 2 * (Theme.Card.listPadding + Theme.Composer2.padding.leading)
    let screen = (NSScreen.main?.visibleFrame.width ?? 1440) - Theme.Panel.screenMargin
    return min(max(Theme.panelWidth, need.rounded(.up)), screen)
  }

  /// The visible screen's content height, clamped to Theme.Panel and the screen.
  private var panelHeight: CGFloat {
    let ideal = model.listHeight
    let screen = (NSScreen.main?.visibleFrame.height ?? 900) - Theme.Panel.screenMargin
    guard ideal > 0 else { return min(Theme.Panel.initialHeight, screen) }
    return min(max(ideal, Theme.Panel.minHeight), Theme.Panel.maxHeight, screen)
  }

  var body: some View {
    if model.needsToken {
      // Reading the Keychain, pairing, or something the window helps with (AppSession).
      PanelConnect().frame(width: Theme.panelWidth).background(.ultraThinMaterial)
    } else {
      // The panel and the window are two views of one app: every row opens the window on its run or agent.
      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          let projects = model.projects
          // A project whose run just completed stays up as its celebration for a moment, then drops to the finished rows.
          let active = projects.filter { $0.isActive || model.celebrating($0) != nil }
          let finished = Array(projects.filter { !$0.isActive && model.celebrating($0) == nil }.prefix(Theme.Finished.maxRows))
          PanelHeader()
          StartProjectField().padding(.top, Theme.Composer.sectionTop)
          if model.daemonUnreachable {
            // Quiet, not red: usually a restart. What's below is the last state the daemon sent.
            HStack(spacing: 6) {
              ProgressView().controlSize(.mini)
              Text("Can't reach capcomd. Reconnecting…")
              Spacer(minLength: 0)
              if model.session.cli != nil && model.session.start != .starting && model.session.start != .started {
                Button("Start capcomd") { model.session.startDaemon() }.buttonStyle(.link)
                  .accessibilityHint("Starts capcomd now and at every login.")
              }
            }
            .font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText)
            .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
            .accessibilityElement(children: .combine)
            .transition(.opacity)
          } else if let skew = model.versionSkew {
            Text(skew.message)
              .font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText)
              .padding(.horizontal, Theme.Composer.panelPadding).padding(.top, 6)
              .fixedSize(horizontal: false, vertical: true)
          }
          // While a folder's next steps show, an empty Active section steps aside (design/setup/InlineSetup).
          let quiet = active.isEmpty && model.setupShowing
          if !quiet {
            Text("Active").font(Theme.Card.sectionFont).foregroundStyle(Theme.Card.sectionText)
              .padding(.top, Theme.Card.sectionTop).padding(.leading, Theme.Card.sectionLeading).padding(.bottom, Theme.Card.sectionBottom)
          }
          ForEach(active) { p in
            Group {
              if let r = model.celebrating(p) { CelebrationCard(project: p, run: r) } else { ActiveCardView(project: p) }
            }
            .padding(.bottom, Theme.cardGap).transition(.opacity)
          }
          if active.isEmpty && !quiet {
            VStack(spacing: 10) {
              PixelWordmark()   // Polish board, item 7
              Text(projects.isEmpty ? "No projects yet" : "Nothing running").font(Theme.Finished.titleFont).foregroundStyle(Theme.Finished.trailingText)
            }
            .frame(maxWidth: .infinity)
              .padding(.vertical, Theme.Finished.paddingVertical).padding(.horizontal, Theme.Finished.paddingHorizontal)
          }
          // Finished and failed projects leave the Active cards: the latest few stay as one-line rows.
          if !finished.isEmpty {
            Text("Recent").font(Theme.Card.sectionFont).foregroundStyle(Theme.Card.sectionText)
              .padding(.top, Theme.Card.sectionTop).padding(.leading, Theme.Card.sectionLeading).padding(.bottom, Theme.Card.sectionBottom)
          }
          // The newest finished project folds to its outcome (direction B); the ones before it stay one row each.
          ForEach(Array(finished.enumerated()), id: \.element.id) { i, p in
            Group { if i == 0 { OutcomeRow(project: p).padding(.bottom, Theme.cardGap) } else { RecentRow(project: p, index: i + 1) } }
              .transition(.opacity)
          }
        }
        .padding(Theme.Card.listPadding)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { listContent = $0; model.listHeight = listContent }
        .animation(Theme.Motion.ease(reduceMotion), value: model.projects.map { "\($0.id)\($0.isActive)\(model.celebrating($0) != nil)" })
      }
    .frame(width: panelWidth, height: panelHeight)
    .transaction(value: panelHeight) { $0.animation = nil }   // layout changes snap (SPEC §7); only content fades
    .transaction(value: panelWidth) { $0.animation = nil }
    // MenuBarExtra(.window) sizes its window once; resize it ourselves, top edge pinned under the menu bar.
    .background(PanelWindowSizer(height: panelHeight, width: panelWidth))
    // The container (Composer board): 26 pt continuous corners, our own material and hairline, clipped to the shape.
    .background {
      let shape = RoundedRectangle(cornerRadius: Theme.Panel.radius, style: .continuous)
      ZStack {
        if reduceTransparency { shape.fill(Theme.Craft.solidPanel) } else { shape.fill(.ultraThinMaterial) }
        shape.strokeBorder(Theme.Panel.stroke, lineWidth: 0.5)
      }
    }
    .clipShape(RoundedRectangle(cornerRadius: Theme.Panel.radius, style: .continuous))
    }
  }
}

/// The panel's header: Open capcomd (⌘O), the window on whatever is in focus.
private struct PanelHeader: View {
  @Environment(AppModel.self) private var model
  var body: some View {
    HStack {
      Spacer(minLength: 0)
      Button { model.openWindow() } label: {
        HStack(spacing: 4) {
          Text("Open capcomd")
          Image(systemName: "macwindow").imageScale(.small)
        }
        .font(Theme.Composer.errorFont).foregroundStyle(Theme.Composer.kbdText).contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .keyboardShortcut("o", modifiers: .command)
      .help("Open the capcomd window (⌘O)")
      .accessibilityHint("Opens the capcomd window")
    }
    .padding(.horizontal, Theme.Composer.panelPadding)
  }
}
/// A recent project (Composer board "Continue" rows): its planner's bot on a tile in the bot's palette, the run's title,
/// how it ended (its mark, then in words), and ⌘1–⌘3 to open it. No counts beyond the approved "· n repos".
struct RecentRow: View {
  @Environment(AppModel.self) private var model
  let project: Project
  let index: Int
  @State private var hover = false
  var body: some View {
    let run = project.latestRun
    let root = run.flatMap { r in r.agents.values.filter { $0.parent == nil }.min { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) } }
    // A run that never had agents still gets a bot, seeded by the run: a blank tile read as a broken image.
    let bot = run.flatMap { r in root.flatMap { model.bot(runId: r.id, agentId: $0.id) } }
      ?? run.flatMap { botTeam([(seed: $0.id, role: "planner")]).first }
    let outcome = model.outcome(project)
    Button { if let run { model.open(run: run.id) } } label: {
      HStack(spacing: 12) {
        BotAvatar(traits: bot, size: .small)
          .frame(width: Theme.Composer2.tile, height: Theme.Composer2.tile)
          .background(RoundedRectangle(cornerRadius: Theme.Composer2.tileRadius, style: .continuous).fill(Self.tile(bot)))
          .overlay(RoundedRectangle(cornerRadius: Theme.Composer2.tileRadius, style: .continuous).strokeBorder(Color.white.opacity(0.18), lineWidth: 0.5))
        VStack(alignment: .leading, spacing: 2) {
          Text(verbatim: project.title).font(Theme.Composer2.rowTitle).foregroundStyle(Theme.Ask.text).lineLimit(1).truncationMode(.tail)
            .help(project.fullTitle)
          HStack(spacing: Theme.Composer2.rowMarkGap) {
            if let o = outcome { OutcomeMark(end: o.end, label: o.head, font: Theme.Composer2.rowMark) }
            Text(verbatim: project.endedLine ?? "Done").font(Theme.Composer2.rowSub).foregroundStyle(Theme.Composer2.rowSubText).lineLimit(1)
            // Its goal branch waits on a decision: a flag here, the Ready bar in its detail.
            if let run, let card = model.goalCard(run.id), let flag = card.rowFlag { GoalRowFlag(text: flag, stopped: card.stopped, branch: card.branch) }
          }
        }
        Spacer(minLength: 0)
        FinishSparkle(endedAtMs: run?.lastEventMs)
        if index <= 3 { KeyCap(text: "⌘\(index)") }
      }
      .padding(Theme.Composer2.rowPadding)
      .background(RoundedRectangle(cornerRadius: Theme.Composer2.rowRadius, style: .continuous).fill(hover ? Theme.Composer2.rowHover : .clear))
      .contentShape(RoundedRectangle(cornerRadius: Theme.Composer2.rowRadius, style: .continuous))
    }
    .buttonStyle(PressableStyle())
    .onHover { hover = $0 }
    .keyboardShortcut(index <= 3 ? KeyEquivalent(Character("\(index)")) : KeyEquivalent(Character("0")), modifiers: index <= 3 ? .command : [.command, .option, .control, .shift])
    // The words already say how it ended, except that its work merged.
    .accessibilityLabel([project.title, outcome?.end == .merged ? outcome?.head : nil, project.endedLine ?? "done",
                         run.flatMap { model.goalCard($0.id)?.rowFlag.map { "\($0): its goal branch waits on you" } }].compactMap { $0 }.joined(separator: ", "))
    .accessibilityHint("Opens it in the capcomd window")
  }

  /// The tile takes the bot's own body colours, darkened a touch so the bot reads on it.
  static func tile(_ t: BotTraits?) -> LinearGradient {
    let p = t.flatMap { try? BotCatalog.standard.part(.palette, $0.palette) }
    let a = p?.colors?["body1"].flatMap(Color.init(hex:)) ?? Theme.Polish.brand
    let b = p?.colors?["body2"].flatMap(Color.init(hex:)) ?? Theme.Polish.brand
    return LinearGradient(colors: [a.opacity(0.85), b.opacity(0.85)], startPoint: .top, endPoint: .bottom)
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
    .accessibilityHint("Opens it in the capcomd window")
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
  var width: CGFloat = Theme.panelWidth
  func makeNSView(context: Context) -> NSView { NSView() }
  func updateNSView(_ view: NSView, context: Context) {
    let h = height, w = width
    // Now, in the same update as the content: SwiftUI centres the panel in the window's old size until the window
    // matches, so resizing only a run-loop turn later showed one frame of a shrinking panel half the difference lower
    // (folding a task flashed the header down and back up). Again a turn later: MenuBarExtra applies its own size
    // after this update (on open, its first size), and ours must win.
    if let window = view.window { Self.fit(window, height: h, width: w) }
    DispatchQueue.main.async { if let window = view.window { Self.fit(window, height: h, width: w) } }
  }

  static func fit(_ window: NSWindow, height h: CGFloat, width w: CGFloat) {
    PanelWindowSizer.makeClear(window)
    let content = window.contentRect(forFrameRect: window.frame)
    guard abs(content.height - h) > 0.5 || abs(content.width - w) > 0.5 else { return }
    var frame = window.frameRect(forContentRect: NSRect(x: content.minX, y: content.maxY - h, width: w, height: h))
    frame.origin.y = window.frame.maxY - frame.height   // pin the top
    // Wider: keep the left edge on the menu bar item, as MenuBarExtra places it, unless that runs off the screen.
    if let vis = window.screen?.visibleFrame { frame.origin.x = min(max(frame.origin.x, vis.minX + 8), vis.maxX - frame.width - 8) }
    window.setFrame(frame, display: true, animate: false)
    window.invalidateShadow()   // the shadow follows our rounded container, not the window's rectangle
  }

  /// The container is ours (Composer board: 26 pt continuous corners): MenuBarExtra's window goes clear and its own
  /// background view is hidden, so only the panel's rounded shape (and its shadow) shows.
  static func makeClear(_ window: NSWindow) {
    guard let host = window.contentView else { return }
    window.isOpaque = false; window.backgroundColor = .clear; window.hasShadow = true
    // MenuBarExtra draws its own square-cornered backdrop (layers with no corner radius, filling the window) under ours.
    for v in host.subviews where v.frame.size == host.bounds.size {
      if let l = v.layer, l.cornerRadius == 0, l.backgroundColor != nil || String(describing: type(of: l)).contains("Backdrop") || String(describing: type(of: l)).contains("Chameleon") {
        v.isHidden = true
      }
    }
    window.invalidateShadow()
  }

}
#endif
