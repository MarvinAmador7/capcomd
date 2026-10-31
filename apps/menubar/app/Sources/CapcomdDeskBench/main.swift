import AppKit
import Foundation
import DeskBenchKit

// CapcomdDeskBench: the desktop window's performance and debugging harness, for coding agents. `deskbench help`.
// Stable subcommands, --json everywhere, documented schema (DeskBenchKit/Results.swift), exit codes in ExitCode.

let help = """
deskbench: performance and debugging harness for the capcomd desktop window (apps/menubar/app/DESKBENCH.md)

  swift run -c release CapcomdDeskBench <command> [options]

commands
  list [scenarios|fixtures|budgets] [--json]     what can be run, and the SPEC §1 budget each scenario maps to
  fixture <name> [--json]                         describe a fixture: projects, agents, items, asks
  run <scenario> [options]                        drive one scenario in-process on a fixture, judge it against its budget
  suite [options]                                 every scenario in turn; one line each, exit non-zero if any fails
  snapshot [--fixture F] [--out DIR] [--at N]     the window as PNG + a view/geometry dump (JSON), no scenario
  profile <scenario> --template hitches|time|swiftui [--out DIR]
                                                  run the scenario under xctrace and summarise the trace as JSON/text
  trace <file.trace> [--process NAME] [--json]     summarise an existing trace (hitches, hangs, time profile) the same way
  ab --a EXE --b EXE <scenario> [--reps N]        alternate two builds of this bench, compare medians within the noise
  compare <baseline.json> <candidate.json>        regression check between two saved results of the same scenario
  explain <result.json>                           a saved result as text: verdict, numbers, longest stretches, causes
  help

run options
  --fixture NAME        solo | trio | crew17 (default) | crew17-long | swarm64
  --reps N              repetitions (default 3; medians are reported, one rep proves nothing)
  --set key=value       a scenario parameter (see `list --json` → params)
  --json                print the result JSON (otherwise the text explanation)
  --out FILE            also write the result JSON here (a baseline for --baseline / compare)
  --baseline FILE       compare against a saved result; exit 4 on a regression beyond the noise band
  --artifacts DIR       write window PNG + view dump after every rep
  --size WxH            window size (default 1440x900)
  --no-activate         don't bring this process to the front (SwiftUI flushes late in the background; recorded in the result)
  --quiet-check 0|1     measure the noise floor for 1 s before the scenario (default 1)
  --host scene|window   scene (default): the window comes from a SwiftUI Window scene, as in the app; window: an NSWindow
                        made by hand (the default for `open`, which needs a fresh window per rep)
  --hold S              keep the window up S seconds after the run (to look at it)
  --wait-for FILE       show the window, then wait until FILE exists before running (what `profile` uses to attach)
  --sampler on|off      sample the main thread's stacks inside long stretches (default on; worstStretches[].stacks;
                        DESKBENCH_SAMPLER=off in the environment also turns it off, for `ab`'s children)
  --sample-hz N         sampling rate while a stretch is open (default 1000)
  --sample-gate-ms N    sample a stretch only once it has lasted N ms (default 4)

exit codes  0 pass · 1 usage · 2 harness error · 3 budget failed · 4 regression beyond noise · 5 untrusted (failed on a noisy machine: run again)
"""

struct Args {
  var positional: [String] = []
  var flags: [String: [String]] = [:]
  init(_ argv: [String]) {
    var i = 0
    while i < argv.count {
      let a = argv[i]
      if a.hasPrefix("--") {
        let key = String(a.dropFirst(2))
        let valueFlags = ["fixture", "reps", "set", "out", "baseline", "artifacts", "size", "quiet-check", "hold", "wait-for", "template", "a", "b", "at", "variant", "seconds", "process", "host"] + SamplerConfig.flags
        if valueFlags.contains(key), i + 1 < argv.count { flags[key, default: []].append(argv[i + 1]); i += 2 } else { flags[key, default: []].append("1"); i += 1 }
      } else { positional.append(a); i += 1 }
    }
  }
  func has(_ k: String) -> Bool { flags[k] != nil }
  func one(_ k: String) -> String? { flags[k]?.last }
  func all(_ k: String) -> [String] { flags[k] ?? [] }
}

