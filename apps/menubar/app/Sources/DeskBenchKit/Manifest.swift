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
    /// Metrics that may not get worse beyond their band for a candidate to win, whatever the objective.
    public var guards: [String]
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
                      params: s.params, objective: o.metric, guards: (o == .frames ? [] : [Objective.frames.metric]) + ["longestStretchMs"],
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
    "fling": ["reel-scroll-view", "snapped"], "burst": ["isolation-*", "delivered-*"], "typing": ["composer-found", "typed", "isolation"],
    "resize": ["columns-follow-width"], "follow": ["enough-columns", "landed"],
  ]

  /// Every `DeskProbe.body` name in CapcomdDesk.
  public static let probes = ["Column", "ColumnComposer", "ColumnHead", "ColumnThread", "CrewTab", "DecisionBar", "EntryRow", "FoldedDeck", "OpenGroup", "Reel", "RootView", "TitleBar"]

  /// The manifest as text, for a person.
  public var text: String {
    var o = ["\(app) via \(adapter), protocol \(`protocol`) · \(build.line)", "scenarios (objective; guards; checks):"]
    for s in scenarios {
      o.append("  \(s.name.padding(toLength: 8, withPad: " ", startingAt: 0)) \(s.kind): \(s.objective); \(s.guards.joined(separator: ", ")); \(s.checks.joined(separator: ", "))"
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
