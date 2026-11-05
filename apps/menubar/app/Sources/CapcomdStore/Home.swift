import Foundation

// The window's Home screen (design/desktop/Home.dc.html): the composer's model menu and the Running cards, as data.
// The views only lay these out; what they say comes from the store (never invented here).

// MARK: the model menu

/// The composer's model button and its menu (Home.dc.html, "Planner model"): Claude Code's models, then Codex's, then an
/// Effort control. A harness that can't run where the run would start stays listed, its models disabled, with the
/// daemon's reason (the #110 rule: always a menu, never a dead name).
public struct ModelMenu: Sendable, Hashable {
  public struct Option: Sendable, Hashable, Identifiable {
    public var provider: String
    /// What `POST /v1/runs` `model` gets; nil: the driver's own (an older daemon lists no models).
    public var model: String?
    public var name: String
    public var note: String
    public var checked: Bool
    public var enabled: Bool
    public var id: String { provider + "/" + (model ?? "-") }
  }
  public struct Section: Sendable, Hashable, Identifiable {
    public var provider: String
    /// "Claude Code", "Codex".
    public var title: String
    /// Why its models can't be picked where the run would start (nil: they can).
    public var reason: String?
    public var options: [Option]
    public var id: String { provider }
  }
  public var sections: [Section]
  /// The current driver's effort levels, lowest first (empty: its effort can't be set), and whether "Auto" (let the
  /// CLI choose) is offered before them: only for a driver with no fixed default (Claude Code).
  public var efforts: [String]
  public var offersAuto: Bool
  /// The effort picked for new runs; nil: Auto.
  public var effort: String?
  /// The button: the model's name, the effort as one to three lit bars (nil: no bars), whether any harness can run.
  public var chip: String
  public var bars: Int?
  public var enabled: Bool
  /// For VoiceOver: "Planner: Claude Code, Opus 5.5, high effort".
  public var label: String

  /// The lit bars (of three) for an effort, as the prototype draws them: Auto and the top levels fill all three.
  public static func bars(_ effort: String?) -> Int {
    switch effort { case "minimal"?, "low"?: 1; case "medium"?: 2; default: 3 }
  }
  /// "claude-opus-5-5" → "Opus 5.5" (a dated suffix dropped); anything else: nil.
  public static func displayName(model m: String?) -> String? {
    guard let m, m.hasPrefix("claude-") else { return nil }
    let parts: [String] = m.dropFirst(7).split(separator: "-").map(String.init).filter { !($0.count == 8 && $0.allSatisfy(\.isNumber)) }
    guard let family = parts.first, family.allSatisfy(\.isLetter) else { return nil }
    let version = parts.dropFirst().filter { $0.allSatisfy(\.isNumber) }.joined(separator: ".")
    return version.isEmpty ? family.capitalized : "\(family.capitalized) \(version)"
  }
  /// A driver's model as the button names it: its listed name, else the id made readable, else the driver's label.
  public static func name(_ d: DriverInfo, model: String?) -> String {
    if let m = model, let listed = d.models?.first(where: { $0.id == m }) { return listed.name }
    return displayName(model: model) ?? model ?? d.label
  }
}

extension CapcomdStore {
  /// The model menu where a run would start now (`startSandbox`), with the driver, model and effort new runs get.
  public var modelMenu: ModelMenu {
    let ds = startDrivers, current = startDriver
    let shown = current ?? ds.first { $0.isDefault == true } ?? ds.first
    let models = capabilities.contains(Capability.runsOptionsModels)
    let picked = startModelShown?.id
    let sections = ds.map { d -> ModelMenu.Section in
      let isCurrent = d.provider == current?.provider
      let opts: [ModelMenu.Option]
      if models, let list = d.models, !list.isEmpty {
        let mine = isCurrent ? picked : nil
        opts = list.map { m in ModelMenu.Option(provider: d.provider, model: m.id, name: m.name, note: m.note, checked: isCurrent && m.id == mine, enabled: d.available) }
      } else {
        // An older daemon: the driver itself, on its profile's model.
        opts = [ModelMenu.Option(provider: d.provider, model: nil, name: ModelMenu.name(d, model: d.model), note: d.label, checked: isCurrent, enabled: d.available)]
      }
      return ModelMenu.Section(provider: d.provider, title: d.label, reason: d.available ? nil : (d.reason ?? "Unavailable"), options: opts)
    }
    let levels = current?.efforts ?? []
    let effort = startEffort
    let chip = shown.map { d in ModelMenu.name(d, model: d.provider == current?.provider ? (picked ?? d.model) : d.model) } ?? "No AI"
    let spokenEffort = levels.isEmpty ? nil : (effort.map { EffortWords.title($0).lowercased() } ?? "auto") + " effort"
    let label = current.map { d in (["Planner: \(d.label)", chip, spokenEffort] as [String?]).compactMap { $0 }.joined(separator: ", ") }
      ?? "Planner unavailable: \(shown?.reason ?? "no AI can drive a run yet")"
    return ModelMenu(sections: sections, efforts: levels, offersAuto: current.map { $0.effort == nil } ?? false, effort: effort, chip: chip,
                     bars: current == nil || levels.isEmpty ? nil : ModelMenu.bars(effort), enabled: current != nil, label: label)
  }
}

