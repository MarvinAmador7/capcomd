// Feasibility probe for capability 3 (a low-noise objective): does proc_pid_rusage report instructions retired and
// cycles for this process on Apple silicon without root, and how stable is the count across identical runs of work
// compared with wall time and CPU time?
//
//   swiftc -O main.swift -o rusage && ./rusage [reps]
//
// Headless.
import Darwin
import Foundation

func rusage() -> (instructions: UInt64, cycles: UInt64, userNs: UInt64, systemNs: UInt64)? {
  var info = rusage_info_v4()
  // libproc declares the buffer as `rusage_info_t *` (void **), but the kernel writes the struct at the pointer passed:
  // callers do `(rusage_info_t *)&ri`. Passing a pointer to a pointer overruns the stack.
  let rc = withUnsafeMutablePointer(to: &info) { p -> Int32 in
    p.withMemoryRebound(to: rusage_info_t?.self, capacity: MemoryLayout<rusage_info_v4>.size / MemoryLayout<rusage_info_t?>.size) {
      proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0)
    }
  }
  guard rc == 0 else { return nil }
  // ri_user_time / ri_system_time are in mach_absolute_time units (24 MHz ticks on Apple silicon), not ns.
  var tb = mach_timebase_info(); mach_timebase_info(&tb)
  func ns(_ t: UInt64) -> UInt64 { t * UInt64(tb.numer) / UInt64(tb.denom) }
  return (info.ri_instructions, info.ri_cycles, ns(info.ri_user_time), ns(info.ri_system_time))
}

@inline(never) func work() -> Int {
  var x = 0
  for i in 0..<30_000_000 { x = x &+ (i &* 31) ^ (x >> 3) }
  return x
}

func cv(_ xs: [Double]) -> Double {
  let m = xs.reduce(0, +) / Double(xs.count)
  let v = xs.map { ($0 - m) * ($0 - m) }.reduce(0, +) / Double(xs.count)
  return m == 0 ? 0 : v.squareRoot() / m * 100
}

setvbuf(stdout, nil, _IONBF, 0)
let reps = Int(CommandLine.arguments.dropFirst().first ?? "10") ?? 10
guard let first = rusage() else { print("proc_pid_rusage failed: errno \(errno)"); exit(2) }
print("proc_pid_rusage(RUSAGE_INFO_V4) as uid \(getuid()): instructions \(first.instructions) cycles \(first.cycles) (non-zero means counters are readable without root)")
var wall: [Double] = [], cpu: [Double] = [], ins: [Double] = [], cyc: [Double] = []
var sink = 0
for _ in 0..<reps {
  let a = rusage()!, t0 = DispatchTime.now().uptimeNanoseconds
  sink &+= work()
  let t1 = DispatchTime.now().uptimeNanoseconds, b = rusage()!
  wall.append(Double(t1 - t0) / 1e6)
  cpu.append(Double((b.userNs + b.systemNs) - (a.userNs + a.systemNs)) / 1e6)
  ins.append(Double(b.instructions - a.instructions) / 1e6)
  cyc.append(Double(b.cycles - a.cycles) / 1e6)
}
print("\(reps) identical runs (sink \(sink & 1)):")
print(String(format: "  wall ms       mean %9.2f  cv %5.2f %%", wall.reduce(0, +) / Double(reps), cv(wall)))
print(String(format: "  cpu ms        mean %9.2f  cv %5.2f %%", cpu.reduce(0, +) / Double(reps), cv(cpu)))
print(String(format: "  M instr       mean %9.2f  cv %5.2f %%", ins.reduce(0, +) / Double(reps), cv(ins)))
print(String(format: "  M cycles      mean %9.2f  cv %5.2f %%", cyc.reduce(0, +) / Double(reps), cv(cyc)))
print("note: ri_instructions/ri_cycles are per process (all threads); there is no public per-thread instruction counter.")
