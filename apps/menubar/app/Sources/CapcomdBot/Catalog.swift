import Foundation

// The bot parts catalog (format bot-catalog/1), decoded from packages/bot-avatar/fixtures/catalog.json, which is the
// single source of truth. CatalogJSON.swift embeds that file verbatim (scripts/gen-bot-catalog.sh writes it; the
// tests check it is identical), so the app needs no resource bundle and nothing here does I/O.

public let botCatalogFormat = "bot-catalog/1"

/// Agent roles (the daemon's profiles). Anything else is `other`.
public enum BotRole: String, CaseIterable, Codable, Sendable {
  case planner, lead, worker, critic, other

  /// Trims and lowercases a profile name; an unknown or missing one is `other`.
  public init(normalizing role: String?) {
    self = BotRole(rawValue: (role ?? "").trimmingCharacters(in: .whitespacesAndNewlines).lowercased()) ?? .other
  }
}

/// Detail levels: xs is 14×14 (head only), small 24×24 (head and shoulders), full 32×32 (whole body).
public enum BotSize: String, CaseIterable, Codable, Sendable {
  case xs, small, full
}

/// Slots in pick order. A slot's candidates are filtered by the parts already picked for earlier slots. (The name is
/// picked separately, from `names`.)
public enum BotSlot: String, CaseIterable, Codable, Sendable {
  case palette, antenna, accessory, head, ears, screen, eyes, mouth, blush, torso, plate, pose, legs, dither
}

public enum DitherStyle: String, Codable, Sendable {
  case flat, checker, bayer, scan
}

public enum BotError: Error, Equatable, Sendable {
  case unknownPart(slot: BotSlot, id: String)
  case unknownPixelKey(String)
  case unknownColor(String)
  case missingDrawing(slot: BotSlot, id: String)
  case missingAnchor(String)
  case badCatalog(String)
}

/// A point in cells.
public struct BotPoint: Hashable, Sendable, Decodable {
  public var x: Int
  public var y: Int

  public init(_ x: Int, _ y: Int) { self.x = x; self.y = y }

  public init(from decoder: Decoder) throws {
    var c = try decoder.unkeyedContainer()
    x = try c.decode(Int.self)
    y = try c.decode(Int.self)
  }

  static func + (a: BotPoint, b: BotPoint) -> BotPoint { BotPoint(a.x + b.x, a.y + b.y) }
}

/// Pixel art: one string per row, one character per cell. "." is empty; every other character is a colour slot.
/// `anchor` is the point of this sprite that lands on its host's anchor.
public struct BotArt: Sendable, Decodable {
  public var rows: [String] { didSet { cells = rows.map { Array($0.utf8) } } }
  public var anchor: BotPoint?
  /// Named points other parts attach to (heads: top, side, earL, earR, neck, visor; torsos: neck, armL, armR, hip, plate).
  public var anchors: [String: BotPoint]?
  /// `rows` as ASCII bytes.
  var cells: [[UInt8]]

  public init(rows: [String], anchor: BotPoint? = nil, anchors: [String: BotPoint]? = nil) {
    self.rows = rows; self.anchor = anchor; self.anchors = anchors
    cells = rows.map { Array($0.utf8) }
  }

  enum CodingKeys: String, CodingKey { case rows, anchor, anchors }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    self.init(rows: try c.decode([String].self, forKey: .rows), anchor: try c.decodeIfPresent(BotPoint.self, forKey: .anchor),
              anchors: try c.decodeIfPresent([String: BotPoint].self, forKey: .anchors))
  }
}

public struct BotPart: Sendable, Decodable {
  public var id: String
  public var label: String
  /// Integer weight (default 4).
  public var weight: Int?
  /// Integer weight per role (raw role names), overriding `weight`; 0 means never for that role.
  public var roles: [String: Int]?
  /// Zones this part takes up; two parts that share a zone never combine.
  public var occupies: [String]?
  /// Only combine with these parts of another slot (keyed by slot name).
  public var requires: [String: [String]]?
  /// Never combine with these parts of another slot (keyed by slot name).
  public var excludes: [String: [String]]?
  /// Drawings per detail level: "xs", "std", "small", "full".
  public var art: [String: BotArt]?
  /// A trait a moment's override must never remove (the orchestrators' crown and flag).
  public var keep: Bool?
  /// Head anchor an accessory attaches to (default "top").
  public var attach: String?
  /// For palettes and screens: colour slot → hex.
  public var colors: [String: String]?
  /// For screens: colours that replace `colors` at xs.
  public var colorsXs: [String: String]?
  /// For poses: [left hand, right hand], each drawn as a right hand (the left is mirrored).
  public var arms: [BotArt]?
  /// For dither styles.
  public var style: DitherStyle?

