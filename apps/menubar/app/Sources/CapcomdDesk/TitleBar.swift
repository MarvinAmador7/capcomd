#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot
import CapcomdUI

/// The title bar (ReelStack, ReelTabs, Home): Home, then the open project as one group with its crew tabs, every other
/// project folded into a deck, and on the right Follow, Actions (⌘K) and + (Home with the composer focused). While Home
/// shows every project is a deck and Home stays pressed. Each piece reads only its own slice.
struct TitleBar: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("TitleBar")
    return HStack(spacing: 8) {
      // Home moved to the rail (C folded); the sidebar button takes its place, where the opened sidebar has it too.
      SidebarToggleButton(on: false)
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(model.decks) { deck in
            if deck.id == model.openProjectId && model.newProject == nil { OpenGroup(deck: deck) } else { FoldedDeck(deck: deck) }
          }
        }
        .padding(.vertical, 6)
      }
      .modifier(KeepBracketInView())
      Spacer(minLength: 0)
      OfflineBadge()
      FollowButton()
      ActionsButton()
      NewProjectButton()
    }
    .padding(.leading, Theme.Desk.titleLeading).padding(.trailing, 10)
    .frame(height: Theme.Desk.titleBar)
  }
}

/// The bracket stays in view: when the reel's on-screen columns change, the strip scrolls the least it can to show the
/// tab on the side the reel moved toward. (ScrollViewReader's scrollTo, issued while the reel's own hosting view updates, only took
/// effect on this view's next update: a jump later.)
struct KeepBracketInView: ViewModifier {
  func body(content: Content) -> some View {
    if #available(macOS 15, *) { content.modifier(Follow()) } else { content }
  }
  @available(macOS 15, *)
  struct Follow: ViewModifier {
    @Environment(DeskModel.self) private var model
    @State private var position = ScrollPosition(idType: String.self)
    func body(content: Content) -> some View {
      content
        .scrollPosition($position)
        .onChange(of: model.reelPosition) { old, new in
          let seen = model.onScreen, cols = model.columns
          guard let first = cols.first(where: seen.contains), let last = cols.last(where: seen.contains) else { return }
          let right = (new.flatMap { cols.firstIndex(of: $0) } ?? 0) >= (old.flatMap { cols.firstIndex(of: $0) } ?? 0)
          // No anchor: the least scroll that shows it (pinning the first tab to the leading edge hid the project name).
          // Back at the first column, the whole group shows again, project name included.
          withAnimation(.easeOut(duration: 0.18)) {
            if first == cols.first { position.scrollTo(edge: .leading) } else { position.scrollTo(id: right ? last : first) }
          }
        }
    }
  }
}

/// The first and last on-screen tabs' bounds, for the bracket.
struct BracketBounds: PreferenceKey {
  static let defaultValue: [Anchor<CGRect>] = []
  static func reduce(value: inout [Anchor<CGRect>], nextValue: () -> [Anchor<CGRect>]) { value += nextValue() }
}

/// The open project: its name, then its crew in tree order, with the on-screen columns bracketed.
struct OpenGroup: View {
  @Environment(DeskModel.self) private var model
  let deck: DeckInfo
  var body: some View {
    DeskProbe.body("OpenGroup")
    let cols = model.columns, seen = model.onScreen
    let first = cols.firstIndex(where: seen.contains) ?? -1, last = cols.lastIndex(where: seen.contains) ?? -1
    return HStack(spacing: 2) {
      // The name opens the project's menu (ReelMenu).
      Button { model.toggleMenu() } label: {
        HStack(spacing: 0) {
          PlaceIcon(sandbox: deck.sandbox).padding(.trailing, 6)
          Text(verbatim: deck.title).font(Theme.Desk.name).foregroundStyle(Theme.Desk.text).lineLimit(1)
            .frame(maxWidth: 200, alignment: .leading).fixedSize()
          Image(systemName: "chevron.down").font(.system(size: 8, weight: .bold)).foregroundStyle(Theme.Desk.secondary)
            .padding(.leading, 6)
        }
        .padding(.trailing, 8).frame(height: Theme.Desk.groupHeight - 4)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .help("Project menu")
      .accessibilityLabel("\(deck.title), project menu")
      // One row of tabs whose identity never changes as the reel scrolls; the bracket is drawn behind the on-screen
      // ones from their bounds, so moving it re-lays out one shape instead of rebuilding tabs.
      HStack(spacing: 2) {
        ForEach(Array(cols.enumerated()), id: \.element) { n, id in
          CrewTab(agentId: id)
            .anchorPreference(key: BracketBounds.self, value: .bounds) { n == first || n == last ? [$0] : [] }
        }
      }
      .scrollTargetLayout()   // the tabs are what the strip scrolls to (KeepBracketInView)
      .backgroundPreferenceValue(BracketBounds.self) { anchors in
        GeometryReader { g in
          if let r = anchors.map({ g[$0] }).reduce(nil, { ($0 ?? $1).union($1) }) {
            RoundedRectangle(cornerRadius: Theme.Desk.tabRadius + 2, style: .continuous)
              .fill(Theme.Desk.bracketFill)
              .overlay(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius + 2, style: .continuous).strokeBorder(Theme.Desk.bracketStroke, lineWidth: 0.5))
              .frame(width: r.width + 4, height: r.height + 4)
              .offset(x: r.minX - 2, y: r.minY - 2)
          }
        }
      }
    }
    .padding(.leading, 12).padding(.trailing, 4)
    .frame(height: Theme.Desk.groupHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).fill(Theme.Desk.groupFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).strokeBorder(Theme.Desk.groupStroke, lineWidth: 0.5))
    .anchorPreference(key: ProjectGroupBounds.self, value: .bounds) { $0 }
  }
}

