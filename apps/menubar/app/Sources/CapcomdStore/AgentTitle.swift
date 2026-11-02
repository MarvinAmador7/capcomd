import Foundation

// Agent titles (capability `agents.title`): every agent has a short title that names its crew tab in the desktop app,
// its row in the menu bar and wherever else an agent is named ("lead · login redirect asks"). The agent names itself
// (or its parent, or the driving harness does); the daemon derives one from the task when nobody did; the person
// renames it here (`PUT …/agents/{agentId}/title`), and their title sticks until they clear it (an empty name).

extension Capability {
  /// Agent.title / titleSource, PUT and DELETE …/agents/{agentId}/title, agent.titled and run.titled.
  public static let agentsTitle = "agents.title"
}

public enum AgentTitle {
  /// The daemon's rules (src/primitives/agent-title.ts): 1–4 words, at most 32 characters, one lowercase line.
  public static let maxWords = 4
  public static let maxChars = 32

  /// One plain line, as the daemon would store it: whitespace collapsed, lowercase, control and format characters
  /// dropped (a zero-width joiner stays inside an emoji).
  public static func clean(_ raw: String) -> String {
    var out = ""
    let scalars = Array(raw.unicodeScalars)
    for (i, u) in scalars.enumerated() {
      if u.properties.generalCategory == .control || u.properties.generalCategory == .lineSeparator || u.properties.generalCategory == .paragraphSeparator {
        out.unicodeScalars.append(" "); continue
      }
      if u.properties.generalCategory == .format {
        let joinsEmoji = u.value == 0x200D && i > 0 && i + 1 < scalars.count
          && (scalars[i - 1].properties.isEmoji || scalars[i - 1].value == 0xFE0F) && scalars[i + 1].properties.isEmoji
        if !joinsEmoji { continue }
      }
      out.unicodeScalars.append(u)
    }
    return out.split(whereSeparator: \.isWhitespace).joined(separator: " ").lowercased()
  }

  /// A title the person typed: cleaned, or why the daemon would refuse it (the same sentences). nil: no words.
  public static func check(_ raw: String) -> Result<String, Refused>? {
    let t = clean(raw)
    if t.isEmpty { return nil }
    let words = t.split(separator: " ").count
    if words > maxWords { return .failure(Refused("A name is 1 to \(maxWords) words, not \(words)")) }
    if t.count > maxChars { return .failure(Refused("A name is at most \(maxChars) characters, not \(t.count)")) }
    return .success(t)
  }
  public struct Refused: Error, Sendable, Hashable { public var message: String; public init(_ m: String) { message = m } }

  /// The title to show (`Agent.title`, untrusted): its first line, cleaned, at most `maxChars` characters (the daemon
  /// never sends more; an older or misbehaving one could). nil when empty.
  public static func shown(_ t: UntrustedText?) -> String? {
    guard let t else { return nil }
    let s = clean(t.firstLine)
    if s.isEmpty { return nil }
    return s.count > maxChars ? String(s.prefix(maxChars - 1)) + "…" : s
  }

  /// An @ mention's handle: the profile, then the title as one word ("@worker-login-redirect"), then the suffix that
  /// tells siblings apart ("@worker-d3ce" from an older daemon). No spaces: a handle is one token of the steer.
  public static func handle(_ n: AgentNode) -> String {
    let slug = n.title.map { t in
      String(t.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }).split(separator: "-").joined(separator: "-")
    }.flatMap { $0.isEmpty ? nil : $0 }
    return "@" + ([n.name, slug, n.suffix].compactMap { $0 }).joined(separator: "-")
  }

  /// How text names an agent: "lead · login redirect", else "worker d3ce" (no title: an older daemon), else "lead".
  public static func label(name: String, title: String?, suffix: String?) -> String {
    if let title { return [name, title].joined(separator: " · ") + (suffix.map { " \($0)" } ?? "") }
    return name + (suffix.map { " \($0)" } ?? "")
  }
}

/// Renaming one agent inline (a crew tab or a column header in the desktop, a row in the menu bar): the field starts
/// with the title shown; Return commits, Esc cancels. An emptied field clears the person's own title (the agent's or
/// the derived one shows again); with none of theirs, it changes nothing.
public struct TitleEdit: Sendable, Hashable {
  public var agentId: String
  /// The title shown when editing began.
  public var original: String
  public var draft: String
  /// The person's own title is the one shown (titleSource user): an empty field clears it.
  public var userTitled: Bool
  /// Why the draft can't be saved (shown under the field); nil while it can.
  public var error: String? {
    guard case .failure(let e)? = AgentTitle.check(draft) else { return nil }
    return e.message
  }
  public init(agentId: String, current: String?, userTitled: Bool) {
    self.agentId = agentId; original = current ?? ""; draft = current ?? ""; self.userTitled = userTitled
  }
  public enum Outcome: Sendable, Hashable {
    /// Send this title (`PUT`).
    case set(String)
    /// Clear the person's title (`DELETE`).
    case clear
    /// Nothing to send: the same title, or an empty field with no title of theirs.
    case unchanged
    /// Keep the field open: the daemon would refuse it.
    case invalid(String)
  }
  /// What Return does with the draft.
  public var commit: Outcome {
    switch AgentTitle.check(draft) {
    case nil: return userTitled ? .clear : .unchanged
    case .failure(let e)?: return .invalid(e.message)
    case .success(let t)?: return t == AgentTitle.clean(original) ? .unchanged : .set(t)
    }
  }
}

