import Foundation
import XCTest
@testable import CapcomdOnboarding

/// The prototype, read in place: its HTML (the sprite's rows and palettes) and Fixtures/prototype.json, what its own
/// script makes (refresh after the prototype changes: bun apps/menubar/app/scripts/gen-onboarding-golden.ts).
enum Prototype {
  static let here = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
  static let html = try! String(contentsOf: here.appendingPathComponent("../../../design/onboarding/onboarding.dc.html").standardizedFileURL, encoding: .utf8)
  static let golden = try! JSONSerialization.jsonObject(with: Data(contentsOf: here.appendingPathComponent("Fixtures/prototype.json"))) as! [String: Any]

  /// The text between `start` and the next `end` in the HTML.
  static func block(_ start: String, _ end: String) -> String {
    let r = html.range(of: start)!
    let rest = html[r.upperBound...]
    return String(rest[..<rest.range(of: end)!.lowerBound])
  }
  static func strings(_ s: String) -> [String] {
    let re = try! NSRegularExpression(pattern: "\"([^\"]*)\"")
    return re.matches(in: s, range: NSRange(s.startIndex..., in: s)).map { String(s[Range($0.range(at: 1), in: s)!]) }
  }
  /// `{ B: "#F28A26", b: "#B85D12" }` → [B: #F28A26, …].
  static func palette(_ s: String) -> [Character: RGB] {
    let re = try! NSRegularExpression(pattern: "([A-Za-z]): \"(#[0-9A-Fa-f]{6})\"")
    var out: [Character: RGB] = [:]
    for m in re.matches(in: s, range: NSRange(s.startIndex..., in: s)) {
      out[Character(String(s[Range(m.range(at: 1), in: s)!]))] = RGB(hex: String(s[Range(m.range(at: 2), in: s)!]))
    }
    return out
  }
  static func cells(_ any: Any?) -> [Cell] {
    (any as! [[Any]]).map { Cell(x: ($0[0] as! NSNumber).intValue, y: ($0[1] as! NSNumber).intValue, color: RGB(hex: $0[2] as! String)) }
  }
}

final class SpriteTests: XCTestCase {
  func testRowsArePrototypeRows() {
    let rows = Prototype.strings(Prototype.block("const ROWS = [", "];"))
    XCTAssertEqual(rows.count, 16)
    XCTAssertEqual(Sprite.rows, rows)
    XCTAssertTrue(Sprite.rows.allSatisfy { $0.count == 16 })
  }

  func testPalettesArePrototypePalettes() {
    let pal = Prototype.block("const PAL = {", "};")
    let orange = Prototype.palette(String(pal[pal.range(of: "orange:")!.upperBound...].prefix { $0 != "}" }))
    let purple = Prototype.palette(String(pal[pal.range(of: "purple:")!.upperBound...].prefix { $0 != "}" }))
    XCTAssertEqual(Sprite.palettes[.orange], orange)
    XCTAssertEqual(Sprite.palettes[.purple], purple)
    XCTAssertEqual(Sprite.screen, Prototype.palette(Prototype.block("const SCREEN = {", "};")))
  }

  func testBodiesLidsAndFacesMatchThePrototypesBoxShadows() {
    let g = Prototype.golden["sprite"] as! [String: [String: Any]]
    for c in Sprite.Colorway.allCases {
      for m in Sprite.Mood.allCases {
        let want = g["\(c.rawValue)-\(m.rawValue)"]!
        XCTAssertEqual(Sprite.body(c, m).cells, Prototype.cells(want["body"]), "\(c) \(m) body")
        XCTAssertEqual(Sprite.lids(c, m).cells, Prototype.cells(want["lids"]), "\(c) \(m) lids")
        XCTAssertEqual(Sprite.faceOff(c, m).cells, Prototype.cells(want["face"]), "\(c) \(m) face")
      }
    }
    XCTAssertTrue(Sprite.lids(.orange, .happy).cells.isEmpty)
  }

  func testHeadAndLaptop() {
    let heads = Prototype.golden["head"] as! [String: Any]
    XCTAssertEqual(Sprite.head(.orange).cells, Prototype.cells(heads["orange"]))
    XCTAssertEqual(Sprite.head(.purple).cells, Prototype.cells(heads["purple"]))
    XCTAssertEqual(Sprite.head(.orange).width, 14); XCTAssertEqual(Sprite.head(.orange).height, 12)
    let lap = Prototype.golden["laptop"] as! [String: Any]
    XCTAssertEqual(Sprite.laptop().cells, Prototype.cells(lap["cells"]))
    XCTAssertEqual(Sprite.laptop().width, (lap["w"] as! NSNumber).intValue)
    XCTAssertEqual(Sprite.laptop().height, (lap["h"] as! NSNumber).intValue)
  }

