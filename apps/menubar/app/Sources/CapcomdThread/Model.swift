import Foundation

/// harness.v1 thread items in format `blocks/1` (docs/harness-contract.md, "Agent threads"): the daemon parses each
/// message once into a block tree, so the app renders structure without parsing markdown. The structure (block and
/// inline types, link targets, media sources) is the daemon's; every string inside is agent-written plain text. Decoding
/// strips control and bidi characters from those strings (defence in depth: the daemon already does), and nothing here
/// ever interprets them as markdown, HTML or a URL to follow.
public let threadFormat = "blocks/1"

public struct Item: Sendable, Hashable, Identifiable, Decodable {
  public var id: String
  public var rev: Int
  /// Run-wide write cursor: the highest one seen is the `after` for the next read.
  public var seq: Int
  /// Position in the thread; it never changes.
  public var order: Int
  public var agentId: String
  /// say, thinking, tool, error, result, plan, handoff, other; more may be added (render those as `text`).
  public var kind: String
  public var open: Bool
  public var at: String
  public var durationMs: Int?
  public var text: String
  /// Empty when `format` isn't one this client knows: render `text` instead.
  public var blocks: [Block]
  public var format: String
  public var redacted: Bool
  public var tool: Tool?
  public var error: ItemError?
  public var truncated: Truncated?
  public var child: Child?

  public struct Tool: Sendable, Hashable, Decodable {
    public var callId: String
    public var name: String
    /// Icon hint (Agent.activity kinds); an unknown one is a plain tool.
    public var kind: String
    public var summary: String
    public var isError: Bool
    public var args: String?
    public var output: String?
    public var files: [Link]
    enum CodingKeys: String, CodingKey { case callId, name, kind, summary, isError, args, output, files }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      callId = try c.decode(String.self, forKey: .callId); name = clean(try c.decode(String.self, forKey: .name))
      kind = try c.decode(String.self, forKey: .kind); summary = clean(try c.decode(String.self, forKey: .summary))
      isError = try c.decode(Bool.self, forKey: .isError)
      args = try c.decodeIfPresent(String.self, forKey: .args).map(clean); output = try c.decodeIfPresent(String.self, forKey: .output).map(clean)
      files = try c.decodeIfPresent([Link].self, forKey: .files) ?? []
    }
  }
  public struct ItemError: Sendable, Hashable, Decodable {
    public var message: String
    public var code: String?
    enum CodingKeys: String, CodingKey { case message, code }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      message = clean(try c.decode(String.self, forKey: .message)); code = try c.decodeIfPresent(String.self, forKey: .code)
    }
  }
  public struct Truncated: Sendable, Hashable, Decodable { public var blocks: Int; public var bytes: Int }
  public struct Child: Sendable, Hashable, Decodable { public var agentId: String; public var status: String }

  enum CodingKeys: String, CodingKey { case id, rev, seq, order, agentId, kind, status, at, durationMs, text, blocks, format, redacted, tool, error, truncated, child }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    id = try c.decode(String.self, forKey: .id); rev = try c.decode(Int.self, forKey: .rev)
    seq = try c.decode(Int.self, forKey: .seq); order = try c.decode(Int.self, forKey: .order)
    agentId = try c.decode(String.self, forKey: .agentId); kind = try c.decode(String.self, forKey: .kind)
    open = try c.decode(String.self, forKey: .status) == "open"
    at = try c.decode(String.self, forKey: .at); durationMs = try c.decodeIfPresent(Int.self, forKey: .durationMs)
    text = clean(try c.decode(String.self, forKey: .text))
    format = try c.decode(String.self, forKey: .format)
    blocks = format == threadFormat ? try c.decode([Block].self, forKey: .blocks) : []
    redacted = try c.decodeIfPresent(Bool.self, forKey: .redacted) ?? false
    tool = try c.decodeIfPresent(Tool.self, forKey: .tool); error = try c.decodeIfPresent(ItemError.self, forKey: .error)
    truncated = try c.decodeIfPresent(Truncated.self, forKey: .truncated); child = try c.decodeIfPresent(Child.self, forKey: .child)
  }

  /// `at` as epoch milliseconds (0 if it doesn't parse).
  public var atMs: Int { isoMs(at) ?? 0 }
}

