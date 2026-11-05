import Foundation
import XCTest
@testable import CapcomdOnboarding

/// The window's Home mark (design/desktop/Home.dc.html `.mark`) against the onboarding sprite and the prototype, read in
/// place: the same head (rows 0–11, columns 1–14 of the 16 × 16 sprite), in the prototype's greys, at its size,
/// opacity and dither.
final class HomeMarkTests: XCTestCase {
  static let html = try! String(contentsOf: Prototype.here.appendingPathComponent("../../../design/desktop/Home.dc.html").standardizedFileURL, encoding: .utf8)

  /// The mark's cells as the prototype draws them: one 6 px box-shadow per cell, offset by the 6 px box at left -6.
  func prototypeCells() throws -> [Cell] {
    let html = Self.html
    let start = try XCTUnwrap(html.range(of: "<div class=\"mark\""))
    let rest = html[start.upperBound...]
    let shadow = try XCTUnwrap(rest.range(of: "box-shadow: "))
    let list = rest[shadow.upperBound...].prefix { $0 != "\"" }
    let re = try NSRegularExpression(pattern: #"(-?\d+)px (-?\d+)px 0 0 (#[0-9A-Fa-f]{6})"#)
    let s = String(list)
    return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { m in
      let n = { (i: Int) in String(s[Range(m.range(at: i), in: s)!]) }
      return Cell(x: (Int(n(1))! - 6) / 6, y: Int(n(2))! / 6, color: RGB(hex: n(3)))
    }
  }

  func testTheMarkIsThePrototypesCellForCell() throws {
    let want = try prototypeCells()
    XCTAssertEqual(want.count, 120)
    let key = { (c: Cell) in "\(c.x),\(c.y)" }
    XCTAssertEqual(Dictionary(uniqueKeysWithValues: Sprite.mark().cells.map { (key($0), $0.color) }),
                   Dictionary(uniqueKeysWithValues: want.map { (key($0), $0.color) }))
  }

  func testTheMarkIsTheOnboardingBotsHead() {
    let mark = Sprite.mark(), head = Sprite.head(.orange)
    XCTAssertEqual(mark.width, 14); XCTAssertEqual(mark.height, 12)
    // The same cells as the onboarding's head: rows 0–11 and columns 1–14 of its 16 × 16 sprite.
    XCTAssertEqual(mark.cells.map { [$0.x, $0.y] }, head.cells.map { [$0.x, $0.y] })
    for c in mark.cells {
      let letter = Array(Sprite.rows[c.y])[c.x + 1]
      XCTAssertEqual(Sprite.markPalette[letter], c.color, "\(letter) at \(c.x),\(c.y)")
    }
    // Monochrome: every grey has r == g (and blue a touch cooler, as the window's greys are).
    for (_, c) in Sprite.markPalette { XCTAssertEqual(c.r, c.g); XCTAssertGreaterThanOrEqual(c.b, c.r) }
  }

  func testTheMarksSizeOpacityAndDitherAreThePrototypes() throws {
    let css = try XCTUnwrap(Self.html.range(of: ".mark{").map { Self.html[$0.upperBound...].prefix { $0 != "}" } }).description
    XCTAssertTrue(css.contains("width:84px;height:72px"))
    XCTAssertEqual(Sprite.mark().width * Sprite.markCell, 84); XCTAssertEqual(Sprite.mark().height * Sprite.markCell, 72)
    XCTAssertTrue(css.contains("opacity:.42")); XCTAssertEqual(Sprite.markOpacity, 0.42)
    XCTAssertTrue(css.contains("repeating-conic-gradient(#000 0 25%,rgba(0,0,0,.55) 0 50%)")); XCTAssertTrue(css.contains("mask-size:2px 2px"))
    // The conic gradient starts at 12 o'clock: the tile's top right and bottom left are full, the others 0.55.
    XCTAssertEqual([Sprite.markAlpha(x: 0, y: 0), Sprite.markAlpha(x: 1, y: 0), Sprite.markAlpha(x: 0, y: 1), Sprite.markAlpha(x: 1, y: 1)], [0.55, 1, 1, 0.55])
  }
}
