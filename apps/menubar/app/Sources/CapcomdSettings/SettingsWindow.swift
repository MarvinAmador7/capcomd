#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdBot
import CapcomdDesk

/// The Settings window (design/desktop/settings/SettingsWindow.dc.html): the desk's own dark chrome, a 248 pt sidebar on
/// the ground (Search, the capcomd status row, the pages in groups) and the page in an inset pane with Back and Forward
/// and its title. Not the system's split view: its sidebar draws the system's material and accent-blue selection.
/// Changes apply at once; anything that has to run in a terminal opens Terminal with the command ready, and the row
/// follows it.
package struct SettingsWindowView: View {
  @Bindable var model: SettingsModel
  package init(model: SettingsModel) { self.model = model }

  package var body: some View {
    HStack(spacing: 0) {
      SettingsSidebar()
      SettingsPane()
        .padding(.top, ST.paneInset).padding(.bottom, ST.paneInset).padding(.trailing, ST.paneInset)
    }
    .frame(minWidth: ST.width, maxWidth: ST.width, minHeight: ST.height, maxHeight: .infinity)
    .background(ST.page)
    // The sidebar's 52 pt header holds the traffic lights: the layout starts at the window's top edge.
    .ignoresSafeArea()
    .environment(model)
    .environment(\.colorScheme, .dark)
    .preferredColorScheme(.dark)
    // Every route Settings reads is cheap: read them while the window is open, and at once when the app comes back
    // from Terminal.
    .task {
      while !Task.isCancelled {
        await model.refreshSettings()
        try? await Task.sleep(for: .seconds(ST.poll))
      }
    }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      Task { await model.refreshSettings() }
    }
    .background(WindowReader { SettingsWindow.attach($0, host: model.host) })
    .background {
      // ⌘[ and ⌘]: Back and Forward.
      Group {
        Button("Back") { model.goBack() }.keyboardShortcut("[", modifiers: .command)
        Button("Forward") { model.goForward() }.keyboardShortcut("]", modifiers: .command)
      }
      .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
    }
  }
}

// MARK: sidebar

/// The sidebar: Search, then the status row and the pages, or the search's results while it has a query.
struct SettingsSidebar: View {
  @Environment(SettingsModel.self) private var model
  @FocusState private var searching: Bool

  var body: some View {
    @Bindable var model = model
    VStack(alignment: .leading, spacing: 0) {
      Color.clear.frame(height: ST.sidebarHeader)   // the traffic lights
      SearchField(text: $model.query, focused: $searching) {
        if let first = model.results.first { model.open(first); searching = false }
      }
      .padding(.bottom, ST.searchBottom)
      if model.query.trimmingCharacters(in: .whitespaces).isEmpty {
        StatusRow()
        Color.clear.frame(height: ST.groupGap)
        ForEach(Array(SettingsPage.groups.enumerated()), id: \.offset) { i, group in
          if i > 0 { Color.clear.frame(height: ST.groupGap) }
          ForEach(group, id: \.self) { PageRow(page: $0) }
        }
      } else {
        SearchResults()
      }
      Spacer(minLength: 0)
    }
    .padding(.horizontal, ST.sidebarPadding).padding(.bottom, 6)
    .frame(width: ST.sidebar)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Settings sections")
  }
}

