import Foundation

// The app's first run without a terminal (CapcomdUI/AppSession.swift does the work): find the capcomd CLI (the one the
// login service runs, when there is one), pair with it (`capcomd clients pair --app mac-app --json`), start the daemon
// as a login service (`capcomd service install --json`) when nothing runs it yet, and say when the app and the daemon
// are far enough apart in version to matter. The pure parts live here.

public enum FirstRun {
  /// The name the app pairs as (`capcomd clients list` shows it; a new pairing revokes the previous one).
  public static let appName = "mac-app"
  public static let pairArguments = ["clients", "pair", "--app", appName, "--json"]
  public static let serviceArguments = ["service", "install", "--json"]
  /// The login service, started now and at every login, or now only (`--no-login`, capcomd 0.10 and later).
  public static func serviceArguments(atLogin: Bool) -> [String] { atLogin ? serviceArguments : serviceArguments + ["--no-login"] }
  public static let serviceStatusArguments = ["service", "status", "--json"]
  /// `capcomd service status --json`: whether the login service is installed (nil: not an answer).
  public static func parseServiceInstalled(_ out: String) -> Bool? {
    guard let d = out.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else { return nil }
    return o["installed"] as? Bool
  }
  /// What to tell someone without the CLI. The app's cask doesn't install it (people often have it already, from
  /// install.sh, Bun or npm), so the app says this when it finds none; the cask's caveats say the same
  /// (scripts/homebrew-cask.ts).
  public static let installCommand = "brew install MarvinAmador7/tap/capcomd"
  /// How the window says to update the CLI, however it was installed (`capcomd upgrade` names brew's or Bun's command
  /// when one of those installed it).
  public static let upgradeCommand = "capcomd upgrade"
  /// The paste fallback's command: the same pairing, printed for a person to copy.
  public static let pairCommand = "capcomd clients pair --app \(appName)"

  /// Where a GUI app looks for `capcomd`, in order. Apps don't get the login shell's PATH, so these are the usual
  /// install places: `CAPCOMD_CLI` (an explicit path), Homebrew (Apple silicon, Intel), install.sh's ~/.capcomd/bin, Bun's
  /// and npm's global bins, ~/.local/bin. A login shell is asked after these (AppSession).
  ///
  /// `service`: the capcomd the login service runs (`serviceCLI`). It comes right after `CAPCOMD_CLI`: first the usual
  /// places that are that same file (an install's bin is a link to it: Bun's ~/.bun/bin/capcomd to the package's entry,
  /// Homebrew's bin to its keg), then its own path. So with two CLIs installed, the app pairs with, starts and restarts
  /// the daemon through the one that runs it, never splitting from it. `resolve` follows links (`realPath`).
  public static func candidates(home: String, environment env: [String: String], service: String? = nil,
                                resolve: (String) -> String = realPath) -> [String] {
    var usual = ["/opt/homebrew/bin/capcomd", "/usr/local/bin/capcomd"]
    let h = home.hasSuffix("/") ? String(home.dropLast()) : home
    if let d = env["CAPCOMD_INSTALL_DIR"], !d.isEmpty { usual.append("\(d)/capcomd") }
    usual += ["\(h)/.capcomd/bin/capcomd", "\(h)/.bun/bin/capcomd"]
    if let p = env["NPM_CONFIG_PREFIX"] ?? env["npm_config_prefix"], !p.isEmpty { usual.append("\(p)/bin/capcomd") }
    usual += ["\(h)/.npm-global/bin/capcomd", "\(h)/.local/bin/capcomd"]
    if let service, !service.isEmpty {
      let target = resolve(service)
      let same = usual.filter { resolve($0) == target }
      usual = same + [service] + usual.filter { resolve($0) != target }
    }
    var out: [String] = []
    if let p = env["CAPCOMD_CLI"], !p.isEmpty { out.append(p) }
    out += usual
    var seen = Set<String>()
    return out.filter { seen.insert($0).inserted }
  }

  /// The first of `candidates` that can run and says it's capcomd (`version`: its `--version`, parsed), with that
  /// version. AppSession runs each; the tests run fake CLIs.
  public static func firstAnswering(_ candidates: [String], isExecutable: (String) -> Bool = { FileManager.default.isExecutableFile(atPath: $0) },
                                    version: (String) async -> String?) async -> (path: String, version: String)? {
    for p in candidates where isExecutable(p) {
      if let v = await version(p) { return (p, v) }
    }
    return nil
  }

  /// A path with its links followed (itself when it doesn't exist).
  public static func realPath(_ path: String) -> String {
    guard let r = realpath(path, nil) else { return path }
    defer { free(r) }
    return String(cString: r)
  }

  // MARK: The login service

  /// The login service's launchd agent (`capcomd service install`, src/cli/commands/service.ts), read only.
  public static let serviceLabel = "dev.capcomd.engine"
  public static func servicePlist(home: String) -> String {
    let h = home.hasSuffix("/") ? String(home.dropLast()) : home
    return "\(h)/Library/LaunchAgents/\(serviceLabel).plist"
  }

