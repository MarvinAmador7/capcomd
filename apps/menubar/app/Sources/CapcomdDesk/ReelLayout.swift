#if canImport(SwiftUI) && os(macOS)
import AppKit
import CapcomdUI

/// The reel's frame engine (`desk.layout=frames`; design note: LAYOUT.md): the reel's geometry measured once per change
/// of its inputs (bounds, column count, backing scale) and every column placed by frame from it. Nothing in the reel is
/// measured through SwiftUI or Auto Layout.
///
/// The one thing it does differently from the fractional reel (`auto`) is snapping: the column width is rounded down to
/// the device pixel grid, so the pitch and every scroll offset are whole pixels and a column lands on a pixel at every
/// offset. With fractional columns (437.33 pt at 1440 pt) each step put every column's thread at a new sub-pixel
/// position, and each one's SwiftUI scroll view re-snapped its origin by a sixth of a point, which posts a scroll and
/// updates that column's view graph: every column, on every step, on screen or not.
/// What the bench asks the reel (its guards and drivers), whatever the reel keeps in its document: how many columns,
/// where column `i` is in the document, and the view showing it (nil: none, the placeholder shows). With a view per
/// column that is the column's view; with reused slots (`reel.columns=reuse`) the slot configured with it.
@MainActor package protocol ReelColumnViews: AnyObject {
  /// Which reel: the open project's, or the Needs you reel (both can be in the window; the second only while open).
  var reelKind: ReelKind { get }
  /// The reel's own horizontal scroll view.
  var reelScrollView: NSScrollView { get }
  var columnCount: Int { get }
  func columnFrame(at i: Int) -> CGRect
  func columnView(at i: Int) -> NSView?
}

package enum ReelKind: String, Sendable { case project, needs }

/// Columns leaving the Needs you reel (answered asks): which go, and which column leads after. The leading column keeps
/// its place when it stays (asks answered elsewhere, before it, don't move what you are reading); when it goes, the
/// column after it takes its place (the same index). Nil when nothing was removed (columns only added, or none
/// before): the reel then lays out as it always does.
package struct ReelRemoval: Equatable, Sendable {
  package var removed: [String]
  package var at: Int
  /// The leaving column's fade and lift, and the others closing up behind it: both start at once, under 300 ms.
  package static let leave: Double = 0.18
  package static let closeUp: Double = 0.24

  package static func plan(old: [String], new: [String], at: Int) -> ReelRemoval? {
    let keep = Set(new)
    let removed = old.filter { !keep.contains($0) }
    guard !removed.isEmpty, !new.isEmpty else { return removed.isEmpty ? nil : ReelRemoval(removed: removed, at: 0) }
    let lead = old.indices.contains(at) ? old[at] : nil
    if let lead, let j = new.firstIndex(of: lead) { return ReelRemoval(removed: removed, at: j) }
    // The leading column left: the first survivor after it takes its place.
    let survivorsBefore = old[..<min(at, old.count)].filter(keep.contains).count
    return ReelRemoval(removed: removed, at: min(survivorsBefore, new.count - 1))
  }
}

struct ReelGeometry: Equatable {
  /// Columns across, the column width and the pitch (width + gap), in points.
  var across = 0
  var width: CGFloat = 0
  var pitch: CGFloat = 0
  /// The inputs it was measured from: a geometry is stale when these change, and only then.
  var bounds: CGSize = .zero
  var count = 0
  var scale: CGFloat = 0

  static let gap = Theme.Desk.gap
  static let inset = Theme.Desk.peek + Theme.Desk.gap

  /// Measure: how many columns fit, how wide each is (snapped to the pixel grid when `snap`), and the pitch.
  static func measure(bounds: CGSize, count: Int, scale: CGFloat, snap: Bool = true) -> ReelGeometry {
    let n = Theme.Desk.columnsAcross(bounds.width)
    var w = max(320, (bounds.width - 2 * inset - CGFloat(n - 1) * gap) / CGFloat(n))
    if snap, scale > 0 { w = (w * scale).rounded(.down) / scale }
    return ReelGeometry(across: n, width: w, pitch: w + gap, bounds: bounds, count: count, scale: scale)
  }

  /// Place: column `i`'s frame in the reel's document. The leading edge is the fractional reel's, so the first column
  /// on screen is exactly where it was; the pixels the snapping gives up widen the trailing peek (≤ 1 pt per column).
  func frame(of i: Int) -> CGRect {
    CGRect(x: Self.inset + CGFloat(i) * pitch, y: 0, width: width, height: max(0, bounds.height - Self.gap))
  }

  /// The document's width: every column, a peek and a gap either side.
  var documentWidth: CGFloat { max(bounds.width, 2 * Self.inset + CGFloat(count) * pitch - Self.gap) }

  /// The columns on screen with column `at` leading, and one each side: the ones a move may show at once.
  func around(_ at: Int) -> ClosedRange<Int>? {
    guard count > 0, across > 0 else { return nil }
    let lo = max(0, min(at, count - 1) - 1), hi = min(count - 1, at + across)
    return lo...hi
  }
}
#endif
