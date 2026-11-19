#if os(macOS)
import XCTest
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit
@testable import CapcomdDesk

/// `describe --json` read back the way PerfLoop's runner reads it (PerfLoopKit at the pinned revision, ADAPTER.md §2,
/// §3b, §5a, §6): the bench is PerfLoopHost's, every scenario on its own fixture, the `scheme:` forms `--fixture` takes,
/// the one look the app draws in, what `profile` may hand the recorded process. No window: the drivers are stand-ins.
@MainActor final class PerfLoopContractTests: XCTestCase {
  func bench() -> Bench {
    BenchCatalog.make(stamp: "commit=abc1234\ndirty=0", knobs: { DeskKnobs.knobs }, body: { _ in nil },
                      builtWithin: { _, _ in GuardResult(name: Guards.builtWithin, pass: true, detail: "") })
  }
  func manifests() throws -> (Bench, PerfLoopKit.Manifest) {
    let b = bench()
    return (b, try JSONDecoder().decode(PerfLoopKit.Manifest.self, from: Data(PLJSON.encode(BenchCatalog.manifest(b)).utf8)))
  }

  func testTheManifestIsPerfLoopHostsWithEveryScenario() throws {
    let (_, m) = try manifests()
    XCTAssertEqual(m.app, "capcomd-desktop"); XCTAssertEqual(m.adapter, "deskbench")
    XCTAssertEqual(m.harness, "PerfLoopHost", "doctor --bench: the helpers of ADAPTER.md §3b (until:, wait, settle, ink, input)")
    XCTAssertEqual(m.scenarios.map(\.name), Scenarios.all.map(\.name))
    XCTAssertFalse((m.verbs ?? []).contains("ab"), "pairs go through two runs: PerfLoopHost has no ab")
    let step = try XCTUnwrap(m.scenarios.first { $0.name == "step" })
    XCTAssertEqual(step.objective, "mainThreadCpuMsPerStep")
    XCTAssertEqual(step.guards, ["checks", "built-within", "snapshot-diff"])
    XCTAssertEqual(step.frameGuards, ["hitchTimeRatioMsPerS", "longestStretchMs"])
    XCTAssertEqual(step.guardParams?["built-within.ms"], .number(300))
    XCTAssertEqual(step.params, ["steps": "8"])
    XCTAssertEqual(m.scenarios.first { $0.name == "typing" }?.guards, ["checks", "built-within"], "no pixels compared where a caret blinks")
    XCTAssertEqual(m.scenarios.first { $0.name == "switch" }?.objective, "latencyMs")
    XCTAssertEqual(m.scenarios.first { $0.name == "swipe" }?.frameGuards, ["hitchTimeRatioMsPerS", "longestStretchMs", "positionErrorP95Pt", "stalls"])
    XCTAssertEqual(m.isolationGuards, ["burst", "typing"])
    XCTAssertEqual(m.fixtures.compactMap { $0["name"]?.string }, Fixtures.all.map(\.name))
    XCTAssertEqual(Set(m.knobs.map(\.name)), Set(DeskKnobs.all.map(\.name)))
    XCTAssertTrue(Set(["synthetic:flick-forward", "synthetic:flick-back", "synthetic:drag-forward"]).isSubset(of: Set(m.gestures ?? [])))
  }

  func testEachScenarioRunsOnItsOwnFixtureThroughTheRunner() throws {
    let (_, read) = try manifests()
    XCTAssertEqual(read.defaultFixture, "crew17")
    for s in Scenarios.all {
      let expected = s.name.hasPrefix("palette-") ? "search" : s.name.hasPrefix("needs-") ? "needs5" : nil
      XCTAssertEqual(s.fixture, expected, s.name)
      XCTAssertEqual(read.scenarios.first { $0.name == s.name }?.fixture, expected, s.name)
      // What perfloop passes as --fixture when nobody names one is what the bench picks on its own.
      XCTAssertEqual(read.fixture(for: s.name), Scenarios.fixture(for: s.name), s.name)
      // doctor --bench fails a scenario whose fixture isn't listed.
      XCTAssertNil(read.unknownFixture(Scenarios.fixture(for: s.name)), s.name)
    }
    XCTAssertEqual(Scenarios.fixture(for: "step"), "crew17")
  }

  func testFixtureSchemesAreFileOnlyAndAFileFixtureRunsUnderItsOwnName() throws {
    let (b, read) = try manifests()
    XCTAssertEqual(read.fixtureSchemes, ["file"])
    XCTAssertNil(read.unknownFixture("file:/tmp/crew-real.json"))
    XCTAssertNil(read.unknownFixture("crew@agents=24,items=100"))
    XCTAssertNotNil(read.unknownFixture("https://example.com/x.json"))
    XCTAssertNotNil(read.unknownFixture("crew99"))
    // A listed name or a parametric one needs nothing; a captured one must exist, and is then listed under its name
    // for this process, so the run's result says the fixture the runner asked for.
    XCTAssertNil(BenchCatalog.register(fixture: "crew17@agents=24", on: b))
    XCTAssertNotNil(BenchCatalog.register(fixture: "file:/nonexistent/crew-real.json", on: b))
    // An existing capture registers (CaptureTests.testTheBenchLoadsACapturedFile).
  }

  func testTheAppDrawsDarkOnly() throws {
    let (_, read) = try manifests()
    XCTAssertEqual(read.appearances, ["dark"], "the app forces the dark look: perfloop refuses --set appearance=light")
    XCTAssertEqual(bench().appearance, .darkAqua)
  }

  func testProfileEnvironmentIsPerfLoopsAllowlistPlusTheBenchsOwnSwitches() throws {
    let (_, read) = try manifests()
    XCTAssertEqual(read.profileEnv, TracePrivacy.profileEnv)
    for name in TracePrivacy.profileEnv {
      XCTAssertFalse(TraceEnv.secretLike(name), "\(name) looks like a secret: perfloop would drop it")
      XCTAssertTrue(TraceEnv.allowed(name, declared: TracePrivacy.profileEnv), name)
    }
    let env = ["HOME": "/Users/x", "PATH": "/usr/bin", "LC_ALL": "C", "TZ": "UTC", "DESKBENCH_SIZING": "1", "DESKBENCH_SAMPLER": "off",
               "PERFLOOP_KNOBS": "reel.slide=clip", "PERFLOOP_HOME": "/tmp/pl", "PERFLOOP_LOCK_HELD": "/tmp/l",
               // Never: tokens, the owner's flag, the runners' passwords, undeclared variables, secret-like ones even under our prefix.
               "PERFLOOP_OWNER": "1", "PERFLOOP_VM_PASSWORD": "x", "CAPCOMD_TOKEN": "x", "GITHUB_TOKEN": "x", "SSH_AUTH_SOCK": "/tmp/s",
               "DESKBENCH_TOKEN": "x", "DESKBENCH_UNDECLARED": "1", "CAPCOMD_HOME": "/Users/x/.capcomd", "OPENAI_API_KEY": "x"]
    XCTAssertEqual(Set(TracePrivacy.scrub(env).keys), ["HOME", "PATH", "LC_ALL", "TZ", "DESKBENCH_SIZING", "DESKBENCH_SAMPLER",
                                                        "PERFLOOP_KNOBS", "PERFLOOP_HOME", "PERFLOOP_LOCK_HELD"])
    // The bench applies the same rule perfloop does: it never passes on more than perfloop would give it.
    XCTAssertEqual(TracePrivacy.scrub(env), TraceEnv.scrub(env, declared: read.profileEnv ?? []))
  }
}
#endif
