#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdThread
import CapcomdBot


struct ThreadView: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String
  @State private var size = (total: CGFloat(0), scroll: CGFloat(0), content: CGFloat(0))
  /// The row that was first when the page above was asked for: put back at the top once that page is in.
  @State private var keep: String?

  var body: some View {
    let agent = model.run(runId)?.agents[agentId]
    let entries = model.threadEntries(agentId)
    VStack(alignment: .leading, spacing: 0) {
      ThreadHeader(runId: runId, agentId: agentId)
      ScrollViewReader { proxy in ScrollView {
        LazyVStack(alignment: .leading, spacing: 0) {
          // Read newest first (agents.thread_tail): the task and the thread's start wait above the page that loads
          // as the top scrolls into view.
          // The page goes in above and the row that was first goes back to the top, so what you read stays put.
          if model.threadTop(agentId) != nil {
            HStack(spacing: 6) {
              if model.threadLoadingEarlier(agentId) { ProgressView().controlSize(.mini) }
              Text(verbatim: model.threadLoadingEarlier(agentId) ? "Loading earlier messages…" : "Earlier messages")
            }
            .font(Theme.Content.otherFont).foregroundStyle(Theme.Content.otherText).frame(maxWidth: .infinity, minHeight: 28)
            .contentShape(Rectangle())
            .onAppear { loadEarlier(entries) }
            .onTapGesture { loadEarlier(entries) }
          } else if let task = agent?.task { TaskRow(task: task).id(agentId) }
          ForEach(Array(entries.enumerated()), id: \.element.id) { n, e in
            switch e {
            case .item(let i, let next): ThreadItemRow(runId: runId, agentId: agentId, item: i, next: next, above: n == 0 ? 0 : Self.bottomMargin(entries[n - 1]))
            case .event(let ev): ThreadItemView(runId: runId, agentId: agentId, item: ev).padding(.bottom, Theme.Content.proseBottom)
            }
          }
          if case .failed(let why)? = model.threadUnavailable(agentId) {
            HStack(spacing: Theme.Content.toolGap) {
              Text(verbatim: "Couldn't load the thread (\(why))")
              Button("Retry") { Task { await model.refreshThread(runId: runId, agentId: agentId) } }.buttonStyle(.plain).foregroundStyle(Theme.accent)
            }
            .font(Theme.Content.otherFont).foregroundStyle(Theme.Content.otherText).padding(.bottom, Theme.Content.proseBottom)
          }
          // Steers still on their way; each is replaced by its message.sent once the daemon confirms it.
          ForEach(model.pendingSteers(agentId)) { p in
            SteerBubble(runId: runId, text: p.body, state: p.state,
                        onRetry: { model.retrySteer(runId: runId, agentId: agentId, p) },
                        onDiscard: { model.discardSteer(agentId: agentId, id: p.id) })
          }
        }
        .padding(Theme.Content.padding)
        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { size.content = $0; report() }
      }
      .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { size.scroll = $0; report() }
      .defaultScrollAnchor(.bottom)
      .onChange(of: entries.first?.id) { _, _ in
        guard let k = keep else { return }
        keep = nil
        proxy.scrollTo(k, anchor: .top)
        DispatchQueue.main.async { proxy.scrollTo(k, anchor: .top) }
      }
      }
      .padding(.horizontal, -Theme.Content.padding.leading + Theme.Drill.headerPadding.leading)   // .th bleeds to 16 inside the panel
      .mask(VStack(spacing: 0) {
        LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: Theme.Content.topFade)
        Color.black; LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: Theme.Content.fade) })
      .environment(\.openURL, OpenURLAction { url in open(url) })
      ThreadComposer(runId: runId, agentId: agentId)
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)   // an empty thread stays left-aligned
    .padding(Theme.Drill.padding)
    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { size.total = $0; report() }
    .navigationBarBackButtonHidden(true)
    .hiddenUnlessTop(.thread(runId: runId, agentId: agentId))
    .onChange(of: model.path.last == .thread(runId: runId, agentId: agentId)) { _, top in if top { report() } }
    // Follow live (thread=1 on the run's feed) and read from the cursor; a slow re-read covers a dropped stream.
    .task(id: agentId) {
      model.openThread(runId: runId, agentId: agentId)
      while !Task.isCancelled {
        await model.refreshThread(runId: runId, agentId: agentId)
        try? await Task.sleep(for: .seconds(Theme.Drill.threadRefreshSeconds))
      }
    }
    .onDisappear { model.closeThread(agentId: agentId) }
  }

  private func loadEarlier(_ entries: [ThreadEntry]) {
    guard keep == nil, !model.threadLoadingEarlier(agentId), let first = entries.first?.id else { return }
    keep = first
    Task {
      await model.loadEarlierThread(runId: runId, agentId: agentId)
      if model.threadEntries(agentId).first?.id == first { keep = nil }   // nothing came: nothing to put back
    }
  }

  static func bottomMargin(_ e: ThreadEntry) -> CGFloat {
    switch e { case .item(let i, _): ThreadItemRow.bottomMargin(i); case .event: Theme.Content.proseBottom }
  }

  /// The thread's natural height: everything around the scroll (header, composer) plus the scroll's content.
  private func report() {
    guard size.total > 0 else { return }
    guard model.path.last == .thread(runId: runId, agentId: agentId) else { return }   // a covered thread doesn't size the panel
    model.routeHeight = size.total - size.scroll + size.content
  }

  /// Link clicks: web links open in the browser (http/https only, checked when the link was built); agent and run
  /// links navigate. Anything else is ignored.
  private func open(_ url: URL) -> OpenURLAction.Result {
    switch url.scheme?.lowercased() {
    case "http", "https": NSWorkspace.shared.open(url); return .handled
    case ThreadLinkURL.scheme:
      let id = url.lastPathComponent
      switch url.host {
      case "agent": model.path.append(.thread(runId: runId, agentId: id)); return .handled
      case "run": model.open(run: id); return .handled
      default: return .discarded
      }
    default: return .discarded
    }
  }
}