  func testEveryCellIsInsideItsGrid() {
    for g in [Sprite.body(.orange), Sprite.head(.purple), Sprite.laptop()] {
      XCTAssertTrue(g.cells.allSatisfy { $0.x >= 0 && $0.x < g.width && $0.y >= 0 && $0.y < g.height })
    }
  }
}

final class PourTests: XCTestCase {
  func testHeadsAndSparksAreThePrototypes() {
    let (heads, sparks) = Pour.make()
    let want = Prototype.golden["minis"] as! [[String: Any]]
    XCTAssertEqual(heads.count, 34)
    XCTAssertEqual(want.count, heads.count)
    for (h, w) in zip(heads, want) {
      XCTAssertEqual(h.cell, (w["p"] as! NSNumber).intValue, "head \(h.index)")
      XCTAssertEqual(h.colorway.rawValue, w["color"] as! String)
      XCTAssertEqual(h.dx, (w["dx"] as! NSNumber).intValue)
      XCTAssertEqual(h.up, (w["up"] as! NSNumber).intValue)
      XCTAssertEqual(h.fall, (w["fall"] as! NSNumber).intValue)
      XCTAssertEqual(h.rotation, (w["rot"] as! NSNumber).intValue)
      XCTAssertEqual(h.delay, (w["delay"] as! NSNumber).doubleValue, accuracy: 1e-9)
      XCTAssertEqual(h.duration, (w["dur"] as! NSNumber).doubleValue, accuracy: 1e-9)
      XCTAssertEqual(h.offset.x, (w["offX"] as! NSNumber).intValue)
      XCTAssertEqual(h.offset.y, (w["offY"] as! NSNumber).intValue)
    }
    let ws = Prototype.golden["sparks"] as! [[String: Any]]
    XCTAssertEqual(sparks.map(\.x), ws.map { ($0["x"] as! NSNumber).intValue })
    XCTAssertEqual(sparks.map(\.delay), ws.map { ($0["d"] as! NSNumber).doubleValue })
  }

  func testSeededSoEveryRunIsTheSame() {
    XCTAssertEqual(Pour.make().heads, Pour.make().heads)
    XCTAssertEqual(Pour.make().sparks, Pour.make().sparks)
    var a = Mulberry32(seed: 29), b = Mulberry32(seed: 29)
    for _ in 0..<100 { XCTAssertEqual(a.next(), b.next()) }
  }

  func testArcsAreBallistic() {
    for h in Pour.make().heads {
      // Before its delay a head waits under the lid, unseen.
      XCTAssertEqual(h.y.value(at: h.delay - 0.1, base: 0), 24)
      XCTAssertEqual(h.opacity.value(at: h.delay - 0.1, base: 1), 0)
      // x at constant speed.
      XCTAssertEqual(h.x.value(at: h.delay + h.duration / 2, base: 0), Double(h.dx) / 2, accuracy: 1e-6)
      // The top of the arc at 42 %, then down past the lid; out by the end.
      XCTAssertEqual(h.y.value(at: h.delay + 0.42 * h.duration, base: 0), Double(h.up), accuracy: 1e-6)
      XCTAssertEqual(h.y.value(at: h.delay + h.duration, base: 0), Double(h.fall), accuracy: 1e-6)
      XCTAssertEqual(h.opacity.value(at: h.delay + 0.5 * h.duration, base: 0), 1)
      XCTAssertEqual(h.opacity.value(at: h.delay + h.duration, base: 0), 0)
      // Up eases out (fast first), down eases in (slow first): a quarter of the way up covers more than a quarter.
      let upQuarter = h.y.value(at: h.delay + 0.105 * h.duration, base: 0)
      XCTAssertLessThan(upQuarter, 24 + (Double(h.up) - 24) * 0.25)
      let downQuarter = h.y.value(at: h.delay + (0.42 + 0.145) * h.duration, base: 0)
      XCTAssertLessThan(downQuarter, Double(h.up) + (Double(h.fall) - Double(h.up)) * 0.25)
      XCTAssertEqual(h.spin.value(at: h.delay + h.duration, base: 0), Double(h.rotation), accuracy: 1e-9)
    }
    // Every head is gone before the props are taken away.
    XCTAssertLessThan(Pour.lastLanding(Pour.make().heads), Intro.propsGone)
    // They still fall when the window opens.
    XCTAssertGreaterThan(Pour.lastLanding(Pour.make().heads), Intro.windowOpens)
  }
}

