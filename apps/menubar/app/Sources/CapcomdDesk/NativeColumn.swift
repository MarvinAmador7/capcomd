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
  let agentId: String
  private let model: DeskModel
  private let head: NSHostingView<AnyView>
  private let body: NSHostingView<AnyView>
  /// The size the head and body were placed for: placing is skipped until it changes.
  private var placed: CGSize = .zero
  private var stroke: (asks: Bool, focused: Bool)?
  /// The stroke, drawn over the head and body as SwiftUI's `strokeBorder` draws it: the same continuous rounded
  /// rectangle, inset by half the line (a layer border antialiases its corners differently).
  private let edge = StrokeView()

  init(agentId: String, model: DeskModel) {
    self.agentId = agentId
    self.model = model
    head = NSHostingView(rootView: AnyView(ColumnHeadHost(agentId: agentId).environment(model).preferredColorScheme(.dark)))
    body = NSHostingView(rootView: AnyView(ColumnBody(agentId: agentId)
      .environment(model).environment(\.threadHost, ThreadHostBox(host: model)).preferredColorScheme(.dark)))
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
    let h = Theme.Desk.columnHeader
    head.frame = CGRect(x: 0, y: 0, width: bounds.width, height: h)
    body.frame = CGRect(x: 0, y: h, width: bounds.width, height: max(0, bounds.height - h))
    edge.frame = bounds
    edge.update()
  }

  /// The stroke reads the agent's `approval` and `focused`; when either changes the column applies it again, once the
  /// change has landed (observation calls back before the set), in the same turn of the run loop.
  private func observe() {
    withObservationTracking { [weak self] in self?.apply() } onChange: { [weak self] in
      RunLoop.main.perform { MainActor.assumeIsolated { self?.observe() } }
    }
  }

  private func apply() {
    DeskProbe.body("Column", id: agentId)
    let a = model.agent(agentId)
    let asks = a?.approval != nil, focused = a?.focused ?? false
    guard stroke.map({ $0 != (asks, focused) }) ?? true else { return }
    stroke = (asks, focused)
    edge.color = NSColor(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke).cgColor
    edge.lineWidth = asks || focused ? 1 : 0.5
    edge.update()
  }
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
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) {
      ColumnHead(slice: a)
        .contentShape(Rectangle())
        .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}

/// The native column's body: the thread (once warm), then the message box or the decision it waits on.
struct ColumnBody: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) {
      VStack(spacing: 0) {
        if a.warm {
          ColumnThread(runId: a.header.runId, agentId: agentId, thread: model.thread(agentId))
            .task(id: agentId) { await model.keepThreadFresh(agentId: agentId) }
        } else {
          Color.clear.frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        if let ap = a.approval { DecisionBar(approval: ap) } else { ColumnComposer(agentId: agentId, name: a.header.name) }
      }
      .contentShape(Rectangle())
      .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
    }
  }
}
#endif
