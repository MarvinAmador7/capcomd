import Foundation

/// The Team screen's data (Team.swift): the roster by project and, per profile the screen shows, its rows, recent work
/// and persona; the changes it sends. Kept apart from the store's run state: nothing here is read by a column, the
/// sidebar's agent list or the menu bar, so a profile loading or changing reports to `onChange` alone and never wakes
/// them. Each route is asked only when the daemon has its capability; a part it lacks is simply absent.
@MainActor
public final class TeamStore {
  /// What a change touched: the roster, or one profile (by its `TeamKey`).
  public enum Change: Hashable, Sendable { case roster, profile(String) }

  unowned let store: CapcomdStore
  let port: ProfilesPort?
  public var onChange: (@MainActor (Change) -> Void)?

  public private(set) var roster: [TeamGroup] = []
  /// The roster was read at least once (an empty one then means none, not "not yet").
  public private(set) var rosterLoaded = false
  public private(set) var rows: [String: ProfileRow] = [:]
  public private(set) var details: [String: ProfileDetail] = [:]
  public private(set) var work: [String: [ProfileWorkItem]] = [:]
  public private(set) var personas: [String: ProfilePersona] = [:]
  /// Values being written, by profile then field id (nil: being removed): the rows show them until the answer.
  public private(set) var pending: [String: [String: String?]] = [:]
  /// The daemon's sentence for the last change it refused, by profile; nil once a later one goes through.
  public private(set) var refusals: [String: String] = [:]
  /// A change answered 403: this app's token can't change profiles, so the rows stay read-only for this store.
  public private(set) var readOnly = false
  /// A run started from a profile's launcher: on its way, started, or refused.
  public private(set) var starts: [String: StartState] = [:]
  var queued: [String: [String: String?]] = [:]
  var writing: Set<String> = []
  var personaWrites: [String: String] = [:]
  var personaWriting: Set<String> = []

  init(store: CapcomdStore, port: ProfilesPort?) { self.store = store; self.port = port }

  public func has(_ capability: String) -> Bool { port != nil && store.capabilities.contains(capability) }
  /// The daemon lists profiles: the Team screen can show.
  public var available: Bool { has(Capability.profiles) }
  /// Its rows can be changed here.
  public var editable: Bool { has(Capability.profilesEdit) && !readOnly }

  private func changed(_ c: Change) { onChange?(c) }

  // MARK: reading

  /// The roster: each of capcomd's projects' own profiles (`projects.known`), then the user's own. Reads the daemon's
  /// capabilities first when it hasn't yet.
  public func refresh() async {
    if store.capabilities.isEmpty { await store.refreshDaemonInfo() }
    guard available, let port else { rosterLoaded = true; changed(.roster); return }
    let known = await store.knownProjects()
    // Every list at once, in one group (the daemon's own as -1): an `async let` beside a task group is freed out of
    // order by some Swift runtimes ("freed pointer was not the last allocation").
    var got: [Int: ProfileList] = [:]
    await withTaskGroup(of: (Int, ProfileList?).self) { g in
      g.addTask { (-1, try? await port.profiles(repo: nil)) }
      for (i, p) in known.enumerated() { g.addTask { (i, try? await port.profiles(repo: p.path)) } }
      for await (i, l) in g { if let l { got[i] = l } }
    }
    let lists: [(name: String, path: String, list: ProfileList?)] = known.enumerated().map { i, p in (p.name, p.path, got[i]) }
    let mine = got[-1]
    var rows: [String: ProfileRow] = [:]
    for (_, path, l) in lists { for r in l?.profiles ?? [] where r.layer == "project" { rows[TeamKey.make(repo: path, name: r.name)] = r } }
    for r in mine?.profiles ?? [] where r.layer != "bundled" { rows[TeamKey.make(repo: nil, name: r.name)] = r }
    let roster = TeamRoster.make(projects: lists, own: mine)
    self.rows = rows
    let first = !rosterLoaded
    rosterLoaded = true
    if first || roster != self.roster { self.roster = roster; changed(.roster) }
    for k in details.keys where rows[k] != nil { changed(.profile(k)) }
  }

  /// Everything a profile's pane shows: its rows, its recent work, its persona, each when the daemon has the route.
  public func load(_ key: String) async {
    guard let port else { return }
    let (repo, name) = TeamKey.split(key)
    enum Part: Sendable { case detail(ProfileDetail?), work([ProfileWorkItem]?), persona(ProfilePersona?) }
    let (edit, works, souls) = (has(Capability.profilesEdit), has(Capability.profilesWork), has(Capability.profilesPersona))
    var d: ProfileDetail?, w: [ProfileWorkItem]?, p: ProfilePersona?
    await withTaskGroup(of: Part.self) { g in
      if edit { g.addTask { .detail(try? await port.profile(name, repo: repo)) } }
      if works { g.addTask { .work(try? await port.profileWork(name, repo: repo, limit: 5)) } }
      if souls { g.addTask { .persona(try? await port.persona(name, repo: repo)) } }
      for await part in g {
        switch part { case .detail(let x): d = x; case .work(let x): w = x; case .persona(let x): p = x }
      }
    }
    if let d { details[key] = d; rows[key] = merged(rows[key], d.profile) }
    if let w { work[key] = w }
    if let p { personas[key] = p }
    changed(.profile(key))
  }

  /// The row the roster has, with what the detail says newer (its title and bot after a change).
  private func merged(_ old: ProfileRow?, _ new: ProfileRow) -> ProfileRow {
    var r = new
    if r.avatarSeed == nil { r.avatarSeed = old?.avatarSeed }
    return r
  }