/// `.hdr` at agent level: back, the bot, its name over one quiet line (role · project), and the status mark. The bot's
/// name leads; the role and project are context.
struct ThreadHeader: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String

  var body: some View {
    let agent = model.run(runId)?.agents[agentId]
    let node = findNode(model.tree(runId))
    let role = agent?.displayName ?? "Agent"
    let name = model.botName(runId: runId, agentId: agentId)
    let provided = model.provider(runId: runId, agentId: agentId)
    let context = [name == nil ? nil : role, provided?.provider.displayName, model.run(runId)?.title].compactMap { $0 }.joined(separator: " · ")
    HStack(spacing: Theme.Drill.headerGap) {
      Button { model.back() } label: {
        Image(systemName: "chevron.left").font(Theme.Drill.backIcon).foregroundStyle(Theme.Drill.switchOn)
          .frame(width: Theme.Drill.backSize, height: Theme.Drill.backSize)
          .background(ControlSurface(shape: Circle(), fallback: Theme.Drill.backFill))
      }
      .buttonStyle(PressableStyle()).accessibilityLabel("Back")
      .background { keyboardOnly("[") { withTransaction(Transaction(animation: nil)) { model.back() } } }
      HStack(spacing: Theme.Drill.headerGap) {
        // The waiting agent raises a floating mitt (Polish board, item 6); the amber mark still carries the state.
        let waiting = model.approvals(runId).contains { $0.agentId == agentId }
        let bot = model.bot(runId: runId, agentId: agentId)
        ProvidedBot(traits: waiting ? bot.flatMap { try? withOverrides($0, pose: "wave") } ?? bot : bot, size: .small, provider: provided?.provider)
          .help(provided.map { p in [p.provider.displayName, p.model].compactMap { $0 }.joined(separator: " · ") } ?? "")
        VStack(alignment: .leading, spacing: Theme.Drill.titleTop) {
          Text(verbatim: name ?? role).font(Theme.Drill.titleFont).tracking(Theme.Drill.titleTracking).foregroundStyle(Theme.Drill.switchOn)
          if !context.isEmpty { Text(verbatim: context).font(Theme.Drill.crumbFont).foregroundStyle(Theme.Drill.crumbText).truncationMode(.tail) }
        }
        .lineLimit(1)
        Spacer(minLength: 0)
        StatusMark(status: node?.statusSymbol)
      }
      .accessibilityElement(children: .combine)
    }
    .padding(Theme.Drill.headerPadding)
  }

  private func findNode(_ ns: [AgentNode]) -> AgentNode? {
    for n in ns { if n.id == agentId { return n }; if let f = findNode(n.children) { return f } }
    return nil
  }
}

#endif
