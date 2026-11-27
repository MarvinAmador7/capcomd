import XCTest
import AppKit
import SwiftUI
@testable import CapcomdStore
import DeskBenchKit
#if canImport(SwiftUI) && os(macOS)
@testable import CapcomdDesk
#endif

/// The desk's four layouts (owner, 2026-11-27): the stored preference and its migration from Reel / Sidebar, ⌃⌘S
/// keeping the side and the edge, the behaviors, and each layout's chrome in a real (off-screen) window.
final class DeskLayoutTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  private var suites: [String] = []
  override func tearDown() {
    for s in suites { UserDefaults().removePersistentDomain(forName: s) }
    suites = []
    super.tearDown()
  }
  func defaults() -> UserDefaults {
    let name = "desk-layout-tests-\(UUID().uuidString)"
    suites.append(name)
    return UserDefaults(suiteName: name)!
  }

  @MainActor func model(defaults: UserDefaults? = nil) -> (DeskModel, CapcomdStore) {
    let w = CachedFixtures.make("crew17")!
    let s = CapcomdStore()
    w.load(into: s)
    return (DeskModel(store: s, defaults: defaults), s)
  }

  // MARK: the preference

  /// Reel (folded) → Tabs above; Sidebar (opened) → Sidebar left; the old key goes once the new one is written.
  func testMigratesReelAndSidebar() {
    let reel = defaults()
    reel.set(false, forKey: DeskLayoutPrefs.legacyKey)
    XCTAssertEqual(DeskLayoutPrefs.read(reel).layout, .tabsAbove)
    XCTAssertNil(reel.object(forKey: DeskLayoutPrefs.legacyKey))
    XCTAssertEqual(reel.string(forKey: DeskLayoutPrefs.layoutKey), "tabsAbove")

    let sidebar = defaults()
    sidebar.set(true, forKey: DeskLayoutPrefs.legacyKey)
    let p = DeskLayoutPrefs.read(sidebar)
    XCTAssertEqual(p.layout, .sidebarLeft)
    XCTAssertEqual(p.side, .left)
    XCTAssertEqual(p.edge, .above)
    XCTAssertNil(sidebar.object(forKey: DeskLayoutPrefs.legacyKey))
    XCTAssertEqual(sidebar.string(forKey: DeskLayoutPrefs.layoutKey), "sidebarLeft")
    // Read again: the same, from the new key alone.
    XCTAssertEqual(DeskLayoutPrefs.read(sidebar).layout, .sidebarLeft)
  }

  /// Nothing stored: Tabs above, both always shown; a layout already stored wins over a stale old key.
  func testDefaultsAndAStoredLayoutWins() {
    let fresh = defaults()
    XCTAssertEqual(DeskLayoutPrefs.read(fresh), DeskLayoutPrefs())
    XCTAssertEqual(DeskLayoutPrefs().layout, .tabsAbove)
    XCTAssertNil(fresh.string(forKey: DeskLayoutPrefs.layoutKey))
    XCTAssertEqual(DeskLayoutPrefs.read(nil), DeskLayoutPrefs())

    let both = defaults()
    both.set("sidebarRight", forKey: DeskLayoutPrefs.layoutKey)
    both.set(false, forKey: DeskLayoutPrefs.legacyKey)
    XCTAssertEqual(DeskLayoutPrefs.read(both).layout, .sidebarRight)
    XCTAssertEqual(DeskLayoutPrefs.read(both).side, .right)
    XCTAssertNil(both.object(forKey: DeskLayoutPrefs.legacyKey))

    let junk = defaults()
    junk.set("diagonal", forKey: DeskLayoutPrefs.layoutKey)
    junk.set("sometimes", forKey: DeskLayoutPrefs.sidebarBehaviorKey)
    XCTAssertEqual(DeskLayoutPrefs.read(junk), DeskLayoutPrefs())
  }

  /// ⌃⌘S goes between tabs and the sidebar, each on the side or edge chosen last.
  func testToggleKeepsTheSideAndTheEdge() {
    var p = DeskLayoutPrefs()
    p.choose(.sidebarRight)
    XCTAssertEqual(p.toggled, .tabsAbove)
    p.choose(.tabsBelow)
    XCTAssertEqual(p.side, .right)
    XCTAssertEqual(p.toggled, .sidebarRight)
    p.choose(.sidebarLeft)
    XCTAssertEqual(p.toggled, .tabsBelow)
    for l in DeskLayout.allCases {
      XCTAssertEqual(DeskLayout(sidebar: l.isSidebar, side: l.side ?? .left, edge: l.edge ?? .above), l)
    }
  }

  /// The model: the layout, ⌃⌘S, the behaviors, written as they change and read back at the next launch; the old
  /// Sidebar choice comes back as Sidebar left.
  @MainActor func testTheModelKeepsTheLayoutAcrossLaunches() {
    let d = defaults()
    d.set(true, forKey: DeskLayoutPrefs.legacyKey)
    let (m, _) = model(defaults: d)
    XCTAssertEqual(m.layout, .sidebarLeft)
    XCTAssertTrue(m.nav.sidebarOpen)
    m.setLayout(.sidebarRight)
    XCTAssertEqual(m.layout, .sidebarRight)
    m.toggleSidebar()
    XCTAssertEqual(m.layout, .tabsAbove)
    XCTAssertFalse(m.nav.sidebarOpen)
    m.setLayout(.tabsBelow)
    m.toggleSidebar()
    XCTAssertEqual(m.layout, .sidebarRight)
    m.setSidebarBehavior(.hover)
    m.setTabsBehavior(.hover)
    m.toggleSidebar()
    XCTAssertEqual(m.layout, .tabsBelow)

    let (again, _) = model(defaults: d)
    XCTAssertEqual(again.layout, .tabsBelow)
    XCTAssertEqual(again.nav.sidebarSide, .right)
    XCTAssertEqual(again.nav.sidebarBehavior, .hover)
    XCTAssertEqual(again.nav.tabsBehavior, .hover)
    again.toggleSidebar()
    XCTAssertEqual(again.layout, .sidebarRight)
  }

  /// Switching keeps what you were looking at: the pane's agent, its splits, the reel's place and the column views.
  @MainActor func testSwitchingKeepsTheSelectionAndTheSplits() {
    let (m, _) = model()
    let target = m.columns[3]
    m.setLayout(.sidebarLeft)
    m.selectRow(id: target)
    m.split(down: false)
    let panes = m.panes, focused = m.focusedAgent
    XCTAssertEqual(m.panes.count, 2)
    for l in [DeskLayout.sidebarRight, .sidebarLeft, .sidebarRight] {
      m.setLayout(l)
      XCTAssertEqual(m.panes, panes, "\(l)")
      XCTAssertEqual(m.focusedAgent, focused, "\(l)")
    }
    // To tabs and back: the reel comes to the pane's agent, and the panes are as they were.
    m.setLayout(.tabsBelow)
    XCTAssertEqual(m.focusedAgent, focused)
    m.setLayout(.sidebarRight)
    XCTAssertEqual(m.panes, panes)
    XCTAssertEqual(m.paneAgent, focused)
  }

  /// Team from the tab bar opens the sidebar on the roster; closing Team goes back to the tabs it came from.
  @MainActor func testTeamFromTheTabsGoesBackToTheTabs() {
    let (m, _) = model()
    m.team.available = true
    m.setLayout(.tabsBelow)
    m.openTeam()
    XCTAssertTrue(m.nav.sidebarOpen)
    XCTAssertTrue(m.team.isOpen)
    m.closeTeam()
    XCTAssertEqual(m.layout, .tabsBelow)
    // Opened from the sidebar, it stays in the sidebar.
    m.setLayout(.sidebarLeft)
    m.openTeam()
    m.closeTeam()
    XCTAssertEqual(m.layout, .sidebarLeft)
  }

  // MARK: the chrome

  /// The tab bar's trailing buttons are the rail's places with their tooltips and shortcuts.
  func testTheTabBarCarriesTheRailsPlaces() {
    XCTAssertEqual(PlaceButton.tabBar, [.needs, .home, .team, .history, .settings, .search, .newProject])
    XCTAssertEqual(PlaceButton.home.help, "Home (⌘0)")
    XCTAssertEqual(PlaceButton.search.help, "Search (⌘K)")
    XCTAssertEqual(PlaceButton.newProject.help, "New project (⇧⌘N)")
    XCTAssertEqual(PlaceButton.settings.help, "Settings (⌘,)")
    XCTAssertTrue(PlaceButton.allCases.allSatisfy { !$0.help.isEmpty && !$0.label.isEmpty })
  }

  /// The opened layer's frames: the sidebar on its side with the pane beside it; on the right, and with Show on hover,
  /// the pane starts under the traffic lights' band; expanded, the pane has the window.
  func testOpenedFrames() {
    let size = CGSize(width: 1440, height: 900), w = SidebarMetrics.width, band = DeskLayoutProbe.tabBar - PaneMetrics.inset
    let left = OpenedFrames.make(size: size, side: .left, hover: false, expanded: false)
    XCTAssertEqual(left.sidebar, CGRect(x: 0, y: 0, width: w, height: 900))
    XCTAssertEqual(left.main, CGRect(x: w, y: 0, width: 1440 - w, height: 900))
    XCTAssertEqual(left.paneInsets.left, 0)
    let right = OpenedFrames.make(size: size, side: .right, hover: false, expanded: false)
    XCTAssertEqual(right.sidebar, CGRect(x: 1440 - w, y: 0, width: w, height: 900))
    XCTAssertEqual(right.main, CGRect(x: 0, y: band, width: 1440 - w, height: 900 - band))
    XCTAssertEqual(right.paneInsets.right, 0)
    XCTAssertGreaterThan(right.paneInsets.left, 0)
    for side in SidebarSide.allCases {
      let hover = OpenedFrames.make(size: size, side: side, hover: true, expanded: false)
      XCTAssertEqual(hover.main, CGRect(x: 0, y: band, width: 1440, height: 900 - band))
      XCTAssertTrue(hover.floating)
      let expanded = OpenedFrames.make(size: size, side: side, hover: false, expanded: true)
      XCTAssertEqual(expanded.main, CGRect(origin: .zero, size: size))
    }
  }

  /// Each layout in a real window (off screen): tabs show the tab bar and no sidebar (no rail either), on their edge;
  /// the sidebar shows on its side and no tab bar. Switching rebuilds none of the reel's columns. With
  /// DESK_LAYOUT_CAPTURE_DIR set, each layout is written there as a PNG.
  @MainActor func testEachLayoutsChromeInTheWindow() throws {
    let dir = ProcessInfo.processInfo.environment["DESK_LAYOUT_CAPTURE_DIR"].map { URL(fileURLWithPath: $0) }
    if let dir { try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true) }
    let (m, _) = model()
    _ = NSApplication.shared
    let w = NSWindow(contentRect: NSRect(x: -20_000, y: -20_000, width: 1440, height: 900), styleMask: [.titled, .resizable, .fullSizeContentView], backing: .buffered, defer: false)
    w.isReleasedWhenClosed = false
    w.appearance = NSAppearance(named: .darkAqua)
    let host = NSHostingView(rootView: DeskWindowContent(model: m))
    w.contentView = host
    w.orderFrontRegardless()
    defer { w.orderOut(nil); w.contentView = nil }
    func spin(_ s: Double = 0.5) { RunLoop.main.run(until: Date().addingTimeInterval(s)) }
    func walk(_ v: NSView, _ f: (NSView) -> Void) { f(v); v.subviews.forEach { walk($0, f) } }
    func reel() -> ReelColumnViews? { var r: ReelColumnViews?; walk(host) { if r == nil, let x = $0 as? ReelColumnViews, x.reelKind == .project { r = x } }; return r }
    func columnViews() -> [ObjectIdentifier] {
      guard let r = reel() else { return [] }
      return (0..<r.columnCount).compactMap { r.columnView(at: $0).map(ObjectIdentifier.init) }
    }
    func shown(_ v: NSView) -> CGRect? { v.isHiddenOrHasHiddenAncestor ? nil : v.convert(v.bounds, to: nil) }
    /// The sidebar's hosting view, while it shows (window coordinates, bottom-left origin).
    func sidebar() -> CGRect? {
      var r: CGRect?
      walk(host) { v in if v.identifier?.rawValue == OpenedLayerView.sidebarID, let f = shown(v) { r = f } }
      return r
    }
    func reelFrame() -> CGRect? { reel().flatMap { shown($0.reelScrollView) } }
    // The reel opens heads first and warms its columns after (each a view of its own once warm): every column warm and
    // its view settled before the views are compared.
    let deadline = Date().addingTimeInterval(20)
    var last: [ObjectIdentifier] = []
    repeat {
      spin(0.5)
      let now = columnViews()
      if now == last, m.columns.allSatisfy({ m.agent($0)?.warm == true }) { break }
      last = now
    } while Date() < deadline
    let built = columnViews()
    XCTAssertFalse(built.isEmpty)
    let H = host.bounds.height, W = host.bounds.width, bar = DeskLayoutProbe.tabBar
    var reelTop: CGFloat?
    for l in [DeskLayout.tabsAbove, .sidebarLeft, .sidebarRight, .tabsBelow, .tabsAbove, .sidebarRight] {
      m.setLayout(l)
      spin()
      switch l {
      case .tabsAbove, .tabsBelow:
        XCTAssertNil(sidebar(), "\(l): a sidebar shows with the tabs")
        let r = try XCTUnwrap(reelFrame(), "\(l): no reel")
        // No rail: the reel spans the window. Above: under the band; below: the band empty, the bar under the reel.
        XCTAssertEqual(r.minX, 0, accuracy: 0.5, "\(l)")
        XCTAssertEqual(r.width, W, accuracy: 0.5, "\(l)")
        XCTAssertGreaterThanOrEqual(H - r.maxY, bar - 0.5, "\(l): the reel's top is in the band")
        // Its top doesn't move between the tab bar's edges.
        if let t = reelTop { XCTAssertEqual(r.maxY, t, accuracy: 0.5, "\(l): the reel's top moved") } else { reelTop = r.maxY }
        XCTAssertEqual(r.minY, l == .tabsBelow ? bar : 0, accuracy: 0.5, "\(l): the reel's bottom")
      case .sidebarLeft, .sidebarRight:
        let s = try XCTUnwrap(sidebar(), "\(l): no sidebar")
        XCTAssertEqual(s.width, SidebarMetrics.width, accuracy: 0.5)
        XCTAssertEqual(l == .sidebarLeft ? s.minX : W - s.maxX, 0, accuracy: 0.5, "\(l): the sidebar's side")
      }
      XCTAssertEqual(columnViews(), built, "\(l): the reel's columns were rebuilt")
      if let dir {
        let rep = try XCTUnwrap(host.bitmapImageRepForCachingDisplay(in: host.bounds))
        host.cacheDisplay(in: host.bounds, to: rep)
        try rep.representation(using: .png, properties: [:])?.write(to: dir.appendingPathComponent("\(l.rawValue).png"))
      }
    }
  }
  #endif
}
