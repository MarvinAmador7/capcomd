import Foundation
import XCTest
@testable import CapcomdBot

/// packages/bot-avatar/fixtures, read in place: the TypeScript engine's catalog and golden bots. The port must match
/// them bit for bit (refresh after an intended change: bun packages/bot-avatar/scripts/golden.ts, then
/// apps/menubar/app/scripts/gen-bot-catalog.sh).
enum Fixtures {
  static let dir = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    .appendingPathComponent("../../../../../packages/bot-avatar/fixtures").standardizedFileURL

  struct Golden: Decodable {
    struct Hash: Decodable { let s: String; let h32: UInt32 }
    struct PRNG: Decodable { let seed: UInt32; let first: [UInt32] }
    struct Size: Decodable { let palette: [String]; let rows: [String] }
    struct Case: Decodable { let seed: String; let role: String; let traits: BotTraits; let sizes: [String: Size] }
    struct Member: Decodable { let seed, name, palette, head, eyes, antenna: String }
    struct Moment: Decodable { let traits: BotTraits; let full: [String] }
    let format: String
    let catalog: String
    let hash: [Hash]
    let mulberry32: PRNG
    let cases: [Case]
    let team: [Member]
    let moment: Moment
    let menuBarMark: [String]
  }

  static let golden: Golden = {
    let data = try! Data(contentsOf: dir.appendingPathComponent("golden/bots.json"))
    return try! JSONDecoder().decode(Golden.self, from: data)
  }()
}

final class CatalogTests: XCTestCase {
  func testEmbeddedCatalogIsThePackageFile() throws {
    let file = try Data(contentsOf: Fixtures.dir.appendingPathComponent("catalog.json"))
    XCTAssertTrue(Data(catalogJSON.utf8) == file,
                  "Sources/CapcomdBot/CatalogJSON.swift is stale: run apps/menubar/app/scripts/gen-bot-catalog.sh")
  }

  func testStandardCatalogDecodes() {
    let c = BotCatalog.standard
    XCTAssertEqual(c.format, "bot-catalog/1")
    XCTAssertEqual(BotSize.allCases.map { [c.frames[$0]!.w, c.frames[$0]!.h] }, [[14, 14], [24, 24], [32, 32]])
    XCTAssertEqual(BotSlot.allCases.map { c.parts($0).count }, [7, 8, 8, 6, 4, 3, 9, 7, 2, 3, 6, 4, 3, 4])
    XCTAssertEqual(c.names.count, 64)
    XCTAssertEqual(c.glyphs.count, 26)
    XCTAssertNotNil(c.ground)
    XCTAssertEqual(try c.part(.antenna, "crown").keep, true)
    XCTAssertThrowsError(try c.part(.head, "nope")) { XCTAssertEqual($0 as? BotError, .unknownPart(slot: .head, id: "nope")) }
  }
}

final class GoldenTests: XCTestCase {
  let g = Fixtures.golden

  func testFormats() {
    XCTAssertEqual(g.format, "bot-golden/1")
    XCTAssertEqual(g.catalog, BotCatalog.standard.format)
  }

  func testHashVectors() {
    XCTAssertGreaterThan(g.hash.count, 4)
    for v in g.hash { XCTAssertEqual(h32(v.s), v.h32, v.s) }
  }

  func testMulberry32() {
    XCTAssertEqual(h32("agt-pl01"), g.mulberry32.seed)
    var r = Mulberry32(seed: g.mulberry32.seed)
    XCTAssertEqual((0..<g.mulberry32.first.count).map { _ in r.next() }, g.mulberry32.first)
  }

  func testTraits() {
    XCTAssertEqual(Set(g.cases.map(\.role)), Set(BotRole.allCases.map(\.rawValue)))
    for c in g.cases { XCTAssertEqual(botTraits(seed: c.seed, role: c.role), c.traits, "\(c.seed) \(c.role)") }
  }

  func testPixelRowsAtEverySize() throws {
    for c in g.cases {
      XCTAssertEqual(Set(c.sizes.keys), Set(BotSize.allCases.map(\.rawValue)))
      for z in BotSize.allCases {
        let want = try XCTUnwrap(c.sizes[z.rawValue])
        let grid = try botGrid(c.traits, size: z)
        XCTAssertEqual(grid.palette, want.palette, "\(c.seed) \(c.role) \(z)")
        XCTAssertEqual(grid.rows, want.rows, "\(c.seed) \(c.role) \(z)")
      }
    }
  }

  func testTeam() {
    let team = botTeam([("agt-pl01", "planner"), ("agt-ld01", "lead"), ("agt-wk01", "worker"), ("agt-wk01", "worker"), ("agt-wk02", "worker")])
    XCTAssertEqual(team.map { [$0.seed, $0.name, $0.palette, $0.head, $0.eyes, $0.antenna] },
                   g.team.map { [$0.seed, $0.name, $0.palette, $0.head, $0.eyes, $0.antenna] })
  }

  func testMoment() throws {
    let m = try withOverrides(botTraits(seed: "agt-wk02", role: "worker"), mood: .happy, pose: "cheer", accessory: "party")
    XCTAssertEqual(m, g.moment.traits)
    XCTAssertEqual(try botGrid(m, size: .full).rows, g.moment.full)
  }

  func testMenuBarMark() {
    XCTAssertEqual(menuBarMark, g.menuBarMark)
  }
}