/// `GET /v1/runs/{runId}/agents/{agentId}/thread` page: items created or changed after `after`, in write order.
public struct Page: Sendable, Decodable {
  public var items: [Item]
  /// More are waiting: pass it as `after`. nil: you have everything.
  public var next: Int?
}

public struct Link: Sendable, Hashable, Decodable {
  public enum Target: String, Sendable, Hashable { case web, artifact, file, agent, run, none }
  public var text: String
  public var href: String?
  public var target: Target
  public var host: String?
  public var id: String?
  public var path: String?
  public var mismatch: Bool
  enum CodingKeys: String, CodingKey { case text, href, target, host, id, path, mismatch }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    text = clean(try c.decode(String.self, forKey: .text)); href = try c.decodeIfPresent(String.self, forKey: .href).map(clean)
    target = Target(rawValue: try c.decode(String.self, forKey: .target)) ?? .none   // a target we don't know is plain text
    host = try c.decodeIfPresent(String.self, forKey: .host).map(clean); id = try c.decodeIfPresent(String.self, forKey: .id)
    path = try c.decodeIfPresent(String.self, forKey: .path).map(clean); mismatch = try c.decodeIfPresent(Bool.self, forKey: .mismatch) ?? false
  }
}

public indirect enum Inline: Sendable, Hashable, Decodable {
  case text(String), code(String), strong([Inline]), em([Inline]), strike([Inline]), link(Link), lineBreak
  /// A node type this client doesn't know: its `text`, if it has one.
  case unknown(String?)
  enum CodingKeys: String, CodingKey { case t, text, children }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    let text = { try c.decodeIfPresent(String.self, forKey: .text).map(clean) }
    let kids = { try c.decodeIfPresent([Inline].self, forKey: .children) ?? [] }
    switch try c.decode(String.self, forKey: .t) {
    case "text": self = .text(try text() ?? "")
    case "code": self = .code(try text() ?? "")
    case "strong": self = .strong(try kids())
    case "em": self = .em(try kids())
    case "strike": self = .strike(try kids())
    case "link": self = .link(try Link(from: d))
    case "break": self = .lineBreak
    default: self = .unknown(try text())
    }
  }
  /// The node as plain text (copy, accessibility).
  public var plain: String {
    switch self {
    case .text(let s), .code(let s): s
    case .strong(let k), .em(let k), .strike(let k): k.map(\.plain).joined()
    case .link(let l): l.text
    case .lineBreak: "\n"
    case .unknown(let s): s ?? ""
    }
  }
}

public struct ListItem: Sendable, Hashable, Decodable {
  /// Task list item: done or not; nil for a plain item.
  public var checked: Bool?
  public var blocks: [Block]
}

public struct Table: Sendable, Hashable, Decodable {
  public enum Align: String, Sendable, Hashable, Decodable { case left, center, right }
  public var align: [Align?]
  public var header: [[Inline]]
  public var rows: [[[Inline]]]
  public var truncatedRows: Int?
  public var truncatedCols: Int?
}

