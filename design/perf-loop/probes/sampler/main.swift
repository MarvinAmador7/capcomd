// Feasibility probe for capability 1 (in-process main-thread sampler).
// A background thread samples the main thread at ~1 kHz with thread_suspend + thread_get_state(ARM_THREAD_STATE64)
// + a frame-pointer walk, then symbolises with dladdr. The main thread runs a known mix (hotA→hotB→spin ≈ 90 %,
// coldA→spin ≈ 10 %) so the sample shares can be checked, and the probe reports the sampler's overhead.
//
//   swiftc -O main.swift -o sampler && ./sampler [seconds] [hz]
//
// Headless: no window, no input, nothing outside this process is touched.
import Darwin
import Foundation

@inline(never) func spin(_ n: Int) -> Int { var x = 0; for i in 0..<n { x = x &+ (i &* 31) ^ (x >> 3) }; return x }
@inline(never) func hotB(_ n: Int) -> Int { spin(n) &+ 1 }
@inline(never) func hotA(_ n: Int) -> Int { hotB(n) &+ 2 }
@inline(never) func coldA(_ n: Int) -> Int { spin(n) &+ 3 }

final class Sampler {
  let target: thread_act_t
  let stackTop: UInt
  let stackBottom: UInt
  let intervalNs: UInt64
  var samples: [[UInt]] = []
  var suspendNs: [UInt64] = []
  var failures = 0
  var running = true
  /// Gate: in the real harness the run-loop observer sets this at afterWaiting and clears it at beforeWaiting, so the
  /// sampler only runs while a stretch is open. Here it stays on.
  var gate = true

  init(target: thread_act_t, pthread: pthread_t, hz: Double) {
    self.target = target
    let addr = UInt(bitPattern: pthread_get_stackaddr_np(pthread))
    let size = UInt(pthread_get_stacksize_np(pthread))
    stackTop = addr; stackBottom = addr - size
    var tb = mach_timebase_info(); mach_timebase_info(&tb)
    ticksPerNs = Double(tb.denom) / Double(tb.numer)   // mach_absolute_time ticks at 24 MHz on Apple silicon, not 1 GHz
    intervalNs = UInt64(1e9 / hz * ticksPerNs)
  }
  let ticksPerNs: Double
  func ns(_ ticks: UInt64) -> UInt64 { UInt64(Double(ticks) / ticksPerNs) }

  func sampleOnce() {
    let t0 = mach_absolute_time()
    guard thread_suspend(target) == KERN_SUCCESS else { failures += 1; return }
    var state = arm_thread_state64_t()
    var count = mach_msg_type_number_t(MemoryLayout<arm_thread_state64_t>.size / MemoryLayout<natural_t>.size)
    let kr = withUnsafeMutablePointer(to: &state) {
      $0.withMemoryRebound(to: natural_t.self, capacity: Int(count)) { thread_get_state(target, thread_state_flavor_t(ARM_THREAD_STATE64), $0, &count) }
    }
    var frames: [UInt] = []
    if kr == KERN_SUCCESS {
      let pc = UInt(state.__pc), lr = UInt(state.__lr)
      var fp = UInt(state.__fp)
      frames.append(pc)
      if lr != 0 { frames.append(lr) }
      var depth = 0
      // The suspended thread cannot move, so its stack memory is stable: read [fp] = caller fp, [fp+8] = return address.
      while depth < 128, fp >= stackBottom, fp + 16 <= stackTop, fp & 0xF == 0 {
        let p = UnsafeRawPointer(bitPattern: fp)!
        let next = p.load(as: UInt.self)
        let ret = p.load(fromByteOffset: 8, as: UInt.self)
        if ret == 0 { break }
        frames.append(ret)
        if next <= fp { break }   // stacks grow down: the caller's frame is above
        fp = next; depth += 1
      }
    } else { failures += 1 }
    thread_resume(target)
    suspendNs.append(ns(mach_absolute_time() - t0))
    samples.append(frames)
  }

  func run() {
    var next = mach_absolute_time()
    while running {
      next += intervalNs
      mach_wait_until(next)
      if gate { sampleOnce() }
    }
  }
}

func symbol(_ addr: UInt) -> String {
  var info = Dl_info()
  guard dladdr(UnsafeRawPointer(bitPattern: addr), &info) != 0 else { return String(format: "0x%lx", addr) }
  if let s = info.dli_sname { return String(cString: s) }
  if let f = info.dli_fname { return "(" + URL(fileURLWithPath: String(cString: f)).lastPathComponent + ")" }
  return String(format: "0x%lx", addr)
}

let seconds = Double(CommandLine.arguments.dropFirst().first ?? "3") ?? 3
let hz = Double(CommandLine.arguments.dropFirst(2).first ?? "1000") ?? 1000
let mainPort = pthread_mach_thread_np(pthread_self())
let mainPthread = pthread_self()

func work(for s: Double) -> Int {
  var iterations = 0, acc = 0
  let end = Date().addingTimeInterval(s)
  while Date() < end {
    acc &+= hotA(90_000)
    acc &+= coldA(10_000)
    iterations += 1
  }
  return iterations &+ (acc & 1)
}

// 1. Baseline: no sampler.
let base = work(for: seconds)

// 2. Sampled.
let sampler = Sampler(target: mainPort, pthread: mainPthread, hz: hz)
let t = Thread { sampler.run() }
t.qualityOfService = .userInteractive
t.start()
let sampled = work(for: seconds)
sampler.running = false
Thread.sleep(forTimeInterval: 0.05)

// 3. Report.
var inclusive: [String: Int] = [:]
var depths: [Int] = []
for s in sampler.samples {
  depths.append(s.count)
  var seen = Set<String>()
  for a in s { let n = symbol(a); if seen.insert(n).inserted { inclusive[n, default: 0] += 1 } }
}
let n = sampler.samples.count
let sorted = sampler.suspendNs.sorted()
func pct(_ p: Double) -> UInt64 { sorted.isEmpty ? 0 : sorted[min(sorted.count - 1, Int(Double(sorted.count) * p))] }
print("sampler probe: \(seconds) s at \(Int(hz)) Hz on \(ProcessInfo.processInfo.machineHardwareName ?? "?")")
print("samples \(n)  failures \(sampler.failures)  stack depth median \(depths.sorted()[max(0, depths.count / 2)])  max \(depths.max() ?? 0)")
print("suspend+get_state+walk+resume per sample: p50 \(pct(0.5)) ns  p95 \(pct(0.95)) ns  max \(sorted.last ?? 0) ns")
print("main-thread throughput: \(base) iterations unsampled vs \(sampled) sampled → overhead \(String(format: "%.2f", (1 - Double(sampled) / Double(base)) * 100)) %")
print("inclusive shares (expected: hotA ≈ 90 %, coldA ≈ 10 %, spin ≈ 100 %):")
for (k, v) in inclusive.sorted(by: { $0.value > $1.value }).prefix(12) {
  print(String(format: "  %5.1f %%  %@", Double(v) / Double(max(n, 1)) * 100, k))
}

extension ProcessInfo {
  var machineHardwareName: String? {
    var size = 0; sysctlbyname("hw.machine", nil, &size, nil, 0)
    var buf = [CChar](repeating: 0, count: size); sysctlbyname("hw.machine", &buf, &size, nil, 0)
    return String(cString: buf)
  }
}