final class SceneryTests: XCTestCase {
  func testTracesAreThePrototypes() {
    let bg = Prototype.golden["bg"] as! [String: [[String: Any]]]
    let (pix, rings) = Scenery.traces()
    func same(_ a: [TracePixel], _ b: [[String: Any]], _ what: String) {
      XCTAssertEqual(a.count, b.count, what)
      for (p, w) in zip(a, b) {
        XCTAssertEqual(p.x, (w["x"] as! NSNumber).intValue, what); XCTAssertEqual(p.y, (w["y"] as! NSNumber).intValue, what)
        XCTAssertEqual(p.color, RGB(hex: w["c"] as! String), what); XCTAssertEqual(p.delay, (w["d"] as! NSNumber).doubleValue, accuracy: 1e-9)
      }
    }
    same(pix, bg["pix"]!, "pixels")
    same(rings, bg["rings"]!, "rings")
    // Kept to the margins (a plus mark's arms may reach 4 pt past the line).
    XCTAssertFalse(pix.contains { $0.x > 224 && $0.x < 976 && $0.y > 88 && $0.y < 696 })
  }

  func testCometsAreThePrototypes() {
    let want = Prototype.golden["comets"] as! [[String: Any]]
    XCTAssertEqual(Comet.all.count, 5)
    for (c, w) in zip(Comet.all, want) {
      XCTAssertEqual(c.x, (w["x"] as! NSNumber).doubleValue); XCTAssertEqual(c.y, (w["y"] as! NSNumber).doubleValue)
      XCTAssertEqual(c.rotation, (w["rot"] as! NSNumber).doubleValue); XCTAssertEqual(c.length, (w["len"] as! NSNumber).doubleValue)
      XCTAssertEqual(c.cycle, (w["cycle"] as! NSNumber).doubleValue); XCTAssertEqual(c.delay, (w["delay"] as! NSNumber).doubleValue)
      XCTAssertEqual(c.color, RGB(hex: w["color"] as! String))
    }
  }

  func testACometCrossesOnceACycleAndWaitsOff() {
    let c = Comet.all[0]
    XCTAssertEqual(c.state(at: 0).opacity, 0)                                   // before its delay
    XCTAssertEqual(c.state(at: c.delay + 0.04 * c.cycle).opacity, 0.75, accuracy: 1e-9)
    XCTAssertEqual(c.state(at: c.delay + 0.2 * c.cycle).opacity, 0.75, accuracy: 1e-9)
    let end = c.state(at: c.delay + 0.34 * c.cycle)
    XCTAssertEqual(end.opacity, 0, accuracy: 1e-9)
    // Down and to the left (its heading, 158°), the length of its trip.
    XCTAssertEqual(hypot(end.x - c.x, end.y - c.y), c.length, accuracy: 1e-6)
    XCTAssertLessThan(end.x, c.x); XCTAssertGreaterThan(end.y, c.y)
    XCTAssertEqual(c.state(at: c.delay + 0.7 * c.cycle).opacity, 0)              // waiting off
    // The next cycle starts over from the same place.
    let again = c.state(at: c.delay + c.cycle + 0.1 * c.cycle), first = c.state(at: c.delay + 0.1 * c.cycle)
    XCTAssertEqual(again.x, first.x, accuracy: 1e-6); XCTAssertEqual(again.opacity, first.opacity, accuracy: 1e-9)
    // Never in step: their first crossings start seconds apart.
    let starts = Comet.all.map(\.delay).sorted()
    XCTAssertTrue(zip(starts, starts.dropFirst()).allSatisfy { $1 - $0 >= 2.5 })
  }
}

final class KeyframeTests: XCTestCase {
  func testCurves() {
    XCTAssertEqual(Curve.linear.apply(0.3), 0.3, accuracy: 1e-12)
    XCTAssertEqual(Curve.ease.apply(0.5), 0.8024033877399112, accuracy: 1e-4)   // the browser's value
    XCTAssertEqual(Curve.expo.apply(0), 0); XCTAssertEqual(Curve.expo.apply(1), 1)
    XCTAssertGreaterThan(Curve.expo.apply(0.2), 0.7)                               // expo out: most of it early
    XCTAssertEqual(Curve.inOut.apply(0.5), 0.5, accuracy: 1e-6)
    XCTAssertEqual(Curve.steps(2).apply(0.49), 0); XCTAssertEqual(Curve.steps(2).apply(0.5), 0.5); XCTAssertEqual(Curve.steps(2).apply(1), 1)
    for x in stride(from: 0.0, through: 1, by: 0.01) { XCTAssertLessThanOrEqual(Curve.out.apply(x), 1 + 1e-9) }
  }

