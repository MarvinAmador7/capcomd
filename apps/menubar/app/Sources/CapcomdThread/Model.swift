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
  /// The agent's bookkeeping (capability `agents.thread_internal`): a wake armed, a wait, a poll of its own state, a CLI
  /// system event. Recorded, and shown only on request.
  public var `internal`: Bool
  /// Kind question (capability `agents.ask`, ADR-026 §4): a question the agent asked, or one it answered, and what
  /// became of it. The thread's record of it: after a reconnect it is what rebuilds the answered or withdrawn line.
  public var question: Question?

  /// A question and its outcome. Its words (the question, the answer, the note) are someone's: plain text, cleaned.
  public struct Question: Sendable, Hashable, Decodable {
    public enum State: String, Sendable, Hashable { case open, answered, withdrawn }
    public var questionId: String
    /// The agent that asked: this thread's agent, or (another agent's item: one it was asked of, one that answered it,
    /// or the asker's root once it is the user's) the asker.
    public var asker: String
    public var state: State
    public var question: String
    /// The recommended answer first, then the asker's other options.
    public var options: [Option]
    /// The asker's reason for its recommendation; what waits on the answer.
    public var why: String?
    public var holds: String?
    /// Who it is asked of now (an agent), nil: the user.
    public var to: String?
    /// The agents that passed it up, in order.
    public var passedBy: [String]
    public var answer: String?
    /// Answered: whether it was the recommended answer.
    public var recommended: Bool?
    /// Who answered: an agent (agt-…) or a person (operator, driver, client:<id>).
    public var by: String?
    public var note: String?
    /// Answered: the agent whose earlier answer a person's answer replaced.
    public var replaces: String?
    public var askedAt: String
    /// When it was answered or withdrawn.
    public var decidedAt: String?
    public struct Option: Sendable, Hashable, Decodable {
      public var label: String
      public var recommended: Bool
      public init(label: String, recommended: Bool) { self.label = label; self.recommended = recommended }
      enum CodingKeys: String, CodingKey { case label, recommended }
      public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        label = clean(try c.decode(String.self, forKey: .label)); recommended = (try? c.decodeIfPresent(Bool.self, forKey: .recommended)) ?? false
      }
    }
    public init(questionId: String, asker: String, state: State, question: String, options: [Option] = [], why: String? = nil, holds: String? = nil,
                to: String? = nil, passedBy: [String] = [], answer: String? = nil, recommended: Bool? = nil,
                by: String? = nil, note: String? = nil, replaces: String? = nil, askedAt: String, decidedAt: String? = nil) {
      self.questionId = questionId; self.asker = asker; self.state = state; self.question = question; self.options = options; self.why = why
      self.holds = holds; self.to = to; self.passedBy = passedBy; self.answer = answer
      self.recommended = recommended; self.by = by; self.note = note; self.replaces = replaces; self.askedAt = askedAt; self.decidedAt = decidedAt
    }
    enum CodingKeys: String, CodingKey { case questionId, asker, state, question, options, why, holds, to, passedBy, answer, recommended, by, note, replaces, askedAt, decidedAt }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      questionId = try c.decode(String.self, forKey: .questionId); asker = try c.decode(String.self, forKey: .asker)
      guard let st = State(rawValue: try c.decode(String.self, forKey: .state)) else {
        throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "a question state this client doesn't know")
      }
      state = st
      question = clean(try c.decode(String.self, forKey: .question)); to = try c.decodeIfPresent(String.self, forKey: .to)
      options = (try? c.decodeIfPresent([Option].self, forKey: .options)) ?? []
      why = try c.decodeIfPresent(String.self, forKey: .why).map(clean); holds = try c.decodeIfPresent(String.self, forKey: .holds).map(clean)
      passedBy = (try? c.decodeIfPresent([String].self, forKey: .passedBy)) ?? []
      answer = try c.decodeIfPresent(String.self, forKey: .answer).map(clean); recommended = try c.decodeIfPresent(Bool.self, forKey: .recommended)
      by = try c.decodeIfPresent(String.self, forKey: .by); note = try c.decodeIfPresent(String.self, forKey: .note).map(clean)
      replaces = try c.decodeIfPresent(String.self, forKey: .replaces)
      askedAt = try c.decode(String.self, forKey: .askedAt); decidedAt = try c.decodeIfPresent(String.self, forKey: .decidedAt)
    }
    /// `decidedAt` as epoch milliseconds.
    public var decidedAtMs: Int? { decidedAt.flatMap(isoMs) }
  }

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
    /// The call's change to one file (harness #64); nil when it edits nothing or the CLI didn't report the lines.
    public var diff: Diff?
    enum CodingKeys: String, CodingKey { case callId, name, kind, summary, isError, args, output, files, diff }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      callId = try c.decode(String.self, forKey: .callId); name = clean(try c.decode(String.self, forKey: .name))
      kind = try c.decode(String.self, forKey: .kind); summary = clean(try c.decode(String.self, forKey: .summary))
      isError = try c.decode(Bool.self, forKey: .isError)
      args = try c.decodeIfPresent(String.self, forKey: .args).map(clean); output = try c.decodeIfPresent(String.self, forKey: .output).map(clean)
      files = try c.decodeIfPresent([Link].self, forKey: .files) ?? []
      diff = try? c.decodeIfPresent(Diff.self, forKey: .diff)   // a diff this client can't read is just not drawn
    }
  }
  /// A short line diff of one file: its first lines (at most 40, hunk gaps included); `added` / `removed` count all.
  public struct Diff: Sendable, Hashable, Decodable {
    public enum Op: Sendable, Hashable { case context, added, removed, gap }
    public struct Line: Sendable, Hashable, Decodable {
      public var op: Op
      public var text: String
      enum CodingKeys: String, CodingKey { case op, text }
      public init(from d: Decoder) throws {
        let c = try d.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .op) {
        case "+": op = .added
        case "-": op = .removed
        case "@": op = .gap
        default: op = .context   // an op we don't know reads as context
        }
        text = clean(try c.decode(String.self, forKey: .text))
      }
    }
    /// Relative to the workspace root; nil when the file is outside it.
    public var path: String?
    public var added: Int
    public var removed: Int
    public var lines: [Line]
    public var truncatedLines: Int?
    enum CodingKeys: String, CodingKey { case path, added, removed, lines, truncatedLines }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      path = try c.decodeIfPresent(String.self, forKey: .path).map(clean)
      added = try c.decode(Int.self, forKey: .added); removed = try c.decode(Int.self, forKey: .removed)
      lines = try c.decode([Line].self, forKey: .lines); truncatedLines = try c.decodeIfPresent(Int.self, forKey: .truncatedLines)
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
  public struct Child: Sendable, Hashable, Decodable {
    public var agentId: String
    public var status: String
    /// A reviewer's verdict (the daemon's `child.verdict`); the blocks then start with a paragraph that says it.
    public var verdict: Verdict?
    /// Its typed hand-back (handback@1, capability `agents.handback_typed`); the blocks say the same in prose.
    public var handback: Handback?
    public init(agentId: String, status: String, verdict: Verdict? = nil, handback: Handback? = nil) { self.agentId = agentId; self.status = status; self.verdict = verdict; self.handback = handback }
    struct WireFinding: Decodable { var text: String; var severity: String?; var file: String?; var line: Int? }
    struct WireVerdict: Decodable { var passed: Bool; var reasons: [String]?; var findings: [WireFinding]? }
    enum CodingKeys: String, CodingKey { case agentId, status, verdict, handback }
    public init(from d: Decoder) throws {
      let c = try d.container(keyedBy: CodingKeys.self)
      agentId = try c.decode(String.self, forKey: .agentId); status = try c.decode(String.self, forKey: .status)
      // A verdict this client can't read is no verdict: the blocks still say it.
      verdict = (try? c.decodeIfPresent(WireVerdict.self, forKey: .verdict))?.flatMap { $0 }.map { v in
        let findings = (v.findings ?? []).prefix(50).compactMap { f -> Finding? in
          let t = clean(f.text).trimmingCharacters(in: .whitespacesAndNewlines)
          return t.isEmpty ? nil : Finding(text: t, severity: f.severity.flatMap(Finding.Severity.init(rawValue:)), file: f.file.map(clean), line: f.line)
        }
        return Verdict(passed: v.passed, reasons: Array((v.reasons ?? []).map { clean($0).trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.prefix(50)), findings: findings)
      }
      // A hand-back this client can't read is none: the blocks still say it.
      handback = (try? c.decodeIfPresent(Handback.self, forKey: .handback)) ?? nil
    }
  }

  enum CodingKeys: String, CodingKey { case id, rev, seq, order, agentId, kind, status, at, durationMs, text, blocks, format, redacted, tool, error, truncated, child, `internal`, question }
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
    `internal` = (try? c.decodeIfPresent(Bool.self, forKey: .internal)) ?? false
    // A question this client can't read is none: the item still says it in `text`.
    question = (try? c.decodeIfPresent(Question.self, forKey: .question)) ?? nil
  }

  /// `at` as epoch milliseconds (0 if it doesn't parse).
  public var atMs: Int { isoMs(at) ?? 0 }
}

