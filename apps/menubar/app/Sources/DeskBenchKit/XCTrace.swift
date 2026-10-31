import Foundation

// Reading what `xctrace export --xpath` prints, so no one hand-parses it again. The export is a table: a <schema> with
// <col><mnemonic> names, then <row>s whose cells either carry an id (first occurrence) or a ref to an earlier cell.
// Backtraces are the same: a <backtrace> or <tagged-backtrace> whose <frame>s have a `name` attribute, by id or ref.

/// A light DOM for the export, built by `XMLLite`.
public final class XNode {
  public let name: String
  public var attrs: [String: String]
  public var text = ""
  public var children: [XNode] = []
  init(_ n: String, _ a: [String: String]) { name = n; attrs = a }
  public func first(_ n: String) -> XNode? { children.first { $0.name == n } }
  public func all(_ n: String) -> [XNode] { children.filter { $0.name == n } }
}

/// One exported table, with ids resolved.
public struct XCTable {
  public var schema: String
  public var columns: [String]
  /// Each row: column mnemonic → the resolved cell.
  public var rows: [[String: XNode]]
  /// Every cell with an id, for resolving refs inside backtraces.
  public var ids: [String: XNode]

  /// Every `<node>` of the export: one table can come in several (a schema-only node, then the rows; or one per
  /// matching table, as `table[@schema="os-signpost"]` matches four). Ids are global to the document, so refs cross
  /// nodes. A `<sentinel/>` is an empty cell: it keeps its column's place and is absent from the row.
  public init(xml: Data) throws {
    let root = try XMLLite.parse(xml)
    let nodes = root.first("trace-query-result")?.all("node") ?? []
    guard !nodes.isEmpty else { throw XCTraceError.badXML("no <node>") }
    var schema: String?, columns: [String] = []
    var ids: [String: XNode] = [:]
    func register(_ n: XNode) { if let id = n.attrs["id"] { ids[id] = n }; n.children.forEach(register) }
    var rows: [[String: XNode]] = []
    for node in nodes {
      if let s = node.first("schema") {
        if schema == nil { schema = s.attrs["name"] }
        columns = s.all("col").compactMap { $0.first("mnemonic")?.text }
      }
      for r in node.all("row") {
        register(r)
        var out: [String: XNode] = [:]
        for (c, cell) in zip(columns, r.children) where cell.name != "sentinel" { out[c] = cell.attrs["ref"].flatMap { ids[$0] } ?? cell }
        rows.append(out)
      }
    }
    self.schema = schema ?? "?"; self.columns = columns
    self.rows = rows; self.ids = ids
  }

  /// Resolves refs inside a cell's subtree (a backtrace's frames).
  public static func frames(_ bt: XNode, ids: [String: XNode]) -> [String] { bt.all("frame").map { ($0.attrs["ref"].flatMap { ids[$0] } ?? $0).attrs["name"] ?? "?" } }
}

public enum XCTraceError: Error, CustomStringConvertible {
  case badXML(String), noTable(String)
  public var description: String { switch self { case .badXML(let s): "xctrace export: \(s)"; case .noTable(let s): "no \(s) table in the trace" } }
}

/// Animation Hitches: the compositor's hitch list (frames shown late), and Instruments' potential hangs.
public struct HitchSummary: Codable, Sendable, Equatable {
  public var process: String
  public var hitches: Int
  public var totalMs: Double
  public var maxMs: Double
  public var over16Ms: Int
  /// Instruments' "Potential Issue" per hitch, counted.
  public var causes: [String: Int]
  public var durationsMs: [Double]
  public var potentialHangsMs: [Double]

