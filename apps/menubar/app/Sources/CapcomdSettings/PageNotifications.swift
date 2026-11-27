#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI
import CapcomdDesk

/// Notifications (SettingsSections.dc.html): what to be told about, and the Dock icon's Needs you count.
struct NotificationsPage: View {
  @Environment(SettingsModel.self) private var model
  @State private var denied = false

  var body: some View {
    @Bindable var model = model
    let available = model.host.notificationsAvailable
    SPage {
      SGroup("Notify me about", id: "notifications.notify") {
        SToggleRow(title: "Approval requests", isOn: $model.notifyApprovals)
        SSep()
        SToggleRow(title: "Usage limits", isOn: $model.notifyUsageLimits)
        SSep()
        SToggleRow(title: "Finished runs", isOn: $model.notifyRunFinished)
      }
      .disabled(!available)

      SGroup(id: "notifications.badge") {
        SRow("Badge app icon") {
          Text("Needs you count")
          SSwitch(title: "Badge app icon", isOn: $model.badgeAppIcon)
        }
      } foot: {
        if !available {
          SFoot(verbatim: "Available in the capcomd app. This build runs without an app bundle.")
        } else if denied {
          SFoot(Text(Self.linked("Notifications are off for capcomd. Turn them on in [System Settings › Notifications](\(NotificationPermission.settingsURL.absoluteString)).")))
        } else {
          SFoot(Text(Self.linked("Banners and sounds follow [System Settings › Notifications](\(NotificationPermission.settingsURL.absoluteString)).")))
        }
      }
    }
    .task { denied = await NotificationPermission.denied(available: available) }
    .onReceive(NotificationCenter.default.publisher(for: NSApplication.didBecomeActiveNotification)) { _ in
      Task { denied = await NotificationPermission.denied(available: available) }
    }
  }

  /// A footnote with a link in it (Markdown).
  static func linked(_ markdown: String) -> AttributedString { (try? AttributedString(markdown: markdown)) ?? AttributedString(markdown) }
}

/// Shortcuts (read-only): the window's menu items and their keys. System Settings can change a menu item's.
struct ShortcutsPage: View {
  var body: some View {
    SPage {
      ForEach(Shortcuts.groups) { g in
        SGroup(g.title, id: "shortcuts.\(g.id)") {
          ForEach(Array(g.rows.enumerated()), id: \.offset) { i, r in
            if i > 0 { SSep() }
            SRow(r.title, minHeight: ST.shortcutRow) { Text(verbatim: r.keys).monospacedDigit().tracking(0.5) }
          }
        }
      }
      SFoot(verbatim: "Change them in System Settings › Keyboard › Keyboard Shortcuts › App Shortcuts.")
    }
  }
}

/// Interface: the window's layout (four tiles, the value ⌃⌘S switches between tabs and the sidebar) with its behavior,
/// and the reel's columns, tabs and Follow.
struct InterfacePage: View {
  @Environment(SettingsModel.self) private var model
  var body: some View {
    @Bindable var model = model
    let layout = model.deskLayout
    let behaviorTitle = layout.isSidebar ? "Sidebar behavior" : "Tab bar behavior"
    SPage {
      SGroup("Layout", id: "interface.layout") {
        // The board's .st-tiles: four, spread across the card.
        HStack(spacing: 0) {
          ForEach(DeskLayout.allCases) { l in
            if l != DeskLayout.allCases.first { Spacer(minLength: 14) }
            LayoutTile(layout: l, on: layout == l) { model.deskLayout = l }
          }
        }
        .padding(.top, 14).padding(.horizontal, 12).padding(.bottom, 12)
        .accessibilityElement(children: .contain).accessibilityLabel("Layout")
        SSep()
        SRow(behaviorTitle) {
          Picker(behaviorTitle, selection: $model.layoutBehavior) {
            ForEach(ChromeBehavior.allCases) { Text(verbatim: $0.name).tag($0) }
          }
          .labelsHidden().pickerStyle(.menu).fixedSize()
        }
      } foot: {
        SFoot(verbatim: "⌃⌘S switches between tabs and the sidebar.")
      }

      SGroup("Reel", id: "interface.reel") {
        SRow("Columns across") {
          Picker("Columns across", selection: $model.columnsAcross) {
            ForEach(InterfacePrefs.Columns.allCases, id: \.self) { Text(verbatim: $0.title).tag($0) }
          }
          .labelsHidden().pickerStyle(.menu).fixedSize()
        }
        SSep()
        SRow("Crew tabs") {
          Picker("Crew tabs", selection: $model.crewTabs) {
            ForEach(InterfacePrefs.CrewTabs.allCases, id: \.self) { Text(verbatim: $0.title).tag($0) }
          }
          .labelsHidden().pickerStyle(.segmented).fixedSize()
        }
        SSep()
        SToggleRow(title: "Follow asks and failures", isOn: $model.followAtLaunch)
      }
    }
  }
}

