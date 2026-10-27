import XCTest
@testable import CapcomdBot

// The rules packages/bot-avatar/test checks, on the port: determinism, valid picks, clean composition, floating hands,
// moments, teams, append-only stability; plus the template mask and the menu bar faces.

let base = BotTraits(seed: "t", role: .worker, name: "Pixel", parts: [
  .palette: "orange-purple", .antenna: "ball", .accessory: "none", .head: "dome", .ears: "disc", .screen: "night", .eyes: "ovals",
  .mouth: "smile", .blush: "on", .torso: "round", .plate: "letter", .pose: "float", .legs: "boots", .dither: "checker",
])

/// The TS tests' seeds: `${p}${(Math.imul(i + 1, 0x9e3779b1) >>> 0).toString(36)}${i}`.
func seeds(_ n: Int, _ p: String = "agt-") -> [String] {
  (0..<n).map { i in "\(p)\(String(UInt32(i + 1) &* 0x9E37_79B1, radix: 36))\(i)" }
}

func clean(_ t: BotTraits, _ z: BotSize) throws -> [Int] {
  let g = try botGrid(t, size: z)
  return [g.clipped, g.offVisor]
}

final class HashTests: XCTestCase {
  func testFNVPublishedVectors() {
    XCTAssertEqual(fnv1a32("".utf8), 0x811C_9DC5)
    XCTAssertEqual(fnv1a32("a".utf8), 0xE40C_292C)
    XCTAssertEqual(fnv1a32("foobar".utf8), 0xBF9C_F968)
    XCTAssertEqual(fmix32(0), 0)
  }

  func testHkeyJoinsWithUnitSeparator() {
    XCTAssertEqual(hkey("agt-1", "head", "dome", "0"), h32("agt-1\u{1F}head\u{1F}dome\u{1F}0"))
  }

  func testMulberry32IsDeterministic() {
    for seed: UInt32 in [0, 1, 0xDEAD_BEEF, h32("agt-pl01")] {
      var a = Mulberry32(seed: seed), b = Mulberry32(seed: seed)
      for _ in 0..<500 { XCTAssertEqual(a.next(), b.next()) }
    }
    var r = botRNG(seed: "s", stream: "confetti"), m = Mulberry32(seed: hkey("s", "confetti"))
    XCTAssertEqual(r.next(), m.next())
  }

  func testSeedsMatchTheTypeScriptTests() {
    XCTAssertEqual(seeds(3), ["agt-17wdrqp0", "agt-grnhia1", "agt-1oo198z2"])
    XCTAssertEqual(seeds(2, "agt-g7-"), ["agt-g7-17wdrqp0", "agt-g7-grnhia1"])
  }
}

final class TraitsTests: XCTestCase {
  func testDeterministic() throws {
    for s in seeds(50) {
      for r in BotRole.allCases {
        let t = botTraits(seed: s, role: r)
        XCTAssertEqual(t, botTraits(seed: s, role: r))
        for z in BotSize.allCases { XCTAssertEqual(try botGrid(t, size: z), try botGrid(botTraits(seed: s, role: r), size: z)) }
      }
    }
  }

  func testRolesNormaliseAndTheNameDependsOnTheSeedAlone() {
    XCTAssertEqual(BotRole(normalizing: " Planner "), .planner)
    XCTAssertEqual(BotRole(normalizing: "sup"), .other)
    XCTAssertEqual(BotRole(normalizing: nil), .other)
    XCTAssertEqual(botTraits(seed: "x", role: " LEAD"), botTraits(seed: "x", role: .lead))
    for s in seeds(20) { for r in BotRole.allCases { XCTAssertEqual(botTraits(seed: s, role: r).name, botName(seed: s)) } }
  }

  func testPickedCombinationsAreValid() throws {
    let c = BotCatalog.standard
    for s in seeds(300) {
      for r in BotRole.allCases {
        let chosen = try chosenOf(botTraits(seed: s, role: r), c)
        for (slot, p) in chosen { XCTAssertTrue(compatible(p, slot, chosen.filter { $0.slot != slot }), "\(s) \(r) \(slot)") }
      }
    }
  }

  func testOrchestratorTraits() {
    for s in seeds(100) {
      XCTAssertEqual(botTraits(seed: s, role: .planner).antenna, "crown")
      XCTAssertEqual(botTraits(seed: s, role: .lead).antenna, "flag")
      for r in [BotRole.worker, .critic, .other] { XCTAssertFalse(["crown", "flag"].contains(botTraits(seed: s, role: r).antenna)) }
    }
  }
}