  public init(hitches: XCTable, hangs: XCTable?, process: String) {
    self.process = process
    let ours = hitches.rows.filter { ($0["process"]?.attrs["fmt"] ?? "").contains(process) }
    let ms = ours.compactMap { $0["duration"]?.text }.compactMap(Double.init).map { $0 / 1e6 }
    self.hitches = ours.count; totalMs = Stats.round(ms.reduce(0, +), 1); maxMs = Stats.round(ms.max() ?? 0, 2)
    over16Ms = ms.filter { $0 >= 16 }.count
    var c: [String: Int] = [:]
    for r in ours { c[r["narrative-description"]?.attrs["fmt"] ?? r["narrative-description"]?.text ?? "unspecified", default: 0] += 1 }
    causes = c; durationsMs = ms.map { Stats.round($0, 2) }
    potentialHangsMs = (hangs?.rows ?? []).filter { ($0["process"]?.attrs["fmt"] ?? "").contains(process) || hangs?.columns.contains("process") == false }
      .compactMap { $0["duration"]?.text }.compactMap(Double.init).map { Stats.round($0 / 1e6, 1) }.sorted()
  }
}

/// Time Profiler, main thread only: where the samples were, inclusive and self, the bursts (main-thread stretches of
/// ≥ 16 contiguous ms) and what ran inside them, filtered to our symbols and SwiftUI's hot spots.
public struct ProfileSummary: Codable, Sendable, Equatable {
  public struct Frame: Codable, Sendable, Equatable { public var symbol: String; public var samples: Int }
  public var mainThreadSamples: Int
  public var sampleIntervalMs: Double
  /// Our code and the SwiftUI/AppKit hot spots, inclusive (a sample counts once per distinct frame in its stack).
  public var inclusiveOurs: [Frame]
  public var inclusiveTop: [Frame]
  public var selfTop: [Frame]
  public var bursts: Int
  public var burstSamples: Int
  public var burstSizes: [Int]
  /// Inside the bursts, inclusive: what the long stretches were doing.
  public var burstFrames: [Frame]

  static let ours = ["Capcomd", "Desk", "Column", "Reel", "Title", "Crew", "Thread", "Bot", "Entry", "Store", "Markdown", "Block", "Composer", "Head", "OpenGroup"]
  static let hot = ["propagate_dirty", "UpdateStack", "ViewGraph", "_opaqueFullSizeContentViewRegion", "_regionForOpaqueDescendants", "TrackingArea", "layout", "Lazy", "ScrollView",
                    "sizeThatFits", "CoreText", "CTFrame", "NSTextField", "decode", "JSON"]

  public init(timeProfile t: XCTable, ids: [String: XNode]) {
    var samples: [(t: Int, frames: [String])] = []
    for r in t.rows {
      guard (r["thread"]?.attrs["fmt"] ?? "").contains("Main Thread") else { continue }
      // Columns are keyed by mnemonic ("stack", "time"); the cells are <tagged-backtrace>/<backtrace> and <sample-time>.
      let bt = r["stack"] ?? r["tagged-backtrace"] ?? r["backtrace"] ?? r.values.first { $0.name == "tagged-backtrace" || $0.name == "backtrace" }
      let names = bt.map { XCTable.frames($0, ids: ids) } ?? []
      let time = Int((r["time"] ?? r["sample-time"] ?? r.values.first { $0.name == "sample-time" })?.text ?? "0") ?? 0
      samples.append((time, names.map(Self.clean)))
    }
    samples.sort { $0.t < $1.t }
    mainThreadSamples = samples.count
    let gaps = zip(samples.dropFirst(), samples).map { Double($0.t - $1.t) / 1e6 }.filter { $0 > 0 }
    sampleIntervalMs = Stats.round(Stats.median(gaps), 3)
    var incl: [String: Int] = [:], selfc: [String: Int] = [:]
    for s in samples {
      for f in Set(s.frames) { incl[f, default: 0] += 1 }
      if let top = s.frames.first { selfc[top, default: 0] += 1 }
    }
    func top(_ d: [String: Int], _ n: Int, where keep: (String) -> Bool = { _ in true }) -> [Frame] {
      d.filter { keep($0.key) }.sorted { ($0.value, $0.key) > ($1.value, $1.key) }.prefix(n).map { Frame(symbol: $0.key, samples: $0.value) }
    }
    inclusiveOurs = top(incl, 60) { k in Self.ours.contains { k.contains($0) } || Self.hot.contains { k.contains($0) } }
    inclusiveTop = top(incl, 40); selfTop = top(selfc, 25)
    // Bursts: consecutive samples ≤ 1.5 ms apart (the profiler samples every 1 ms while the thread runs); ≥ 16 of them
    // is a stretch longer than a 60 Hz frame.
    var runs: [[(t: Int, frames: [String])]] = [], cur: [(t: Int, frames: [String])] = []
    for s in samples {
      if let last = cur.last, s.t - last.t > 1_500_000 { runs.append(cur); cur = [] }
      cur.append(s)
    }
    if !cur.isEmpty { runs.append(cur) }
    let long = runs.filter { $0.count >= 16 }
    bursts = long.count; burstSizes = long.map(\.count).sorted().suffix(15).map { $0 }
    var bi: [String: Int] = [:]; var n = 0
    for r in long { for s in r { n += 1; for f in Set(s.frames) { bi[f, default: 0] += 1 } } }
    burstSamples = n
    let floor = max(10, n / 60)
    burstFrames = top(bi.filter { $0.value >= floor }, 60) { k in Self.ours.contains { k.contains($0) } || Self.hot.contains { k.contains($0) } }
  }

