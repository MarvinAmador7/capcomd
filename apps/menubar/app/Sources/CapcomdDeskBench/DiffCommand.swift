import Foundation
import DeskBenchKit

/// `diff A B` / `trace --diff A B`: the differential call tree of two time profiles (.trace files or profile JSON),
/// ms per step. Traces are exported in parallel (both sides, time profile + signposts + TOC at once): xctrace's export is
/// most of the wall time.
enum DiffCommand {
  static let usage = "usage: deskbench diff <a.trace|a.json> <b.trace|b.json> [--top N] [--per step|run] [--min-ms X] [--process NAME] [--champion BUILD] [--allow-stale] [--allow-cross-os] [--json]"
  /// Exit code when provenance refuses the comparison (SCHEMAS.md: 6 refused).
  static let refused = 6

  static func run(_ files: [String], args: Args) -> Int32 {
    guard files.count == 2 else { err(usage); return Int32(ExitCode.usage) }
    let began = Date()
    let per = args.one("per") ?? "step"
    guard per == "step" || per == "run" else { err("--per must be step or run"); return Int32(ExitCode.usage) }
    let process = args.one("process") ?? "CapcomdDeskBench"
    var loaded: [Result<DiffInput, Error>] = Array(repeating: .failure(CLIError.harness("not loaded")), count: 2)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: 2) { i in
      let r = Result { try load(files[i], process: process, per: per) }
      lock.lock(); loaded[i] = r; lock.unlock()
    }
    let a: DiffInput, b: DiffInput
    do { a = try loaded[0].get(); b = try loaded[1].get() } catch { err("deskbench: \(error)"); return Int32(ExitCode.harness) }
    let prov = Diff.provenance(a: a.side, b: b.side, champion: args.one("champion"), allowStale: args.has("allow-stale"), allowCrossOS: args.has("allow-cross-os"))
    let top = args.one("top").flatMap(Int.init) ?? 8
    var r = Diff.make(a: a, b: b, normalisation: per == "run" ? "msPerRun" : "msPerStep", top: top, minMs: args.one("min-ms").flatMap(Double.init), provenance: prov)
    r.elapsedS = Stats.round(Date().timeIntervalSince(began), 1)
    if prov.refused {
      err("deskbench: diff refused: \(prov.reasons.joined(separator: "; ")). Pass --allow-stale / --allow-cross-os to compare anyway.")
      if args.has("json") { out(JSONOut.encode(r)) }
      return Int32(refused)
    }
    out(args.has("json") ? JSONOut.encode(r) : Explain.text(r, top: top))
    return 0
  }

  /// One side: a `.trace` (exported here) or a profile JSON (its trees; its trace when it has none).
  static func load(_ path: String, process: String, per: String) throws -> DiffInput {
    let url = URL(fileURLWithPath: path)
    if url.pathExtension == "trace" { return try fromTrace(url, process: process, per: per) }
    let data = try Data(contentsOf: url)
    let p = try JSONOut.decode(ProfileResult.self, from: data)
    let raw = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    let build = buildInfo(raw), os = osInfo(raw)
    if per == "step", let steps = p.steps, !steps.isEmpty, let t = p.treeInSteps ?? p.treePerStep.map({ CallTree.merge($0.map(\.tree), name: "main thread") }) {
      let side = DiffSide(profile: path, trace: p.trace, build: build, os: os, steps: steps.count, stepSource: steps[0].source, samples: p.tree?.v ?? t.v, sampleIntervalMs: p.sampleIntervalMs ?? 1)
      return DiffInput(side: side, tree: t, notes: ["trees from the profile JSON (pruned when written)"])
    }
    let inProcessSteps = p.stepsExpected ?? p.inProcess.map { $0.reps.reduce(0) { $0 + $1.steps.count } }
    if FileManager.default.fileExists(atPath: p.trace) {
      // An older profile (deskbench.profile/1, no tree), or one without steps: the trace has more to say.
      var input = try fromTrace(URL(fileURLWithPath: p.trace), process: process, per: per, inProcessSteps: inProcessSteps)
      input.side.profile = path
      input.side.build = input.side.build ?? build
      input.side.os = input.side.os ?? os
      if p.tree == nil { input.notes.insert("tree built from the profile's trace (the JSON predates call trees)", at: 0) }
      return input
    }
    guard let t = p.tree else { throw CLIError.harness("\(path) has no call tree (written before perfloop.profile/2) and its trace \(p.trace) is gone") }
    let n = per == "run" ? 1 : max(1, inProcessSteps ?? 1)
    let side = DiffSide(profile: path, trace: p.trace, build: build, os: os, steps: n, stepSource: per == "run" ? "run" : "inProcess", samples: t.v, sampleIntervalMs: p.sampleIntervalMs ?? 1)
    return DiffInput(side: side, tree: t, notes: per == "run" ? [] : ["no step signposts: the whole recording ÷ \(n) in-process steps (settling and idle time included)"])
  }

  static func fromTrace(_ url: URL, process: String, per: String, inProcessSteps: Int? = nil) throws -> DiffInput {
    guard FileManager.default.fileExists(atPath: url.path) else { throw CLIError.usage("no such trace: \(url.path)") }
    let xpaths = ["/trace-toc/run[@number=\"1\"]/data/table[@schema=\"time-profile\"]", "/trace-toc/run[@number=\"1\"]/data/table[@schema=\"os-signpost\"]", nil]
    var outs = [Data](repeating: Data(), count: 3)
    let lock = NSLock()
    DispatchQueue.concurrentPerform(iterations: 3) { i in
      let d = (try? export(url, xpath: xpaths[i])) ?? Data()
      lock.lock(); outs[i] = d; lock.unlock()
    }
    guard let tp = try? XCTable(xml: outs[0]), tp.schema == "time-profile" else { throw CLIError.harness("no time-profile table in \(url.path) (record it with --template time)") }
    let sp = try? XCTable(xml: outs[1])
    // From the TOC only the OS build and the recorded process's name are read (it also lists the environment).
    let toc = String(decoding: outs[2], as: UTF8.self)
    let os = firstMatch(#"<device [^>]*os-version="([^"]*)""#, in: toc)
    let proc = firstMatch(#"<process type="attached"[^>]* name="([^"]*)""#, in: toc) ?? process
    let s = MainThreadSamples(timeProfile: tp, process: proc)
    var steps = sp.map { StepInterval.fromSignposts($0) } ?? []
    var notes: [String] = []
    if per == "run" { steps = [] }
    let trees = StepTrees(samples: s, steps: steps)
    if per == "run" {
      return DiffInput(side: DiffSide(trace: url.path, os: os, steps: 1, stepSource: "run", samples: s.count, sampleIntervalMs: s.sampleIntervalMs), tree: trees.whole)
    }
    if steps.isEmpty {
      let n = max(1, inProcessSteps ?? 1)
      notes.append("no `step` signposts in the trace: the whole recording ÷ \(n) step\(n == 1 ? "" : "s") (settling and idle time included)")
      return DiffInput(side: DiffSide(trace: url.path, os: os, steps: n, stepSource: inProcessSteps == nil ? "none" : "inProcess", samples: s.count, sampleIntervalMs: s.sampleIntervalMs), tree: trees.whole, notes: notes)
    }
    let outside = Double(trees.outside.v) * s.sampleIntervalMs
    notes.append("\(trees.inSteps.v) of \(s.count) main-thread samples inside \(steps.count) steps; \(Int(outside)) ms outside steps not compared")
    return DiffInput(side: DiffSide(trace: url.path, os: os, steps: steps.count, stepSource: "signpost", samples: s.count, sampleIntervalMs: s.sampleIntervalMs), tree: trees.inSteps, notes: notes)
  }

  /// `xctrace export` to memory; `xpath` nil exports the TOC.
  static func export(_ trace: URL, xpath: String?) throws -> Data {
    let p = Process(); p.executableURL = URL(fileURLWithPath: "/usr/bin/xcrun")
    p.arguments = ["xctrace", "export", "--input", trace.path] + (xpath.map { ["--xpath", $0] } ?? ["--toc"])
    let o = Pipe(); p.standardOutput = o; p.standardError = FileHandle.nullDevice
    try p.run()
    let d = o.fileHandleForReading.readDataToEndOfFile(); p.waitUntilExit()
    return d
  }

  static func firstMatch(_ pattern: String, in s: String) -> String? {
    guard let re = try? NSRegularExpression(pattern: pattern), let m = re.firstMatch(in: s, range: NSRange(s.startIndex..., in: s)), m.numberOfRanges > 1,
          let r = Range(m.range(at: 1), in: s) else { return nil }
    return String(s[r])
  }

  /// The build of a profile JSON: `build` (perfloop.profile/2), else the in-process result's `tool.build`, else its
  /// `tool.commit` (read from the cwd before the stamp: marked `stamp: false`).
  static func buildInfo(_ raw: [String: Any]?) -> DiffBuild? {
    func from(_ d: [String: Any]) -> DiffBuild { DiffBuild(hash: d["hash"] as? String, commit: d["commit"] as? String, dirty: d["dirty"] as? Bool, stamp: d["stamp"] as? Bool) }
    if let b = raw?["build"] as? [String: Any] { return from(b) }
    let tool = (raw?["inProcess"] as? [String: Any])?["tool"] as? [String: Any]
    if let b = tool?["build"] as? [String: Any] { return from(b) }
    if let c = tool?["commit"] as? String { return DiffBuild(commit: c, stamp: false) }
    return nil
  }

  static func osInfo(_ raw: [String: Any]?) -> String? {
    ((raw?["machine"] as? [String: Any])?["os"] as? String) ?? (((raw?["inProcess"] as? [String: Any])?["machine"] as? [String: Any])?["os"] as? String)
  }
}