  func testTimedHoldsBothEndsAndRepeats() {
    let t = Timed(Track(from: 0, to: 10, .linear), duration: 2, delay: 1)
    XCTAssertEqual(t.value(at: 0, base: 5), 0)
    XCTAssertEqual(t.value(at: 2, base: 5), 5, accuracy: 1e-12)
    XCTAssertEqual(t.value(at: 9, base: 5), 10)
    let noFill = Timed(Track([(0, 0), (0.5, 3), (1, 0)], all: .steps(2)), duration: 0.12, delay: 2.25, repeats: 8, fills: false)
    XCTAssertEqual(noFill.value(at: 2, base: 0), 0)
    XCTAssertEqual(noFill.value(at: 2.25 + 0.065, base: 0), 3)
    XCTAssertEqual(noFill.value(at: 2.25 + 0.12 * 8 + 0.01, base: 7), 7)
    let loop = Intro.bob
    XCTAssertEqual(loop.value(at: 1.6, base: 0), -10, accuracy: 1e-9)
    XCTAssertEqual(loop.value(at: 3.2 * 5 + 1.6, base: 0), -10, accuracy: 1e-9)
  }
}

final class IntroTests: XCTestCase {
  func testWelcomeLayoutIsThePrototypes() {
    // The flex column worked out: his top 152.75 (rounded), so he waits 131 below it to sit on the window's centre.
    XCTAssertEqual(WelcomeLayout.columnHeight, 454.5, accuracy: 1e-9)
    XCTAssertEqual(WelcomeLayout.heroTop, 153)
    XCTAssertEqual(WelcomeLayout.liftOffset, 131)
    XCTAssertEqual(WelcomeLayout.heroLeft, 504)
  }

  func testTheLiftCrouchesOvershootsAndSettles() {
    let dy = WelcomeLayout.liftOffset, l = Intro.lift(dy: dy), at = Intro.windowOpens
    XCTAssertEqual(l.y.value(at: at - 1, base: 0), dy)                      // waiting at the centre
    XCTAssertEqual(l.y.value(at: at + 0.13 * 1.2, base: 0), dy + 14, accuracy: 1e-9)   // the crouch
    XCTAssertEqual(l.scaleY.value(at: at + 0.13 * 1.2, base: 1), 0.94, accuracy: 1e-9)
    XCTAssertEqual(l.y.value(at: at + 0.56 * 1.2, base: 0), -12, accuracy: 1e-9)       // past his mark
    XCTAssertEqual(l.y.value(at: at + 1.2, base: 0), 0)                                // home
    XCTAssertEqual(l.scaleX.value(at: at + 1.2, base: 1), 1)
  }

  func testTheTimelineIsInOrder() {
    XCTAssertLessThan(Intro.signal.delay, Intro.scanLine.delay)
    XCTAssertLessThan(Intro.scanLine.end, Intro.crt.end)
    XCTAssertLessThanOrEqual(Intro.faceCover.end, Intro.firstBlink.delay + 0.001)
    XCTAssertLessThan(Intro.firstBlink.end, Intro.laptopPullY.end)
    XCTAssertLessThan(Intro.laptopPullY.end, Pour.make().heads[0].delay)
    XCTAssertEqual(Intro.backdrop.delay, 3.7)
    // The face: on, flickers once, then on for good by 1.4 s.
    XCTAssertEqual(Intro.faceCover.value(at: 0.5, base: 0), 1)
    XCTAssertEqual(Intro.faceCover.value(at: 0.81 * 1.6, base: 0), 0, accuracy: 1e-9)
    XCTAssertEqual(Intro.faceCover.value(at: 0.84 * 1.6, base: 0), 1, accuracy: 1e-9)
    XCTAssertEqual(Intro.faceCover.value(at: 1.5, base: 0), 0)
  }
}

final class FlowTests: XCTestCase {
  func testStepsDotsAndFooter() {
    XCTAssertEqual(Step.allCases.count, 7)
    XCTAssertEqual(Step.allCases.filter(\.showsDots), [.welcome, .boot, .crew, .project, .goal])
    XCTAssertEqual(Step.allCases.filter(\.showsFooter), [.boot, .crew, .project, .goal])
    XCTAssertEqual(Step.allCases.filter(\.canSkip), [.goal])
    XCTAssertEqual(dots(.project), [.done, .done, .done, .on, .off])
    XCTAssertEqual(Step.crew.dotsLabel, "Step 3 of 5")
    XCTAssertEqual(Step.allSet.previous, .goal)
  }

