import XCTest
import DeskBenchKit
import PerfLoopKit

/// `describe --json` read back the way PerfLoop's runner reads it (PerfLoopKit at the pinned revision, ADAPTER.md §2,
/// §6): each scenario's own fixture, the `scheme:` forms `--fixture` takes, what `profile` may hand the recorded process.
final class PerfLoopContractTests: XCTestCase {
  func manifests() throws -> (DeskBenchKit.Manifest, PerfLoopKit.Manifest) {
    let build = BuildInfo(hash: "sha256:00", commit: "abc1234", dirty: false, sourceHash: nil, builtAt: nil, configuration: "release", toolchain: nil, stamp: true)
    let m = DeskBenchKit.Manifest(build: build, knobs: [])
    return (m, try JSONDecoder().decode(PerfLoopKit.Manifest.self, from: Data(JSONOut.encode(m).utf8)))
  }

  func testEachScenarioRunsOnItsOwnFixtureThroughTheRunner() throws {
    let (m, read) = try manifests()
    XCTAssertEqual(read.defaultFixture, "crew17")
    for s in Scenarios.all {
      let expected = s.name.hasPrefix("palette-") ? "search" : s.name.hasPrefix("needs-") ? "needs5" : nil
      XCTAssertEqual(s.fixture, expected, s.name)
      XCTAssertEqual(m.scenarios.first { $0.name == s.name }?.fixture, expected, s.name)
      // What perfloop passes as --fixture when nobody names one is what `deskbench run` picks on its own.
      XCTAssertEqual(read.fixture(for: s.name), Scenarios.fixture(for: s.name), s.name)
      // doctor --bench fails a scenario whose fixture isn't listed.
      XCTAssertNil(read.unknownFixture(Scenarios.fixture(for: s.name)), s.name)
    }
    XCTAssertEqual(Scenarios.fixture(for: "step"), "crew17")
    XCTAssertEqual(Scenarios.fixture(for: "no-such-scenario"), "crew17")
    // Absent, not null, on the scenarios that run on the default.
    let obj = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(JSONOut.encode(m).utf8)) as? [String: Any])
    let step = try XCTUnwrap((obj["scenarios"] as? [[String: Any]])?.first { $0["name"] as? String == "step" })
    XCTAssertNil(step["fixture"])
  }

  func testFixtureSchemesAreFileOnly() throws {
    let (_, read) = try manifests()
    XCTAssertEqual(read.fixtureSchemes, ["file"])
    XCTAssertNil(read.unknownFixture("file:/tmp/crew-real.json"))
    XCTAssertNil(read.unknownFixture("file:crew-real"))
    XCTAssertNil(read.unknownFixture("crew@agents=24,items=100"))
    XCTAssertNotNil(read.unknownFixture("https://example.com/x.json"))
    XCTAssertNotNil(read.unknownFixture("crew99"))
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
