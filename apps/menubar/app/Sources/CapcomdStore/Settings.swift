import Foundation

// The Settings window's data (design/settings/*.dc.html, design/settings-spec.md): the daemon's version, the logins per
// AI × place, each place's agent environment and the background service, plus the mapping from what the daemon says
// (or, on older daemons, what run-options implies) to the rows the window shows. Platform-neutral and tested; the
// views live in MenuBarApp/Settings*.swift.

// MARK: wire

/// `GET /v1/health`: the daemon's version and what it can do beyond the base contract.
public struct DaemonHealth: Sendable, Hashable {
  public var version: String?
  public var capabilities: Set<String>
  public init(version: String? = nil, capabilities: Set<String> = []) { self.version = version; self.capabilities = capabilities }
}

/// `GET /v1/logins` entry (capability `logins`): one AI's login in one place agents run.
public struct LoginInfo: Codable, Sendable, Hashable {
  /// "claude" or "codex".
  public var provider: String
  /// "docker" (Local) or "boxd" (Cloud).
  public var sandbox: String
  public var loggedIn: Bool
  /// "plan" (a subscription login) or "api_key"; nil when not logged in or unknown.
  public var how: String?
  /// The daemon's plain sentence about it, when it has one.
  public var detail: String?
  /// What to run in Terminal to log in there.
  public var command: String
  public init(provider: String, sandbox: String, loggedIn: Bool, how: String? = nil, detail: String? = nil, command: String) {
    self.provider = provider; self.sandbox = sandbox; self.loggedIn = loggedIn; self.how = how; self.detail = detail; self.command = command
  }
}

/// `GET /v1/environments` entry (capability `environments`): the agent environment of one place.
public struct EnvironmentInfo: Codable, Sendable, Hashable {
  public var sandbox: String
  /// "ready", "missing", "building" or "failed".
  public var status: String
  public var name: String?
  /// Tool versions in it: `claude`, `codex`, `node`.
  public var versions: [String: String]?
  /// ISO 8601.
  public var builtAt: String?
  /// What to run in Terminal to build it.
  public var command: String
  public init(sandbox: String, status: String, name: String? = nil, versions: [String: String]? = nil, builtAt: String? = nil, command: String) {
    self.sandbox = sandbox; self.status = status; self.name = name; self.versions = versions; self.builtAt = builtAt; self.command = command
  }
}

/// `GET /v1/service` (capability `service`): capcomd as a background service (launchd).
public struct ServiceInfo: Codable, Sendable, Hashable {
  public var installed: Bool
  public var loaded: Bool
  public var installCommand: String
  public var uninstallCommand: String
  public init(installed: Bool, loaded: Bool, installCommand: String = "capcomd service install", uninstallCommand: String = "capcomd service uninstall") {
    self.installed = installed; self.loaded = loaded; self.installCommand = installCommand; self.uninstallCommand = uninstallCommand
  }
}

/// Decoding of the Settings routes' bodies (shared by the live adapter and the tests).
public enum SettingsWire {
  struct Logins: Decodable { var logins: [LoginInfo] }
  struct Environments: Decodable { var environments: [EnvironmentInfo] }
  public static func logins(_ data: Data) throws -> [LoginInfo] { try JSONDecoder().decode(Logins.self, from: data).logins }
  public static func environments(_ data: Data) throws -> [EnvironmentInfo] { try JSONDecoder().decode(Environments.self, from: data).environments }
  public static func service(_ data: Data) throws -> ServiceInfo { try JSONDecoder().decode(ServiceInfo.self, from: data) }
  /// `{version?, capabilities?}`; a daemon from before capabilities sends none (an empty set).
  public static func health(_ data: Data) -> DaemonHealth {
    let o = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
    return DaemonHealth(version: o?["version"] as? String, capabilities: Set(o?["capabilities"] as? [String] ?? []))
  }
}

// MARK: store