final class CompositionTests: XCTestCase {
  func testEveryPartSwappedIntoABaseBotDrawsCleanly() throws {
    for slot in BotSlot.allCases {
      for p in BotCatalog.standard.parts(slot) {
        for z in BotSize.allCases { XCTAssertEqual(try clean(withPart(base, slot: slot, id: p.id), z), [0, 0], "\(slot) \(p.id) \(z)") }
      }
    }
  }

  func testEveryHeadWithEveryHeadPartComposesCleanly() throws {
    for h in BotCatalog.standard.parts(.head) {
      for s in [BotSlot.antenna, .accessory, .ears, .eyes, .mouth, .blush, .screen] {
        for p in BotCatalog.standard.parts(s) {
          let t = try withPart(withPart(base, slot: .head, id: h.id), slot: s, id: p.id)
          if t.head != h.id { continue } // the pair is excluded by the rules
          for z in BotSize.allCases { XCTAssertEqual(try clean(t, z), [0, 0], "\(h.id) \(s) \(p.id) \(z)") }
        }
      }
    }
  }

  func testEveryTorsoWithEveryPoseLegsAndPlateComposesCleanly() throws {
    for to in BotCatalog.standard.parts(.torso) {
      for s in [BotSlot.pose, .legs, .plate] {
        for p in BotCatalog.standard.parts(s) {
          for z in BotSize.allCases {
            XCTAssertEqual(try clean(withPart(withPart(base, slot: .torso, id: to.id), slot: s, id: p.id), z), [0, 0], "\(to.id) \(s) \(p.id) \(z)")
          }
        }
      }
    }
  }

  /// Drawn pieces (anything but empty and the ground shadow), 4-connected: ink outlines touch, so a hand that is joined
  /// to the body, or whose outline runs into the body's, is one piece with it.
  func pieces(_ t: BotTraits, _ z: BotSize) throws -> Int {
    let g = try botGrid(t, size: z)
    let shadow = g.palette.firstIndex(of: BotCatalog.standard.constants["shadow"]!) ?? -2
    var seen = [Bool](repeating: false, count: g.w * g.h)
    var n = 0
    for i in 0..<g.px.count where !seen[i] && g.px[i] >= 0 && g.px[i] != shadow {
      n += 1
      var stack = [i]
      seen[i] = true
      while let j = stack.popLast() {
        let x = j % g.w, y = j / g.w
        for (dx, dy) in [(1, 0), (-1, 0), (0, 1), (0, -1)] {
          let nx = x + dx, ny = y + dy, k = ny * g.w + nx
          if nx < 0 || ny < 0 || nx >= g.w || ny >= g.h || seen[k] || g.px[k] < 0 || g.px[k] == shadow { continue }
          seen[k] = true
          stack.append(k)
        }
      }
    }
    return n
  }

  func testHandsFloatClearOfTheBody() throws {
    for head in BotCatalog.standard.parts(.head) {
      for torso in BotCatalog.standard.parts(.torso) {
        var t = base
        t.head = head.id; t.torso = torso.id; t.ears = "none"; t.antenna = "none"; t.accessory = "none"
        // small: the body plus two hands.
        XCTAssertEqual(try pieces(t, .small), 3, "\(head.id) \(torso.id) small")
        // full: body + two hands, in every pose (the spark is held, so it is part of its hand).
        for p in BotCatalog.standard.parts(.pose) {
          t.pose = p.id
          XCTAssertEqual(try pieces(t, .full), 3, "\(head.id) \(torso.id) \(p.id) full")
        }
      }
    }
  }

  func testRandomBotsAreClean() throws {
    for s in seeds(200) {
      for r in BotRole.allCases {
        let t = botTraits(seed: s, role: r)
        for z in BotSize.allCases {
          let g = try botGrid(t, size: z)
          XCTAssertEqual([g.clipped, g.offVisor], [0, 0], "\(s) \(r) \(z)")
          XCTAssertLessThanOrEqual(g.palette.count, 36)
          XCTAssertEqual(g.px.count, g.w * g.h)
        }
      }
    }
  }

