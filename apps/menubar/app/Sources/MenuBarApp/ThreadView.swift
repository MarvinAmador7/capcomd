#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §4.5 agent thread, limited to what harness.v1 carries (gap G3). All agent text is `Text(verbatim:)`:
/// no markdown, no autolinks, no actions.
struct ThreadView: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String

  var body: some View {
    let agent = model.run(runId)?.agents[agentId]
    let node = findNode(model.tree(runId))
    VStack(alignment: .leading, spacing: 10) {
      HStack(spacing: 6) {
        Button { model.back() } label: { Image(systemName: "chevron.left") }
          .buttonStyle(.plain).keyboardShortcut("[", modifiers: .command).accessibilityLabel("Back")
        Text(verbatim: "\(model.run(runId)?.title ?? runId) / \(agent?.displayName ?? "Agent")").font(Theme.chip).foregroundStyle(.secondary).lineLimit(1)
      }
      HStack(spacing: 6) {
        ProfileIcon(kind: agent?.kind ?? .other, tint: node?.iconTint ?? .grey)
        Text(verbatim: agent?.displayName ?? "Agent").font(Theme.panelTitle)
        if let s = node?.suffix { Text(verbatim: s).font(Theme.monoTime).foregroundStyle(.tertiary) }
        StatusMark(status: node?.statusSymbol)
      }
      if let task = agent?.task {
        RedactableText(text: task).font(Theme.body).foregroundStyle(.primary.opacity(0.88)).textSelection(.enabled)
      }
      if let att = agent?.taskAttachment { Text(verbatim: att.label).font(Theme.chip).foregroundStyle(.tertiary) }
      if let sum = agent?.resultSummary {
        VStack(alignment: .leading, spacing: 4) {
          Text("Result").font(Theme.chip).foregroundStyle(.tertiary)
          RedactableText(text: sum).font(Theme.body).textSelection(.enabled)   // untrusted: plain text only
        }
      }
      ScrollView {
        VStack(alignment: .leading, spacing: 8) {
          ForEach(model.thread(agentId)) { ThreadItemView(runId: runId, agentId: agentId, item: $0) }
        }
      }
      .mask(VStack(spacing: 0) { Color.black; LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom).frame(height: 16) })
    }
    .padding(Theme.inset)
    .navigationBarBackButtonHidden(true)
  }

  private func findNode(_ ns: [AgentNode]) -> AgentNode? {
    for n in ns { if n.id == agentId { return n }; if let f = findNode(n.children) { return f } }
    return nil
  }
}

struct ThreadItemView: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let agentId: String
  let item: ThreadItem
  var body: some View {
    switch item.kind {
    case .status(let s):
      Text(verbatim: s).font(Theme.chip).foregroundStyle(.tertiary)
    case .notice(let kind, let detail):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "wrench").foregroundStyle(.secondary).font(.system(size: 11))
        Text(verbatim: kind).font(Theme.monoTime).foregroundStyle(.tertiary)
        RedactableText(text: detail).font(Theme.body)
      }
    case .checkpoint(let reason, let files):
      HStack(alignment: .firstTextBaseline, spacing: 6) {
        Image(systemName: "arrow.triangle.branch").foregroundStyle(.secondary).font(.system(size: 11))
        RedactableText(text: reason).font(Theme.body)
        if let f = files { Text(verbatim: "\(f) files").font(Theme.monoTime).foregroundStyle(.tertiary) }
      }
    case .steer(let bytes):
      HStack { Spacer()
        Text(verbatim: bytes.map { "Message sent (\($0) bytes)" } ?? "Message sent").font(Theme.body)
          .padding(.horizontal, 10).padding(.vertical, 6)
          .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(0.07)))
      }
    case .message(let from, let to, let text, let attachment):
      let outgoing = from == agentId
      HStack { if outgoing { Spacer() }
        VStack(alignment: outgoing ? .trailing : .leading, spacing: 4) {
          Text(verbatim: outgoing ? "to \(to)" : "from \(from)").font(Theme.monoTime).foregroundStyle(.tertiary)
          if let t = text { RedactableText(text: t).font(Theme.body).textSelection(.enabled) }
          if let a = attachment { Text(verbatim: a.label).font(Theme.chip).foregroundStyle(.tertiary) }
        }
        .padding(.horizontal, 10).padding(.vertical, 6)
        .background(RoundedRectangle(cornerRadius: 10).fill(Color.white.opacity(outgoing ? 0.07 : 0.04)))
        if !outgoing { Spacer() }
      }
    case .handoff(let childId, let name, let summary, let artifacts):
      Button { model.path.append(.thread(runId: runId, agentId: childId)) } label: {
        VStack(alignment: .leading, spacing: 6) {
          HStack(spacing: 6) {
            Text(verbatim: name).font(Theme.body.weight(.semibold))
            Text("handed back").font(Theme.chip).foregroundStyle(.tertiary)
            Spacer()
            Image(systemName: "chevron.right").foregroundStyle(.tertiary)
          }
          if let s = summary { RedactableText(text: s).font(Theme.body).foregroundStyle(.primary.opacity(0.88)).multilineTextAlignment(.leading) }
          if !artifacts.isEmpty {
            HStack(spacing: 4) { ForEach(artifacts, id: \.self) { Chip(text: $0.plain) } }
          }
        }
        .padding(Theme.cardPadding)
        .background(RoundedRectangle(cornerRadius: Theme.cardRadius).fill(Theme.cardFill))
      }
      .buttonStyle(.plain)
    }
  }
}
#endif
