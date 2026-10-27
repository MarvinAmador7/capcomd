import Foundation

// Place details (ADR-021 phase 1; design/settings/CloudExplore.dc.html, design/settings-spec.md §4.1): each place agents
// run as the daemon describes it (`GET /v1/sandboxes`, `/v1/sandboxes/{name}`), its machines
// (`…/resources`, `…/resources/{id}` with the command that opens a shell in one), and the mapping from that data to the
// rows Settings shows. Nothing here names a provider: what a place is and can do comes from its descriptor.

// MARK: wire

/// A JSON scalar as a field's value or default: `"3600"`, `true`, `3600`, or null. Objects and arrays read as null.
public enum FieldValue: Decodable, Sendable, Hashable {
  case string(String), bool(Bool), number(Double), null
  public init(from decoder: Decoder) throws {
    let c = try decoder.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else { self = .null }
  }
  /// As text, for matching a choice: "3600" for both `"3600"` and `3600`.
  public var text: String? {
    switch self {
    case .string(let s): s
    case .bool(let b): b ? "true" : "false"
    case .number(let n): n.rounded() == n && abs(n) < 1e15 ? String(Int64(n)) : String(n)
    case .null: nil
    }
  }
  public var bool: Bool? {
    switch self { case .bool(let b): b; case .string(let s): s == "true" ? true : s == "false" ? false : nil; default: nil }
  }
}

/// One row the daemon describes (ADR-021 §2): a setting (`choice`, `toggle`) or a read-only `info` / `status` row. The
/// set of types is closed, but an app meets newer ones: anything else shows `label` and `display`, read-only.
public struct SandboxField: Decodable, Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable { case choice, toggle, info, status, other(String) }
  public struct Choice: Decodable, Sendable, Hashable {
    public var value: String; public var label: String
    enum CodingKeys: String, CodingKey { case value, label }
    public init(value: String, label: String) { self.value = value; self.label = label }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      value = (try c.decodeIfPresent(FieldValue.self, forKey: .value))?.text ?? ""
      label = try c.decodeIfPresent(String.self, forKey: .label) ?? value
    }
  }
  public var id: String
  public var type: String
  public var label: String
  public var help: String?
  public var value: FieldValue
  /// The daemon's text for the value ("1 hour", "Set by CAPCOMD_SANDBOX_IDLE_SECONDS in capcomd's environment").
  public var display: String?
  public var defaultValue: FieldValue
  public var choices: [Choice]
  /// "default", "config" or "env".
  public var source: String?
  public var editable: Bool
  public var appliesTo: String?
  public var needsRestart: Bool
  /// A `status` row's state ("ok", "warn", "bad", "none"): its dot. Absent: no dot.
  public var state: String?

  enum CodingKeys: String, CodingKey { case id, type, label, help, value, display, defaultValue = "default", choices, source, editable, appliesTo, needsRestart, state }
  public init(id: String, type: String, label: String, help: String? = nil, value: FieldValue = .null, display: String? = nil, defaultValue: FieldValue = .null,
              choices: [Choice] = [], source: String? = nil, editable: Bool = false, appliesTo: String? = nil, needsRestart: Bool = false, state: String? = nil) {
    self.id = id; self.type = type; self.label = label; self.help = help; self.value = value; self.display = display; self.defaultValue = defaultValue
    self.choices = choices; self.source = source; self.editable = editable; self.appliesTo = appliesTo; self.needsRestart = needsRestart; self.state = state
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    type = try c.decodeIfPresent(String.self, forKey: .type) ?? "info"
    label = try c.decodeIfPresent(String.self, forKey: .label) ?? id
    help = try? c.decodeIfPresent(String.self, forKey: .help)
    value = (try? c.decodeIfPresent(FieldValue.self, forKey: .value)) ?? .null
    display = try? c.decodeIfPresent(String.self, forKey: .display)
    defaultValue = (try? c.decodeIfPresent(FieldValue.self, forKey: .defaultValue)) ?? .null
    choices = (try? c.decodeIfPresent(Lossy<Choice>.self, forKey: .choices))?.items ?? []
    source = try? c.decodeIfPresent(String.self, forKey: .source)
    editable = (try? c.decodeIfPresent(Bool.self, forKey: .editable)) ?? false
    appliesTo = try? c.decodeIfPresent(String.self, forKey: .appliesTo)
    needsRestart = (try? c.decodeIfPresent(Bool.self, forKey: .needsRestart)) ?? false
    state = try? c.decodeIfPresent(String.self, forKey: .state)
  }

  public var kind: Kind {
    switch type { case "choice": .choice; case "toggle": .toggle; case "info": .info; case "status": .status; default: .other(type) }
  }
  /// What the row says: the daemon's `display`, else the picked choice's label, else the value itself.
  public var shown: String {
    if let display, !display.isEmpty { return display }
    if let v = value.text, let c = choices.first(where: { $0.value == v }) { return c.label }
    if let b = value.bool, kind == .toggle { return b ? "On" : "Off" }
    return value.text ?? ""
  }
  /// The value is set in capcomd's environment, so the app can't change it (the row shows `display`).
  public var fromEnvironment: Bool { source == "env" }
}

