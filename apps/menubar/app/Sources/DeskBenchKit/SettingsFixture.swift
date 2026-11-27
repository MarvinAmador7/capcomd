import Foundation
import CapcomdStore

/// The Settings window's daemon for the bench (`settings-*` scenarios): the routes Settings reads, answered from the
/// client mock's `SETTINGS=mixed SANDBOXES=machines` scene (client/mock/settings.ts) as the Accounts and Runs boards
/// draw it: Claude Code logged in on Cloud only, Codex nowhere, Local's agent environment not built, Cloud's ready,
/// Cloud the default, two agents' machines and one left behind on Cloud. Times are relative to now. Read-only: a write
/// (a setting, a delete) is refused.
public final class SettingsFixtureDaemon: DaemonInfoFetching, @unchecked Sendable {
  public static let version = "0.13.0-rc.3"
  public static let capabilities: Set<String> = [
    Capability.runsOptions, "runs.options.repo", "runs.options.sandbox", Capability.runsOptionsModels, Capability.logins,
    Capability.environments, Capability.service, Capability.sandboxes, Capability.sandboxesResources,
  ]
  private let now: Date
  public init(now: Date = Date()) { self.now = now }

  public func capabilities() async throws -> Set<String> { Self.capabilities }
  public func skills() async throws -> [SkillInfo] { [] }
  public func health() async throws -> DaemonHealth { DaemonHealth(version: Self.version, capabilities: Self.capabilities) }
  public func runOptions(repo: String?) async throws -> RunOptions { try JSONDecoder().decode(RunOptions.self, from: Data(Self.runOptionsJSON.utf8)) }
  public func logins() async throws -> [LoginInfo] { try SettingsWire.logins(Data(Self.loginsJSON.utf8)) }
  public func environments() async throws -> [EnvironmentInfo] { try SettingsWire.environments(Data(Self.environmentsJSON.utf8)) }
  public func service() async throws -> ServiceInfo { try SettingsWire.service(Data(Self.serviceJSON.utf8)) }
  public func sandboxes() async throws -> [SandboxDescriptor] { try SandboxWire.sandboxes(Data(Self.sandboxesJSON.utf8)) }
  public func sandbox(_ name: String) async throws -> SandboxDetail {
    guard let json = Self.detailJSON[name] else { throw DetailUnavailable.failed("no such place") }
    return try SandboxWire.detail(Data(json.utf8))
  }
  public func resources(sandbox: String) async throws -> ResourcePage {
    try SandboxWire.resources(Data(resourcesJSON(sandbox).utf8))
  }
  public func resource(sandbox: String, id: String) async throws -> ResourceDetail { throw DetailUnavailable.failed("not in the bench") }
  public func updateSandboxSettings(_ name: String, values: [String: String], rev: String) async throws -> SandboxDetail { throw SettingsRefused.forbidden }
  public func resourceAction(sandbox: String, id: String, action: String, idempotencyKey: String) async throws -> ResourceActionResult {
    throw ActionRefused("The bench doesn't delete machines.", status: 403)
  }

  // MARK: the scene, as the mock answers it

