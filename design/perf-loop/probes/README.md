# Feasibility probes

Headless Swift command-line probes behind `FEASIBILITY.md`. Each is a single file; build with `swiftc -O`. None opens
a window, records a GUI process or sends input. Binaries are gitignored.

| Probe | Build and run | Shows |
|---|---|---|
| `sampler/main.swift` | `swiftc -O main.swift -o sampler && ./sampler 3 1000` | Suspend + `thread_get_state` + frame-pointer walk of the main thread from a background thread at 1 kHz: failures, per-sample cost, overhead, inclusive shares vs a known 90/10 workload |
| `rusage/main.swift` | `swiftc -O main.swift -o rusage && ./rusage 10` | `proc_pid_rusage` instructions and cycles as a normal user; CV across identical runs vs wall and CPU time |
| `symbolicate/main.swift` | `swiftc -O main.swift -o symbolicate && ./symbolicate 6 & sleep 1; xcrun atos -p <pid> <addrs>` | `dladdr` vs `atos -p` on a non-exported AppKit address |
| `symbolicate/scan.swift` | `swiftc -O scan.swift -o scan && ./scan \| swift demangle --simplified` | How many distinct (local) symbols `dladdr` resolves across AttributeGraph |

xctrace probes were shell one-liners, recorded in `FEASIBILITY.md` §1.4–1.6: `xcrun xctrace list templates`,
`xctrace record --template 'CPU Counters' --launch -- /bin/sleep 2`, `--template SwiftUI` likewise, and
`xctrace export --toc` / `--xpath` on the session's existing traces.
