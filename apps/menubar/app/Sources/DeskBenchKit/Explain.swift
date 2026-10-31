import Foundation

/// A result as a page of text for whoever has to act on it: the verdict, the numbers against the budget, the longest
/// main-thread stretches with what SwiftUI evaluated inside them, and what that pattern usually means.
public enum Explain {
  public static func text(_ r: BenchResult) -> String {
    var o: [String] = []
    let s = r.summary
    o.append("\(r.scenario) on \(r.fixture): \(r.verdict.uppercased())  (\(r.reps.count) reps, \(Int(r.durationMs)) ms, \(r.machine.screenHz.clean) Hz, \(r.tool.configuration))")
    o.append("build: " + (r.tool.build?.line ?? "\(r.tool.commit ?? "unknown commit") (no build stamp: from before it, or read from the cwd)"))
    if r.profiled == true { o.append("profiled: a profiler was attached; these numbers include its cost and are never compared") }
    o.append("budget: \(r.budget.budget)")
    o.append("rule:   \(r.budget.rule)")
    if !r.budget.pass { for why in r.budget.reasons { o.append("  ✗ \(why)") } } else { o.append("  ✓ met") }
    if let c = r.comparison, !c.isEmpty {
      o.append("against the baseline:")
      for x in c { o.append("  \(x.regression ? "✗" : x.improvement ? "✓" : "·") \(x.reason)") }
    }
    if !r.noise.quiet {
      o.append("noise: NOT QUIET. " + r.noise.reasons.joined(separator: "; ") + ". A failed budget here means 'run it again', not 'the reel is slow'.")
    } else {
      o.append("noise: quiet (idle: \(r.noise.idleLate)/\(r.noise.idleTicks) late frames, longest idle stretch \(r.noise.idleLongestStretchMs) ms, load/core \(r.machine.loadPerCore))")
    }
    if let w = r.window, !w.trustworthy { o.append("window: active=\(w.appActive) key=\(w.keyWindow) visible=\(w.visible) occluded=\(w.occluded): SwiftUI flushes late in that state") }
    o.append("")
    o.append("numbers (medians across reps):")
    if let l = s.latencyMs { o.append("  latency       median \(l.median) ms  p95 \(l.p95) ms  max \(l.max) ms  (n=\(l.n))") }
    if let st = s.settleMs { o.append("  settle        median \(st.median) ms  max \(st.max) ms") }
    // The objectives (what ab/compare decide on), then the frames. Results from before them get CPU/step from their reps.
    func dist(_ xs: [Double]) -> Dist? { xs.isEmpty ? nil : Dist(xs) }
    if let ob = s.objective, let v = ob.value { o.append("  objective     \(ob.name) \(v)\(ob.dist.map { " (min \($0.min), max \($0.max), n=\($0.n))" } ?? "")") }
    var per: [String] = []
    if let c = s.mainThreadCpuMsPerStep ?? dist(r.reps.compactMap(\.cpuMsPerStep)) { per.append("main-thread cpu \(c.median) ms (mad \(c.mad))") }
    if let i = s.instructionsPerStep { per.append(String(format: "instructions %.2f M (mad %.2f M)", i.median / 1e6, i.mad / 1e6)) }
    if !per.isEmpty { o.append("  per step      " + per.joined(separator: "  ")) }
    let hitch = s.hitchTimeRatioMsPerS.map { "late frame time \($0.median) ms/s (max \($0.max))  " } ?? ""
    o.append("  frames        \(hitch)display at \(s.steadyHz.median.clean) Hz  p95 \(s.frameP95Ms.median) ms  p99 \(s.frameP99Ms.median) ms  late \(s.lateFrames.median)/rep (max \(s.lateFrames.max))  dropped \(s.droppedFrames.median)/rep")
    o.append("  main thread   longest \(s.longestStretchMs.median) ms (max \(s.longestStretchMs.max))  >16.7 ms: \(s.stretchesOver16.median)/rep  >100 ms: \(s.hangsOver100.median)/rep  cpu share while awake \(Int(s.mainThreadCpuShare * 100)) %")
    if s.mainThreadCpuShare < 0.6 { o.append("  !! the main thread had \(Int(s.mainThreadCpuShare * 100)) % of a core while awake: it was preempted by other processes. Stretch lengths below are wall time; the cpu column is the work.") }
    if s.steadyHz.median < r.machine.screenHz - 0.5, ["step", "jump", "fling", "follow", "burst"].contains(r.scenario) { o.append("  !! the display ran at \(s.steadyHz.median.clean) Hz during the scenario on a \(r.machine.screenHz.clean) Hz panel (adaptive refresh, or a 60 Hz display setting); late frames are judged at that rate") }
    let bodies = s.bodies.sorted { $0.value > $1.value }.prefix(8).map { "\($0.key) \(Int($0.value))" }
    if !bodies.isEmpty { o.append("  bodies/rep    " + bodies.joined(separator: "  ")) }
    if !s.checksFailed.isEmpty { o.append("  checks failed " + s.checksFailed.joined(separator: ", ")) }

    // The worst stretches, with the views evaluated in them.
    let worst = r.reps.flatMap(\.worstStretches).sorted { $0.durationMs > $1.durationMs }.prefix(6)
    if !worst.isEmpty {
      o.append("")
      let sampled = worst.contains { $0.samples != nil }
      o.append("longest main-thread stretches (what SwiftUI evaluated inside each\(sampled ? ", and where the sampled stacks were" : "")):")
      for w in worst { o += stretchLines(w) }
      if let sm = r.reps.compactMap(\.sampler).first {
        let n = r.reps.compactMap(\.sampler).reduce(0) { $0 + $1.samples }
        o.append("  (sampler: \(n) samples at \(sm.hz.clean) Hz once a stretch passed \(sm.gateMs.clean) ms; cost \(sm.costP50Us.clean) µs a sample, sampler thread \(sm.overheadPct) % of the main thread's CPU)")
      }
    }
    let hints = suggestions(r)
    if !hints.isEmpty {
      o.append("")
      o.append("likely causes:")
      for h in hints { o.append("  • " + h) }
    }
    o.append("")
    o.append("next: `deskbench profile \(r.scenario) --fixture \(r.fixture) --template hitches` for the compositor's hitch list, `--template time` for stacks inside the stretches.")
    return o.joined(separator: "\n")
  }

