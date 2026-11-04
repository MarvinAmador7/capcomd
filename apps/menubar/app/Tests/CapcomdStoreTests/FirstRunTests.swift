import XCTest
@testable import CapcomdStore

final class FirstRunTests: XCTestCase {
  func testCandidatesInOrderWithoutDuplicates() {
    let c = FirstRun.candidates(home: "/Users/me/", environment: ["CAPCOMD_CLI": "/opt/x/capcomd", "NPM_CONFIG_PREFIX": "/Users/me/.npm-global"])
    XCTAssertEqual(c, ["/opt/x/capcomd", "/opt/homebrew/bin/capcomd", "/usr/local/bin/capcomd", "/Users/me/.capcomd/bin/capcomd",
                       "/Users/me/.bun/bin/capcomd", "/Users/me/.npm-global/bin/capcomd", "/Users/me/.local/bin/capcomd"])
    XCTAssertEqual(FirstRun.candidates(home: "/h", environment: [:]).first, "/opt/homebrew/bin/capcomd")
  }

  func testChildPathPutsTheCLIsFolderAndBunFirst() {
    XCTAssertEqual(FirstRun.childPath(cli: "/Users/me/.npm-global/bin/capcomd", home: "/Users/me", inherited: "/usr/bin:/bin:/opt/homebrew/bin"),
                   "/Users/me/.npm-global/bin:/Users/me/.bun/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin")
    XCTAssertTrue(FirstRun.childPath(cli: "/opt/homebrew/bin/capcomd", home: "/h", inherited: nil).hasSuffix(":/usr/bin:/bin:/usr/sbin:/sbin"))
  }

  func testParsesTheCLIsOutput() {
    XCTAssertEqual(FirstRun.parseVersion("capcomd 0.9.0\n"), "0.9.0")
    XCTAssertEqual(FirstRun.parseVersion("capcomd 0.10.0-rc.1"), "0.10.0-rc.1")
    XCTAssertNil(FirstRun.parseVersion("zsh: command not found: capcomd"))

    let pair = #"{"schema":"relay.v1","ok":true,"id":"cli-1","name":"mac-app","app":"mac-app","scopes":["read"],"token":"cch_abc","revoked":[],"version":"0.10.0"}"#
    XCTAssertEqual(FirstRun.parsePair(pair), FirstRun.Paired(token: "cch_abc", version: "0.10.0"))
    XCTAssertNil(FirstRun.parsePair(#"{"schema":"relay.v1","ok":false,"error":{"code":"usage"}}"#))
    XCTAssertNil(FirstRun.parsePair("cch_abc\n"))   // the plain output is for people; the app asks for --json

    XCTAssertEqual(FirstRun.parseService(#"{"ok":true,"installed":true,"running":true,"port":6420}"#, exitCode: 0), .running)
    XCTAssertEqual(FirstRun.parseService(#"{"ok":true,"installed":true,"running":false,"log":"/h/.capcomd/engine.log"}"#, exitCode: 1),
                   .notAnswering(log: "/h/.capcomd/engine.log"))
    XCTAssertEqual(FirstRun.parseService(#"{"ok":false,"error":{"message":"launchctl bootstrap failed: 5\nmore"}}"#, exitCode: 2),
                   .failed("launchctl bootstrap failed: 5"))
    XCTAssertEqual(FirstRun.parseService("", exitCode: 127), .failed("capcomd exited with 127"))
  }

  func testVersionSkewOnlyWhenTheMinorDiffers() {
    XCTAssertNil(VersionSkew.of(app: "0.10.0", daemon: "0.10.3"))
    XCTAssertNil(VersionSkew.of(app: "0.10.0", daemon: nil))
    XCTAssertNil(VersionSkew.of(app: "dev", daemon: "0.10.0"))
    XCTAssertNil(VersionSkew.of(app: "0.10.0-rc.1", daemon: "0.10.0"))
    XCTAssertEqual(VersionSkew.of(app: "0.10.0", daemon: "0.9.2"), .daemonOlder(app: "0.10.0", daemon: "0.9.2", restartFixes: false))
    XCTAssertEqual(VersionSkew.of(app: "0.10.0", daemon: "0.9.2", cli: "0.10.1"), .daemonOlder(app: "0.10.0", daemon: "0.9.2", restartFixes: true))
    XCTAssertEqual(VersionSkew.of(app: "0.9.0", daemon: "1.0.0"), .appOlder(app: "0.9.0", daemon: "1.0.0"))
    XCTAssertTrue(VersionSkew.appOlder(app: "0.9.0", daemon: "0.10.0").message.contains("brew upgrade capcomd-app"))
    XCTAssertTrue(VersionSkew.daemonOlder(app: "0.10.0", daemon: "0.9.0", restartFixes: true).message.contains("Restart"))
  }

  /// The onboarding's "Start capcomd when I log in": the same login service, at login or now only.
  func testServiceAtLoginOrNowOnly() {
    XCTAssertEqual(FirstRun.serviceArguments(atLogin: true), ["service", "install", "--json"])
    XCTAssertEqual(FirstRun.serviceArguments(atLogin: false), ["service", "install", "--json", "--no-login"])
    XCTAssertEqual(FirstRun.parseServiceInstalled(#"{"installed":true,"loaded":true,"running":true,"port":6420}"#), true)
    XCTAssertEqual(FirstRun.parseServiceInstalled(#"{"installed":false,"loaded":false,"running":true}"#), false)
    XCTAssertNil(FirstRun.parseServiceInstalled("usage: capcomd service"))
  }
}
