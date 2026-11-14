import Foundation

// Correctness guards (design/perf-loop CAPABILITIES.md C6): pass/fail checks that make "fast because wrong" lose. A
// blank column is fast; the objective alone would climb on it. Two guards here, both judged after the scenario has
// settled, and never optimised:
//
// - `built-within`: every on-screen column has had its `Column`, `ColumnHead`, `ColumnThread` bodies and (when the
//   fixture gives it a thread) at least one `EntryRow` body since its project opened, the last of them at most N ms
//   after the scenario's settle point (N = `built-within.ms`, default 300), and each on-screen hosting view has
//   something in it (not the reel's blank placeholder, not an empty hosting view).
// - `snapshot-diff`: the window's PNG after settle against the champion's for the same scenario step, pixel by pixel,
//   outside a mask of what moves on its own (the system-drawn clocks); over `snapshot-diff.tolerance` (default 0.5 %
//   of the pixels) or a column out of its box, the experiment goes to the owner (`needsReview`), never a win.
//
// The runner (perfloop) reads which guards gate a scenario from the champion's manifest, never the candidate's, and
// passes them to both sides (`PERFLOOP_GUARDS`); the snapshot comparison runs in the champion's binary (`snapdiff`).

/// One guard's outcome on one rep (`reps[].guards[]`, SCHEMAS.md §3), beside `checks[]` which stays as it is.
public struct GuardResult: Codable, Sendable, Equatable {
  public var name: String
  public var pass: Bool
  public var detail: String
  /// Files the guard wrote (PNGs, the layout), absolute paths.
  public var artifacts: [String]
  /// The measured number: built-within → how long after settle the last on-screen column was built (ms, ≤ 0 when it
  /// was built before); snapshot-diff → the share of compared pixels that differ (0.005 = 0.5 %).
  public var value: Double?
  /// The limit `value` is judged against.
  public var limit: Double?
  /// A failure that asks the owner (snapshot-diff over tolerance → needsReview) instead of vetoing outright.
  public var review: Bool?
  public init(name: String, pass: Bool, detail: String, artifacts: [String] = [], value: Double? = nil, limit: Double? = nil, review: Bool? = nil) {
    self.name = name; self.pass = pass; self.detail = detail; self.artifacts = artifacts; self.value = value; self.limit = limit; self.review = review
  }
}

/// Which guards gate each scenario, with their parameters: what `describe` lists and the runner passes back.
public enum Guards {
  public static let builtWithin = "built-within"
  public static let snapshotDiff = "snapshot-diff"
  /// The scenario's own checks (`landed`, `isolation`, …): one the candidate fails while the champion passes vetoes it.
  public static let checks = "checks"
  /// Guards the bench itself runs after a rep (the rest are the checks, or pairwise in the runner).
  public static let adapterRun: Set<String> = [builtWithin, snapshotDiff]

  /// Defaults, overridden per scenario by `params(for:)` and by the runner (`PERFLOOP_GUARD_PARAMS`).
  public static let defaults: [String: Double] = [
    "built-within.ms": 300,
    "snapshot-diff.tolerance": 0.005,
    /// A single column may differ by at most this share of its own pixels (a blank thread in one of three columns is
    /// under the window's tolerance on a wide window only by luck).
    "snapshot-diff.columnTolerance": 0.02,
    /// Each column's ink box (the extent of what is drawn in it) may move by at most this many points on any side.
    "snapshot-diff.bboxPt": 4,
    /// How far, in points, a pixel that changed on its own between two snapshots 1.1 s apart masks around it: the
    /// clocks are right-aligned, and a changing seconds digit masks the minutes and hours to its left.
    "snapshot-diff.maskPt": 56,
    /// A channel difference at or under this (of 255) is the same pixel.
    "snapshot-diff.threshold": 16,
    /// A thread viewport must be drawn at least this share as much as the champion's (ink coverage, the share of its
    /// pixels unlike its background): a blank thread draws ~0. Loose on purpose: after a project switch the same build
    /// rests its threads at different scroll offsets, and once in a while with most of one viewport still empty (seen:
    /// 3.7 % vs 11.6 % drawn, a ratio of 0.31).
    "snapshot-diff.threadInkMin": 0.2,
  ]

