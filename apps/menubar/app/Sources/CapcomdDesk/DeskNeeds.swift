#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore

// The Needs you seam (RexNotes "The Needs you hand", RexNeedsReel). The rail's hand, the sidebar header's hand and the
// Needs you heading call `openNeedsReel()`; ⌘J (Go › Next Ask) calls `stepToNextAsk()`. The Needs you reel itself is
// built separately: it replaces `openNeedsReel()`'s body. Until then the hand shows the oldest ask, as ⌘J does.

extension DeskModel {
  /// The hand (rail or sidebar header) or the Needs you heading: the reel of every agent that needs you, oldest first.
  /// Stub: shows the first agent in Needs you (the oldest ask) until the Needs you reel lands.
  package func openNeedsReel() {
    stepToNextAsk()
  }

  /// ⌘J: the next agent that needs you, one at a time, in Needs you's order (wrapping); it doesn't animate.
  package func stepToNextAsk() {
    let rows = sidebar.content.needs.flatMap(\.rows)
    guard !rows.isEmpty else { return }
    let at = selectedAgent.flatMap { id in rows.firstIndex { $0.id == id } }
    selectRow(rows[at.map { ($0 + 1) % rows.count } ?? 0])
  }
}
#endif
