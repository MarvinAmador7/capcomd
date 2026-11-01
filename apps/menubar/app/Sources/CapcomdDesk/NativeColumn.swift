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
    guard stroke.map({ $0 != (asks, focused) }) ?? true, let layer else { return }
    stroke = (asks, focused)
    CATransaction.begin()
    CATransaction.setDisableActions(true)
    layer.borderColor = NSColor(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke).cgColor
    layer.borderWidth = asks || focused ? 1 : 0.5
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