  func testPrimaryButtonPerScreen() {
    var f = Flow()
    XCTAssertEqual(f.primary, .getStarted)
    XCTAssertTrue(f.go(.boot))
    XCTAssertEqual(f.primary, .boot); XCTAssertEqual(f.primary?.label, "Boot capcomd")
    f.boot.begin()
    XCTAssertEqual(f.primary, .booting); XCTAssertFalse(f.primaryEnabled); XCTAssertFalse(f.backEnabled)
    f.boot.advance(); f.boot.advance(); f.boot.advance()
    XCTAssertTrue(f.boot.done)
    XCTAssertEqual(f.primary, .next); XCTAssertEqual(f.primary?.label, "Continue")
    XCTAssertTrue(f.go(.crew)); XCTAssertEqual(f.primary, .next)
    XCTAssertTrue(f.go(.project))
    XCTAssertFalse(f.primaryEnabled)                         // nothing picked yet
    f.project = "/Users/me/Developer/app"; XCTAssertFalse(f.primaryEnabled)
    f.projectReady = true; XCTAssertTrue(f.primaryEnabled)
    XCTAssertTrue(f.go(.goal))
    XCTAssertEqual(f.primary, .launch); XCTAssertEqual(f.primary?.label, "Launch crew")
    XCTAssertFalse(f.primaryEnabled)
    f.goal = "   "; XCTAssertFalse(f.primaryEnabled)
    f.goal = Launch.suggestions[0]; XCTAssertTrue(f.primaryEnabled)
    XCTAssertTrue(f.go(.launch)); XCTAssertNil(f.primary)    // until the run starts
    f.runId = "run-1"; XCTAssertEqual(f.primary, .openCapcomd)
  }

  func testBootMustFinishBeforeTheRest() {
    var f = Flow(step: .boot)
    XCTAssertFalse(f.go(.crew)); XCTAssertFalse(f.go(.allSet))
    XCTAssertEqual(f.step, .boot)
    XCTAssertEqual(Flow().primaryEnabled, true)
    f.boot.cliMissing = true
    XCTAssertFalse(f.primaryEnabled)                         // Boot waits for the CLI
  }

  func testSkipLeadsToAllSetAndBackToTheGoal() {
    var f = Flow(step: .boot)
    f.boot.begin(); for _ in 0..<3 { f.boot.advance() }
    f.go(.goal)
    f.skip()
    XCTAssertEqual(f.step, .allSet); XCTAssertEqual(f.primary, .openCapcomd)
    XCTAssertFalse(f.step.showsDots); XCTAssertFalse(f.step.showsFooter)
    f.back()
    XCTAssertEqual(f.step, .goal)
    var g = Flow(step: .crew); g.boot.stage = 4
    g.skip()
    XCTAssertEqual(g.step, .crew)                            // only the goal skips
  }

  func testBackToWelcomeStartsAnUnfinishedBootOver() {
    var f = Flow(step: .boot)
    f.boot.begin(); f.boot.fail("capcomd didn't answer.")
    f.go(.welcome)
    XCTAssertEqual(f.boot, Boot())
    var g = Flow(step: .boot); g.boot.stage = 4
    g.go(.welcome)
    XCTAssertTrue(g.boot.done)                              // a finished boot stays finished
  }
}

final class BootTests: XCTestCase {
  func testRowsAsTheyRun() {
    var b = Boot()
    XCTAssertEqual((0..<3).map(b.label), Boot.waiting)
    XCTAssertEqual(b.bubble, "Ready when you are.")
    XCTAssertEqual(b.fill, 0)
    b.begin()
    XCTAssertEqual(b.row(0), .running); XCTAssertEqual(b.label(0), "Looking for capcomd…"); XCTAssertEqual(b.row(1), .waiting)
    XCTAssertEqual(b.bubble, "Looking around…")
    b.version = "0.9.0"; b.path = "/opt/homebrew/bin/capcomd"
    b.advance()
    XCTAssertEqual(b.row(0), .done); XCTAssertEqual(b.label(0), "Found capcomd"); XCTAssertEqual(b.detail(0), "0.9.0 · /opt/homebrew/bin/capcomd")
    XCTAssertEqual(b.label(1), "Starting capcomd…"); XCTAssertEqual(b.bubble, "Warming up the engine…"); XCTAssertEqual(b.fill, 60)
    b.advance()
    XCTAssertEqual(b.detail(1), "in the background, and whenever you log in")
    XCTAssertEqual(b.label(2), "Pairing this Mac…"); XCTAssertEqual(b.bubble, "Shaking hands…"); XCTAssertEqual(b.fill, 120)
    b.advance()
    XCTAssertTrue(b.done); XCTAssertEqual((0..<3).map(b.label), Boot.done)
    XCTAssertEqual(b.detail(2), "its key is kept in your Keychain"); XCTAssertEqual(b.bubble, "All systems go!")
    b.atLogin = false
    XCTAssertEqual(b.detail(1), "in the background, until you quit it")
  }

