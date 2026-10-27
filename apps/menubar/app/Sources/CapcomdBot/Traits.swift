// Seed + role → traits (which part fills each slot), ported from packages/bot-avatar/src/engine.ts.
//
// Determinism. Every pick is weighted rendezvous hashing: candidate c with integer weight w scores
// max(h32(seed␟slot␟c.id␟k) for k in 0..<w), and the highest score wins (ties: the earlier candidate). A part wins with
// probability w/Σw, and adding a part to a slot changes only the bots that the new part wins. Same seed, same role,
// same catalog → the same bot as the TypeScript engine, bit for bit.

public let botTraitsFormat = "bot/1"

/// Which part fills each slot of one bot, plus its name.
public struct BotTraits: Sendable, Hashable, Codable {
  public var format: String
  public var seed: String
  public var role: BotRole
  public var name: String
  public var palette: String
  public var antenna: String
  public var accessory: String
  public var head: String
  public var ears: String
  public var screen: String
  public var eyes: String
  public var mouth: String
  public var blush: String
  public var torso: String
  public var plate: String
  public var pose: String
  public var legs: String
  public var dither: String

  public init(seed: String, role: BotRole, name: String, parts: [BotSlot: String]) {
    format = botTraitsFormat; self.seed = seed; self.role = role; self.name = name
    palette = ""; antenna = ""; accessory = ""; head = ""; ears = ""; screen = ""; eyes = ""; mouth = ""; blush = ""
    torso = ""; plate = ""; pose = ""; legs = ""; dither = ""
    for (s, id) in parts { self[s] = id }
  }

  public subscript(slot: BotSlot) -> String {
    get {
      switch slot {
      case .palette: palette
      case .antenna: antenna
      case .accessory: accessory
      case .head: head
      case .ears: ears
      case .screen: screen
      case .eyes: eyes
      case .mouth: mouth
      case .blush: blush
      case .torso: torso
      case .plate: plate
      case .pose: pose
      case .legs: legs
      case .dither: dither
      }
    }
    set {
      switch slot {
      case .palette: palette = newValue
      case .antenna: antenna = newValue
      case .accessory: accessory = newValue
      case .head: head = newValue
      case .ears: ears = newValue
      case .screen: screen = newValue
      case .eyes: eyes = newValue
      case .mouth: mouth = newValue
      case .blush: blush = newValue
      case .torso: torso = newValue
      case .plate: plate = newValue
      case .pose: pose = newValue
      case .legs: legs = newValue
      case .dither: dither = newValue
      }
    }
  }
}

typealias Chosen = [(slot: BotSlot, part: BotPart)]

/// Whether `cand` (for `slot`) combines with the parts already chosen. Checks both directions.
func compatible(_ cand: BotPart, _ slot: BotSlot, _ chosen: Chosen) -> Bool {
  for (s, p) in chosen {
    if p.excludes?[slot.rawValue]?.contains(cand.id) == true { return false }
    if cand.excludes?[s.rawValue]?.contains(p.id) == true { return false }
    if let pr = p.requires?[slot.rawValue], !pr.contains(cand.id) { return false }
    if let cr = cand.requires?[s.rawValue], !cr.contains(p.id) { return false }
    if let co = cand.occupies, let po = p.occupies, co.contains(where: po.contains) { return false }
  }
  return true
}

/// Weighted rendezvous pick: the index of the winning candidate, or nil when every weight is 0 or there are none.
public func rendezvous(seed: String, slot: String, candidates: [(id: String, weight: Int)]) -> Int? {
  var best: Int?
  var bestScore: Int64 = -1
  for (i, c) in candidates.enumerated() {
    var s: Int64 = -1
    if c.weight > 0 { for k in 0..<c.weight { s = max(s, Int64(hkey(seed, slot, c.id, String(k)))) } }
    if s > bestScore { bestScore = s; best = i }
  }
  return best
}

func candidates(_ slot: BotSlot, _ role: BotRole, _ chosen: Chosen, _ catalog: BotCatalog) -> [BotPart] {
  catalog.parts(slot).filter { $0.weight(for: role) > 0 && compatible($0, slot, chosen) }
}

/// The bot's name: it depends on the seed alone.
public func botName(seed: String, catalog: BotCatalog = .standard) -> String {
  guard let i = rendezvous(seed: seed, slot: "name", candidates: catalog.names.map { (id: $0, weight: 1) }) else { return "" }
  return catalog.names[i]
}

/// Which part fills each slot for this seed (the agent id) and role (its profile; unknown ones are `other`).
public func botTraits(seed: String, role: String?, catalog: BotCatalog = .standard) -> BotTraits {
  botTraits(seed: seed, role: BotRole(normalizing: role), catalog: catalog)
}

