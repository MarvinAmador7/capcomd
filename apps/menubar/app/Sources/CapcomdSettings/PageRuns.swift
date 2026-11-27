#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// Runs (SettingsSections.dc.html, Runs): what new runs start with, and each place agents run as one row that pushes its
/// own page (PlacePage). A row shows the one state that needs action ("Agent environment not built"), else the place's.
/// "Runs on" and a place's Make Default are one setting, the composer's starting place.
struct RunsPage: View {
  @Environment(SettingsModel.self) private var model
  private static let chooseFolder = "\u{1}choose"

  var body: some View {
    let places = model.hasRunOptions ? model.sandboxes : []
    SPage {
      SGroup("New runs", id: "runs.newRuns") {
        projectRow
        if model.hasRunOptions {
          SSep(); driverRow
          if model.modelMenu.sections.contains(where: { $0.provider == model.startDriver?.provider && !$0.options.isEmpty }) { SSep(); modelRow }
          if let d = model.startDriver, let levels = d.efforts, !levels.isEmpty { SSep(); effortRow(d, levels) }
          SSep(); placeRow
        }
      } foot: {
        if !model.hasRunOptions { SFoot(verbatim: "This version of capcomd can't list drivers or places to run. Update capcomd to choose them here.") }
      }

      if !places.isEmpty {
        SGroup("Places", id: "runs.places") {
          ForEach(Array(places.enumerated()), id: \.element.id) { i, p in
            if i > 0 { SSep() }
            PlaceRow(place: p)
          }
        } foot: {
          if !model.connection.live { SFoot(verbatim: "Shown when capcomd is running.") }
        }
      }
    }
  }

  /// The project checkout new runs go to (the composer's folder chip), or capcomd's default project.
  private var projectRow: some View {
    SRow("Project") {
      Picker("Project", selection: Binding(get: { model.startRepo ?? "" }, set: { v in
        if v == Self.chooseFolder {
          Task { if let f = await model.host.chooseFolder("Choose the project's checkout.") { model.startRepo = f } }
        } else {
          model.startRepo = v.isEmpty ? nil : v
        }
      })) {
        Label("Default project", systemImage: "folder").tag("")
        if let repo = model.startRepo { Label((repo as NSString).lastPathComponent, systemImage: "folder").tag(repo) }
        Divider()
        Text("Choose Folder…").tag(Self.chooseFolder)
      }
      .labelsHidden().pickerStyle(.menu).fixedSize()
      .help(model.startRepo ?? "capcomd's default project")
    }
  }

  /// Who drives new runs as their planner, as the default place has them; one that can't run there is disabled.
  @ViewBuilder private var driverRow: some View {
    let drivers = model.defaultPlaceDrivers
    let current = model.startDriver?.provider ?? ""
    SRow("Driven by") {
      Picker("Driven by", selection: Binding(get: { current }, set: { model.pickDriver($0) })) {
        if current.isEmpty { Text("None available").tag("") }
        ForEach(drivers) { d in
          Label { Text(verbatim: d.label) } icon: { Provider(wire: d.provider).map(MenuMarks.provider) }
            .tag(d.provider).disabled(!d.available)
        }
      }
      .labelsHidden().pickerStyle(.menu).fixedSize()
      .help(drivers.filter { !$0.available }.map { "\($0.label): \($0.reason ?? "unavailable")" }.joined(separator: "\n"))
    }
  }

  /// The planner's model for new runs (the window's model menu, for the driver new runs go to).
  @ViewBuilder private var modelRow: some View {
    let menu = model.modelMenu
    let section = menu.sections.first { $0.provider == model.startDriver?.provider }
    let options = section?.options ?? []
    let checked = options.first(where: \.checked) ?? options.first
    SRow("Model") {
      Picker("Model", selection: Binding(get: { checked?.id ?? "" }, set: { id in if let o = options.first(where: { $0.id == id }) { model.pickModel(o) } })) {
        ForEach(options) { o in Text(verbatim: o.name).tag(o.id).disabled(!o.enabled) }
      }
      .labelsHidden().pickerStyle(.menu).fixedSize()
      .disabled(section?.reason != nil)
      .help(section?.reason ?? "")
    }
  }

  /// The driver's reasoning effort, lowest first; Auto when the driver has no default (Claude Code picks per model).
  private func effortRow(_ d: DriverInfo, _ levels: [String]) -> some View {
    SRow("Effort") {
      Picker("Effort", selection: Binding(get: { model.startEffort ?? EffortBars.auto }, set: { model.pickEffort($0 == EffortBars.auto ? nil : $0) })) {
        if d.effort == nil {
          Label { Text("Auto") } icon: { Image(systemName: "cellularbars", variableValue: 0.25) }.tag(EffortBars.auto)
        }
        ForEach(Array(levels.enumerated()), id: \.element) { i, l in
          Label { Text(verbatim: EffortBars.title(l)) } icon: { Image(systemName: "cellularbars", variableValue: EffortBars.value(i, of: levels.count)) }.tag(l)
        }
      }
      .labelsHidden().pickerStyle(.menu).fixedSize()
    }
  }

  /// The default place, as a popup of every place the daemon lists.
  private var placeRow: some View {
    SRow("Runs on") {
      Picker("Runs on", selection: Binding(get: { model.defaultPlace?.name ?? "" }, set: { model.setDefaultPlace($0) })) {
        if model.defaultPlace == nil { Text("None").tag("") }
        ForEach(model.sandboxes) { s in
          let d = model.descriptor(s.name)
          Label { Text(verbatim: d.map(\.displayTitle) ?? PlaceNames.menu(s)) } icon: { MenuMarks.place(d?.mark ?? s.name, kind: d?.kind) }.tag(s.name)
        }
      }
      .labelsHidden().pickerStyle(.menu).fixedSize()
    }
  }
}

