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

/// What the window shows while the sidebar is open. Nothing is built until the first open; from then on it stays built
/// and a toggle only shows or hides it. It lives in AppKit views of its own (`OpenedLayerView`): SwiftUI takes a view at
/// opacity 0 out of the window's view tree, so hiding it with SwiftUI re-added every AppKit-backed view on each open (the
/// pane, the scroll views, the text fields), and each addition recomputed the window's key-view loop over the reel too.
/// `isHidden` and a Core Animation transform keep them in place.
struct OpenedLayer: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.openSettings) private var openSettings
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  @Environment(\.threadHost) private var threadHost
  var body: some View {
    if model.nav.everOpened {
      OpenedLayerHost(model: model, open: model.nav.sidebarOpen, reduceMotion: reduceMotion,
                      openSettings: { openSettings() }, threadHost: threadHost)
    }
  }
}

struct OpenedLayerHost: NSViewRepresentable {
  let model: DeskModel
  let open: Bool
  let reduceMotion: Bool
  let openSettings: () -> Void
  let threadHost: ThreadHostBox?
  func makeNSView(context: Context) -> OpenedLayerView {
    OpenedLayerView(model: model, openSettings: openSettings, threadHost: threadHost, open: open)
  }
  func sizeThatFits(_ proposal: ProposedViewSize, nsView: OpenedLayerView, context: Context) -> CGSize? {
    proposal.replacingUnspecifiedDimensions(by: DeskWindowContent.minSize)
  }
  /// A click on the sidebar button animates (its transaction has an animation); the keyboard doesn't.
  func updateNSView(_ v: OpenedLayerView, context: Context) {
    v.set(open: open, animated: context.transaction.animation != nil && !context.transaction.disablesAnimations, reduceMotion: reduceMotion)
  }
}

/// The opened window's AppKit side: the sidebar (248 pt) and the pane area, each a hosting view laid out by frame. Shown
/// and hidden with `isHidden`; opening by a click slides the sidebar in by transform and fades the pane in (0.25 s,
/// ease-out, no bounce; Reduce Motion: a 0.15 s crossfade), folding the reverse. Nothing is laid out by the animation:
/// the frames are final from the start.
final class OpenedLayerView: NSView {
  private let sidebar: NSHostingView<AnyView>
  private let pane: NSHostingView<AnyView>
  private var open: Bool
  private var placed: CGSize = .zero
  /// Bumped per toggle: a fold's completion doesn't hide a layer that was opened again meanwhile.
  private var serial = 0

  init(model: DeskModel, openSettings: @escaping () -> Void, threadHost: ThreadHostBox?, open: Bool) {
    func root<V: View>(_ v: V) -> AnyView {
      AnyView(v.environment(model).environment(\.threadHost, threadHost ?? ThreadHostBox(host: model))
        .environment(\.deskOpenSettings, DeskSettingsOpener(open: openSettings)).preferredColorScheme(.dark))
    }
    sidebar = NSHostingView(rootView: root(SidebarView()))
    pane = NSHostingView(rootView: root(PaneArea()))
    self.open = open
    super.init(frame: .zero)
    wantsLayer = true
    for h in [pane, sidebar] {
      h.safeAreaRegions = []
      h.sizingOptions = []
      h.wantsLayer = true
      addSubview(h)
    }
    isHidden = !open
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    guard bounds.size != placed else { return }
    placed = bounds.size
    let w = SidebarMetrics.width
    sidebar.frame = CGRect(x: 0, y: 0, width: w, height: bounds.height)
    pane.frame = CGRect(x: w, y: 0, width: max(0, bounds.width - w), height: bounds.height)
  }

  func set(open o: Bool, animated: Bool, reduceMotion: Bool) {
    guard o != open else { return }
    open = o
    serial += 1
    let s = serial
    sidebar.layer?.removeAllAnimations(); pane.layer?.removeAllAnimations(); layer?.removeAllAnimations()
    guard animated else { isHidden = !o; return }
    if o { isHidden = false }
    CATransaction.begin()
    CATransaction.setCompletionBlock { [weak self] in
      guard let self, self.serial == s else { return }
      if !self.open { self.isHidden = true }
      self.sidebar.layer?.removeAllAnimations(); self.pane.layer?.removeAllAnimations(); self.layer?.removeAllAnimations()
    }
    if reduceMotion {
      layer?.add(Self.anim("opacity", from: o ? 0 : 1, to: o ? 1 : 0, duration: 0.15), forKey: "fade")
    } else {
      let w = Double(SidebarMetrics.width)
      sidebar.layer?.add(Self.anim("transform.translation.x", from: o ? -w : 0, to: o ? 0 : -w, duration: 0.25), forKey: "slide")
      pane.layer?.add(Self.anim("opacity", from: o ? 0 : 1, to: o ? 1 : 0, duration: 0.25), forKey: "fade")
    }
    CATransaction.commit()
  }

  /// Transform or opacity only, ease-out, held at its end until the completion block tidies up.
  private static func anim(_ key: String, from: Double, to: Double, duration: Double) -> CABasicAnimation {
    let a = CABasicAnimation(keyPath: key)
    a.fromValue = from; a.toValue = to; a.duration = duration
    a.timingFunction = CAMediaTimingFunction(controlPoints: 0.2, 0.8, 0.2, 1)
    a.fillMode = .both; a.isRemovedOnCompletion = false
    return a
  }
}

extension EnvironmentValues {
  /// The app's Settings window, handed into the opened layer's own hosting views (they aren't in the app's scene).
  @Entry var deskOpenSettings: DeskSettingsOpener? = nil
}

/// The Settings action, compared as always equal (it never changes), so carrying it in the environment invalidates nothing.
struct DeskSettingsOpener: Equatable {
  let open: () -> Void
  static func == (_: Self, _: Self) -> Bool { true }
}

/// The main area: one agent's pane, or Home (+ and ⌘0 show Home here, as folded; only while open, so there is one Home).
struct PaneArea: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("PaneArea")
    let open = model.nav.sidebarOpen
    return Group {
      if open, let np = model.newProject {
        HomeView(np: np)
      } else if let run = model.openRunId, let id = model.paneAgent {
        PaneHost(model: model, runId: run, agentId: id, open: open)
          .padding(.top, 8).padding(.trailing, 8).padding(.bottom, 8)
      } else if open, model.unreachable {
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
  /// Folded: hidden, and it keeps the agent it shows (a focus change in the reel doesn't rebuild it).
  let open: Bool
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
    if v.isHidden == open { v.isHidden = !open }
    guard open else { return }
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
