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

  // MARK: The CLI the login service runs

  /// The launchd agent `capcomd service install` writes (src/cli/commands/service.ts serviceFile), for `argv`.
  static func launchAgent(_ argv: [String]) -> String {
    """
    <?xml version="1.0" encoding="UTF-8"?>
    <!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
    <plist version="1.0">
    <dict>
      <key>Label</key><string>dev.capcomd.engine</string>
      <key>ProgramArguments</key>
      <array>\(argv.map { "<string>\($0)</string>" }.joined())</array>
      <key>WorkingDirectory</key><string>/Users/me</string>
      <key>RunAtLoad</key><true/>
    </dict>
    </plist>
    """
  }

  func testTheServicesCLIFromItsLaunchAgent() {
    let entry = "/Users/me/.bun/install/global/node_modules/capcomd/src/cli/index.ts"
    XCTAssertEqual(FirstRun.servicePlist(home: "/Users/me/"), "/Users/me/Library/LaunchAgents/dev.capcomd.engine.plist")
    // Bun and npm: bun runs the package's entry.
    XCTAssertEqual(FirstRun.serviceCLI(plist: Data(Self.launchAgent(["/Users/me/.bun/bin/bun", entry, "serve", "--port", "6420"]).utf8)), entry)
    // The single executable (install.sh, Homebrew's opt link) runs itself.
    XCTAssertEqual(FirstRun.serviceCLI(plist: Data(Self.launchAgent(["/opt/homebrew/opt/capcomd/bin/capcomd", "serve", "--port", "6420"]).utf8)),
                   "/opt/homebrew/opt/capcomd/bin/capcomd")
    XCTAssertNil(FirstRun.serviceCLI(plist: Data(Self.launchAgent(["/usr/bin/true"]).utf8)))   // not capcomd's
    XCTAssertNil(FirstRun.serviceCLI(plist: Data(Self.launchAgent(["serve"]).utf8)))
    XCTAssertNil(FirstRun.serviceCLI(plist: Data("not a plist".utf8)))
  }

  func testTheServicesCLIComesFirstSoTheAppNeverSplitsFromItsDaemon() {
    let entry = "/Users/me/.bun/install/global/node_modules/capcomd/src/cli/index.ts"
    let links = ["/Users/me/.bun/bin/capcomd": entry,
                 "/opt/homebrew/bin/capcomd": "/opt/homebrew/Cellar/capcomd/0.12.0/bin/capcomd",
                 "/opt/homebrew/opt/capcomd/bin/capcomd": "/opt/homebrew/Cellar/capcomd/0.12.0/bin/capcomd"]
    let resolve = { (p: String) in links[p] ?? p }
    // Bun's: its bin link first, then the entry itself, then the usual order (Homebrew's CLI no longer wins).
    XCTAssertEqual(FirstRun.candidates(home: "/Users/me", environment: [:], service: entry, resolve: resolve),
                   ["/Users/me/.bun/bin/capcomd", entry, "/opt/homebrew/bin/capcomd", "/usr/local/bin/capcomd", "/Users/me/.capcomd/bin/capcomd",
                    "/Users/me/.npm-global/bin/capcomd", "/Users/me/.local/bin/capcomd"])
    // Homebrew's opt link: its bin, which is the same keg.
    XCTAssertEqual(FirstRun.candidates(home: "/Users/me", environment: [:], service: "/opt/homebrew/opt/capcomd/bin/capcomd", resolve: resolve).prefix(3),
                   ["/opt/homebrew/bin/capcomd", "/opt/homebrew/opt/capcomd/bin/capcomd", "/usr/local/bin/capcomd"])
    // install.sh's: already a candidate, moved up.
    XCTAssertEqual(FirstRun.candidates(home: "/Users/me", environment: [:], service: "/Users/me/.capcomd/bin/capcomd", resolve: resolve).first,
                   "/Users/me/.capcomd/bin/capcomd")
    // CAPCOMD_CLI is still asked first; no service, the order as before.
    XCTAssertEqual(FirstRun.candidates(home: "/Users/me", environment: ["CAPCOMD_CLI": "/x/capcomd"], service: entry, resolve: resolve).prefix(2),
                   ["/x/capcomd", "/Users/me/.bun/bin/capcomd"])
    XCTAssertEqual(FirstRun.candidates(home: "/Users/me", environment: [:], service: nil, resolve: resolve), FirstRun.candidates(home: "/Users/me", environment: [:]))
  }

  /// The owner's setup, with fake CLIs on disk: capcomd from `bun add -g` (~/.bun/bin/capcomd, a link to the package's
  /// entry) running as the login service, and an older install.sh capcomd earlier in the usual order. The app picks
  /// the service's, pairs with it, sees the service installed (so it offers none), and still warns on a version skew.
  func testFakeCLIsTheServicesBunInstallIsTheOnePairedWith() async throws {
    let home = try FakeHome()
    defer { home.remove() }
    let entry = try home.cli(".bun/install/global/node_modules/capcomd/src/cli/index.ts", version: "0.12.0", token: "cch_bun", installed: true)
    try home.link(".bun/bin/capcomd", to: "../install/global/node_modules/capcomd/src/cli/index.ts")
    _ = try home.cli(".capcomd/bin/capcomd", version: "0.11.0", token: "cch_installsh", installed: false)

    // No login service: the usual order (install.sh's ~/.capcomd/bin comes before Bun's bin).
    let before = await home.find()
    XCTAssertEqual(before?.path, home.path(".capcomd/bin/capcomd")); XCTAssertEqual(before?.version, "0.11.0")

    // The login service runs Bun's: that one, through its bin link.
    try home.write("Library/LaunchAgents/dev.capcomd.engine.plist", Self.launchAgent([home.path(".bun/bin/bun"), entry, "serve", "--port", "6420"]))
    let maybe = await home.find()
    let found = try XCTUnwrap(maybe)
    XCTAssertEqual(found.path, home.path(".bun/bin/capcomd")); XCTAssertEqual(found.version, "0.12.0")

    let pair = try XCTUnwrap(FakeHome.run(found.path, FirstRun.pairArguments))
    XCTAssertEqual(FirstRun.parsePair(pair), FirstRun.Paired(token: "cch_bun", version: "0.12.0"))
    XCTAssertEqual(FakeHome.run(found.path, FirstRun.serviceStatusArguments).flatMap(FirstRun.parseServiceInstalled), true)

    // The daemon it runs is older than the app: the warning stays, and a restart (through this CLI) fixes it.
    XCTAssertNil(VersionSkew.of(app: "0.12.0", daemon: "0.12.0", cli: found.version))
    XCTAssertEqual(VersionSkew.of(app: "0.12.0", daemon: "0.11.2", cli: found.version), .daemonOlder(app: "0.12.0", daemon: "0.11.2", restartFixes: true))
    XCTAssertEqual(VersionSkew.daemonOlder(app: "0.12.0", daemon: "0.11.2", restartFixes: false).message,
                   "This app is 0.12.0, capcomd is 0.11.2. Update capcomd: capcomd upgrade")

    // A service whose CLI is gone (uninstalled since): the usual order again.
    try FileManager.default.removeItem(atPath: entry)
    let after = await home.find()
    XCTAssertEqual(after?.path, home.path(".capcomd/bin/capcomd"))
  }

  /// No CLI anywhere: nothing found (the window and the onboarding then show `installCommand`).
  func testFakeCLIsNoneFound() async throws {
    let home = try FakeHome()
    defer { home.remove() }
    try home.write(".capcomd/bin/capcomd", "not executable")
    let found = await home.find()
    XCTAssertNil(found)
    XCTAssertEqual(FirstRun.installCommand, "brew install MarvinAmador7/tap/capcomd")   // scripts/homebrew-cask.ts's caveats say the same
  }
}