/// A provider's capabilities as clients see them (ADR-021 §1). Unknown caps are ignored.
public struct SandboxCaps: Decodable, Sendable, Hashable {
  /// "container" or "vm".
  public var isolation: String?
  public var snapshots: Bool?
  /// Logins can be kept as secrets bound to their AI's API host.
  public var hostBoundSecrets: Bool?
  public var egressAllowlist: Bool?
  public var interactive: Bool?
  /// "platform" (the provider deletes idle machines), "sweep" (capcomd does) or "none".
  public var idleLifetime: String?
  /// A person can open an interactive shell in a live machine.
  public var shell: Bool?
  public init(isolation: String? = nil, snapshots: Bool? = nil, hostBoundSecrets: Bool? = nil, egressAllowlist: Bool? = nil, interactive: Bool? = nil,
              idleLifetime: String? = nil, shell: Bool? = nil) {
    self.isolation = isolation; self.snapshots = snapshots; self.hostBoundSecrets = hostBoundSecrets; self.egressAllowlist = egressAllowlist
    self.interactive = interactive; self.idleLifetime = idleLifetime; self.shell = shell
  }
}

/// A place agents run, as the daemon describes it (`GET /v1/sandboxes` entries; `descriptor` of `/v1/sandboxes/{name}`).
public struct SandboxDescriptor: Decodable, Sendable, Hashable, Identifiable {
  public enum Kind: Sendable, Hashable { case local, cloud }
  public var name: String
  public var descriptorVersion: Int?
  /// "Local", "Cloud".
  public var label: String
  /// "local" or "cloud"; anything else reads as cloud.
  public var kindName: String?
  /// What the title says after the dot: "Docker", "boxd".
  public var vendor: String?
  /// "Cloud · boxd".
  public var title: String?
  /// A bundled mark's id; unknown ids fall back to a glyph by kind.
  public var mark: String?
  public var listed: Bool?
  public var caps: SandboxCaps
  public var settings: [String]
  public var info: [String]
  public var resourceKinds: [String]
  public var actions: [String]
  /// From the list route: whether it can be used now, why not, and whether it is the daemon's default.
  public var available: Bool?
  public var reason: String?
  public var isDefault: Bool?
  public var id: String { name }

  enum CodingKeys: String, CodingKey {
    case name, descriptorVersion, label, kindName = "kind", vendor, title, mark, listed, caps, settings, info, resourceKinds, actions, available, reason, isDefault = "default"
  }
  public init(name: String, label: String, kind: String? = "cloud", vendor: String? = nil, title: String? = nil, mark: String? = nil, caps: SandboxCaps = SandboxCaps(),
              settings: [String] = [], info: [String] = [], resourceKinds: [String] = [], actions: [String] = [], available: Bool? = nil, reason: String? = nil,
              isDefault: Bool? = nil, descriptorVersion: Int? = 1, listed: Bool? = true) {
    self.name = name; self.label = label; self.kindName = kind; self.vendor = vendor; self.title = title; self.mark = mark; self.caps = caps
    self.settings = settings; self.info = info; self.resourceKinds = resourceKinds; self.actions = actions; self.available = available; self.reason = reason
    self.isDefault = isDefault; self.descriptorVersion = descriptorVersion; self.listed = listed
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    name = try c.decode(String.self, forKey: .name)
    descriptorVersion = try? c.decodeIfPresent(Int.self, forKey: .descriptorVersion)
    label = (try? c.decodeIfPresent(String.self, forKey: .label)) ?? name
    kindName = try? c.decodeIfPresent(String.self, forKey: .kindName)
    vendor = try? c.decodeIfPresent(String.self, forKey: .vendor)
    title = try? c.decodeIfPresent(String.self, forKey: .title)
    mark = try? c.decodeIfPresent(String.self, forKey: .mark)
    listed = try? c.decodeIfPresent(Bool.self, forKey: .listed)
    caps = (try? c.decodeIfPresent(SandboxCaps.self, forKey: .caps)) ?? SandboxCaps()
    settings = (try? c.decodeIfPresent([String].self, forKey: .settings)) ?? []
    info = (try? c.decodeIfPresent([String].self, forKey: .info)) ?? []
    resourceKinds = (try? c.decodeIfPresent([String].self, forKey: .resourceKinds)) ?? []
    actions = (try? c.decodeIfPresent([String].self, forKey: .actions)) ?? []
    available = try? c.decodeIfPresent(Bool.self, forKey: .available)
    reason = try? c.decodeIfPresent(String.self, forKey: .reason)
    isDefault = try? c.decodeIfPresent(Bool.self, forKey: .isDefault)
  }