extension CapcomdStore {
  /// Everything the Settings window shows from the daemon, read again every few seconds while it is open (all cheap
  /// routes). A route the daemon doesn't advertise is `.unavailable(.unsupported)`; a failed read keeps the last value
  /// (the window shows it disabled while capcomd can't be reached).
  public func refreshSettings() async {
    guard let daemonInfo else { return }
    do {
      let h = try await daemonInfo.health()
      capabilities = h.capabilities; daemonVersion = h.version
    } catch { changed(); return }
    await refreshRunOptions()
    if let v = await settingsRead(Capability.logins, { try await daemonInfo.logins() }) { logins = v }
    if let v = await settingsRead(Capability.environments, { try await daemonInfo.environments() }) { environments = v }
    if let v = await settingsRead(Capability.service, { try await daemonInfo.service() }) { service = v }
    changed()
  }

  /// nil: keep what was there (the daemon couldn't be reached).
  private func settingsRead<T: Sendable & Hashable>(_ cap: String, _ read: () async throws -> T) async -> Fetched<T>? {
    guard capabilities.contains(cap) else { return .unavailable(.unsupported) }
    do { return .loaded(try await read()) }
    catch is Unauthorized { unauthorized = true; return nil }
    catch let e as DetailUnavailable { return .unavailable(e) }
    catch { return nil }
  }

  // MARK: where and how new runs start (the composer and Settings › Runs share these)

  /// The place new runs go by default: the one last picked (in the composer or in Settings) while the daemon still
  /// lists it, else the daemon's default, else the first. Settings shows this one as "Default", even when it can't
  /// be used right now (its section says why).
  public var defaultPlace: SandboxInfo? {
    let ss = runOptions.sandboxes
    return ss.first { $0.name == prefs.startSandbox } ?? ss.first { $0.isDefault == true } ?? ss.first
  }
  /// Where the composer starts a run: the default place while it can be used, else the daemon's default, else any.
  public var startSandbox: SandboxInfo? {
    let ss = runOptions.sandboxes
    if let d = defaultPlace, d.available { return d }
    return ss.first { $0.isDefault == true && $0.available } ?? ss.first(where: \.available)
  }
  /// Settings › Runs (Runs on, Make Default) and the composer's Local / Cloud switch both land here: one pref.
  public func setDefaultPlace(_ name: String) { prefs.startSandbox = name; changed() }

  /// The drivers as they stand where the composer would start a run.
  public var startDrivers: [DriverInfo] { runOptions.drivers(in: startSandbox?.name) }
  /// The driver new runs go to: the one last picked while the daemon still offers it, else the project's default.
  public var startDriver: DriverInfo? {
    let ds = startDrivers
    return ds.first { $0.provider == prefs.startDriver && $0.available } ?? ds.first { $0.isDefault == true && $0.available } ?? ds.first(where: \.available)
  }
  public func pickDriver(_ provider: String) { prefs.startDriver = provider; changed() }
  /// The driver's reasoning effort for new runs: the one last picked for it while it still offers it, else its default.
  /// nil is "Auto": nothing is sent and the CLI picks (Claude Code has no fixed default; it chooses per model).
  public var startEffort: String? {
    guard let d = startDriver, let levels = d.efforts, !levels.isEmpty else { return nil }
    if let p = prefs.startEffort(d.provider) { return p == UIPreferences.autoEffort ? nil : (levels.contains(p) ? p : d.effort) }
    return d.effort.flatMap { levels.contains($0) ? $0 : nil }
  }
  public func pickEffort(_ effort: String?) {
    guard let d = startDriver else { return }
    prefs.setStartEffort(effort ?? UIPreferences.autoEffort, for: d.provider); changed()
  }

  /// The menu bar mark's face: a raised mitt when an approval waits, open eyes while anything runs, else sleepy. With
  /// bot faces off (Settings › General) it is always the plain mark.
  public var markFace: MarkFace {
    guard prefs.botFaces else { return .plain }
    if badgeCount > 0 { return .approval }
    return runs.values.contains { r in r.agents.values.contains { $0.status == .running } } ? .working : .idle
  }
}

/// What the menu bar mark shows (CapcomdBot's faces; `.plain` is the mark itself, eyes open).
public enum MarkFace: Sendable, Hashable { case plain, idle, working, approval }

// MARK: rows

