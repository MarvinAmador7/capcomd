#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import Observation
import CapcomdUI

/// A column as an AppKit view (`desk.column=native`; design note: LAYOUT.md). Its layer is the column's frame: fill,
/// continuous corner, clip and stroke. Inside it, by frame, two hosting views: the head (`ColumnHead`, 40 pt) and the
/// body (thread, then the message box or the decision). The stroke follows focus and asks through observation, so a
/// focus change (every step) sets a layer border instead of re-rendering `Column` and laying out its whole SwiftUI
/// tree, thread included. Text, selection and accessibility stay SwiftUI's: the head and the body are the views the
/// SwiftUI column was made of.
final class NativeColumnView: NSView {
  /// The agent it shows. A reel slot (`reel.columns=reuse`) is configured with another as the reel moves.
  private(set) var agentId: String
  private let model: DeskModel
  /// Per-agent state a slot hands from one agent to the next (the message box's draft), when it is a slot.
  private let memory: SlotMemory?
  /// A reel column, or the opened window's one pane (PaneHead, 44 pt; no focus ring: the pane is the focus).
  private let style: ColumnStyle
  private let head: NSHostingView<AnyView>
  private let body: NSHostingView<AnyView>
  /// The size the head and body were placed for: placing is skipped until it changes.
  private var placed: CGSize = .zero
  private var stroke: (asks: Bool, focused: Bool)?
  /// The stroke, drawn over the head and body as SwiftUI's `strokeBorder` draws it: the same continuous rounded
  /// rectangle, inset by half the line (a layer border antialiases its corners differently).
  private let edge = StrokeView()
  /// In the Needs you reel: no amber ring (every column there asks).
  private let needs: Bool

  init(agentId: String, model: DeskModel, memory: SlotMemory? = nil, style: ColumnStyle = .reel, needs: Bool = false) {
    self.agentId = agentId
    self.model = model
    self.memory = memory
    self.style = style
    self.needs = needs
    head = NSHostingView(rootView: Self.head(agentId, model, style, needs))
    body = NSHostingView(rootView: Self.body(agentId, model, memory, style, needs))
    super.init(frame: .zero)
    wantsLayer = true
    layer?.backgroundColor = NSColor(Theme.Desk.column).cgColor
    layer?.cornerRadius = Theme.Desk.columnRadius
    layer?.cornerCurve = .continuous
    layer?.masksToBounds = true
    for h in [head, body] {
      h.safeAreaRegions = []
      h.sizingOptions = []   // placed by frame; nothing to measure
      addSubview(h)
    }
    addSubview(edge)
    observe()
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }

  override func layout() {
    super.layout()
    guard bounds.size != placed else { return }
    placed = bounds.size
    let h = style == .pane ? Theme.Desk.paneHeader : Theme.Desk.columnHeader
    head.frame = CGRect(x: 0, y: 0, width: bounds.width, height: h)
    body.frame = CGRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
    edge.frame = bounds
    edge.update()
  }

  private static func head(_ id: String, _ model: DeskModel, _ style: ColumnStyle, _ needs: Bool = false) -> AnyView {
    style == .pane ? AnyView(PaneHeadHost(agentId: id).id(id).environment(model).preferredColorScheme(.dark))
                   : AnyView(ColumnHeadHost(agentId: id).id(id).environment(model).environment(\.needsReel, needs).preferredColorScheme(.dark))
  }
  /// The body, identified by its agent: a slot configured with another agent starts its views (and their state) anew;
  /// what must follow the agent is in `memory`.
  private static func body(_ id: String, _ model: DeskModel, _ memory: SlotMemory?, _ style: ColumnStyle, _ needs: Bool = false) -> AnyView {
    AnyView(ColumnBody(agentId: id).id(id).environment(model).environment(\.threadHost, ThreadHostBox(host: model))
      .environment(\.slotMemory, memory).environment(\.deskPane, style == .pane).environment(\.needsReel, needs).preferredColorScheme(.dark))
  }

  /// A slot shows another agent: its head and body get that agent's views, its stroke that agent's state. Nothing is
  /// removed, added or moved: the reel sets the slot's frame.
  func configure(_ id: String) {
    guard id != agentId else { return }
    agentId = id
    head.rootView = Self.head(id, model, style, needs)
    body.rootView = Self.body(id, model, memory, style, needs)
    stroke = nil
    observe()
  }

  /// The opened pane leaving the window (the sidebar folds): its SwiftUI trees are emptied first, so they don't render
  /// the whole thread once more on the way out (a hosting view taken out of its window updates its environment).
  override func viewWillMove(toWindow newWindow: NSWindow?) {
    super.viewWillMove(toWindow: newWindow)
    guard style == .pane, newWindow == nil, window != nil else { return }
    head.rootView = AnyView(EmptyView())
    body.rootView = AnyView(EmptyView())
    agentId = ""
  }

