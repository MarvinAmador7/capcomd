import AppKit
import SwiftUI
import CapcomdStore
import CapcomdDesk
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit

/// Team (design/desktop/team; SPEC §2.2) on the `team` fixture, whose store has the profile routes: the Team button in
/// the sidebar's foot clicked open and closed, roster rows clicked, and a profile's settings row opened in place and a
/// value written. The sidebar's list and the profile's pane are ink regions: a blank roster or pane fails.
@MainActor enum DriveTeam {
  /// Views of the reel and the agents' panes, kept under Team: switching profiles must not render them.
  static let agentViews: Set<String> = ["Column", "ColumnHead", "ColumnThread", "EntryRow", "PaneEntryRow", "PaneHead", "PaneThread", "AgentRow", "SidebarList", "CrewTab"]

  /// The sidebar's foot (40 pt, under the list; 8 pt sides, 6 pt under it): Team sits left of History and Settings
  /// (28 pt buttons, 2 pt apart, 2 pt in from the right). AppKit's window coordinates: from the bottom.
  static func teamButton(_ d: Desk) -> CGPoint { CGPoint(x: 248 - 8 - 2 - 28 * 2 - 2 * 2 - 14, y: 6 + 20) }

  /// The pane's place beside the sidebar (top-left coordinates, as ink regions take them).
  static func paneRegion(_ d: Desk) -> InkRegion {
    .rect("team-pane", CGRect(x: 248, y: 0, width: max(0, d.content.bounds.width - 248), height: d.content.bounds.height))
  }

  /// The daemon's capabilities read (the Team button works from then on), the sidebar open on the agents.
  static func prepare(_ d: Desk) async throws {
    await d.store.refreshDaemonInfo()
    guard await d.run.wait(timeoutMs: 2000, { d.model.team.available }) else { throw DeskError("the team fixture's daemon didn't say it lists profiles") }
    await DriveSidebar.openSidebar(d)
  }

  /// Team open (as its button does), its roster read and the first profile's rows in.
  static func openTeam(_ d: Desk) async {
    if !d.model.team.isOpen { d.model.openTeam() }
    _ = await d.run.wait(timeoutMs: 3000) { !d.model.team.roster.isEmpty && d.model.team.selectedKey != nil }
    if let k = d.model.team.selectedKey { _ = await d.run.wait(timeoutMs: 3000) { d.model.team.slice(k).detail != nil } }
    await d.quiet(timeoutMs: 3000)
  }

  /// A roster row's centre, from the fixed heights: the list starts under the 52 pt header; a label is 24 pt with 2 pt
  /// above the first and 14 pt above the others; a row is 28 pt.
  static func rowPoint(_ d: Desk, _ key: String) -> CGPoint? {
    var y: CGFloat = 52
    for (i, g) in d.model.team.roster.enumerated() {
      y += (i == 0 ? 2 : 14) + 24
      for m in g.members {
        if m.id == key { return CGPoint(x: 120, y: d.content.bounds.height - (y + 14)) }
        y += 28
      }
    }
    return nil
  }

  // MARK: team-open

  /// Clicks the Team button (a mouse-down and -up on the app's queue at the button) to open Team, then again to leave
  /// it, `opens` times. Latency: the click to the frame with the roster and the profile's pane header.
  static func teamOpen(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    try await prepare(d)
    var opened = true, closed = true, notes: [String] = []
    let opens = run.int("opens", 4)
    for i in 0..<opens {
      let t = run.now
      await run.click(at: teamButton(d), ink: [d.sidebarRegion, paneRegion(d)], name: "open#\(i)", until: {
        d.model.team.isOpen && !d.model.team.roster.isEmpty && d.bodies.contains { $0.view == "TeamPaneHead" && $0.t >= t }
      })
      let ok = d.model.team.isOpen && d.model.team.selectedKey != nil
      if !ok { notes.append("open#\(i): team \(d.model.team.isOpen), selected \(d.model.team.selectedKey ?? "-")") }
      opened = opened && ok
      if i == opens - 1 { break }   // ends open, for the snapshot
      await run.click(at: teamButton(d), ink: [d.sidebarRegion], name: "close#\(i)", until: { !d.model.team.isOpen && d.paneView() != nil })
      let back = !d.model.team.isOpen && d.paneView() != nil
      if !back { notes.append("close#\(i): team \(d.model.team.isOpen), agent pane \(d.paneView()?.agent ?? "none")") }
      closed = closed && back
    }
    await d.quiet(timeoutMs: 3000)
    let labels = d.model.team.roster.map(\.title)
    let words = d.model.team.roster.first?.members.map(\.role.rawValue) ?? []
    let rosterOK = labels == ["capcomd", "capcomd-site", "All projects"] && words == ["plans", "leads", "builds", "reviews"]
      && d.model.team.roster.last?.members.map(\.title) == ["Security critic", "tern"]
    run.regions([d.sidebarRegion, paneRegion(d)])
    run.record([
      Check("opened", opened, notes.filter { $0.hasPrefix("open") }.joined(separator: "; ").ifEmpty("every click opened Team on a profile (\(opens) opens)")),
      Check("roster", rosterOK, "labels \(labels), first project's role words \(words)"),
      Check("closed", closed, notes.filter { $0.hasPrefix("close") }.joined(separator: "; ").ifEmpty("every second click gave the agents back")),
    ])
  }