  func testUnknownPartsThrow() {
    var t = base
    t.head = "nope"
    XCTAssertThrowsError(try botGrid(t, size: .xs)) { XCTAssertEqual($0 as? BotError, .unknownPart(slot: .head, id: "nope")) }
    XCTAssertThrowsError(try withOverrides(base, pose: "nope"))
    XCTAssertThrowsError(try withOverrides(base, accessory: "nope"))
    XCTAssertThrowsError(try withPart(base, slot: .eyes, id: "nope"))
  }

  func testRGBA() throws {
    let g = try botGrid(base, size: .full)
    let b = g.rgba()
    XCTAssertEqual(b.count, 32 * 32 * 4)
    for (i, v) in g.px.enumerated() {
      if v < 0 { XCTAssertEqual(b[i * 4 + 3], 0) } else { XCTAssertEqual(b[i * 4 + 3], g.palette[v] == "#00000059" ? 0x59 : 255) }
    }
    XCTAssertTrue(parseHexColor("#FF7410") == (0xFF, 0x74, 0x10, 0xFF))
  }
}

final class MaskTests: XCTestCase {
  func testTheMaskIsTheOpaqueCellsWithTheVisorCutOut() throws {
    let c = BotCatalog.standard
    for s in seeds(40) {
      for r in BotRole.allCases {
        let t = botTraits(seed: s, role: r)
        let scr = try c.part(.screen, t.screen)
        for z in BotSize.allCases {
          let g = try botGrid(t, size: z)
          var screenColours = scr.colors ?? [:]
          if z == .xs { screenColours.merge(scr.colorsXs ?? [:]) { $1 } }
          let visorHex = Set([screenColours["V"], screenColours["v"]].compactMap { $0 })
          XCTAssertEqual(g.mask.w, g.w)
          for (i, v) in g.px.enumerated() {
            if v < 0 || g.palette[v] == c.constants["shadow"] { XCTAssertFalse(g.mask.bits[i], "\(s) \(r) \(z) \(i) clear"); continue }
            // The visor (screen and bezel) is cut out. Lilac's screen and bezel colours are also body, accent and plate
            // colours, so only the night and plum screens can be told apart by colour.
            if t.screen != "lilac" && visorHex.contains(g.palette[v]) { XCTAssertFalse(g.mask.bits[i], "\(s) \(r) \(z) \(i) visor") }
          }
          // Cutting the visor leaves most of the bot: the mask is more than half of the opaque cells.
          let opaque = g.px.filter { $0 >= 0 && g.palette[$0] != c.constants["shadow"] }.count
          XCTAssertGreaterThan(g.mask.bits.filter { $0 }.count * 2, opaque)
        }
      }
    }
  }

  func testEyesStandInsideTheCutOutVisor() throws {
    var t = base
    t.screen = "night"; t.eyes = "ovals"; t.mouth = "smile"; t.blush = "on"; t.antenna = "none"; t.ears = "none"
    let g = try botGrid(t, size: .xs)
    // xs: the head lands at (1, 4) and its visor at +(2, 3), 8×5: eyes at visor rows 1–2, cols 1–2 and 5–6.
    let vx = 3, vy = 7
    for (x, y) in [(1, 1), (2, 1), (1, 2), (2, 2), (5, 1), (6, 2)] { XCTAssertTrue(g.mask[vx + x, vy + y], "eye \(x),\(y)") }
    for (x, y) in [(1, 0), (3, 1), (4, 2), (6, 0), (0, 1), (6, 4)] { XCTAssertFalse(g.mask[vx + x, vy + y], "visor \(x),\(y)") }
    // The visor's rounded corners are the head's.
    XCTAssertTrue(g.mask[vx, vy])
    // Blush tints the visor, so it is cut out too.
    for (x, y) in [(0, 3), (7, 3)] { XCTAssertFalse(g.mask[vx + x, vy + y], "blush \(x),\(y)") }
    // The head around the visor is opaque.
    XCTAssertTrue(g.mask[vx - 1, vy + 2])
    XCTAssertEqual(BotMask(rows: g.mask.rows), g.mask)
  }
}

final class MomentTests: XCTestCase {
  func testMoodsChangeTheFaceOnly() throws {
    let happy = try withOverrides(base, mood: .happy)
    XCTAssertEqual([happy.eyes, happy.mouth], ["happy", "grin"])
    var back = happy
    back.eyes = base.eyes; back.mouth = base.mouth
    XCTAssertEqual(back, base)
  }