  public func weight(for role: BotRole) -> Int { roles?[role.rawValue] ?? weight ?? 4 }
}

public struct BotFrame: Sendable, Decodable {
  public var w: Int
  public var h: Int
  /// Where the head's top-left cell goes.
  public var head: BotPoint
  /// Draw a one-cell ink outline around the silhouette.
  public var outline: Bool
  /// Draw a dithered ground shadow under the feet (full body).
  public var shadow: Bool
  /// Which drawing a part uses at this level, in order of preference.
  public var uses: [String]
  /// "auto" (the bot's dither style) or "flat".
  public var shading: String
}

public struct BotCatalog: Sendable, Decodable {
  public var format: String
  public var frames: [BotSize: BotFrame]
  /// Fixed colours shared by every palette (metal, ink, flame, white, shadow).
  public var constants: [String: String]
  public var slots: [BotSlot: [BotPart]]
  public var names: [String]
  /// 4×5 glyphs for the letter chest plate, "#" = ink.
  public var glyphs: [String: [String]]
  /// The dithered ground shadow under a full-body bot, anchored at the canvas's bottom centre.
  public var ground: BotArt?
  /// 4×4 ordered-dither thresholds 0–15, indexed [y & 3][x & 3].
  public var bayer4: [[Int]]

  /// The catalog the app ships: packages/bot-avatar/fixtures/catalog.json.
  public static let standard: BotCatalog = {
    do { return try BotCatalog(json: Data(catalogJSON.utf8)) } catch { fatalError("CapcomdBot: the embedded catalog does not decode: \(error)") }
  }()

  public init(json: Data) throws {
    self = try JSONDecoder().decode(BotCatalog.self, from: json)
  }

  enum CodingKeys: String, CodingKey { case format, frames, constants, slots, names, glyphs, ground, bayer4 }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    format = try c.decode(String.self, forKey: .format)
    guard format == botCatalogFormat else { throw BotError.badCatalog("format \(format)") }
    let fr = try c.decode([String: BotFrame].self, forKey: .frames)
    frames = [:]
    for z in BotSize.allCases {
      guard let f = fr[z.rawValue] else { throw BotError.badCatalog("no frame \(z.rawValue)") }
      frames[z] = f
    }
    constants = try c.decode([String: String].self, forKey: .constants)
    let sl = try c.decode([String: [BotPart]].self, forKey: .slots)
    slots = [:]
    for s in BotSlot.allCases {
      guard let p = sl[s.rawValue] else { throw BotError.badCatalog("no slot \(s.rawValue)") }
      slots[s] = p
    }
    names = try c.decode([String].self, forKey: .names)
    glyphs = try c.decode([String: [String]].self, forKey: .glyphs)
    ground = try c.decodeIfPresent(BotArt.self, forKey: .ground)
    bayer4 = try c.decode([[Int]].self, forKey: .bayer4)
    guard bayer4.count == 4, bayer4.allSatisfy({ $0.count == 4 }) else { throw BotError.badCatalog("bayer4 is not 4×4") }
  }

  /// The parts of a slot, in catalog order.
  public func parts(_ slot: BotSlot) -> [BotPart] { slots[slot] ?? [] }

  public func part(_ slot: BotSlot, _ id: String) throws -> BotPart {
    guard let p = parts(slot).first(where: { $0.id == id }) else { throw BotError.unknownPart(slot: slot, id: id) }
    return p
  }

  func frame(_ size: BotSize) -> BotFrame { frames[size]! } // every size is checked when decoding

  /// The drawing a part uses at a size, if any.
  func art(_ p: BotPart, _ size: BotSize) -> BotArt? {
    for k in frame(size).uses { if let a = p.art?[k] { return a } }
    return nil
  }
}
