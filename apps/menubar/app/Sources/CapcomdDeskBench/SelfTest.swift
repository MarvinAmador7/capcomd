import Foundation
import QuartzCore
import DeskBenchKit

// `deskbench selftest sampler`: the sampler against a known main-thread workload in this process, headless (no
// NSApplication, no window: the main run loop runs bare), through the same StretchClock the harness uses. Each burn
// is one run-loop wake-up, as a long stretch is in the window: 90 % of it under `selftestHot`, 10 % under
// `selftestCold`, all of it in `selftestSpin`. The alignment checks put the work where the clock's edges used to miss
// it: in a `beforeWaiting` observer at Core Animation's order, and after a run-loop exit.

@inline(never) func selftestSpin(_ n: Int) -> Int { var x = 0; for i in 0..<n { x = x &+ (i &* 31) ^ (x >> 3) }; return x }
@inline(never) func selftestHotInner(_ n: Int) -> Int { selftestSpin(n) &+ 1 }
@inline(never) func selftestHot(_ n: Int) -> Int { selftestHotInner(n) &+ 2 }
@inline(never) func selftestCold(_ n: Int) -> Int { selftestSpin(n) &+ 3 }

/// Burns `ms` of main thread in the 90/10 mix; returns the work done (spin steps, in thousands).
@inline(never) func selftestBurn(ms: Double) -> Int {
  let end = CACurrentMediaTime() + ms / 1000
  var work = 0, acc = 0
  // The argument varies with the result so the calls can't be hoisted out of the loop as invariant.
  while CACurrentMediaTime() < end {
    for _ in 0..<8 { acc &+= selftestHot(9_000 &+ (acc & 1)); acc &+= selftestCold(1_000 &+ (acc & 1)); work += 10 }
  }
  return work &+ (acc & 1)
}

/// Allocates and frees as fast as it can for `ms`: the sampler must never suspend the main thread inside malloc and
/// then wait on it.
@inline(never) func selftestAllocate(ms: Double) -> Int {
  let end = CACurrentMediaTime() + ms / 1000
  var n = 0
  while CACurrentMediaTime() < end {
    var d: [String: [Int]] = [:]
    for i in 0..<64 { d["k\(i)"] = Array(repeating: i, count: 16 + i) }
    n &+= d.values.reduce(0) { $0 + $1.count }
  }
  return n
}

@MainActor enum SelfTest {
  struct Report: Codable {
    var schema = "deskbench.selftest/1"
    var test = "sampler"
    var pass: Bool
    var checks: [Check]
    /// Over the attribution phase.
    var sampler: SamplerStats
    /// Work per CPU ms of the main thread, unsampled vs sampled wake-ups (median of alternating phases), and per wall ms.
    var throughputLossPct: Double
    var wallThroughputLossPct: Double
    var shares: [String: Double]
    /// The longest burn, as a worst stretch of a result would carry it.
    var stretch: Stretch?
  }