  public var kind: Kind { kindName == "local" ? .local : .cloud }
  public var vendorName: String { vendor ?? name }
  /// The section header and the details title: "Cloud · boxd".
  public var displayTitle: String { title ?? "\(label) · \(vendorName)" }
}

/// `GET /v1/sandboxes/{name}`: the descriptor, its settings and its info rows.
public struct SandboxDetail: Decodable, Sendable, Hashable {
  public var descriptor: SandboxDescriptor
  public var settings: [SandboxField]
  public var info: [SandboxField]
  /// Settings revision (for PATCH, phase 2); a string or a number on the wire.
  public var rev: String?
  enum CodingKeys: String, CodingKey { case descriptor, settings, info, rev }
  public init(descriptor: SandboxDescriptor, settings: [SandboxField] = [], info: [SandboxField] = [], rev: String? = nil) {
    self.descriptor = descriptor; self.settings = settings; self.info = info; self.rev = rev
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    descriptor = try c.decode(SandboxDescriptor.self, forKey: .descriptor)
    settings = (try? c.decodeIfPresent(Lossy<SandboxField>.self, forKey: .settings))?.items ?? []
    info = (try? c.decodeIfPresent(Lossy<SandboxField>.self, forKey: .info))?.items ?? []
    rev = (try? c.decodeIfPresent(FieldValue.self, forKey: .rev))?.text
  }
}

/// Something live capcomd made at a provider (ADR-021 §3); v1 has one kind, `machine`.
public struct SandboxResource: Decodable, Sendable, Hashable, Identifiable {
  /// Who uses it, from capcomd's own records (never the provider's labels): an agent, or capcomd itself for a short job
  /// (phase 2: `kind` `check`, `login`, `env_build`, `doctor`, more to come). Older daemons send no `kind`: an agent.
  public struct Owner: Decodable, Sendable, Hashable {
    /// "agent", "check", "login", "env_build", "doctor"; nil from a daemon before phase 2 (an agent).
    public var kind: String?
    public var runId: String?; public var agentId: String?; public var role: String?; public var task: String?
    /// The daemon's line for capcomd's own machines ("Checks for run-8kq2", "Logging in to Claude Code"); null for agents.
    public var label: String?
    public init(kind: String? = nil, runId: String? = nil, agentId: String? = nil, role: String? = nil, task: String? = nil, label: String? = nil) {
      self.kind = kind; self.runId = runId; self.agentId = agentId; self.role = role; self.task = task; self.label = label
    }
    enum CodingKeys: String, CodingKey { case kind, runId, agentId, role, task, label }
    public init(from decoder: Decoder) throws {
      let c = try decoder.container(keyedBy: CodingKeys.self)
      kind = try? c.decodeIfPresent(String.self, forKey: .kind)
      runId = try? c.decodeIfPresent(String.self, forKey: .runId)
      agentId = try? c.decodeIfPresent(String.self, forKey: .agentId)
      role = try? c.decodeIfPresent(String.self, forKey: .role)
      task = try? c.decodeIfPresent(String.self, forKey: .task)
      label = try? c.decodeIfPresent(String.self, forKey: .label)
    }
    /// An agent's machine (or a daemon that doesn't say). Anything else is capcomd's own short-lived machine, whatever
    /// its kind: it is never left behind, and the app never opens or deletes it.
    public var isAgent: Bool { kind == nil || kind == "agent" }
  }
  public var id: String
  public var kind: String
  /// starting, running, asleep (reserved), orphaned, stopping, unknown.
  public var state: String
  public var owner: Owner?
  public var createdAt: String?
  public var deleteAfter: String?
  public var actions: [String]
  enum CodingKeys: String, CodingKey { case id, kind, state, owner, createdAt, deleteAfter, actions }
  public init(id: String, kind: String = "machine", state: String, owner: Owner? = nil, createdAt: String? = nil, deleteAfter: String? = nil, actions: [String] = []) {
    self.id = id; self.kind = kind; self.state = state; self.owner = owner; self.createdAt = createdAt; self.deleteAfter = deleteAfter; self.actions = actions
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id)
    kind = (try? c.decodeIfPresent(String.self, forKey: .kind)) ?? "machine"
    state = (try? c.decodeIfPresent(String.self, forKey: .state)) ?? "unknown"
    owner = try? c.decodeIfPresent(Owner.self, forKey: .owner)
    createdAt = try? c.decodeIfPresent(String.self, forKey: .createdAt)
    deleteAfter = try? c.decodeIfPresent(String.self, forKey: .deleteAfter)
    actions = (try? c.decodeIfPresent([String].self, forKey: .actions)) ?? []
  }
  /// Nothing of capcomd's owns it: a machine left behind (a crash, a stopped run), which the idle lifetime cleans up.
  /// A machine capcomd uses for its own short job (checks, a login, building the environment) has an owner without an
  /// agent, and is not left behind.
  public var orphaned: Bool { state == "orphaned" || owner == nil }
  /// capcomd's own short-lived machine (checks, a login, an environment build): never opened or deleted from the app.
  public var capcomdJob: Bool { owner.map { !$0.isAgent } ?? false }
}

