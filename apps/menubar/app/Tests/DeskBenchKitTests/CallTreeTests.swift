import XCTest
@testable import DeskBenchKit

/// Call trees from xctrace exports and the differential tree (`diff`), on hand-made fixtures in Fixtures/ (no recorded
/// trace data: real exports carry the recorded process's environment).
final class CallTreeTests: XCTestCase {
  static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")
  func table(_ name: String) throws -> XCTable { try XCTable(xml: Data(contentsOf: Self.fixtures.appendingPathComponent(name))) }

  func testExportAcrossNodesKeepsSentinelColumnsAndResolvesRefs() throws {
    let t = try table("time-profile.xml")
    XCTAssertEqual(t.schema, "time-profile")
    XCTAssertEqual(t.columns, ["time", "thread", "process", "thread-state", "weight", "stack"])
    XCTAssertEqual(t.rows.count, 6)                                   // rows from both <node>s after the schema's
    XCTAssertNil(t.rows[1]["thread-state"])                           // the sentinel is an empty cell…
    XCTAssertEqual(t.rows[1]["weight"]?.text, "1000000")              // …and the cells after it keep their columns
    XCTAssertEqual(t.rows[1]["stack"]?.name, "tagged-backtrace")
    XCTAssertEqual(t.rows[2]["thread"]?.attrs["fmt"], "Main Thread 0x1 (Bench, pid: 7)")   // a ref into an earlier node
    XCTAssertEqual(XCTable.frames(t.rows[3]["stack"]!, ids: t.ids), ["LayoutEngineBox.sizeThatFits(_:)", "ReelView.slide(to:animated:)", "main"])
    XCTAssertTrue(XCTable.frames(t.rows[2]["stack"]!, ids: t.ids)[0].hasPrefix("std::__1::pair<Key, Value (unsigned short)>"))   // &lt; &gt; &amp;
    XCTAssertThrowsError(try XCTable(xml: Data("<trace-query-result></trace-query-result>".utf8)))
  }

  func testSymbolsLoseArgumentsButNotTheirNames() {
    XCTAssertEqual(Symbol.clean("-[NSApplication(NSEventRouting) sendEvent:]"), "-[NSApplication(NSEventRouting) sendEvent:]")
    XCTAssertEqual(Symbol.clean("+[NSAnimationManager(Private) performAnimations:] (in AppKit)"), "+[NSAnimationManager(Private) performAnimations:]")
    XCTAssertEqual(Symbol.clean("AG::Graph::propagate_dirty(unsigned int)"), "AG::Graph::propagate_dirty")
    XCTAssertEqual(Symbol.clean("ReelView.slide(to:animated:)"), "ReelView.slide")
    XCTAssertEqual(Symbol.clean("Attribute.init<A>(_:)"), "Attribute.init<A>")
    XCTAssertEqual(Symbol.clean("std::pair<K, V (unsigned short)> Map<K>::get<K>(K const&)"), "std::pair<K, V (unsigned short)> Map<K>::get<K>")
    XCTAssertEqual(Symbol.clean("(anonymous namespace)::Engine::solve(int)"), "(anonymous namespace)::Engine::solve")
    XCTAssertEqual(Symbol.clean("Functor::operator()(int) const"), "Functor::operator()")
    XCTAssertEqual(Symbol.clean("closure #1 () -> () in Foo.bar()"), "closure #1")
    XCTAssertEqual(Symbol.clean(String(repeating: "x", count: 200)).count, 110)
    XCTAssertTrue(Symbol.isNoise("objc_msgSend")); XCTAssertTrue(Symbol.isNoise("0x1908c4234")); XCTAssertFalse(Symbol.isNoise("LayoutEngineBox.sizeThatFits"))
  }

  func testStepsComeFromSignpostsOnce() throws {
    let steps = StepInterval.fromSignposts(try table("signposts.xml"))
    // The repeated events collapse, the other subsystem's interval is not a step.
    XCTAssertEqual(steps, [StepInterval(name: "step#1 1→4", startNs: 90_000_000, endNs: 150_000_000, source: "signpost"),
                           StepInterval(name: "step#2 2→5", startNs: 190_000_000, endNs: 250_000_000, source: "signpost")])
  }

