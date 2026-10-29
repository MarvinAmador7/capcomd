import Foundation
import CapcomdThread

/// What the thread view shows, in order: the daemon's structured items (harness #59) and, between them, the messages
/// that aren't part of an agent's own output (your steers, messages from other agents). Against a daemon without the
/// thread route, the event-built items (ThreadItem) as before.
public enum ThreadEntry: Sendable, Hashable, Identifiable {
  /// `next` is the item after it (a thinking item's duration is the gap to it when the CLI reported none).
  case item(CapcomdThread.Item, next: CapcomdThread.Item?)
  case event(ThreadItem)
  public var id: String {
    switch self { case .item(let i, _): "itm:\(i.id)"; case .event(let e): "evt:\(e.id)" }
  }
}

/// Bytes behind a media block, loaded on demand (attachment and workspace media through the daemon only).
public enum MediaKey: Sendable, Hashable {
  case attachment(runId: String, id: String)
  case workspace(runId: String, agentId: String, path: String)
}

extension CapcomdStore {
  public static let threadPage = 100

  /// The thread view opened: follow its run's thread items live (`thread=1` on that run's lifecycle feed, resumed from
  /// its cursor) and read the thread from where we are. Contract order: stream first, then the route; the highest rev
  /// of an id wins, so an item that arrives both ways is shown once.
  public func openThread(runId: String, agentId: String) {
    openThreadAgent = agentId
    if threadStreamRun != runId {
      let old = threadStreamRun
      threadStreamRun = runId
      if let old { resubscribeLifecycle(old) }
      resubscribeLifecycle(runId)
    }
    changed()
  }

  /// The thread view closed: the run's lifecycle feed goes back to lifecycle frames only. Items already read stay.
  public func closeThread() {
    openThreadAgent = nil
    guard let run = threadStreamRun else { return }
    threadStreamRun = nil
    resubscribeLifecycle(run)
  }

  func resubscribeLifecycle(_ runId: String) {
    let key = Self.lifecycleKey(runId)
    guard subs[key] != nil else { return }   // syncLifecycleFeeds opens it later with the right flag
    subs.removeValue(forKey: key)?.cancel()
    subscribe(key, scope: runId, feed: "lifecycle")
  }

  /// Reads the agent's thread from the route's cursor to the end, a page at a time. The cursor is the highest seq the
  /// route returned, never one from a live frame: a frame can run ahead of items the route hasn't returned yet.
  public func refreshThread(runId: String, agentId: String) async {
    guard let threadSource else { return }
    do {
      for _ in 0..<50 {   // bounded: a long thread catches up over a few refreshes
        let after = threadCursor[agentId] ?? 0
        let page = try await threadSource.thread(runId: runId, agentId: agentId, after: after, limit: Self.threadPage)
        books[agentId, default: Book()].apply(page.items)   // into the live book: frames applied meanwhile stay
        threadCursor[agentId] = max(after, page.items.map(\.seq).max() ?? after, page.next ?? after)
        guard page.next != nil, !page.items.isEmpty else { break }
      }
      threadUnavailable[agentId] = nil
    } catch is Unauthorized { unauthorized = true }
    catch { threadUnavailable[agentId] = error as? DetailUnavailable ?? .failed("Couldn't reach capcomd") }
    changed()
  }

  /// `agent.thread_item_changed` (ephemeral, `?thread=1`): a full item, latest rev wins.
  func applyThreadFrame(runId: String?, agentId: String?, _ d: [String: JSONValue]) {
    guard let runId, runId == threadStreamRun, let agentId, case .object(let o)? = d["item"],
          let item = try? JSONDecoder().decode(CapcomdThread.Item.self, from: StreamFrame.reencode(o)) else { return }
    books[agentId, default: Book()].apply(item)
  }

  /// Whether the daemon serves structured threads for this agent (nil: not asked yet).
  public func threadSupported(agentId: String) -> Bool? {
    if case .unsupported? = threadUnavailable[agentId] { return false }
    return books[agentId] != nil ? true : nil
  }

  public func threadEntries(agentId: String) -> [ThreadEntry] {
    let events = thread(agentId: agentId)
    guard let book = books[agentId], threadSupported(agentId: agentId) == true else { return events.map(ThreadEntry.event) }
    // The agent's own output is in the book; keep only messages from someone else (steers, other agents).
    let messages = events.filter { if case .message(let from, _, _, _) = $0.kind { return from != agentId }; return false }
    var out: [ThreadEntry] = []; out.reserveCapacity(book.items.count + messages.count)
    var m = messages.sorted { ($0.epochMs, $0.seq) < ($1.epochMs, $1.seq) }[...]
    for (n, item) in book.items.enumerated() {
      while let first = m.first, first.epochMs <= item.atMs { out.append(.event(first)); m = m.dropFirst() }
      out.append(.item(item, next: n + 1 < book.items.count ? book.items[n + 1] : nil))
    }
    out += m.map(ThreadEntry.event)
    return out
  }

  /// Loads a media block's bytes once (a failed load can be retried). Only png, jpeg, gif and webp are kept: what the
  /// daemon serves as an image, checked again here by the file's magic bytes.
  public func loadMedia(_ key: MediaKey) async {
    if case .loaded? = media[key] { return }
    guard let threadSource else { media[key] = .unavailable(.unsupported); changed(); return }
    do {
      let data: Data
      switch key {
      case .attachment(let r, let id): data = try await threadSource.attachment(runId: r, id: id)
      case .workspace(let r, let a, let p): data = try await threadSource.workspaceFile(runId: r, agentId: a, path: p)
      }
      media[key] = Self.isRasterImage(data) ? .loaded(data) : .unavailable(.failed("not an image"))
    } catch is Unauthorized { unauthorized = true }
    catch { media[key] = .unavailable(error as? DetailUnavailable ?? .failed("Couldn't reach capcomd")) }
    changed()
  }

  public nonisolated static func isRasterImage(_ d: Data) -> Bool {
    let b = [UInt8](d.prefix(12))
    if b.starts(with: [0x89, 0x50, 0x4E, 0x47]) { return true }                    // png
    if b.starts(with: [0xFF, 0xD8, 0xFF]) { return true }                          // jpeg
    if b.starts(with: Array("GIF8".utf8)) { return true }                          // gif
    return b.count >= 12 && b[0..<4].elementsEqual("RIFF".utf8) && b[8..<12].elementsEqual("WEBP".utf8)
  }
}
