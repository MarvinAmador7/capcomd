import Foundation
import PerfLoopProbe

// "Why did this body run" (CAPABILITIES.md C7) as text: the model's recorded mutations (`Mutations` in PerfLoopProbe,
// the setters in CapcomdDesk's DeskModel) and the bodies the bench charged to them, per stretch and per step.

extension Explain {
  /// `AgentSlice.onScreen×6 + AgentSlice.focused×2 (CrewTab×6, Column×2) · (unrecorded) (Reel×1)`: key paths charged
  /// with the same bodies (set in the same updates) are one group, heaviest group first.
  public static func causesText(_ cs: [Cause], groups limit: Int = 4) -> String {
    let gs = groups(cs)
    var parts = gs.prefix(limit).map { g in
      let keys = g.keys.map { $0.keyPath == Cause.unrecorded ? $0.keyPath : "\($0.keyPath)×\($0.count)" }.joined(separator: " + ")
      return "\(keys) (\(bodiesText(g.bodies, objects: g.objects)))"
    }
    if gs.count > limit { parts.append("+\(gs.count - limit) more") }
    return parts.joined(separator: " · ")
  }

  /// Bodies heaviest first: `Column×17, CrewTab×16`; `Column×34 (17 distinct)` when the bodies were fewer objects.
  static func bodiesText(_ b: [String: Int], objects: [String: Int]? = nil, limit: Int = 5) -> String {
    let xs = b.sorted { ($0.value, $1.key) > ($1.value, $0.key) }
    return xs.prefix(limit).map { x in
      "\(x.key)×\(x.value)" + (objects?[x.key].flatMap { $0 < x.value ? " (\($0) distinct)" : nil } ?? "")
    }.joined(separator: ", ") + (xs.count > limit ? ", …" : "")
  }

  /// Causes with identical bodies, together; within a group the most-set key path first.
  static func groups(_ cs: [Cause]) -> [(keys: [Cause], bodies: [String: Int], objects: [String: Int]?)] {
    var out: [(keys: [Cause], bodies: [String: Int], objects: [String: Int]?)] = []
    for c in cs {
      if let i = out.firstIndex(where: { $0.bodies == c.bodies }) { out[i].keys.append(c) } else { out.append(([c], c.bodies, c.objects)) }
    }
    for i in out.indices { out[i].keys.sort { ($0.keyPath == Cause.unrecorded ? 0 : 1, $0.count, $1.keyPath) > ($1.keyPath == Cause.unrecorded ? 0 : 1, $1.count, $0.keyPath) } }
    return out.sorted { ($0.bodies.values.reduce(0, +), $0.keys.count) > ($1.bodies.values.reduce(0, +), $1.keys.count) }
  }

  /// Many windows' causes as one list: sets and bodies summed per key path; `ids` and `objects` the most in one window.
  public static func merge(_ lists: [[Cause]]) -> [Cause] {
    var by: [String: Cause] = [:]
    for l in lists {
      for c in l {
        var m = by[c.keyPath] ?? Cause(keyPath: c.keyPath, count: 0, bodies: [:])
        m.count += c.count
        if let n = c.ids { m.ids = max(m.ids ?? 0, n) }
        m.bodies.merge(c.bodies, uniquingKeysWith: +)
        if let o = c.objects { m.objects = (m.objects ?? [:]).merging(o, uniquingKeysWith: max) }
        by[c.keyPath] = m
      }
    }
    return by.values.sorted { ($0.bodyTotal, $0.count, $1.keyPath) > ($1.bodyTotal, $1.count, $0.keyPath) }
  }

  /// The steps' causes over every rep, for `explain`: empty when the result has none (older benches).
  public static func stepCauseLines(_ r: BenchResult) -> [String] {
    let steps = r.reps.flatMap(\.steps)
    let lists = steps.compactMap(\.causes)
    guard !lists.isEmpty else { return [] }
    let all = merge(lists)
    var o = ["", "why the steps' bodies ran (\(steps.count) steps over \(r.reps.count) rep\(r.reps.count == 1 ? "" : "s"); each update's bodies charged to the mutations since the previous one):"]
    if all.isEmpty { o.append("  no bodies in the steps"); return o }
    for g in groups(all).prefix(6) {
      let keys = g.keys.map { k in k.keyPath == Cause.unrecorded ? "\(k.keyPath): no recorded mutation (environment, layout, or a model property without a record)"
                                                                   : "\(k.keyPath) set \(k.count)×" + (k.ids.map { " (≤ \($0) object\($0 == 1 ? "" : "s") a step)" } ?? "") }
      let per = g.objects.map { o in o.sorted { $0.key < $1.key }.map { "\($0.key) \($0.value)" }.joined(separator: ", ") }
      o.append("  " + keys.joined(separator: " + ") + " → " + bodiesText(g.bodies, limit: 6) + (per.map { "  [most distinct in one step: \($0)]" } ?? ""))
    }
    return o
  }
}
