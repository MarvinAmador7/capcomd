import XCTest
import DeskBenchKit
import PerfLoopProbe
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// PerfLoop Phase 2 on the adapter side: the desktop window's knobs (the manifest: PerfLoopContractTests).
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
    // Search ⌘K is drawn inside the window; its own key panel stays a knob (it measured slower in every pair).
    XCTAssertEqual(DeskKnobs.searchHost.defaultValue, .overlay)
    // AppKit's first-shortcut and first-field work is done ahead (2026-11-19); `none` is the window before.
    XCTAssertEqual(DeskKnobs.prewarm.defaultValue, .all)
    XCTAssertEqual(DeskKnobs.all.map(\.name), ["build.perFrame", "desk.column", "desk.layout", "desk.prewarm", "reel.cache", "reel.columns", "reel.release", "reel.slide", "search.host"])
    try XCTSkipIf(ProcessInfo.processInfo.environment[Knobs.variable] != nil, "PERFLOOP_KNOBS is set for this test run")
    XCTAssertEqual(DeskKnobs.reelSlide.value, .ca)
    XCTAssertEqual(DeskKnobs.buildPerFrame.value, 1)
    XCTAssertEqual(DeskKnobs.deskLayout.value, .auto)
    XCTAssertEqual(DeskKnobs.deskColumn.value, .swiftui)
    XCTAssertEqual(DeskKnobs.reelColumns.value, .keep)
    XCTAssertEqual(DeskKnobs.reelCache.value, .off)
    XCTAssertEqual(DeskKnobs.reelRelease.value, .land)
    XCTAssertEqual(DeskKnobs.searchHost.value, .overlay)
    XCTAssertEqual(DeskKnobs.prewarm.value, .all)
    XCTAssertEqual(DeskKnobs.vector, ["reel.slide": "ca", "build.perFrame": "1", "desk.layout": "auto", "desk.column": "swiftui", "reel.columns": "keep", "reel.cache": "off", "reel.release": "land",
                                      "search.host": "overlay", "desk.prewarm": "all"])
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
}
