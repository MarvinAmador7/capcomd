#if os(macOS)
import AppKit
import Foundation
import PerfLoopHost
import PerfLoopKit
import PerfLoopProbe

/// deskbench as a PerfLoopHost bench: the scenarios (Scenarios.swift), the fixtures (Fixtures.swift, parametric), the
/// guards (Guards.swift), the probes, what `profile` may pass on (TracePrivacy.swift) and the look, registered on a
/// `Bench`. The bench executable gives the scenarios' drivers, the knobs and the `built-within` guard; the tests give
/// stand-ins and read the manifest back the way perfloop's runner reads it, with no window.
public enum BenchCatalog {
  public static let app = "capcomd-desktop"
  public static let adapter = "deskbench"
  /// The app forces the dark look on every view (`.preferredColorScheme(.dark)`, the search panel's `darkAqua`): it
  /// follows no system appearance, so the bench draws dark and lists only that (`--set appearance=dark`).
  public static let appearances = ["dark"]
  /// `--fixture file:PATH` (or `file:NAME`, under the fixtures folder): a captured fixture (CapturedFixture.swift).
  public static let fixtureSchemes = ["file"]
  /// Module name prefixes whose frames are the app's (CapcomdDesk, CapcomdUI, CapcomdStore, …).
  public static let appModules = ["Capcomd"]

  /// Every `DeskProbe.body` name in CapcomdDesk.
  public static let probes = ["AgentRow", "Column", "ColumnComposer", "ColumnHead", "ColumnThread", "CrewTab", "DecisionBar", "EntryRow", "FoldedDeck",
                               "LimitBar", "NeedsReel", "NothingNeedsYou", "OpenGroup", "Pane", "PaneArea", "PaneComposer", "PaneEntryRow", "PaneHead",
                               "PaneThread", "ProjectLabel", "Rail", "Reel", "RootView", "SearchView", "SectionHeading", "Sidebar", "SidebarList",
                               "TitleBar"]

  /// The frame metrics a scenario may not make worse beyond their band, whatever it climbs on; a replayed gesture's
  /// smoothness too (`swipe`).
  public static func frameGuards(_ s: ScenarioSpec) -> [String] {
    ["hitchTimeRatioMsPerS", "longestStretchMs"] + (s.name == "swipe" ? ["positionErrorP95Pt", "stalls"] : [])
  }

  /// The bench, every scenario's body from `body` (nil: a stand-in that throws, for the tests).
  @MainActor
  public static func make(stamp: String?, fileID: String = #fileID, knobs: @escaping @MainActor () -> [any AnyKnob],
                          body: (String) -> ScenarioBody?, builtWithin: @escaping GuardBody) -> Bench {
    let bench = Bench(app: app, adapter: adapter, stamp: stamp, fileID: fileID)
    bench.appModules = appModules
    bench.probes = probes
    bench.profileEnv = TracePrivacy.profileEnv
    bench.gestures = SyntheticGestures.specs
    bench.windowSize = CGSize(width: 1440, height: 900)
    bench.appearance = .darkAqua
    bench.isolationScenarios = Guards.isolation
    for f in Fixtures.all {
      bench.fixture(f.name, summary: f.summary, parametric: f.parametric?.mapValues { Double($0[0])...Double($0[1]) })
    }
    bench.defaultFixture = Scenarios.defaultFixture
    bench.knobs(knobs)
    for s in Scenarios.all {
      let kind: ScenarioKind = switch s.kind { case .latency: .latency; case .smooth: .smooth; case .isolation: .isolation }
      bench.scenario(s.name, summary: s.summary, kind: kind, guards: Guards.forScenario(s.name), guardParams: Guards.params(for: s.name),
                     frameGuards: frameGuards(s), params: s.params, budget: "\(s.budget) (\(s.rule))", latencyBudgetMs: s.latencyBudgetMs, fixture: s.fixture,
                     body(s.name) ?? { _ in throw CatalogError("\(s.name) has no driver in this build") })
    }
    bench.guard(Guards.builtWithin, builtWithin)
    return bench
  }

  /// The manifest the runner reads (`describe --json`): PerfLoopHost's, with what this bench takes beyond its defaults:
  /// captured fixtures (`file:`) and the one look the app draws in.
  @MainActor
  public static func manifest(_ bench: Bench) -> Manifest {
    var m = bench.manifest()
    m.fixtureSchemes = fixtureSchemes
    m.appearances = appearances
    return m
  }

  /// A `--fixture` the bench takes beyond its listed names (`file:PATH`), registered under exactly that name for this
  /// process, so the run's result says the fixture it was asked for. nil when `spec` needs nothing (a listed name,
  /// `NAME@k=v`), else the problem with it.
  @MainActor
  public static func register(fixture spec: String, on bench: Bench) -> String? {
    guard spec.hasPrefix(CapturedFixture.prefix) else { return nil }
    if let p = Fixtures.problem(spec) { return p }
    if !bench.fixtures.contains(where: { $0.name == spec }) { bench.fixture(spec, summary: "a captured fixture") }
    return nil
  }
}

public struct CatalogError: Error, CustomStringConvertible {
  public var description: String
  public init(_ s: String) { description = s }
}
#endif
