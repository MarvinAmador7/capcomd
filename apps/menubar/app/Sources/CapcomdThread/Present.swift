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