public struct Media: Sendable, Hashable, Decodable {
  public enum Kind: String, Sendable, Hashable { case image, video, audio, file }
  public enum Source: Sendable, Hashable {
    /// Bytes the daemon holds: `GET /v1/runs/{runId}/attachments/{id}/content` (also a tool's `inline` image).
    case attachment(id: String)
    /// A file of the agent's latest work: `GET /v1/runs/{runId}/agents/{agentId}/workspace?path=`.
    case workspace(path: String)
    /// Never loads by itself: only on an explicit click.
    case remote(url: String, host: String)
    case unknown
  }
  public var kind: Kind
  public var source: Source
  public var alt: String
  public var mime: String?
  public var bytes: Int?
  public var width: Int?
  public var height: Int?
  enum CodingKeys: String, CodingKey { case kind, source, alt, mime, bytes, width, height }
  enum SourceKeys: String, CodingKey { case type, id, attachmentId, path, url, host }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    kind = Kind(rawValue: try c.decode(String.self, forKey: .kind)) ?? .file
    let s = try c.nestedContainer(keyedBy: SourceKeys.self, forKey: .source)
    switch try s.decode(String.self, forKey: .type) {
    case "attachment": source = .attachment(id: try s.decode(String.self, forKey: .id))
    case "inline": source = .attachment(id: try s.decode(String.self, forKey: .attachmentId))
    case "workspace": source = .workspace(path: clean(try s.decode(String.self, forKey: .path)))
    case "remote": source = .remote(url: clean(try s.decode(String.self, forKey: .url)), host: clean(try s.decode(String.self, forKey: .host)))
    default: source = .unknown
    }
    alt = clean(try c.decodeIfPresent(String.self, forKey: .alt) ?? "")
    mime = try c.decodeIfPresent(String.self, forKey: .mime); bytes = try c.decodeIfPresent(Int.self, forKey: .bytes)
    width = try c.decodeIfPresent(Int.self, forKey: .width); height = try c.decodeIfPresent(Int.self, forKey: .height)
  }
}

public indirect enum Block: Sendable, Hashable, Decodable {
  case paragraph([Inline])
  case heading(level: Int, [Inline])
  case list(ordered: Bool, start: Int?, items: [ListItem])
  case code(lang: String?, text: String, truncatedLines: Int?)
  case table(Table)
  case quote([Block])
  case rule
  case media(Media)
  /// Reserved for token streaming: the trailing block still being written, as plain text.
  case open(String)
  /// A block type this client doesn't know: its `text`, if it has one (else skip it).
  case unknown(String?)
  enum CodingKeys: String, CodingKey { case t, children, level, ordered, start, items, lang, text, truncatedLines, blocks }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    let kids = { try c.decodeIfPresent([Inline].self, forKey: .children) ?? [] }
    switch try c.decode(String.self, forKey: .t) {
    case "paragraph": self = .paragraph(try kids())
    case "heading": self = .heading(level: min(3, max(1, try c.decodeIfPresent(Int.self, forKey: .level) ?? 3)), try kids())
    case "list": self = .list(ordered: try c.decodeIfPresent(Bool.self, forKey: .ordered) ?? false, start: try c.decodeIfPresent(Int.self, forKey: .start),
                              items: try c.decodeIfPresent([ListItem].self, forKey: .items) ?? [])
    case "code": self = .code(lang: try c.decodeIfPresent(String.self, forKey: .lang).map(clean), text: clean(try c.decode(String.self, forKey: .text)),
                              truncatedLines: try c.decodeIfPresent(Int.self, forKey: .truncatedLines))
    case "table": self = .table(try Table(from: d))
    case "quote": self = .quote(try c.decodeIfPresent([Block].self, forKey: .blocks) ?? [])
    case "rule": self = .rule
    case "media": self = .media(try Media(from: d))
    case "open": self = .open(clean(try c.decodeIfPresent(String.self, forKey: .text) ?? ""))
    default: self = .unknown(try c.decodeIfPresent(String.self, forKey: .text).map(clean))
    }
  }
}

/// Drops C0/C1 controls (newline and tab stay) and bidi overrides from agent-written text.
func clean(_ raw: String) -> String {
  var out = String.UnicodeScalarView()
  for u in raw.unicodeScalars {
    let v = u.value
    if v == 0x0A || v == 0x09 { out.append(u); continue }
    if v < 0x20 || (0x7F...0x9F).contains(v) { continue }
    if (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0x200E || v == 0x200F { continue }
    out.append(u)
  }
  return String(out)
}

/// ISO 8601 UTC with or without milliseconds → epoch ms.
func isoMs(_ s: String) -> Int? {
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: s) { return Int(d.timeIntervalSince1970 * 1000) }
  f.formatOptions = [.withInternetDateTime]
  return f.date(from: s).map { Int($0.timeIntervalSince1970 * 1000) }
}