/// The search field (.st-search): 28 tall, a magnifier, a clear button while it has text. Return opens the first result.
struct SearchField: View {
  @Binding var text: String
  var focused: FocusState<Bool>.Binding
  let submit: () -> Void
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ST.searchRadius, style: .continuous)
    HStack(spacing: 6) {
      Image(systemName: "magnifyingglass").font(.system(size: 12, weight: .medium)).foregroundStyle(ST.t3).accessibilityHidden(true)
      TextField("Search", text: $text, prompt: Text("Search").foregroundStyle(ST.t3))
        .textFieldStyle(.plain).font(.system(size: 13)).foregroundStyle(ST.t1)
        .focused(focused)
        .onSubmit(submit)
        .onExitCommand { text = "" }
        .accessibilityIdentifier("settings-search")
      if !text.isEmpty {
        Button { text = "" } label: {
          Image(systemName: "xmark.circle.fill").font(.system(size: 13)).foregroundStyle(ST.t3)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Clear search")
      }
    }
    .padding(.leading, 8).padding(.trailing, 6)
    .frame(height: ST.search)
    .background(shape.fill(ST.searchFill))
    .overlay(shape.strokeBorder(focused.wrappedValue ? ST.accent.opacity(0.85) : ST.searchStroke, lineWidth: 0.5))
    .overlay(shape.inset(by: -1.5).stroke(ST.accent.opacity(0.22), lineWidth: 3).opacity(focused.wrappedValue ? 1 : 0))
  }
}

