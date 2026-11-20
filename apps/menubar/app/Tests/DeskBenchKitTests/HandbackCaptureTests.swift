import XCTest
@testable import CapcomdStore
import CapcomdThread
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
import CapcomdUI
import CapcomdBot
import SwiftUI
#endif

/// Typed hand-back cards (ADR-026 §7) as a parent's thread draws them, from handoff items as the daemon serves them: a
/// worker's handback@1 (done, and blocked with a failed check), and a reviewer's review-verdict@1 findings under its
/// seal. With PANE_CAPTURE_DIR=<dir> each is written to <dir>/<name>.png for a look; without it the test only draws them.
final class HandbackCaptureTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  @MainActor final class Host: ThreadHost {
    let team = botTeam([(seed: "agt-c", role: "worker"), (seed: "agt-b", role: "worker"), (seed: "agt-r", role: "reviewer")])
    func bot(runId: String, agentId: String) -> BotTraits? { ["agt-c": team[0], "agt-b": team[1], "agt-r": team[2]][agentId] }
    func agentProvider(runId: String, agentId: String) -> Provider? { .claude }
    func role(runId: String, agentId: String) -> String? { agentId == "agt-r" ? "reviewer" : "worker" }
    func media(_ key: MediaKey) -> Fetched<Data>? { nil }
    func loadMedia(_ key: MediaKey) async {}
    func openAgent(runId: String, agentId: String) {}
  }

  static func handoff(_ child: [String: Any], text: String, blocks: [[String: Any]] = []) throws -> CapcomdThread.Item {
    let o: [String: Any] = ["id": "itm-p-handoff-\(child["agentId"]!)", "rev": 1, "seq": 9, "order": 9, "agentId": "agt-p", "kind": "handoff", "status": "done",
                            "at": "2026-11-20T10:00:00.000Z", "text": text, "blocks": blocks, "format": "blocks/1", "redacted": false, "child": child, "internal": false]
    return try JSONDecoder().decode(CapcomdThread.Item.self, from: JSONSerialization.data(withJSONObject: o))
  }

  static let done: [String: Any] = ["agentId": "agt-c", "status": "done", "handback": [
    "status": "done", "outcome": "added the date parser and wired it into the importer.",
    "changed": [["path": "src/parse/date.ts", "what": "new parser"], ["path": "src/import/rows.ts", "what": "uses it"], ["path": "tests/parse/date.test.ts", "what": NSNull()]],
    "checked": [["check": "bun test tests/parse", "result": "passed", "note": "14 pass"], ["check": "bun run typecheck", "result": "passed", "note": NSNull()],
                ["check": "a real import of last week's file", "result": "not run", "note": "no fixture in the repo"]],
    "risks": ["dates before 1970 read as 1970: the old parser did the same"],
    "decide": ["keep the old parser behind a flag for one release?"],
  ] as [String: Any]]
  static let blocked: [String: Any] = ["agentId": "agt-b", "status": "done", "handback": [
    "status": "blocked", "outcome": "the staging database refuses the migration's user.",
    "changed": [["path": "db/migrations/0042_add_index.sql", "what": "the migration"]],
    "checked": [["check": "bun run migrate --dry-run", "result": "failed", "note": "permission denied for schema public"]],
    "risks": [String](), "decide": ["grant the migration user CREATE on public, or run it as the owner?"],
  ] as [String: Any]]
  static let review: [String: Any] = ["agentId": "agt-r", "status": "done", "verdict": [
    "passed": false, "reasons": ["src/import/rows.ts:88: drops rows whose date is empty", "tests/parse/date.test.ts: no test for a leap day"],
    "findings": [["text": "drops rows whose date is empty instead of keeping them with no date", "severity": "blocker", "file": "src/import/rows.ts", "line": 88],
                 ["text": "no test for a leap day", "severity": "minor", "file": "tests/parse/date.test.ts", "line": NSNull()],
                 ["text": "the parser's name could say it is UTC-only", "severity": "nit", "file": NSNull(), "line": NSNull()]],
  ] as [String: Any]]
  static let reviewBlocks: [[String: Any]] = [
    ["t": "paragraph", "children": [["t": "strong", "children": [["t": "text", "text": "Didn't pass review"]]]]],
    ["t": "list", "ordered": false, "start": NSNull(), "items": (review["verdict"] as! [String: Any])["reasons"].map { ($0 as! [String]).map { ["checked": NSNull(), "blocks": [["t": "paragraph", "children": [["t": "text", "text": $0]]]]] } }!],
  ]

  @MainActor func testDrawsTypedHandbackCards() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let host = ThreadHostBox(host: Host())
    let draws: [(String, CapcomdThread.Item, Bool)] = [
      ("handback-done", try Self.handoff(Self.done, text: "Done: added the date parser and wired it into the importer."), true),
      ("handback-done-clamped", try Self.handoff(Self.done, text: "Done: added the date parser and wired it into the importer."), false),
      ("handback-blocked", try Self.handoff(Self.blocked, text: "Blocked: the staging database refuses the migration's user."), true),
      ("review-verdict-findings", try Self.handoff(Self.review, text: "Didn't pass review", blocks: Self.reviewBlocks), true),
    ]
    XCTAssertEqual(draws[0].1.typedHandback?.checked.count, 3)
    XCTAssertEqual(draws[3].1.child?.verdict?.findings.count, 3)
    var heights: [String: CGFloat] = [:]
    for (name, item, expanded) in draws {
      let view = HandoffCard(runId: "run-g", item: item, expanded: expanded)
        .padding(20).frame(width: 560, alignment: .topLeading).background(Theme.Desk.column)
        .environment(\.threadHost, host).environment(\.colorScheme, .dark)
      let h = NSHostingView(rootView: view)
      let size = h.fittingSize
      let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
      w.appearance = NSAppearance(named: .darkAqua)
      h.frame = CGRect(origin: .zero, size: size)
      w.contentView = h
      for _ in 0..<8 { h.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
      heights[name] = h.fittingSize.height
      let rep = try XCTUnwrap(h.bitmapImageRepForCachingDisplay(in: h.bounds))
      h.cacheDisplay(in: h.bounds, to: rep)
      if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
      w.contentView = nil
    }
    // Open, the whole card shows (its sections); clamped, it stops at the clamp with Show more.
    XCTAssertGreaterThan(heights["handback-done"]!, 200)
    XCTAssertLessThan(heights["handback-done-clamped"]!, heights["handback-done"]!)
    XCTAssertGreaterThan(heights["review-verdict-findings"]!, 80)
  }

  /// The lines a finding is drawn as: its severity, then where, then what (a blocker's word in the failure colour).
  @MainActor func testAFindingsLine() {
    XCTAssertEqual(String(FindingsList.line(Finding(text: "drops rows", severity: .blocker, file: "src/rows.ts", line: 88)).characters), "blocker  src/rows.ts:88  drops rows")
    XCTAssertEqual(String(FindingsList.line(Finding(text: "say UTC")).characters), "say UTC")
  }
  #endif
}