func out(_ s: String) { print(s); fflush(stdout) }
func err(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

func kv(_ xs: [String]) -> [String: String] {
  var d: [String: String] = [:]
  for x in xs { let p = x.split(separator: "=", maxSplits: 1).map(String.init); if p.count == 2 { d[p[0]] = p[1] } }
  return d
}

@MainActor func main() async -> Int32 {
  let argv = Array(CommandLine.arguments.dropFirst())
  let args = Args(argv)
  guard let cmd = args.positional.first else { out(help); return Int32(ExitCode.usage) }
  let json = args.has("json")
  SamplerConfig.current = SamplerConfig(args)
  switch cmd {
  case "help", "-h", "--help": out(help); return 0

  case "list":
    let what = args.positional.dropFirst().first ?? "all"
    if json {
      struct L: Codable { var scenarios: [ScenarioSpec]; var fixtures: [FixtureSpec]; var suite: [String]; var exitCodes: [String: Int] }
      out(JSONOut.encode(L(scenarios: Scenarios.all, fixtures: Fixtures.all, suite: Scenarios.suite,
                           exitCodes: ["ok": 0, "usage": 1, "harness": 2, "budget": 3, "regression": 4, "untrusted": 5])))
      return 0
    }
    if what == "all" || what == "scenarios" || what == "budgets" {
      out("scenarios (→ SPEC §1 budget):")
      for s in Scenarios.all {
        out("  \(s.name.padding(toLength: 8, withPad: " ", startingAt: 0)) \(s.summary)")
        out("           → \(s.budget)"); out("           rule: \(s.rule)")
        if !s.params.isEmpty { out("           params: " + s.params.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")) }
      }
    }
    if what == "all" || what == "fixtures" {
      out("fixtures:")
      for f in Fixtures.all { out("  \(f.name.padding(toLength: 12, withPad: " ", startingAt: 0)) \(f.openAgents) agents, \(f.projects) projects, \(f.itemsPerThread.lowerBound)–\(f.itemsPerThread.upperBound) items/thread, \(f.asks) ask(s): \(f.summary)") }
    }
    return 0

  case "fixture":
    guard let name = args.positional.dropFirst().first, let w = Fixtures.make(name) else { err("usage: deskbench fixture <name>  (see `list fixtures`)"); return Int32(ExitCode.usage) }
    struct F: Codable { var spec: FixtureSpec; var runs: [String]; var openRun: String?; var agents: [String: [String]]; var asking: [String: [String]]; var items: [String: Int]; var events: Int; var attachments: Int; var kinds: [String: Int] }
    var kinds: [String: Int] = [:]
    for (_, items) in w.threads { for i in items { kinds[i.kind, default: 0] += 1 } }
    let f = F(spec: w.spec, runs: w.runIds, openRun: w.openRunId, agents: w.agents, asking: w.asking, items: w.threads.mapValues(\.count), events: w.events.count, attachments: w.attachments.count, kinds: kinds)
    if json { out(JSONOut.encode(f)) } else {
      out("\(name): \(w.spec.summary)")
      for r in w.runIds { out("  \(r)\(r == w.openRunId ? " (open)" : ""): \(w.agents[r]?.count ?? 0) agents, asks: \(w.asking[r] ?? [])") }
      out("  items: \(w.threads.values.map(\.count).reduce(0, +)) across \(w.threads.count) threads; kinds: \(kinds.sorted { $0.value > $1.value }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))")
      out("  events: \(w.events.count), attachments: \(w.attachments.count)")
    }
    return 0

  case "run", "suite":
    var o = Runner.Options(scenario: args.positional.dropFirst().first ?? "")
    if let f = args.one("fixture") { o.fixture = f }
    if let r = args.one("reps").flatMap(Int.init) { o.reps = r }
    o.params = kv(args.all("set"))
    if let s = args.one("size") { let p = s.lowercased().split(separator: "x"); if p.count == 2, let w = Double(p[0]), let h = Double(p[1]) { o.width = w; o.height = h } }
    o.activate = !args.has("no-activate")
    o.quietCheck = args.one("quiet-check") != "0"
    o.artifacts = args.one("artifacts").map { URL(fileURLWithPath: $0) }
    o.baseline = args.one("baseline").map { URL(fileURLWithPath: $0) }
    o.waitFor = args.one("wait-for").map { URL(fileURLWithPath: $0) }
    o.holdSeconds = args.one("hold").flatMap(Double.init) ?? 0
    o.variant = args.one("variant")
    o.host = Harness.current != nil ? "scene" : "window"
    if cmd == "run" {
      guard !o.scenario.isEmpty else { err("usage: deskbench run <scenario> [options]"); return Int32(ExitCode.usage) }
      switch await Runner.run(o) {
      case .failure(let e): err("deskbench: \(e)"); return Int32(e.code)
      case .success(let r):
        let text = JSONOut.encode(r)
        if let p = args.one("out") { do { try text.write(toFile: p, atomically: true, encoding: .utf8) } catch { err("couldn't write \(p): \(error)") } }
        out(json ? text : Explain.text(r))
        return Int32(r.exitCode)
      }
    }
    // suite
    let outDir = args.one("out").map { URL(fileURLWithPath: $0) }
    if let d = outDir { try? FileManager.default.createDirectory(at: d, withIntermediateDirectories: true) }
    var worst = 0; var results: [BenchResult] = []
    for name in Scenarios.suite {
      var so = o; so.scenario = name
      switch await Runner.run(so) {
      case .failure(let e): err("\(name): \(e)"); worst = max(worst, e.code)
      case .success(let r):
        results.append(r); worst = max(worst, r.exitCode)
        if let d = outDir { try? JSONOut.encode(r).write(to: d.appendingPathComponent("\(name).json"), atomically: true, encoding: .utf8) }
        if !json {
          let s = r.summary
          var line = "\(r.verdict.uppercased().padding(toLength: 10, withPad: " ", startingAt: 0)) \(name.padding(toLength: 8, withPad: " ", startingAt: 0))"
          if let l = s.latencyMs { line += " latency \(l.median) ms (p95 \(l.p95))" }
          line += "  late frames \(s.lateFrames.median)/rep  frame p95 \(s.frameP95Ms.median) ms  longest stretch \(s.longestStretchMs.median) ms"
          if !r.budget.pass { line += "\n           " + r.budget.reasons.joined(separator: "\n           ") }
          out(line)
        }
      }
    }
    if json { struct S: Codable { var schema = "deskbench.suite/1"; var results: [BenchResult]; var exitCode: Int }; out(JSONOut.encode(S(results: results, exitCode: worst))) }
    else { out("suite: \(results.filter { $0.verdict == "pass" }.count)/\(results.count) passed; exit \(worst)") }
    return Int32(worst)

  case "snapshot":
    let fixture = args.one("fixture") ?? "crew17"
    guard let w = Fixtures.make(fixture) else { err("unknown fixture"); return Int32(ExitCode.usage) }
    let dir = URL(fileURLWithPath: args.one("out") ?? "deskbench-snapshot")
    let h = Harness.current ?? Harness(world: w)
    var size = CGSize(width: 1440, height: 900)
    if let s = args.one("size") { let p = s.lowercased().split(separator: "x"); if p.count == 2, let w = Double(p[0]), let hh = Double(p[1]) { size = CGSize(width: w, height: hh) } }
    h.showWindow(size: size, activate: !args.has("no-activate"))
    _ = await h.nextCommit()
    _ = await h.ensureActive(!args.has("no-activate"))
    await h.sleep(ms: 600)
    if let at = args.one("at"), let i = Int(at), h.model.columns.indices.contains(i) { h.model.scroll(to: h.model.columns[i], animated: false); _ = await h.nextCommit(); await h.sleep(ms: 150) }
    let paths = h.snapshot(into: dir, name: "window")
    if let hold = args.one("hold").flatMap(Double.init) { await h.sleep(ms: hold * 1000) }
    if json { out(JSONOut.encode(h.dump())) } else {
      let d = h.dump()
      out("written: " + paths.joined(separator: ", "))
      out("window \(d.window.map { "\($0.frame)" } ?? "?") active=\(d.window?.appActive ?? false) key=\(d.window?.keyWindow ?? false) occluded=\(d.window?.occluded ?? true)")
      out("model: \(d.model.columns.count) columns, across \(d.model.across), position \(d.model.reelPosition ?? "-"), on screen \(d.model.onScreen), warm \(d.model.warm.count), asking \(d.model.asking)")
      for s in d.scrollViews { out("scroll \(s.cls) frame \(s.frame) doc \(s.scroll!.documentSize) clip \(s.scroll!.clipBounds) insets \(s.scroll!.contentInsets) h=\(s.scroll!.horizontal) v=\(s.scroll!.vertical)") }
    }
    h.closeWindow()
    return 0

  case "profile":
    guard let sc = args.positional.dropFirst().first else { err("usage: deskbench profile <scenario> --template hitches|time|swiftui [--out DIR]"); return Int32(ExitCode.usage) }
    do {
      let (r, code) = try Commands.profile(scenario: sc, fixture: args.one("fixture") ?? "crew17", template: args.one("template") ?? "hitches",
                                           out: URL(fileURLWithPath: args.one("out") ?? "deskbench-profile"), reps: args.one("reps").flatMap(Int.init) ?? 2,
                                           params: args.all("set"), seconds: args.one("seconds").flatMap(Double.init), activate: !args.has("no-activate"), host: args.one("host"))
      out(json ? JSONOut.encode(r) : Commands.profileText(r))
      return Int32(code)
    } catch let e as CLIError { err("deskbench: \(e)"); return Int32(e.code) } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }

  case "trace":
    guard let f = args.positional.dropFirst().first else { err("usage: deskbench trace <file.trace> [--process NAME]"); return Int32(ExitCode.usage) }
    do {
      let r = try Commands.summarise(trace: URL(fileURLWithPath: f), template: "existing", scenario: "-", process: args.one("process") ?? "Capcomd")
      out(json ? JSONOut.encode(r) : Commands.profileText(r))
      return 0
    } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }

  case "ab":
    guard let a = args.one("a"), let b = args.one("b"), let sc = args.positional.dropFirst().first else { err("usage: deskbench ab --a EXE --b EXE <scenario> [--fixture F] [--reps N]"); return Int32(ExitCode.usage) }
    do {
      let (r, code) = try Commands.ab(a: a, b: b, scenario: sc, fixture: args.one("fixture") ?? "crew17", reps: args.one("reps").flatMap(Int.init) ?? 5, params: args.all("set"), activate: !args.has("no-activate"))
      if let p = args.one("out") { try? JSONOut.encode(r).write(toFile: p, atomically: true, encoding: .utf8) }
      out(json ? JSONOut.encode(r) : r.text)
      return Int32(code)
    } catch let e as CLIError { err("deskbench: \(e)"); return Int32(e.code) } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }

  case "compare":
    let files = Array(args.positional.dropFirst())
    guard files.count == 2 else { err("usage: deskbench compare <baseline.json> <candidate.json>"); return Int32(ExitCode.usage) }
    do {
      let a = try JSONOut.decode(BenchResult.self, from: Data(contentsOf: URL(fileURLWithPath: files[0])))
      let b = try JSONOut.decode(BenchResult.self, from: Data(contentsOf: URL(fileURLWithPath: files[1])))
      guard a.scenario == b.scenario, let spec = Scenarios.spec(a.scenario) else { err("the results are for different scenarios (\(a.scenario) vs \(b.scenario))"); return Int32(ExitCode.usage) }
      let regs = Runner.compare(spec, baseline: a.reps, candidate: b.reps)
      struct C: Codable { var schema = "deskbench.compare/1"; var scenario: String; var baseline: String; var candidate: String; var comparison: [Regression]; var regression: Bool }
      let c = C(scenario: a.scenario, baseline: files[0], candidate: files[1], comparison: regs, regression: regs.contains { $0.regression })
      if json { out(JSONOut.encode(c)) } else {
        out("compare \(a.scenario): \(files[0]) → \(files[1])")
        for r in regs { out("  \(r.regression ? "✗ REGRESSION" : r.improvement ? "✓ better" : "· same") \(r.reason)") }
        if !a.noise.quiet || !b.noise.quiet { out("  (one of the runs was on a noisy machine)") }
      }
      return Int32(c.regression ? ExitCode.regression : ExitCode.ok)
    } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }

  case "explain":
    guard let f = args.positional.dropFirst().first else { err("usage: deskbench explain <result.json>"); return Int32(ExitCode.usage) }
    do { out(Explain.text(try JSONOut.decode(BenchResult.self, from: Data(contentsOf: URL(fileURLWithPath: f))))); return 0 }
    catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }

  default:
    err("deskbench: unknown command '\(cmd)'\n"); out(help); return Int32(ExitCode.usage)
  }
}