/// `GET /v1/sandboxes/{name}/resources`: the last list capcomd got from the provider. `stale`: the provider didn't answer
/// just now, so this is the last good list and `error` says why.
public struct ResourcePage: Decodable, Sendable, Hashable {
  public var resources: [SandboxResource]
  public var asOf: String?
  public var stale: Bool
  public var error: String?
  public var next: String?
  enum CodingKeys: String, CodingKey { case resources, asOf, stale, error, next }
  struct ErrorBody: Decodable { var message: String? }
  public init(resources: [SandboxResource], asOf: String? = nil, stale: Bool = false, error: String? = nil, next: String? = nil) {
    self.resources = resources; self.asOf = asOf; self.stale = stale; self.error = error; self.next = next
  }
  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    resources = (try c.decodeIfPresent(Lossy<SandboxResource>.self, forKey: .resources))?.items ?? []
    asOf = try? c.decodeIfPresent(String.self, forKey: .asOf)
    stale = (try? c.decodeIfPresent(Bool.self, forKey: .stale)) ?? false
    // A sentence or an ApiError-like object.
    error = (try? c.decodeIfPresent(String.self, forKey: .error)) ?? (try? c.decodeIfPresent(ErrorBody.self, forKey: .error))?.message
    next = try? c.decodeIfPresent(String.self, forKey: .next)
  }
}

/// `GET /v1/sandboxes/{name}/resources/{id}`: the resource and the command that opens a shell in it.
public struct ResourceDetail: Sendable, Hashable {
  public var resource: SandboxResource?
  /// A plain capcomd command the daemon wrote from trusted ids (`capcomd sandbox shell run-8kq2 agt-41`).
  public var terminalCommand: String?
  public init(resource: SandboxResource?, terminalCommand: String?) { self.resource = resource; self.terminalCommand = terminalCommand }
}

/// Decodes an array, dropping the elements that don't decode (a newer daemon's shapes never fail the whole list).
struct Lossy<T: Decodable>: Decodable {
  var items: [T]
  /// Accepts any element, so a bad one is stepped over (the container only advances on a successful decode).
  struct Skip: Decodable { init(from decoder: Decoder) throws {} }
  init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    var out: [T] = []
    while !c.isAtEnd {
      if let v = try? c.decode(T.self) { out.append(v) } else { _ = try? c.decode(Skip.self) }
    }
    items = out
  }
}

/// Decoding of the place routes (shared by the live adapter and the tests).
public enum SandboxWire {
  struct List: Decodable { var sandboxes: Lossy<SandboxDescriptor> }
  /// `{sandboxes: [descriptor + available/reason/default]}`; providers the daemon doesn't list (`listed: false`) are dropped.
  public static func sandboxes(_ data: Data) throws -> [SandboxDescriptor] {
    try JSONDecoder().decode(List.self, from: data).sandboxes.items.filter { $0.listed != false }
  }
  public static func detail(_ data: Data) throws -> SandboxDetail { try JSONDecoder().decode(SandboxDetail.self, from: data) }
  public static func resources(_ data: Data) throws -> ResourcePage { try JSONDecoder().decode(ResourcePage.self, from: data) }
  /// The resource either flat with `terminalCommand` beside its fields, or as `{resource, terminalCommand}`.
  public static func resource(_ data: Data) throws -> ResourceDetail {
    guard let o = try JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw DetailUnavailable.failed("unexpected response") }
    let inner = o["resource"] as? [String: Any]
    let body = try inner.map { try JSONSerialization.data(withJSONObject: $0) } ?? data
    let resource = try? JSONDecoder().decode(SandboxResource.self, from: body)
    let command = (o["terminalCommand"] as? String) ?? (inner?["terminalCommand"] as? String)
    return ResourceDetail(resource: resource, terminalCommand: command)
  }
}

