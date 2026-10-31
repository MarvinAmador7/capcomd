import XCTest
import DeskBenchKit

/// The sampler's pure half: symbol names, folding stacks into a tree and tops, the schema's new fields, and `explain`.
final class StacksTests: XCTestCase {
  // MARK: symbols

  func testSwiftNamesDemangleAndClean() {
    // Real symbols from the bench binary (nm), and SwiftUI-shaped ones.
    let cases: [(String, String)] = [
      ("$s11CapcomdDesk8ReelViewC5slide33_2B7A2AA8F133D4F51567A0284E65F985LL2to4fromySi_12CoreGraphics7CGFloatVSgtF", "ReelView.slide"),
      ("$s11CapcomdDesk8ReelViewC5slide33_2B7A2AA8F133D4F51567A0284E65F985LL2to4fromySi_12CoreGraphics7CGFloatVSgtFyycfU_TA", "closure #1 in ReelView.slide"),
      ("$s11CapcomdDesk8ReelViewC20intrinsicContentSizeSo6CGSizeVvgTo", "ReelView.intrinsicContentSize.getter"),
      ("$s11CapcomdDesk8ReelViewC5coderACSgSo7NSCoderC_tcfcTf4dn_n", "ReelView.init"),
      ("$s11CapcomdDesk0B5ModelC8onScreenShySSGvg", "DeskModel.onScreen.getter"),
      ("$s7SwiftUI24ScrollViewCommitMutationV6commityyF", "ScrollViewCommitMutation.commit"),
      ("$s7SwiftUI13NSHostingViewC6layoutyyFTo", "NSHostingView.layout"),
    ]
    for (raw, want) in cases { XCTAssertEqual(Symbols.name(raw), want, raw) }
  }

  func testCxxAndObjCNames() {
    XCTAssertEqual(Symbols.demangle("_ZN2AG5Graph15propagate_dirtyENS_4data3ptrINS_4NodeEEE"), "AG::Graph::propagate_dirty(AG::data::ptr<AG::Node>)")
    XCTAssertEqual(Symbols.name("_ZN2AG5Graph15propagate_dirtyENS_4data3ptrINS_4NodeEEE"), "AG::Graph::propagate_dirty")
    XCTAssertEqual(Symbols.name("-[NSView(NSLayout) _layoutSubtreeWithOldSize:]"), "-[NSView(NSLayout) _layoutSubtreeWithOldSize:]")
    XCTAssertEqual(Symbols.name("CFRunLoopRunSpecific"), "CFRunLoopRunSpecific")
    XCTAssertEqual(Symbols.name("$sNotAValidMangling"), "$sNotAValidMangling")   // left alone when the runtime can't demangle it
  }

  func testCleanDemangledForms() {
    let cases: [(String, String)] = [
      ("(1) suspend resume partial function for static CapcomdDeskBench.SelfTest.sampler(json: Swift.Bool) async -> Swift.Int32", "SelfTest.sampler"),
      ("protocol witness for SwiftUI.CommitMutation.commit() -> () in conformance SwiftUI.ScrollViewCommitMutation : SwiftUI.CommitMutation in SwiftUI", "ScrollViewCommitMutation.commit"),
      ("protocol witness for SwiftUI.Layout.sizeThatFits(proposal: SwiftUI.ProposedViewSize) -> __C.CGSize in conformance SwiftUI.LayoutEngineBox : SwiftUI.Layout in SwiftUI", "LayoutEngineBox.sizeThatFits"),
      ("CapcomdStore.CapcomdStore.receive(_: CapcomdStore.Frame, scope: Swift.String) -> ()", "CapcomdStore.receive"),
      ("generic specialization <CapcomdDesk.Column> of SwiftUI.NSHostingView.layout() -> ()", "NSHostingView.layout"),
      ("merged SwiftUI.ViewGraph.updateOutputs(at: SwiftUI.Time) -> ()", "ViewGraph.updateOutputs"),
      ("(extension in SwiftUI):SwiftUI.View.frame(width: CoreGraphics.CGFloat?) -> some", "View.frame"),
      ("reabstraction thunk helper from @escaping @callee_guaranteed () -> () to @escaping @callee_unowned @convention(block) () -> ()", "(thunk)"),
      ("SwiftUI.LayoutEngineBox.sizeThatFits(SwiftUI._ProposedSize) -> __C.CGSize", "LayoutEngineBox.sizeThatFits"),
      // xctrace's own (already demangled, module-less) names come out the same, so C2's trees and these agree.
      ("ScrollViewCommitMutation.commit()", "ScrollViewCommitMutation.commit"),
    ]
    for (raw, want) in cases { XCTAssertEqual(Symbols.clean(raw), want, raw) }
    XCTAssertEqual(Symbols.clean(String(repeating: "x", count: 300)).count, 110)
  }

