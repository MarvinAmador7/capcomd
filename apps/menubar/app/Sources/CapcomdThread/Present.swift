import Foundation

/// What a click on a link does. Only the daemon's classification decides it, never the link's text.
public enum LinkAction: Sendable, Hashable {
  /// An http(s) URL, opened in the browser on an explicit click.
  case web(URL)
  case agent(String), run(String)
  /// A file of the agent's work, or an attachment the daemon holds: shown, not opened.
  case file(String), artifact(String)
  /// Plain text (javascript:, data:, mailto:, custom schemes, paths outside the workspace, anything unparseable).
  case none
}

extension Link {
  public var action: LinkAction {
    switch target {
    case .web:
      guard let h = href, let u = URL(string: h), let s = u.scheme?.lowercased(), s == "http" || s == "https", u.host != nil else { return .none }
      return .web(u)
    case .agent: return id.map(LinkAction.agent) ?? .none
    case .run: return id.map(LinkAction.run) ?? .none
    case .file: return path.map(LinkAction.file) ?? .none
    case .artifact: return id.map(LinkAction.artifact) ?? .none
    case .none: return .none
    }
  }

  /// Shown next to the link's text: a web link's host, or its full URL when the text points somewhere else
  /// (`mismatch`), so the reader always sees the real destination.
  public var destination: String? {
    guard case .web = action else { return nil }
    return mismatch ? href : host
  }
}

extension Item {
  /// "Thought for 8s": a thinking item's own duration when the CLI reported one, else the gap to the next item.
  public func thinkingSeconds(next: Item?) -> Int? {
    if let d = durationMs { return max(1, Int((Double(d) / 1000).rounded())) }
    guard let n = next, n.atMs > 0, atMs > 0, n.atMs >= atMs else { return nil }
    return max(1, Int((Double(n.atMs - atMs) / 1000).rounded()))
  }
}

/// A tool call's duration as the thread shows it: "0.4s", "2.1s", "12s", "3m 5s".
public func callDuration(ms: Int) -> String {
  if ms < 10_000 { return String(format: "%.1fs", Double(ms) / 1000) }
  let s = ms / 1000
  return s < 60 ? "\(s)s" : "\(s / 60)m \(s % 60)s"
}

/// Restrained highlighting (SPEC §4.5): keywords, strings, comments and numbers only, for a handful of languages;
/// anything else stays plain. A token never spans lines differently from the source: the text is reproduced exactly.
public enum Highlight {
  public enum Kind: Sendable, Hashable { case plain, keyword, string, comment, number }
  public struct Token: Sendable, Hashable { public var text: String; public var kind: Kind }

  public static func tokens(_ code: String, lang: String?) -> [Token] {
    guard let spec = Spec.for(lang) else { return [Token(text: code, kind: .plain)] }
    var out: [Token] = []
    let s = Array(code.unicodeScalars); var i = 0, plain = String.UnicodeScalarView()
    func flush() { if !plain.isEmpty { out.append(Token(text: String(plain), kind: .plain)); plain = .init() } }
    func take(_ kind: Kind, _ end: Int) { flush(); out.append(Token(text: String(String.UnicodeScalarView(s[i..<end])), kind: kind)); i = end }
    func starts(_ p: String) -> Bool { let ps = Array(p.unicodeScalars); return i + ps.count <= s.count && Array(s[i..<i + ps.count]) == ps }
    while i < s.count {
      let c = s[i]
      if let lc = spec.lineComments.first(where: starts) {
        _ = lc; var e = i; while e < s.count && s[e] != "\n" { e += 1 }; take(.comment, e); continue
      }
      if spec.blockComments && starts("/*") {
        var e = i + 2; while e + 1 < s.count && !(s[e] == "*" && s[e + 1] == "/") { e += 1 }; take(.comment, min(s.count, e + 2)); continue
      }
      if spec.quotes.contains(c) {
        var e = i + 1
        while e < s.count && s[e] != c && s[e] != "\n" { if s[e] == "\\" { e += 1 }; e += 1 }
        take(.string, min(s.count, e + 1)); continue
      }
      let prevWord = i > 0 && isWord(s[i - 1])
      if !prevWord && CharacterSet.decimalDigits.contains(c) {
        var e = i; while e < s.count && (isWord(s[e]) || s[e] == ".") { e += 1 }; take(.number, e); continue
      }
      if !prevWord && isWord(c) {
        var e = i; while e < s.count && isWord(s[e]) { e += 1 }
        let w = String(String.UnicodeScalarView(s[i..<e]))
        if spec.keywords.contains(spec.caseInsensitive ? w.uppercased() : w) { take(.keyword, e) } else { plain.append(contentsOf: s[i..<e]); i = e }
        continue
      }
      plain.append(c); i += 1
    }
    flush()
    return out
  }