/// `PUT /v1/runs/{runId}/agents/{agentId}/title` (`title` nil: `DELETE`), steer scope, Idempotency-Key. Returns the
/// title shown after it and where it comes from. Throws `AgentTitle.Refused` (403, 404, 422), `Unauthorized`, or
/// `DetailUnavailable.unsupported` on daemons without the routes.
public protocol AgentTitling: Sendable {
  func setTitle(runId: String, agentId: String, title: String?, idempotencyKey: String) async throws -> (title: String?, titleSource: String?)
}

/// A rename on its way, or why the last one didn't go through (the old title is back).
public enum TitleAction: Sendable, Hashable { case saving, failed(String) }

extension CapcomdStore {
  public static let titlesNeedUpdate = "Update capcomd to rename agents."
  /// The daemon names agents and takes the person's names (`agents.title`).
  public var titlesSupported: Bool { capabilities.contains(Capability.agentsTitle) }

  /// Where an inline rename of this agent starts: the title shown, and whether it is the person's own.
  public func titleEdit(runId: String, agentId: String) -> TitleEdit? {
    guard let a = runs[runId]?.agents[agentId] else { return nil }
    return TitleEdit(agentId: agentId, current: a.titleText, userTitled: a.titleSource == "user")
  }

  /// Applies an inline rename's outcome: the title shows at once (titleSource user) and agent.titled confirms it; a
  /// refusal or failure puts the old title back and says why in `titleActions`. One Idempotency-Key per rename, reused
  /// on a retry after a transport failure.
  @discardableResult
  public func rename(runId: String, agentId: String, _ outcome: TitleEdit.Outcome) async -> TitleAction? {
    let title: String?
    switch outcome { case .set(let t): title = t; case .clear: title = nil; case .unchanged, .invalid: return titleActions[agentId] }
    guard let before = runs[runId]?.agents[agentId] else { return nil }
    // Shown before anything is asked of the daemon (its capabilities may need a read first).
    titleActions[agentId] = .saving
    if let title { updateAgent(runId, agentId) { $0.title = UntrustedText(title); $0.titleSource = "user" } }
    changed()
    await ensureCapabilities()
    guard let titler, titlesSupported else {
      updateAgent(runId, agentId) { $0.title = before.title; $0.titleSource = before.titleSource }
      titleActions[agentId] = .failed(Self.titlesNeedUpdate); changed(); return titleActions[agentId]
    }
    let slot = "title:\(agentId):\(title ?? "")"
    let key = pendingTitleKeys[slot] ?? makeKey()
    pendingTitleKeys[slot] = key
    var next: TitleAction?
    do {
      let r = try await titler.setTitle(runId: runId, agentId: agentId, title: title, idempotencyKey: key)
      pendingTitleKeys[slot] = nil; next = nil
      updateAgent(runId, agentId) { $0.title = r.title.map(UntrustedText.init); $0.titleSource = r.titleSource }
    } catch let e as AgentTitle.Refused { pendingTitleKeys[slot] = nil; next = .failed(e.message) }
    catch is Unauthorized { unauthorized = true; next = .failed(Self.tokenRejected) }
    catch DetailUnavailable.unsupported { pendingTitleKeys[slot] = nil; next = .failed(Self.titlesNeedUpdate) }
    catch { next = .failed("Couldn't reach capcomd") }   // key kept: a retry replays instead of renaming twice
    if next != nil { updateAgent(runId, agentId) { $0.title = before.title; $0.titleSource = before.titleSource } }
    titleActions[agentId] = next
    changed()
    return next
  }

  /// agent.spawned / agent.titled: the title it carries, when it is the one shown.
  func applyTitle(_ e: Envelope, runId: String?, agentId: String?) {
    guard let runId, let agentId, runs[runId]?.agents[agentId] != nil else { return }
    let d = e.data
    // agent.titled with shown false: the person's title holds the tab; the new one shows once they clear theirs.
    if e.type == "agent.titled", d["shown"]?.bool == false { return }
    if titleActions[agentId] == .saving, e.type == "agent.titled", d["by"]?.string != "user", d["by"]?.string != "cleared" { return }
    updateAgent(runId, agentId) { $0.title = d["title"]?.string.map(UntrustedText.init); $0.titleSource = d["titleSource"]?.string ?? d["by"]?.string }
  }
}
