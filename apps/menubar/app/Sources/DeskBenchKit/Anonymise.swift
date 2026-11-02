import Foundation
import CapcomdStore
#if canImport(CryptoKit)
import CryptoKit
#endif

/// Makes a captured run safe to keep (CAPABILITIES.md C8; owner's decision, SPEC §7.3): every piece of text is replaced
/// by generated text of the same length and shape (letters → words of the same length, digits → digits, whitespace,
/// newlines and punctuation kept, so headings, lists, code, tables and diffs lay out as they did), identifiers are
/// hashed with a per-capture salt (prefix kept, consistent across the capture: `agt-…` in an event, a thread item and
/// a link still match), URLs become `https://example.com/…` of the same length, hosts `example.com`, and times move
/// by one constant (intervals and durations kept). Structure is kept: block types, list nesting, table shape,
/// enum-like fields (`kind`, `status`, `t`, `op`, …) and numbers.
///
/// It works on raw JSON, key by key, so a field the daemon adds later is replaced as text unless it is known to be
/// safe: the default is to replace.
public struct Anonymiser {
  let salt: Data
  /// Added to every epoch-ms time (and every ISO time in a time field).
  public let shiftMs: Int
  var ids: [String: String] = [:]

  /// `salt` nil: a random one (the default; then nothing links two captures). `shiftMs`: what to add to times.
  public init(salt: Data? = nil, shiftMs: Int = 0) {
    self.salt = salt ?? Data((0..<16).map { _ in UInt8.random(in: 0...255) })
    self.shiftMs = shiftMs
  }

  // MARK: rules