/// Effort levels in words ("xhigh" → "Extra high").
public enum EffortWords {
  public static func title(_ level: String) -> String {
    switch level { case "xhigh": "Extra high"; case "max": "Max"; default: level.prefix(1).uppercased() + level.dropFirst() }
  }
}

// MARK: typing on Home

/// Home opens with nothing focused (no blue ring) and holds the keyboard itself; typing there starts the goal. This
/// says which key presses are text for the composer: printable characters with no modifier but Shift. Return, Tab,
/// Esc, arrows and function keys (Unicode's private-use F700–F8FF) and anything with ⌘, ⌃ or ⌥ keep their own meaning.
public enum HomeTyping {
  public static func text(_ characters: String, command: Bool, control: Bool, option: Bool) -> String? {
    guard !command, !control, !option, !characters.isEmpty else { return nil }
    let printable = characters.unicodeScalars.allSatisfy { s in
      !CharacterSet.controlCharacters.contains(s) && !(0xF700...0xF8FF).contains(s.value) && s.value != 0x7F
    }
    return printable ? characters : nil
  }
}

// MARK: Running

/// One Running card on Home: a project with an active run, as one 48 pt line (its place, its title, a few words on what
/// the crew is doing, the crew's heads, the elapsed time), and, when it asks, a second line with the question, the
/// evidence and Deny / Approve.
public struct HomeRun: Sendable, Hashable, Identifiable {
  public struct Ask: Sendable, Hashable {
    public var approvalId: String
    /// The ask's question as the menu bar's card words it.
    public var question: String
    /// The files with their +/− ("3 files, +73 −5"), else the branch line; nil when the daemon sent neither.
    public var evidence: String?
    /// A decision on its way: the buttons wait.
    public var busy: Bool
  }
  /// The project (its deck in the title bar): a click opens it.
  public var id: String
  /// The run the card speaks for, whose crew it stacks.
  public var runId: String
  public var title: String
  /// "docker" (Local), "boxd" (Cloud), else nil.
  public var sandbox: String?
  public var phrase: String
  public var startedAtMs: Int?
  /// Its crew, in tree order (the heads, at most `headsShown`).
  public var agentIds: [String]
  public var ask: Ask?

  public static let headsShown = 5

  /// The menu bar's card sentence ("worker d3ce is editing 3 files") as a few words: who is dropped, then "is", and the
  /// line is cut at its first clause and after six words. Nothing is added but the "…" of a cut.
  public static func phrase(_ s: ActiveCard.Sentence, maxWords: Int = 6) -> String {
    var t = s.rest.trimmingCharacters(in: .whitespaces)
    if s.who != nil {
      if t.hasPrefix("is ") { t = String(t.dropFirst(3)) }
      else if t.hasPrefix(":") { t = t.dropFirst().trimmingCharacters(in: .whitespaces) }
    }
    // A line that isn't a name ("Read 4 files", "Starting") reads on after the title in lower case; "README" stays.
    if let f = t.first, f.isUppercase, t.dropFirst().first.map({ $0.isLowercase }) ?? false { t = f.lowercased() + t.dropFirst() }
    if let r = t.range(of: #"(\. |; | — | – |\n)"#, options: .regularExpression) { t = String(t[..<r.lowerBound]) }
    let words = t.split(separator: " ", omittingEmptySubsequences: true)
    if words.count > maxWords { return words.prefix(maxWords).joined(separator: " ") + "…" }
    return t
  }

  /// "3 files, +73 −5", "1 file, +2 −0".
  public static func evidence(_ a: PendingApproval) -> String? {
    if let d = a.diff, d.total > 0 { return "\(d.total) file\(d.total == 1 ? "" : "s"), +\(d.added) −\(d.removed)" }
    return a.branchLine
  }
}

extension CapcomdStore {
  /// Home's Running cards: every project with an active run, in the store's live order (the menu bar's: running first,
  /// then by its latest event), each speaking for the run its card would (the one asking, else the newest active).
  public func homeRuns(nowMs: Int = Int(Date().timeIntervalSince1970 * 1000)) -> [HomeRun] {
    projects.filter(\.isActive).map { p in
      let card = activeCard(p, nowMs: nowMs)
      var ask: HomeRun.Ask?
      if case .ask(let a) = card.body {
        let busy: Bool = { if case .submitting = a.approval.decision { return true }; return false }()
        ask = HomeRun.Ask(approvalId: a.approval.id, question: a.question, evidence: HomeRun.evidence(a.approval), busy: busy)
      }
      let ids = agentTree(runId: card.runId).flatMap(\.subtreeIds)
      return HomeRun(id: p.id, runId: card.runId, title: card.title, sandbox: runs[card.runId]?.sandbox, phrase: HomeRun.phrase(card.sentence),
                     startedAtMs: card.startedAtMs, agentIds: Array(ids.prefix(HomeRun.headsShown)), ask: ask)
    }
  }
}
