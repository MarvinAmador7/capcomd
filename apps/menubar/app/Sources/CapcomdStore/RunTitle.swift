import Foundation

/// A run's title: a short name for the work, so Recent and the Active cards say which run is which (harness.v1
/// `Run.title`). A port of the daemon's rules (src/api/run-title.ts), checked against the same fixture
/// (tests/api/run-titles.json): the app titles runs the same way when the daemon is older, and before a newer title
/// reaches it (a merge lands on the live feed before the run is read again).
public struct RunTitle: Sendable, Hashable {
  /// Where the title came from, best first: the run's label (when it isn't just its goal), the merged work's commit
  /// and pull request subject, the goal, the first agent's task. A source this app doesn't know ranks first: the
  /// daemon only adds better ones.
  public enum Source: Sendable, Hashable {
    case label, merge, goal, task, other(String)
    public init(wire: String) {
      switch wire { case "label": self = .label; case "merge": self = .merge; case "goal": self = .goal; case "task": self = .task; default: self = .other(wire) }
    }
    public var rank: Int { switch self { case .other: 5; case .label: 4; case .merge: 3; case .goal: 2; case .task: 1 } }
  }
  public var text: String
  public var source: Source
  /// The line the title was cut from (cleaned), for its tooltip; the title itself when it wasn't cut.
  public var full: String
  public init(text: String, source: Source, full: String? = nil) { self.text = text; self.source = source; self.full = full ?? text }

  /// A run with no label, goal or task yet.
  public static let untitled = "Untitled run"
  /// About a git subject line; longer text is cut where a clause ends, else at a word with "…".
  public static let max = 50
  static let min = 12, weakMin = 24

