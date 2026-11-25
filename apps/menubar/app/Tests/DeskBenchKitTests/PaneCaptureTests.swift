import XCTest
@testable import CapcomdStore
#if canImport(SwiftUI) && os(macOS)
import AppKit
@testable import CapcomdDesk
import CapcomdUI
import CapcomdBot
import SwiftUI
#endif

/// The opened pane of an agent the daemon is still getting ready, drawn as the app draws it, from the frames the daemon
/// sends (snapshot.agents, then live agent.activity_changed of kind setup). With PANE_CAPTURE_DIR=<dir> each state is
/// written to <dir>/<name>.png for a look; without it the test only draws them (no file).
final class PaneCaptureTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  static let MB = 1_048_576
  let scope = "lifecycle:run-g"

  @MainActor func store(activity: String, model: String? = nil) -> CapcomdStore {
    let s = CapcomdStore()
    let created = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-42))
    let agent = #"{"id":"agt-p","runId":"run-g","parent":null,"depth":0,"profile":"planner","status":"running","text":"x","task":null,"taskAttachment":null,"result":null,"updatedAt":null,"createdAt":"\#(created)","provider":"claude"\#(model.map { #","model":"\#($0)""# } ?? ""),"activity":\#(activity)}"#
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
    XCTAssertEqual(a.setupLine?.phase, "Starting the machine")
    var n = 0
    func live(_ activity: String) {
      n += 1
      s.receive(StreamFrame.parse(event: "agent.activity_changed", data: #"{"v":1,"id":"eph-\#(n)","scope":"run-g","seq":3,"entity":"agt-p","entitySeq":0,"type":"agent.activity_changed","typeVersion":1,"durability":"ephemeral","ts":"2026-11-19T14:44:00.000Z","epochMs":9,"projectId":"prj-g","runId":"run-g","agentId":"agt-p","text":"x","data":{"agentId":"agt-p","status":"running","activity":\#(activity)}}"#), scope: scope)
    }
    live(Self.setup("copy", "Copying the repository · 10% (10 of 100 MB)", bytes: 10 * Self.MB, total: 100 * Self.MB))
    XCTAssertEqual(a.setupLine?.detail, "10% · 10 of 100 MB")
    XCTAssertEqual(a.setupLine?.fraction, 0.1)
    live(Self.setup("agent", "Starting the agent"))
    XCTAssertEqual(a.setupLine?.phase, "Starting planner")
    XCTAssertNil(a.setupLine?.phaseShown)                                       // "Starting planner" is said once
    live(#"{"text":"Thinking","kind":"think","at":"2026-11-19T14:45:19.000Z"}"#)
    XCTAssertNil(a.setupLine)
  }

  @MainActor func testDrawsThePaneInEachState() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    // The opened pane in each state, and a reel column (the same body) copying.
    let draws = Self.states.map { ($0.0, $0.1, ColumnStyle.pane) } + [("reel-3-copy", Self.states[2].1, ColumnStyle.reel)]
    for (name, activity, style) in draws {
      let m = DeskModel(store: store(activity: activity))
      XCTAssertEqual(m.columns, ["agt-p"])
      try Self.draw(m, style: style, name: name, into: dir)
    }
  }

  /// Draws the agent's column (a pane, or a reel column) offscreen; with `dir`, writes it to <dir>/<name>.png.
  @MainActor static func draw(_ m: DeskModel, style: ColumnStyle, name: String, into dir: URL?, size: CGSize? = nil, settle: Int = 6) throws {
    let size = size ?? (style == .pane ? CGSize(width: 760, height: 520) : CGSize(width: 380, height: 520))
    let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
    w.appearance = NSAppearance(named: .darkAqua)
    let pane = style == .pane ? NativeColumnView(agentId: "agt-p", model: m, style: .pane, pane: PaneState(id: 0)) : NativeColumnView(agentId: "agt-p", model: m)
    pane.frame = CGRect(origin: .zero, size: size)
    w.contentView = pane
    for _ in 0..<settle { pane.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
    let rep = try XCTUnwrap(pane.bitmapImageRepForCachingDisplay(in: pane.bounds))
    pane.cacheDisplay(in: pane.bounds, to: rep)
    if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
    w.contentView = nil
  }

  /// The pane composer: idle (its turn ended, waiting between turns), working (the send circle is Stop), and the model
  /// menu open (a daemon that lists the harness's models and takes one with a message).
  @MainActor func testDrawsTheComposer() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    func ready(_ s: CapcomdStore) {
      s.capabilities = [Capability.agentPause, Capability.runsOptions, Capability.runsOptionsModels, Capability.agentsMessagesModel, Capability.steerSkills]
      s.runOptions = RunOptions(drivers: [DriverInfo(provider: "claude", label: "Claude Code", efforts: ["low", "medium", "high", "max"], models: [
        ModelInfo(id: "claude-opus-4-5", name: "Opus 4.5", note: "Most capable"), ModelInfo(id: "claude-sonnet-4-5", name: "Sonnet 4.5", note: "Fast"),
        ModelInfo(id: "claude-haiku-4-5", name: "Haiku 4.5", note: "Fastest"),
      ])])
      s.skills = .loaded([SkillInfo(name: "validate-shards", description: "Null checks", source: "user")])
      s.changed()
    }
    let think = #"{"text":"Thinking","kind":"think","at":"2026-11-19T14:45:19.000Z"}"#
    // Working.
    let ws = store(activity: think, model: "claude-opus-4-5"); ready(ws)
    let wm = DeskModel(store: ws)
    let working = try XCTUnwrap(wm.agent("agt-p")?.composer)
    XCTAssertTrue(working.isWorking && working.canStop)
    XCTAssertEqual(working.model?.chip, "Opus 4.5")
    XCTAssertTrue(working.model?.editable == true)
    try Self.draw(wm, style: .pane, name: "composer-working", into: dir)
    // The model menu open, a pick for its next turn made.
    ws.setNextTurn(agentId: "agt-p", effort: .some("high"))
    wm.toggleAgentModelMenu("agt-p")
    XCTAssertTrue(wm.agent("agt-p")?.modelMenuOpen == true)
    try Self.draw(wm, style: .pane, name: "composer-menu-open", into: dir, settle: 10)
    // Idle: its turn ended with a wake armed (it waits for verify): not working, so no Stop.
    let iss = store(activity: think, model: "claude-opus-4-5"); ready(iss)
    iss.receive(StreamFrame.parse(event: "agent.wake_armed", data: #"{"v":1,"id":"wk-1","scope":"run-g","seq":4,"entity":"agt-p","entitySeq":0,"type":"agent.wake_armed","typeVersion":1,"durability":"durable","ts":"2026-11-19T14:44:00.000Z","epochMs":\#(Int(Date().timeIntervalSince1970 * 1000) - 252_000),"projectId":"prj-g","runId":"run-g","agentId":"agt-p","text":"x","data":{"wakeId":"wk-1","kind":"op","op":"vfy-3f9a","opKind":"verify"}}"#), scope: scope)
    let im = DeskModel(store: iss)
    let idle = try XCTUnwrap(im.agent("agt-p")?.composer)
    XCTAssertFalse(idle.isWorking)
    XCTAssertNotNil(im.agent("agt-p")?.header.waitLine)
    try Self.draw(im, style: .pane, name: "composer-idle-waiting", into: dir)
  }

  /// The waking line (DurableWaking-v3) as the agent lifecycle's trail would fill it: folded, open, a reel column's
  /// ring, the record once it's done, and the waiting card. Drawn on the pane's ground at the reading width.
  @MainActor func testDrawsTheWakingLine() throws {
    let dir = ProcessInfo.processInfo.environment["PANE_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let now = Int(Date().timeIntervalSince1970 * 1000)
    let steps: [SetupLineModel.Step] = [
      .init(line: "Starting a machine", state: .done, ms: 2_100), .init(line: "Copying the repository", state: .now, atMs: now - 6_800),
      .init(line: "Restoring the conversation", state: .next), .init(line: "Starting planner", state: .next),
    ]
    let line = SetupLineModel(name: "planner", waking: true, phase: "Copying the repository", detail: "53% · 56 of 105 MB", fraction: 0.53,
                              sinceMs: now - 9_000, steps: steps)
    let bot = botTeam([(seed: "agt-p", role: Optional("planner"))]).first
    let record = SetupRecord(elapsedMs: 75_000, steps: [
      .init(line: "Starting a machine", state: .done, ms: 2_100), .init(line: "Copying the repository", state: .done, ms: 57_000),
      .init(line: "Restoring the conversation", state: .done, ms: 7_900), .init(line: "Starting planner", state: .done, ms: 8_000),
    ])
    let draws: [(String, CGFloat, AnyView)] = [
      ("waking-folded", 560, AnyView(SetupLine(model: line, bot: bot))),
      ("waking-open", 560, AnyView(SetupLine(model: line, bot: bot, open: true))),
      ("waking-column", 300, AnyView(SetupLine(model: line, bot: bot, compact: true))),
      ("waking-column-open", 300, AnyView(SetupLine(model: line, bot: bot, compact: true, open: true))),
      ("setup-record", 560, AnyView(SetupRecordRow(record: record, open: true))),
      ("waiting", 560, AnyView(WaitingRow(line: "waiting for verify vfy-3f9a", sinceMs: now - 252_000))),
    ]
    for (name, width, view) in draws {
      let host = NSHostingView(rootView: view.padding(20).frame(width: width, alignment: .topLeading).background(Theme.Desk.column)
        .environment(\.colorScheme, .dark))
      let size = host.fittingSize
      let w = NSWindow(contentRect: CGRect(origin: CGPoint(x: -20_000, y: -20_000), size: size), styleMask: [.borderless], backing: .buffered, defer: false)
      w.appearance = NSAppearance(named: .darkAqua)
      host.frame = CGRect(origin: .zero, size: size)
      w.contentView = host
      for _ in 0..<6 { host.layoutSubtreeIfNeeded(); RunLoop.main.run(until: Date().addingTimeInterval(0.05)) }
      XCTAssertGreaterThan(size.height, 30, name)
      let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
      host.cacheDisplay(in: host.bounds, to: rep)
      if let dir { try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(name).png")) }
      w.contentView = nil
    }
  }
  #endif
}