/// A layout tile (.st-tile): a 124 × 78 drawing of the window, its name under it, ringed when chosen.
struct LayoutTile: View {
  let layout: DeskLayout
  let on: Bool
  let pick: () -> Void
  var body: some View {
    let shape = RoundedRectangle(cornerRadius: 8, style: .continuous)
    VStack(spacing: 8) {
      Button(action: pick) {
        LayoutThumb(layout: layout)
          .frame(width: ST.layoutWidth, height: ST.layoutHeight)
          .background(ST.hex(0x0E0E10))
          .clipShape(shape)
          .overlay(shape.strokeBorder(Color.white.opacity(0.16), lineWidth: 0.5))
          .overlay(shape.inset(by: -1.5).stroke(ST.accent, lineWidth: 3).opacity(on ? 1 : 0))
          .contentShape(shape)
      }
      .buttonStyle(.plain)
      Text(verbatim: layout.name).font(.system(size: 12, weight: on ? .medium : .regular)).foregroundStyle(on ? ST.t1 : ST.t2)
    }
    .accessibilityElement(children: .ignore)
    .accessibilityLabel("Layout: \(layout.name)")
    .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    .accessibilityAction { pick() }
    .accessibilityIdentifier("settings-layout-\(layout.rawValue)")
  }
}

/// The board's tile drawings (.st-th spans): tabs above or below one wide column, with the places as small squares at
/// the tab bar's trailing end; the sidebar (a list, its foot's squares) at the left or the right of one agent's pane.
/// Positions are the board's, in points.
struct LayoutThumb: View {
  let layout: DeskLayout
  var body: some View {
    Canvas { ctx, _ in
      func rect(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, _ c: Color, _ r: CGFloat = 1) {
        ctx.fill(Path(roundedRect: CGRect(x: x, y: y, width: w, height: h), cornerRadius: r), with: .color(c))
      }
      let line = Color.white.opacity(0.22), dim = Color.white.opacity(0.12), g = Color.white.opacity(0.08), s = Color.white.opacity(0.1)
      let head = ST.hex(0x8A6BD1), light = ST.hex(0x3A3A3E), amber = ST.hex(0xFFB020)
      for x in [5, 10, 15] as [CGFloat] { rect(x, 4, 3, 3, light, 1.5) }
      func card(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat) {
        rect(x, y, w, h, ST.hex(0x151518), 3)
        ctx.stroke(Path(roundedRect: CGRect(x: x + 0.25, y: y + 0.25, width: w - 0.5, height: h - 0.5), cornerRadius: 3), with: .color(.white.opacity(0.1)), lineWidth: 0.5)
      }
      /// The pane: its head and title, then lines of a thread, and its message box.
      func pane(_ x: CGFloat, _ y: CGFloat, _ w: CGFloat, _ h: CGFloat, lines: [CGFloat], box: CGRect) {
        card(x, y, w, h)
        rect(x + 4, y + 4, 4, 4, head); rect(x + 10, y + 5, 26, 2, line)
        for (i, lw) in lines.enumerated() { rect(x + 10, y + 14 + CGFloat(i) * 7, lw, 2, dim) }
        rect(box.minX, box.minY, box.width, box.height, g, 2)
      }
      /// The sidebar: the Needs you heading, rows, the search line and the foot's squares.
      func sidebar(_ x: CGFloat) {
        rect(x, 13, 14, 2, amber)
        for (i, w) in [20, 16, 22, 14, 18, 12].enumerated() {
          let y = 18 + CGFloat(i) * 6
          rect(x, y, 3, 3, head); rect(x + 6, y + 1, CGFloat(w), 2, line)
        }
        rect(x - 2, 58, 34, 5, s, 2)
        for dx in [0, 7, 14, 21] as [CGFloat] { rect(x + dx, 68, 4, 4, s, 2) }
      }
      /// The tab bar: the project's group with its tabs, then the places as squares at the trailing end.
      func tabs(_ y: CGFloat) {
        rect(y > 40 ? 4 : 24, y, 62, 7, g, 2)
        for x in (y > 40 ? [7, 26, 45] : [27, 46, 65]) as [CGFloat] { rect(x, y + 1.5, 15, 4, s, 2) }
        for x in [90, 97, 104, 111] as [CGFloat] { rect(x, y + 1.5, 4, 4, s, 2) }
      }
      switch layout {
      case .tabsAbove:
        tabs(2)
        pane(3, 12, 118, 63, lines: [68, 53, 73, 44, 63], box: CGRect(x: 11, y: 66, width: 102, height: 5))
      case .sidebarLeft:
        sidebar(5)
        pane(40, 3, 81, 72, lines: [42, 33, 45, 27, 39], box: CGRect(x: 48, y: 66, width: 65, height: 5))
      case .sidebarRight:
        pane(3, 12, 78, 63, lines: [40, 31, 43, 26, 37], box: CGRect(x: 11, y: 66, width: 62, height: 5))
        sidebar(87)
      case .tabsBelow:
        pane(3, 12, 118, 54, lines: [68, 53, 73, 44], box: CGRect(x: 11, y: 57, width: 102, height: 5))
        tabs(68)
      }
    }
  }
}
#endif