  func testAFailureStopsOnItsRowAndRetriesFromThere() {
    var b = Boot(); b.begin(); b.advance()
    XCTAssertTrue(b.switchEnabled == false)
    b.fail("capcomd didn't start yet.")
    XCTAssertEqual(b.row(0), .done); XCTAssertEqual(b.row(1), .failed("capcomd didn't start yet."))
    XCTAssertEqual(b.detail(1), "capcomd didn't start yet."); XCTAssertEqual(b.label(1), "Start capcomd")
    XCTAssertFalse(b.running); XCTAssertTrue(b.switchEnabled)
    XCTAssertEqual(b.bubble, Boot.failedBubble)
    XCTAssertEqual(Flow(step: .boot).primary, .boot)
    var f = Flow(step: .boot); f.boot = b
    XCTAssertEqual(f.primary, .retry); XCTAssertTrue(f.backEnabled)
    b.retry()
    XCTAssertEqual(b.stage, 2); XCTAssertEqual(b.row(1), .running)
  }

  func testMissingCLI() {
    var b = Boot(); b.cliMissing = true
    XCTAssertEqual(b.bubble, "Hmm, I can't find capcomd.")
  }
}

final class GateTests: XCTestCase {
  func testWhenItShows() {
    let first = Record(), seen = Record(seen: true), done = Record(seen: true, finished: true)
    XCTAssertTrue(Gate.shows(first, link: .unknown))
    XCTAssertTrue(Gate.shows(first, link: .connected))
    XCTAssertFalse(Gate.shows(seen, link: .unknown))
    XCTAssertFalse(Gate.shows(seen, link: .connected))
    XCTAssertTrue(Gate.shows(seen, link: .needsSetup))      // not finished, and it can't connect
    XCTAssertFalse(Gate.shows(seen, link: .needsSetup, dismissed: true))   // closed this launch: not again until the next
    for l in [Link.unknown, .connected, .needsSetup] { XCTAssertFalse(Gate.shows(done, link: l)) }
    XCTAssertEqual(Gate.firstStep(first), .welcome)
    XCTAssertEqual(Gate.firstStep(seen), .boot)
    XCTAssertTrue(Gate.holdsMainWindow(first)); XCTAssertFalse(Gate.holdsMainWindow(seen)); XCTAssertFalse(Gate.holdsMainWindow(done))
  }

  func testTheIntroPlaysOnceUnlessAskedAndNeverWithReduceMotion() {
    XCTAssertTrue(Gate.playsIntro(Record(), asked: false, reduceMotion: false))
    XCTAssertFalse(Gate.playsIntro(Record(seen: true), asked: false, reduceMotion: false))
    XCTAssertTrue(Gate.playsIntro(Record(seen: true, finished: true), asked: true, reduceMotion: false))
    XCTAssertFalse(Gate.playsIntro(Record(), asked: false, reduceMotion: true))
    XCTAssertFalse(Gate.playsIntro(Record(seen: true), asked: true, reduceMotion: true))
  }

  func testRecordPersists() {
    var stored: [String: Bool] = [:]
    XCTAssertEqual(Record { stored[$0] ?? false }, Record())
    Record(seen: true, finished: true).write { stored[$0] = $1 }
    XCTAssertEqual(stored, ["capcomd.onboarding.seen": true, "capcomd.onboarding.finished": true])
    XCTAssertEqual(Record { stored[$0] ?? false }, Record(seen: true, finished: true))
  }
}

final class LaunchTests: XCTestCase {
  func testChoreography() {
    XCTAssertEqual(Launch.stage(atMs: 0), 0)
    XCTAssertFalse(Launch.showsPlanner(atMs: 249)); XCTAssertTrue(Launch.showsPlanner(atMs: 250))
    XCTAssertTrue(Launch.showsCircuit(atMs: 1000))
    XCTAssertTrue(Launch.showsPackets(atMs: 2100)); XCTAssertFalse(Launch.showsDone(atMs: 3199)); XCTAssertTrue(Launch.showsDone(atMs: 3200))
  }

