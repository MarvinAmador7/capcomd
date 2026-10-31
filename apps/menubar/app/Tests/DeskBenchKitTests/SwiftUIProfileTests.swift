import XCTest
import DeskBenchKit

/// PerfLoop Phase 3, the confirmation side of C7: the SwiftUI template's cause and effect tables, summarised. The
/// `*-empty.xml` fixtures are real exports (schemas only: the recording had no rows, so no paths or environment).
final class SwiftUIProfileTests: XCTestCase {
  static let fixtures = URL(fileURLWithPath: #filePath).deletingLastPathComponent().appendingPathComponent("Fixtures")

  func table(_ name: String) throws -> XCTable { try XCTable(xml: Data(contentsOf: Self.fixtures.appendingPathComponent(name))) }

  /// Real exports from a recording of `step` (Instruments 27.1, macOS 27.0.1): the tables exist, their rows don't.
  func testTheTemplateRecordedNoRowsHere() throws {
    var ts: [String: XCTable] = [:]
    for n in SwiftUIProfile.tableNames { ts[n] = try table("\(n)-empty.xml") }
    XCTAssertEqual(ts["swiftui-updates"]?.columns.contains("root-causes"), true)
    XCTAssertEqual(ts["swiftui-causes"]?.columns, ["timestamp", "source-node-event-id", "source-node", "destination-node-event-id", "destination-node",
                                                  "label", "value-type", "changed-properties", "layout-info", "process"])
    let p = SwiftUIProfile(tables: ts, process: "CapcomdDeskBench")
    XCTAssertTrue(p.empty); XCTAssertEqual(p.rows["swiftui-updates"], 0); XCTAssertEqual(p.rootCauses, [])
    XCTAssertTrue(p.lines.joined(separator: "\n").contains("recorded no SwiftUI rows"))
  }

  /// Rows hand-made on the real `swiftui-updates` / `swiftui-causes` schemas (the cell shapes are a guess: no row has
  /// been seen). Root causes are counted by view; another process's rows are left out.
  func testRootCausesByView() throws {
    let updates = try table("swiftui-updates-empty.xml"), causes = try table("swiftui-causes-empty.xml")
    func row(_ view: String, _ ms: Double, _ cause: String?, pid: Int = 7725) -> String {
      let c = cause.map { #"<description-set fmt="\#($0)">\#($0)</description-set>"# } ?? "<sentinel/>"
      return "<row><start-time fmt=\"00:01\">1</start-time><duration fmt=\"\(ms) ms\">\(Int(ms * 1e6))</duration><uint32 fmt=\"1\">1</uint32>"
        + "<swiftui-update fmt=\"View Body Updates\">View Body Updates</swiftui-update><sentinel/><string fmt=\"\(view)\">\(view)</string><sentinel/><sentinel/>"
        + "<string fmt=\"CapcomdDesk\">CapcomdDesk</string><string fmt=\"\(view)\">\(view)</string>"
        + "<process fmt=\"\(pid == 7725 ? "CapcomdDeskBench" : "Finder") (\(pid))\"><pid fmt=\"\(pid)\">\(pid)</pid></process><sentinel/>"
        + c + "<event-concept fmt=\"Moderate\">Moderate</event-concept><sentinel/><sentinel/><sentinel/><sentinel/></row>"
    }
    func filled(_ t: XCTable, _ rows: [String]) throws -> XCTable {
      let schema = "<schema name=\"\(t.schema)\">" + t.columns.map { "<col><mnemonic>\($0)</mnemonic></col>" }.joined() + "</schema>"
      return try XCTable(xml: Data("<?xml version=\"1.0\"?><trace-query-result><node>\(schema)\(rows.joined())</node></trace-query-result>".utf8))
    }
    let u = try filled(updates, (0..<17).map { _ in row("Column", 0.4, "AgentSlice.focused") } + [row("CrewTab", 2.5, "AgentSlice.onScreen"), row("Reel", 0.1, nil),
                                                                                                  row("Column", 9, "Finder.thing", pid: 1)])
    let c = try filled(causes, ["<row><event-time fmt=\"1\">1</event-time><sentinel/><sentinel/><sentinel/><sentinel/><string fmt=\"@Observable\">@Observable</string>"
                                + "<sentinel/><string fmt=\"focused\">focused</string><sentinel/><process fmt=\"CapcomdDeskBench (7725)\">7725</process></row>"])
    let p = SwiftUIProfile(tables: ["swiftui-updates": u, "swiftui-causes": c], process: "CapcomdDeskBench")
    XCTAssertFalse(p.empty)
    XCTAssertEqual(p.rows["swiftui-updates"], 19)
    XCTAssertEqual(p.rootCauses.first, SwiftUIProfile.RootCause(cause: "AgentSlice.focused", updates: 17, views: ["Column": 17], ms: 6.8))
    XCTAssertEqual(p.rootCauses.map(\.cause), ["AgentSlice.focused", "AgentSlice.onScreen", "(none)"])
    XCTAssertEqual(p.longUpdates.map(\.view), ["CrewTab"])
    XCTAssertEqual(p.edges, ["@Observable: focused": 1])
  }

  func testOlderProfilesSwiftUIListStillDecodes() throws {
    let old = #"{"table":"swiftui-updates","rows":3,"byView":{"Column":3}}"#
    let p = try JSONOut.decode(SwiftUIProfile.self, from: Data("[\(old)]".utf8))
    XCTAssertEqual(p.tables.first?.byView, ["Column": 3]); XCTAssertEqual(p.rows["swiftui-updates"], 3); XCTAssertEqual(p.rootCauses, [])
    let back = try JSONOut.decode(SwiftUIProfile.self, from: Data(JSONOut.encode(p).utf8))
    XCTAssertEqual(back, p)
  }
}
