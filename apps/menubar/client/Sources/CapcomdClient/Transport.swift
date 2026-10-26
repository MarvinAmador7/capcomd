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
    self.client = HTTPClient(eventLoopGroupProvider: .singleton)
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

  public func get(_ path: String) async throws -> (Int, Data) {
    let resp = try await client.execute(try request(path), timeout: .seconds(10))
    let body = try await resp.body.collect(upTo: 4 << 20)
    return (Int(resp.status.code), Data(body.readableBytesView))
  }

  public func getJSON<T: Decodable>(_ path: String, as: T.Type) async throws -> T {
    let (s, d) = try await get(path)
    guard s == 200 else { throw HTTPStatusError(status: s) }
    return try JSONDecoder().decode(T.self, from: d)
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

