#if canImport(SwiftUI) && os(macOS)
import Foundation
import Observation
import CapcomdStore

/// What the app needs before it can show anything, shared by the window and the menu bar item: the daemon token, the
/// capcomd CLI that makes one, and starting the daemon. From a fresh install it gets there by itself: the Keychain's
/// token if there is one, else it finds the CLI and pairs (`capcomd clients pair --app mac-app`), saving the token in
/// the Keychain. Each surface keeps its own store and connects whenever a token arrives (`onToken`).
@Observable @MainActor
package final class AppSession {
  package enum Token: Equatable {
    /// Reading the Keychain (macOS may be asking whether this build can use the token).
    case reading
    /// Running `capcomd clients pair`.
    case pairing
    /// No token, and no capcomd CLI to make one.
    case needsCLI
    /// Pairing didn't work: why, in a line.
    case failed(String)
    /// The daemon refused the token the app has.
    case rejected
    case ready(String)
  }
  package enum Start: Equatable { case idle, starting, started, failed(String) }

  package private(set) var token: Token = .reading
  /// The token came from `CAPCOMD_TOKEN` (development): nothing is saved or paired.
  package private(set) var tokenFromEnvironment = false
  /// The capcomd CLI the app runs, once found, and its version.
  package private(set) var cli: String?
  package private(set) var cliVersion: String?
  package private(set) var lookingForCLI = false
  /// Starting the daemon as a login service (`capcomd service install`).
  package private(set) var start: Start = .idle

  @ObservationIgnored private var listeners: [@MainActor (String) -> Void] = []
  @ObservationIgnored private var located = false

  package init() {}

  package var current: String? { if case .ready(let t) = token { return t }; return nil }

  /// `f` gets every token the app connects with: the current one at once, then each new one.
  package func onToken(_ f: @escaping @MainActor (String) -> Void) {
    listeners.append(f)
    if let t = current { f(t) }
  }

  private func use(_ t: String) {
    token = .ready(t)
    for f in listeners { f(t) }
  }

  /// Launch: `CAPCOMD_TOKEN`, else the Keychain (read off the main thread: macOS can hold it on its prompt), else pair.
  package func begin() {
    if let env = ProcessInfo.processInfo.environment["CAPCOMD_TOKEN"], !env.isEmpty {
      tokenFromEnvironment = true; use(env); return
    }
    Task.detached(priority: .userInitiated) {
      let saved = Keychain.token()
      await MainActor.run { [weak self] in
        guard let self else { return }
        if let saved, !saved.isEmpty { self.use(saved) } else { self.pair() }
      }
    }
    Task { _ = await locate() }   // for Start capcomd and the version check, whatever the token
  }

  /// Makes this app a token with the CLI and keeps it (Connect, or a first launch without one).
  package func pair() {
    if token == .pairing { return }
    token = .pairing
    Task {
      guard let cli = await locate(again: true) else { token = .needsCLI; return }
      guard let r = await CLIRunner.run(cli, FirstRun.pairArguments) else { token = .failed("capcomd didn't answer."); return }
      // Exit 2 is a usage error: a capcomd from before `clients pair` (0.9 and older).
      if r.code == 2 { token = .failed("This capcomd\(cliVersion.map { " (\($0))" } ?? "") can't connect apps by itself. Update it: brew upgrade capcomd"); return }
      guard r.code == 0, let p = FirstRun.parsePair(r.out) else { token = .failed(Self.why(r)); return }
      if let v = p.version { cliVersion = v }
      guard Keychain.save(p.token) else { token = .failed("Couldn't save the token to the Keychain."); return }
      tokenFromEnvironment = false
      use(p.token)
    }
  }

  /// A pasted token (the fallback): saved, then every surface reconnects with it.
  package func submit(pasted raw: String) -> Bool {
    let t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !t.isEmpty, Keychain.save(t) else { return false }
    tokenFromEnvironment = false
    use(t)
    return true
  }

  /// A surface's store got a 401 for `t`. Another copy of the app may have paired since (the Keychain item is shared):
  /// read it once more before asking.
  @ObservationIgnored private var recheckingFor: String?
  package func rejected(_ t: String) {
    guard current == t, recheckingFor != t else { return }
    if tokenFromEnvironment { token = .rejected; return }
    recheckingFor = t
    Task.detached(priority: .userInitiated) {
      let saved = Keychain.token()
      await MainActor.run { [weak self] in
        guard let self, self.current == t else { return }
        self.recheckingFor = nil
        if let saved, !saved.isEmpty, saved != t { self.use(saved) } else { self.token = .rejected }
      }
    }
  }

  /// Finds the CLI: the usual install places, then a login shell's PATH. `again`: look even if it was found missing.
  @discardableResult
  package func locate(again: Bool = false) async -> String? {
    if let cli, FileManager.default.isExecutableFile(atPath: cli) { return cli }
    if located && !again { return nil }
    lookingForCLI = true
    defer { lookingForCLI = false; located = true }
    let found = await CLIRunner.find()
    cli = found?.path; cliVersion = found?.version ?? cliVersion
    return cli
  }

  /// Check Again (no CLI): look again, and pair if there's still no token.
  package func recheck() {
    Task {
      _ = await locate(again: true)
      if current == nil { pair() }
    }
  }

  /// Start capcomd: install the login service (it starts now and at every login); the stores reconnect by themselves.
  package func startDaemon() {
    if start == .starting { return }
    start = .starting
    Task {
      guard let cli = await locate(again: true) else { start = .failed("Install the capcomd CLI first: \(FirstRun.installCommand)"); return }
      // `service install` waits up to 20 s for the engine to answer.
      guard let r = await CLIRunner.run(cli, FirstRun.serviceArguments, timeout: 60) else { start = .failed("capcomd didn't answer."); return }
      switch FirstRun.parseService(r.out, exitCode: r.code) {
      case .running: start = .started
      case .notAnswering(let log): start = .failed("capcomd didn't start yet." + (log.map { " Its log: \($0)" } ?? ""))
      case .failed(let m): start = .failed(m)
      }
      if let v = await CLIRunner.version(cli) { cliVersion = v }
    }
  }

  /// A surface reached the daemon: a finished start has done its job.
  package func reachable() { if start != .idle && start != .starting { start = .idle } }

  /// How far apart the app and the daemon it reached are, when it matters.
  package func skew(daemon: String?) -> VersionSkew? { VersionSkew.of(app: AppInfo.bundleVersion, daemon: daemon, cli: cliVersion) }

  private static func why(_ r: CLIRunner.Result) -> String {
    if let d = r.out.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
       let m = (o["error"] as? [String: Any])?["message"] as? String { return FirstRun.firstLine(m) }
    let e = FirstRun.firstLine(r.err)
    return e.isEmpty ? "capcomd exited with \(r.code)." : e
  }
}

