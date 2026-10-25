import Foundation

/// One parsed SSE frame from `GET /v1/streams/{scope}/events` (docs/events.md "Stream frames").
public enum StreamFrame: Sendable, Hashable {
  case event(Envelope)
  case reset(snapshotSeq: Int?, reason: String?)
  case snapshotRun(SnapshotRun)
  case snapshotAgents([SnapshotAgent])
  case snapshotApprovals([SnapshotApproval])
  case snapshotEnd(snapshotSeq: Int)
  case ignored(String)

  /// Parses `event:` name plus `data:` JSON. Accepts the contract (`event: <type>`) and the mock's legacy shape
  /// (`event: event`, reset as `data: {"type":"stream.reset","seq":n}`).
  public static func parse(event: String, data: String) -> StreamFrame {
    guard let bytes = data.data(using: .utf8) else { return .ignored(event) }
    let dec = JSONDecoder()
    let obj = (try? dec.decode([String: JSONValue].self, from: bytes)) ?? [:]
    let payload: [String: JSONValue] = {
      // Snapshot/reset frames may be bare payloads or wrapped in an envelope's `data`.
      if case .object(let inner)? = obj["data"], obj["seq"] != nil, obj["scope"] != nil { return inner }
      return obj
    }()
    let name = event == "message" || event == "event" ? (obj["type"]?.string ?? event) : event
    switch name {
    case "stream.reset": return .reset(snapshotSeq: payload["snapshotSeq"]?.int ?? payload["seq"]?.int, reason: payload["reason"]?.string)
    case "snapshot.run": return (try? dec.decode(SnapshotRunFrame.self, from: reencode(payload))).map { .snapshotRun($0.run) } ?? .ignored(name)
    case "snapshot.agents": return (try? dec.decode(SnapshotAgentsFrame.self, from: reencode(payload))).map { .snapshotAgents($0.agents) } ?? .ignored(name)
    case "snapshot.approvals": return (try? dec.decode(SnapshotApprovalsFrame.self, from: reencode(payload))).map { .snapshotApprovals($0.approvals) } ?? .ignored(name)
    case "snapshot.end": return payload["snapshotSeq"]?.int.map { .snapshotEnd(snapshotSeq: $0) } ?? .ignored(name)
    default:
      if let e = try? dec.decode(Envelope.self, from: bytes) { return .event(e) }
      return .ignored(name)
    }
  }
  static func reencode(_ o: [String: JSONValue]) -> Data { (try? JSONEncoder().encode(o)) ?? Data() }
}

public struct SnapshotRun: Codable, Sendable, Hashable { public var id: String; public var projectId: String?; public var label: String?; public var state: String; public var goal: String? }
public struct SnapshotAgent: Codable, Sendable, Hashable { public var id: String; public var runId: String; public var parent: String?; public var depth: Int; public var profile: String?; public var status: String }
public struct SnapshotApproval: Codable, Sendable, Hashable {
  public var approvalId: String; public var kind: String; public var status: String; public var question: String
  public var requestedBy: RequestedBy?; public var subject: [String: JSONValue]?
  public struct RequestedBy: Codable, Sendable, Hashable { public var agentId: String?; public var runId: String }
}
struct SnapshotRunFrame: Codable { var run: SnapshotRun }
struct SnapshotAgentsFrame: Codable { var agents: [SnapshotAgent] }
struct SnapshotApprovalsFrame: Codable { var approvals: [SnapshotApproval] }
