import Foundation
import PerfLoopKit

// Correctness guards (design/perf-loop CAPABILITIES.md C6): pass/fail checks that make "fast because wrong" lose. A
// blank column is fast; the objective alone would climb on it. The bench's own guard is here; PerfLoopHost brings the
// rest (`snapshot-diff`, region by region; the `ink` guard over each scenario's main view), all judged after the
// scenario has settled, and never optimised:
//
// - `built-within`: every on-screen column has had its `Column`, `ColumnHead`, `ColumnThread` bodies and (when the
//   fixture gives it a thread) at least one `EntryRow` body since its project opened, the last of them at most N ms
//   after the scenario's settle point (N = `built-within.ms`, default 300), and each on-screen hosting view has
//   something in it (not the reel's blank placeholder, not an empty hosting view).
//
// The runner (perfloop) reads which guards gate a scenario from the champion's manifest, never the candidate's, and
// passes them to both sides (`PERFLOOP_GUARDS`); the snapshot comparison runs in the champion's binary (`snapdiff`).

/// Which guards gate each scenario, with their parameters: what `describe` lists and the runner passes back.
public enum Guards {
  public static let builtWithin = "built-within"
  public static let snapshotDiff = "snapshot-diff"
  /// The scenario's own checks (`landed`, `isolation`, …): one the candidate fails while the champion passes vetoes it.
  public static let checks = "checks"

  /// Defaults, overridden per scenario by `params(for:)` and by the runner (`PERFLOOP_GUARD_PARAMS`).
  public static let defaults: [String: Double] = [
    "built-within.ms": 300,
    "snapshot-diff.tolerance": 0.005,
    /// A channel difference at or under this (of 255) is the same pixel.
    "snapshot-diff.threshold": 16,
  ]

  /// The scenarios whose end state is deterministic enough to compare pixels: the reel at rest after scrolls,
  /// switches, a resize, Follow, a fresh window, Search ⌘K at rest (its panel drawn in). Not `burst` (the arriving items' layout settles on its own clock) and
  /// not `typing` (the caret, the field editor). Their threads rest where they rest: a look that differs only in a
  /// thread is the owner's to read (DESKBENCH.md, Snapshots).
  static let snapshotScenarios: Set<String> = ["open", "switch", "step", "jump", "fling", "swipe", "follow", "resize",
                                                "needs-open", "needs-answer", "needs-arrive", "needs-step", "needs-empty", "needs-swipe", "sidebar-toggle", "sidebar-select",
                                                "palette-first", "palette-open", "palette-type", "palette-keys", "split-open", "split-focus", "pane-expand", "expand-switch"]

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