  func testWorkersLandAtTheirTimeOnceTheyExist() {
    XCTAssertFalse(Launch.showsWorker(0, atMs: 1599, workers: 3))
    XCTAssertTrue(Launch.showsWorker(0, atMs: 1600, workers: 3))
    XCTAssertFalse(Launch.showsWorker(1, atMs: 1600, workers: 3)); XCTAssertTrue(Launch.showsWorker(1, atMs: 1850, workers: 3))
    XCTAssertTrue(Launch.showsWorker(2, atMs: 2100, workers: 3))
    XCTAssertFalse(Launch.showsWorker(0, atMs: 9000, workers: 0))   // no worker yet: nothing lands
    XCTAssertTrue(Launch.showsWorker(0, atMs: 9000, workers: 1)); XCTAssertFalse(Launch.showsWorker(1, atMs: 9000, workers: 1))
    XCTAssertFalse(Launch.showsWorker(3, atMs: 9000, workers: 5))   // three places
  }

  /// No bots on Launch: nodes on the circuit, read top-down, with no gap where the planner bot stood.
  func testNodesReadTopDown() {
    // The planner's node is centred where the prototype's planner bot was (7 pt cells at top 92: 92 + 56).
    XCTAssertEqual(Launch.plannerNodeTop + Launch.nodeSide / 2, 148)
    XCTAssertLessThan(Launch.plannerNodeTop + Launch.nodeSide, Launch.plannerLabelTop)
    XCTAssertLessThan(Launch.plannerLabelTop + 44, Launch.traceTop)             // name and status, then the trace
    XCTAssertEqual(Launch.traceTop + Launch.traceHeight, Launch.busTop)          // the trace meets the bus
    XCTAssertEqual(Launch.nodeTop, Launch.busTop + Launch.dropHeight)           // each drop ends on its node
    XCTAssertLessThan(Launch.nodeTop + Launch.nodeSide, Launch.workerLabelTop)
    XCTAssertLessThan(Launch.workerLabelTop + 44, Launch.doneTop)
  }

  func testANodeFillsWithoutBouncing() {
    XCTAssertEqual(Launch.fill(atMs: 1000, from: 1000), 0)
    XCTAssertEqual(Launch.fill(atMs: 1000 + Launch.fillMs, from: 1000), 1)
    var last = 0.0
    for t in stride(from: 1000, through: 1000 + Launch.fillMs + 200, by: 10) {
      let f = Launch.fill(atMs: t, from: 1000)
      XCTAssertGreaterThanOrEqual(f, last); XCTAssertLessThanOrEqual(f, 1)   // monotonic, never past full
      last = f
    }
    XCTAssertGreaterThan(Launch.fill(atMs: 1000 + Launch.fillMs / 4, from: 1000), 0.6)   // expo out: most of it early
  }
}

final class RepoScanTests: XCTestCase {
  var home = ""
  let fm = FileManager.default

  override func setUpWithError() throws {
    let base = URL(fileURLWithPath: NSTemporaryDirectory()).appendingPathComponent("onboarding-scan-\(UUID().uuidString)")
    try fm.createDirectory(at: base, withIntermediateDirectories: true)
    home = RepoScan.standard(try fm.destinationOfSymbolicLinkIfAny(base.path))
  }
  override func tearDownWithError() throws { try? fm.removeItem(atPath: home) }

  func repo(_ rel: String, branch: String = "main") {
    let p = home + "/" + rel
    try! fm.createDirectory(atPath: p + "/.git", withIntermediateDirectories: true)
    try! "ref: refs/heads/\(branch)\n".write(toFile: p + "/.git/HEAD", atomically: true, encoding: .utf8)
  }
  func dir(_ rel: String) { try! fm.createDirectory(atPath: home + "/" + rel, withIntermediateDirectories: true) }

  func testFindsReposTwoLevelsDownInTheUsualFolders() {
    repo("Developer/app"); repo("Developer/org/api", branch: "dev"); repo("Code/site"); repo("Projects/tool"); repo("src/lib")
    repo("Developer/org/deeper/three")               // three levels down: not looked at
    repo("Developer/app/vendor/inner")               // inside a repository: never descended into
    repo("Developer/node_modules/pkg"); repo("Developer/.hidden/secret")
    repo("Elsewhere/notlooked")                      // not one of the usual folders
    let found = RepoScan.scan(home: home)
    XCTAssertEqual(Set(found.map { RepoScan.display($0.path, home: home) }),
                   ["~/Developer/app", "~/Developer/org/api", "~/Code/site", "~/Projects/tool", "~/src/lib"])
    XCTAssertEqual(found.first { $0.name == "api" }?.branch, "dev")
    XCTAssertEqual(found.first { $0.name == "app" }?.branch, "main")
    XCTAssertTrue(found.allSatisfy { !$0.known })
  }

