import Foundation
import XCTest
@testable import CapcomdBot

/// The menu bar marks (Settings › General › App Icon), the Settings section glyphs and the Dock icon's looks.
final class MarkTests: XCTestCase {
  /// packages/bot-avatar/src/marks.ts, read in place: `export const NAME: string[] = [ "…", … ];` rows, with the
  /// Antenna's `...MENU_BAR_MARK.slice(2)` spelled out.
  static func tsMark(_ name: String) throws -> [String] {
    let url = Fixtures.dir.deletingLastPathComponent().appendingPathComponent("src/marks.ts")
    let src = try String(contentsOf: url, encoding: .utf8)
    guard let start = src.range(of: "export const \(name): string[] = [") else { throw NSError(domain: "marks.ts has no \(name)", code: 1) }
    let body = src[start.upperBound...].prefix { $0 != ";" }
    var rows: [String] = []
    for line in body.split(separator: "\n") {
      let t = line.trimmingCharacters(in: .whitespaces)
      if t.hasPrefix("\""), let end = t.dropFirst().firstIndex(of: "\"") { rows.append(String(t[t.index(after: t.startIndex)..<end])) }
      if t.hasPrefix("...MENU_BAR_MARK.slice(2)") { rows += try tsMark("MENU_BAR_MARK").dropFirst(2) }
    }
    return rows
  }

  func testTheMarksMatchTheTypeScriptPackage() throws {
    XCTAssertEqual(try Self.tsMark("MENU_BAR_MARK"), menuBarMark)
    XCTAssertEqual(try Self.tsMark("ANTENNA_MARK"), antennaMark)
    XCTAssertEqual(try Self.tsMark("RING_MARK"), ringMark)
  }

  func testEveryMarkIs16By16AndTheDomeIsTheDefault() {
    for m in MenuBarMark.allCases {
      XCTAssertEqual(m.rows.count, 16, "\(m)")
      XCTAssertTrue(m.rows.allSatisfy { $0.count == 16 }, "\(m)")
      for f in MenuBarFace.allCases { XCTAssertEqual(f.mask(m).bits.count, 256, "\(m) \(f)") }
    }
    XCTAssertEqual(MenuBarMark(stored: nil), .dome)
    XCTAssertEqual(MenuBarMark(stored: "bogus"), .dome)
    XCTAssertEqual(MenuBarMark(stored: "ring"), .ring)
    XCTAssertEqual(MenuBarFace.working.rows(.dome), menuBarMark)
  }

  /// The Dome's faces are the ones the menu bar has always shown.
  func testTheDomesFacesAreUnchanged() {
    var idle = menuBarMark
    idle[6] = ".##..........##."; idle[7] = ".##.###..###.##."
    XCTAssertEqual(MenuBarFace.idle.rows, idle)
    var approval = menuBarMark
    approval[0] = ".............##."; approval[1] = ".............##."
    XCTAssertEqual(MenuBarFace.approval.rows, approval)
  }

  /// The Antenna keeps its antenna under every face, and the approval mitt stands beside it.
  func testTheAntennasFaces() {
    XCTAssertEqual(antennaMark[0], ".......##.......")
    XCTAssertEqual(Array(antennaMark.dropFirst(2)), Array(menuBarMark.dropFirst(2)))
    XCTAssertEqual(MenuBarFace.approval.rows(.antenna)[0], ".......##....##.")
    XCTAssertEqual(MenuBarFace.idle.rows(.antenna)[7], ".##.###..###.##.")
    XCTAssertEqual(MenuBarFace.idle.rows(.antenna)[0], ".......##.......")
  }

  /// The Ring's centre dot shrinks to a bar when idle; the mitt sits clear of the ring.
  func testTheRingsFaces() {
    let idle = MenuBarFace.idle.rows(.ring)
    XCTAssertEqual(idle[6], ".##..........##.")
    XCTAssertEqual(idle[7], ".##...####...##.")
    XCTAssertEqual(idle[9], ".##..........##.")
    let approval = MenuBarFace.approval.rows(.ring)
    XCTAssertEqual(approval[0], ".............##.")
    XCTAssertEqual(approval[1], ".....######..##.")
    XCTAssertNotEqual(MenuBarFace.working.rows(.ring), MenuBarFace.idle.rows(.ring))
  }

  func testTheSectionGlyphsAre14By14() {
    XCTAssertEqual(SettingsGlyph.all.count, 7)
    for g in SettingsGlyph.all {
      for l in g.layers {
        XCTAssertEqual(l.rows.count, SettingsGlyph.side)
        XCTAssertTrue(l.rows.allSatisfy { $0.count == SettingsGlyph.side })
        XCTAssertTrue(l.mask.bits.contains(true))
      }
      XCTAssertEqual(g.layers.first?.color, "#ffffff")
    }
    // The layers never overlap: each cell is one colour.
    for g in SettingsGlyph.all where g.layers.count > 1 {
      let a = g.layers[0].mask.bits, b = g.layers[1].mask.bits
      XCTAssertFalse(zip(a, b).contains { $0 && $1 })
    }
  }

  /// The Dock icon's looks: corners clear, the square's top in its gradient's first colour, the mark's ink in the middle.
  func testTheDockIconsLooks() {
    let size = 128
    for style in AppIconStyle.allCases {
      let px = AppIconArt.rgba(size: size, style: style)
      XCTAssertEqual(px.count, size * size * 4)
      XCTAssertEqual(px[3], 0, "\(style): the corner is clear")
      // A cell of the mark's top edge: the dome's top row, at the middle.
      let ink = AppIconArt.rgb(style.ink)
      let lit = (0..<size).contains { y in
        let i = (y * size + size / 2) * 4
        return px[i + 3] == 255 && Double(px[i]) == ink.0 && Double(px[i + 1]) == ink.1 && Double(px[i + 2]) == ink.2
      }
      XCTAssertTrue(lit, "\(style): the mark is drawn in its ink")
    }
    XCTAssertEqual(AppIconStyle(stored: nil), .orange)
    XCTAssertEqual(AppIconStyle(stored: "mono"), .mono)
  }

  /// The Orange look is the build's own icon: apps/menubar/scripts/gen-icon.ts, run with Bun, gives the same bytes.
  func testOrangeIsTheBuildsIcon() throws {
    let script = Fixtures.dir.appendingPathComponent("../../../apps/menubar/scripts/gen-icon.ts").standardizedFileURL.path
    let env = ProcessInfo.processInfo.environment
    let fm = FileManager.default
    let candidates = [env["BUN_BIN"]].compactMap { $0 } + (env["PATH"] ?? "").split(separator: ":").map { "\($0)/bun" }
      + [fm.homeDirectoryForCurrentUser.appendingPathComponent(".bun/bin/bun").path]
    guard let bun = candidates.first(where: { fm.isExecutableFile(atPath: $0) }) else { throw XCTSkip("no bun") }
    for size in [32, 128] {
      let p = Process()
      p.executableURL = URL(fileURLWithPath: bun)
      p.arguments = ["-e", "const {renderIcon} = await import(\(String(reflecting: script))); process.stdout.write(Buffer.from(renderIcon(\(size))))"]
      let out = Pipe()
      p.standardOutput = out
      try p.run()
      let data = out.fileHandleForReading.readDataToEndOfFile()
      p.waitUntilExit()
      XCTAssertEqual(p.terminationStatus, 0)
      XCTAssertEqual([UInt8](data), AppIconArt.rgba(size: size, style: .orange), "size \(size)")
    }
  }
}