/// The connection as Settings › General › Status says it.
public enum ConnectionState: Sendable, Hashable {
  case waitingForKeychain
  /// No token yet: the app can't talk to capcomd until one is pasted.
  case noToken
  /// capcomd answered 401 to the saved token.
  case rejected
  /// The daemon feed can't connect; the app keeps retrying.
  case unreachable
  case connected(version: String?)

  public static func of(tokenPending: Bool, tokenMissing: Bool, unauthorized: Bool, unreachable: Bool, version: String?) -> ConnectionState {
    if tokenPending { return .waitingForKeychain }
    if tokenMissing { return .noToken }
    if unauthorized { return .rejected }
    if unreachable { return .unreachable }
    return .connected(version: version)
  }
  /// Rows that come from the daemon can be trusted to be current.
  public var live: Bool { if case .connected = self { return true }; return false }
}

/// One login row: an AI (Claude, Codex) in one place (Cloud, Local).
public struct LoginRow: Sendable, Hashable, Identifiable {
  public enum State: Sendable, Hashable {
    /// Logged in with a subscription.
    case plan
    case apiKey
    /// The daemon says it can run there, but not how it is logged in (older daemons).
    case loggedIn
    case notLoggedIn
    /// Nothing says (an older daemon that answers for its own place only, or not at all).
    case unknown
  }
  public var provider: String
  public var sandbox: String
  public var state: State
  /// The daemon's sentence: the login's detail, or why the driver can't run there.
  public var detail: String?
  public var command: String
  public var id: String { "\(provider):\(sandbox)" }
  public var isLoggedIn: Bool { state == .plan || state == .apiKey || state == .loggedIn }
  /// What a Terminal hand-off waits to see change.
  public var fingerprint: String { "\(state)|\(detail ?? "")" }
}

/// One place's agent environment.
public struct EnvironmentRow: Sendable, Hashable, Identifiable {
  public enum State: Sendable, Hashable { case ready, missing, building, failed, unknown }
  public var sandbox: String
  public var state: State
  /// ("Claude Code", "2.1.303"), ("Codex", "0.163.0"): the agent tools in it, in that order.
  public var versions: [Pair]
  public var builtAt: Date?
  /// Builds it (Build…, Try Again…).
  public var command: String
  public var id: String { sandbox }
  public var fingerprint: String { "\(state)|\(builtAt.map { "\($0.timeIntervalSince1970)" } ?? "")" }
  /// Rebuild… of a ready environment: the build command, forced.
  public var rebuildCommand: String { command.contains("--force") ? command : command + " --force" }
  public struct Pair: Sendable, Hashable { public var tool: String; public var version: String }
}

public enum ServiceState: Sendable, Hashable {
  /// Installed and loaded: launchd starts capcomd at login and restarts it.
  case on
  case off
  /// The daemon can't say (older daemon, or not read yet).
  case unknown
}

/// The boxd API key, as run-options' `boxd` place reports it.
public enum BoxdKeyState: Sendable, Hashable { case saved, notSet, unknown }

/// Maps what the daemon says to Settings rows, falling back to what `run-options` implies on daemons without the
/// Settings routes.
public enum SettingsRows {
  public static let providers = ["claude", "codex"]
  /// Cloud first (Accounts board order), then Local, then any other place the daemon lists.
  public static func accountPlaces(_ options: RunOptions, _ logins: [LoginInfo]?) -> [String] {
    var names = options.sandboxes.map(\.name)
    for l in logins ?? [] where !names.contains(l.sandbox) { names.append(l.sandbox) }
    if names.isEmpty { names = ["boxd", "docker"] }
    return names.enumerated().sorted { a, b in
      let ra = a.element == "boxd" ? 0 : a.element == "docker" ? 1 : 2, rb = b.element == "boxd" ? 0 : b.element == "docker" ? 1 : 2
      return (ra, a.offset) < (rb, b.offset)
    }.map(\.element)
  }

  public static func loginCommand(provider: String, sandbox: String) -> String { "capcomd auth login \(provider) --sandbox \(sandbox)" }
  public static func buildCommand(sandbox: String) -> String { "capcomd env build --sandbox \(sandbox)" }
  public static let boxdKeyCommand = "capcomd setup accounts"
  public static let serviceInstall = "capcomd service install"
  public static let serviceUninstall = "capcomd service uninstall"

