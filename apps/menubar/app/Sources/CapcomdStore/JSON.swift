import Foundation

/// Open JSON value. Payloads are open per events.md §6.2: unknown fields are kept here and ignored by the store.
public enum JSONValue: Codable, Hashable, Sendable {
  case null, bool(Bool), number(Double), string(String), array([JSONValue]), object([String: JSONValue])
  public init(from d: Decoder) throws {
    let c = try d.singleValueContainer()
    if c.decodeNil() { self = .null }
    else if let b = try? c.decode(Bool.self) { self = .bool(b) }
    else if let n = try? c.decode(Double.self) { self = .number(n) }
    else if let s = try? c.decode(String.self) { self = .string(s) }
    else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
    else { self = .object(try c.decode([String: JSONValue].self)) }
  }
  public func encode(to e: Encoder) throws {
    var c = e.singleValueContainer()
    switch self {
    case .null: try c.encodeNil()
    case .bool(let b): try c.encode(b)
    case .number(let n): try c.encode(n)
    case .string(let s): try c.encode(s)
    case .array(let a): try c.encode(a)
    case .object(let o): try c.encode(o)
    }
  }
  public subscript(_ k: String) -> JSONValue? { if case .object(let o) = self { return o[k] }; return nil }
  public var string: String? { if case .string(let s) = self { return s }; return nil }
  public var int: Int? { if case .number(let n) = self { return Int(n) }; return nil }
  public var array: [JSONValue]? { if case .array(let a) = self { return a }; return nil }
  public var isNull: Bool { if case .null = self { return true }; return false }
}

/// Contract timestamps (UTC, ISO 8601, 3 fraction digits) → epoch ms.
public func epochMs(iso: String?) -> Int? {
  guard let iso else { return nil }
  let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
  if let d = f.date(from: iso) { return Int(d.timeIntervalSince1970 * 1000) }
  f.formatOptions = [.withInternetDateTime]
  return f.date(from: iso).map { Int($0.timeIntervalSince1970 * 1000) }
}

/// harness.v1 envelope (openapi `events.replay` item / SSE frame data). Decoded leniently: unknown keys ignored.
public struct Envelope: Codable, Hashable, Sendable {
  public var v: Int?
  public var id: String
  public var scope: String
  public var seq: Int
  public var entity: String
  public var type: String
  public var ts: String?
  public var epochMs: Int
  public var projectId: String?
  public var runId: String?
  public var agentId: String?
  /// `durable` or `ephemeral`; ephemeral frames (agent.activity_changed) are live-only and never a resume cursor.
  public var durability: String?
  /// The daemon's plain-language sentence for the step, written from trusted fields only (never agent text).
  public var text: String?
  public var data: [String: JSONValue]
  public init(id: String, scope: String, seq: Int, entity: String, type: String, epochMs: Int, projectId: String?, runId: String?, agentId: String?, data: [String: JSONValue]) {
    self.v = 1; self.id = id; self.scope = scope; self.seq = seq; self.entity = entity; self.type = type; self.ts = nil
    self.epochMs = epochMs; self.projectId = projectId; self.runId = runId; self.agentId = agentId; self.data = data
  }
}
