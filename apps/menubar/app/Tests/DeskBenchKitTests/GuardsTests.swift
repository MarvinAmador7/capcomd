import XCTest
@testable import DeskBenchKit

/// The `built-within` guard's rule (Guards.swift, C6), on made-up bodies: no window.
final class GuardsTests: XCTestCase {
  typealias B = BuiltWithin.Body

  func cols(_ ids: [String]) -> [BuiltWithin.Column] { ids.map { BuiltWithin.Column(id: $0, expectsRows: true, warm: true, view: "hosting") } }
  func built(_ id: String, at t: Double) -> [B] { BuiltWithin.required.enumerated().map { B(t: t + Double($0.offset), view: $0.element, id: id) } }

  func testBuiltWithinPassesWhenEveryOnScreenColumnWasBuiltSinceItsProjectOpened() {
    let bodies = built("a", at: 100) + built("b", at: 400) + [B(t: 50, view: "TitleBar", id: nil)]
    let g = BuiltWithin.evaluate(columns: cols(["a", "b"]), bodies: bodies, since: 90, settleAt: 300, limitMs: 300)
    XCTAssertTrue(g.pass, g.detail)
    XCTAssertEqual(g.value, 103, "the last column's last first body, 103 ms after settle")
    XCTAssertEqual(g.limit, 300)
  }

  func testBuiltWithinFailsABlankColumnALateOneAndAColdOne() {
    // b never built its thread (a blank column is fast); c was built 700 ms after settle; bodies before `since`
    // belong to the project shown before the switch and count for nothing.
    let bodies = built("a", at: 100) + [B(t: 120, view: "Column", id: "b"), B(t: 121, view: "ColumnHead", id: "b")] + built("c", at: 1000) + built("d", at: 10)
    var cs = cols(["a", "b", "c", "d"])
    let g = BuiltWithin.evaluate(columns: cs, bodies: bodies, since: 90, settleAt: 300, limitMs: 300)
    XCTAssertFalse(g.pass)
    XCTAssertTrue(g.detail.contains("b: no ColumnThread/EntryRow body"), g.detail)
    XCTAssertTrue(g.detail.contains("c: built 703.0 ms after settle"), g.detail)
    XCTAssertTrue(g.detail.contains("d: no Column/ColumnHead/ColumnThread/EntryRow"), g.detail)
    cs = [BuiltWithin.Column(id: "a", expectsRows: true, warm: false, view: "placeholder")]
    let cold = BuiltWithin.evaluate(columns: cs, bodies: built("a", at: 100), since: 0, settleAt: 300, limitMs: 300)
    XCTAssertFalse(cold.pass)
    XCTAssertTrue(cold.detail.contains("cold") && cold.detail.contains("placeholder"), cold.detail)
    XCTAssertFalse(BuiltWithin.evaluate(columns: [], bodies: [], since: 0, settleAt: 0, limitMs: 300).pass, "no column on screen is no proof")
  }

  func testAThreadlessAgentNeedsNoEntryRow() {
    let c = [BuiltWithin.Column(id: "a", expectsRows: false, warm: true, view: "hosting")]
    let bodies = [B(t: 1, view: "Column", id: "a"), B(t: 2, view: "ColumnHead", id: "a"), B(t: 3, view: "ColumnThread", id: "a")]
    XCTAssertTrue(BuiltWithin.evaluate(columns: c, bodies: bodies, since: 0, settleAt: 10, limitMs: 300).pass)
  }
}
