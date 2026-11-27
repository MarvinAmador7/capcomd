import AppKit
import SwiftUI
import CapcomdStore
import CapcomdDesk
import CapcomdSettings
import DeskBenchKit
import PerfLoopHost
import PerfLoopKit
import PerfLoopProbe

/// The Settings window (design/desktop/settings) on the Settings fixture's daemon (DeskBenchKit/SettingsFixture.swift):
/// the window opened as ⌘, does, then real clicks on the sidebar's pages, a place's row on Runs (its page pushed) and
/// Back. The sidebar and the pane are ink regions: a blank sidebar or page fails.
@MainActor final class SettingsBench: DeskProbeSink {
  let run: HostRun
  let store: CapcomdStore
  let model: SettingsModel
  var bodies: [(t: Double, view: String, id: String?)] = []

  init(_ run: HostRun) {
    self.run = run
    store = CapcomdStore(daemonInfo: SettingsFixtureDaemon(), clientId: "deskbench")
    model = SettingsModel(store: store, session: nil, host: .quiet)
    DeskProbe.sink = self
    run.atClose { DeskProbe.sink = nil }
  }

  func body(_ view: StaticString) { bodies.append((run.now, view.description, nil)); Probe.body(view) }
  func body(_ view: StaticString, id: String) { bodies.append((run.now, view.description, id)); Probe.body(view, id: id) }
  func event(_ name: StaticString, _ value: Int) { Probe.event(name, value) }

  static let size = CGSize(width: 880, height: 660)
  func hosting() -> NSView {
    let h = NSHostingView(rootView: SettingsWindowView(model: model))
    h.sizingOptions = []
    return h
  }

  /// The page shown since `t` (its `SettingsPage` body, by the route's key: "general", "place:boxd").
  func shown(_ key: String, since t: Double) -> Bool { bodies.contains { $0.view == "SettingsPage" && $0.id == key && $0.t >= t } }
  static func key(_ r: SettingsRoute) -> String {
    switch r { case .page(let p): p.rawValue; case .place(let n): "place:\(n)" }
  }

  var height: CGFloat { run.window?.contentView?.bounds.height ?? Self.size.height }
  /// The sidebar below the traffic lights, and the pane (top-left coordinates, as ink regions take them).
  var sidebarRegion: InkRegion { .rect("settings-sidebar", CGRect(x: 0, y: 52, width: 248, height: height - 52)) }
  var paneRegion: InkRegion { .rect("settings-pane", CGRect(x: 248, y: 8, width: 880 - 248 - 8, height: height - 16)) }

  /// A page's row in the sidebar, from the fixed heights (SettingsChrome's ST): the 52 pt header, the 28 pt search and
  /// 10 under it, the 44 pt status row, 10, then 28 pt rows with 10 between groups. AppKit's window coordinates.
  func rowPoint(_ page: SettingsPage) -> CGPoint {
    var y: CGFloat = 52 + 28 + 10
    if page == .status { return CGPoint(x: 120, y: height - (y + 22)) }
    y += 44
    for group in SettingsPage.groups {
      y += 10
      for p in group {
        if p == page { return CGPoint(x: 120, y: height - (y + 14)) }
        y += 28
      }
    }
    return CGPoint(x: 120, y: height - y)
  }
  /// Back, in the toolbar's capsule (8 pt into the pane, 12 in, the toolbar 44 tall).
  var backPoint: CGPoint { CGPoint(x: 248 + 12 + 15, y: height - (8 + 22)) }

  /// The window opened and the daemon read (as the window's first refresh does).
  func opened() async {
    _ = await run.wait(timeoutMs: 3000) { [unowned self] in store.daemonVersion != nil && !store.runOptions.sandboxes.isEmpty }
    await model.refreshSettings()
    await run.settle(quietMs: 200, timeoutMs: 3000)
  }
}

@MainActor enum DriveSettings {
  // MARK: settings-open