  /// The capcomd the login service runs, from its agent's ProgramArguments: `<capcomd> serve …` for the single
  /// executable (install.sh, Homebrew), `<bun> <capcomd's entry> serve …` for Bun and npm installs; either way the
  /// argument before `serve`. Nil: not a plist, or not a capcomd service.
  public static func serviceCLI(plist: Data) -> String? {
    guard let o = (try? PropertyListSerialization.propertyList(from: plist, format: nil)) as? [String: Any],
          let argv = o["ProgramArguments"] as? [String], let i = argv.firstIndex(of: "serve"), i > 0, !argv[i - 1].isEmpty else { return nil }
    return argv[i - 1]
  }

  /// The PATH the CLI runs with: its own folder first (an npm install is a `#!/usr/bin/env bun` script), then the
  /// places Bun, git and Homebrew live, then what the app was given.
  public static func childPath(cli: String, home: String, inherited: String?) -> String {
    let dir = (cli as NSString).deletingLastPathComponent
    let h = home.hasSuffix("/") ? String(home.dropLast()) : home
    var parts = [dir, "\(h)/.bun/bin", "/opt/homebrew/bin", "/usr/local/bin"]
    parts += (inherited ?? "/usr/bin:/bin:/usr/sbin:/sbin").split(separator: ":").map(String.init)
    var seen = Set<String>()
    return parts.filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: ":")
  }

  /// `capcomd --version` → "0.9.0".
  public static func parseVersion(_ out: String) -> String? {
    let w = out.trimmingCharacters(in: .whitespacesAndNewlines).split(separator: " ")
    guard w.count == 2, w[0] == "capcomd", SemVer(String(w[1])) != nil else { return nil }
    return String(w[1])
  }

  public struct Paired: Equatable, Sendable { public var token: String; public var version: String? }
  /// `capcomd clients pair --json`'s object: its token (and the CLI's version). Nil: not a pairing.
  public static func parsePair(_ out: String) -> Paired? {
    guard let d = out.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any],
          o["ok"] as? Bool == true, let t = o["token"] as? String, t.hasPrefix("cch_") else { return nil }
    return Paired(token: t, version: o["version"] as? String)
  }

  /// `capcomd service install --json`: whether the engine answered, else the log to look at.
  public enum Service: Equatable, Sendable { case running, notAnswering(log: String?), failed(String) }
  public static func parseService(_ out: String, exitCode: Int32) -> Service {
    guard let d = out.data(using: .utf8), let o = (try? JSONSerialization.jsonObject(with: d)) as? [String: Any] else {
      return .failed(exitCode == 0 ? "capcomd said nothing" : "capcomd exited with \(exitCode)")
    }
    if o["ok"] as? Bool == false {
      let e = o["error"] as? [String: Any]
      return .failed((e?["message"] as? String).map(firstLine) ?? "capcomd exited with \(exitCode)")
    }
    return o["running"] as? Bool == true ? .running : .notAnswering(log: o["log"] as? String)
  }

  /// A CLI error's first line, short enough for the window.
  public static func firstLine(_ s: String) -> String {
    let l = s.split(whereSeparator: \.isNewline).first.map(String.init) ?? ""
    return l.count > 160 ? String(l.prefix(159)) + "…" : l
  }
}

/// X.Y.Z[-pre], compared by its numbers.
public struct SemVer: Comparable, Sendable, Hashable {
  public var major: Int, minor: Int, patch: Int
  public init?(_ s: String) {
    let core = s.hasPrefix("v") ? s.dropFirst() : Substring(s)
    let n = core.split(separator: "-", maxSplits: 1)[0].split(separator: ".").map { Int($0) }
    guard n.count == 3, let a = n[0], let b = n[1], let c = n[2] else { return nil }
    major = a; minor = b; patch = c
  }
  public static func < (l: SemVer, r: SemVer) -> Bool { (l.major, l.minor, l.patch) < (r.major, r.minor, r.patch) }
  /// The part of the version that changes what the app and the daemon say to each other: while capcomd is 0.x, a minor
  /// release can add or change routes (SemVer's 0.x rule, as capcomd releases), so major and minor.
  var line: [Int] { [major, minor] }
}

/// The app and the daemon it talks to, in versions that matter (a different minor while 0.x); nil: fine, or unknown.
public enum VersionSkew: Equatable, Sendable {
  /// The daemon is older: restart it when the CLI is already newer (a `brew upgrade` left the old one running), else
  /// update the CLI.
  case daemonOlder(app: String, daemon: String, restartFixes: Bool)
  /// The app is older than the daemon: update the app.
  case appOlder(app: String, daemon: String)

  public static func of(app: String?, daemon: String?, cli: String? = nil) -> VersionSkew? {
    guard let app, let daemon, let a = SemVer(app), let d = SemVer(daemon), a.line != d.line else { return nil }
    if d < a { return .daemonOlder(app: app, daemon: daemon, restartFixes: cli.flatMap(SemVer.init).map { $0.line == a.line } ?? false) }
    return .appOlder(app: app, daemon: daemon)
  }

  /// The line the window and the menu bar show.
  public var message: String {
    switch self {
    case .daemonOlder(let a, let d, let restart):
      return restart ? "capcomd \(d) is still running. Restart it to use \(a) with this app."
                     : "This app is \(a), capcomd is \(d). Update capcomd: \(FirstRun.upgradeCommand)"
    case .appOlder(let a, let d):
      return "capcomd is \(d), this app is \(a). Update the app: brew upgrade capcomd-app"
    }
  }
}