  /// One worst stretch: its line, then (with the sampler on) where its samples were: the top inclusive frames that are
  /// ours or SwiftUI/AppKit hot spots, the hottest path through the framework, and the leaf frames.
  public static func stretchLines(_ w: Stretch) -> [String] {
    let b = w.bodies.sorted { $0.value > $1.value }.prefix(6).map { "\($0.key)×\($0.value)" }.joined(separator: " ")
    let noBodies = w.samples == nil ? "(no view bodies: AppKit/layout/text or the fixture)" : "(no view bodies)"
    var o = ["  \(String(format: "%7.1f", w.durationMs)) ms wall \(String(format: "%6.1f", w.cpuMs)) ms cpu  during \(w.step)  \(b.isEmpty ? noBodies : b)"]
    guard let n = w.samples else { return o }
    let pad = "             "
    guard n > 0, let tree = w.stacks else { o.append(pad + "not sampled (shorter than the sampler's gate)"); return o }
    func pct(_ v: Int) -> String { "\(Int((Double(v) / Double(n) * 100).rounded())) %" }
    let ours = w.topOurs ?? [], fw = w.topFramework ?? []
    let oursSet = Set(ours.map(\.symbol))
    func notable(_ s: String) -> Bool { oursSet.contains(s) || ProfileSummary.hot.contains { s.contains($0) } }
    var top = (ours + fw.filter { notable($0.symbol) }).sorted { ($0.samples, $1.symbol) > ($1.samples, $0.symbol) }
    if top.count < 3 { top += fw.filter { f in !top.contains { $0.symbol == f.symbol } }.prefix(3 - top.count) }
    let awake = w.awakeMs.map { $0 > w.durationMs + 1 ? ", awake \(Stats.round($0, 1)) ms" : "" } ?? ""
    o.append(pad + "\(n) samples\(awake): " + top.prefix(5).map { "\($0.symbol) \(pct($0.samples))\($0.under.map { " (under \($0))" } ?? "")" }.joined(separator: " · "))
    // The hottest path below the run loop: the first frame, every frame that is ours or a hot spot or where the time
    // splits (the share falls by ≥ 3 points), and the last frame still holding ≥ 10 %.
    let path = tree.hotPath.filter { !StackProfile.isTrunk($0.n) && $0.v >= Double(n) * 0.1 }
    var shown: [String] = [], last: Double?, skipped = false
    for (i, p) in path.enumerated() {
      let keep = i == 0 || i == path.count - 1 || notable(p.n) || (last.map { p.v <= $0 - Double(n) * 0.03 } ?? true)
      if keep, shown.count < 8 { shown.append((skipped ? "… › " : "") + "\(p.n) \(pct(Int(p.v)))"); last = p.v; skipped = false } else { skipped = true }
    }
    if !shown.isEmpty { o.append(pad + "path: " + shown.joined(separator: " › ")) }
    if let s = w.topSelf, !s.isEmpty { o.append(pad + "self: " + s.prefix(4).map { "\($0.symbol) \(pct($0.samples))" }.joined(separator: " · ")) }
    return o
  }

