import XCTest
import DeskBenchKit
import PerfLoopProbe
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
#endif

/// `swipe` and the gesture recorder (design/perf-loop CAPABILITIES.md C9), without a window: the synthetic gestures
/// (PerfLoopProbe's, committed as files) and the app's recorder hook, off and on.
final class GestureTests: XCTestCase {
  /// The files in apps/menubar/app/Gestures are the built-in synthetic gestures, byte for byte
  /// (`deskbench gestures --write Gestures` makes them).
  func testTheCommittedSyntheticFilesAreTheBuiltInOnes() throws {
    let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("../../Gestures").standardizedFileURL
    let synthetic = SyntheticGestures.all.filter { Gestures.committed.contains($0.name) }
    XCTAssertEqual(synthetic.map(\.name), Gestures.committed)
    for g in synthetic {
      let url = dir.appendingPathComponent("\(g.name).json")
      let data = try Data(contentsOf: url)
      XCTAssertEqual(try Gesture.read(url), g, "\(url.path) is stale: deskbench gestures --write Gestures")
      XCTAssertEqual(data, g.encoded())
    }
    XCTAssertEqual(Set(try FileManager.default.contentsOfDirectory(atPath: dir.path).filter { $0.hasSuffix(".json") }), Set(Gestures.committed.map { "\($0).json" }),
                   "only synthetic gestures are committed: a recording of a hand stays out of the repo")
  }

  func testSyntheticGesturesFollowTheFlingCurves() throws {
    let f = try XCTUnwrap(try? SyntheticGestures.load("synthetic:flick-forward"))
    XCTAssertEqual(f.synthetic, true); XCTAssertEqual(f.problems, [])
    XCTAssertEqual(f.fingerTravel.dx, -70, "6 frames growing to 2400/120 = 20 pt: 3.3 + 6.7 + … + 20")
    XCTAssertEqual(f.events.map(\.phase).prefix(3), [.mayBegin, .began, .changed])
    XCTAssertEqual(f.events.last?.momentum, .ended)
    XCTAssertTrue(f.events.allSatisfy { $0.dx == $0.dx.rounded() }, "whole points: what a CGEvent carries")
    XCTAssertEqual((try? SyntheticGestures.load("synthetic:flick-back"))?.fingerTravel.dx, 70)
    let d = try XCTUnwrap(try? SyntheticGestures.load("synthetic:drag-forward"))
    XCTAssertEqual(d.momentumTravel.dx, 0); XCTAssertEqual(d.events.last?.phase, .ended)
    XCTAssertTrue(Set(["synthetic:flick-forward", "synthetic:flick-back", "synthetic:drag-forward"]).isSubset(of: SyntheticGestures.specs))
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
