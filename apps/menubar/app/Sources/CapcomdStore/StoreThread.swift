import Foundation

/// A steer typed in the thread input, shown as a bubble until the daemon's `message.sent` (same seq) replaces it.
public struct PendingSteer: Sendable, Hashable, Identifiable {
  public enum State: Sendable, Hashable { case sending, sent(seq: Int), failed(String) }
  public var id: String
  public var body: String
  public var skills: [String]
  public var state: State
  var key: String
}

/// Capabilities the thread input checks before offering a feature.
public enum Capability {
  /// The steer route accepts `skills: [name]` (skill attach).
  public static let steerSkills = "steer.skills"
  /// An agent can be paused on its own (Esc to stop while it writes).
  public static let agentPause = "agent.pause"
  /// `POST /v1/runs` takes `driver` and `sandbox`, and `GET /v1/run-options` lists them: who drives a new run and
  /// whether it runs locally (Docker) or on a VM (boxd).
  public static let runsOptions = "runs.options"
  /// `GET /v1/run-options` takes `repo`: the options of the project a new run goes to, not only the daemon's own.
  public static let runsOptionsRepo = "runs.options.repo"
}

extension CapcomdStore {
  /// Thread items plus this agent's steers still on their way (a sent one drops out once its message.sent arrives).
  public func pendingSteers(agentId: String) -> [PendingSteer] {
    let have = Set((threads[agentId] ?? []).map(\.id))
    return (outbox[agentId] ?? []).filter { p in
      if case .sent(let seq) = p.state { return !have.contains("msg:operator:\(agentId):\(seq)") }
      return true
    }
  }

  /// Send `body` to the agent. A failed send keeps its Idempotency-Key, so Retry replays rather than sending twice.
  public func steer(runId: String, agentId: String, body raw: String, skills: [String] = [], retrying id: String? = nil) async {
    let body = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    guard let messenger, !body.isEmpty else { return }
    var list = outbox[agentId] ?? []
    let entry: PendingSteer
    if let id, let i = list.firstIndex(where: { $0.id == id }) { list[i].state = .sending; entry = list[i] }
    else { entry = PendingSteer(id: UUID().uuidString, body: body, skills: skills, state: .sending, key: makeKey()); list.append(entry) }
    outbox[agentId] = list; changed()
    let state: PendingSteer.State
    do {
      let sent = try await messenger.send(runId: runId, agentId: agentId, body: entry.body,
                                          skills: capabilities.contains(Capability.steerSkills) ? entry.skills : [], idempotencyKey: entry.key)
      state = .sent(seq: sent.seq)
    } catch let e as MessageRefused { state = .failed(e.message) }
    catch is Unauthorized { unauthorized = true; state = .failed("capcomd rejected the token") }
    catch DetailUnavailable.unsupported { state = .failed("This capcomd can't send messages from here yet") }
    catch { state = .failed("Couldn't reach capcomd") }
    if let i = outbox[agentId]?.firstIndex(where: { $0.id == entry.id }) { outbox[agentId]?[i].state = state }
    changed()
  }

  public func discardSteer(agentId: String, id: String) { outbox[agentId]?.removeAll { $0.id == id }; changed() }

  /// Capabilities and skills, read once per daemon connection (cheap; the view asks when the thread opens).
  public func refreshDaemonInfo() async {
    guard let daemonInfo else { return }
    if let c = try? await daemonInfo.capabilities() { capabilities = c }
    do { skills = .loaded(try await daemonInfo.skills()) }
    catch { skills = .unavailable(error as? DetailUnavailable ?? .failed("Couldn't reach capcomd")) }
    await refreshRunOptions()
  }

  /// Who can drive a new run and where, for the project it goes to (`prefs.startRepo`; the daemon's own on daemons
  /// that can only say for that one). A folder that isn't a capcomd project leaves every driver unavailable, saying why.
  public func refreshRunOptions() async {
    guard let daemonInfo, capabilities.contains(Capability.runsOptions) else { runOptions = RunOptions(); changed(); return }
    let repo = capabilities.contains(Capability.runsOptionsRepo) ? prefs.startRepo : nil
    let options: RunOptions
    do { options = try await daemonInfo.runOptions(repo: repo) }
    catch let e as MessageRefused {
      options = RunOptions(drivers: runOptions.drivers.map { var d = $0; d.available = false; d.reason = e.message; return d }, sandboxes: runOptions.sandboxes)
    }
    catch { return }
    // The project changed while this was asked: its own refresh answers for it.
    guard repo == (capabilities.contains(Capability.runsOptionsRepo) ? prefs.startRepo : nil) else { return }
    runOptions = options
    changed()
  }
}