  static let runOptionsJSON = """
  {"drivers":[{"provider":"claude","label":"Claude Code","model":"claude-opus-5-5","efforts":["low","medium","high","xhigh","max"],"effort":null,"available":true,"reason":null,"default":true,
  "models":[{"id":"claude-opus-5-5","name":"Opus 5.5","note":"Most capable"},{"id":"claude-sonnet-5-5","name":"Sonnet 5.5","note":"Fast and capable"}],
  "sandboxes":{"docker":{"available":false,"reason":"Not logged in to Claude Code for Local (run capcomd auth login claude --sandbox docker)"},"boxd":{"available":true,"reason":null}}},
  {"provider":"codex","label":"Codex","model":"gpt-5-codex","efforts":["minimal","low","medium","high"],"effort":"medium","available":false,"reason":"Not logged in to Codex for Cloud (run capcomd auth login codex --sandbox boxd)","default":false,
  "sandboxes":{"docker":{"available":false,"reason":"Not logged in to Codex for Local (run capcomd auth login codex --sandbox docker)"},"boxd":{"available":false,"reason":"Not logged in to Codex for Cloud (run capcomd auth login codex --sandbox boxd)"}}}],
  "sandboxes":[{"name":"docker","label":"Local","available":true,"reason":null,"default":false},{"name":"boxd","label":"Cloud","available":true,"reason":null,"default":true}]}
  """
  static let loginsJSON = """
  {"logins":[{"provider":"claude","sandbox":"docker","loggedIn":false,"how":null,"detail":null,"command":"capcomd auth login claude --sandbox docker","hostBound":false,"boundTo":null},
  {"provider":"claude","sandbox":"boxd","loggedIn":true,"how":"plan","detail":"Logged in with a Claude plan","command":"capcomd auth login claude --sandbox boxd","hostBound":true,"boundTo":"api.anthropic.com"},
  {"provider":"codex","sandbox":"docker","loggedIn":false,"how":null,"detail":null,"command":"capcomd auth login codex --sandbox docker","hostBound":false,"boundTo":null},
  {"provider":"codex","sandbox":"boxd","loggedIn":false,"how":null,"detail":null,"command":"capcomd auth login codex --sandbox boxd","hostBound":false,"boundTo":null}]}
  """
  static let environmentsJSON = """
  {"environments":[{"sandbox":"docker","status":"missing","name":null,"versions":{},"builtAt":null,"command":"capcomd env build --sandbox docker"},
  {"sandbox":"boxd","status":"ready","name":"capcomd-env-boxd-3f2a91","versions":{"claude":"2.1.303","codex":"0.163.0","node":"22.11.0"},"builtAt":"2026-11-24T09:12:03.000Z","command":"capcomd env build --sandbox boxd"}]}
  """
  static let serviceJSON = """
  {"installed":true,"loaded":true,"installCommand":"capcomd service install","uninstallCommand":"capcomd service uninstall"}
  """
  static let descriptors: [String: String] = [
    "docker": """
    {"name":"docker","descriptorVersion":1,"label":"Local","kind":"local","vendor":"Docker","title":"Local · Docker","mark":"docker","listed":true,"caps":{"isolation":"container","snapshots":true,"hostBoundSecrets":false,"egressAllowlist":false,"interactive":true,"idleLifetime":"sweep","shell":true,"costs":false},"settings":["idleLifetime"],"info":["logins","checkpoints"],"resourceKinds":["machine"],"actions":["open_terminal","delete"]
    """,
    "boxd": """
    {"name":"boxd","descriptorVersion":1,"label":"Cloud","kind":"cloud","vendor":"boxd","title":"Cloud · boxd","mark":"boxd","listed":true,"caps":{"isolation":"vm","snapshots":true,"hostBoundSecrets":true,"egressAllowlist":true,"interactive":true,"idleLifetime":"platform","shell":true,"costs":false},"settings":["idleLifetime"],"info":["logins","checkpoints"],"resourceKinds":["machine"],"actions":["open_terminal","delete"]
    """,
  ]
  static var sandboxesJSON: String {
    "{\"sandboxes\":[" + descriptors["docker"]! + ",\"available\":true,\"reason\":null,\"default\":false}," + descriptors["boxd"]! + ",\"available\":true,\"reason\":null,\"default\":true}]}"
  }
  static func settingsJSON(_ help: String) -> String {
    """
    [{"id":"idleLifetime","type":"choice","label":"Delete idle machines after","help":"\(help)","value":"3600","display":"1 hour","default":"3600","choices":[{"value":"900","label":"15 minutes"},{"value":"3600","label":"1 hour"},{"value":"14400","label":"4 hours"},{"value":"43200","label":"12 hours"}],"source":"default","editable":true,"appliesTo":"new_runs","needsRestart":false}]
    """
  }
  static func infoJSON(logins: (String, String, String)) -> String {
    """
    [{"id":"logins","type":"info","label":"Logins","help":"\(logins.0)","value":"\(logins.1)","display":"\(logins.2)"},{"id":"checkpoints","type":"info","label":"Checkpoints","help":"An agent's work is saved as it goes; a stopped or paused agent picks up from its last checkpoint.","value":"600000","display":"After each commit and every 10 minutes"}]
    """
  }
  static let detailJSON: [String: String] = [
    "docker": "{\"descriptor\":" + descriptors["docker"]! + "},\"settings\":" + settingsJSON("A machine left behind (a crash, a stopped run) is deleted after this, within 5 minutes.")
      + ",\"info\":" + infoJSON(logins: ("Kept in the agent environment on this Mac.", "not_bound", "Not bound")) + ",\"rev\":\"r1\"}",
    "boxd": "{\"descriptor\":" + descriptors["boxd"]! + "},\"settings\":" + settingsJSON("A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing.")
      + ",\"info\":" + infoJSON(logins: ("Kept as boxd secrets bound to each AI's API: agents can use them, and they can't be sent anywhere else.", "bound", "Bound")) + ",\"rev\":\"r1\"}",
  ]

  func iso(_ minutesAgo: Double) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: now.addingTimeInterval(-minutesAgo * 60))
  }
  func resourcesJSON(_ sandbox: String) -> String {
    func machine(_ id: String, _ state: String, owner: String, ago: Double) -> String {
      "{\"id\":\"\(id)\",\"kind\":\"machine\",\"state\":\"\(state)\",\"owner\":\(owner),\"createdAt\":\"\(iso(ago))\",\"deleteAfter\":\"\(iso(ago - 70))\",\"cost\":null,\"actions\":[\"open_terminal\"],\"destructive\":false,\"confirm\":null}"
    }
    func agent(_ role: String, _ task: String) -> String {
      "{\"kind\":\"agent\",\"runId\":\"run-8kq2\",\"agentId\":\"agt-\(role)\",\"role\":\"\(role)\",\"task\":\"\(task)\",\"label\":null}"
    }
    let list: [String] = sandbox == "boxd"
      ? [machine("relay-3f9c2a1b7e5d4c60", "running", owner: agent("worker", "add abs to the calculator"), ago: 4),
         machine("relay-77ab0e94c2d81f35", "running", owner: agent("reviewer", "add abs to the calculator"), ago: 1),
         machine("relay-0c11d5e2a9b74f08", "orphaned", owner: "null", ago: 120)]
      : [machine("capcomd-agt-52-7d1e", "running", owner: agent("worker", "Fix the flaky date test"), ago: 12)]
    return "{\"resources\":[" + list.joined(separator: ",") + "],\"asOf\":\"\(iso(0))\",\"stale\":false,\"error\":null,\"next\":null}"
  }
}