/// The capcomd status row (.st-who): the app icon, "capcomd", and Running · version or Not running. Opens its page.
struct StatusRow: View {
  @Environment(SettingsModel.self) private var model
  @State private var hover = false
  var body: some View {
    let c = model.connection, selected = model.nav.current == .page(.status)
    Button { model.go(.page(.status)) } label: {
      HStack(spacing: ST.whoGap) {
        AppIconImage(side: ST.whoMark)
        VStack(alignment: .leading, spacing: 0) {
          Text("capcomd").font(ST.whoName).foregroundStyle(ST.t1)
          HStack(spacing: 5) {
            StatusDot(kind: Self.dot(c), side: 6)
            Text(verbatim: Self.status(c, version: model.daemonVersion)).lineLimit(1)
          }
          .font(ST.whoStatus).foregroundStyle(ST.t3)
        }
        Spacer(minLength: 0)
      }
      .padding(.horizontal, 8)
      .frame(height: ST.who)
      .background(RoundedRectangle(cornerRadius: ST.rowRadius, style: .continuous).fill(selected ? ST.rowSelected : hover ? ST.rowHover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .accessibilityLabel("capcomd, \(Self.status(c, version: model.daemonVersion))")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("settings-page-status")
  }

  static func dot(_ c: ConnectionState) -> StatusDot.Kind {
    switch c { case .connected: .ok; case .unreachable, .rejected: .bad; case .noToken, .waitingForKeychain: .empty }
  }
  static func status(_ c: ConnectionState, version: String?) -> String {
    switch c {
    case .connected: version.map { "Running · \($0)" } ?? "Running"
    case .unreachable: "Not running"
    case .rejected: "Token refused"
    case .noToken: "Not connected"
    case .waitingForKeychain: "Waiting for Keychain"
    }
  }
}

/// A page's row (.row): its icon, its title, the amber count on Accounts when a login new runs need is missing.
struct PageRow: View {
  @Environment(SettingsModel.self) private var model
  let page: SettingsPage
  @State private var hover = false
  var body: some View {
    let selected = model.nav.current.page == page
    let count = page == .accounts && model.neededLogin != nil ? 1 : 0
    Button { model.go(.page(page)) } label: {
      HStack(spacing: ST.rowGap) {
        if let g = page.glyph { SectionIcon(glyph: g) }
        Text(verbatim: page.title).font(ST.rowFont).foregroundStyle(selected || hover ? ST.t1 : ST.t2).lineLimit(1)
        Spacer(minLength: 0)
        if count > 0 {
          Text(verbatim: "\(count)").font(ST.countFont).foregroundStyle(ST.countText)
            .padding(.horizontal, 4).frame(minWidth: 15, minHeight: 15)
            .background(Capsule().fill(ST.count))
            .accessibilityLabel("a login needs you")
        }
      }
      .padding(.leading, 8).padding(.trailing, 6)
      .frame(height: ST.row)
      .background(RoundedRectangle(cornerRadius: ST.rowRadius, style: .continuous).fill(selected ? ST.rowSelected : hover ? ST.rowHover : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityIdentifier("settings-page-\(page.rawValue)")
  }
}

/// The search's results (States: search with results): each row's icon, its title with the match in bold, its page.
struct SearchResults: View {
  @Environment(SettingsModel.self) private var model
  var body: some View {
    let results = model.results
    if results.isEmpty {
      Text("No Results").font(ST.rowFont).foregroundStyle(ST.t3).frame(maxWidth: .infinity).padding(.top, 16)
    } else {
      ForEach(results) { r in
        Button { model.open(r) } label: {
          HStack(spacing: ST.rowGap) {
            if let g = r.entry.route.page.glyph { SectionIcon(glyph: g) } else { AppIconImage(side: ST.icon) }
            Self.title(r).font(ST.rowFont).foregroundStyle(ST.t1).lineLimit(1).truncationMode(.tail)
            Spacer(minLength: 4)
            Text(verbatim: r.entry.pageTitle).font(ST.resultPage).foregroundStyle(ST.t3)
          }
          .padding(.leading, 8).padding(.trailing, 6)
          .frame(height: ST.row)
          .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
      }
    }
  }

  /// The title with the matched characters in bold.
  static func title(_ r: SettingsSearch.Result) -> Text {
    let t = r.entry.title
    guard let m = r.match, m.upperBound <= t.count else { return Text(verbatim: t) }
    let a = t.index(t.startIndex, offsetBy: m.lowerBound), b = t.index(t.startIndex, offsetBy: m.upperBound)
    return Text(verbatim: String(t[..<a])) + Text(verbatim: String(t[a..<b])).fontWeight(.semibold) + Text(verbatim: String(t[b...]))
  }
}

// MARK: pane

/// The pane (.pane): the toolbar, then the page.
struct SettingsPane: View {
  @Environment(SettingsModel.self) private var model
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: ST.panelRadius, style: .continuous)
    VStack(spacing: 0) {
      Toolbar()
      page.frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }
    .background(shape.fill(ST.panel))
    .overlay(shape.strokeBorder(ST.panelStroke, lineWidth: 0.5))
    .clipShape(shape)
  }

  @ViewBuilder private var page: some View {
    let _ = DeskProbe.body("SettingsPage", id: Self.key(model.nav.current))
    switch model.nav.current {
    case .page(.status): StatusPage()
    case .page(.general): GeneralPage()
    case .page(.notifications): NotificationsPage()
    case .page(.interface): InterfacePage()
    case .page(.shortcuts): ShortcutsPage()
    case .page(.runs): RunsPage()
    case .page(.accounts): AccountsPage()
    case .page(.about): AboutPage()
    case .place(let name): PlacePage(name: name).id(name)
    }
  }

  /// The route as the bench names it: "general", "place:boxd".
  static func key(_ r: SettingsRoute) -> String {
    switch r { case .page(let p): p.rawValue; case .place(let n): "place:\(n)" }
  }
}

/// The toolbar (.st-tb): Back and Forward in a capsule, the page's title.
struct Toolbar: View {
  @Environment(SettingsModel.self) private var model
  var body: some View {
    HStack(spacing: 12) {
      HStack(spacing: 0) {
        navButton("chevron.left", "Back", enabled: model.nav.canGoBack) { model.goBack() }
        Rectangle().fill(ST.navStroke).frame(width: 0.5, height: ST.navHeight)
        navButton("chevron.right", "Forward", enabled: model.nav.canGoForward) { model.goForward() }
      }
      .frame(height: ST.navHeight)
      .background(Capsule().fill(ST.navFill))
      .overlay(Capsule().strokeBorder(ST.navStroke, lineWidth: 0.5))
      Text(verbatim: title).font(ST.title).foregroundStyle(ST.t1).lineLimit(1)
        .accessibilityAddTraits(.isHeader)
        .accessibilityIdentifier("settings-title")
      Spacer(minLength: 0)
    }
    .padding(.horizontal, ST.toolbarPadding)
    .frame(height: ST.toolbar)
  }

  private var title: String {
    switch model.nav.current { case .page(let p): p.title; case .place(let n): model.placeTitle(n) }
  }

  private func navButton(_ symbol: String, _ label: String, enabled: Bool, _ action: @escaping () -> Void) -> some View {
    Button(action: action) {
      Image(systemName: symbol).font(.system(size: 12, weight: .medium))
        .frame(width: ST.navButton, height: ST.navHeight).contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .foregroundStyle(enabled ? ST.t1 : ST.t4)
    .disabled(!enabled)
    .accessibilityLabel(label)
  }
}

// MARK: the window

/// The Settings window: brought to the front with its controls drawn active (⌘, or the panel's Settings…), the menu bar
/// panel closed; the desk's chrome (a transparent title bar over a full-size content view, the 52 pt toolbar area the
/// traffic lights sit in).
@MainActor package enum SettingsWindow {
  private static var window: NSWindow?
  private static var closeObserver: NSObjectProtocol?
  package static var isOpen: Bool { window?.isVisible == true }

  /// Settings… in the panel: close the panel, open the window in front.
  package static func open(_ openSettings: OpenSettingsAction, host: SettingsHost) {
    host.closePanel()
    openSettings()
    DispatchQueue.main.async { if let window { bringFront(window) } }
  }

  /// The Settings view found its window (⌘, or Settings…): in front, its chrome, forgotten when it closes.
  package static func attach(_ w: NSWindow, host: SettingsHost) {
    host.closePanel()
    chrome(w)
    if window !== w {
      if let closeObserver { NotificationCenter.default.removeObserver(closeObserver) }
      window = w
      closeObserver = NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: w, queue: .main) { _ in
        MainActor.assumeIsolated {
          if let o = closeObserver { NotificationCenter.default.removeObserver(o) }
          closeObserver = nil; window = nil
        }
      }
    }
    DispatchQueue.main.async { bringFront(w) }
  }

  /// The desk's chrome on the Settings window.
  package static func chrome(_ w: NSWindow) {
    w.titlebarAppearsTransparent = true
    w.titleVisibility = .hidden
    w.styleMask.insert(.fullSizeContentView)
    w.styleMask.insert(.resizable)
    if w.toolbar == nil {
      let t = NSToolbar(identifier: "capcomd.settings")
      t.showsBaselineSeparator = false
      w.toolbar = t
    }
    w.toolbarStyle = .unified
    w.isMovableByWindowBackground = true
    w.backgroundColor = NSColor(srgbRed: 0x0C / 255, green: 0x0C / 255, blue: 0x0D / 255, alpha: 1)
    w.appearance = NSAppearance(named: .darkAqua)
    w.contentMinSize = NSSize(width: ST.width, height: ST.height)
    w.contentMaxSize = NSSize(width: ST.width, height: 10_000)
  }

  private static func bringFront(_ w: NSWindow) {
    NSApp.activate()
    w.makeKeyAndOrderFront(nil)
    w.orderFrontRegardless()
  }
}

/// Hands the view's window to `found` once it is in one.
package struct WindowReader: NSViewRepresentable {
  let found: (NSWindow) -> Void
  package init(found: @escaping (NSWindow) -> Void) { self.found = found }
  package func makeNSView(context: Context) -> NSView { Reader(found: found) }
  package func updateNSView(_ v: NSView, context: Context) {}
  final class Reader: NSView {
    let found: (NSWindow) -> Void
    init(found: @escaping (NSWindow) -> Void) { self.found = found; super.init(frame: .zero) }
    required init?(coder: NSCoder) { nil }
    override func viewDidMoveToWindow() {
      super.viewDidMoveToWindow()
      if let window { let f = found; DispatchQueue.main.async { f(window) } }
    }
  }
}
#endif