  func testAPartyHatReplacesAnOrdinaryAntennaButNeverTheCrownOrTheFlag() throws {
    let party = try withOverrides(base, pose: "cheer", accessory: "party")
    XCTAssertEqual([party.accessory, party.antenna, party.pose], ["party", "none", "cheer"])
    for s in seeds(40) {
      let p = try withOverrides(botTraits(seed: s, role: .planner), accessory: "party")
      XCTAssertEqual([p.antenna, p.accessory], ["crown", botTraits(seed: s, role: .planner).accessory])
      XCTAssertEqual(try withOverrides(botTraits(seed: s, role: .lead), accessory: "party").antenna, "flag")
    }
  }

  func testAMoodThatNoLongerFitsTheMonocleDropsIt() throws {
    var mono = base
    mono.role = .critic; mono.accessory = "monocle"; mono.eyes = "ovals"
    XCTAssertEqual(try withOverrides(mono, mood: .oops).accessory, "none")
    for z in BotSize.allCases {
      for m in BotMood.allCases {
        XCTAssertEqual(try clean(withOverrides(botTraits(seed: "agt-cr01", role: .critic), mood: m, pose: "cheer", accessory: "party"), z), [0, 0])
      }
    }
  }
}

final class TeamTests: XCTestCase {
  func testSiblingsArePairwiseDistinctAndAddingOneNeverRepaintsTheOthers() {
    let roles = ["planner", "lead", "worker", "worker", "worker", "critic", "worker", "worker"]
    for g in 0..<100 {
      let members: [(seed: String, role: String?)] = zip(seeds(roles.count, "agt-g\(g)-"), roles).map { ($0, $1) }
      let team = botTeam(members)
      for i in 0..<team.count { for j in 0..<i { XCTAssertTrue(distinct(team[i], team[j]), "\(g) \(i) \(j)") } }
      XCTAssertEqual(botTeam(Array(members.prefix(5))), Array(team.prefix(5)))
      XCTAssertEqual(team.map(\.seed), members.map(\.seed))
    }
    XCTAssertEqual(botTeam([("agt-pl01", "planner")]).first, botTraits(seed: "agt-pl01", role: .planner))
  }
}

final class StabilityTests: XCTestCase {
  func testAppendingAPartRepaintsOnlyTheBotsItWins() throws {
    var grown = BotCatalog.standard
    var dome2 = grown.parts(.head)[0]
    dome2.id = "dome2"; dome2.weight = 4
    grown.slots[.head]!.append(dome2)
    var ovals2 = grown.parts(.eyes)[0]
    ovals2.id = "ovals2"; ovals2.weight = 4
    grown.slots[.eyes]!.append(ovals2)
    let ss = seeds(1000)
    var sameHead = 0, sameEyes = 0
    for s in ss {
      let a = botTraits(seed: s, role: .worker), b = botTraits(seed: s, role: .worker, catalog: grown)
      XCTAssertEqual([a.palette, a.antenna, a.accessory, a.name], [b.palette, b.antenna, b.accessory, b.name])
      if b.head == a.head { sameHead += 1 } else { XCTAssertEqual(b.head, "dome2") }
      if b.eyes == a.eyes { sameEyes += 1 } else { XCTAssertEqual(b.eyes, "ovals2") }
    }
    XCTAssertGreaterThan(Double(sameHead) / Double(ss.count), 0.8)
    XCTAssertGreaterThan(Double(sameEyes) / Double(ss.count), 0.8)
  }
}

final class MenuBarMarkTests: XCTestCase {
  func testTheMarkIs16By16() {
    XCTAssertEqual(menuBarMark.count, 16)
    for r in menuBarMark { XCTAssertEqual(r.count, 16); XCTAssertTrue(r.allSatisfy { $0 == "#" || $0 == "." }) }
  }

  func testFaces() {
    XCTAssertEqual(MenuBarFace.working.rows, menuBarMark)
    var idle = menuBarMark
    idle[6] = ".##..........##."; idle[7] = ".##.###..###.##."
    XCTAssertEqual(MenuBarFace.idle.rows, idle)
    var approval = menuBarMark
    approval[0] = ".............##."; approval[1] = ".............##."
    XCTAssertEqual(MenuBarFace.approval.rows, approval)
    for f in MenuBarFace.allCases {
      XCTAssertEqual([f.mask.w, f.mask.h], [16, 16])
      XCTAssertEqual(f.mask.rows, f.rows)
    }
    // The raised mitt floats: a clear row between it and the dome.
    XCTAssertFalse(MenuBarFace.approval.mask[13, 2] || MenuBarFace.approval.mask[14, 2])
  }
}
