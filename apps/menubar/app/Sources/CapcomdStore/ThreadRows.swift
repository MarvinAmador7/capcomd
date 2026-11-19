import Foundation
import CapcomdThread

/// A line of the thread as it is drawn (thread v2, ThreadPolish-v2 on the design canvas): an entry as itself, finished
/// tool calls in a row folded into one "Used N tools" line, thinking in a row merged into one "Thinking · 5s" line.
/// Pure presentation of `[ThreadEntry]`, in their order: nothing is dropped or moved.
public enum ThreadRow: Sendable, Hashable, Identifiable {
  case entry(ThreadEntry)
  /// Two or more finished tool calls in a row.
  case tools(ToolRun)
  /// One or more thinking items in a row.
  case thinking(ThinkingRun)

  /// Keyed by the run's first item, so a group that grows keeps its place (and whether it is open).
  public var id: String {
    switch self {
    case .entry(let e): e.id
    case .tools(let r): "tools:\(r.items.first?.id ?? "")"
    case .thinking(let r): "think:\(r.items.first?.id ?? "")"
    }
  }

  /// Folds `entries` into rows. A run of tool calls takes calls that are done (a running call stays its own row, at the
  /// end, until it finishes and joins), and no edit with a diff (its card shows the change); anything else (a message,
  /// a thought, a hand-back, your steer) ends the run. One finished call stays its own row.
  public static func rows(_ entries: [ThreadEntry]) -> [ThreadRow] {
    var out: [ThreadRow] = []; out.reserveCapacity(entries.count)
    var tools: [CapcomdThread.Item] = []
    var thoughts: [CapcomdThread.Item] = []
    var afterThoughts: CapcomdThread.Item?   // the item after the last thought (its time runs to it)
    func flushTools() {
      if tools.count == 1 { out.append(.entry(.item(tools[0], next: nil))) }
      else if tools.count > 1 { out.append(.tools(ToolRun(tools))) }
      tools.removeAll(keepingCapacity: true)
    }
    func flushThoughts() {
      if !thoughts.isEmpty { out.append(.thinking(ThinkingRun(thoughts, next: afterThoughts))) }
      thoughts.removeAll(keepingCapacity: true)
    }
    for e in entries {
      if case .item(let i, let next) = e {
        if i.kind == "thinking" {
          flushTools()
          thoughts.append(i); afterThoughts = next
          continue
        }
        flushThoughts()
        if foldable(i) { tools.append(i); continue }
        flushTools()
        out.append(.entry(.item(i, next: next)))
      } else {
        flushTools()
        flushThoughts()
        out.append(.entry(e))
      }
    }
    flushTools()
    flushThoughts()
    return out
  }

  /// A finished call with no diff card.
  static func foldable(_ i: CapcomdThread.Item) -> Bool {
    i.kind == "tool" && !i.open && i.tool?.diff == nil
  }
}