/// Which part fills each slot for this seed and role. Every slot of the standard catalog always has a candidate (the
/// tests check); a custom catalog where one has none is a catalog bug and traps, as the TypeScript engine throws.
public func botTraits(seed: String, role: BotRole, catalog: BotCatalog = .standard) -> BotTraits {
  var chosen: Chosen = []
  var parts: [BotSlot: String] = [:]
  for slot in BotSlot.allCases {
    let cands = candidates(slot, role, chosen, catalog)
    guard let i = rendezvous(seed: seed, slot: slot.rawValue, candidates: cands.map { (id: $0.id, weight: $0.weight(for: role)) }) else {
      preconditionFailure("CapcomdBot: no \(slot.rawValue) fits \(parts) (\(role.rawValue))")
    }
    chosen.append((slot, cands[i]))
    parts[slot] = cands[i].id
  }
  return BotTraits(seed: seed, role: role, name: botName(seed: seed, catalog: catalog), parts: parts)
}

func chosenOf(_ t: BotTraits, _ catalog: BotCatalog) throws -> Chosen {
  try BotSlot.allCases.map { ($0, try catalog.part($0, t[$0])) }
}

// Overrides for identity moments --------------------------------------------------------------------------------------

/// Expressions a moment can ask for. They replace eyes and mouth; status is still shown by the status marks.
public enum BotMood: String, CaseIterable, Sendable {
  case happy, sleepy, oops, love

  public var eyes: String {
    switch self {
    case .happy: "happy"
    case .sleepy: "sleepy"
    case .oops: "squint"
    case .love: "hearts"
    }
  }

  public var mouth: String {
    switch self {
    case .happy: "grin"
    case .sleepy: "flat"
    case .oops: "o"
    case .love: "smile"
    }
  }
}

/// Apply a moment's overrides, keeping the bot valid: a requested accessory may take the place of an ordinary antenna
/// (never of a kept one: the planner's crown, the lead's flag); one that clashes anyway is skipped, and an accessory
/// that no longer fits the new face is dropped. Throws for a pose or accessory id the catalog doesn't have.
public func withOverrides(_ t: BotTraits, mood: BotMood? = nil, pose: String? = nil, accessory: String? = nil,
                          catalog: BotCatalog = .standard) throws -> BotTraits {
  var n = t
  if let mood { n.eyes = mood.eyes; n.mouth = mood.mouth }
  if let pose { _ = try catalog.part(.pose, pose); n.pose = pose }
  func rest(_ n: BotTraits) throws -> Chosen { try chosenOf(n, catalog).filter { $0.slot != .accessory } }
  if let accessory, accessory != n.accessory {
    let acc = try catalog.part(.accessory, accessory)
    var bare = n
    bare.antenna = "none"
    if compatible(acc, .accessory, try rest(n)) {
      n.accessory = accessory
    } else if try catalog.part(.antenna, n.antenna).keep != true, compatible(acc, .accessory, try rest(bare)) {
      n = bare
      n.accessory = accessory
    }
  }
  if !compatible(try catalog.part(.accessory, n.accessory), .accessory, try rest(n)) { n.accessory = "none" }
  return n
}

/// `t` with one part swapped in; any other part that no longer fits gives way to the first one in catalog order that
/// does (catalog sheets, previews). Role weights are ignored: it shows what a part looks like, not what gets picked.
public func withPart(_ t: BotTraits, slot: BotSlot, id: String, catalog: BotCatalog = .standard) throws -> BotTraits {
  _ = try catalog.part(slot, id)
  var n = t
  n[slot] = id
  for s in BotSlot.allCases where s != slot {
    let others = try chosenOf(n, catalog).filter { $0.slot != s }
    if !compatible(try catalog.part(s, n[s]), s, others), let p = catalog.parts(s).first(where: { compatible($0, s, others) }) {
      n[s] = p.id
    }
  }
  return n
}

// Teams ---------------------------------------------------------------------------------------------------------------

/// Two bots read as different at a glance: different colour and one more difference, or three differences, and
/// different names.
public func distinct(_ a: BotTraits, _ b: BotTraits) -> Bool {
  if a.name == b.name { return false }
  let diffs = [a.head != b.head, a.eyes != b.eyes, a.antenna != b.antenna || a.accessory != b.accessory, a.screen != b.screen,
               a.ears != b.ears].filter { $0 }.count
  return a.palette != b.palette ? diffs >= 1 : diffs >= 3
}

/// Variant seeds botTeam tries per member (the member's own seed, then `seed#1` … `seed#15`).
public let botTeamTries = 16

/// Traits for agents shown together (siblings, a tree), in spawn order. Each keeps its own bot unless it looks like one
/// earlier in the list; then it takes the first variant seed `\(seed)#k` (k = 1…15) that doesn't, keeping its own
/// `seed`. Earlier agents never change, so pass agents in creation order and a new sibling never repaints an old one.
public func botTeam(_ members: [(seed: String, role: String?)], catalog: BotCatalog = .standard) -> [BotTraits] {
  var out: [BotTraits] = []
  for m in members {
    var pick: BotTraits?
    for k in 0..<botTeamTries where pick == nil {
      var t = botTraits(seed: k == 0 ? m.seed : "\(m.seed)#\(k)", role: m.role, catalog: catalog)
      if out.allSatisfy({ distinct($0, t) }) { t.seed = m.seed; pick = t }
    }
    out.append(pick ?? botTraits(seed: m.seed, role: m.role, catalog: catalog))
  }
  return out
}