  /// The scenarios whose end state is deterministic enough to compare pixels: the reel at rest after scrolls,
  /// switches, a resize, Follow, a fresh window. Not `burst` (the arriving items' layout settles on its own clock) and
  /// not `typing` (the caret, the field editor).
  static let snapshotScenarios: Set<String> = ["open", "switch", "step", "jump", "fling", "swipe", "follow", "resize", "sidebar-toggle", "sidebar-select"]

  /// The correctness guards of a scenario, as the manifest lists them.
  public static func forScenario(_ name: String) -> [String] {
    [checks, builtWithin] + (snapshotScenarios.contains(name) ? [snapshotDiff] : [])
  }

  /// The guard parameters a scenario uses (the defaults of its guards; per-scenario values go here when a scenario
  /// needs its own).
  public static func params(for name: String) -> [String: Double] {
    let gs = Set(forScenario(name))
    return defaults.filter { k, _ in gs.contains(where: { k.hasPrefix($0 + ".") }) }
  }

  /// Scenarios whose checks run on every promotion, whatever scenario the experiment climbs (C6: isolation).
  public static let isolation = ["burst", "typing"]
}

/// What a run was asked to guard: names and parameters, from the environment the runner sets (`PERFLOOP_GUARDS=a,b`,
/// `PERFLOOP_GUARD_PARAMS=k=v,k=v`, `PERFLOOP_ARTIFACTS=DIR`) and the command line (`--guards`, `--guard-param`,
/// `--artifacts`); the command line wins.
public struct GuardConfig: Sendable, Equatable {
  public var names: Set<String>
  public var params: [String: Double]
  public var dir: URL?
  public static let namesVariable = "PERFLOOP_GUARDS", paramsVariable = "PERFLOOP_GUARD_PARAMS", dirVariable = "PERFLOOP_ARTIFACTS"

  public init(names: Set<String> = [], params: [String: Double] = [:], dir: URL? = nil) { self.names = names; self.params = params; self.dir = dir }

  public init(env: [String: String], names cli: [String] = [], params cliParams: [String] = [], dir cliDir: String? = nil) {
    func list(_ s: String?) -> [String] { (s ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty } }
    names = Set(list(env[Self.namesVariable]) + cli.flatMap { list($0) })
    var p: [String: Double] = [:]
    for kv in list(env[Self.paramsVariable]) + cliParams.flatMap({ list($0) }) {
      let x = kv.split(separator: "=", maxSplits: 1).map(String.init)
      if x.count == 2, let v = Double(x[1]) { p[x[0]] = v }
    }
    params = p
    dir = (cliDir ?? env[Self.dirVariable]).map { URL(fileURLWithPath: $0) }
  }

  /// Whether the bench has anything to do after a rep.
  public var active: Bool { !names.isDisjoint(with: Guards.adapterRun) }
  public func wants(_ name: String) -> Bool { names.contains(name) }
  public func value(_ k: String) -> Double { params[k] ?? Guards.defaults[k] ?? 0 }
}

/// The `built-within` guard over the bodies the probe recorded: a pure function, so the rule is tested without a window.
public enum BuiltWithin {
  /// The bodies a built column has had.
  public static let required = ["Column", "ColumnHead", "ColumnThread", "EntryRow"]

  /// One on-screen column as the reel and the model show it.
  public struct Column: Sendable, Equatable {
    public var id: String
    /// The fixture gives this agent a thread: at least one `EntryRow` body is due.
    public var expectsRows: Bool
    /// The model's warm flag: a cold column draws no thread at all. nil when unknown.
    public var warm: Bool?
    /// What its view in the reel is: "hosting" (a hosting view with something in it, or an AppKit column holding one),
    /// "empty" (a hosting view with no subviews and no sublayers), "placeholder" (the reel's blank before it builds the
    /// column), "hidden" (a column view hidden while in view), "missing".
    public var view: String?
    public init(id: String, expectsRows: Bool, warm: Bool? = nil, view: String? = nil) { self.id = id; self.expectsRows = expectsRows; self.warm = warm; self.view = view }
  }

  public struct Body: Sendable, Equatable {
    public var t: Double; public var view: String; public var id: String?
    public init(t: Double, view: String, id: String?) { self.t = t; self.view = view; self.id = id }
  }

