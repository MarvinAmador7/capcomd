#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdThread
import CapcomdBot
import CapcomdUI

/// The open project's agents as full-height columns in tree order (Reel). Lazy: only columns near the screen exist,
/// and only those load their threads. Snaps to a column edge; neighbours peek at both sides.
struct Reel: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    @Bindable var m = model
    GeometryReader { geo in
      let across = Theme.Desk.columnsAcross(geo.size.width)
      let inset = Theme.Desk.peek + Theme.Desk.gap
      let width = (geo.size.width - 2 * inset - CGFloat(across - 1) * Theme.Desk.gap) / CGFloat(across)
      ScrollView(.horizontal, showsIndicators: false) {
        LazyHStack(spacing: Theme.Desk.gap) {
          ForEach(model.columns, id: \.self) { id in
            Column(agentId: id).frame(width: max(320, width))
          }
        }
        .scrollTargetLayout()
        .padding(.bottom, Theme.Desk.gap)
      }
      .scrollTargetBehavior(.viewAligned)
      .scrollPosition(id: $m.reelPosition, anchor: .leading)
      .contentMargins(.horizontal, inset, for: .scrollContent)
      .onChange(of: across, initial: true) { _, n in if model.across != n { model.across = n } }
    }
  }
}

/// One agent: header, thread, and its message box (or the decision it waits on, docked at its foot).
struct Column: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) {
      let asks = a.approval != nil, focused = model.focusedAgent == agentId
      VStack(spacing: 0) {
        ColumnHead(slice: a)
        ColumnThread(runId: a.header.runId, agentId: agentId, thread: model.thread(agentId))
        if let ap = a.approval { DecisionBar(approval: ap) } else { ColumnComposer(agentId: agentId, name: a.header.name) }
      }
      .background(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous).fill(Theme.Desk.column))
      .overlay(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous)
        .strokeBorder(asks ? Theme.Desk.askStroke : focused ? Theme.accent.opacity(0.45) : Theme.Desk.columnStroke, lineWidth: asks || focused ? 1 : 0.5))
      .clipShape(RoundedRectangle(cornerRadius: Theme.Desk.columnRadius, style: .continuous))
      .contentShape(Rectangle())
      .onTapGesture { if model.focusedAgent != agentId { model.focusedAgent = agentId } }
      .task(id: agentId) { await model.keepThreadFresh(agentId: agentId) }
    }
  }
}

/// The column's header: bot, profile, its id suffix, bot name, state, place, and the system-drawn clock.
struct ColumnHead: View {
  let slice: AgentSlice
  var body: some View {
    let h = slice.header
    HStack(spacing: 8) {
      ProvidedBot(traits: slice.bot, size: .xs, cell: 1.5, provider: h.provider)
      Text(verbatim: h.name).font(Theme.Desk.name).foregroundStyle(Theme.Desk.text)
      if let s = h.suffix { Text(verbatim: s).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary) }
      if let n = slice.bot?.name { Text(verbatim: n).font(Theme.Desk.label).foregroundStyle(Theme.Desk.tertiary) }
      Text(verbatim: "· " + Self.state(h, asks: slice.approval != nil)).font(Theme.Desk.meta)
        .foregroundStyle(slice.approval != nil ? Theme.amber : h.status == .failed ? Theme.red : Theme.Desk.secondary)
      Spacer(minLength: 0)
      if let r = h.repo { Text(verbatim: r).font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary).lineLimit(1) }
      if h.status == .running {
        Text(Date(timeIntervalSince1970: Double(h.spawnedAtMs) / 1000), style: .timer)
          .font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary).monospacedDigit()
      }
    }
    .lineLimit(1)
    .padding(.horizontal, 12)
    .frame(height: Theme.Desk.columnHeader)
    .accessibilityElement(children: .combine)
  }
  static func state(_ h: ColumnHeader, asks: Bool) -> String {
    if asks { return "waiting on you" }
    switch h.status {
    case .running: return "working"; case .pending: return "queued"; case .done: return "done"
    case .failed: return "failed"; case .paused: return "paused"; case .cancelled: return "stopped"
    case .handedOff: return "handed back"; case .unknown: return "starting"
    }
  }
}

/// The thread: rows from the shared renderer, newest at the bottom. Rows are Equatable, so a new or changed item
/// re-renders that row only.
struct ColumnThread: View {
  let runId: String
  let agentId: String
  let thread: ThreadSlice
  var body: some View {
    let entries = thread.entries
    ScrollView {
      LazyVStack(alignment: .leading, spacing: 0) {
        ForEach(Array(entries.enumerated()), id: \.element.id) { n, e in
          EntryRow(runId: runId, agentId: agentId, entry: e, above: n == 0 ? 0 : Self.bottomMargin(entries[n - 1])).equatable()
        }
        if case .failed(let why)? = thread.unavailable {
          Text(verbatim: "Couldn't load the thread (\(why))").font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary)
        }
        ForEach(thread.pending) { p in SteerBubble(runId: runId, text: p.body, state: p.state) }
      }
      .padding(Theme.Desk.bodyPadding)
    }
    .defaultScrollAnchor(.bottom)
    .scrollIndicators(.never)
  }
  static func bottomMargin(_ e: ThreadEntry) -> CGFloat {
    switch e { case .item(let i, _): ThreadItemRow.bottomMargin(i); case .event: Theme.Content.proseBottom }
  }
}