// MARK: store

/// What Open in Terminal can do with a machine.
public enum TerminalCommand: Sendable, Hashable {
  /// A plain capcomd command (it passed `SettingsRows.isSafeCommand`): run it in Terminal.
  case ready(String)
  /// The daemon sent something that isn't a plain capcomd command: never run it.
  case refused
  /// It can't be opened; the sentence says why.
  case unavailable(String)
}

extension CapcomdStore {
  /// The place a descriptor describes, when the daemon has `sandboxes`.
  public func sandboxDescriptor(_ name: String) -> SandboxDescriptor? {
    sandboxDetails[name]?.value?.descriptor ?? sandboxList?.value?.first { $0.name == name }
  }

  /// Reads one place's details and its machines (the Details screen polls this while it shows). A machine list that
  /// fails after one was read keeps that list, marked stale, as the daemon itself does when its provider doesn't answer.
  public func refreshSandbox(_ name: String) async {
    guard let daemonInfo else { return }
    if let v = await settingsRead(Capability.sandboxes, { try await daemonInfo.sandbox(name) }) { sandboxDetails[name] = v }
    if let v = await settingsRead(Capability.sandboxesResources, { try await daemonInfo.resources(sandbox: name) }) {
      if case .unavailable(.failed(let why)) = v, var last = sandboxResources[name]?.value {
        last.stale = true; last.error = why; sandboxResources[name] = .loaded(last)
      } else {
        sandboxResources[name] = v
      }
    }
    changed()
  }

  /// The command that opens a shell in a machine, from the daemon (`GET …/resources/{id}` `terminalCommand`); the app
  /// never builds one. Only a plain capcomd command comes back `.ready`.
  public func terminalCommand(sandbox: String, resource: String) async -> TerminalCommand {
    guard let daemonInfo, capabilities.contains(Capability.sandboxesResources) else { return .unavailable("Update capcomd to open machines from here.") }
    do {
      let d = try await daemonInfo.resource(sandbox: sandbox, id: resource)
      guard let c = d.terminalCommand?.trimmingCharacters(in: .whitespaces), !c.isEmpty else { return .unavailable("capcomd can't open a shell in this machine.") }
      return SettingsRows.isSafeCommand(c) ? .ready(c) : .refused
    } catch is Unauthorized {
      unauthorized = true; changed(); return .unavailable("capcomd rejected this app's token.")
    } catch DetailUnavailable.failed(let why) {
      return .unavailable(why == SandboxRows.gone ? "This machine is gone." : "Couldn't ask capcomd just now.")
    } catch {
      return .unavailable("Couldn't ask capcomd just now.")
    }
  }
}

// MARK: changing settings (phase 2)

/// A place setting being changed, or the reason the last change didn't take.
public struct SettingEdit: Sendable, Hashable {
  /// The choice value on its way to the daemon (the picker shows it until the daemon answers).
  public var pending: String?
  /// The daemon's sentence (422), or why the change couldn't be made.
  public var error: String?
  public init(pending: String? = nil, error: String? = nil) { self.pending = pending; self.error = error }
  public static func key(_ sandbox: String, _ id: String) -> String { "\(sandbox)/\(id)" }
}

/// How the Details screen shows one setting: a control or its value read-only, and a sentence under it.
public struct FieldControl: Sendable, Hashable {
  /// The picker can be used.
  public var editable: Bool
  /// The choice the picker shows: the one being saved while it is on its way, else the daemon's value.
  public var selection: String
  public var saving: Bool
  /// Under the row: the daemon's refusal, a failed change, or "Reset your token to change these".
  public var note: String?
  public init(editable: Bool, selection: String, saving: Bool = false, note: String? = nil) {
    self.editable = editable; self.selection = selection; self.saving = saving; self.note = note
  }
}

extension CapcomdStore {
  /// The note on a setting the daemon would let change but this app's token can't (no `configure` scope).
  public static let needsConfigureScope = "Reset your token to change these"

  /// Whether `field` of `sandbox` can be changed from here, and what its row shows. A setting is a control only when the
  /// daemon has `sandboxes.settings`, says the field is `editable` (an environment variable doesn't set it), it is a
  /// `choice`, and the token hasn't been refused the `configure` scope; otherwise it shows the daemon's text read-only.
  public func fieldControl(sandbox: String, _ field: SandboxField) -> FieldControl {
    let edit = settingEdits[SettingEdit.key(sandbox, field.id)]
    let selection = edit?.pending ?? field.value.text ?? ""
    guard changeable(field) else { return FieldControl(editable: false, selection: field.value.text ?? "") }
    if configureDenied { return FieldControl(editable: false, selection: field.value.text ?? "", note: Self.needsConfigureScope) }
    return FieldControl(editable: edit?.pending == nil, selection: selection, saving: edit?.pending != nil, note: edit?.error)
  }