/// Where a project runs, as the menu bar's Local / Cloud switch shows it. A place this app doesn't know shows nothing.
enum Place {
  case local, cloud
  init?(sandbox: String?) {
    switch sandbox { case "docker"?, "fake-host"?: self = .local; case "boxd"?: self = .cloud; default: return nil }
  }
  var word: String { self == .local ? "Local" : "Cloud" }
  var symbol: String { self == .local ? "laptopcomputer" : "cloud" }
}

struct PlaceIcon: View {
  let sandbox: String?
  var body: some View {
    if let p = Place(sandbox: sandbox) {
      Image(systemName: p.symbol).font(.system(size: 13, weight: .regular)).foregroundStyle(Color(white: 0.78))
        .accessibilityLabel(p.word)
    }
  }
}

/// One agent's tab: its head and its title (capability agents.title; an older daemon's: the suffix, else the profile);
/// amber when it asks, dim while queued. A click scrolls the reel to it; a double-click renames it in place. A long
/// title ends with "…" at a fixed width, so the strip doesn't move as titles change.
struct CrewTab: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    let _ = DeskProbe.body("CrewTab", id: agentId)
    if let a = model.agent(agentId) {
      let h = a.header, asks = a.approval != nil
      Button { model.closeNeedsReel(); model.scroll(to: agentId) } label: {
        HStack(spacing: 5) {
          BotAvatar(traits: a.bot, size: .xs, cell: 1.5)
          if a.renaming == .tab {
            InlineTitleField(agentId: agentId, font: Theme.Desk.label, width: Theme.Desk.tabTitleMax)
          } else {
            Text(verbatim: h.tabLabel).font(Theme.Desk.label).lineLimit(1).truncationMode(.tail)
              .frame(maxWidth: Theme.Desk.tabTitleMax, alignment: .leading).fixedSize(horizontal: true, vertical: false)
          }
          if asks { Text("asks").font(Theme.Desk.label).foregroundStyle(Theme.amber) }
        }
        .foregroundStyle(asks || a.onScreen ? Theme.Desk.text : Theme.Desk.secondary)
        .padding(.leading, 4).padding(.trailing, 9)
        .frame(height: Theme.Desk.tabHeight)
        .background(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius, style: .continuous).fill(asks ? Theme.Desk.askFill : .clear))
        .overlay(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius, style: .continuous).strokeBorder(asks ? Theme.Desk.askStroke : .clear, lineWidth: 1))
        .opacity(h.status == .pending ? 0.6 : 1)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .simultaneousGesture(TapGesture(count: 2).onEnded { model.beginRename(agentId, at: .tab) })
      .help(a.renameFailure.map { "Couldn't rename it: \($0)" } ?? h.label)
      .accessibilityLabel([h.label, asks ? "asks" : nil].compactMap { $0 }.joined(separator: " "))
      .accessibilityAction(named: "Rename") { model.beginRename(agentId, at: .tab) }
    }
  }
}