  static func sampler(json: Bool) async -> Int32 {
    guard MainThreadSampler.supported else { FileHandle.standardError.write(Data("deskbench: the sampler needs arm64\n".utf8)); return Int32(ExitCode.harness) }
    // A hung main thread (a sampler bug that deadlocks it) must not hang the test: a watchdog off the main thread.
    let beat = Beat()
    let dog = Thread {
      while true {
        Thread.sleep(forTimeInterval: 1)
        if beat.age() > 10 { FileHandle.standardError.write(Data("deskbench selftest: the main thread stopped for 10 s (sampler deadlock?)\n".utf8)); exit(Int32(ExitCode.harness)) }
      }
    }
    dog.start()
    func nap() async { beat.touch(); try? await Task.sleep(for: .milliseconds(3)) }

    // An app's main thread runs at user-interactive QoS (a command-line tool's doesn't): what decides how fast it gets
    // its core back after each suspension on a loaded machine.
    pthread_set_qos_class_self_np(QOS_CLASS_USER_INTERACTIVE, 0)
    let config = SamplerConfig()
    let s = MainThreadSampler(config: config)
    let clock = StretchClock(t0: CACurrentMediaTime())
    s.start(); clock.sampler = s; clock.attach()
    var checks: [Check] = []
    /// The clock's stretch that held CACurrentMediaTime `t`.
    func stretch(at t: Double) -> StretchClock.Entry? {
      let ms = (t - clock.t0) * 1000
      return clock.entries.last { $0.at <= ms + 0.01 && $0.at + $0.dur >= ms - 0.01 }
    }

    // 1. The gate: wake-ups shorter than it are never sampled.
    // (A wake-up the machine stretches past the gate is sampled, rightly: the check is that every sampled one was.)
    let m0 = s.mark()
    for _ in 0..<150 { _ = selftestBurn(ms: 1); await nap() }
    let gate = s.stats(since: m0)
    let early = s.spans.filter { $0.wake > m0.lastWake && ($0.sleep - $0.wake) * 1000 < config.gateMs }
    checks.append(Check("gate", early.isEmpty && gate.sampledStretches <= 3, "\(gate.samples) samples in \(gate.sampledStretches) of 150 wake-ups of ~1 ms (gate \(config.gateMs.txt) ms); \(early.count) sampled before the gate"))

    // 2. Attribution: 10 wake-ups of 120 ms each.
    let burnMs = 120.0
    var wakes: [(at: Double, ms: Double)] = []
    let m1 = s.mark()
    for _ in 0..<10 {
      let t = CACurrentMediaTime()
      _ = selftestBurn(ms: burnMs)
      wakes.append((t, (CACurrentMediaTime() - t) * 1000))
      await nap()
    }
    let attr = s.stats(since: m1)
    var all: [[StackFrame]] = [], perSpan: [Int] = [], longest: (Double, Stretch)?
    for w in wakes {
      guard let e = stretch(at: w.at), let sp = s.span(stretch: e.id) else { perSpan.append(0); continue }
      let st = s.stacks(sp)
      all += st; perSpan.append(sp.samples)
      var x = Stretch(step: "selftest", atMs: 0, durationMs: Stats.round(e.dur, 2), cpuMs: Stats.round(e.cpu, 2), bodies: [:])
      s.annotate(&x, stretch: e.id)
      if w.ms > (longest?.0 ?? 0) { longest = (w.ms, x) }
    }
    let p = StackProfile(stacks: all)
    func share(_ sym: String) -> Double {
      let c = (p.ours + p.framework).first { $0.symbol == sym }?.samples ?? 0
      return p.samples > 0 ? Stats.round(Double(c) / Double(p.samples), 3) : 0
    }
    let shares = ["selftestBurn": share("selftestBurn"), "selftestHot": share("selftestHot"), "selftestCold": share("selftestCold"), "selftestSpin": share("selftestSpin")]
    let expected = (burnMs - config.gateMs) * config.hz / 1000
    let minSpan = perSpan.min() ?? 0
    checks.append(Check("coverage", Double(minSpan) >= expected * 0.7, "samples per 120 ms wake-up: \(perSpan.map(String.init).joined(separator: " ")) (expected ≈ \(Int(expected)) after the gate)"))
    checks.append(Check("no-failures", attr.failures == 0 && attr.truncated == 0, "\(attr.failures) failed, \(attr.truncated) truncated of \(attr.samples)"))
    checks.append(Check("attribution", shares["selftestBurn"]! >= 0.97 && shares["selftestSpin"]! >= 0.9 && abs(shares["selftestHot"]! - 0.9) <= 0.06 && abs(shares["selftestCold"]! - 0.1) <= 0.06,
                        "inclusive: burn \(pctText(shares["selftestBurn"]!)) spin \(pctText(shares["selftestSpin"]!)) hot \(pctText(shares["selftestHot"]!)) cold \(pctText(shares["selftestCold"]!)) (expected ≈ 100/100/90/10)"))
    checks.append(Check("ours", p.ours.contains { $0.symbol == "selftestHot" }, "our frames: " + p.ours.prefix(4).map(\.symbol).joined(separator: ", ")))

    // 2b. Alignment: the stretch and its samples cover work the old edges cut off. (a) 60 ms in a beforeWaiting
    // observer at order 2 000 000, where Core Animation commits (the harness's observer at order 0 had already
    // closed the stretch); (b) 60 ms after a run-loop exit inside the wake-up (the sampler closed on `exit`, so a
    // long stretch could read "not sampled").
    let alignMs = 60.0, alignExpected = (alignMs - config.gateMs) * config.hz / 1000
    func align(_ name: String, _ run: (@escaping () -> Void) -> Void) async -> Check {
      var at = 0.0
      run { at = CACurrentMediaTime(); _ = selftestBurn(ms: alignMs) }
      for _ in 0..<40 where at == 0 || stretch(at: at) == nil { await nap() }
      await nap()
      guard at > 0, let e = stretch(at: at) else { return Check(name, false, "the workload didn't run, or no stretch held it") }
      let sp = s.span(stretch: e.id)
      let burn = sp.map { StackProfile(stacks: s.stacks($0)) }.map { p in p.ours.first { $0.symbol == "selftestBurn" }?.samples ?? 0 } ?? 0
      let ok = e.dur >= alignMs - 1 && Double(burn) >= alignExpected * 0.7
      return Check(name, ok, "stretch \(Stats.round(e.dur, 1)) ms around \(Int(alignMs)) ms of work; \(sp?.samples ?? 0) samples, \(burn) in the work (expected ≈ \(Int(alignExpected)))")
    }
    checks.append(await align("align-commit") { work in
      let o = CFRunLoopObserverCreateWithHandler(kCFAllocatorDefault, CFRunLoopActivity.beforeWaiting.rawValue, false, 2_000_000) { _, _ in work() }!
      CFRunLoopAddObserver(CFRunLoopGetMain(), o, CFRunLoopMode.commonModes)
    })
    checks.append(await align("align-exit") { work in
      // A nested pass of the run loop that doesn't wait (entry, sources, exit), then the work, still in the wake-up.
      _ = CFRunLoopRunInMode(CFRunLoopMode.defaultMode, 0, true)
      work()
    })
    let long = clock.entries.filter { $0.at >= (m1.lastWake - clock.t0) * 1000 && $0.dur > 10 }
    let missed = long.filter { s.span(stretch: $0.id) == nil }
    checks.append(Check("every-long-stretch", missed.isEmpty, "\(long.count - missed.count) of \(long.count) stretches over 10 ms have samples\(missed.isEmpty ? "" : "; missed: " + missed.map { "\(Stats.round($0.dur, 1)) ms" }.joined(separator: ", "))"))

    // 3. Cost: the same burns with the sampler detached and attached, alternating. Work per ms of the main thread's
    // CPU is what sampling takes from the work itself (cache, the suspensions); work per wall ms adds the time held
    // suspended and rescheduled, and whatever else the machine was doing (noisy on a shared Mac: reported, not judged).
    var off: [(cpu: Double, wall: Double)] = [], on: [(cpu: Double, wall: Double)] = []
    for round in 0..<12 {
      let sampled = round % 2 == 1
      clock.sampler = sampled ? s : nil
      var work = 0, ms = 0.0, cpu = 0.0
      for _ in 0..<4 {
        let t = CACurrentMediaTime(), c = Harness.threadCpuMs()
        work += selftestBurn(ms: 100)
        ms += (CACurrentMediaTime() - t) * 1000; cpu += Harness.threadCpuMs() - c
        await nap()
      }
      let x = (cpu: Double(work) / max(cpu, 1e-9), wall: Double(work) / ms)
      if sampled { on.append(x) } else { off.append(x) }
    }
    clock.sampler = s
    func lossPct(_ k: KeyPath<(cpu: Double, wall: Double), Double>) -> Double {
      Stats.round((1 - Stats.median(on.map { $0[keyPath: k] }) / max(Stats.median(off.map { $0[keyPath: k] }), 1e-9)) * 100, 2)
    }
    let loss = lossPct(\.cpu), wallLoss = lossPct(\.wall)
    checks.append(Check("cost", loss < 5 && attr.costP50Us < 50, "work lost per CPU ms in sampled wake-ups \(loss) % (per wall ms \(wallLoss) %, on a load of \(String(format: "%.1f", loadAverage()))); \(attr.costP50Us.txt) µs a sample (p95 \(attr.costP95Us.txt), max \(attr.costMaxUs.txt)); sampler thread \(attr.overheadPct) % of the main thread's CPU; main thread held \(attr.stallMs) ms in \(attr.mainCpuMs) ms"))

    // 4. Malloc under sampling: 2 s of allocating wake-ups must finish (the watchdog catches a deadlock).
    let m3 = s.mark()
    for _ in 0..<10 { _ = selftestAllocate(ms: 200); await nap() }
    let alloc = s.stats(since: m3)
    checks.append(Check("malloc", alloc.samples > 500 && alloc.failures == 0, "\(alloc.samples) samples while the main thread allocated for 2 s; \(alloc.failures) failed"))

    clock.detach()
    s.stop()
    beat.stop()
    let pass = checks.allSatisfy(\.pass)
    let r = Report(pass: pass, checks: checks, sampler: attr, throughputLossPct: loss, wallThroughputLossPct: wallLoss, shares: shares, stretch: longest?.1)
    if json { print(JSONOut.encode(r)) } else {
      print("selftest sampler: \(pass ? "PASS" : "FAIL")  (\(config.hz.txt) Hz, gate \(config.gateMs.txt) ms, headless main run loop)")
      for c in checks { print("  \(c.pass ? "✓" : "✗") \(c.name): \(c.detail)") }
      if let w = longest?.1 { print("the longest burn as `explain` prints a worst stretch:"); Explain.stretchLines(w).forEach { print($0) } }
    }
    fflush(stdout)
    return Int32(pass ? ExitCode.ok : ExitCode.harness)
  }

  static func loadAverage() -> Double { var l = [0.0, 0, 0]; return getloadavg(&l, 3) > 0 ? l[0] : 0 }

  static func pctText(_ x: Double) -> String { "\(Stats.round(x * 100, 1)) %" }
}

/// The main thread's heartbeat, for the watchdog.
final class Beat: @unchecked Sendable {
  private let lock = NSLock()
  private var last = CACurrentMediaTime()
  private var stopped = false
  func touch() { lock.lock(); last = CACurrentMediaTime(); lock.unlock() }
  func stop() { lock.lock(); stopped = true; lock.unlock() }
  func age() -> Double { lock.lock(); defer { lock.unlock() }; return stopped ? 0 : CACurrentMediaTime() - last }
}

private extension Double {
  var txt: String { self == self.rounded() ? String(Int(self)) : String(self) }
}