  /// The daemon would take a new value for `field` from a client (whatever this token's scopes).
  func changeable(_ field: SandboxField) -> Bool {
    capabilities.contains(Capability.sandboxesSettings) && field.kind == .choice && field.editable && !field.fromEnvironment && !field.choices.isEmpty
  }

  /// Sets one of a place's settings to a choice's `value` (`PATCH /v1/sandboxes/{name}/settings` with the details' `rev`).
  /// On 200 the details become the daemon's answer. On 409 (changed elsewhere since it was read) it reads the place
  /// again and tries once more with the new rev. On 403 the token lacks `configure`: settings go read-only with
  /// `needsConfigureScope`. On 422 the row shows the daemon's sentence.
  public func changeSetting(sandbox: String, id: String, to value: String) async {
    guard let daemonInfo, capabilities.contains(Capability.sandboxesSettings), !configureDenied,
          let detail = sandboxDetails[sandbox]?.value, let field = detail.settings.first(where: { $0.id == id }), changeable(field) else { return }
    let key = SettingEdit.key(sandbox, id)
    guard settingEdits[key]?.pending == nil else { return }
    if field.value.text == value { settingEdits[key] = nil; changed(); return }
    settingEdits[key] = SettingEdit(pending: value); changed()
    var problem: String?
    var rev = detail.rev
    attempts: for attempt in 0..<2 {
      do {
        if rev == nil { let fresh = try await daemonInfo.sandbox(sandbox); sandboxDetails[sandbox] = .loaded(fresh); rev = fresh.rev }
        guard let r = rev else { problem = Self.couldNotChange; break attempts }
        sandboxDetails[sandbox] = .loaded(try await daemonInfo.updateSandboxSettings(sandbox, values: [id: value], rev: r))
        break attempts
      } catch SettingsRefused.conflict(let current) {
        // Changed somewhere else since it was read: read it again, then try once more with the rev it has now.
        let fresh = try? await daemonInfo.sandbox(sandbox)
        if let fresh { sandboxDetails[sandbox] = .loaded(fresh) }
        rev = fresh?.rev ?? current
        if attempt == 1 || rev == nil { problem = "These settings changed somewhere else. Try again."; break attempts }
      } catch SettingsRefused.forbidden {
        configureDenied = true; break attempts
      } catch SettingsRefused.invalid(let message) {
        problem = message; break attempts
      } catch is Unauthorized {
        unauthorized = true; break attempts
      } catch {
        problem = Self.couldNotChange; break attempts
      }
    }
    settingEdits[key] = problem.map { SettingEdit(error: $0) }
    changed()
  }

  static let couldNotChange = "Couldn't change it just now. Try again."
}

// MARK: rows

/// A row's dot (Settings' StatusDot): green, orange, red, the empty ring, or none.
public enum Tone: Sendable, Hashable { case ok, warn, bad, empty, none }

/// One machine in a place's Machines section.
public struct MachineRow: Sendable, Hashable, Identifiable {
  public var id: String
  /// "worker · Add an abs(a) function", "checks · run-8kq2", or "Left behind · no agent owns it".
  public var title: String
  /// "4 min", "2 h".
  public var age: String
  public var tone: Tone
  public var orphaned: Bool
  /// capcomd's own short-lived machine (checks, a login, an environment build), not an agent's.
  public var capcomdJob: Bool
  public var canOpenTerminal: Bool
  /// The daemon offers Delete (phase 3); never for capcomd's own machines.
  public var canDelete: Bool
  public var createdAt: Date?
  public var deleteAfter: Date?
}

/// The place's availability as its first row says it.
public struct PlaceStatus: Sendable, Hashable {
  public var tone: Tone
  public var text: String
  /// What the daemon says to run to fix it ("No boxd API key (run capcomd setup)" → `capcomd setup`): Set Up….
  public var setupCommand: String?
  /// What a Set Up… hand-off waits to see change.
  public var fingerprint: String { "\(tone)|\(text)" }
}

/// Which rows go in which section of the Details screen. The sections and their order are fixed (the board); the rows
/// in them come from the daemon.
public struct DetailSections: Sendable, Hashable {
  /// `status` rows (a provider's key, …), after the availability row.
  public var status: [SandboxField] = []
  /// The idle lifetime, under the machines.
  public var machines: [SandboxField] = []
  /// Logins, Checkpoints and other info rows.
  public var safety: [SandboxField] = []
  /// Settings this app doesn't place: their own section, last.
  public var more: [SandboxField] = []
  public init() {}
}

