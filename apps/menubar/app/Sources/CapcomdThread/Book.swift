/// One agent's thread as the client holds it: the highest `rev` of each id wins, items stay sorted by `order`, and
/// `cursor` is the highest `seq` seen (the `after` for the next read). Items arrive both from the thread route and from
/// live frames, in any interleaving; applying the same revision twice, or an older one, changes nothing.
///
/// A thread read newest first (`agents.thread_tail`) has a `top`: the position (`order`) its pages reach up to. Items
/// placed above it can still arrive (a tool call up there finishing, by cursor or live frame); they are kept, so a later
/// page never shows an older rev, but not shown until a page above reaches them, so the thread never shows a gap.
public struct Book: Sendable, Hashable {
  public private(set) var items: [Item] = []
  public private(set) var cursor = 0
  /// The `order` the pages read so far reach up to; nil: the thread is read from its start.
  public private(set) var top: Int?
  private var index: [String: Int] = [:]   // id → position in `items`

  public init() {}

  /// What the thread shows: every item from `top` down.
  public var shown: ArraySlice<Item> {
    guard let top else { return items[...] }
    var lo = 0, hi = items.count   // the first item at or below `top` (items are sorted by order)
    while lo < hi { let mid = (lo + hi) / 2; if items[mid].order < top { lo = mid + 1 } else { hi = mid } }
    return items[lo...]
  }
  /// Whether there are items above what is shown.
  public var hasEarlier: Bool { top != nil }

  /// The thread's newest page (a first read): shown down from its first item; `before` nil: it is the whole thread.
  public mutating func start(tail: [Item], before: Int?) {
    apply(tail)
    top = before
  }

  /// A page above `top`: shown too, and the top moves up to it (nil: the thread's start is reached).
  public mutating func extend(above page: [Item], before: Int?) {
    guard let current = top else { return }
    apply(page)
    top = before.map { min($0, current) }
  }

  /// Applies one item revision. Returns whether anything visible changed.
  @discardableResult
  public mutating func apply(_ item: Item) -> Bool {
    cursor = max(cursor, item.seq)
    if let i = index[item.id] {
      guard item.rev > items[i].rev else { return false }
      items[i] = item   // `order` never changes, so its place doesn't either
      return true
    }
    let at = items.firstIndex { ($0.order, $0.id) > (item.order, item.id) } ?? items.endIndex
    items.insert(item, at: at)
    if at == items.endIndex - 1 { index[item.id] = at } else { reindex(from: at) }
    return true
  }

  @discardableResult
  public mutating func apply<S: Sequence>(_ batch: S) -> Bool where S.Element == Item {
    var changed = false
    for i in batch where apply(i) { changed = true }
    return changed
  }

  private mutating func reindex(from start: Int) {
    for i in start..<items.count { index[items[i].id] = i }
  }
}