  /// A symbol without its argument list, cut to 110 characters (`Symbol.clean`).
  static func clean(_ s: String) -> String { Symbol.clean(s) }
}

/// SwiftUI template: view body evaluations by view type, from the SwiftUI instruments' tables when present.
public struct SwiftUISummary: Codable, Sendable, Equatable {
  public var table: String
  public var rows: Int
  public var byView: [String: Int]
  public init(table t: XCTable) {
    table = t.schema; rows = t.rows.count
    var c: [String: Int] = [:]
    for r in t.rows {
      let name = r["view-name"]?.attrs["fmt"] ?? r["name"]?.attrs["fmt"] ?? r["view-type"]?.attrs["fmt"] ?? r.values.first { $0.name == "string" }?.attrs["fmt"] ?? "?"
      c[String(name.prefix(80)), default: 0] += 1
    }
    byView = c
  }
}

/// What `profile` prints.
public struct ProfileResult: Codable, Sendable, Equatable {
  /// `perfloop.profile/2`; documents written as `deskbench.profile/1` still decode (every added field is optional).
  public var schema = "perfloop.profile/2"
  public var template: String
  public var trace: String
  public var scenario: String
  public var fixture: String
  public var process: String
  public var durationS: Double
  public var hitches: HitchSummary?
  public var timeProfile: ProfileSummary?
  public var swiftUI: [SwiftUISummary]?
  public var signposts: [String: Int]?
  /// The in-process result of the same run (frames, stretches, bodies), when the child wrote one.
  public var inProcess: BenchResult?
  public var notes: [String]
  // perfloop.profile/2 (CallTree.swift, `addCallTrees`): the main thread's call tree, per `step` signpost interval.
  /// The steps the signposts marked.
  public var steps: [StepInterval]?
  /// Main thread, whole recording, v = samples.
  public var tree: CallTree?
  /// Main thread, samples inside steps only (what `diff` compares).
  public var treeInSteps: CallTree?
  public var treePerStep: [StepTree]?
  /// Main-thread ms per step: samples inside steps × sampleIntervalMs ÷ steps.
  public var msPerStep: Double?
  public var sampleIntervalMs: Double?
  public var stepsCovered: Int?
  /// Steps the in-process result ran, when the profile carries it.
  public var stepsExpected: Int?
  public init(template: String, trace: String, scenario: String, fixture: String, process: String, durationS: Double) {
    self.template = template; self.trace = trace; self.scenario = scenario; self.fixture = fixture; self.process = process; self.durationS = durationS; notes = []
  }
}