  /// Bodies since `since` (when the columns' project opened or their window was made) for `columns`; `settleAt` is
  /// the scenario's settle point. Built = every required body has happened at least once; when = the latest of the
  /// first ones. Passes when every column is built, warm, a hosting view with content, and built ≤ `limitMs` after
  /// settle.
  public static func evaluate(columns: [Column], bodies: [Body], since: Double, settleAt: Double, limitMs: Double) -> GuardResult {
    var problems: [String] = [], latest: Double?
    if columns.isEmpty { problems.append("no column on screen after settle") }
    for c in columns {
      var firsts: [String: Double] = [:]
      for b in bodies where b.t >= since && b.id == c.id && firsts[b.view] == nil { firsts[b.view] = b.t }
      let want = c.expectsRows ? required : required.filter { $0 != "EntryRow" }
      let missing = want.filter { firsts[$0] == nil }
      if !missing.isEmpty { problems.append("\(c.id): no \(missing.joined(separator: "/")) body since its project opened") }
      if c.warm == false { problems.append("\(c.id): cold (its thread isn't shown)") }
      if let v = c.view, v != "hosting" { problems.append("\(c.id): \(v == "placeholder" ? "still the reel's blank placeholder" : v == "empty" ? "an empty hosting view" : v == "hidden" ? "hidden while in view" : "no view in the reel")") }
      if missing.isEmpty, let when = want.compactMap({ firsts[$0] }).max() {
        let late = when - settleAt
        latest = max(latest ?? late, late)
        if late > limitMs { problems.append("\(c.id): built \(Stats.round(late, 1)) ms after settle (limit \(Int(limitMs)) ms)") }
      }
    }
    let value = latest.map { Stats.round($0, 1) }
    let detail = problems.isEmpty
      ? "\(columns.count) on-screen column(s) built, the last \(value.map { $0 <= 0 ? "before settle (\(-$0) ms)" : "\($0) ms after settle" } ?? "-") (limit \(Int(limitMs)) ms)"
      : problems.joined(separator: "; ")
    return GuardResult(name: Guards.builtWithin, pass: problems.isEmpty, detail: detail, value: value, limit: limitMs)
  }
}

/// An 8-bit RGBA bitmap, rows top to bottom.
public struct RGBAImage: Sendable, Equatable {
  public var width: Int, height: Int
  public var pixels: [UInt8]
  public init(width: Int, height: Int, pixels: [UInt8]) { self.width = width; self.height = height; self.pixels = pixels }
  public init(width: Int, height: Int, fill: (UInt8, UInt8, UInt8)) {
    self.width = width; self.height = height
    pixels = [UInt8](repeating: 255, count: width * height * 4)
    for i in 0..<(width * height) { pixels[i * 4] = fill.0; pixels[i * 4 + 1] = fill.1; pixels[i * 4 + 2] = fill.2 }
  }
  @inline(__always) func differs(_ o: RGBAImage, _ i: Int, _ t: Int) -> Bool {
    let p = i * 4
    for c in 0..<3 where abs(Int(pixels[p + c]) - Int(o.pixels[p + c])) > t { return true }
    return false
  }
  public mutating func set(_ x: Int, _ y: Int, _ c: (UInt8, UInt8, UInt8)) { let p = (y * width + x) * 4; pixels[p] = c.0; pixels[p + 1] = c.1; pixels[p + 2] = c.2; pixels[p + 3] = 255 }
}

/// Where the window's columns were when a snapshot was taken (`<name>.layout.json` beside `<name>.png`).
public struct SnapshotLayout: Codable, Sendable, Equatable {
  public var schema = "deskbench.snapshot/1"
  public var scenario: String
  /// Pixels per point of the PNG.
  public var scale: Double
  public var widthPx: Int, heightPx: Int
  /// The columns in view, left to right; rects in PNG pixels, top-left origin: [x, y, w, h], clipped to what shows.
  public var columns: [Col]
  public var at: String
  public struct Col: Codable, Sendable, Equatable {
    public var id: String
    public var rect: [Int]
    /// The column's thread viewport (its scroll view), when it has one: compared by how much is drawn in it, not
    /// pixel by pixel (a thread's resting scroll offset varies from run to run on the same build).
    public var thread: [Int]?
    /// Less than half of it shows (a neighbour peeking at the edge): only its thread is masked, it isn't judged.
    public var partial: Bool?
    public init(id: String, rect: [Int], thread: [Int]? = nil, partial: Bool? = nil) { self.id = id; self.rect = rect; self.thread = thread; self.partial = partial }
  }
  public init(scenario: String, scale: Double, widthPx: Int, heightPx: Int, columns: [Col], at: String) {
    self.scenario = scenario; self.scale = scale; self.widthPx = widthPx; self.heightPx = heightPx; self.columns = columns; self.at = at
  }
}

/// The `snapshot-diff` guard's arithmetic, on bitmaps: pure, so it is tested without a window or a PNG.
public enum SnapshotDiff {
  public struct Column: Codable, Sendable, Equatable {
    public var id: String
    /// Share of the column's compared pixels that differ.
    public var ratio: Double
    /// The extent of what is drawn in the column (pixels unlike its background), [x, y, w, h] px; nil when empty.
    public var inkA: [Int]?, inkB: [Int]?
    /// Where the differing pixels are, [x, y, w, h] px; nil when none.
    public var changed: [Int]?
    /// Share of the thread viewport's pixels that are drawn (unlike its background) on each side; nil without a thread.
    public var threadInkA: Double?, threadInkB: Double?
    public var pass: Bool
    public var why: String?
  }

  public struct Report: Codable, Sendable, Equatable {
    public var schema = "deskbench.snapdiff/1"
    public var ratio: Double
    public var differing: Int
    public var compared: Int
    /// Pixels left out: they changed by themselves within one side's own two snapshots (the clocks), widened.
    public var masked: Int
    /// Pixels in thread viewports, compared by ink coverage instead of pixel by pixel.
    public var threads: Int?
    public var tolerance: Double
    public var columns: [Column]
    public var pass: Bool
    public var reasons: [String]
  }

  /// Pixels that differ between two snapshots of one window taken apart in time: what moves on its own.
  public static func unstable(_ a: RGBAImage, _ later: RGBAImage, threshold: Int) -> [Bool] {
    guard a.width == later.width, a.height == later.height else { return [Bool](repeating: false, count: a.width * a.height) }
    var m = [Bool](repeating: false, count: a.width * a.height)
    for i in 0..<m.count where a.differs(later, i, threshold) { m[i] = true }
    return m
  }

  /// Grows a mask by `rx` pixels left and right and `ry` up and down (a box, two separable passes).
  public static func dilate(_ m: [Bool], width w: Int, height h: Int, rx: Int, ry: Int) -> [Bool] {
    guard rx > 0 || ry > 0, m.contains(true) else { return m }
    var row = [Bool](repeating: false, count: m.count)
    for y in 0..<h {
      var last = Int.min / 2   // the nearest set pixel at or left of x, then right of x
      let base = y * w
      for x in 0..<w { if m[base + x] { last = x }; if x - last <= rx { row[base + x] = true } }
      last = Int.max / 2
      for x in stride(from: w - 1, through: 0, by: -1) { if m[base + x] { last = x }; if last - x <= rx { row[base + x] = true } }
    }
    guard ry > 0 else { return row }
    var out = row
    for x in 0..<w {
      var last = Int.min / 2
      for y in 0..<h { if row[y * w + x] { last = y }; if y - last <= ry { out[y * w + x] = true } }
      last = Int.max / 2
      for y in stride(from: h - 1, through: 0, by: -1) { if row[y * w + x] { last = y }; if last - y <= ry { out[y * w + x] = true } }
    }
    return out
  }

  /// Compares the champion's snapshot `a` with the candidate's `b`: pixel by pixel outside `mask` and the threads'
  /// viewports, the whole window's share of differing pixels against `tolerance`; per full column of the champion's
  /// layout, its own share against `columnTolerance`, its ink box against `bboxPx`, and its thread's ink coverage
  /// (the share of the viewport drawn): at least `threadInkMin` of the champion's. `columnsB` is the candidate's
  /// layout: other columns in view fail by themselves.
  public static func compare(_ a: RGBAImage, _ b: RGBAImage, mask: [Bool]?, columns: [SnapshotLayout.Col], columnsB: [SnapshotLayout.Col]?,
                             tolerance: Double, columnTolerance: Double, bboxPx: Int, threadInkMin: Double, threshold: Int) -> Report {
    var reasons: [String] = []
    guard a.width == b.width, a.height == b.height else {
      return Report(ratio: 1, differing: b.width * b.height, compared: b.width * b.height, masked: 0, tolerance: tolerance, columns: [], pass: false,
                    reasons: ["the snapshots differ in size: \(a.width)×\(a.height) px vs \(b.width)×\(b.height) px"])
    }
    let n = a.width * a.height
    // Thread viewports of either side: their content is compared by coverage below.
    var inThread = [Bool](repeating: false, count: n), threads = 0
    for t in (columns + (columnsB ?? [])).compactMap(\.thread) where t.count == 4 {
      for y in max(0, t[1])..<min(a.height, t[1] + t[3]) { for x in max(0, t[0])..<min(a.width, t[0] + t[2]) { inThread[y * a.width + x] = true } }
    }
    var differing = 0, masked = 0
    var diff = [Bool](repeating: false, count: n)
    for i in 0..<n {
      if mask?[i] == true { masked += 1; continue }
      if inThread[i] { threads += 1; continue }
      if a.differs(b, i, threshold) { diff[i] = true; differing += 1 }
    }
    let compared = n - masked - threads
    let ratio = compared > 0 ? Double(differing) / Double(compared) : 0
    if ratio > tolerance { reasons.append("\(pct(ratio)) of the window's pixels differ (tolerance \(pct(tolerance)))") }
    let fullA = columns.filter { $0.partial != true }, fullB = columnsB?.filter { $0.partial != true }
    if let fb = fullB, fb.map(\.id) != fullA.map(\.id) {
      reasons.append("other columns in view: \(fullA.map(\.id).joined(separator: ", ")) vs \(fb.map(\.id).joined(separator: ", "))")
    }
    var cols: [Column] = []
    for c in fullA {
      guard c.rect.count == 4 else { continue }
      let x0 = max(0, c.rect[0]), y0 = max(0, c.rect[1]), x1 = min(a.width, c.rect[0] + c.rect[2]), y1 = min(a.height, c.rect[1] + c.rect[3])
      guard x1 > x0, y1 > y0 else { continue }
      var d = 0, m = 0, box = Box()
      for y in y0..<y1 { for x in x0..<x1 { let i = y * a.width + x; if mask?[i] == true || inThread[i] { m += 1 } else if diff[i] { d += 1; box.add(x, y) } } }
      let area = (x1 - x0) * (y1 - y0) - m
      let r = area > 0 ? Double(d) / Double(area) : 0
      let ia = ink(a, x0, y0, x1, y1, threshold: threshold)?.box, ib = ink(b, x0, y0, x1, y1, threshold: threshold)?.box
      var why: [String] = []
      if r > columnTolerance { why.append("\(pct(r)) of its pixels outside the thread differ (column tolerance \(pct(columnTolerance)))") }
      switch (ia, ib) {
      case (nil, nil): break
      case (.some, nil): why.append("nothing is drawn in it on the candidate")
      case (nil, .some): why.append("nothing is drawn in it on the champion")
      case let (p?, q?):
        let off = zip(p.edges, q.edges).map { abs($0 - $1) }.max() ?? 0
        if off > bboxPx { why.append("its ink box moved \(off) px (\(q.rect!) vs \(p.rect!); limit \(bboxPx) px)") }
      }
      var ta: Double?, tb: Double?
      if let t = c.thread, t.count == 4 {
        ta = ink(a, t[0], t[1], t[0] + t[2], t[1] + t[3], threshold: threshold)?.coverage ?? 0
        tb = ink(b, t[0], t[1], t[0] + t[2], t[1] + t[3], threshold: threshold)?.coverage ?? 0
        let bHas = columnsB.map { $0.first { $0.id == c.id }?.thread != nil } ?? true
        if !bHas { why.append("no thread on the candidate") }
        if tb! < ta! * threadInkMin { why.append("its thread is \(pct(tb!)) drawn vs the champion's \(pct(ta!)) (at least \(Int(threadInkMin * 100)) % of it is due)") }
      }
      cols.append(Column(id: c.id, ratio: Stats.round(r, 5), inkA: ia?.rect, inkB: ib?.rect, changed: box.rect,
                         threadInkA: ta.map { Stats.round($0, 4) }, threadInkB: tb.map { Stats.round($0, 4) }, pass: why.isEmpty, why: why.isEmpty ? nil : why.joined(separator: "; ")))
      if !why.isEmpty { reasons.append("column \(c.id): " + why.joined(separator: "; ")) }
    }
    return Report(ratio: Stats.round(ratio, 6), differing: differing, compared: compared, masked: masked, threads: threads, tolerance: tolerance, columns: cols,
                  pass: reasons.isEmpty, reasons: reasons)
  }

  /// The report as the guard's record.
  public static func guardResult(_ r: Report, artifacts: [String]) -> GuardResult {
    // How close the threads came to the floor (`threadInkMin`): the headroom the tolerance has on this pair.
    let inks = r.columns.compactMap { c in c.threadInkA.flatMap { a in c.threadInkB.map { a > 0 ? $0 / a : 1 } } }
    let detail = r.pass
      ? "\(pct(r.ratio)) of the pixels outside the threads differ (tolerance \(pct(r.tolerance))); \(r.columns.count) column(s) within their boxes"
        + (inks.min().map { ", threads drawn \(Int(($0 * 100).rounded())) % or more of the champion's" } ?? "")
        + "; \(pct(Double(r.masked) / Double(max(1, r.compared + r.masked + (r.threads ?? 0))))) masked (clocks)"
      : r.reasons.joined(separator: "; ")
    return GuardResult(name: Guards.snapshotDiff, pass: r.pass, detail: detail, artifacts: artifacts, value: r.ratio, limit: r.tolerance, review: r.pass ? nil : true)
  }

  /// Marks the differing pixels on a dimmed copy of the candidate's snapshot, for the owner's look.
  public static func picture(_ a: RGBAImage, _ b: RGBAImage, mask: [Bool]?, threshold: Int) -> RGBAImage {
    var out = b
    guard a.width == b.width, a.height == b.height else { return out }
    for i in 0..<(b.width * b.height) {
      let p = i * 4
      if mask?[i] == true { out.pixels[p] = 40; out.pixels[p + 1] = 40; out.pixels[p + 2] = 120; continue }
      if a.differs(b, i, threshold) { out.pixels[p] = 255; out.pixels[p + 1] = 0; out.pixels[p + 2] = 255 }
      else { for c in 0..<3 { out.pixels[p + c] = out.pixels[p + c] / 3 } }
    }
    return out
  }

  struct Box {
    var x0 = Int.max, y0 = Int.max, x1 = Int.min, y1 = Int.min
    mutating func add(_ x: Int, _ y: Int) { x0 = min(x0, x); y0 = min(y0, y); x1 = max(x1, x); y1 = max(y1, y) }
    var rect: [Int]? { x1 < x0 ? nil : [x0, y0, x1 - x0 + 1, y1 - y0 + 1] }
    var edges: [Int] { [x0, y0, x1, y1] }
  }

  /// What is drawn in a region: pixels unlike its background (the commonest colour in it, sampled), their extent and
  /// their share of the region. The region's outer 3 px are left out (the column's own stroke); nil when nothing is.
  static func ink(_ img: RGBAImage, _ x0: Int, _ y0: Int, _ x1: Int, _ y1: Int, threshold: Int) -> (box: Box, coverage: Double)? {
    let ix0 = max(0, x0) + 3, iy0 = max(0, y0) + 3, ix1 = min(img.width, x1) - 3, iy1 = min(img.height, y1) - 3
    guard ix1 > ix0, iy1 > iy0 else { return nil }
    var hist: [Int: Int] = [:]
    for y in stride(from: iy0, to: iy1, by: 5) { for x in stride(from: ix0, to: ix1, by: 5) {
      let p = (y * img.width + x) * 4
      hist[((Int(img.pixels[p]) >> 3) << 10) | ((Int(img.pixels[p + 1]) >> 3) << 5) | (Int(img.pixels[p + 2]) >> 3), default: 0] += 1
    } }
    guard let mode = hist.max(by: { $0.value < $1.value })?.key else { return nil }
    let bg = [((mode >> 10) << 3) + 4, (((mode >> 5) & 31) << 3) + 4, ((mode & 31) << 3) + 4]
    var box = Box(), drawn = 0
    for y in iy0..<iy1 { for x in ix0..<ix1 {
      let p = (y * img.width + x) * 4
      if abs(Int(img.pixels[p]) - bg[0]) > threshold + 4 || abs(Int(img.pixels[p + 1]) - bg[1]) > threshold + 4 || abs(Int(img.pixels[p + 2]) - bg[2]) > threshold + 4 { box.add(x, y); drawn += 1 }
    } }
    return box.rect == nil ? nil : (box, Double(drawn) / Double((ix1 - ix0) * (iy1 - iy0)))
  }

  static func pct(_ x: Double) -> String { "\(Stats.round(x * 100, 3)) %" }
}

extension Summary {
  /// Guards that failed in any rep, by name (SCHEMAS.md §3 `summary.guardsFailed`).
  public static func guardsFailed(_ rs: [RepResult]) -> [String] {
    Array(Set(rs.flatMap { ($0.guards ?? []).filter { !$0.pass }.map(\.name) })).sorted()
  }
}
