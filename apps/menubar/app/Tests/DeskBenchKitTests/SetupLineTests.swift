import XCTest
@testable import CapcomdDesk
@testable import CapcomdStore

/// The compact getting-ready / waking line (DurableWaking-v3): its words, clock and step times.
final class SetupLineTests: XCTestCase {
  func testTheLineSaysWhoAndThePhaseOnce() {
    let copy = Preparing(phase: .copy, line: "Copying the repository", detail: "53% · 56 of 105 MB", fraction: 0.534, sinceMs: 1000)
    let l = SetupLineModel.of(copy, name: "planner", waking: true)
    XCTAssertEqual(l.title, "Waking planner")
    XCTAssertEqual(l.phaseShown, "Copying the repository")
    XCTAssertEqual(l.percent, 53)
    XCTAssertEqual(l.spoken, "Waking planner: copying the repository, 53 percent")
    // The last phase names the agent: it isn't said twice.
    let start = SetupLineModel.of(Preparing(phase: .starting, line: "Starting planner", sinceMs: nil), name: "planner")
    XCTAssertEqual(start.title, "Starting planner")
    XCTAssertNil(start.phaseShown)
  }

  func testStepsCountFromTheCurrentOne() {
    let l = SetupLineModel(name: "planner", waking: true, phase: "Copying the repository", fraction: 0.53, steps: [
      .init(line: "Starting a machine", state: .done, ms: 2100), .init(line: "Copying the repository", state: .now, atMs: 0),
      .init(line: "Restoring the conversation", state: .next), .init(line: "Starting planner", state: .next),
    ])
    XCTAssertEqual(l.stepCount, "2/4")
    XCTAssertEqual(l.spoken, "Waking planner: copying the repository, 53 percent, step 2 of 4")
  }

  func testClockAndStepTimes() {
    XCTAssertEqual(SetupLineModel.clock(9_400), "0:09")
    XCTAssertEqual(SetupLineModel.clock(75_000), "1:15")
    XCTAssertEqual(SetupLineModel.clock(-5), "0:00")
    XCTAssertEqual(SetupLineModel.stepTime(2_100), "2.1s")
    XCTAssertEqual(SetupLineModel.stepTime(8_000), "8s")
    XCTAssertEqual(SetupLineModel.stepTime(57_300), "57s")
    XCTAssertEqual(SetupLineModel.stepTime(75_000), "1:15")
  }

  func testTheRecordCountsItsSteps() {
    XCTAssertEqual(SetupRecord(elapsedMs: 75_000, steps: Array(repeating: .init(line: "x", state: .done, ms: 1), count: 4)).label, "Set up in 1:15 · 4 steps")
    XCTAssertEqual(SetupRecord(elapsedMs: 3_000, steps: []).label, "Set up in 0:03")
  }
}
