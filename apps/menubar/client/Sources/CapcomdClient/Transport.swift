import AsyncHTTPClient
import Foundation
import NIOCore
import NIOHTTP1

public struct HTTPStatusError: Error, Equatable { public let status: Int; public init(status: Int) { self.status = status } }

/// HTTP over a Unix domain socket via AsyncHTTPClient (URLSession cannot do AF_UNIX).
/// Seam for swift-openapi-generator: wrap `send` in a ClientTransport later.
public final class UnixSocketTransport: @unchecked Sendable {
  public let socketPath: String
  let token: String
  let client: HTTPClient
  public init(socketPath: String, token: String) {
    self.socketPath = socketPath; self.token = token
    // A local socket: a refused connection means the daemon is down or restarting. Fail the request at once (connect
    // timeout 3 s, no pool retry) and let the caller back off and reconnect; with the pool's retry an SSE request kept
    // retrying inside its 24 h deadline, so feeds never came back after a daemon restart.
    var config = HTTPClient.Configuration()
    config.connectionPool.retryConnectionEstablishment = false
    // Every SSE feed holds a connection for good (the daemon feed, one per followed run, the open thread's): the default
    // 8 per host queued any feed past the eighth forever, so newer runs never showed their agents.
    config.connectionPool.concurrentHTTP1ConnectionsPerHostSoftLimit = 64
    config.timeout.connect = .seconds(3)
    self.client = HTTPClient(eventLoopGroupProvider: .singleton, configuration: config)
  }
  public func shutdown() async throws { try await client.shutdown() }

  func request(_ path: String, headers extra: [(String, String)] = []) throws -> HTTPClientRequest {
    guard let url = URL(httpURLWithSocketPath: socketPath, uri: path) else { throw URLError(.badURL) }
    var r = HTTPClientRequest(url: url.absoluteString)
    r.headers.replaceOrAdd(name: "Host", value: "localhost")
    r.headers.add(name: "Authorization", value: "Bearer \(token)")
    for (k, v) in extra { r.headers.add(name: k, value: v) }
    return r
  }

  /// GET with the body collected up to `maxBytes` (a larger body throws).
  public func get(_ path: String, maxBytes: Int = 4 << 20) async throws -> (Int, Data) {
    let resp = try await client.execute(try request(path), timeout: .seconds(10))
    let body = try await resp.body.collect(upTo: maxBytes)
    return (Int(resp.status.code), Data(body.readableBytesView))
  }

  public func getJSON<T: Decodable>(_ path: String, as: T.Type, maxBytes: Int = 4 << 20) async throws -> T {
    let (s, d) = try await get(path, maxBytes: maxBytes)
    guard s == 200 else { throw HTTPStatusError(status: s) }
    return try JSONDecoder().decode(T.self, from: d)
  }

  /// POST with an optional JSON body; returns the status and body (errors are ApiError `{code, message}` JSON).
  public func post(_ path: String, headers extra: [(String, String)] = [], json: Data? = nil) async throws -> (Int, Data) {
    var r = try request(path, headers: extra + (json == nil ? [] : [("Content-Type", "application/json")]))
    r.method = .POST
    if let json { r.body = .bytes(ByteBuffer(data: json)) }
    let resp = try await client.execute(r, timeout: .seconds(30))
    let body = try await resp.body.collect(upTo: 1 << 20)
    return (Int(resp.status.code), Data(body.readableBytesView))
  }

  /// Opens an SSE stream and yields raw byte chunks.
  public func stream(_ path: String, lastEventID: String?) async throws -> HTTPClientResponse.Body {
    var h = [("Accept", "text/event-stream")]
    if let id = lastEventID { h.append(("Last-Event-ID", id)) }
    let resp = try await client.execute(try request(path, headers: h), timeout: .hours(24))
    guard resp.status == .ok else { throw HTTPStatusError(status: Int(resp.status.code)) }
    return resp.body
  }
}