  // MARK: folding

  /// The probe's 90/10 workload, leaf first, with the link register repeating the pc's function in some samples.
  func knownStacks() -> [[StackFrame]] {
    let trunk = [StackFrame("__CFRunLoopDoObservers"), StackFrame("CFRunLoopRunSpecific"), StackFrame("main", ours: true), StackFrame("start")]
    let view = StackFrame("ReelView.slide", ours: true)
    let hot = [StackFrame("AG::Graph::propagate_dirty"), StackFrame("ScrollViewCommitMutation.commit"), view] + trunk
    let cold = [StackFrame("CTFrameDraw"), StackFrame("DeskModel.scroll", ours: true)] + trunk
    var out: [[StackFrame]] = []
    for i in 0..<90 { out.append(i % 3 == 0 ? [hot[0]] + hot : hot) }   // a repeated leaf is one frame
    for _ in 0..<10 { out.append(cold) }
    return out
  }

  func testFoldBuildsTreeAndTops() {
    let p = StackProfile(stacks: knownStacks())
    XCTAssertEqual(p.samples, 100)
    XCTAssertEqual(p.tree.n, "main thread"); XCTAssertEqual(p.tree.v, 100)
    XCTAssertEqual(p.tree.c.map(\.n), ["start"])
    XCTAssertEqual(p.tree.hotPath.map(\.n), ["start", "main", "CFRunLoopRunSpecific", "__CFRunLoopDoObservers", "ReelView.slide", "ScrollViewCommitMutation.commit", "AG::Graph::propagate_dirty"])
    XCTAssertEqual(p.tree.hotPath.last?.v, 90)
    XCTAssertEqual(p.ours, [SymbolCount(symbol: "ReelView.slide", samples: 90), SymbolCount(symbol: "DeskModel.scroll", samples: 10)])   // `main` is trunk
    XCTAssertEqual(p.framework.map(\.symbol), ["AG::Graph::propagate_dirty", "ScrollViewCommitMutation.commit", "CTFrameDraw"])
    XCTAssertEqual(p.framework.first?.under, "ReelView.slide")
    XCTAssertEqual(p.framework.last?.under, "DeskModel.scroll")
    XCTAssertEqual(p.selfTop.first, SymbolCount(symbol: "AG::Graph::propagate_dirty", samples: 90))
    // inclusive: a frame counts once per sample even when it repeats
    XCTAssertEqual(p.tree.nodeCount, 1 + 4 + 3 + 2)
  }

  func testPruningKeepsWeightInParent() {
    var stacks = knownStacks()
    stacks += (0..<2).map { _ in [StackFrame("rare"), StackFrame("ReelView.slide", ours: true), StackFrame("main", ours: true), StackFrame("start")] }
    let p = StackProfile(stacks: stacks, minShare: 0.05)   // 102 samples: nodes under 6 samples go
    func find(_ t: CallTree, _ n: String) -> CallTree? { t.n == n ? t : t.c.lazy.compactMap { find($0, n) }.first }
    XCTAssertNil(find(p.tree, "rare"))
    XCTAssertEqual(p.tree.v, 102)
    XCTAssertTrue(p.framework.contains { $0.symbol == "rare" })   // the tops aren't pruned
  }

  func testTrunk() {
    for s in ["start", "main", "CFRunLoopRunSpecific", "__CFRunLoopRun", "_CFRunLoopRunSpecificWithOptions", "__CFRUNLOOP_IS_CALLING_OUT_TO_AN_OBSERVER_CALLBACK_FUNCTION__",
              "_dispatch_main_queue_drain", "-[NSApplication run]", "_DPSNextEvent", "swift_job_runImpl"] { XCTAssertTrue(StackProfile.isTrunk(s), s) }
    for s in ["CA::Transaction::commit", "ReelView.slide", "NSHostingView.layout", "AG::Graph::propagate_dirty"] { XCTAssertFalse(StackProfile.isTrunk(s), s) }
  }

  func testSamplerCostPercentiles() {
    var h = [Int](repeating: 0, count: 256)
    h[7] = 50; h[8] = 40; h[30] = 9; h[255] = 1
    XCTAssertEqual(SamplerStats.percentile(h, 50), 7)
    XCTAssertEqual(SamplerStats.percentile(h, 95), 30)
    XCTAssertEqual(SamplerStats.percentile(h, 100), 255)
    XCTAssertEqual(SamplerStats.percentile([Int](repeating: 0, count: 256), 50), 0)
    let s = SamplerStats(hz: 1000, gateMs: 4, samples: 2310, sampledStretches: 12, failures: 0, truncated: 0, stallMs: 17.0, costP50Us: 7, costP95Us: 15, costMaxUs: 78,
                         samplerCpuMs: 3.1, mainCpuMs: 500)
    XCTAssertEqual(s.overheadPct, 0.62)
  }