// The window needs a running NSApplication; the command runs as a task on the main actor inside its run loop. Scenario
// commands run as a SwiftUI app whose Window scene shows the fixture (the app's own window machinery) unless
// `--host window` asks for a hand-made NSWindow; `open` always uses one (it needs a fresh window per rep).
let startup = Args(Array(CommandLine.arguments.dropFirst()))
let sceneCommands = ["run", "suite", "snapshot"]
let wantsScene = sceneCommands.contains(startup.positional.first ?? "") && (startup.one("host") ?? "scene") == "scene"
  && !(startup.positional.first == "run" && startup.positional.dropFirst().first == "open")
MainActor.assumeIsolated {
  if wantsScene, let w = Fixtures.make(startup.one("fixture") ?? "crew17") {
    let h = Harness(world: w); h.sceneHosted = true; Harness.current = h
    if let s = startup.one("size") { let p = s.lowercased().split(separator: "x"); if p.count == 2, let w = Double(p[0]), let hh = Double(p[1]) { BenchScene.size = CGSize(width: w, height: hh) } }
  }
}
Task { @MainActor in
  let code = await main()
  exit(code)
}
if MainActor.assumeIsolated({ Harness.current != nil }) {
  BenchScene.main()
} else {
  let app = NSApplication.shared
  // A regular app (Dock icon, can become active): SwiftUI flushes state changes promptly only in an active app.
  app.setActivationPolicy(CommandLine.arguments.contains("--no-activate") ? .accessory : .regular)
  app.run()
}