  // MARK: team-switch

  /// With Team open, clicks roster rows spread over the projects and All projects. Each pick must show that profile in
  /// the pane, and nothing of the agents (the reel, their panes, their list) may render.
  static func teamSwitch(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    try await prepare(d)
    await openTeam(d)
    let members = d.model.team.members
    let clicks = run.int("clicks", 6)
    var switched = true, notes: [String] = []
    let start = run.now
    for i in 0..<clicks {
      // Every other row from the second, wrapping: each click is another profile than the one shown.
      let m = members[(1 + i * 2) % members.count]
      guard m.id != d.model.team.selectedKey, let p = rowPoint(d, m.id) else { continue }
      let t = run.now
      await run.click(at: p, ink: [paneRegion(d)], name: "click#\(i) \(m.name)", until: {
        d.model.team.selectedKey == m.id && d.bodies.contains { $0.view == "TeamPaneHead" && $0.id == m.id && $0.t >= t }
      })
      let ok = d.model.team.selectedKey == m.id && d.model.team.slice(m.id).title == m.title
      if !ok { notes.append("click on \(m.name) at y \(Int(p.y)): shows \(d.model.team.selectedKey ?? "-")") }
      switched = switched && ok
    }
    let leaked = d.bodies(in: start...run.now).filter { agentViews.contains($0.view) }
    await d.quiet(timeoutMs: 3000)
    run.regions([d.sidebarRegion, paneRegion(d)])
    run.record([
      Check("switched", switched, notes.joined(separator: "; ").ifEmpty("every clicked row showed its profile in the pane")),
      Check("isolation", leaked.isEmpty, leaked.isEmpty ? "no agent view rendered" : "agent views rendered: \(Desk.summary(leaked))"),
    ])
  }

  // MARK: team-settings

  /// With Team open on an installed profile (Security critic, All projects): the settings row's summary, then its rows
  /// opened and closed in place `toggles` times (as its click does, without the 0.2 s ease), then its turns stepped up
  /// once, which is written to the profile's file.
  static func teamSettings(_ run: HostRun) async throws {
    let d = try Desk(run)
    try await d.show()
    await d.rewind()
    try await prepare(d)
    await openTeam(d)
    guard let key = d.model.team.members.first(where: { $0.name == "security-critic" })?.id else { throw DeskError("no security-critic in the team fixture") }
    d.model.showProfile(key)
    let s = d.model.team.slice(key)
    _ = await run.wait(timeoutMs: 3000) { s.detail != nil && s.work != nil && s.persona != nil }
    await d.quiet(timeoutMs: 3000)
    let names = Dictionary(d.store.runOptions.drivers.flatMap { $0.models ?? [] }.map { ($0.id, $0.name) }, uniquingKeysWith: { a, _ in a })
    let summary = s.row.map { TeamSummary.line($0, detail: s.detail, models: names) } ?? "-"
    let want = "Opus 5.5 · high · Cloud · read-only · alone · 40 turns · 30 min · 2 skills"
    var toggled = true
    for i in 0..<run.int("toggles", 6) {
      let opening = i % 2 == 0
      let t = run.now
      await run.step("toggle#\(i) \(opening ? "open" : "close")", until: {
        s.settingsOpen == opening && d.bodies.contains { $0.view == "TeamSheet" && $0.id == key && $0.t >= t }
          && (!opening || d.bodies.contains { $0.view == "TeamFieldRows" && $0.id == key && $0.t >= t })
      }, ink: [paneRegion(d)]) {
        s.settingsOpen = opening
      }
      toggled = toggled && s.settingsOpen == opening
    }
    // Opened again, then Turns + (40 → 45), written through PUT.
    if !s.settingsOpen { s.settingsOpen = true; await d.quiet(timeoutMs: 2000) }
    let rows = s.detail.map { TeamFields.rows($0).count } ?? 0
    let turns = s.detail?.field("limits.maxTurns")
    let next = turns.flatMap { TeamFields.stepped($0, by: 1) }
    await run.step("turns +", until: { s.detail?.field("limits.maxTurns")?.value == next }, ink: [paneRegion(d)]) {
      if let next { d.model.setProfile(key, ["limits.maxTurns": next]) }
    }
    let put = d.teamDaemon?.puts.last
    let written = next == "45" && put?.name == "security-critic" && put?.values["limits.maxTurns"] == .some("45")
      && s.detail?.field("limits.maxTurns")?.display == "45 turns" && s.pending.isEmpty
    await d.quiet(timeoutMs: 2000)
    run.regions([d.sidebarRegion, paneRegion(d)])
    run.record([
      Check("summary", summary == want, "\"\(summary)\""),
      Check("rows", toggled && rows == 13, "rows \(rows) (13 expected), every toggle \(toggled ? "took" : "did not take")"),
      Check("written", written, "PUT \(put.map { "\($0.name) \($0.values)" } ?? "none"); turns now \(s.detail?.field("limits.maxTurns")?.display ?? "-")"),
    ])
  }
}