  static func isWord(_ u: Unicode.Scalar) -> Bool { u == "_" || CharacterSet.alphanumerics.contains(u) }

  struct Spec {
    var keywords: Set<String>; var caseInsensitive = false
    var lineComments: [String]; var blockComments = false; var quotes: Set<Unicode.Scalar> = ["\"", "'"]
    static func `for`(_ lang: String?) -> Spec? {
      switch lang?.lowercased() {
      case "sql": Spec(keywords: ["SELECT", "FROM", "WHERE", "AND", "OR", "NOT", "NULL", "IS", "IN", "AS", "ON", "JOIN", "LEFT", "RIGHT", "INNER", "OUTER", "GROUP", "BY", "ORDER", "LIMIT", "INSERT", "INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE", "TABLE", "ALTER", "DROP", "WITH", "DISTINCT", "HAVING", "UNION", "CASE", "WHEN", "THEN", "ELSE", "END", "COUNT", "SUM", "AVG", "MIN", "MAX", "BIGINT", "TEXT", "INT", "INTEGER", "BOOLEAN", "PRIMARY", "KEY", "DESC", "ASC"], caseInsensitive: true, lineComments: ["--"], blockComments: true, quotes: ["'"])
      case "ts", "typescript", "js", "javascript", "tsx", "jsx": Spec(keywords: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "import", "export", "from", "async", "await", "new", "class", "extends", "type", "interface", "true", "false", "null", "undefined", "throw", "try", "catch", "of", "in", "switch", "case", "default", "break", "continue"], lineComments: ["//"], blockComments: true, quotes: ["\"", "'", "`"])
      case "swift": Spec(keywords: ["let", "var", "func", "return", "if", "else", "guard", "for", "while", "import", "struct", "class", "enum", "case", "switch", "default", "true", "false", "nil", "throw", "try", "await", "async", "public", "private", "static", "self", "in", "extension", "protocol"], lineComments: ["//"], blockComments: true, quotes: ["\""])
      case "py", "python": Spec(keywords: ["def", "return", "if", "elif", "else", "for", "while", "import", "from", "as", "class", "True", "False", "None", "and", "or", "not", "in", "is", "with", "try", "except", "raise", "lambda", "yield", "async", "await", "pass"], lineComments: ["#"])
      case "go": Spec(keywords: ["func", "return", "if", "else", "for", "range", "package", "import", "type", "struct", "interface", "var", "const", "nil", "true", "false", "go", "defer", "switch", "case", "default", "map", "chan"], lineComments: ["//"], blockComments: true, quotes: ["\"", "`"])
      case "rust", "rs": Spec(keywords: ["fn", "let", "mut", "return", "if", "else", "for", "while", "loop", "match", "use", "mod", "pub", "struct", "enum", "impl", "trait", "true", "false", "self", "async", "await", "where"], lineComments: ["//"], blockComments: true, quotes: ["\""])
      case "sh", "bash", "zsh", "shell", "console": Spec(keywords: ["if", "then", "else", "fi", "for", "do", "done", "while", "case", "esac", "function", "export", "local", "return", "in"], lineComments: ["#"])
      case "json": Spec(keywords: ["true", "false", "null"], lineComments: [], quotes: ["\""])
      default: nil
      }
    }
  }
}

/// A reviewer's verdict: capcomd's review contract has the reviewer answer `{"passed": true|false, "reasons": [...]}`,
/// as its whole message or as the last paragraph (or code block) after its prose. Every string in it is agent text.
public struct Verdict: Sendable, Hashable {
  public var passed: Bool
  public var reasons: [String]
  public init(passed: Bool, reasons: [String]) { self.passed = passed; self.reasons = reasons }