  /// Keys whose string values are machine words, kept when they look like one.
  static let words: [String: (String) -> Bool] = {
    let token: (String) -> Bool = { s in s.count <= 48 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "._:-/".contains($0)) } }
    let lower: (String) -> Bool = { s in s.count <= 32 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || "._-".contains($0)) } }
    var d: [String: (String) -> Bool] = [:]
    for k in ["type", "t", "kind", "status", "format", "op", "durability", "state", "phase", "role", "decision", "encoding", "severity", "mode", "effort", "feed"] { d[k] = lower }
    for k in ["provider", "model", "sandbox"] { d[k] = token }
    for k in ["cause", "code"] { d[k] = { s in s.count <= 40 && s.allSatisfy { $0.isASCII && ($0.isLowercase || $0.isNumber || "_.-".contains($0)) } } }
    d["mime"] = { s in s.count <= 64 && s.contains("/") && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "/.+-".contains($0)) } }
    d["lang"] = { s in s.count <= 20 && s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "+#._-".contains($0)) } }
    d["align"] = { ["left", "right", "center"].contains($0) }
    d["target"] = { ["web", "artifact", "file", "agent", "run", "none"].contains($0) }
    d["profile"] = { ["planner", "lead", "worker", "critic", "verifier", "reviewer", "researcher", "tester", "fixer", "writer", "designer", "operator"].contains($0) }
    d["name"] = { toolNames.contains($0) }
    return d
  }()
  /// Tool names common to the agent CLIs: kept so a tool row shows its usual icon and label. Anything else (an MCP
  /// tool's name says what it talks to) is text.
  static let toolNames: Set<String> = ["Read", "Write", "Edit", "MultiEdit", "Bash", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Task", "TodoWrite", "NotebookEdit",
                                       "NotebookRead", "BashOutput", "KillShell", "ExitPlanMode", "apply_patch", "shell", "exec_command", "update_plan", "view_image",
                                       "read_file", "write_file", "list_dir", "search", "web_search"]
  static func idKey(_ k: String) -> Bool {
    k == "id" || k.hasSuffix("Id") || k.hasSuffix("Ids") || ["entity", "scope", "parent", "key", "by", "callId", "seqId"].contains(k)
  }
  static func timeKey(_ k: String) -> Bool { k == "at" || k == "ts" || k.hasSuffix("At") }
  static func epochKey(_ k: String) -> Bool { k == "epochMs" || k.hasSuffix("AtMs") || k.hasSuffix("EpochMs") }
  static func urlKey(_ k: String) -> Bool { ["href", "url", "src", "uri", "link"].contains(k) }

  // MARK: values

  /// A JSON value found under `key` (array elements inherit their array's key).
  public mutating func value(_ v: JSONValue, key: String?) -> JSONValue {
    switch v {
    case .string(let s): return .string(string(s, key: key))
    case .number(let n): return key.map(Self.epochKey) == true ? .number(n + Double(shiftMs)) : v
    case .array(let a): return .array(a.map { value($0, key: key) })
    case .object(let o):
      var out: [String: JSONValue] = [:]
      for (k, x) in o { out[k] = value(x, key: k) }
      return .object(out)
    default: return v
    }
  }

  mutating func string(_ s: String, key: String?) -> String {
    guard let k = key else { return text(s) }
    if Self.idKey(k) { return id(s) }
    if Self.timeKey(k), let t = epochMs(iso: s) { return Self.iso(t + shiftMs) }
    if Self.urlKey(k) { return url(s) }
    if k == "host" { return "example.com" }
    if let ok = Self.words[k], ok(s) { return s }
    return text(s)
  }

  /// `agt-7f3a…`: the prefix kept (letters and one `-`, `_` or `:`), the rest a salted hash of the same length (at
  /// least 6 hex digits). The same id always maps to the same hash within one Anonymiser.
  public mutating func id(_ s: String) -> String {
    if s.isEmpty { return s }
    if let done = ids[s] { return done }
    var prefix = ""
    if let i = s.firstIndex(where: { "-_:".contains($0) }), s.distance(from: s.startIndex, to: i) <= 8, s[..<i].allSatisfy(\.isLetter) {
      prefix = String(s[...i])
    }
    let body = s.count - prefix.count
    var hex = Self.hex(salt + Data(s.utf8))
    while hex.count < max(6, body) { hex += Self.hex(salt + Data((hex + s).utf8)) }
    let out = prefix + String(hex.prefix(max(6, body)))
    ids[s] = out
    return out
  }

  /// Same length, same shape, none of the words: each run of letters becomes a word of the same length (capitals
  /// where the original had them), each digit a digit; everything else (spaces, newlines, punctuation, markdown
  /// markers, brackets, emoji) stays where it was. URLs inside the text become example.com of the same length.
  public mutating func text(_ s: String) -> String {
    if s.isEmpty { return s }
    var g = Self.gen(salt + Data(s.utf8))
    var out = ""
    let chars = Array(Self.stripURLs(s))
    var i = 0
    while i < chars.count {
      let c = chars[i]
      if c == "\u{1}" {                                                       // a URL (stripURLs): example.com, same length
        var j = i + 1
        while j < chars.count && chars[j] == "\u{2}" { j += 1 }
        out += String((url(String(repeating: "x", count: j - i)) + String(repeating: "x", count: j - i)).prefix(j - i))
        i = j; continue
      }
      if c.isLetter {
        var j = i
        while j < chars.count && chars[j].isLetter { j += 1 }
        out += Self.word(length: j - i, like: Array(chars[i..<j]), &g)
        i = j; continue
      }
      if c.isNumber { out.append(Character(String(g.next() % 10))); i += 1; continue }
      out.append(c); i += 1
    }
    return out
  }

  /// `https://example.com/…`, the original's length when it was longer.
  public func url(_ s: String) -> String {
    let base = "https://example.com/"
    return s.count <= base.count ? base : base + String(repeating: "x", count: s.count - base.count)
  }

  // MARK: helpers

  /// Marks URLs: a URL of n characters becomes \u{1} and n − 1 \u{2}s, which `text` turns into example.com.
  static func stripURLs(_ s: String) -> String {
    guard s.contains("://") || s.contains("www.") else { return s }
    let pattern = #"([A-Za-z][A-Za-z0-9+.-]{1,15}://|www\.)[^\s<>"'`()\[\]{}]+"#
    guard let re = try? NSRegularExpression(pattern: pattern) else { return s }
    let ns = s as NSString
    var out = "", last = 0
    for m in re.matches(in: s, range: NSRange(location: 0, length: ns.length)) {
      out += ns.substring(with: NSRange(location: last, length: m.range.location - last))
      let n = ns.substring(with: m.range).count
      out += "\u{1}" + String(repeating: "\u{2}", count: max(0, n - 1))
      last = m.range.location + m.range.length
    }
    out += ns.substring(from: last)
    return out
  }

  static let vocabulary: [Int: [String]] = {
    let words = """
    a I an as at be by do go he if in is it me my no of on or so to up us we and are but can did end few for get had has her him his how its let may new not now old one our out own put run say see set she the too two use was way who why yes yet able also back been both call came come down each even find from give good have here into just keep kind know last like line long look made make many more most much must name near next only open over part plan read same seem show side some such sure take tell than that them then they this time turn very want well went what when will with word work year about after again along being below bring build check close could early every first found front given going great group heavy issue large later leave light might model never often order other paper place point quite right round shall short since small sound start state still study table taken their there these thing think three today under until value water where which while whole world would write ahead change number before second simple single little moment always people should system result branch commit
    """.split(whereSeparator: \.isWhitespace).map(String.init)
    return Dictionary(grouping: words, by: \.count)
  }()

  static func word(length n: Int, like original: [Character], _ g: inout Gen) -> String {
    var w: String
    if let list = vocabulary[n], !list.isEmpty { w = list[Int(g.next() % UInt64(list.count))] }
    else { w = String((0..<n).map { _ in Character(UnicodeScalar(UInt8(97 + Int(g.next() % 26)))) }) }
    if original.count > 1, original.allSatisfy(\.isUppercase) { return w.uppercased() }
    if original.first?.isUppercase == true { return w.prefix(1).uppercased() + w.dropFirst() }
    return w.lowercased()
  }

  static func gen(_ d: Data) -> Gen {
    let h = digest(d)
    return Gen(seed: h.prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) })
  }
  static func hex(_ d: Data) -> String { digest(d).map { String(format: "%02x", $0) }.joined() }
  static func digest(_ d: Data) -> [UInt8] {
    #if canImport(CryptoKit)
    return Array(SHA256.hash(data: d))
    #else
    // FNV-1a, widened: only where CryptoKit is missing (the bench is macOS-only; this keeps the module building).
    var out: [UInt8] = []
    var h: UInt64 = 14695981039346656037
    for round in 0..<4 { for b in d { h = (h ^ UInt64(b)) &* 1099511628211 }; h ^= UInt64(round); for k in 0..<8 { out.append(UInt8((h >> (8 * k)) & 0xFF)) } }
    return out
    #endif
  }
  static func iso(_ ms: Int) -> String {
    let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f.string(from: Date(timeIntervalSince1970: Double(ms) / 1000))
  }
}