/// One place on Runs: its kind's symbol and title (the Default badge), its provider under it; the one state that needs
/// action, else its own; a chevron. The whole row opens the place's page.
struct PlaceRow: View {
  @Environment(SettingsModel.self) private var model
  let place: SandboxInfo
  @State private var hover = false

  var body: some View {
    let d = model.descriptor(place.name)
    let title = model.placeTitle(place.name)
    let state = PlaceRow.state(model, place: place, descriptor: d)
    Button { model.go(.place(place.name)) } label: {
      HStack(spacing: ST.valueGap) {
        VStack(alignment: .leading, spacing: 1) {
          HStack(spacing: 6) {
            PlaceMark(kind: d?.kind ?? PlaceNames.kind(place.name)).foregroundStyle(ST.t2)
            Text(verbatim: title).font(ST.label).foregroundStyle(ST.t1)
            if model.defaultPlace?.name == place.name { DefaultBadge() }
          }
          Text(verbatim: d?.vendorName ?? PlaceNames.engine(place.name)).font(ST.sub).foregroundStyle(ST.t3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        if state.waiting { WaitingValue() } else { StatusValue(state.tone, state.text) }
        Image(systemName: "chevron.right").font(.system(size: 11, weight: .semibold)).foregroundStyle(ST.t4).accessibilityHidden(true)
      }
      .padding(.vertical, ST.rowPadV).padding(.horizontal, ST.rowPadH)
      .frame(minHeight: ST.rowMin)
      .background(hover ? Color.white.opacity(0.03) : .clear)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .accessibilityElement(children: .combine)
    .accessibilityLabel("\(title), \(state.text)")
    .accessibilityHint("Shows its environment, machines and safety.")
    .accessibilityIdentifier("settings-place-\(place.name)")
  }

  /// The row's one state: a hand-off waiting, the place not usable, its agent environment not ready, else its status.
  static func state(_ model: SettingsModel, place: SandboxInfo, descriptor d: SandboxDescriptor?) -> (tone: StatusDot.Kind?, text: String, waiting: Bool) {
    let name = place.name
    if model.handOffs.waiting(HandOffKey.placeSetup(name)) != nil || model.handOffs.waiting(HandOffKey.environment(name)) != nil
        || (d == nil && name == "boxd" && model.handOffs.waiting(HandOffKey.boxdKey) != nil) {
      return (nil, "Waiting for Terminal…", true)
    }
    if let d {
      let s = SandboxRows.status(d, place: place)
      if s.tone != .ok { return (s.tone.dot, s.text, false) }
    } else if !place.available {
      return (name == "boxd" ? .empty : .bad, PlaceNames.reason(place.reason) ?? (name == "boxd" ? "No boxd API key" : "Can't be used now"), false)
    }
    if let env = model.environmentRows?.first(where: { $0.sandbox == name }) {
      switch env.state {
      case .missing: return (.warn, "Agent environment not built", false)
      case .failed: return (.bad, "Agent environment failed", false)
      case .building: return (.empty, "Building agent environment", false)
      case .ready, .unknown: break
      }
    }
    if let d { let s = SandboxRows.status(d, place: place); return (s.tone.dot, s.text, false) }
    return (.ok, name == "docker" ? "Running" : "Ready", false)
  }
}

/// Marks drawn from SVG paths as images, for popup menus (which take images, not shapes). Template images are tinted
/// by the menu; a `color` keeps the brand's (Claude's coral).
@MainActor enum MenuMarks {
  private static var cache: [String: NSImage] = [:]
  static func image(_ key: String, path: Path, viewBox: CGFloat, size: CGFloat, color: NSColor? = nil) -> NSImage {
    let k = "\(key)-\(size)-\(color?.description ?? "t")"
    if let hit = cache[k] { return hit }
    let img = NSImage(size: NSSize(width: size, height: size), flipped: true) { rect in
      let s = rect.width / viewBox
      let p = path.applying(CGAffineTransform(scaleX: s, y: s))
      guard let ctx = NSGraphicsContext.current?.cgContext else { return false }
      ctx.addPath(p.cgPath)
      ctx.setFillColor((color ?? .black).cgColor)
      ctx.fillPath()
      return true
    }
    img.isTemplate = color == nil
    cache[k] = img
    return img
  }
  static func provider(_ p: Provider) -> Image {
    switch p {
    case .claude: Image(nsImage: image("claude", path: ProviderMarks.claude, viewBox: 24, size: 13, color: NSColor(Theme.Provider.claude)))
    case .codex: Image(nsImage: image("openai", path: ProviderMarks.openai, viewBox: 24, size: 13, color: nil))
    case .fx: Image(nsImage: image("fx", path: ProviderMarks.fx, viewBox: 24, size: 13, color: nil))
    case .other: Image(systemName: ProviderMarks.genericSymbol)
    }
  }
  /// A place's mark by its id (PlaceMarks): bundled marks, else a glyph by kind.
  static func place(_ mark: String, kind: SandboxDescriptor.Kind? = nil) -> Image {
    switch PlaceMarks.glyph(mark, kind: kind) {
    case .path(let id, let path): Image(nsImage: image(id, path: path, viewBox: 24, size: 13))
    case .symbol(let s): Image(systemName: s)
    }
  }
}
#endif
