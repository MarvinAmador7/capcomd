import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
#endif

/// The opened pane of an agent the daemon is still getting ready, drawn as the app draws it, from the frames the daemon
/// sends (snapshot.agents, then live agent.activity_changed of kind setup). With PANE_CAPTURE_DIR=<dir> each state is
/// written to <dir>/<name>.png for a look; without it the test only draws them (no file).
final class PaneCaptureTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  static let MB = 1_048_576
  let scope = "lifecycle:run-g"

  @MainActor func store(activity: String) -> CapcomdStore {
    let s = CapcomdStore()
    let created = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-42))
    let agent = #"{"id":"agt-p","runId":"run-g","parent":null,"depth":0,"profile":"planner","status":"running","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"\#(created)","provider":"claude","activity":\#(activity)}"#
    for (e, d) in [("snapshot.run", #"{"run":{"id":"run-g","projectId":"prj-g","label":null,"state":"running","goal":"Make the getting-ready pane","sandbox":"boxd"}}"#),
                   ("snapshot.agents", #"{"agents":[\#(agent)]}"#), ("snapshot.approvals", #"{"approvals":[]}"#), ("snapshot.end", #"{"snapshotSeq":3}"#)] {
      s.receive(StreamFrame.parse(event: e, data: d), scope: scope)
    }
    return s
  }
  static func setup(_ phase: String, _ text: String, bytes: Int? = nil, total: Int? = nil) -> String {
    #"{"text":"\#(text)","kind":"setup","at":"2026-11-19T14:44:00.000Z","setup":{"phase":"\#(phase)","bytes":\#(bytes.map(String.init) ?? "null"),"totalBytes":\#(total.map(String.init) ?? "null")}}"#
  }
  static let states: [(String, String)] = [
    ("1-no-activity", "null"),
    ("2-machine", setup("machine", "Starting the machine")),
    ("3-copy", setup("copy", "Copying the repository · 53% (56 of 105 MB)", bytes: 56 * MB, total: 105 * MB + 400_000)),
    ("4-workspace", setup("workspace", "Preparing the workspace")),
    ("5-agent", setup("agent", "Starting the agent")),
    ("6-thinking", #"{"text":"Thinking","kind":"think","at":"2026-11-19T14:45:19.000Z"}"#),
  ]

  /// The agent's slice follows the daemon's setup live (one change at most a second), and its first step ends it.
  @MainActor func testTheSliceFollowsTheSetupLiveUntilTheFirstStep() throws {
    let s = store(activity: Self.setup("machine", "Starting the machine"))
    let m = DeskModel(store: s)
    let a = try XCTUnwrap(m.agent("agt-p"))
    XCTAssertEqual(a.preparing?.line, "Starting the machine")
    var n = 0
    func live(_ activity: String) {
      n += 1
      s.receive(StreamFrame.parse(event: "agent.activity_changed", data: #"{"v":1,"id":"eph-\#(n)","scope":"run-g","seq":3,"entity":"agt-p","entitySeq":0,"type":"agent.activity_changed","typeVersion":1,"durability":"ephemeral","ts":"2026-11-19T14:44:00.000Z","epochMs":9,"projectId":"prj-g","runId":"run-g","agentId":"agt-p","text":"x","data":{"agentId":"agt-p","status":"running","activity":\#(activity)}}"#), scope: scope)
    }
    live(Self.setup("copy", "Copying the repository · 10% (10 of 100 MB)", bytes: 10 * Self.MB, total: 100 * Self.MB))
    XCTAssertEqual(a.preparing?.detail, "10% · 10 of 100 MB")
    XCTAssertEqual(a.preparing?.fraction, 0.1)
    live(Self.setup("agent", "Starting the agent"))
    XCTAssertEqual(a.preparing?.line, "Starting planner")
    live(#"{"text":"Thinking","kind":"think","at":"2026-11-19T14:45:19.000Z"}"#)
    XCTAssertNil(a.preparing)
  }

  @MainActor func testDrawsThePaneInEachState() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    // The opened pane in each state, and a reel column (the same body) copying.
    let draws = Self.states.map { ($0.0, $0.1, ColumnStyle.pane) } + [("reel-3-copy", Self.states[2].1, ColumnStyle.reel)]
    for (name, activity, style) in draws {
      let m = DeskModel(store: store(activity: activity))
      XCTAssertEqual(m.columns, ["agt-p"])
      let size = style == .pane ? CGSize(width: 760, height: 520) : CGSize(width: 380, height: 520)
      let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
      w.appearance = NSAppearance(named: .darkAqua)
      let pane = style == .pane ? NativeColumnView(agentId: "agt-p", model: m, style: .pane, pane: PaneState(id: 0)) : NativeColumnView(agentId: "agt-p", model: m)
      pane.frame = CGRect(origin: .zero, size: size)
      w.contentView = pane
      for _ in 0..<6 { pane.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
      let rep = try XCTUnwrap(pane.bitmapImageRepForCachingDisplay(in: pane.bounds))
      pane.cacheDisplay(in: pane.bounds, to: rep)
      if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
      w.contentView = nil
    }
  }
  #endif
}