  // MARK: schema

  func testCallTreeJSONOmitsEmptyChildren() throws {
    let t = CallTree(n: "main thread", v: 3, c: [CallTree(n: "a", v: 2, c: [CallTree(n: "b", v: 1)]), CallTree(n: "d", v: 1)])
    let j = JSONOut.encode(t)
    XCTAssertTrue(j.contains("\"v\" : 3"))           // whole numbers stay integers in the JSON
    XCTAssertFalse(j.contains("\"c\" : [\n\n"))
    XCTAssertEqual(j.components(separatedBy: "\"c\" :").count - 1, 2)   // root and "a" only
    XCTAssertEqual(try JSONOut.decode(CallTree.self, from: Data(j.utf8)), t)
    XCTAssertEqual(try JSONOut.decode(CallTree.self, from: Data(#"{"n":"x","v":1.5}"#.utf8)), CallTree(n: "x", v: 1.5))
  }

  func testOldResultsStillDecodeAndRoundTrip() throws {
    let r = try JSONOut.decode(BenchResult.self, from: Data(v1StepResult.utf8))
    XCTAssertEqual(r.schema, "deskbench.result/1"); XCTAssertEqual(r.scenario, "step")
    XCTAssertEqual(r.reps.count, 1)
    XCTAssertNil(r.reps[0].sampler)
    XCTAssertFalse(r.reps[0].worstStretches.isEmpty)
    XCTAssertTrue(r.reps[0].worstStretches.allSatisfy { $0.samples == nil && $0.stacks == nil && $0.topOurs == nil })
    // Re-encoding an old result adds no sampler keys and loses nothing.
    let again = JSONOut.encode(r)
    for k in ["\"stacks\"", "\"sampler\"", "\"topOurs\"", "\"awakeMs\""] { XCTAssertFalse(again.contains(k), k) }
    XCTAssertEqual(try JSONOut.decode(BenchResult.self, from: Data(again.utf8)), r)
    // The text explanation of an old result is unchanged in kind: the bodies-only line.
    XCTAssertTrue(Explain.text(r).contains("(no view bodies: AppKit/layout/text or the fixture)"))
  }

  func testSampledStretchRoundTripsAndExplains() throws {
    var r = try JSONOut.decode(BenchResult.self, from: Data(v1StepResult.utf8))
    let p = StackProfile(stacks: knownStacks())
    var w = r.reps[0].worstStretches[0]
    w.samples = p.samples; w.stacks = p.tree; w.topOurs = p.ours; w.topFramework = p.framework; w.topSelf = p.selfTop; w.awakeMs = w.durationMs + 3
    r.reps[0].worstStretches[0] = w
    r.reps[0].worstStretches[1].samples = 0
    r.reps[0].sampler = SamplerStats(hz: 1000, gateMs: 4, samples: 100, sampledStretches: 1, failures: 0, truncated: 0, stallMs: 0.7, costP50Us: 7, costP95Us: 15,
                                     costMaxUs: 40, samplerCpuMs: 1, mainCpuMs: 400)
    let back = try JSONOut.decode(BenchResult.self, from: Data(JSONOut.encode(r).utf8))
    XCTAssertEqual(back, r)
    XCTAssertEqual(back.reps[0].worstStretches[0].topFramework?.first?.under, "ReelView.slide")

    let text = Explain.text(back)
    XCTAssertTrue(text.contains("100 samples, awake"), text)
    XCTAssertTrue(text.contains("ReelView.slide 90 %"), text)
    XCTAssertTrue(text.contains("AG::Graph::propagate_dirty 90 % (under ReelView.slide)"), text)
    XCTAssertTrue(text.contains("path: ReelView.slide 90 % › ScrollViewCommitMutation.commit 90 % › AG::Graph::propagate_dirty 90 %"), text)
    XCTAssertTrue(text.contains("self: AG::Graph::propagate_dirty 90 %"), text)
    XCTAssertTrue(text.contains("not sampled (shorter than the sampler's gate)"), text)
    XCTAssertTrue(text.contains("(sampler: 100 samples at 1000 Hz"), text)
    XCTAssertFalse(text.contains("CFRunLoopRunSpecific"), text)   // the trunk is never shown
  }
}