  func testMainThreadTreeIsRootFirstPerStepAndMarksOurFrames() throws {
    let s = MainThreadSamples(timeProfile: try table("time-profile.xml"), process: "Bench")
    XCTAssertEqual(s.count, 5)                                       // the worker thread's sample is not the main thread
    XCTAssertEqual(s.process, "Bench")
    XCTAssertEqual(s.sampleIntervalMs, 1)
    XCTAssertEqual(s.times, s.times.sorted())
    let trees = StepTrees(samples: s, steps: StepInterval.fromSignposts(try table("signposts.xml")))
    let w = trees.whole
    XCTAssertEqual(w.n, "main thread"); XCTAssertEqual(w.v, 5)
    XCTAssertEqual(w.c.map(\.n), ["main"]); XCTAssertEqual(w.c[0].o, true)
    let reel = w.c[0].c[0]
    XCTAssertEqual(reel.n, "ReelView.slide"); XCTAssertEqual(reel.v, 4); XCTAssertEqual(reel.o, true)
    XCTAssertEqual(Set(reel.c.map(\.n)), ["-[NSApplication(NSEventRouting) sendEvent:]", "LayoutEngineBox.sizeThatFits"])
    XCTAssertEqual(reel.c.first { $0.n.hasPrefix("-[NSApplication") }?.c.map(\.n), ["-[NSScrollAnimationHelper(Private) _advance:]"])
    let fits = reel.c.first { $0.n == "LayoutEngineBox.sizeThatFits" }!
    XCTAssertNil(fits.o)
    XCTAssertEqual(fits.c.map(\.n), ["(anonymous namespace)::Engine::solve"])
    XCTAssertEqual(w.c[0].c.map(\.n), ["ReelView.slide", "objc_msgSend"])   // heaviest first
    // Per step: 2 samples each; the one at 300 ms is outside both.
    XCTAssertEqual(trees.perStep.map(\.v), [2, 2])
    XCTAssertEqual(trees.inSteps.v, 4); XCTAssertEqual(trees.outside.v, 1)
    XCTAssertEqual(trees.perStep[0].samples { $0.contains("NSScrollAnimationHelper") }, 2)
    XCTAssertEqual(trees.perStep[1].samples { $0.contains("sizeThatFits") }, 2)
    XCTAssertEqual(trees.msPerStep, 2)
  }

  func testProfileCarriesTreesAndOldProfilesStillDecode() throws {
    var p = ProfileResult(template: "Time Profiler", trace: "/nowhere.trace", scenario: "step", fixture: "crew17", process: "Bench", durationS: 1)
    p.addCallTrees(timeProfile: try table("time-profile.xml"), signposts: try table("signposts.xml"), process: "Bench")
    XCTAssertEqual(p.schema, "perfloop.profile/2")
    XCTAssertEqual(p.stepsCovered, 2); XCTAssertEqual(p.msPerStep, 2); XCTAssertEqual(p.treePerStep?.map(\.step), ["step#1 1→4", "step#2 2→5"])
    let text = JSONOut.encode(p)
    XCTAssertTrue(text.contains("\"chain\""))                         // unbranched runs are written as one node…
    let back = try JSONOut.decode(ProfileResult.self, from: Data(text.utf8))
    XCTAssertEqual(back, p)                                           // …and expand again
    let old = #"{"schema":"deskbench.profile/1","template":"Time Profiler","trace":"/x.trace","scenario":"step","fixture":"crew17","process":"CapcomdDeskBench","durationS":12,"notes":[],"signposts":{}}"#
    let o = try JSONOut.decode(ProfileResult.self, from: Data(old.utf8))
    XCTAssertEqual(o.schema, "deskbench.profile/1"); XCTAssertNil(o.tree); XCTAssertNil(o.steps)
  }

  // Two builds of a reel step, 1 ms samples. a: the scroll animation drives a commit (100 per step) and a layout pass
  // runs in the display cycle (60); b: the animation is gone, a sizeThatFits wall appeared (120), and the same layout
  // pass now runs under displayIfNeeded instead (moved, not removed).
  func side(_ stacks: [([String], Int)], steps: Int) -> DiffInput {
    var b = CallTreeBuilder(), names: [String] = [], index: [String: Int32] = [:]
    for (frames, n) in stacks {
      let ids = frames.map { f -> Int32 in if let i = index[f] { return i }; let i = Int32(names.count); names.append(f); index[f] = i; return i }
      for _ in 0..<n { b.add(ids) }
    }
    let t = b.tree(root: "main thread", names: names, ours: names.map { $0.hasPrefix("Reel") })
    return DiffInput(side: DiffSide(steps: steps, stepSource: "signpost", samples: t.v, sampleIntervalMs: 1), tree: t)
  }