  /// The project changed: the model made new slices for its agents, so whatever this slot shows is stale, even an
  /// agent of the same id. The next `configure` rebuilds.
  func forget() { agentId = "" }

  /// Bumped by each `observe`: a callback from an earlier observation (an earlier agent's) is dropped.
  private var generation = 0

  /// The stroke reads the agent's `approval` and `focused`; when either changes the column applies it again, once the
  /// change has landed (observation calls back before the set), in the same turn of the run loop.
  private func observe() {
    generation += 1
    let g = generation
    withObservationTracking { [weak self] in self?.apply() } onChange: { [weak self] in
      RunLoop.main.perform { MainActor.assumeIsolated { if let self, self.generation == g { self.observe() } } }
    }
  }

  private func apply() {
    DeskProbe.body(style == .pane ? "Pane" : "Column", id: agentId)
    let a = model.agent(agentId, inNeeds: needs)
    let asks = a?.approval != nil && !needs, focused = style == .reel && (a?.focused ?? false)
    guard stroke.map({ $0 != (asks, focused) }) ?? true else { return }
    stroke = (asks, focused)
    edge.color = NSColor(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke).cgColor
    edge.lineWidth = asks || focused ? 1 : 0.5
    edge.update()
  }
}

/// Where a column view is: in the reel, or the opened window's pane.
enum ColumnStyle { case reel, pane }

/// What the bench reads off a column view: whether it is the opened window's pane, and which agent it shows.
@MainActor package protocol DeskPaneProbe: AnyObject {
  var isPane: Bool { get }
  var shownAgent: String { get }
}

extension NativeColumnView: DeskPaneProbe {
  package var isPane: Bool { style == .pane }
  package var shownAgent: String { agentId }
}

extension EnvironmentValues {
  /// The view is in the opened window's pane (not the reel kept under it): its decision takes Return and its message
  /// box takes the focus only while the sidebar is open, the reel's only while it is folded.
  @Entry var deskPane = false
}

/// What follows an agent from one reel slot to the next (`reel.columns=reuse`): its message box's draft. The thread's
/// scroll position and unfolded thinking rows don't (a reconfigured slot shows the thread at its foot, folded).
@MainActor final class SlotMemory {
  var drafts: [String: String] = [:]
}

extension EnvironmentValues {
  /// The reel's slot memory when the column is a reused slot; nil otherwise (the box's draft is then its own state).
  @Entry var slotMemory: SlotMemory? = nil
}

/// The column's stroke: a shape layer over the column, never hit (clicks go to what is under it).
final class StrokeView: NSView {
  var color: CGColor?
  var lineWidth: CGFloat = 0.5
  private let shape = CAShapeLayer()
  private var drawn: (CGSize, CGFloat)?
  override init(frame: CGRect) {
    super.init(frame: frame)
    wantsLayer = true
    shape.fillColor = nil
    layer?.addSublayer(shape)
  }
  required init?(coder: NSCoder) { fatalError() }
  override var isFlipped: Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? { nil }

  func update() {
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    shape.strokeColor = color
    shape.lineWidth = lineWidth
    if drawn.map({ $0 != (bounds.size, lineWidth) }) ?? true {
      drawn = (bounds.size, lineWidth)
      shape.frame = bounds
      let r = bounds.insetBy(dx: lineWidth / 2, dy: lineWidth / 2)
      shape.path = RoundedRectangle(cornerRadius: max(0, Theme.Desk.columnRadius - lineWidth / 2), style: .continuous).path(in: r).cgPath
    }
    CATransaction.commit()
  }
}

/// The native column's head: `ColumnHead` on the agent's slice. A click focuses the column, as anywhere in it.
struct ColumnHeadHost: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.needsReel) private var inNeeds
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId, inNeeds: inNeeds) {
      ColumnHead(slice: a)
        .contentShape(Rectangle())
        .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}

/// The native column's body: the thread (once warm), then the message box or the decision it waits on.
struct ColumnBody: View {
  @Environment(DeskModel.self) private var model
  /// The opened pane always shows its thread: it is the one thing on screen (the reel's warm set is for the reel).
  @Environment(\.deskPane) private var inPane
  @Environment(\.needsReel) private var inNeeds
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId, inNeeds: inNeeds) {
      VStack(spacing: 0) {
        if inNeeds, let p = model.needs.place(agentId) { NeedsPlaceLine(place: p) }
        if a.warm || inPane {
          ColumnThread(runId: a.header.runId, agentId: agentId, thread: model.thread(agentId))
            .task(id: agentId) { await model.keepThreadFresh(agentId: agentId) }
        } else {
          Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if let ap = a.approval { DecisionBar(approval: ap, focused: a.focused) }
        else if let l = a.limit { LimitBar(limit: l, focused: a.focused) }
        else { ColumnComposer(agentId: agentId, name: a.header.name) }
      }
      .contentShape(Rectangle())
      .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}
#endif