  /// The verdict in `raw` when it is that JSON and nothing else (a ```json fence around it is fine).
  public static func parse(_ raw: String) -> Verdict? {
    var t = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if t.hasPrefix("```"), t.hasSuffix("```"), let nl = t.firstIndex(of: "\n") {
      t = String(t[t.index(after: nl)..<t.index(t.endIndex, offsetBy: -3)]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
    guard t.hasPrefix("{"), t.hasSuffix("}"), t.utf8.count <= 64_000,
          let o = (try? JSONSerialization.jsonObject(with: Data(t.utf8))) as? [String: Any],
          let passed = o["passed"] as? Bool else { return nil }
    // JSON escapes can bring back what decoding stripped (\u202e): clean each reason again.
    let reasons = ((o["reasons"] as? [Any]) ?? []).compactMap { $0 as? String }.map(clean)
      .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    return Verdict(passed: passed, reasons: Array(reasons.prefix(50)))
  }
}

extension Item {
  /// A Claude Code system event an older daemon wrote as a line ("System: thinking_tokens", "System: permission_denied"):
  /// its bookkeeping, which newer daemons leave out (a refused call's own row says it was refused). Not shown.
  public var isSystemBookkeeping: Bool {
    guard kind == "other", text.hasPrefix("System: ") else { return false }
    let subtype = text.dropFirst("System: ".count)
    return !subtype.isEmpty && subtype.allSatisfy { $0 == "_" || ($0.isASCII && ($0.isLowercase || $0.isNumber)) }
  }

  /// A reviewer's hand-back: its verdict and the blocks after the paragraph that says it (the daemon writes that one
  /// for clients that don't read `child.verdict`); nil for any other item.
  public var handoffVerdict: (verdict: Verdict, rest: [Block])? {
    guard kind == "handoff", let v = child?.verdict else { return nil }
    guard case .paragraph? = blocks.first else { return (v, blocks) }
    return (v, Array(blocks.dropFirst()))
  }

  /// A message that ends in a verdict: the prose before it (maybe none) and the verdict; nil for any other message.
  public var verdictTail: (prose: [Block], verdict: Verdict)? {
    guard kind == "say" || kind == "result" else { return nil }
    guard let last = blocks.last else { return Verdict.parse(text).map { ([], $0) } }
    let raw: String
    switch last {
    case .paragraph(let inlines): raw = inlines.map(\.plain).joined()
    case .code(_, let text, _): raw = text
    default: return nil
    }
    return Verdict.parse(raw).map { (Array(blocks.dropLast()), $0) }
  }
}

// MARK: - Tool rows, call groups and thinking runs (thread v2: ThreadPolish-v2 on the design canvas)

/// Where a tool call stands, as its row's right edge says it: a running arc, a done tick, "Failed", "Not allowed".
public enum ToolStatus: Sendable, Hashable {
  case running, done, failed
  /// Its permission rules refused it: it never ran.
  case notAllowed
}

extension Item {
  /// The call was refused by its permission rules (`error.code` "refused"): it never ran.
  public var refused: Bool { kind == "tool" && error?.code == "refused" }

  public var toolStatus: ToolStatus {
    if open { return .running }
    if refused { return .notAllowed }
    return tool?.isError == true || error != nil ? .failed : .done
  }
}

extension Item.Tool {
  /// The tool's short name, in mono on its row: "Bash", "Read", "Glob"; capcomd's own tools by their verb ("spawn",
  /// "await"); another MCP server's tool by the tool's name; codex's item types as the step they are ("shell", "edit").
  public var displayName: String {
    if let m = Self.mcp(name) { return m.server == "capcomd" ? String(m.tool.trimmingPrefix("capcomd_")) : m.tool }
    switch name {
    case "command_execution": return "shell"
    case "file_change": return "edit"
    case "": return "tool"
    default: return name
    }
  }

  /// What the call was about, after its name: the summary without the verb the name already says ("Run bun test" →
  /// "bun test", "Search the code for email in src" → "email in src"). capcomd's own calls keep their phrase ("Spawn a
  /// worker"); another server's tool says the server.
  public var detail: String {
    if let m = Self.mcp(name), m.server != "capcomd" {
      return summary == "\(m.server): \(m.tool)" ? m.server : summary
    }
    for verb in Self.verbs where summary.hasPrefix(verb) && summary.count > verb.count {
      return String(summary.dropFirst(verb.count))
    }
    return summary
  }

  /// The verbs the daemon's summaries start with (packages/agent-thread summary.ts), longest first.
  static let verbs = ["Search the code for ", "Search the web for ", "Run ", "Read ", "Find ", "Edit ", "Write ", "List ", "Fetch ", "Delete "]

  /// `mcp__server__tool` (Claude Code) or `server.tool` (codex, fx).
  static func mcp(_ name: String) -> (server: String, tool: String)? {
    if name.hasPrefix("mcp__") {
      let rest = name.dropFirst(5)
      guard let r = rest.range(of: "__") else { return nil }
      return (String(rest[..<r.lowerBound]), String(rest[r.upperBound...]))
    }
    let parts = name.split(separator: ".", maxSplits: 1)
    guard parts.count == 2, !parts[0].isEmpty, !parts[1].isEmpty, !name.contains("/"), !name.contains(" ") else { return nil }
    return (String(parts[0]), String(parts[1]))
  }
}

/// Two or more finished tool calls in a row, as one line: "Used 3 tools · 2 not allowed · 5.0s". A refusal or a
/// failure is said in words, so folding the calls hides nothing.
public struct ToolRun: Sendable, Hashable {
  public var items: [Item]
  public init(_ items: [Item]) { self.items = items }

  public var count: Int { items.count }
  public var notAllowed: Int { items.filter { $0.toolStatus == .notAllowed }.count }
  public var failed: Int { items.filter { $0.toolStatus == .failed }.count }
  /// The calls' own durations added up (what they took, not the gaps between them); nil when none reported one.
  public var durationMs: Int? {
    let ds = items.compactMap(\.durationMs)
    return ds.isEmpty ? nil : ds.reduce(0, +)
  }
  /// The calls whose icons stack on the line: the first three.
  public var stacked: [Item] { Array(items.prefix(3)) }

  /// The line's words, in order: "Used 3 tools", then each note ("2 not allowed", "1 failed"), then the time.
  public var title: String { "Used \(count) tools" }
  public var notes: [String] {
    var out: [String] = []
    if notAllowed > 0 { out.append("\(notAllowed) not allowed") }
    if failed > 0 { out.append("\(failed) failed") }
    return out
  }
  public var duration: String? { durationMs.map { callDuration(ms: $0) } }
  /// For VoiceOver: the whole line in words.
  public var spoken: String { ([title] + notes + (duration.map { [$0] } ?? [])).joined(separator: ", ") }
}

/// Thinking items in a row, as one line: "Thinking · 5s" (their times added up); "Thinking" while the last one runs.
/// What the CLI hid is said inside, when the line is opened, not on it.
public struct ThinkingRun: Sendable, Hashable {
  public var items: [Item]
  /// The item after the run (the last thought's duration is the gap to it when the CLI reported none).
  public var next: Item?
  public init(_ items: [Item], next: Item?) { self.items = items; self.next = next }

  public var open: Bool { items.last?.open == true }
  /// Every thought in it was hidden by the CLI.
  public var hidden: Bool { items.allSatisfy(\.redacted) }
  /// The thoughts' times added up; nil when none can be told.
  public var seconds: Int? {
    var total = 0, any = false
    for (n, i) in items.enumerated() where !i.open {
      if let s = i.thinkingSeconds(next: n + 1 < items.count ? items[n + 1] : next) { total += s; any = true }
    }
    return any ? total : nil
  }
  /// While it thinks the line says only that (its clock runs beside it); done, the total.
  public var label: String {
    if open { return "Thinking" }
    return seconds.map { "Thinking · \($0)s" } ?? "Thinking"
  }
  public var spoken: String {
    if open { return "Thinking" }
    return seconds.map { "Thought for \($0) \($0 == 1 ? "second" : "seconds")" } ?? "Thought"
  }
}

extension Verdict {
  /// The seal's words: "Passed review" / "Didn't pass review".
  public var title: String { passed ? "Passed review" : "Didn't pass review" }
}