/// Maps what the daemon says about places to rows. Platform-neutral and tested.
public enum SandboxRows {
  public static let idleLifetime = "idleLifetime"
  public static let logins = "logins"
  public static let checkpoints = "checkpoints"
  public static let openTerminal = "open_terminal"
  public static let delete = "delete"
  /// `DetailUnavailable.failed` reason for a resource the daemon no longer has.
  public static let gone = "gone"

  public static func sections(_ d: SandboxDetail) -> DetailSections {
    var s = DetailSections()
    for f in d.settings {
      if f.id == idleLifetime { s.machines.append(f) } else if f.kind == .status { s.status.append(f) } else { s.more.append(f) }
    }
    for f in d.info {
      if f.kind == .status && f.id != logins && f.id != checkpoints { s.status.append(f) }
      else if f.id == idleLifetime { s.machines.append(f) }
      else { s.safety.append(f) }
    }
    // Logins first, then Checkpoints, then anything else, as on the board.
    let rank = { (f: SandboxField) in f.id == logins ? 0 : f.id == checkpoints ? 1 : 2 }
    s.safety = s.safety.enumerated().sorted { (rank($0.element), $0.offset) < (rank($1.element), $1.offset) }.map(\.element)
    return s
  }

  /// The machines, owned ones first (newest first), then the ones left behind.
  public static func machines(_ page: ResourcePage, descriptor: SandboxDescriptor?, now: Date = Date()) -> [MachineRow] {
    let shell = descriptor?.caps.shell != false
    let rows = page.resources.map { r -> MachineRow in
      let created = r.createdAt.flatMap(SettingsRows.parseISO)
      let title: String
      if r.orphaned { title = "Left behind · no agent owns it" }
      else if let o = r.owner, !o.isAgent { title = jobTitle(o) }
      else {
        let who = r.owner?.role ?? r.owner?.agentId ?? "agent"
        let task = firstLine(r.owner?.task)
        title = task.isEmpty ? who : "\(who) · \(task)"
      }
      let tone: Tone
      switch r.state {
      case "running": tone = r.orphaned ? .warn : .ok
      case "orphaned": tone = .warn
      case "starting", "stopping": tone = .empty
      default: tone = r.orphaned ? .warn : .empty
      }
      let job = r.capcomdJob
      return MachineRow(id: r.id, title: title, age: created.map { age(from: $0, now: now) } ?? "", tone: tone, orphaned: r.orphaned, capcomdJob: job,
                        canOpenTerminal: !job && shell && r.actions.contains(openTerminal) && r.state != "stopping",
                        canDelete: !job && r.actions.contains(delete),
                        createdAt: created, deleteAfter: r.deleteAfter.flatMap(SettingsRows.parseISO))
    }
    return rows.enumerated().sorted { a, b in
      if a.element.orphaned != b.element.orphaned { return !a.element.orphaned }
      let ta = a.element.createdAt ?? .distantPast, tb = b.element.createdAt ?? .distantPast
      return ta != tb ? ta > tb : a.offset < b.offset
    }.map(\.element)
  }

  /// capcomd's own machine: "checks · run-8kq2" (who · its run), else "environment · Building the agent environment"
  /// (who · the daemon's line), else whichever of them there is, else its kind.
  static func jobTitle(_ o: SandboxResource.Owner) -> String {
    let who = (o.role?.isEmpty == false ? o.role : nil) ?? o.kind.map { $0.replacingOccurrences(of: "_", with: " ") }
    let what = (o.runId?.isEmpty == false ? o.runId : nil) ?? (o.label.map { firstLine($0) }.flatMap { $0.isEmpty ? nil : $0 })
    switch (who, what) {
    case let (w?, x?): return "\(w) · \(x)"
    case let (w?, nil): return w
    case let (nil, x?): return x
    default: return "capcomd"
    }
  }

  /// "now", "4 min", "2 h", "3 d".
  public static func age(from: Date, now: Date = Date()) -> String {
    let s = max(0, now.timeIntervalSince(from))
    if s < 60 { return "now" }
    if s < 3600 { return "\(Int(s / 60)) min" }
    if s < 86_400 { return "\(Int(s / 3600)) h" }
    return "\(Int(s / 86_400)) d"
  }

  /// A task's first line, trimmed.
  public static func firstLine(_ s: String?) -> String {
    (s ?? "").trimmingCharacters(in: .whitespacesAndNewlines).split(separator: "\n", maxSplits: 1, omittingEmptySubsequences: true).first
      .map { $0.trimmingCharacters(in: .whitespaces) } ?? ""
  }