struct EntryRow: View, Equatable {
  let runId: String
  let agentId: String
  let entry: ThreadEntry
  let above: CGFloat
  var body: some View {
    switch entry {
    case .item(let i, let next): ThreadItemRow(runId: runId, agentId: agentId, item: i, next: next, above: above)
    case .event(let ev): ThreadItemView(runId: runId, agentId: agentId, item: ev).padding(.bottom, Theme.Content.proseBottom)
    }
  }
}

/// The column's message box: plain text to this agent. The draft is the field's own state; nothing else re-renders
/// while you type.
struct ColumnComposer: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  let name: String
  @State private var draft = ""
  var body: some View {
    HStack(spacing: 8) {
      TextField("Tell \(name)…", text: $draft, axis: .vertical)
        .textFieldStyle(.plain).font(.system(size: 13)).lineLimit(1...5)
        .onSubmit(send)
      if !draft.isEmpty {
        Button(action: send) {
          Image(systemName: "arrow.up").font(.system(size: 11, weight: .bold)).foregroundStyle(Color(white: 0.11))
            .frame(width: 24, height: 24).background(Circle().fill(Theme.Desk.text))
        }
        .buttonStyle(PressableStyle()).accessibilityLabel("Send")
      }
    }
    .padding(.leading, 12).padding(.trailing, 8).padding(.vertical, 8)
    .frame(minHeight: Theme.Desk.composerHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.composerRadius, style: .continuous).fill(Theme.Desk.composerFill))
    .padding([.horizontal, .bottom], 12)
  }
  private func send() {
    let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !text.isEmpty else { return }
    model.steer(agentId: agentId, body: text); draft = ""
  }
}

/// The decision an agent waits on, docked at its column's foot: the question, then View diff · Deny · Approve ↩.
struct DecisionBar: View {
  @Environment(DeskModel.self) private var model
  let approval: PendingApproval
  var body: some View {
    let busy = approval.decision != .idle
    VStack(alignment: .leading, spacing: 8) {
      Text(verbatim: approval.question.plain).font(Theme.Desk.question).foregroundStyle(Theme.Desk.text)
        .fixedSize(horizontal: false, vertical: true)
      if let b = approval.branchLine { Text(verbatim: b).font(Theme.Desk.mono).foregroundStyle(Theme.Desk.secondary) }
      HStack(spacing: 8) {
        Spacer(minLength: 0)
        Button("Deny") { model.decide(approval.id, .deny) }
          .buttonStyle(DeskButton(kind: .outline))
        Button { model.decide(approval.id, .approve) } label: {
          HStack(spacing: 6) { Text("Approve"); Text("↩").font(.system(size: 10.5, weight: .semibold)).padding(.horizontal, 4).background(RoundedRectangle(cornerRadius: 4).fill(Color.black.opacity(0.12))) }
        }
        .buttonStyle(DeskButton(kind: .primary))
        .keyboardShortcut(.defaultAction)
      }
      .disabled(busy).opacity(busy ? 0.5 : 1)
    }
    .padding(.horizontal, 14).padding(.vertical, 12)
    .frame(maxWidth: .infinity, alignment: .leading)
    .background(Theme.Desk.decisionFill)
  }
}

/// The two button looks the window uses: the inverted Approve and the outlined secondary (menu bar's Theme.Ask).
struct DeskButton: ButtonStyle {
  enum Kind { case primary, outline }
  let kind: Kind
  func makeBody(configuration: Configuration) -> some View {
    configuration.label
      .font(.system(size: 12.5, weight: kind == .primary ? .semibold : .medium))
      .foregroundStyle(kind == .primary ? Color(red: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255) : Theme.Desk.text)
      .padding(.horizontal, 12).frame(minWidth: kind == .primary ? 104 : 0).frame(height: 28)
      .background(RoundedRectangle(cornerRadius: 7, style: .continuous).fill(kind == .primary ? Theme.Desk.text : .clear))
      .overlay(RoundedRectangle(cornerRadius: 7, style: .continuous).strokeBorder(kind == .primary ? .clear : Color.white.opacity(0.2), lineWidth: 0.5))
      .scaleEffect(configuration.isPressed ? 0.97 : 1)
      .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
  }
}
#endif