/// A folded project: its name, then its crew's heads stacked. Amber, and who asks under the name, when an agent in it asks.
struct FoldedDeck: View {
  @Environment(DeskModel.self) private var model
  let deck: DeckInfo
  var body: some View {
    DeskProbe.body("FoldedDeck")
    let asks = deck.askingAgentId != nil
    return Button { model.open(project: deck.id) } label: {
      HStack(spacing: 9) {
        PlaceIcon(sandbox: deck.sandbox)
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: deck.title).font(Theme.Desk.label).foregroundStyle(Theme.Desk.text).lineLimit(1)
          if asks, let who = deck.askingName { Text(verbatim: "\(who) asks").font(Theme.Desk.meta).foregroundStyle(Theme.amber) }
        }
        .frame(maxWidth: 150, alignment: .leading)
        HStack(spacing: -Theme.Desk.deckHeadOverlap) {
          ForEach(model.heads(deck).prefix(5), id: \.self) { t in
            BotAvatar(traits: t, size: .xs, cell: 1.5)
              .frame(width: Theme.Desk.deckHead, height: Theme.Desk.deckHead)
              .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color(white: 0.15)))
              .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.Desk.ground, lineWidth: 1.5))
          }
        }
      }
      .padding(.horizontal, 10)
      .frame(height: Theme.Desk.groupHeight)
      .background(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).fill(Theme.Desk.deckFill))
      .overlay(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).strokeBorder(asks ? Theme.Desk.askStroke : .clear, lineWidth: 1))
      .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(deck.title + (asks ? ", \(deck.askingName ?? "an agent") asks" : ""))
  }
}

/// The daemon's feed dropped: what the window shows is as of then, until it reconnects (by itself).
struct OfflineBadge: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    if model.unreachable, model.openRunId != nil {   // with nothing read, the window itself says so
      Label("Can't reach capcomd", systemImage: "bolt.horizontal.circle")
        .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.amber)
        .padding(.horizontal, 10).frame(height: Theme.Desk.iconButton)
        .help("The window shows what it last read; it reconnects by itself when capcomd is back.")
    }
  }
}

struct FollowButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    @Bindable var m = model
    Toggle(isOn: $m.follow) {
      Label("Follow", systemImage: "eye").font(.system(size: 12, weight: .medium))
    }
    .toggleStyle(.button).buttonStyle(.plain)
    .padding(.horizontal, 10).frame(height: Theme.Desk.iconButton)
    .foregroundStyle(model.follow ? Color(red: 0x6C / 255, green: 0xB4 / 255, blue: 1) : Theme.Desk.tertiary)
    .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(model.follow ? Theme.accent.opacity(0.16) : .clear))
    .help("Follow: an ask or a failure scrolls the reel to it (⇧⌘F)")
  }
}

/// Actions (⌘K): the palette.
struct ActionsButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    Button { model.togglePalette() } label: {
      Image(systemName: "command").font(.system(size: 13, weight: .regular))
        .foregroundStyle(model.paletteOpen ? Theme.Desk.text : Theme.Desk.tertiary)
        .frame(width: Theme.Desk.iconButton, height: Theme.Desk.iconButton)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(model.paletteOpen ? Color.white.opacity(0.10) : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .help("Actions (⌘K)")
    .accessibilityLabel("Actions")
  }
}

/// + (⇧⌘N): Home, with the composer focused.
struct NewProjectButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    Button { model.openNewProject() } label: {
      Image(systemName: "plus").font(.system(size: 13, weight: .regular))
        .foregroundStyle(Theme.Desk.tertiary)
        .frame(width: Theme.Desk.iconButton, height: Theme.Desk.iconButton)
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .help("New project (⇧⌘N)")
    .accessibilityLabel("New project")
  }
}

/// Home (⌘0), before the projects: pressed while Home shows; pressed again, back to the open project.
struct HomeButton: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    let on = model.homeShown
    Button { model.toggleHome() } label: {
      HouseGlyph().stroke(style: StrokeStyle(lineWidth: 1.3, lineJoin: .round))
        .frame(width: 15, height: 15)
        .foregroundStyle(on ? Theme.Desk.text : Theme.Desk.tertiary)
        .frame(width: Theme.Desk.iconButton, height: Theme.Desk.iconButton)
        .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(on ? Color.white.opacity(0.10) : .clear))
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .help("Home (⌘0)")
    .accessibilityLabel("Home").accessibilityAddTraits(on ? .isSelected : [])
  }
}

/// The prototype's house (a 16-unit path: roof, walls and door).
struct HouseGlyph: Shape {
  func path(in r: CGRect) -> Path {
    let s = r.width / 16
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: r.minX + x * s, y: r.minY + y * s) }
    var path = Path()
    path.move(to: p(2.5, 7.2)); path.addLine(to: p(8, 2.8)); path.addLine(to: p(13.5, 7.2)); path.addLine(to: p(13.5, 13.5))
    path.addLine(to: p(9.6, 13.5)); path.addLine(to: p(9.6, 10)); path.addLine(to: p(6.4, 10)); path.addLine(to: p(6.4, 13.5))
    path.addLine(to: p(2.5, 13.5)); path.closeSubpath()
    return path
  }
}
#endif