  // MARK: changing

  /// Writes `values` (field id → value; nil removes it) to the profile's own file. Changes made while one is on its way go
  /// together after it. A 409 (its files changed underneath) reads it again and sends the change once more on the new rev.
  public func set(_ key: String, _ values: [String: String?]) async {
    guard editable, port != nil else { return }
    queued[key, default: [:]].merge(values) { _, b in b }
    pending[key, default: [:]].merge(values) { _, b in b }
    changed(.profile(key))
    guard !writing.contains(key) else { return }
    writing.insert(key)
    defer { writing.remove(key) }
    while let next = queued.removeValue(forKey: key), !next.isEmpty {
      await write(key, next, retry: true)
    }
  }

  private func write(_ key: String, _ values: [String: String?], retry: Bool) async {
    guard let port else { return }
    let (repo, name) = TeamKey.split(key)
    if details[key] == nil, let d = try? await port.profile(name, repo: repo) { details[key] = d }
    guard let rev = details[key]?.rev else { settle(key, values); return }
    do {
      let d = try await port.updateProfile(name, repo: repo, values: values, rev: rev, idempotencyKey: store.makeKey())
      details[key] = d; rows[key] = merged(rows[key], d.profile)
      refusals[key] = nil
      settle(key, values)
      updateRoster(key, d.profile)
    } catch ProfileRefused.conflict {
      if let d = try? await port.profile(name, repo: repo) { details[key] = d; rows[key] = merged(rows[key], d.profile) }
      if retry { await write(key, values, retry: false) } else { settle(key, values) }
    } catch ProfileRefused.forbidden {
      readOnly = true; settle(key, values)
    } catch ProfileRefused.invalid(let why) {
      refusals[key] = why; settle(key, values)
    } catch is Unauthorized {
      store.unauthorized = true; settle(key, values)
    } catch {
      refusals[key] = "Couldn't reach capcomd"; settle(key, values)
    }
  }

  /// The written values are no longer pending (unless a later change to the same field is queued).
  private func settle(_ key: String, _ values: [String: String?]) {
    for id in values.keys where queued[key]?[id] == nil { pending[key]?[id] = nil }
    if pending[key]?.isEmpty == true { pending[key] = nil }
    changed(.profile(key))
  }

  /// A title or a bot changed: the roster's row follows.
  private func updateRoster(_ key: String, _ row: ProfileRow) {
    var changedAny = false
    for (gi, g) in roster.enumerated() {
      for (mi, m) in g.members.enumerated() where m.id == key {
        let next = TeamMember(row: merged(rows[key], row), repo: m.repo)
        if next != m { roster[gi].members[mi] = next; changedAny = true }
      }
    }
    if changedAny { changed(.roster) }
  }

  /// The persona's new text, written over the one last read (its hash). Edits made while one is on its way go after it.
  public func savePersona(_ key: String, text: String) async {
    guard has(Capability.profilesPersona), let port else { return }
    personaWrites[key] = text
    guard !personaWriting.contains(key) else { return }
    personaWriting.insert(key)
    defer { personaWriting.remove(key) }
    let (repo, name) = TeamKey.split(key)
    while let t = personaWrites.removeValue(forKey: key) {
      guard t != personas[key]?.text else { continue }
      do {
        personas[key] = try await port.updatePersona(name, repo: repo, text: t, rev: personas[key]?.hash ?? "")
        refusals[key] = nil
      } catch ProfileRefused.conflict {
        if let p = try? await port.persona(name, repo: repo) {
          personas[key] = p
          if let again = try? await port.updatePersona(name, repo: repo, text: t, rev: p.hash ?? "") { personas[key] = again }
        }
      } catch ProfileRefused.invalid(let why) { refusals[key] = why }
      catch ProfileRefused.forbidden { readOnly = true }
      catch is Unauthorized { store.unauthorized = true }
      catch { refusals[key] = "Couldn't reach capcomd" }
      changed(.profile(key))
    }
  }

  // MARK: starting a run

  /// Whether the launcher can start a run of this profile: a worker always; a planner only where `POST /v1/runs` takes
  /// `planner`.
  public func canStart(_ key: String) -> Bool {
    guard let r = rows[key] else { return false }
    return TeamRole.of(r) == .plans ? has(Capability.runsPlanner) : true
  }

  /// Starts a run of the profile on `goal`: `profile` for a worker, `planner` for a planner. A project's profile runs in
  /// its project; the user's own in the project the composer has (the remembered checkout, else the daemon's own).
  @discardableResult
  public func start(_ key: String, goal: String, sandbox: String?) async -> StartState {
    guard canStart(key), let r = rows[key] else { return .idle }
    let (repo, name) = TeamKey.split(key)
    let planner = TeamRole.of(r) == .plans
    let choice = RunChoice(repo: repo ?? store.prefs.startRepo, sandbox: sandbox, profile: planner ? nil : name, planner: planner ? name : nil)
    starts[key] = .starting; changed(.profile(key))
    let state = await store.startRun(goal: goal, choice)
    store.clearStart()
    starts[key] = state; changed(.profile(key))
    return state
  }
  public func clearStart(_ key: String) { if starts[key] != nil { starts[key] = nil; changed(.profile(key)) } }
}

extension CapcomdStore {
  /// The Team screen's data, on this store's daemon (the live adapter lists profiles; tests and the bench pass a port).
  public var team: TeamStore {
    if let t = teamStore { return t }
    let t = TeamStore(store: self, port: profilesPort ?? (daemonInfo as? ProfilesPort))
    teamStore = t
    return t
  }
}