  func testDiffRanksWhatGrewAndShrankPerStepAndSeesMoves() {
    let run = ["start", "main", "CFRunLoopRun"]
    let a = side([(run + ["-[NSAnimation advance]", "-[NSScrollAnimationHelper setProgress:]", "ScrollViewCommitMutation.commit", "AG::Graph::propagate_dirty"], 200),
                  (run + ["DisplayCycleObserverForLayout", "-[NSWindow layoutIfNeeded]", "ReelView.layout", "-[NSView layout]"], 120),
                  (run + ["ReelView.body"], 40)], steps: 2)
    let b = side([(run + ["ReelRepresentable.updateNSView", "LayoutEngineBox.sizeThatFits", "-[NSISEngine solve]"], 480),
                  (run + ["-[NSWindow displayIfNeeded]", "-[NSWindow layoutIfNeeded]", "ReelView.layout", "-[NSView layout]"], 240),
                  (run + ["ReelView.body"], 80)], steps: 4)
    let d = Diff.make(a: a, b: b, scenario: "step", top: 5)
    XCTAssertEqual(d.schema, "perfloop.diff/1")
    XCTAssertEqual(d.a.msPerStep, 180); XCTAssertEqual(d.b.msPerStep, 200); XCTAssertEqual(d.deltaMsPerStep, 20)   // per step: 360/2, 800/4
    // Largest growth: the sizeThatFits subtree, as one chain (its frames moved together), under our frame.
    XCTAssertEqual(d.losses.first?.chain, ["ReelRepresentable.updateNSView", "LayoutEngineBox.sizeThatFits", "-[NSISEngine solve]"])
    XCTAssertEqual(d.losses.first?.d, 120); XCTAssertEqual(d.losses.first?.ours, true)
    // Largest shrink: the scroll animation's subtree, outermost frame first, reported once.
    XCTAssertEqual(d.gains.first?.symbol, "-[NSAnimation advance]")
    XCTAssertEqual(d.gains.first?.chain.contains("ScrollViewCommitMutation.commit"), true)
    XCTAssertEqual(d.gains.first?.d, -100); XCTAssertEqual(d.gains.first?.a, 100); XCTAssertEqual(d.gains.first?.b, 0)
    XCTAssertEqual(d.gains.filter { $0.chain.contains("AG::Graph::propagate_dirty") }.count, 1)
    // The layout pass moved: not a gain or a loss of its own, listed as a move.
    XCTAssertFalse((d.gains + d.losses).contains { $0.chain.contains("DisplayCycleObserverForLayout") || $0.chain.contains("-[NSWindow displayIfNeeded]") })
    XCTAssertTrue(d.moved.contains { $0.symbol == "-[NSWindow layoutIfNeeded]" && $0.fromUnder == "DisplayCycleObserverForLayout" && $0.toUnder == "-[NSWindow displayIfNeeded]" })
    // ReelView.body: 20 ms per step on both sides, not a mover.
    XCTAssertFalse((d.gains + d.losses).contains { $0.chain.contains("ReelView.body") })
    XCTAssertEqual(d.remaining.first?.symbol, "ReelRepresentable.updateNSView")
    let text = Explain.text(d)
    XCTAssertTrue(text.contains("grew in b")); XCTAssertTrue(text.contains("LayoutEngineBox.sizeThatFits")); XCTAssertTrue(text.contains("moved: -[NSWindow layoutIfNeeded]"))
    let back = try? JSONOut.decode(DiffResult.self, from: Data(JSONOut.encode(d).utf8))
    XCTAssertEqual(back, d)
  }

  func testProvenanceRefusesStaleAndCrossOSUnlessAllowed() {
    var a = DiffSide(steps: 16, stepSource: "signpost", samples: 1, sampleIntervalMs: 1), b = a
    a.build = DiffBuild(commit: "3a6b5b7", stamp: false); b.build = DiffBuild(hash: "sha256:abcdef0123", commit: "9bcd41a", dirty: false, stamp: true)
    XCTAssertFalse(Diff.provenance(a: a, b: b, champion: nil, allowStale: false, allowCrossOS: false).refused)
    let stale = Diff.provenance(a: a, b: b, champion: "9bcd41a", allowStale: false, allowCrossOS: false)
    XCTAssertTrue(stale.stale); XCTAssertTrue(stale.refused); XCTAssertTrue(stale.reasons[0].contains("3a6b5b7 ≠ champion 9bcd41a"))
    XCTAssertFalse(Diff.provenance(a: a, b: b, champion: "9bcd41a", allowStale: true, allowCrossOS: false).refused)
    XCTAssertFalse(Diff.provenance(a: b, b: a, champion: "9bcd41a", allowStale: false, allowCrossOS: false).refused)
    XCTAssertTrue(Diff.provenance(a: DiffSide(steps: 1, stepSource: "-", samples: 1, sampleIntervalMs: 1), b: b, champion: "9bcd41a", allowStale: false, allowCrossOS: false).refused)   // unstamped
    a.os = "Version 27.0.1 (Build 26A434)"; b.os = "27.0.1 (26A434)"
    XCTAssertFalse(Diff.provenance(a: a, b: b, champion: nil, allowStale: false, allowCrossOS: false).crossOS)   // the same build, two spellings
    b.os = "27.1 (26B12)"
    XCTAssertTrue(Diff.provenance(a: a, b: b, champion: nil, allowStale: false, allowCrossOS: false).refused)
    XCTAssertFalse(Diff.provenance(a: a, b: b, champion: nil, allowStale: false, allowCrossOS: true).refused)
  }
}
