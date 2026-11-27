import AppKit
import SwiftUI
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// The desk's four layouts (DeskLayout.swift; written in this PR): switched with real clicks on the sidebar button (in
/// the tab bar above or below, in the sidebar's header on either side), ⌃⌘S through the menu bar, and the layout picked
/// as Settings › Interface › Layout and View › Layout pick it (`setLayout`). Every switch must show its chrome (tabs: the
/// reel under or over the bar, no sidebar; sidebar: the sidebar on its side) and keep what was there: the reel's column
/// views (none rebuilt), its place, the selected agent and the panes with their splits.
@MainActor enum DriveLayout {
  enum How { case click, press, choose }

  static func layoutSwitch(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    // A place to keep: the reel moved off its first column, an agent picked, two panes.
    let cols = d.model.columns
    guard cols.count > 4 else { return run.record([Check("fixture", false, "fewer than 5 agents")]) }
    d.model.scroll(to: cols[3], animated: false)
    _ = await d.nextCommit()
    await d.quiet()
    d.model.setLayout(.sidebarLeft)
    _ = await d.run.wait(timeoutMs: 2000) { d.paneView() != nil }
    d.model.selectRow(id: cols[3])
    d.model.split(down: false)
    _ = await d.run.wait(timeoutMs: 2000) { d.panesShown().count == 2 }
    await d.threadsDrawn("setup")
    d.model.setLayout(.tabsAbove)
    _ = await d.run.wait(timeoutMs: 2000) { d.paneView() == nil }
    await d.quiet(timeoutMs: 3000)

    let columns = columnViews(d)
    let reelAt = d.model.reelPosition
    let panes = d.model.panes
    let selected = d.model.focusedAgent
    var paneViews: [ObjectIdentifier]? = nil
    var chromeNotes: [String] = [], keptNotes: [String] = []
    var columnBodies = 0

    // Each: how it is switched, and the layout it lands in.
    let plan: [(How, DeskLayout)] = [
      (.click, .sidebarLeft),     // the tab bar's sidebar button (above)
      (.choose, .sidebarRight),   // Layout: Sidebar right
      (.click, .tabsAbove),       // the sidebar's button, at its header's trailing end
      (.choose, .tabsBelow),      // Layout: Tabs below
      (.press, .sidebarRight),    // ⌃⌘S: back to the sidebar, on the right
      (.press, .tabsBelow),       // ⌃⌘S: back to the tabs, below
      (.click, .sidebarRight),    // the tab bar's sidebar button (below)
      (.choose, .sidebarLeft),
      (.click, .tabsBelow),       // the sidebar's button (left)
      (.choose, .tabsAbove),
    ]
    let rounds = max(1, run.int("rounds", 1))
    var n = 0
    for _ in 0..<rounds {
      for (how, to) in plan {
        let from = d.model.layout
        let name = "switch#\(n) \(from.rawValue)→\(to.rawValue) (\(how))"
        let ink = to.isSidebar ? [d.sidebarRegion, d.paneRegion] : [d.reelRegion]
        let done = { d.model.layout == to && (to.isSidebar ? d.paneView() != nil && sidebarFrame(d) != nil : d.paneView() == nil) }
        let t = run.now
        switch how {
        case .click:
          await run.click(at: toggleButton(d, in: from), ink: ink, name: name, timeoutMs: 3000, until: done)
        case .press:
          await run.press("⌃⌘S", expect: "Toggle Sidebar", ink: ink, name: name, timeoutMs: 3000, until: done)
        case .choose:
          await run.step(name, timeoutMs: 3000, until: done, ink: ink) { d.model.setLayout(to) }
        }
        if to.isSidebar { await d.threadsDrawn(name) }
        columnBodies += d.bodies(in: t...run.now).filter { $0.view == "Column" || $0.view == "ColumnThread" }.count
        n += 1
        if d.model.layout != to { chromeNotes.append("\(name): the layout is \(d.model.layout.rawValue)") }
        if let why = chrome(d, to) { chromeNotes.append("\(name): \(why)") }
        if columnViews(d) != columns { keptNotes.append("\(name): the reel's column views changed") }
        if d.model.panes != panes { keptNotes.append("\(name): the panes changed") }
        if d.model.focusedAgent != selected { keptNotes.append("\(name): the selected agent \(selected ?? "-") → \(d.model.focusedAgent ?? "-")") }
        if to.isSidebar {
          let ids = d.panesShown().map { ObjectIdentifier($0.view) }
          if paneViews == nil { paneViews = ids } else if ids != paneViews { keptNotes.append("\(name): the pane views changed") }
          if d.model.paneAgent != selected { keptNotes.append("\(name): the pane shows \(d.model.paneAgent ?? "-")") }
        } else if d.model.reelPosition != reelAt && d.model.reelPosition != selected {
          keptNotes.append("\(name): the reel's place \(reelAt ?? "-") → \(d.model.reelPosition ?? "-")")
        }
      }
    }
    run.regions([d.reelRegion])
    run.record([
      Check("chrome", chromeNotes.isEmpty, chromeNotes.joined(separator: "; ").ifEmpty("every switch showed its layout's chrome (\(n) switches)")),
      Check("columns-kept", !keptNotes.contains { $0.contains("column views") }, "the reel's \(columns.count) column views kept across \(n) switches; Column/ColumnThread bodies \(columnBodies)"),
      Check("selection-kept", keptNotes.isEmpty, keptNotes.joined(separator: "; ").ifEmpty("the selected agent, the reel's place, the panes and their views kept")),
    ])
  }

