import XCTest
import DeskBenchKit
import PerfLoopProbe
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
#endif

/// `swipe` and the gesture recorder (design/perf-loop CAPABILITIES.md C9), without a window: the synthetic gestures,
/// how a result's smoothness is summed up, compared and judged, and the app's recorder hook, off and on.
final class GestureTests: XCTestCase {
  /// The files in apps/menubar/app/Gestures are the built-in synthetic gestures, byte for byte
  /// (`deskbench gestures --write Gestures` makes them).
  func testTheCommittedSyntheticFilesAreTheBuiltInOnes() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Gestures").standardizedFileURL
    for g in Gestures.synthetic {
      let url = dir.appendingPathComponent("\(g.name).json")
      let data = try Data(contentsOf: url)
      XCTAssertEqual(try Gesture.read(url), g, "\(url.path) is stale: deskbench gestures --write Gestures")
      XCTAssertEqual(data, g.encoded())
    }
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }), Set(Gestures.synthetic.map { "\($0.name).json" }),
                   "only synthetic gestures are committed: a recording of a hand stays out of the repo")
  }

  func testSyntheticGesturesFollowTheFlingCurves() throws {
    let f = try XCTUnwrap(Gestures.named("synthetic:flick-forward"))
    XCTAssertEqual(f.synthetic, true); XCTAssertEqual(f.problems, [])
    XCTAssertEqual(f.fingerTravel.dx, -70, "6 frames growing to 2400/120 = 20 pt: 3.3 + 6.7 + … + 20")
    XCTAssertEqual(f.events.map(\.phase).prefix(3), [.mayBegin, .began, .changed])
    XCTAssertEqual(f.events.last?.momentum, .ended)
    XCTAssertTrue(f.events.allSatisfy { $0.dx == $0.dx.rounded() }, "whole points: what a CGEvent carries")
    XCTAssertEqual(Gestures.named("synthetic:flick-back")?.fingerTravel.dx, 70)
    let d = try XCTUnwrap(Gestures.named("drag-forward"))
    XCTAssertEqual(d.momentumTravel.dx, 0); XCTAssertEqual(d.events.last?.phase, .ended)
    XCTAssertEqual(Gestures.synthetic.map(Gestures.spec), ["synthetic:flick-forward", "synthetic:flick-back", "synthetic:drag-forward"])
  }

  func testLoadSaysWhatIsWrong() throws {
    guard case .failure(let e) = Gestures.load("synthetic:nope") else { return XCTFail("no such synthetic gesture") }
    XCTAssertTrue(e.description.contains("synthetic:flick-forward"))
    guard case .failure = Gestures.load("/nonexistent/g.json") else { return XCTFail("no such file") }
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("g-\(UUID().uuidString).json")
    defer { try? FileManager.default.removeItem(at: url) }
    var g = Gestures.synthetic[0]; g.events = [.init(t: 0, dx: 0, phase: .began)]
    try g.encoded().write(to: url)
    guard case .failure(let e2) = Gestures.load(url.path) else { return XCTFail("nothing moves") }
    XCTAssertTrue(e2.description.contains("nothing moved"))
    try Gestures.synthetic[2].encoded().write(to: url)
    XCTAssertEqual(try Gestures.load(url.path).get(), Gestures.synthetic[2])
  }

  // MARK: results

  func rep(_ i: Int, smooth: [Smoothness?], cpu: Double = 10) -> RepResult {
    let steps = smooth.enumerated().map { n, s -> StepResult in
      var st = StepResult(name: "swipe#\(n)", atMs: 0, durationMs: 500, frames: FrameStats(intervalsMs: [8.3, 8.3], nominalHz: 120), mainThread: MainThreadStats(stretchesMs: [2]),
                          bodies: [:], cpuMs: cpu)
      st.smoothness = s
      return st
    }
    var r = RepResult(index: i, steps: steps, frames: FrameStats(intervalsMs: [8.3, 8.3], nominalHz: 120), mainThread: MainThreadStats(stretchesMs: [2]), bodies: [:], checks: [], worstStretches: [], window: nil)
    r.measure = currentMeasure
    return r
  }

  func testARepSumsUpItsGestures() throws {
    let r = rep(0, smooth: [Smoothness(positionErrorP95Pt: 0.5, stalls: 1, jerkP95: 4, latencyFrames: 1), Smoothness(positionErrorP95Pt: 2, stalls: 2, jerkP95: 8, latencyFrames: 1), nil])
    let s = try XCTUnwrap(r.smoothness)
    XCTAssertEqual(s.positionErrorP95Pt, 2, "the worst gesture"); XCTAssertEqual(s.stalls, 3, "every stall"); XCTAssertEqual(s.jerkP95, 4, "the median jerk (nearest rank, as Stats.median)")
    XCTAssertNil(rep(0, smooth: [nil]).smoothness, "no gesture, no smoothness: every other scenario")
    let sum = Summary(reps: [r, r, rep(2, smooth: [Smoothness(positionErrorP95Pt: 0, stalls: 0, jerkP95: 2)])])
    XCTAssertEqual(sum.smoothness?.positionErrorP95Pt?.median, 2); XCTAssertEqual(sum.smoothness?.stalls.median, 3)
    XCTAssertNil(Summary(reps: [rep(0, smooth: [nil])]).smoothness)
    // Old results decode without it.
    let old = try JSONOut.decode(StepResult.self, from: Data(#"{"name":"s","atMs":0,"durationMs":1,"frames":{"ticks":0,"nominalHz":60,"steadyHz":60,"measuredHz":0,"p50Ms":0,"p95Ms":0,"p99Ms":0,"maxMs":0,"late":0,"lateAtNominal":0,"dropped":0,"lateRatio":0},"mainThread":{"stretches":0,"busyMs":0,"cpuMs":0,"longestMs":0,"over8":0,"over16":0,"over33":0,"over100":0,"over250":0},"bodies":{},"notes":[]}"#.utf8))
    XCTAssertNil(old.smoothness)
  }

  /// Position error and stalls guard a comparison; jerk informs.
  func testComparisonGuardsOnErrorAndStallsAndInformsOnJerk() throws {
    let spec = try XCTUnwrap(Scenarios.spec("swipe"))
    let good = (0..<5).map { rep($0, smooth: [Smoothness(positionErrorP95Pt: 0, stalls: 0, jerkP95: 3)]) }
    let stalling = (0..<5).map { rep($0, smooth: [Smoothness(positionErrorP95Pt: 0, stalls: 4, jerkP95: 30)], cpu: 5) }
    let c = Comparison(spec, baseline: good, candidate: stalling)
    XCTAssertEqual(c.rows.first { $0.metric == "positionErrorP95Pt" }?.role, "guard")
    XCTAssertEqual(c.rows.first { $0.metric == "stalls" }?.role, "guard")
    XCTAssertEqual(c.rows.first { $0.metric == "jerkP95" }?.role, "info")
    XCTAssertTrue(c.regression); XCTAssertFalse(c.improvement); XCTAssertEqual(c.guardsFailed, ["stalls"])
    let same = Comparison(spec, baseline: good, candidate: (0..<5).map { rep($0, smooth: [Smoothness(positionErrorP95Pt: 0.3, stalls: 1, jerkP95: 90)], cpu: 5) })
    XCTAssertTrue(same.improvement, "inside the bands (0.5 pt, 1 stall), and jerk never decides: \(same.rows.map(\.reason))")
    XCTAssertNil(Comparison(Scenarios.spec("step")!, baseline: [rep(0, smooth: [nil])], candidate: [rep(0, smooth: [nil])]).rows.first { $0.metric == "stalls" })
  }

  func testTheBudgetWantsTheContentWithinAPointWithoutStalls() throws {
    let spec = try XCTUnwrap(Scenarios.spec("swipe"))
    let ok = [rep(0, smooth: [Smoothness(positionErrorP95Pt: 0, stalls: 0, jerkP95: 3)])]
    XCTAssertTrue(Budgets.evaluate(spec, reps: ok, summary: Summary(reps: ok)).pass)
    let bad = [rep(0, smooth: [Smoothness(positionErrorP95Pt: 3.5, stalls: 2, jerkP95: 3)])]
    let v = Budgets.evaluate(spec, reps: bad, summary: Summary(reps: bad))
    XCTAssertFalse(v.pass); XCTAssertEqual(v.reasons.count, 2, "\(v.reasons)")
    XCTAssertTrue(v.reasons[0].contains("3.5 pt from the fingers"))
  }

  func testTheManifestDescribesSwipe() throws {
    let build = BuildInfo(hash: "sha256:00", commit: "abc1234", dirty: false, sourceHash: nil, builtAt: nil, configuration: "release", toolchain: nil, stamp: true)
    let m = Manifest(build: build, knobs: [])
    let s = try XCTUnwrap(m.scenarios.first { $0.name == "swipe" })
    XCTAssertEqual(s.kind, "smooth"); XCTAssertEqual(s.objective, "mainThreadCpuMsPerStep")
    XCTAssertEqual(s.checks, ["reel-scroll-view", "gesture", "snapped"])
    XCTAssertEqual(s.frameGuards, ["hitchTimeRatioMsPerS", "longestStretchMs", "positionErrorP95Pt", "stalls"])
    XCTAssertTrue(s.guards.contains("snapshot-diff"))
    XCTAssertEqual(s.params["gesture"], "synthetic:flick-forward")
    XCTAssertEqual(m.gestures, ["synthetic:flick-forward", "synthetic:flick-back", "synthetic:drag-forward"])
    XCTAssertFalse(Scenarios.suite.contains("swipe"), "swipe isn't in the suite: fling covers it there, and recordings are the owner's")
  }

  // MARK: the app's recorder

  #if canImport(SwiftUI) && os(macOS)
  /// The app as it ships: nothing attaches a recorder, so the reel's hook is a nil check per scroll event. A million
  /// cost nothing next to a frame and write nothing.
  @MainActor func testTheRecorderIsOffByDefaultAndCostsNothing() throws {
    XCTAssertNil(GestureTap.recorder)
    let ev = try XCTUnwrap(Self.event(dx: -3, phase: 2, momentum: 0, at: 1))
    let t = Date()
    for _ in 0..<1_000_000 { GestureTap.scrollWheel(ev) }
    XCTAssertLessThan(Date().timeIntervalSince(t), 0.5)
    XCTAssertNil(GestureTap.recorder)
    // And the reel's scroll view still hands every event on: the hook sits before its own handling and returns nothing.
    let sv = SnapScrollView(frame: NSRect(x: 0, y: 0, width: 100, height: 100))
    sv.scrollWheel(with: ev)
    XCTAssertNil(GestureTap.recorder)
  }

  /// On (what CAPCOMD_DESK_RECORD_GESTURE and `record-gesture` do): the scroll events' deltas, phases and times reach
  /// the file, and nothing else does.
  @MainActor func testTheRecorderWritesTheEventsItSaw() throws {
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("gesture-\(UUID().uuidString)")
    defer { try? FileManager.default.removeItem(at: dir); GestureTap.stop() }
    var wrote: [URL] = []
    GestureTap.record(to: dir.appendingPathComponent("flick.json")) { if case .success(let (u, _)) = $0 { wrote.append(u) } }
    // CGScrollPhase: began 1, changed 2, ended 4; CGMomentumScrollPhase: begin 1, continue 2, end 3.
    let script: [(Double, Int64, Int64)] = [(0, 1, 0), (-5, 2, 0), (-9, 2, 0), (0, 4, 0), (-8, 0, 1), (-4, 0, 2), (0, 0, 3)]
    for (i, (dx, sp, mp)) in script.enumerated() { GestureTap.scrollWheel(try XCTUnwrap(Self.event(dx: dx, phase: sp, momentum: mp, at: 10 + Double(i) / 120))) }
    XCTAssertEqual(wrote.map(\.lastPathComponent), ["flick.json"])
    let g = try Gesture.read(wrote[0])
    XCTAssertEqual(g.name, "flick"); XCTAssertEqual(g.device, "trackpad"); XCTAssertNil(g.synthetic)
    XCTAssertEqual(g.events.map(\.dx), [0, -5, -9, 0, -8, -4, 0])
    XCTAssertEqual(g.events.map(\.phase), [.began, .changed, .changed, .ended, .none, .none, .none])
    XCTAssertEqual(g.events.map(\.momentum), [.none, .none, .none, .none, .began, .changed, .ended])
    XCTAssertEqual(g.events.last?.t ?? 0, 50, accuracy: 0.01)
    let keys = Set(try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: wrote[0])) as? [String: Any]).keys)
    XCTAssertEqual(keys, ["schema", "name", "recordedAt", "device", "hz", "events"], "no text, no window contents, no identifiers")
    GestureTap.stop()
    XCTAssertNil(GestureTap.recorder)
  }

  static func event(dx: Double, phase: Int64, momentum: Int64, at t: Double) -> NSEvent? {
    guard let cg = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: 0, wheel2: Int32(dx), wheel3: 0) else { return nil }
    cg.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    cg.setDoubleValueField(.scrollWheelEventPointDeltaAxis2, value: dx); cg.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: dx)
    cg.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase); cg.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    cg.timestamp = CGEventTimestamp(t * 1e9)
    return NSEvent(cgEvent: cg)
  }
  #endif
}
