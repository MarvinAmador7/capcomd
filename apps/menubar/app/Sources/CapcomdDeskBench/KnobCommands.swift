import Foundation
import CapcomdDesk
import DeskBenchKit
import PerfLoopProbe

/// Runtime knobs on the command line (CAPABILITIES.md C4) and `describe`. A knob reaches the window through
/// PERFLOOP_KNOBS only: `--knob name=value` (or `--set knob:name=value`) is merged into this process's environment
/// before anything reads a knob, and into each child's for `ab`, `profile` and `suite`.
enum KnobArgs {
  /// `--knob a=1,b=2` (repeatable) and `--set knob:a=1`; a later one wins.
  static func from(_ a: Args) -> [String: String] {
    var d: [String: String] = [:]
    for s in a.all("set") where isKnob(s) { d.merge(Knobs.parse(String(s.dropFirst(5)))) { $1 } }
    for k in a.all("knob") { d.merge(Knobs.parse(k)) { $1 } }
    return d
  }

  static func isKnob(_ set: String) -> Bool { set.hasPrefix("knob:") }

  /// The environment's PERFLOOP_KNOBS with the command line's on top, put back in the environment. Runs first, before
  /// any knob is made (they read the variable once).
  static func export(_ a: Args) {
    let cli = from(a)
    guard !cli.isEmpty else { return }
    var all = Knobs.parse(ProcessInfo.processInfo.environment[Knobs.variable] ?? "")
    all.merge(cli) { $1 }
    setenv(Knobs.variable, Knobs.format(all), 1)
  }

  /// The settings for one side of `ab`: this process's (environment and command line) with the side's on top.
  static func side(_ text: String?) -> [String: String] {
    var all = Knobs.settings
    all.merge(Knobs.parse(text ?? "")) { $1 }
    return all
  }

  /// `deskbench knobs [--json]`: the knob vector this process would run with, and what is wrong with the settings.
  static func show(json: Bool) -> Int32 {
    struct K: Codable { var schema = "deskbench.knobs/1"; var settings: String; var knobs: [String: String]; var problems: [String] }
    let k = K(settings: ProcessInfo.processInfo.environment[Knobs.variable] ?? "", knobs: DeskKnobs.vector, problems: DeskKnobs.problems)
    if json { out(JSONOut.encode(k)) } else {
      for i in DeskKnobs.all { out("\(i.name) = \(k.knobs[i.name] ?? "?")\(k.knobs[i.name] == i.default ? " (default)" : "")") }
      for p in k.problems { out("problem: " + p) }
    }
    return Int32(k.problems.isEmpty ? ExitCode.ok : ExitCode.usage)
  }

  /// `deskbench describe [--json]`: the perfloop.manifest/1 for this binary.
  @MainActor static func describe(json: Bool) -> Int32 {
    let m = Manifest(build: Runner.build, knobs: DeskKnobs.all)
    out(json ? JSONOut.encode(m) : m.text)
    return 0
  }
}