  // MARK: reading the window

  /// The reel's column views, in order (none rebuilt: the same objects).
  static func columnViews(_ d: Desk) -> [ObjectIdentifier] {
    guard let r = d.reel(.project) else { return [] }
    return (0..<r.columnCount).compactMap { r.columnView(at: $0).map(ObjectIdentifier.init) }
  }

  /// The sidebar's hosting view while it shows, in window coordinates (bottom-left origin).
  static func sidebarFrame(_ d: Desk) -> CGRect? {
    var r: CGRect?
    d.walk(d.content) { v in
      if v.identifier?.rawValue == DeskLayoutProbe.sidebarID, !v.isHiddenOrHasHiddenAncestor { r = v.convert(v.bounds, to: nil) }
    }
    return r
  }

  /// What the layout must show; nil when it does.
  static func chrome(_ d: Desk, _ l: DeskLayout) -> String? {
    let W = d.content.bounds.width, bar = DeskLayoutProbe.tabBar
    switch l {
    case .tabsAbove, .tabsBelow:
      if let s = sidebarFrame(d) { return "a sidebar shows with the tabs at x \(Int(s.minX))" }
      guard let sv = d.reelScrollView() else { return "no reel" }
      let r = sv.convert(sv.bounds, to: nil), H = d.content.bounds.height
      if abs(r.minX) > 0.5 || abs(r.width - W) > 0.5 { return "the reel spans x \(Int(r.minX))…\(Int(r.maxX)), not the window (a rail?)" }
      let bottom = l == .tabsBelow ? bar : 0
      if abs(r.minY - bottom) > 0.5 || H - r.maxY < bar - 0.5 { return "the reel is at y \(Int(r.minY))…\(Int(r.maxY)) in \(Int(H))" }
      return nil
    case .sidebarLeft, .sidebarRight:
      guard let s = sidebarFrame(d) else { return "no sidebar" }
      let off = l == .sidebarLeft ? s.minX : W - s.maxX
      return abs(off) > 0.5 ? "the sidebar at x \(Int(s.minX))…\(Int(s.maxX))" : nil
    }
  }

  /// The sidebar button's centre, in window coordinates: in the tab bar (above at x 84, below at x 10) or in the
  /// sidebar's header (left: x 84 from the window's left; right: at the header's trailing end).
  static func toggleButton(_ d: Desk, in l: DeskLayout) -> CGPoint {
    let W = d.content.bounds.width, H = d.content.bounds.height, bar = DeskLayoutProbe.tabBar
    switch l {
    case .tabsAbove: return CGPoint(x: 84 + 15, y: H - bar / 2)
    case .tabsBelow: return CGPoint(x: 10 + 15, y: bar / 2)
    case .sidebarLeft: return CGPoint(x: 84 + 14, y: H - 26)
    case .sidebarRight: return CGPoint(x: W - 8 - 2 - 14, y: H - 26)
    }
  }
}