/// A throwaway home folder with fake capcomd CLIs (shell scripts that answer as capcomd does), searched like the app
/// searches (AppSession's CLIRunner.find), but only inside it.
struct FakeHome {
  let root: String
  init() throws {
    root = (NSTemporaryDirectory() as NSString).appendingPathComponent("capcomd-firstrun-\(UUID().uuidString)")
    try FileManager.default.createDirectory(atPath: root, withIntermediateDirectories: true)
  }
  func remove() { try? FileManager.default.removeItem(atPath: root) }
  func path(_ rel: String) -> String { (root as NSString).appendingPathComponent(rel) }

  func write(_ rel: String, _ body: String, executable: Bool = false) throws {
    let p = path(rel)
    try FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try body.write(toFile: p, atomically: true, encoding: .utf8)
    if executable { try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: p) }
  }
  func link(_ rel: String, to dest: String) throws {
    let p = path(rel)
    try FileManager.default.createDirectory(atPath: (p as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
    try FileManager.default.createSymbolicLink(atPath: p, withDestinationPath: dest)
  }
  /// A fake `capcomd`: --version, `clients pair --app mac-app --json` and `service status --json`, as the CLI prints them.
  @discardableResult
  func cli(_ rel: String, version: String, token: String, installed: Bool) throws -> String {
    try write(rel, """
      #!/bin/sh
      case "$*" in
        "--version") echo "capcomd \(version)" ;;
        "clients pair --app mac-app --json") echo '{"schema":"relay.v1","ok":true,"app":"mac-app","token":"\(token)","version":"\(version)"}' ;;
        "service status --json") echo '{"schema":"relay.v1","ok":true,"installed":\(installed),"loaded":\(installed),"running":true,"port":6420}' ;;
        *) echo "usage" >&2; exit 2 ;;
      esac
      """, executable: true)
    return path(rel)
  }

  /// What the app would find here: the service's launch agent read, the candidates in the app's order, only those
  /// inside this home (a real /opt/homebrew/bin/capcomd on the machine is ignored).
  func find() async -> (path: String, version: String)? {
    let service = FileManager.default.contents(atPath: FirstRun.servicePlist(home: root)).flatMap(FirstRun.serviceCLI(plist:))
    let c = FirstRun.candidates(home: root, environment: [:], service: service).filter { $0.hasPrefix(root) }
    return await FirstRun.firstAnswering(c) { Self.run($0, ["--version"]).flatMap(FirstRun.parseVersion) }
  }

  /// Runs a fake CLI: its stdout when it exits 0.
  static func run(_ exe: String, _ args: [String]) -> String? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    let out = Pipe()
    p.standardOutput = out; p.standardError = FileHandle.nullDevice
    do { try p.run() } catch { return nil }
    let data = out.fileHandleForReading.readDataToEndOfFile()
    p.waitUntilExit()
    return p.terminationStatus == 0 ? String(decoding: data, as: UTF8.self) : nil
  }
}
