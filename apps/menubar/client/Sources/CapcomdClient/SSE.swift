import Foundation
import NIOCore

public struct SSEFrame: Equatable, Sendable { public var id: String?; public var event: String; public var data: String }

public enum SSEItem: Equatable, Sendable { case frame(SSEFrame); case comment(String) }

/// Incremental SSE parser (WHATWG event-stream): feed bytes, get complete frames.
public struct SSEParser {
  var buf = [UInt8](); var id: String?; var event = ""; var data = [String]()
  public init() {}
  public mutating func feed(_ bytes: some Sequence<UInt8>) -> [SSEFrame] {
    feedItems(bytes).compactMap { if case .frame(let f) = $0 { return f }; return nil }
  }
  /// Like `feed`, but also surfaces `:` comment lines (the contract's `: heartbeat`).
  public mutating func feedItems(_ bytes: some Sequence<UInt8>) -> [SSEItem] {
    buf.append(contentsOf: bytes); var out = [SSEItem]()
    while let nl = buf.firstIndex(of: 10) {
      var line = Array(buf[..<nl]); buf.removeSubrange(...nl)
      if line.last == 13 { line.removeLast() }
      let s = String(decoding: line, as: UTF8.self)
      if s.isEmpty {
        if !data.isEmpty { out.append(.frame(SSEFrame(id: id, event: event.isEmpty ? "message" : event, data: data.joined(separator: "\n")))) }
        id = nil; event = ""; data = []; continue
      }
      if s.hasPrefix(":") { out.append(.comment(String(s.dropFirst()).trimmingCharacters(in: .whitespaces))); continue }
      let (f, v): (Substring, Substring)
      if let c = s.firstIndex(of: ":") { f = s[..<c]; var r = s[s.index(after: c)...]; if r.first == " " { r = r.dropFirst() }; v = r } else { f = Substring(s); v = "" }
      switch f { case "id": id = String(v); case "event": event = String(v); case "data": data.append(String(v)); default: break }
    }
    return out
  }
}

/// No bytes (not even a `: heartbeat`) within the idle window: the contract says treat the socket as dead.
public struct SSEIdleTimeout: Error, Equatable { public let after: Duration }

extension UnixSocketTransport {
  /// Opens `path` as SSE and yields parsed items. HTTP errors (`HTTPStatusError`) surface from iteration; the stream
  /// fails with `SSEIdleTimeout` if no bytes (including response headers) arrive for `idleTimeout`
  /// (contract: 15s heartbeat, ~45s of silence = dead socket).
  public func sseItems(_ path: String, lastEventID: String?, idleTimeout: Duration = .seconds(45)) -> AsyncThrowingStream<SSEItem, Error> {
    let clock = ContinuousClock(), last = LastActivity(clock.now)
    return AsyncThrowingStream { cont in
      let reader = Task {
        var parser = SSEParser()
        do {
          let body = try await self.stream(path, lastEventID: lastEventID)
          last.touch(clock.now)
          for try await chunk in body {
            last.touch(clock.now)
            for item in parser.feedItems(chunk.readableBytesView) { cont.yield(item) }
          }
          cont.finish()
        } catch { cont.finish(throwing: error) }
      }
      let watchdog = Task {
        while !Task.isCancelled {
          let deadline = last.value + idleTimeout
          if clock.now >= deadline { cont.finish(throwing: SSEIdleTimeout(after: idleTimeout)); reader.cancel(); return }
          try? await Task.sleep(until: deadline, clock: clock)
        }
      }
      cont.onTermination = { _ in reader.cancel(); watchdog.cancel() }
    }
  }
}

final class LastActivity: @unchecked Sendable {
  private let lock = NSLock(); private var t: ContinuousClock.Instant
  init(_ t: ContinuousClock.Instant) { self.t = t }
  func touch(_ n: ContinuousClock.Instant) { lock.lock(); t = n; lock.unlock() }
  var value: ContinuousClock.Instant { lock.lock(); defer { lock.unlock() }; return t }
}
