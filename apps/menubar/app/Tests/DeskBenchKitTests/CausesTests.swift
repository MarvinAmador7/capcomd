import XCTest
import DeskBenchKit
import CapcomdStore
import PerfLoopProbe
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// PerfLoop Phase 3, "why did this body run" (CAPABILITIES.md C7): the desktop model's mutation records and the text
/// `explain` makes of them.
final class CausesTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  /// The model driven as a tab click, Follow and the keyboard drive it, with and without a sink: the same state either
  /// way (no sink attached = today's code), and with one the records name what changed.
  @MainActor func testMutationRecordsChangeNothingAndNameWhatChanged() throws {
    func drive(_ sink: CauseRecorder?) -> [String] {
      Mutations.sink = sink
      defer { Mutations.sink = nil }
      let w = Fixtures.make("crew17")!
      let s = CapcomdStore(thread: FixtureThread(w))
      w.load(into: s)
      let m = DeskModel(store: s)
      let cols = m.columns
      m.scroll(to: cols[5])                 // a crew tab's click
      m.reelScrolled(toIndex: 3)            // the reel reporting where it landed
      m.across = 2
      m.focusedAgent = cols[0]              // a click on a column
      m.goToAgent(16)                       // the keyboard
      return [m.focusedAgent ?? "-", m.reelPosition ?? "-", String(m.across), m.onScreen.sorted().joined(separator: ","),
              cols.filter { m.agent($0)?.focused == true }.joined(separator: ","), cols.filter { m.agent($0)?.onScreen == true }.joined(separator: ","),
              cols.filter { m.agent($0)?.warm == true }.joined(separator: ",")]
    }
    XCTAssertNil(Mutations.sink)
    let r = CauseRecorder { 0 }
    XCTAssertEqual(drive(nil), drive(r))
    XCTAssertNil(Mutations.sink)
    r.body("Column")
    let keys = Set(r.causes(from: -1, to: 1).map(\.keyPath))
    for k in ["DeskModel.focusedAgent", "DeskModel.reelPosition", "DeskModel.reelRequest", "DeskModel.across", "DeskModel.columns",
              "AgentSlice.focused", "AgentSlice.onScreen", "AgentSlice.warm"] { XCTAssertTrue(keys.contains(k), "\(k) not recorded: \(keys.sorted())") }
    let focused = r.causes(from: -1, to: 1).first { $0.keyPath == "AgentSlice.focused" }
    XCTAssertGreaterThanOrEqual(focused?.ids ?? 0, 3)   // set per agent, with its id
  }
  #endif

  func testExplainPrintsCausesUnderTheStretch() {
    var w = Stretch(step: "step#3 9→12", atMs: 100, durationMs: 38.5, cpuMs: 37.8, bodies: ["Column": 34, "CrewTab": 4])
    w.causes = [Cause(keyPath: "AgentSlice.focused", count: 2, ids: 2, bodies: ["Column": 34, "CrewTab": 4], objects: ["Column": 17, "CrewTab": 4]),
                Cause(keyPath: "AgentSlice.onScreen", count: 2, ids: 2, bodies: ["Column": 34, "CrewTab": 4], objects: ["Column": 17, "CrewTab": 4]),
                Cause(keyPath: Cause.unrecorded, count: 0, bodies: ["Reel": 1])]
    let lines = Explain.stretchLines(w)
    XCTAssertEqual(lines.count, 2)
    XCTAssertEqual(lines[1], "             causes: AgentSlice.focused×2 + AgentSlice.onScreen×2 (Column×34 (17 distinct), CrewTab×4) · (unrecorded) (Reel×1)")
    w.causes = nil
    XCTAssertEqual(Explain.stretchLines(w).count, 1)   // older results: no line
  }

  func testStepCausesMergeAcrossSteps() {
    let a = [Cause(keyPath: "M.x", count: 1, ids: 1, bodies: ["V": 2], objects: ["V": 2])]
    let b = [Cause(keyPath: "M.x", count: 2, ids: 3, bodies: ["V": 1, "W": 1], objects: ["V": 1])]
    XCTAssertEqual(Explain.merge([a, b]), [Cause(keyPath: "M.x", count: 3, ids: 3, bodies: ["V": 3, "W": 1], objects: ["V": 2])])
  }

  func testResultsWithoutCausesStillDecode() throws {
    let s = try JSONOut.decode(Stretch.self, from: Data(#"{"step":"s","atMs":1,"durationMs":2,"cpuMs":2,"bodies":{}}"#.utf8))
    XCTAssertNil(s.causes)
    var t = s; t.causes = [Cause(keyPath: "M.x", count: 1, bodies: ["V": 1])]
    XCTAssertEqual(try JSONOut.decode(Stretch.self, from: Data(JSONOut.encode(t).utf8)), t)
  }
}
