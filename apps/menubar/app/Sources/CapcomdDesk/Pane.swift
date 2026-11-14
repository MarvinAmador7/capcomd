#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// The opened window (RexMain): the sidebar over the window's left 248 pt and, beside it, one agent's pane. The title bar
// goes; the pane's 44 pt header is the top line. The reel stays built underneath at its own size (folding shows it as
// it was, and a toggle never reflows it); the pane is an AppKit column (NativeColumnView, `.pane`) with the reel's own
// thread, message box and decision.

/// What the window shows while the sidebar is open. Empty while folded: nothing of it is built or observed then.
struct OpenedLayer: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  var body: some View {
    let open = model.nav.sidebarOpen
    return ZStack(alignment: .topLeading) {
      if open {
        // At its final frame from the first pass: only opacity changes while the sidebar slides.
        PaneArea().padding(.leading, SidebarMetrics.width).transition(.opacity)
        SidebarView().transition(reduceMotion ? .opacity : .move(edge: .leading))
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
  }
}

/// The main area: one agent's pane, or Home (+ and ⌘0 show Home here, as folded).
struct PaneArea: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("PaneArea")
    return Group {
      if let np = model.newProject {
        HomeView(np: np)
      } else if let run = model.openRunId, let id = model.paneAgent {
        PaneHost(model: model, runId: run, agentId: id)
          .padding(.top, 8).padding(.trailing, 8).padding(.bottom, 8)
      } else if model.unreachable {
        Unreachable()
      } else {
        Color.clear
      }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .background(Theme.Desk.ground)
  }
}

/// The pane: the reel's AppKit column in its pane style, configured with whichever agent the sidebar selects. A new run
/// (another project) makes new slices, so it starts its views anew even for an agent id it showed before.
struct PaneHost: NSViewRepresentable {
  let model: DeskModel
  let runId: String
  let agentId: String
  final class Coordinator { var runId = "" }
  func makeCoordinator() -> Coordinator { Coordinator() }
  func makeNSView(context: Context) -> NativeColumnView {
    context.coordinator.runId = runId
    return NativeColumnView(agentId: agentId, model: model, style: .pane)
  }
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: NativeColumnView, context: Context) -> CGSize? {
    proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
  }
  func updateNSView(_ v: NativeColumnView, context: Context) {
    if context.coordinator.runId != runId { context.coordinator.runId = runId; v.forget() }
    v.configure(agentId)
  }
}

/// The pane header's host: `PaneHead` on the agent's slice. A click focuses the pane, as anywhere in it.
struct PaneHeadHost: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) { PaneHead(slice: a) }
  }
}

/// RexMain `.ph`: the head, its title (a double-click renames it), profile, short ID, status; on the right the project ·
/// place · elapsed, then the pane's controls.
struct PaneHead: View {
  @Environment(DeskModel.self) private var model
  let slice: AgentSlice
  var body: some View {
    DeskProbe.body("PaneHead", id: slice.id)
    let h = slice.header, asks = slice.approval != nil
    let deck = model.decks.first { $0.runId == h.runId }
    let place = Place(sandbox: deck?.sandbox).map { $0 == .local ? "This Mac" : "boxd" }
    return HStack(spacing: 8) {
      BotAvatar(traits: slice.bot, size: .small, cell: 1).frame(width: 24, height: 24)
      if slice.renaming == .header {
        InlineTitleField(agentId: slice.id, font: .system(size: 13, weight: .semibold), width: Theme.Desk.headerField)
      } else {
        Text(verbatim: h.tabLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.Desk.text)
          .lineLimit(1).truncationMode(.tail).layoutPriority(1)
          .contentShape(Rectangle())
          .onTapGesture(count: 2) { if model.store.titlesSupported { model.beginRename(slice.id, at: .header) } }
          .help(slice.renameFailure.map { "Couldn't rename it: \($0)" } ?? "Double-click to rename")
      }
      Text(verbatim: h.name).font(.system(size: 13)).foregroundStyle(Theme.Desk.secondary).fixedSize()
      Text(verbatim: String(h.agentId.suffix(4))).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.Desk.tertiary).fixedSize()
      Text(verbatim: "· " + ColumnHead.state(h, asks: asks)).font(.system(size: 13))
        .foregroundStyle(asks ? Theme.amber : h.status == .failed ? Theme.red : Theme.Desk.tertiary).fixedSize()
      Spacer(minLength: 8)
      HStack(spacing: 0) {
        Text(verbatim: [deck?.title, place].compactMap { $0 }.joined(separator: " · "))
          .lineLimit(1).truncationMode(.tail)
        if h.status == .running, let start = h.startedAtMs {
          Text(verbatim: " · ")
          Text(Date(timeIntervalSince1970: Double(start) / 1000), style: .timer).monospacedDigit()
        }
      }
      .font(.system(size: 11.5, design: .monospaced)).foregroundStyle(Theme.Desk.tertiary)
      .padding(.trailing, 6)
      PaneControls(slice: slice)
    }
    .lineLimit(1)
    .padding(.leading, 14).padding(.trailing, 8)
    .frame(height: Theme.Desk.paneHeader)
    .contentShape(Rectangle())
    .accessibilityElement(children: .contain)
  }
}

/// The pane's controls, right of its header (RexMain `.ctl`: 26 pt buttons). Its slots are the seams for the work built
/// on this pane: splits (⌘D right, ⇧⌘D down) go in `PaneSplitSlot`, expand (⇧⌘↩, arrows-out) in `PaneExpandSlot`. Both
/// are empty for now, so the header lays out the same once they're filled.
struct PaneControls: View {
  let slice: AgentSlice
  var body: some View {
    HStack(spacing: 0) {
      PaneSplitSlot(agentId: slice.id)
      PaneMore(slice: slice)
      PaneExpandSlot(agentId: slice.id)
    }
  }
}

/// Split right / split down: not built yet (a later change adds them here).
struct PaneSplitSlot: View {
  let agentId: String
  var body: some View { EmptyView() }
}

/// Expand to the window / back: not built yet (a later change adds it here).
struct PaneExpandSlot: View {
  let agentId: String
  var body: some View { EmptyView() }
}

/// The pane's •••: the same daemon actions as its row's.
struct PaneMore: View {
  @Environment(DeskModel.self) private var model
  let slice: AgentSlice
  var body: some View {
    let h = slice.header
    let row = SidebarRow(id: h.agentId, runId: h.runId, projectId: model.openProjectId ?? "", title: h.tabLabel, bot: slice.bot,
                         provider: h.provider, level: 0, word: nil, tone: .plain)
    return Menu {
      ForEach(model.agentMenu(row), id: \.self) { item in
        if case .copyId = item { Divider() }
        Button { model.perform(item, on: row) } label: {
          if case .copyId(let short) = item { Text("Copy Agent ID (\(short))") } else { Text(item.title) }
        }
      }
    } label: {
      Image(systemName: "ellipsis").font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(red: 0x7D / 255, green: 0x7D / 255, blue: 0x85 / 255))
    }
    .menuStyle(.borderlessButton)
    .menuIndicator(.hidden)
    .fixedSize()
    .frame(width: 26, height: 26)
    .help("More")
    .accessibilityLabel("More for \(h.tabLabel)")
  }
}
#endif
