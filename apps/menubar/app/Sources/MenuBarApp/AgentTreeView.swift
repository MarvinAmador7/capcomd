#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

/// SPEC §4.4: outline tree, 26 pt rows: chevron · profile icon · name · suffix · status. Approvals bubble up.
struct AgentTreeView: View {
  @Environment(AppModel.self) private var model
  let runId: String
  var compact: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      ForEach(model.tree(runId)) { AgentTreeRow(runId: runId, node: $0) }
    }
  }
}

struct AgentTreeRow: View {
  @Environment(AppModel.self) private var model
  let runId: String
  let node: AgentNode
  @State private var expanded = true

  var body: some View {
    VStack(alignment: .leading, spacing: 0) {
      HStack(spacing: 6) {
        Button { expanded.toggle() } label: {
          Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(.tertiary)
            .rotationEffect(.degrees(expanded ? 90 : 0)).opacity(node.children.isEmpty ? 0 : 1)
        }
        .buttonStyle(.plain).frame(width: 12).disabled(node.children.isEmpty)
        ProfileIcon(kind: node.kind, tint: node.waiting || (!expanded && node.descendantWaiting) ? .amber : node.iconTint)
        Button { model.path.append(.thread(runId: runId, agentId: node.id)) } label: {
          HStack(spacing: 4) {
            Text(verbatim: node.name).font(Theme.treeRowFont)
            if let s = node.suffix { Text(verbatim: s).font(Theme.monoTime).foregroundStyle(.tertiary) }
          }
        }
        .buttonStyle(.plain)
        Spacer()
        StatusMark(status: !expanded && node.descendantWaiting && !node.waiting ? .waiting : node.statusSymbol)
      }
      .frame(height: Theme.treeRow)
      .padding(.leading, CGFloat(node.depth) * 14)
      .overlay(alignment: .leading) {
        if node.depth > 0 { Rectangle().fill(Theme.hairline).frame(width: 0.5).padding(.leading, CGFloat(node.depth) * 14 - 8) }
      }
      .accessibilityElement(children: .combine)
      .accessibilityLabel(node.accessibilityLabel)
      if expanded {
        ForEach(node.children) { AgentTreeRow(runId: runId, node: $0) }
      }
    }
  }
}
#endif