  /// Patterns the desktop work has met before, matched on the body counts inside long stretches.
  public static func suggestions(_ r: BenchResult) -> [String] {
    var out: [String] = []
    let s = r.summary
    let stretches = r.reps.flatMap(\.worstStretches)
    let scrolling = ["step", "jump", "fling", "follow"].contains(r.scenario)
    func total(_ view: String) -> Int { stretches.reduce(0) { $0 + ($1.bodies[view] ?? 0) } }
    if scrolling, total("Column") > 2 * max(1, r.reps.count) {
      out.append("Column bodies ran while the reel moved (\(total("Column")) in the long stretches): columns are being rebuilt mid-scroll. A lazy stack, a changed ForEach identity, or a model property every Column reads (focusedAgent, onScreen) that changes per frame. Columns should move, not re-evaluate: see Reel.swift's HStack and .geometryGroup().")
    }
    if scrolling, total("EntryRow") > 20 * max(1, r.reps.count) {
      out.append("EntryRow bodies ran during a scroll (\(total("EntryRow"))): thread rows were created or re-evaluated on the way. Threads should be warmed while the reel stands still (DeskModel.warm) and rows are Equatable; check that ThreadSlice isn't reassigned with equal data.")
    }
    if scrolling, total("TitleBar") + total("OpenGroup") + total("CrewTab") > 4 * max(1, r.reps.count) {
      out.append("Title bar views re-evaluated while scrolling (TitleBar/OpenGroup/CrewTab): the reel position is being reported per frame instead of once per column crossed (Reel's onScrollGeometryChange rounds to a column index; scrollPosition(id:) did not).")
    }
    if r.scenario == "burst", s.checksFailed.contains(where: { $0.hasPrefix("isolation") }) {
      out.append("A thread item re-rendered views outside its column. The store's change keys (ChangeKey.thread(agentId)) or DeskModel.apply are too broad, or a view reads a whole-model property (model.columns, model.decks) that changed.")
    }
    if r.scenario == "typing", s.checksFailed.contains(where: { $0.hasPrefix("isolation") }) {
      out.append("Typing re-rendered views outside ColumnComposer: the draft leaked out of the composer's @State (a binding into the model, or focus state the column reads).")
    }
    if r.scenario == "open" || r.scenario == "switch", let l = s.latencyMs, let b = Scenarios.spec(r.scenario)?.latencyBudgetMs, l.median > b {
      out.append("First frame late: the work before the first commit is too big. Count the bodies in the first stretch (EntryRow × hundreds means threads were built before the first frame; they should warm after it) and check that pages decode off the main thread.")
    }
    if stretches.contains(where: { $0.durationMs > 50 && $0.cpuMs < $0.durationMs * 0.5 }) {
      out.append("Long stretches had less than half their length in CPU time: the main thread was preempted (another process, Spotlight indexing a fresh .build, a build). Those are the machine's, not the reel's; quiet it or use `ab`.")
    }
    if s.hangsOver100.max > 0, stretches.contains(where: { $0.durationMs > 100 && $0.bodies.isEmpty && $0.cpuMs > $0.durationMs * 0.5 && $0.stacks == nil }) {
      out.append("A stretch over 100 ms had no SwiftUI bodies in it: AppKit layout, text layout (CoreText) or the fixture itself. `profile --template time` shows the stack.")
    }
    if !r.noise.quiet, !r.budget.pass {
      out.append("The machine was busy. Re-run with the window frontmost and other heavy apps quiet, or use `ab` (alternating runs) to take the noise out of a comparison.")
    }
    return out
  }
}

extension Double {
  var clean: String { self == self.rounded() ? String(Int(self)) : String(self) }
}
