// Feasibility probe for capability 1's symbolication: dladdr only knows exported symbols, so an address inside a
// non-exported AppKit/SwiftUI function is reported as "<nearest export>+offset". `atos -p <pid>` (CoreSymbolication,
// shared-cache aware) names the real function while the process is alive. The probe prints both for an address
// 0x4000 past NSApplicationMain, then sleeps so the shell can run atos against it. Headless: AppKit is loaded, no
// NSApplication is created, no window.
//   swiftc -O main.swift -o symbolicate && ./symbolicate & sleep 0.3; atos -p $! <addr>
import Darwin
import Foundation

setvbuf(stdout, nil, _IONBF, 0)
guard let h = dlopen("/System/Library/Frameworks/AppKit.framework/AppKit", RTLD_NOW), let sym = dlsym(h, "NSApplicationMain") else { print("no AppKit"); exit(2) }
let inside = UInt(bitPattern: sym) + 0x4000
for a in [UInt(bitPattern: sym), inside] {
  var info = Dl_info()
  let ok = dladdr(UnsafeRawPointer(bitPattern: a), &info) != 0
  let name = ok ? (info.dli_sname.map { String(cString: $0) } ?? "<no symbol>") : "<dladdr failed>"
  let off = ok ? a - UInt(bitPattern: info.dli_saddr) : 0
  print(String(format: "0x%lx  dladdr: %@+0x%lx", a, name, off))
}
print("pid \(getpid())")
Thread.sleep(forTimeInterval: Double(CommandLine.arguments.dropFirst().first ?? "8") ?? 8)
