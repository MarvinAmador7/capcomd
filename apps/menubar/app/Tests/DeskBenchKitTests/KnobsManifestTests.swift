import XCTest
import DeskBenchKit
import PerfLoopProbe
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// PerfLoop Phase 2 on the adapter side: the desktop window's knobs, their record in results, and `describe`.
final class KnobsManifestTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  func testDeskKnobsDefaultToTodaysBehaviour() throws {
    // The render-server slide and one far column per frame: the reel as it was before knobs.
    XCTAssertEqual(DeskKnobs.reelSlide.defaultValue, .ca)
    XCTAssertEqual(DeskKnobs.buildPerFrame.defaultValue, 1)
    // The native path's knobs default to today's code: fractional frames, SwiftUI columns, every column in the scrolling document.
    XCTAssertEqual(DeskKnobs.deskLayout.defaultValue, .auto)
    XCTAssertEqual(DeskKnobs.deskColumn.defaultValue, .swiftui)
    XCTAssertEqual(DeskKnobs.reelColumns.defaultValue, .keep)
    XCTAssertEqual(DeskKnobs.reelCache.defaultValue, .off)
    // The reel ends AppKit's own deceleration when the fingers lift (the fix of 2026-11-04); `appkit` is the old reel.
    XCTAssertEqual(DeskKnobs.reelRelease.defaultValue, .land)
    XCTAssertEqual(DeskKnobs.all.map(\.name), ["build.perFrame", "desk.column", "desk.layout", "reel.cache", "reel.columns", "reel.release", "reel.slide"])
    try XCTSkipIf(ProcessInfo.processInfo.environment[Knobs.variable] != nil, "PERFLOOP_KNOBS is set for this test run")
    XCTAssertEqual(DeskKnobs.reelSlide.value, .ca)
    XCTAssertEqual(DeskKnobs.buildPerFrame.value, 1)
    XCTAssertEqual(DeskKnobs.deskLayout.value, .auto)
    XCTAssertEqual(DeskKnobs.deskColumn.value, .swiftui)
    XCTAssertEqual(DeskKnobs.reelColumns.value, .keep)
    XCTAssertEqual(DeskKnobs.reelCache.value, .off)
    XCTAssertEqual(DeskKnobs.reelRelease.value, .land)
    XCTAssertEqual(DeskKnobs.vector, ["reel.slide": "ca", "build.perFrame": "1", "desk.layout": "auto", "desk.column": "swiftui", "reel.columns": "keep", "reel.cache": "off", "reel.release": "land"])
    XCTAssertEqual(DeskKnobs.problems.filter { !$0.contains("t.") }, [])
  }

  func testASettingSelectsTheClipSlide() {
    // What PERFLOOP_KNOBS=reel.slide=clip,build.perFrame=4 resolves to (a test name, so the real knobs keep theirs).
    let s = Knobs.parse("t.reel.slide=clip,t.build.perFrame=4")
    XCTAssertEqual(Knob("t.reel.slide", default: DeskKnobs.Slide.ca, choices: DeskKnobs.Slide.allCases, settings: s).value, .clip)
    XCTAssertEqual(Knob("t.build.perFrame", default: 1, range: 1...8, settings: s).value, 4)
    _ = DeskKnobs.knobs   // registered, for check
    XCTAssertEqual(Knobs.check(["reel.slide": "clip", "build.perFrame": "8"]), [])
    XCTAssertEqual(Knobs.check(["reel.slide": "warp"]), ["reel.slide=warp: not one of ca, clip"])
    XCTAssertEqual(Knobs.check(["build.perFrame": "0"]).count, 1)
  }
  #endif

  func testManifestDescribesEveryScenario() throws {
    let build = BuildInfo(hash: "sha256:00", commit: "abc1234", dirty: false, sourceHash: nil, builtAt: nil, configuration: "release", toolchain: nil, stamp: true)
    let knobs = [KnobInfo(name: "reel.slide", type: "choice", default: "ca", choices: ["ca", "clip"]), KnobInfo(name: "build.perFrame", type: "int", default: "1", range: ["1", "8"])]
    let m = Manifest(build: build, knobs: knobs)
    XCTAssertEqual(m.schema, "perfloop.manifest/1")
    XCTAssertEqual(m.scenarios.map(\.name), Scenarios.all.map(\.name))
    XCTAssertEqual(Set(Manifest.checks.keys), Set(Scenarios.all.map(\.name)), "every scenario lists its checks")
    let step = try XCTUnwrap(m.scenarios.first { $0.name == "step" })
    XCTAssertEqual(step.objective, "mainThreadCpuMsPerStep")
    XCTAssertEqual(step.guards, ["checks", "built-within", "snapshot-diff"])
    XCTAssertEqual(step.frameGuards, ["hitchTimeRatioMsPerS", "longestStretchMs"])
    XCTAssertEqual(step.guardParams?["built-within.ms"], 300)
    XCTAssertEqual(step.guardParams?["snapshot-diff.tolerance"], 0.005)
    XCTAssertEqual(m.scenarios.first { $0.name == "typing" }?.guards, ["checks", "built-within"], "no pixels compared where a caret blinks")
    XCTAssertNil(m.scenarios.first { $0.name == "typing" }?.guardParams?["snapshot-diff.tolerance"])
    XCTAssertEqual(m.isolationGuards, ["burst", "typing"])
    XCTAssertEqual(step.params, ["steps": "8"])
    XCTAssertEqual(m.scenarios.first { $0.name == "switch" }?.objective, "latencyMs")
    XCTAssertEqual(m.scenarios.first { $0.name == "open" }?.host, "window")
    XCTAssertEqual(m.fixtures.map(\.name), Fixtures.all.map(\.name))
    let json = JSONOut.encode(m)
    let back = try JSONOut.decode(Manifest.self, from: Data(json.utf8))
    XCTAssertEqual(back, m)
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(json.utf8)) as? [String: Any])
    XCTAssertEqual(obj["protocol"] as? Int, 1)
    let k = try XCTUnwrap((obj["knobs"] as? [[String: Any]])?.first { $0["name"] as? String == "build.perFrame" })
    XCTAssertEqual(k["default"] as? Int, 1, "numeric knobs are numbers in the manifest")
    XCTAssertEqual(k["range"] as? [Int], [1, 8])
  }

  func testResultsRecordKnobsAndOlderResultsStillDecode() throws {
    var r = try JSONOut.decode(BenchResult.self, from: Data(v1StepResult.utf8))
    XCTAssertNil(r.knobs)
    r.knobs = ["reel.slide": "clip", "build.perFrame": "1"]
    let back = try JSONOut.decode(BenchResult.self, from: Data(JSONOut.encode(r).utf8))
    XCTAssertEqual(back.knobs, ["reel.slide": "clip", "build.perFrame": "1"])
  }
}