  // Clause boundaries, strongest first. The first sentence is the title; within the weaker tiers, the longest clause.
  static let tiers: [[String]] = [
    [". ", "! ", "? ", "; ", "。", "！", "？", "；"],
    [": ", " — ", " – ", " - ", "：", " ("],
    [", ", " and ", " then ", " so that ", " because ", " with ", " by ", " which ", "，", "、"],
  ]
  nonisolated(unsafe) static let marker = try! Regex(#"^(#{1,6}\s+|[-*+•]\s+|>\s*|[0-9]{1,3}[.)]\s+|\[[ x]\]\s+|\[agent:[^\]]*\]\s*)"#).ignoresCase()
  nonisolated(unsafe) static let polite = try! Regex(#"^(please,?|pls,?|kindly|(can|could|would|will) you( please)?)\s+"#).ignoresCase()
  nonisolated(unsafe) static let trailing = try! Regex(#"[\s.,;:!。、，；：]+$"#)
  nonisolated(unsafe) static let questions = try! Regex(#"\?+$"#)
  nonisolated(unsafe) static let dangling = try! Regex(#"\s+(a|an|the|and|or|to|of|for|with|in|on|at|by|from|into)$"#).ignoresCase()
  nonisolated(unsafe) static let danglingMarks = try! Regex(#"[\s,;:(\-—–]+$"#)

  static func collapse(_ s: String) -> String { s.split(whereSeparator: \.isWhitespace).joined(separator: " ") }

  /// One line, cleaned: whitespace collapsed, list and heading markers, backticks, bold markers and a leading
  /// "please" / "can you" dropped, no trailing punctuation.
  public static func clean(_ line: String) -> String {
    var s = collapse(line)
    while true { let next = collapse(s.replacing(marker, with: "", maxReplacements: 1)); if next == s { break }; s = next }
    s = collapse(s.replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "**", with: ""))
    if let m = s.firstMatch(of: polite), m.range.upperBound < s.endIndex {
      s = String(s[m.range.upperBound...]).replacing(questions, with: "")
      if let c = s.first { s = c.uppercased() + s.dropFirst() }
    }
    return s.replacing(trailing, with: "")
  }

  /// Opened brackets are all closed (a cut inside "multiply(a, b)" would leave half of it).
  static func balanced(_ s: Substring) -> Bool {
    var depth = 0
    for c in s {
      if c == "(" || c == "[" || c == "{" { depth += 1 } else if (c == ")" || c == "]" || c == "}") && depth > 0 { depth -= 1 }
    }
    return depth == 0
  }

  /// A short title for a goal, label or task (see the daemon's `shortTitle`); nil when there's no text.
  /// The first line with text in it, cleaned: what a title is cut from.
  public static func firstLine(_ text: String?) -> String? {
    text?.split(whereSeparator: \.isNewline).lazy.map({ clean(String($0)) }).first(where: { !$0.isEmpty })
  }

  public static func short(_ text: String?) -> String? {
    guard let s = firstLine(text) else { return nil }
    if s.count <= max { return s }
    for (i, tier) in tiers.enumerated() {
      var best: String?
      for sep in tier {
        var from = s.startIndex
        while let r = s.range(of: sep, range: from..<s.endIndex) {
          from = s.index(after: r.lowerBound)
          let head = String(s[..<r.lowerBound]).replacing(trailing, with: "")
          let n = head.count
          if n > max { break }
          if n < (i == 2 ? weakMin : min) || !balanced(Substring(head)) { continue }
          if best == nil || (i == 0 ? n < best!.count : n > best!.count) { best = head }
          if i == 0 { break }
        }
      }
      if let best { return best }
    }
    let cut = String(s.prefix(max - 1))
    if let space = cut.lastIndex(of: " "), space > cut.startIndex, cut[..<space].count >= min {
      var head = String(cut[..<space])
      while true {
        let next = head.replacing(dangling, with: "").replacing(danglingMarks, with: "")
        if next == head { break }; head = next
      }
      return head + "…"
    }
    return String(cut.reversed().drop(while: \.isWhitespace).reversed()) + "…"
  }

  /// The run's title from what the app knows of it (the daemon's rules: see `Source`). The merged work names the run
  /// only when exactly one agent's work merged. `agents` in spawn order.
  public static func of(label: String?, goal: String?, agents: [Agent]) -> RunTitle? {
    func titled(_ text: String?, _ source: Source) -> RunTitle? { short(text).map { RunTitle(text: $0, source: source, full: firstLine(text)) } }
    let g = titled(goal, .goal)
    if let l = titled(label, .label), l.text != g?.text { return l }
    let merged = agents.filter { $0.merge?.state == "merged" }
    if merged.count == 1, let t = titled(merged[0].task?.plain, .merge) { return t }
    return g ?? titled(agents.first { $0.parent == nil }?.task?.plain, .task)
  }
}

extension Run {
  /// The title to show: the app's own (it follows the live feed) or the daemon's (`Run.title`), whichever comes from
  /// the better source; the daemon's on a tie. Nil when the run has no label, goal or task yet.
  public var titled: RunTitle? {
    let local = RunTitle.of(label: label, goal: goal?.plain, agents: agents.values.sorted { ($0.spawnedAtMs, $0.id) < ($1.spawnedAtMs, $1.id) })
    guard let daemon = daemonTitle else { return local }
    guard let local else { return daemon }
    return local.source.rank > daemon.source.rank ? local : daemon
  }
}

extension Project {
  /// The goal's first line, when the title doesn't already say it (a title cut from the goal, or a merged subject
  /// that is the goal's own words): the card never shows the same words twice.
  public var goalLine: String? {
    guard let g = goal.map({ RunTitle.clean($0.firstLine) }), !g.isEmpty else { return nil }
    let t = title.hasSuffix("…") ? String(title.dropLast()) : title
    let (gl, tl) = (g.lowercased(), t.lowercased())
    return gl.hasPrefix(tl) || tl.hasPrefix(gl) ? nil : g
  }
  /// The title in full, for a tooltip: the line it was cut from (a daemon's title cut from the goal: the goal's).
  public var fullTitle: String {
    guard let t = runs.lazy.compactMap(\.titled).first else { return title }
    let goalFull = t.source == .goal && t.full == t.text ? goal.flatMap { RunTitle.firstLine($0.plain) } : nil
    let full = goalFull ?? t.full
    return full.count > 400 ? String(full.prefix(399)) + "…" : full
  }
}
