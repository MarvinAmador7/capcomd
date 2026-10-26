import AsyncHTTPClient
import Foundation
import HTTPTypes
import NIOCore
import OpenAPIRuntime

/// Hand-written swift-openapi ClientTransport over the Unix socket (generated types/client from relay openapi/capcomd.json).
/// Not using swift-openapi-async-http-client: it forwards AHC's default Host (the hex-encoded socket path), which Bun rejects with 400.
struct UnixClientTransport: ClientTransport {
  let t: UnixSocketTransport
  func send(_ request: HTTPRequest, body: HTTPBody?, baseURL: URL, operationID: String) async throws -> (HTTPResponse, HTTPBody?) {
    var r = try t.request(request.path ?? "/")
    r.method = .init(rawValue: request.method.rawValue)
    for f in request.headerFields where f.name != .authorization { r.headers.add(name: f.name.rawName, value: f.value) }
    if let body { r.body = .bytes(ByteBuffer(bytes: try await Data(collecting: body, upTo: 4 << 20))) }
    let resp = try await t.client.execute(r, timeout: .seconds(30))
    var fields = HTTPFields()
    for (k, v) in resp.headers { if let n = HTTPField.Name(k) { fields.append(.init(name: n, value: v)) } }
    let bytes = try await resp.body.collect(upTo: 16 << 20)
    return (HTTPResponse(status: .init(code: Int(resp.status.code)), headerFields: fields), HTTPBody(Array(bytes.readableBytesView)))
  }
}

extension UnixSocketTransport {
  public func openAPIClient() throws -> Client {
    Client(serverURL: URL(string: "http://localhost")!, configuration: .init(dateTranscoder: .iso8601WithFractionalSeconds), transport: UnixClientTransport(t: self))
  }
}


/// Contract timestamps: RFC 3339 UTC with exactly 3 ms digits (e.g. 2026-10-25T07:57:00.000Z). Generated as `Date`
/// (`format: date-time`); these convert to and from that wire string.
public enum HarnessTime {
  public static let style = Date.ISO8601FormatStyle(includingFractionalSeconds: true)
  public static func string(_ d: Date) -> String { d.formatted(style) }
  public static func date(_ s: String) throws -> Date { try style.parse(s) }
}
extension JSONDecoder {
  /// For SSE envelopes decoded outside the generated client.
  static let harness: JSONDecoder = { let d = JSONDecoder()
    d.dateDecodingStrategy = .custom { c in try HarnessTime.date(c.singleValueContainer().decode(String.self)) }; return d }()
}
