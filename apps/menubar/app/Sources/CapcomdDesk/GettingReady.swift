#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdUI

/// An agent's thread before its first item: what the daemon is doing to get it ready (capability agents.setup), so a
/// minute and a half of copying a repository isn't an empty pane. Over the thread while the thread has no item of the
/// agent's own; it fades as the first one arrives. Reads only its agent's `preparing` and its thread's entries, so a
/// progress change (at most one a second) re-renders this and nothing else.
struct GettingReadyOverlay: View {
  @Environment(DeskModel.self) private var model
  @Environment(\.needsReel) private var inNeeds
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let agentId: String
  /// The column's thread when it shows one (a cold reel column has none read: it shows the state on its own).
  let thread: ThreadSlice?
  var body: some View {
    let p = shown
    ZStack {
      if let p { GettingReady(preparing: p).transition(.opacity) }
    }
    .frame(maxWidth: .infinity, maxHeight: .infinity)
    .allowsHitTesting(false)
    .animation(Theme.Motion.ease(reduceMotion), value: p == nil)
  }
  /// Shown while the agent gets ready and its thread has nothing of its own yet (your messages to it may be there).
  private var shown: Preparing? {
    guard let p = model.agent(agentId, inNeeds: inNeeds)?.preparing else { return nil }
    let own = thread?.entries.contains { if case .item = $0 { return true }; return false } ?? false
    return own ? nil : p
  }
}

/// The getting-ready block, centred in the empty thread: the line ("Copying the repository…"), the copy's bar when the
/// daemon sent its total, and a meta line with its progress and how long the agent has been at it.
struct GettingReady: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let preparing: Preparing
  var body: some View {
    VStack(alignment: .center, spacing: Theme.Desk.readyGap) {
      Text(verbatim: preparing.line + "…").font(Theme.Desk.label).foregroundStyle(Theme.Desk.secondary)
        .multilineTextAlignment(.center)
      if let f = preparing.fraction {
        Capsule().fill(Theme.Desk.readyTrack)
          .overlay(alignment: .leading) {
            // The fill is the track scaled from its leading edge: a transform, never a width change.
            Capsule().fill(Theme.Desk.readyFill).scaleEffect(x: max(0.001, f), y: 1, anchor: .leading)
              .animation(reduceMotion ? nil : Theme.Motion.standard, value: f)
          }
          .frame(width: Theme.Desk.readyWidth, height: Theme.Desk.readyBar)
          .accessibilityHidden(true)
      }
      if preparing.detail != nil || preparing.sinceMs != nil {
        HStack(spacing: 0) {
          if let d = preparing.detail { Text(verbatim: d) }
          if preparing.detail != nil, preparing.sinceMs != nil { Text(verbatim: " · ") }
          if let since = preparing.sinceMs {
            Text(Date(timeIntervalSince1970: Double(since) / 1000), style: .timer).monospacedDigit()
          }
        }
        .font(Theme.Desk.meta).foregroundStyle(Theme.Desk.tertiary)
      }
    }
    .frame(width: Theme.Desk.readyWidth)
    .accessibilityElement(children: .combine)
    .accessibilityLabel(preparing.line + (preparing.detail.map { ", " + $0 } ?? ""))
  }
}
#endif
