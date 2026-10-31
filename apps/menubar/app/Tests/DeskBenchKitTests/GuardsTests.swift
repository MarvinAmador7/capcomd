import XCTest
@testable import DeskBenchKit

/// The correctness guards' rules (Guards.swift, C6), on made-up bodies and bitmaps: no window.
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

  func testGuardConfigFromTheEnvironmentAndTheCommandLine() {
    let c = GuardConfig(env: ["PERFLOOP_GUARDS": "checks,built-within", "PERFLOOP_GUARD_PARAMS": "built-within.ms=500", "PERFLOOP_ARTIFACTS": "/tmp/x"],
                        names: ["snapshot-diff"], params: ["snapshot-diff.tolerance=0.01"])
    XCTAssertEqual(c.names, ["checks", "built-within", "snapshot-diff"])
    XCTAssertEqual(c.value("built-within.ms"), 500); XCTAssertEqual(c.value("snapshot-diff.tolerance"), 0.01); XCTAssertEqual(c.value("snapshot-diff.bboxPt"), 4)
    XCTAssertEqual(c.dir?.path, "/tmp/x"); XCTAssertTrue(c.active)
    XCTAssertFalse(GuardConfig(env: ["PERFLOOP_GUARDS": "checks"]).active, "checks are the driver's own: nothing to do after a rep")
  }

  // MARK: snapshot-diff

  let bg: (UInt8, UInt8, UInt8) = (30, 30, 34)
  /// A 100×60 "window" with one column at x 10..<50 holding text-like stripes, and a thread viewport y 10..<50.
  func window(stripes: Int = 8, clock: Int = 0, shift: Int = 0) -> RGBAImage {
    var img = RGBAImage(width: 100, height: 60, fill: bg)
    for s in 0..<stripes { for x in 14..<46 { img.set(x, 12 + ((s * 4 + shift) % 36), (220, 220, 220)) } }
    for x in (80 + clock)..<(84 + clock) { for y in 2..<6 { img.set(x, y, (200, 200, 200)) } }     // a ticking clock
    for x in 10..<50 { img.set(x, 4, (120, 120, 120)) }                                                // the column head
    return img
  }
  let layout = [SnapshotLayout.Col(id: "a", rect: [10, 0, 40, 60], thread: [10, 10, 40, 40])]

  func compare(_ a: RGBAImage, _ b: RGBAImage, mask: [Bool]? = nil, colsB: [SnapshotLayout.Col]? = nil) -> SnapshotDiff.Report {
    SnapshotDiff.compare(a, b, mask: mask, columns: layout, columnsB: colsB ?? layout, tolerance: 0.005, columnTolerance: 0.02, bboxPx: 8, threadInkMin: 0.2, threshold: 16)
  }

  func testTheSameWindowPassesAndAClockIsMaskedByItsOwnTicking() {
    XCTAssertTrue(compare(window(), window()).pass)
    // The clock moved between the champion's and the candidate's pictures: unmasked, it fails…
    XCTAssertFalse(compare(window(), window(clock: 6)).pass)
    // …masked by what moved within one side's own two pictures, widened, it doesn't.
    let m = SnapshotDiff.dilate(SnapshotDiff.unstable(window(), window(clock: 2), threshold: 16), width: 100, height: 60, rx: 8, ry: 1)
    let r = compare(window(), window(clock: 6), mask: m)
    XCTAssertTrue(r.pass, r.reasons.joined(separator: "; ")); XCTAssertGreaterThan(r.masked, 0)
  }

  func testAThreadAtAnotherScrollOffsetPassesABlankThreadDoesNot() {
    let r = compare(window(), window(shift: 3))
    XCTAssertTrue(r.pass, r.reasons.joined(separator: "; "))
    let blank = compare(window(), window(stripes: 0))
    XCTAssertFalse(blank.pass)
    XCTAssertTrue(blank.reasons.joined().contains("thread is 0.0 % drawn"), blank.reasons.joined(separator: "; "))
    XCTAssertEqual(blank.columns.first?.threadInkB, 0)
    // A thread the candidate doesn't have at all.
    XCTAssertFalse(compare(window(), window(), colsB: [SnapshotLayout.Col(id: "a", rect: [10, 0, 40, 60])]).pass)
  }

  func testOtherColumnsOrAnotherSizeFail() {
    XCTAssertFalse(compare(window(), window(), colsB: [SnapshotLayout.Col(id: "z", rect: [10, 0, 40, 60], thread: [10, 10, 40, 40])]).pass)
    let r = compare(window(), RGBAImage(width: 90, height: 60, fill: bg))
    XCTAssertFalse(r.pass); XCTAssertTrue(r.reasons[0].contains("differ in size"))
    // The column head gone: outside the thread, pixel by pixel.
    var noHead = window(); for x in 10..<50 { noHead.set(x, 4, bg) }
    XCTAssertFalse(compare(window(), noHead).pass)
  }

  func testTheGuardRecordAsksForReviewWhenOverTolerance() {
    let g = SnapshotDiff.guardResult(compare(window(), window(stripes: 0)), artifacts: ["a.png", "b.png"])
    XCTAssertEqual(g.name, "snapshot-diff"); XCTAssertFalse(g.pass); XCTAssertEqual(g.review, true); XCTAssertEqual(g.artifacts.count, 2)
    XCTAssertNil(SnapshotDiff.guardResult(compare(window(), window()), artifacts: []).review)
  }

  func testDilateGrowsABoxBothWays() {
    var m = [Bool](repeating: false, count: 10 * 5); m[2 * 10 + 5] = true
    let d = SnapshotDiff.dilate(m, width: 10, height: 5, rx: 2, ry: 1)
    XCTAssertEqual(d.filter { $0 }.count, 5 * 3)
    XCTAssertTrue(d[1 * 10 + 3]); XCTAssertTrue(d[3 * 10 + 7]); XCTAssertFalse(d[2 * 10 + 8]); XCTAssertFalse(d[0 * 10 + 5])
  }

  func testRepGuardsReachTheSummaryAndOldResultsDecode() throws {
    var r = try JSONOut.decode(BenchResult.self, from: Data(v1StepResult.utf8))
    XCTAssertNil(r.reps[0].guards); XCTAssertNil(Summary(reps: r.reps).guardsFailed)
    r.reps[0].guards = [GuardResult(name: "built-within", pass: false, detail: "x"), GuardResult(name: "snapshot-diff", pass: true, detail: "y")]
    XCTAssertEqual(Summary(reps: r.reps).guardsFailed, ["built-within"])
    let back = try JSONOut.decode(BenchResult.self, from: Data(JSONOut.encode(r).utf8))
    XCTAssertEqual(back.reps[0].guards?.count, 2)
  }
}