  /// Opens the Settings window on General (⌘,) and waits for the first frame with the sidebar and the page. Checks the
  /// sidebar's status row says capcomd runs and its version, and that every page has its row.
  static func settingsOpen(_ run: HostRun) async throws {
    let s = SettingsBench(run)
    if let scene = try? await run.appWindow(timeoutMs: 3000, where: { DeskBenchApp.isScene($0) }) { scene.orderOut(nil) }
    try await run.open("open#\(run.rep)", size: SettingsBench.size, title: "Settings",
                       until: { s.shown("general", since: 0) }, ink: [s.sidebarRegion, s.paneRegion], view: { s.hosting() })
    await s.opened()
    let connected = s.model.connection == .connected(version: SettingsFixtureDaemon.version)
    run.regions([s.sidebarRegion, s.paneRegion])
    run.record([
      Check("opened", s.shown("general", since: 0) && s.model.nav.current == .page(.general), "General shows (\(SettingsBench.key(s.model.nav.current)))"),
      Check("status", connected, "the status row says Running · \(s.model.daemonVersion ?? "-") (\(s.model.connection))"),
      Check("needs-you", s.model.neededLogin == nil, "the default driver is logged in where new runs go: no amber count (\(s.model.neededLogin?.id ?? "none"))"),
    ])
  }

  // MARK: settings-switch-page

  /// Clicks every page's row in the sidebar (real clicks), then on Runs the Cloud place's row (its page pushed), then
  /// Back. Each click: the frame with that page. Ends on `--set end=PAGE` (a page's name, or place:NAME), for pictures.
  static func settingsSwitchPage(_ run: HostRun) async throws {
    let s = SettingsBench(run)
    if let scene = try? await run.appWindow(timeoutMs: 3000, where: { DeskBenchApp.isScene($0) }) { scene.orderOut(nil) }
    try await run.show(SettingsWindowView(model: s.model), size: SettingsBench.size, title: "Settings")
    await s.opened()
    var switched = true, notes: [String] = []
    let order: [SettingsPage] = [.notifications, .interface, .shortcuts, .runs, .accounts, .about, .status, .general]
    for _ in 0..<max(1, run.int("rounds", 1)) {
      for p in order {
        let t = run.now
        await run.click(at: s.rowPoint(p), ink: [s.paneRegion], name: "page \(p.rawValue)", until: { s.shown(p.rawValue, since: t) })
        let ok = s.model.nav.current == .page(p)
        if !ok { notes.append("\(p.rawValue): shows \(SettingsBench.key(s.model.nav.current))") }
        switched = switched && ok
      }
    }
    // Runs › Cloud: the place's own page, pushed; Back returns to Runs.
    var t = run.now
    await run.click(at: s.rowPoint(.runs), ink: [s.paneRegion], name: "page runs", until: { s.shown("runs", since: t) })
    t = run.now
    await run.click(identifier: "settings-place-boxd", ink: [s.paneRegion], name: "place boxd", until: { s.shown("place:boxd", since: t) })
    let pushed = s.model.nav.current == .place("boxd")
    t = run.now
    await run.click(at: s.backPoint, ink: [s.paneRegion], name: "back", until: { s.shown("runs", since: t) })
    let back = s.model.nav.current == .page(.runs) && s.model.nav.canGoForward
    // Where the picture is taken.
    if let end = run.param("end"), !end.isEmpty {
      let route: SettingsRoute? = end.hasPrefix("place:") ? .place(String(end.dropFirst(6))) : SettingsPage(rawValue: end).map { .page($0) }
      if let route {
        t = run.now
        await run.step("end \(end)", until: { s.shown(SettingsBench.key(route), since: t) }) { s.model.go(route) }
      }
    }
    await run.settle(quietMs: 300, timeoutMs: 3000)
    run.regions([s.sidebarRegion, s.paneRegion])
    run.record([
      Check("switched", switched, notes.joined(separator: "; ").ifEmpty("every click showed its page (\(order.count) pages)")),
      Check("place-pushed", pushed, "the Cloud row opened its page (\(SettingsBench.key(s.model.nav.current)))"),
      Check("back", back, back ? "Back returned to Runs, Forward ready" : "Back left \(SettingsBench.key(s.model.nav.current))"),
    ])
  }
}