  /// Login rows for `places`, one per AI. With `logins` (capability `logins`) from the daemon's ledger; without it,
  /// from run-options: per place when the daemon reports drivers per sandbox (`runs.options.sandbox`), else only for
  /// its own place (the default one), every other place Unknown.
  public static func logins(_ fetched: Fetched<[LoginInfo]>?, options: RunOptions, capabilities: Set<String>, places: [String]) -> [LoginRow] {
    providers.flatMap { provider in
      places.map { place -> LoginRow in
        if let all = fetched?.value {
          guard let l = all.first(where: { $0.provider == provider && $0.sandbox == place }) else {
            return LoginRow(provider: provider, sandbox: place, state: .unknown, detail: nil, command: loginCommand(provider: provider, sandbox: place))
          }
          let state: LoginRow.State = !l.loggedIn ? .notLoggedIn : l.how == "plan" ? .plan : l.how == "api_key" ? .apiKey : .loggedIn
          return LoginRow(provider: provider, sandbox: place, state: state, detail: l.detail, command: l.command)
        }
        return fallbackLogin(provider: provider, place: place, options: options, capabilities: capabilities)
      }
    }
  }

  static func fallbackLogin(provider: String, place: String, options: RunOptions, capabilities: Set<String>) -> LoginRow {
    let command = loginCommand(provider: provider, sandbox: place)
    guard let d = options.drivers.first(where: { $0.provider == provider }) else {
      return LoginRow(provider: provider, sandbox: place, state: .unknown, detail: nil, command: command)
    }
    let own = options.sandboxes.first { $0.isDefault == true }?.name
    let fit: DriverAvailability?
    if let here = d.sandboxes?[place] { fit = here }
    else if place == own { fit = DriverAvailability(available: d.available, reason: d.reason) }
    else { fit = nil }
    guard let fit else { return LoginRow(provider: provider, sandbox: place, state: .unknown, detail: nil, command: command) }
    if fit.available { return LoginRow(provider: provider, sandbox: place, state: .loggedIn, detail: nil, command: command) }
    // The driver can't run there; only a reason about logging in says the login is missing (another reason, such as
    // no agent environment yet, says nothing about the login).
    let r = (fit.reason ?? "").lowercased()
    let aboutLogin = r.contains("logged in") || r.contains("log in") || r.contains("login") || r.contains("auth login")
    return LoginRow(provider: provider, sandbox: place, state: aboutLogin ? .notLoggedIn : .unknown, detail: fit.reason, command: command)
  }

  /// Environment rows for `places` (capability `environments`); nil when the daemon can't say (the rows are hidden).
  public static func environments(_ fetched: Fetched<[EnvironmentInfo]>?, places: [String]) -> [EnvironmentRow]? {
    guard let all = fetched?.value else { return nil }
    return places.map { place in
      guard let e = all.first(where: { $0.sandbox == place }) else {
        return EnvironmentRow(sandbox: place, state: .unknown, versions: [], builtAt: nil, command: buildCommand(sandbox: place))
      }
      let state: EnvironmentRow.State
      switch e.status { case "ready": state = .ready; case "missing": state = .missing; case "building": state = .building; case "failed": state = .failed; default: state = .unknown }
      let tools: [(String, String)] = [("claude", "Claude Code"), ("codex", "Codex")]
      let versions = tools.compactMap { key, name in e.versions?[key].map { EnvironmentRow.Pair(tool: name, version: $0) } }
      return EnvironmentRow(sandbox: place, state: state, versions: versions, builtAt: e.builtAt.flatMap(parseISO), command: e.command)
    }
  }

  public static func service(_ fetched: Fetched<ServiceInfo>?) -> ServiceState {
    guard let s = fetched?.value else { return .unknown }
    return s.installed && s.loaded ? .on : .off
  }

  public static func boxdKey(_ options: RunOptions) -> BoxdKeyState {
    guard let b = options.sandboxes.first(where: { $0.name == "boxd" }) else { return .unknown }
    return b.available ? .saved : .notSet
  }

