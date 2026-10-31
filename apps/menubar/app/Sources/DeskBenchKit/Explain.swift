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
    o += stepCauseLines(r)
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
    let when = w.step.hasPrefix("before ") || w.step.hasPrefix("after ") ? w.step : "during \(w.step)"
    var o = ["  \(String(format: "%7.1f", w.durationMs)) ms wall \(String(format: "%6.1f", w.cpuMs)) ms cpu  \(when)  \(b.isEmpty ? noBodies : b)"]
    if let c = w.causes, !c.isEmpty { o.append("             causes: " + causesText(c)) }
    guard let n = w.samples else { return o }
    let pad = "             "
    guard n > 0, let tree = w.stacks else {
      o.append(pad + (w.unsampled == "missed" ? "not sampled: it passed the gate, but the sampler thread got no core in time (a loaded machine)"
                      : w.unsampled == "gate" ? "not sampled (shorter than the sampler's gate)"
                      : "not sampled (shorter than the sampler's gate, or cut off: an older bench's sampler stopped at a run-loop exit)"))
      return o
    }
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

  /// What the long stretches' samples say first (where the time went, by frame), then the patterns the desktop work
  /// has met before, matched on the body counts inside long stretches.
  public static func suggestions(_ r: BenchResult) -> [String] {
    var out = stackCauses(r)
    let s = r.summary
    let stretches = r.reps.flatMap(\.worstStretches)
    let scrolling = ["step", "jump", "fling", "follow"].contains(r.scenario)
    // Bodies only in the stretches that belong to a step: the setup (rewinding the reel, building columns) is meant to build.
    let inSteps = stretches.filter { !$0.step.hasPrefix("before ") && !$0.step.hasPrefix("after ") }
    func total(_ view: String) -> Int { inSteps.reduce(0) { $0 + ($1.bodies[view] ?? 0) } }
    // The reel (Reel.swift's ReelView) gives each column its own hosting view, and a slide moves the scroll offset once
    // and animates the document layer in the render server: a step should update a column at most once.
    if scrolling, total("Column") > 2 * max(1, r.reps.count) {
      out.append("Column bodies ran in the steps' long stretches (\(total("Column"))): more than the once per step a slide needs. Look for a model property every Column reads that changes during a step (focusedAgent, onScreen) or a changed identity; ReelView.slide moves the offset once, so columns shouldn't re-evaluate on the way.")
    }
    if scrolling, total("EntryRow") > 20 * max(1, r.reps.count) {
      out.append("EntryRow bodies ran during the steps (\(total("EntryRow"))): thread rows were created or re-evaluated on the way (ColumnThread's LazyVStack building rows of a column that wasn't warm, or rows re-evaluated). Threads should be warmed while the reel stands still (DeskModel.warm) and rows are Equatable; check that ThreadSlice isn't reassigned with equal data.")
    }
    if scrolling, total("TitleBar") + total("OpenGroup") + total("CrewTab") > 4 * max(1, r.reps.count) {
      out.append("Title bar views re-evaluated in the steps (TitleBar/OpenGroup/CrewTab, \(total("TitleBar") + total("OpenGroup") + total("CrewTab"))): the reel position reaches the model once per column crossed (ReelView.scrolled → DeskModel.reelScrolled(toIndex:)), so something else they read changes during a step.")
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

extension Explain {
  /// Our frames that are the bench driving the window, not the app: never a cause.
  static let benchTypes: Set<String> = ["Drive", "Harness", "Runner", "Commands", "SelfTest", "BenchScene", "MainThreadSampler", "StretchClock", "main"]

  /// Framework frames worth naming as a cause, and what each means for the desktop window.
  static let families: [(match: [String], meaning: String)] = [
    (["LazySubviewPlacements", "_LazyLayoutViewCache", "LazyLayout", "LazyStack"], "a lazy stack placing subviews: ColumnThread's LazyVStack builds rows as they come on screen"),
    (["propagate_dirty"], "AttributeGraph invalidating what depends on a changed value: a value many views read changed"),
    (["ViewGraphRootValueUpdater", "UpdateStack::update", "GraphHost"], "SwiftUI updating its view graph"),
    (["layoutSubtreeIfNeeded", "_layoutSubtree", "_layoutViewTree", "NSHostingView.layout", "sizeThatFits"], "AppKit's layout pass"),
    (["displayIfNeeded", "drawRect", "drawLayer", "CA::Layer::display"], "drawing"),
    (["CTLine", "CTFramesetter", "CoreText", "NSTextField", "NSTextLayoutManager"], "text layout"),
    (["destroy value witness", "removeFromSuperview", "dealloc", "outlined destroy"], "tearing views or values down"),
    (["CA::Transaction::commit", "CA::Context::commit_transaction"], "Core Animation's commit"),
    (["decode", "JSON"], "decoding"),
  ]

  static func isBench(_ symbol: String) -> Bool {
    let last = symbol.components(separatedBy: " in ").last ?? symbol
    return benchTypes.contains(String(last.prefix { $0 != "." && $0 != "(" && $0 != " " }))
  }

  static func family(_ symbol: String) -> String? { families.first { f in f.match.contains { symbol.contains($0) } }?.meaning }

  /// Causes from the samples of the long stretches (over 16.7 ms; the steps' own when there are any): their call trees
  /// merged, the heaviest frames that are ours (the app's, not the bench's) or a known framework hot spot, each with its
  /// share of the samples, where inside it the time mostly went and, for a framework frame, which of our frames it ran
  /// under. A frame inside one already named that holds most of its weight replaces it: the more specific one is the cause.
  public static func stackCauses(_ r: BenchResult, limit: Int = 3) -> [String] {
    let all = r.reps.flatMap(\.worstStretches).filter { ($0.samples ?? 0) > 0 && $0.stacks != nil && $0.durationMs > 16.7 }
    let inSteps = all.filter { !$0.step.hasPrefix("before ") }
    let sampled = inSteps.isEmpty ? all : inSteps
    guard !sampled.isEmpty else { return [] }
    let tree = StackTree.merge(sampled.compactMap(\.stacks))
    let total = tree.v
    guard total > 0 else { return [] }
    var weight: [String: Int] = [:], under: [String: [String: Int]] = [:], ours: Set<String> = []
    for w in sampled {
      for x in w.topOurs ?? [] where !isBench(x.symbol) && StackTree.informative(x.symbol) { weight[x.symbol, default: 0] += x.samples; ours.insert(x.symbol) }
      for x in w.topFramework ?? [] where family(x.symbol) != nil && StackTree.informative(x.symbol) {
        weight[x.symbol, default: 0] += x.samples
        if let u = x.under, !isBench(u) { under[x.symbol, default: [:]][u, default: 0] += x.samples }
      }
    }
    var picked: [(sym: String, node: StackTree)] = []
    // Ours first (what an agent can change), then the framework hot spots; heaviest first within each.
    let order = weight.sorted { (ours.contains($0.key) ? 1 : 0, $0.value, $1.key) > (ours.contains($1.key) ? 1 : 0, $1.value, $0.key) }
    for (sym, _) in order {
      guard let node = tree.gather(sym), node.v >= total * 0.1 else { continue }
      // Inside one already named and holding most of it: the more specific frame replaces it.
      if let i = picked.firstIndex(where: { $0.node.contains(sym) && node.v >= $0.node.v * 0.8 && ours.contains(sym) == ours.contains($0.sym) }) { picked[i] = (sym, node); continue }
      // A wrapper (or a callee) holding about the same time as one already named says nothing new.
      if picked.contains(where: { (node.contains($0.sym) || $0.node.contains(sym)) && abs(node.v - $0.node.v) < max(node.v, $0.node.v) * 0.2 }) { continue }
      picked.append((sym, node))
      if picked.count == limit { break }
    }
    let span = "\(sampled.count) long stretch\(sampled.count == 1 ? "" : "es"), \(Int(total)) samples"
    return picked.enumerated().map { i, p in
      let (sym, node) = p
      func pct(_ v: Double) -> String { "\(Int((v / total * 100).rounded())) %" }
      var line = "\(pct(node.v)) of the samples in the long stretches\(i == 0 ? " (\(span))" : "") were under \(sym)"
      if ours.contains(sym) { line += " (our code)" } else if let m = family(sym) { line += " (\(m))" }
      if !ours.contains(sym), let u = under[sym]?.max(by: { ($0.value, $1.key) < ($1.value, $0.key) })?.key { line += ", beneath \(u)" }
      if let m = node.mostlyIn(), m.n != sym {
        let meaning = family(m.n).flatMap { $0 == family(sym) ? nil : $0 }
        line += "; mostly in \(m.n) (\(pct(m.v)))" + (meaning.map { ": \($0)" } ?? "")
      }
      return line + "."
    }
  }
}

extension Double {
  var clean: String { self == self.rounded() ? String(Int(self)) : String(self) }
}