  /// The availability row: "Running" for a place on this Mac, "Ready" for a cloud; else the daemon's reason, with Set
  /// Up… when the reason names a plain capcomd command to run.
  public static func status(_ d: SandboxDescriptor, place: SandboxInfo?) -> PlaceStatus {
    let available = place?.available ?? d.available ?? false
    if available { return PlaceStatus(tone: .ok, text: d.kind == .local ? "Running" : "Ready") }
    let reason = place?.reason ?? d.reason
    let command = setupCommand(reason)
    return PlaceStatus(tone: command == nil ? .bad : .empty, text: stripHint(reason) ?? "Can't be used now", setupCommand: command)
  }

  /// "No boxd API key (run capcomd setup)" → "capcomd setup"; also "(run `capcomd env build`)". Only plain capcomd commands.
  public static func setupCommand(_ reason: String?) -> String? {
    guard let reason, let r = reason.range(of: "(run ") else { return nil }
    var rest = reason[r.upperBound...]
    guard let close = rest.lastIndex(of: ")") else { return nil }
    rest = rest[..<close]
    let c = rest.trimmingCharacters(in: CharacterSet(charactersIn: "` "))
    return SettingsRows.isSafeCommand(c) ? c : nil
  }
  /// The reason without its "(run …)" hint: the row's button is the way to fix it.
  public static func stripHint(_ r: String?) -> String? {
    guard let r else { return nil }
    if let i = r.range(of: " (run ") { return String(r[..<i.lowerBound]) }
    return r
  }

  /// The section footer about where agents work, from the descriptor ("Agents work in containers on this Mac.").
  public static func placeFootnote(_ d: SandboxDescriptor) -> String? {
    guard d.kind == .local else { return nil }
    switch d.caps.isolation { case "container": return "Agents work in containers on this Mac."; case "vm": return "Agents work in virtual machines on this Mac."; default: return nil }
  }

  /// The Logins row in Safety: whether every login here is bound to its AI's API (`/v1/logins` `hostBound`, `boundTo`).
  /// nil when the daemon doesn't say (no `hostBound` on its logins) or there are no logins for this place.
  public struct LoginsSummary: Sendable, Hashable { public var tone: Tone; public var text: String; public var sub: String }
  public static func loginsSummary(_ all: [LoginInfo], sandbox: String) -> LoginsSummary? {
    let here = all.filter { $0.sandbox == sandbox }
    guard !here.isEmpty, here.contains(where: { $0.hostBound != nil }) else { return nil }
    let inUse = here.filter(\.loggedIn)
    guard !inUse.isEmpty else { return LoginsSummary(tone: .empty, text: "No logins", sub: "Log in from Settings › Accounts.") }
    let name = { (p: String) in p == "claude" ? "Claude" : p == "codex" ? "Codex" : p }
    let bound = inUse.filter { $0.hostBound == true }, loose = inUse.filter { $0.hostBound != true }
    let hosts = bound.compactMap(\.boundTo)
    let hostList = hosts.isEmpty ? "" : " (\(hosts.joined(separator: ", ")))"
    if loose.isEmpty {
      return LoginsSummary(tone: .ok, text: "Bound", sub: "Bound to each AI's API\(hostList): agents can use them, and they can't be sent anywhere else.")
    }
    if bound.isEmpty { return LoginsSummary(tone: .none, text: "Not bound", sub: "Logins here aren't bound to a host.") }
    let names = loose.map { name($0.provider) }
    let list = names.count == 1 ? names[0] : names.dropLast().joined(separator: ", ") + " and " + names.last!
    return LoginsSummary(tone: .warn, text: names.count == 1 ? "\(list) isn't bound" : "\(list) aren't bound",
                         sub: "\(bound.map { name($0.provider) }.joined(separator: " and ")) \(bound.count == 1 ? "is" : "are") bound to \(bound.count == 1 ? "its" : "their") AI's API\(hostList).")
  }

  /// "Local (Docker) can't bind logins to a host; Cloud does." when some places can and some can't.
  public static func bindingFootnote(_ places: [SandboxDescriptor]) -> String? {
    let can = places.filter { $0.caps.hostBoundSecrets == true }, cannot = places.filter { $0.caps.hostBoundSecrets == false }
    guard !can.isEmpty, !cannot.isEmpty else { return nil }
    let names = cannot.map { "\($0.label) (\($0.vendorName))" }.joined(separator: ", ")
    return "\(names) can't bind logins to a host; \(can.map(\.label).joined(separator: ", ")) \(can.count == 1 ? "does" : "do")."
  }
}