  /// Commands from the daemon go to a shell (Terminal), so only plain capcomd invocations pass: optional
  /// `CAPCOMD_*=value` assignments (never PATH or anything else that changes what runs), then `capcomd` and words of
  /// letters, digits and `._/=,:@+-`. No quotes, `$`, `;`, `&`, `|`, redirections or backticks, so nothing can be
  /// smuggled into the script.
  public static func isSafeCommand(_ c: String) -> Bool {
    let words = c.split(separator: " ", omittingEmptySubsequences: false)
    guard !words.isEmpty, c.count <= 300 else { return false }
    func word(_ w: Substring) -> Bool { !w.isEmpty && w.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._/=,:@+-".contains($0)) } }
    func assignment(_ w: Substring) -> Bool {
      guard w.hasPrefix("CAPCOMD_"), let eq = w.firstIndex(of: "=") else { return false }
      let name = w[..<eq], value = w[w.index(after: eq)...]
      return name.allSatisfy { $0.isASCII && ($0.isUppercase || $0.isNumber || $0 == "_") } && word(value)
    }
    var i = 0
    while i < words.count, assignment(words[i]) { i += 1 }
    guard i < words.count, words[i] == "capcomd" else { return false }
    return words[(i + 1)...].allSatisfy(word)
  }

  /// "2026-10-24T09:12:03.000Z", with or without fractional seconds.
  public static func parseISO(_ s: String) -> Date? {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = f.date(from: s) { return d }
    f.formatOptions = [.withInternetDateTime]
    return f.date(from: s)
  }
}

// MARK: Terminal hand-offs

/// Things the user finishes in Terminal (log in, build an environment, install the service): the row says "Waiting
/// for Terminal…" until what it shows changes, the script says it finished, Terminal is quit after it had opened, or
/// `timeout` passes.
public struct HandOffs: Sendable, Hashable {
  public struct Entry: Sendable, Hashable {
    public var command: String
    public var baseline: String
    public var startedAt: Date
    var sawTerminal = false
  }
  public static let timeout: TimeInterval = 600
  public private(set) var open: [String: Entry] = [:]
  public init() {}

  public mutating func start(_ key: String, command: String, baseline: String, at now: Date = Date()) {
    open[key] = Entry(command: command, baseline: baseline, startedAt: now)
  }
  public func waiting(_ key: String) -> Entry? { open[key] }
  public mutating func cancel(_ key: String) { open[key] = nil }

  /// Ends the hand-offs whose row changed (`current`: key → fingerprint now), whose script finished (`finished`), whose
  /// Terminal went away, or that waited too long. A key missing from `current` is left alone (its row isn't known yet).
  public mutating func settle(current: [String: String], finished: Set<String> = [], terminalRunning: Bool, now: Date = Date()) {
    for (key, var e) in open {
      if let fp = current[key], fp != e.baseline { open[key] = nil; continue }
      if finished.contains(key) { open[key] = nil; continue }
      if now.timeIntervalSince(e.startedAt) > Self.timeout { open[key] = nil; continue }
      if terminalRunning { e.sawTerminal = true; open[key] = e }
      else if e.sawTerminal { open[key] = nil }
    }
  }
}

// MARK: window size

/// The Settings window fitted to its pane (MenuBarApp's SettingsWindow.fit), in screen coordinates (y up).
public enum WindowFit {
  /// `frame` resized to `height` with its top edge kept, then kept inside `visible` (the screen's visible frame: no menu
  /// bar, no Dock) by moving it, never by resizing it further, unless it is taller than all of `visible`.
  public static func fitted(_ frame: CGRect, height: CGFloat, visible: CGRect?) -> CGRect {
    // Foundation-only (the store builds on Linux): origin and size, not CoreGraphics' minY / maxY helpers.
    let top = frame.origin.y + frame.size.height
    var f = frame
    f.size.height = height
    f.origin.y = top - height
    guard let v = visible else { return f }
    let vTop = v.origin.y + v.size.height
    f.size.height = min(f.size.height, v.size.height)
    if f.origin.y < v.origin.y { f.origin.y = v.origin.y }                          // would run under the Dock: move up
    if f.origin.y + f.size.height > vTop { f.origin.y = vTop - f.size.height }      // would run under the menu bar: move down
    return f
  }
}
