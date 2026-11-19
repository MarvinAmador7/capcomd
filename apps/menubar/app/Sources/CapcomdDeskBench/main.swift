import AppKit
import Foundation
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit
import PerfLoopProbe

// CapcomdDeskBench (`deskbench`): the desktop window's PerfLoop bench (DESKBENCH.md). PerfLoopHost answers the
// runner's whole contract (list, describe, run, snapdiff, profile, diff, knobs, gestures, record-gesture); this file
// says what to measure (DeskBenchKit/BenchCatalog.swift: scenarios, fixtures, guards) and how to drive it (Drive*.swift),
// and keeps the verbs only capcomd has (`fixture`, `fixture capture`, `gestures --write`). The verbs that open a window
// run inside the bench's SwiftUI app (BenchApp.swift: `bench.attach()` from its `init`).

let drivers: [String: ScenarioBody] = [
  "open": Drive.open, "switch": Drive.switchProjects, "step": Drive.step, "jump": Drive.jump, "fling": Drive.fling,
  "swipe": { try await Drive.swipe($0) }, "burst": Drive.burst, "typing": Drive.typing, "resize": Drive.resize, "follow": Drive.follow,
  "sidebar-toggle": DriveSidebar.sidebarToggle, "sidebar-select": DriveSidebar.sidebarSelect, "sidebar-burst": DriveSidebar.sidebarBurst,
  "sidebar-scroll": DriveSidebar.sidebarScroll,
  "palette-open": Palette.paletteOpen, "palette-type": Palette.paletteType, "palette-keys": Palette.paletteKeys,
  "split-open": DriveSplits.splitOpen, "split-focus": DriveSplits.splitFocus, "split-burst": DriveSplits.splitBurst,
  "pane-expand": DriveSplits.paneExpand, "expand-switch": DriveSplits.expandSwitch,
  "needs-open": NeedsDrive.needsOpen, "needs-answer": NeedsDrive.needsAnswer, "needs-arrive": NeedsDrive.needsArrive,
  "needs-step": NeedsDrive.needsStep, "needs-empty": NeedsDrive.needsEmpty, "needs-swipe": NeedsDrive.needsSwipe,
]

let bench = MainActor.assumeIsolated {
  BenchCatalog.make(stamp: perfLoopBuildStamp, knobs: { DeskKnobs.knobs }, body: { drivers[$0] }, builtWithin: { await BuiltWithinGuard.judge($0, $1) })
}

let extraHelp = """

deskbench's own (capcomd)
  describe [--json]                     the manifest, with appearances ["dark"] (the app draws dark only)
  fixture NAME [--json]                 what a fixture builds: projects, agents, items, asks (NAME@agents=24,items=100;
                                        file:PATH, a captured one)
  fixture capture --from SOCKET --run ID [--out FILE] [--token-file F | --keychain] [--raw] [--json]
                                        read runs from a daemon as the app does, anonymised: a fixture for --fixture file:FILE
  gestures --write DIR                  write the synthetic gestures as files (apps/menubar/app/Gestures)
  run SCENARIO --gesture FILE           the same as --set gesture=FILE (repeat it: taken in turn)
  run SCENARIO --size WxH               the window's size (--set size=WxH; default 1440x900)
environment: DESKBENCH_SAMPLER=off (PERFLOOP_SAMPLER=off), DESKBENCH_SIZING=1 (open: NSHostingView's default sizing
  options, as the scene's hosting view has), DESKBENCH_APPKIT_TRACE=1 (swipe, record-gesture: AppKit's own deceleration,
  on stderr)
"""

/// The command line as PerfLoopHost takes it: `--gesture X` and `--size WxH` as `--set`.
func prepare(_ argv: [String]) -> [String] {
  var out: [String] = [], gestures: [String] = []
  var i = 0
  while i < argv.count {
    let a = argv[i], next = i + 1 < argv.count ? argv[i + 1] : nil
    if a == "--gesture", let n = next { gestures.append(n); i += 2; continue }
    if a == "--size", let n = next { out += ["--set", "size=\(n)"]; i += 2; continue }
    out.append(a); i += 1
  }
  if !gestures.isEmpty { out += ["--set", "gesture=\(gestures.joined(separator: ","))"] }
  return out
}

func say(_ s: String) { FileHandle.standardOutput.write(Data((s + "\n").utf8)) }
func complain(_ s: String) { FileHandle.standardError.write(Data(("deskbench: " + s + "\n").utf8)) }

let env = ProcessInfo.processInfo.environment
if env["DESKBENCH_SAMPLER"] == "off" { setenv("PERFLOOP_SAMPLER", "off", 1) }
let argv = prepare(Array(CommandLine.arguments.dropFirst()))
let args = Args(argv)

switch args.positional.first {
case "help", "-h", "--help", nil:
  MainActor.assumeIsolated { say(bench.help + "\n" + extraHelp) }
  exit(0)
case "describe":
  MainActor.assumeIsolated { say(PLJSON.encode(BenchCatalog.manifest(bench))) }
  exit(0)
case "gestures" where args.has("write"):
  let dir = URL(fileURLWithPath: args.one("write")!)
  do {
    try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    for g in SyntheticGestures.all where Gestures.committed.contains(g.name) {
      let u = dir.appendingPathComponent("\(g.name).json"); try g.encoded().write(to: u, options: .atomic); say(u.path)
    }
    exit(0)
  } catch { complain("\(error)"); exit(2) }
case "fixture":
  // Headless: the main run loop without NSApplication (no Dock icon, no window server connection).
  Task { @MainActor in exit(await FixtureCommand.run(args)) }
  CFRunLoopRun()
case "run", "record-gesture":
  // Inside the bench's SwiftUI app: its `init` hands the command line to `bench.attach`, which starts the verb once the
  // app has launched (its scene's window and its menu bar up).
  MainActor.assumeIsolated { DeskBenchApp.argv = argv }
  DeskBenchApp.main()
default:
  bench.main(argv)
}
