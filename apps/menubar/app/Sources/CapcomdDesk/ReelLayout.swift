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
