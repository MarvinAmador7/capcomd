/// One agent's thread as the client holds it: the highest `rev` of each id wins, items stay sorted by `order`, and
/// `cursor` is the highest `seq` seen (the `after` for the next read). Items arrive both from the thread route and from
/// live frames, in any interleaving; applying the same revision twice, or an older one, changes nothing.
public struct Book: Sendable, Hashable {
  public private(set) var items: [Item] = []
  public private(set) var cursor = 0
  private var index: [String: Int] = [:]   // id → position in `items`

  public init() {}

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
