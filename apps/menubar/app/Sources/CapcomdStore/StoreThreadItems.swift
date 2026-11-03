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
    followThreads(runId: runId, holder: Self.panelHolder)
    changed()
  }

  /// The thread view closed: the run's lifecycle feed goes back to lifecycle frames only (unless the reel still
  /// follows it). Items already read stay.
  public func closeThread() {
    openThreadAgent = nil
    followThreads(runId: nil, holder: Self.panelHolder)
  }

  public static let panelHolder = "panel"
  public static let reelHolder = "reel"

  /// `holder` (the panel's thread view, the desktop reel) now follows `runId`'s live thread items for all its agents,
  /// or nothing. A run's feed is reopened only when whether anyone follows it changes.
  public func followThreads(runId: String?, holder: String) {
    let before = threadStreamRuns
    if let runId { threadHolders[holder] = runId } else { threadHolders.removeValue(forKey: holder) }
    let after = threadStreamRuns
    for run in before.symmetricDifference(after) { resubscribeLifecycle(run) }
  }

  func resubscribeLifecycle(_ runId: String) {
    let key = Self.lifecycleKey(runId)
    guard subs[key] != nil else { return }   // syncLifecycleFeeds opens it later with the right flag
    subs.removeValue(forKey: key)?.cancel()
    subscribe(key, scope: runId, feed: "lifecycle")
  }

  /// Reads the agent's thread: on a first read, its newest page first (`agents.thread_tail`), shown at once; then from
  /// the route's cursor to the end, a page at a time. The cursor is one the route returned (the tail's, or the highest
  /// seq it served), never one from a live frame: a frame can run ahead of items the route hasn't returned yet.
  ///
  /// The pages after the cursor go into the book together, once the read ends. Applied page by page, any change in
  /// between (a live frame, an activity line) showed the thread as far as it had been read: the oldest items, oldest
  /// first, so a long thread opened on its first hundred items and reached its newest seconds later. A daemon without
  /// the tail route is read that way from the start, as before.
  ///
  /// One read per agent at a time: a call while one is on its way makes it read once more when it ends (a reconnect
  /// mid-read must not be answered by the read that failed). A read cancelled with its view leaves no error behind.
  public func refreshThread(runId: String, agentId: String) async {
    guard threadReads.insert(agentId).inserted else { threadRereads.insert(agentId); return }
    defer { threadReads.remove(agentId) }
    repeat {
      threadRereads.remove(agentId)
      await readThread(runId: runId, agentId: agentId)
    } while threadRereads.contains(agentId) && !Task.isCancelled
  }

  /// Whether a first read asks for the newest page first: the daemon says it has the route, or hasn't been asked yet (a
  /// daemon without it answers 404, and the read goes on from the start).
  var threadTailUsable: Bool { daemonVersion == nil || capabilities.contains(Capability.agentsThreadTail) }

  private func readThread(runId: String, agentId: String) async {
    guard let threadSource else { return }
    var failure: Error?
    if threadCursor[agentId] == nil, threadTailUsable {
      do {
        let t = try await threadSource.threadTail(runId: runId, agentId: agentId, before: nil, limit: Self.threadPage)
        if threadCursor[agentId] == nil {   // nothing read it meanwhile
          books[agentId, default: Book()].start(tail: t.items, before: t.before)
          threadCursor[agentId] = t.cursor
          threadUnavailable[agentId] = nil
          mark(.thread(agentId)); changed()   // the newest show now; the catch-up below is small
        }
      }
      catch DetailUnavailable.unsupported {}   // no tail route (or no such agent): read from the start
      catch { failure = error }
    }
    var read: [CapcomdThread.Item] = [], cursor = threadCursor[agentId] ?? 0
    if failure == nil {
      do {
        for _ in 0..<50 {   // bounded: a long thread catches up over a few refreshes
          let page = try await threadSource.thread(runId: runId, agentId: agentId, after: cursor, limit: Self.threadPage)
          read += page.items
          cursor = max(cursor, page.items.map(\.seq).max() ?? cursor, page.next ?? cursor)
          guard page.next != nil, !page.items.isEmpty else { break }
        }
      } catch { failure = error }
    }
    if !read.isEmpty || failure == nil {
      books[agentId, default: Book()].apply(read)   // into the live book: frames applied meanwhile stay (highest rev wins)
      threadCursor[agentId] = max(threadCursor[agentId] ?? 0, cursor)
    }
    if failure != nil, Task.isCancelled || failure is CancellationError { changed(); return }   // its view went: not a failure
    switch failure {
    case nil: threadUnavailable[agentId] = nil; mark(.thread(agentId))
    case is Unauthorized?: unauthorized = true
    case let e?: threadUnavailable[agentId] = e as? DetailUnavailable ?? .failed("Couldn't reach capcomd"); mark(.thread(agentId))
    }
    changed()
  }

  /// Reads again every followed thread of `runs` that was read or failed (after a reconnect).
  func rereadThreads(runs ids: Set<String>) {
    for id in ids {
      for agentId in runs[id]?.agents.keys.sorted() ?? [] where books[agentId] != nil || threadUnavailable[agentId] != nil {
        Task { await refreshThread(runId: id, agentId: agentId) }
      }
    }
  }

  /// Whether the thread has items above what it shows (read newest first, `agents.thread_tail`).
  public func threadHasEarlier(agentId: String) -> Bool { books[agentId]?.hasEarlier ?? false }
  /// Where the shown thread starts (the `before` of the page above it); nil when it shows everything.
  public func threadTop(agentId: String) -> Int? { books[agentId]?.top }

  /// The page above the shown thread (the view scrolled up to its top): read and shown above it. One at a time per
  /// agent; a failure leaves the thread as it was, and scrolling up again tries again.
  public func loadEarlierThread(runId: String, agentId: String) async {
    guard let threadSource, let top = books[agentId]?.top, threadLoadingEarlier.insert(agentId).inserted else { return }
    mark(.thread(agentId)); changed()
    do {
      let t = try await threadSource.threadTail(runId: runId, agentId: agentId, before: top, limit: Self.threadPage)
      books[agentId]?.extend(above: t.items, before: t.before)
    }
    catch is Unauthorized { unauthorized = true }
    catch {}
    threadLoadingEarlier.remove(agentId)
    mark(.thread(agentId)); changed()
  }

  /// `agent.thread_item_changed` (ephemeral, `?thread=1`): a full item, latest rev wins.
  func applyThreadFrame(runId: String?, agentId: String?, _ d: [String: JSONValue]) {
    guard let runId, threadStreamRuns.contains(runId), let agentId, case .object(let o)? = d["item"],
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
    // Read newest first, the thread shows from its top down; messages from before its first item wait with it.
    let items = Array(book.shown)
    let from = book.hasEarlier ? items.first?.atMs ?? Int.max : Int.min
    var out: [ThreadEntry] = []; out.reserveCapacity(items.count + messages.count)
    var m = messages.filter { $0.epochMs >= from }.sorted { ($0.epochMs, $0.seq) < ($1.epochMs, $1.seq) }[...]
    for (n, item) in items.enumerated() {
      while let first = m.first, first.epochMs <= item.atMs { out.append(.event(first)); m = m.dropFirst() }
      out.append(.item(item, next: n + 1 < items.count ? items[n + 1] : nil))
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