  func testNeverOpensProtectedFolders() throws {
    repo("Documents/private"); repo("Desktop/thing")
    // ~/src is a symlink into Documents: not followed. A symlink below a root is never followed either.
    try fm.createSymbolicLink(atPath: home + "/src", withDestinationPath: home + "/Documents")
    dir("Developer")
    try fm.createSymbolicLink(atPath: home + "/Developer/docs", withDestinationPath: home + "/Desktop")
    XCTAssertEqual(RepoScan.scan(home: home), [])
    for p in ["Documents", "Documents/x", "Desktop", "Downloads/a", "Library/Mobile Documents/com~apple~CloudDocs", "Pictures", "Music/x"] {
      XCTAssertTrue(RepoScan.isProtected(home + "/" + p, home: home), p)
    }
    XCTAssertTrue(RepoScan.isProtected("/Volumes/USB/code", home: home))
    for p in ["Developer", "Developer/Documents", "Code/x", "DocumentsArchive"] { XCTAssertFalse(RepoScan.isProtected(home + "/" + p, home: home), p) }
  }

  func testASymlinkedRootIsFollowedWhenItIsSafe() throws {
    repo("Work/one")
    try fm.createSymbolicLink(atPath: home + "/Developer", withDestinationPath: home + "/Work")
    XCTAssertEqual(RepoScan.scan(home: home).map(\.name), ["one"])
  }

  func testBounded() {
    for i in 0..<(RepoScan.maxFound + 15) { repo(String(format: "Developer/r%03d", i)) }
    XCTAssertEqual(RepoScan.scan(home: home).count, RepoScan.maxFound)
  }

  func testWorktreeAndDetachedHeads() throws {
    repo("Developer/main-repo")
    let gitdir = home + "/Developer/main-repo/.git/worktrees/feature"
    try fm.createDirectory(atPath: gitdir, withIntermediateDirectories: true)
    try "ref: refs/heads/feature/x\n".write(toFile: gitdir + "/HEAD", atomically: true, encoding: .utf8)
    dir("Developer/feature")
    try "gitdir: \(gitdir)\n".write(toFile: home + "/Developer/feature/.git", atomically: true, encoding: .utf8)
    repo("Code/detached")
    try "0123456789abcdef0123456789abcdef01234567\n".write(toFile: home + "/Code/detached/.git/HEAD", atomically: true, encoding: .utf8)
    let found = RepoScan.scan(home: home)
    XCTAssertEqual(found.first { $0.name == "feature" }?.branch, "feature/x")
    XCTAssertEqual(found.first { $0.name == "detached" }?.branch, "0123456")
  }

  func testCapcomdsProjectsComeFirstWithoutRepeats() {
    repo("Developer/app"); repo("Developer/other"); repo("Elsewhere/known")
    let scanned = RepoScan.scan(home: home)
    let merged = RepoScan.merge(known: [home + "/Elsewhere/known", home + "/Developer/app/", home + "/Gone/missing", home + "/Documents/secret"],
                                scanned: scanned, home: home)
    XCTAssertEqual(merged.map { RepoScan.display($0.path, home: home) }, ["~/Elsewhere/known", "~/Developer/app", "~/Documents/secret", "~/Developer/other"])
    XCTAssertEqual(merged.map(\.known), [true, true, true, false])
    // A project in a protected folder is listed but never opened (no branch read).
    XCTAssertNil(merged[2].branch)
    XCTAssertEqual(merged[0].branch, "main")
  }

  func testDisplay() {
    XCTAssertEqual(RepoScan.display("/Users/me/Developer/x", home: "/Users/me"), "~/Developer/x")
    XCTAssertEqual(RepoScan.display("/Users/me", home: "/Users/me/"), "~")
    XCTAssertEqual(RepoScan.display("/opt/x", home: "/Users/me"), "/opt/x")
    XCTAssertEqual(RepoScan.display("/Users/meadow/x", home: "/Users/me"), "/Users/meadow/x")
  }
}

extension FileManager {
  /// /var → /private/var and the like, so paths compare as the scan sees them.
  func destinationOfSymbolicLinkIfAny(_ p: String) throws -> String { (p as NSString).resolvingSymlinksInPath }
}
