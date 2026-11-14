import Foundation
import PerfLoopProbe

/// What `deskbench describe --json` prints (design/perf-loop SCHEMAS.md §2, `perfloop.manifest/1`): everything the
/// generic runner needs to drive this adapter without importing the app. Which scenarios exist and what each decides
/// on, which guards gate acceptance, the fixtures, the knobs that can be swept, how to host the window. Fields are only
/// ever added.
public struct Manifest: Codable, Sendable, Equatable {
  public var schema = "perfloop.manifest/1"
  /// The bench protocol's version: `run <scenario> --json` prints a result on stdout; `--wait-for FILE` holds the
  /// window until FILE exists and writes FILE.done when the reps are done; knobs come in PERFLOOP_KNOBS.
  public var `protocol` = 1
  public var app = "capcomd-desktop"
  public var adapter = "deskbench"
  public var build: BuildInfo
  public var scenarios: [Scenario]
  /// The scenarios a whole-suite run covers, in order.
  public var suite: [String]
  public var fixtures: [FixtureSpec]
  public var defaultFixture = "crew17"
  public var knobs: [KnobInfo]
  /// The objectives a comparison can decide on (`--objective`); each scenario names its default.
  public var objectives: [String]
  public var hosts = ["scene", "window"]
  public var defaultHost = "scene"
  /// View bodies the probe seam counts (a rep's `bodies`).
  public var probes: [String]
  public var exitCodes: [String: Int]
  /// Scenarios whose checks run on every promotion, whatever the experiment climbs (C6: isolation, Guards.swift).
  public var isolationGuards: [String]? = Guards.isolation
  /// The gestures `swipe` has built in (`--set gesture=synthetic:NAME`); recorded ones are files (`perfloop.gesture/1`,
  /// `--set gesture=PATH`, `perfloop gestures list`).
  public var gestures: [String]? = Gestures.synthetic.map(Gestures.spec)

  public struct Scenario: Codable, Sendable, Equatable {
    public var name: String
    public var summary: String
    public var kind: String
    public var budget: String
    public var rule: String
    public var latencyBudgetMs: Double?
    public var params: [String: String]
    /// What `ab` and `compare` decide on unless told otherwise (lower is better).
    public var objective: String
    /// Correctness guards that gate acceptance (SCHEMAS.md §2, Guards.swift): `checks` (the scenario's own checks),
    /// `built-within`, `snapshot-diff`. The runner reads them from the champion's manifest, never the candidate's.
    public var guards: [String]
    /// Their parameters (`built-within.ms`, `snapshot-diff.tolerance`, …).
    public var guardParams: [String: Double]? = nil
    /// Metrics that may not get worse beyond their band for a candidate to win, whatever the objective.
    public var frameGuards: [String]? = nil
    /// The scenario's own checks: one failing in most reps fails the budget.
    public var checks: [String]
    /// A host the scenario always uses, whatever `--host` says (`open` needs a fresh window per rep).
    public var host: String?
  }

  public init(build: BuildInfo, knobs: [KnobInfo]) {
    self.build = build
    self.knobs = knobs
    scenarios = Scenarios.all.map { s in
      let o = Objective.default(for: s)
      return Scenario(name: s.name, summary: s.summary, kind: s.kind.rawValue, budget: s.budget, rule: s.rule, latencyBudgetMs: s.latencyBudgetMs,
                      params: s.params, objective: o.metric, guards: Guards.forScenario(s.name), guardParams: Guards.params(for: s.name),
                      frameGuards: (o == .frames ? [] : [Objective.frames.metric]) + ["longestStretchMs"] + (s.name == "swipe" ? ["positionErrorP95Pt", "stalls"] : []),
                      checks: Self.checks[s.name] ?? [], host: s.name == "open" ? "window" : nil)
    }
    suite = Scenarios.suite
    fixtures = Fixtures.all
    objectives = Objective.allCases.map(\.metric)
    probes = Self.probes
    exitCodes = ["ok": ExitCode.ok, "usage": ExitCode.usage, "harness": ExitCode.harness, "budget": ExitCode.budget, "regression": ExitCode.regression,
                 "untrusted": ExitCode.untrusted, "refused": ExitCode.refused]
  }

  /// The checks each scenario's driver records (CapcomdDeskBench/Drive.swift). `burst`'s carry its phase:
  /// `isolation-still`, `delivered-moving`, …
  public static let checks: [String: [String]] = [
    "open": ["columns-at-first-frame"], "switch": ["two-projects", "switched"], "step": ["landed"], "jump": ["enough-columns", "landed"],
    "fling": ["reel-scroll-view", "snapped"], "swipe": ["reel-scroll-view", "gesture", "snapped"], "burst": ["isolation-*", "delivered-*"], "typing": ["composer-found", "typed", "isolation"],
    "resize": ["columns-follow-width"], "follow": ["enough-columns", "landed"],
    "palette-open": ["items", "empty-search", "panel-drawn", "esc-closes"], "palette-type": ["typed", "ranking", "panel-drawn"],
    "palette-keys": ["selection", "return-opens", "split-falls-back", "esc-closes", "panel-drawn"],
  ]

  /// Every `DeskProbe.body` name in CapcomdDesk.
  public static let probes = ["Column", "ColumnComposer", "ColumnHead", "ColumnThread", "CrewTab", "DecisionBar", "EntryRow", "FoldedDeck", "OpenGroup", "Reel", "RootView", "SearchView", "TitleBar"]

  /// The manifest as text, for a person.
  public var text: String {
    var o = ["\(app) via \(adapter), protocol \(`protocol`) · \(build.line)", "scenarios (objective; correctness guards; frame guards; checks):"]
    for s in scenarios {
      o.append("  \(s.name.padding(toLength: 8, withPad: " ", startingAt: 0)) \(s.kind): \(s.objective); \(s.guards.joined(separator: ", ")); \((s.frameGuards ?? []).joined(separator: ", ")); \(s.checks.joined(separator: ", "))"
               + (s.params.isEmpty ? "" : "  params " + s.params.map { "\($0.key)=\($0.value)" }.sorted().joined(separator: " ")))
    }
    o.append("fixtures: " + fixtures.map(\.name).joined(separator: ", ") + " (default \(defaultFixture))")
    o.append("knobs (--knob name=value, PERFLOOP_KNOBS):")
    for k in knobs {
      let values = k.choices?.joined(separator: "|") ?? k.range.map { "\($0[0])…\($0[1])" } ?? k.type
      o.append("  \(k.name.padding(toLength: 16, withPad: " ", startingAt: 0)) \(values), default \(k.default)" + (k.summary.map { ": \($0)" } ?? ""))
    }
    o.append("hosts: \(hosts.joined(separator: ", ")) (default \(defaultHost))")
    return o.joined(separator: "\n")
  }
}