/// A child's typed hand-back (handback@1, ADR-026 §7): the outcome first, then what changed, how it was checked, risks and
/// decisions. Every string is agent text (plain, cleaned).
public struct Handback: Sendable, Hashable, Decodable {
  public enum Status: String, Sendable, Hashable { case done, partly, blocked }
  public enum Result: String, Sendable, Hashable { case passed, failed, notRun = "not run" }
  public struct Change: Sendable, Hashable {
    public var path: String; public var what: String?
    public init(path: String, what: String? = nil) { self.path = path; self.what = what }
  }
  public struct Check: Sendable, Hashable {
    public var check: String; public var result: Result; public var note: String?
    public init(check: String, result: Result, note: String? = nil) { self.check = check; self.result = result; self.note = note }
  }
  public var status: Status
  public var outcome: String
  public var changed: [Change]
  public var checked: [Check]
  public var risks: [String]
  public var decide: [String]
  public init(status: Status, outcome: String, changed: [Change] = [], checked: [Check] = [], risks: [String] = [], decide: [String] = []) {
    self.status = status; self.outcome = outcome; self.changed = changed; self.checked = checked; self.risks = risks; self.decide = decide
  }
  struct WireChange: Decodable { var path: String; var what: String? }
  struct WireCheck: Decodable { var check: String; var result: String; var note: String? }
  enum CodingKeys: String, CodingKey { case status, outcome, changed, checked, risks, decide }
  public init(from d: Decoder) throws {
    let c = try d.container(keyedBy: CodingKeys.self)
    let line = { (s: String) in clean(s).trimmingCharacters(in: .whitespacesAndNewlines) }
    // A status this client doesn't know reads as done: the outcome line still says what happened.
    status = Status(rawValue: try c.decode(String.self, forKey: .status)) ?? .done
    outcome = line(try c.decode(String.self, forKey: .outcome))
    changed = (try c.decodeIfPresent([WireChange].self, forKey: .changed) ?? []).prefix(50).compactMap { w in
      let p = line(w.path); return p.isEmpty ? nil : Change(path: p, what: w.what.map(line).flatMap { $0.isEmpty ? nil : $0 })
    }
    // A result this client doesn't know isn't shown as passed: it reads as not run.
    checked = (try c.decodeIfPresent([WireCheck].self, forKey: .checked) ?? []).prefix(20).compactMap { w in
      let k = line(w.check); return k.isEmpty ? nil : Check(check: k, result: Result(rawValue: w.result) ?? .notRun, note: w.note.map(line).flatMap { $0.isEmpty ? nil : $0 })
    }
    risks = (try c.decodeIfPresent([String].self, forKey: .risks) ?? []).prefix(10).map(line).filter { !$0.isEmpty }
    decide = (try c.decodeIfPresent([String].self, forKey: .decide) ?? []).prefix(10).map(line).filter { !$0.isEmpty }
  }
}

/// `GET /v1/runs/{runId}/agents/{agentId}/thread` page: items created or changed after `after`, in write order.
public struct Page: Sendable, Decodable {
  public var items: [Item]
  /// More are waiting: pass it as `after`. nil: you have everything.
  public var next: Int?
}

/// `GET /v1/runs/{runId}/agents/{agentId}/thread/tail` (capability `agents.thread_tail`): the newest items by position,
/// oldest first, each at its latest rev.
public struct Tail: Sendable, Decodable {
  public var items: [Item]
  /// Older items are waiting: pass it as `before` for the page above these. nil: these reach the thread's start.
  public var before: Int?
  /// The write cursor from just before these were read: the `after` that the thread route (and live frames) go on from.
  public var cursor: Int
  public init(items: [Item], before: Int?, cursor: Int) { self.items = items; self.before = before; self.cursor = cursor }
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