/// The app's version: its bundle's (nil for a `swift run` build, which has none), and what About shows.
package enum AppInfo {
  package static var bundleVersion: String? { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String }
  package static var version: String { bundleVersion ?? "dev" }
  package static let repo = URL(string: "https://github.com/MarvinAmador7/capcomd")!
  package static let changelog = URL(string: "https://github.com/MarvinAmador7/capcomd/blob/main/CHANGELOG.md")!
  package static let newIssue = URL(string: "https://github.com/MarvinAmador7/capcomd/issues/new")!
}

/// Runs the capcomd CLI as the local user, off the main thread, with a PATH that finds Bun and git.
package enum CLIRunner {
  package struct Result: Sendable { package var code: Int32; package var out: String; package var err: String }

  /// `exe args`, or nil when it can't start or runs past `timeout` (then it's terminated).
  package static func run(_ exe: String, _ args: [String], timeout: TimeInterval = 30) async -> Result? {
    await withCheckedContinuation { c in
      DispatchQueue.global(qos: .userInitiated).async { c.resume(returning: runNow(exe, args, timeout: timeout)) }
    }
  }

  /// The first candidate that runs and says it's capcomd, else the one a login shell finds.
  package static func find() async -> (path: String, version: String)? {
    let env = ProcessInfo.processInfo.environment
    for p in FirstRun.candidates(home: NSHomeDirectory(), environment: env) where FileManager.default.isExecutableFile(atPath: p) {
      if let v = await version(p) { return (p, v) }
    }
    let shell = env["SHELL"].flatMap { $0.hasPrefix("/") ? $0 : nil } ?? "/bin/zsh"
    guard let r = await run(shell, ["-l", "-i", "-c", "command -v capcomd"], timeout: 8), r.code == 0 else { return nil }
    let path = r.out.split(whereSeparator: \.isNewline).map { $0.trimmingCharacters(in: .whitespaces) }
      .last { $0.hasPrefix("/") && $0.hasSuffix("/capcomd") }
    guard let path, FileManager.default.isExecutableFile(atPath: path), let v = await version(path) else { return nil }
    return (path, v)
  }

  package static func version(_ exe: String) async -> String? {
    guard let r = await run(exe, ["--version"], timeout: 15), r.code == 0 else { return nil }
    return FirstRun.parseVersion(r.out)
  }

  private final class Buffer: @unchecked Sendable { var data = Data() }

  private static func runNow(_ exe: String, _ args: [String], timeout: TimeInterval) -> Result? {
    let p = Process()
    p.executableURL = URL(fileURLWithPath: exe)
    p.arguments = args
    var env = ProcessInfo.processInfo.environment
    env["PATH"] = FirstRun.childPath(cli: exe, home: NSHomeDirectory(), inherited: env["PATH"])
    env["NO_COLOR"] = "1"
    env.removeValue(forKey: "CAPCOMD_TOKEN")
    p.environment = env
    p.currentDirectoryURL = URL(fileURLWithPath: NSHomeDirectory())
    let out = Pipe(), err = Pipe()
    p.standardOutput = out; p.standardError = err; p.standardInput = FileHandle.nullDevice
    let exited = DispatchSemaphore(value: 0)
    p.terminationHandler = { _ in exited.signal() }
    do { try p.run() } catch { return nil }
    // Both pipes drain while it runs, so a chatty command can't fill one and stall.
    let o = Buffer(), e = Buffer(), drained = DispatchGroup()
    for (pipe, buf) in [(out, o), (err, e)] {
      drained.enter()
      DispatchQueue.global(qos: .userInitiated).async { buf.data = pipe.fileHandleForReading.readDataToEndOfFile(); drained.leave() }
    }
    if exited.wait(timeout: .now() + timeout) == .timedOut {
      p.terminate()
      if exited.wait(timeout: .now() + 2) == .timedOut { kill(p.processIdentifier, SIGKILL) }
      return nil
    }
    _ = drained.wait(timeout: .now() + 2)
    return Result(code: p.terminationStatus, out: String(decoding: o.data, as: UTF8.self), err: String(decoding: e.data, as: UTF8.self))
  }
}
#endif
