// Does dladdr see non-exported (local) symbols in the shared cache? Walk forward from an exported AttributeGraph entry
// point in 0x400-byte steps and print the distinct names dladdr returns. Headless.
import Darwin
import Foundation
setvbuf(stdout, nil, _IONBF, 0)
guard let h = dlopen("/System/Library/PrivateFrameworks/AttributeGraph.framework/AttributeGraph", RTLD_NOW), let sym = dlsym(h, "AGGraphCreate") else { print("no AttributeGraph"); exit(2) }
var names: [String: Int] = [:]
for i in 0..<400 {
  var info = Dl_info()
  let a = UInt(bitPattern: sym) + UInt(i) * 0x400
  guard dladdr(UnsafeRawPointer(bitPattern: a), &info) != 0 else { continue }
  names[info.dli_sname.map { String(cString: $0) } ?? "<nil>", default: 0] += 1
}
print("\(names.count) distinct symbols across 400 probes (\(names["<nil>"] ?? 0) unnamed)")
for (k, v) in names.sorted(by: { $0.value > $1.value }).prefix(12) { print("  \(v)× \(k)") }
