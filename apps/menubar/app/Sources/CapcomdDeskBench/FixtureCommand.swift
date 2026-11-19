import Foundation
import DeskBenchKit
import PerfLoopKit

/// `deskbench fixture NAME` (what a fixture builds) and `deskbench fixture capture` (Capture.swift): headless.
@MainActor enum FixtureCommand {
  static func run(_ args: Args) async -> Int32 {
    if args.positional.dropFirst().first == "capture" { return await Capture.run(args) }
    guard let name = args.positional.dropFirst().first, let w = Fixtures.make(name) else {
      err("usage: deskbench fixture NAME [--json]  (fixtures: \(Fixtures.all.map(\.name).joined(separator: ", ")))"
          + (args.positional.dropFirst().first.flatMap(Fixtures.problem).map { "\n" + $0 } ?? ""))
      return Int32(ExitCode.usage)
    }
    struct F: Codable { var spec: FixtureSpec; var runs: [String]; var openRun: String?; var agents: [String: [String]]; var asking: [String: [String]]; var items: [String: Int]; var events: Int; var attachments: Int; var kinds: [String: Int] }
    var kinds: [String: Int] = [:]
    for (_, items) in w.threads { for i in items { kinds[i.kind, default: 0] += 1 } }
    let f = F(spec: w.spec, runs: w.runIds, openRun: w.openRunId, agents: w.agents, asking: w.asking, items: w.threads.mapValues(\.count), events: w.events.count, attachments: w.attachments.count, kinds: kinds)
    if args.has("json") { out(PLJSON.encode(f)); return 0 }
    out("\(name): \(w.spec.summary)")
    for r in w.runIds { out("  \(r)\(r == w.openRunId ? " (open)" : ""): \(w.agents[r]?.count ?? 0) agents, asks: \(w.asking[r] ?? [])") }
    out("  items: \(w.threads.values.map(\.count).reduce(0, +)) across \(w.threads.count) threads; kinds: \(kinds.sorted { $0.value > $1.value }.map { "\($0.key) \($0.value)" }.joined(separator: ", "))")
    out("  events: \(w.events.count), attachments: \(w.attachments.count)")
    return 0
  }
}

/// The command line of deskbench's own verbs: positional words and `--flag value` (or `--flag` alone).
struct Args {
  var positional: [String] = []
  var flags: [String: [String]] = [:]
  static let valued: Set<String> = ["from", "run", "out", "name", "token-file", "write", "fixture", "set", "reps"]
  init(_ argv: [String]) {
    var i = 0
    while i < argv.count {
      let a = argv[i]
      if a.hasPrefix("--") {
        let k = String(a.dropFirst(2))
        if Self.valued.contains(k), i + 1 < argv.count { flags[k, default: []].append(argv[i + 1]); i += 2 } else { flags[k, default: []].append("1"); i += 1 }
      } else { positional.append(a); i += 1 }
    }
  }
  func has(_ k: String) -> Bool { flags[k] != nil }
  func one(_ k: String) -> String? { flags[k]?.last }
  func all(_ k: String) -> [String] { flags[k] ?? [] }
}

func out(_ s: String) { print(s); fflush(stdout) }
func err(_ s: String) { FileHandle.standardError.write(Data((s + "\n").utf8)) }

/// What deskbench's own verbs exit with (the same codes PerfLoopHost's take: ADAPTER.md §7).
enum ExitCode {
  static let ok = 0, usage = 1, harness = 2, refused = 6
}

/// Pretty, sorted JSON (as PerfLoop prints its documents).
func jsonText<T: Encodable>(_ v: T) -> String { PLJSON.encode(v) }
