#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot
import CapcomdUI

// Team in the opened sidebar (CrewProfile's `.sb`): with the Team button pressed, the list is the roster by project
// instead of the agents: one quiet label per project (as the agents' project labels), its profiles under it, then "All
// projects" for the user's own. A row: the profile's bot, its name, its role word.

/// The Team button: in the sidebar's foot (beside Home, History, Settings) and on the folded rail, where it opens the
/// sidebar on the roster. Pressed while Team shows; disabled on a daemon that doesn't list profiles.
struct TeamButton: View {
  @Environment(DeskModel.self) private var model
  var size: CGFloat = Theme.Desk.Side.button
  var body: some View {
    let available = model.team.available
    SideButton(symbol: "person.2", on: model.team.isOpen, help: available ? PlaceButton.team.help : "Team (this capcomd doesn't list profiles)",
               label: "Team", size: size) { model.toggleTeam() }
      .disabled(!available).opacity(available ? 1 : 0.5)
  }
}

/// The roster: a label per project and the user's own, a row per profile. ↑ ↓ move the selection (the pane follows).
struct TeamRosterList: View {
  @Environment(DeskModel.self) private var model
  @FocusState private var focused: Bool
  var body: some View {
    DeskProbe.body("TeamRoster")
    let t = model.team
    let selected = t.selectedKey, visible = t.visibleKeys
    return ScrollView(.vertical) {
      VStack(alignment: .leading, spacing: 0) {
        ForEach(Array(t.roster.enumerated()), id: \.element.id) { i, g in
          TeamGroupLabel(title: g.title, everywhere: g.everywhere, first: i == 0)
          ForEach(g.members) { m in
            TeamRow(member: m, selected: m.id == selected, visible: visible.contains(m.id)).equatable()
          }
        }
      }
      .padding(.bottom, 8)
    }
    .scrollIndicators(.automatic)
    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    .focusable()
    .focusEffectDisabled()
    .focused($focused)
    .onKeyPress(.upArrow) { model.moveTeamSelection(-1); return .handled }
    .onKeyPress(.downArrow) { model.moveTeamSelection(1); return .handled }
    .task(id: model.nav.listFocus) { if model.nav.listFocus > 0 && model.team.isOpen { focused = true } }
    .onChange(of: model.team.isOpen) { _, open in if !open { focused = false } }
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Team, by project")
  }
}

/// A project's label (the agents sidebar's project label: 24 pt, 11.5 pt semibold, tertiary), or "All projects" with
/// the stacked layers.
struct TeamGroupLabel: View {
  let title: String
  let everywhere: Bool
  let first: Bool
  var body: some View {
    HStack(spacing: 6) {
      Image(systemName: everywhere ? Theme.Desk.Team.allProjects : Theme.Desk.Team.projectGlyph)
        .font(.system(size: 10, weight: .medium)).foregroundStyle(Theme.Desk.tertiary).frame(width: 13)
      Text(verbatim: title).font(Theme.Desk.Side.labelFont).foregroundStyle(Theme.Desk.tertiary).lineLimit(1).truncationMode(.tail)
      Spacer(minLength: 0)
    }
    .padding(.horizontal, 8)
    .frame(height: SidebarMetrics.label)
    .padding(.top, first ? 2 : 14)
    .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
  }
}

/// One profile: its bot in an 18 pt box, its name (its title, else its profile name), the role word. Selected: the pill;
/// shown in another split: the faint tint. ⌘-click opens it beside the focused pane.
struct TeamRow: View, Equatable {
  @Environment(DeskModel.self) private var model
  let member: TeamMember
  let selected: Bool
  let visible: Bool
  @State private var hover = false
  static func == (a: Self, b: Self) -> Bool { a.member == b.member && a.selected == b.selected && a.visible == b.visible }
  var body: some View {
    DeskProbe.body("TeamRow", id: member.id)
    let bot = model.team.bot(name: member.name, role: member.role, seed: member.avatarSeed)
    return Button {
      model.showProfile(member.id, split: NSEvent.modifierFlags.contains(.command))
    } label: {
      HStack(spacing: 8) {
        BotAvatar(traits: bot, size: .xs, cell: 1).frame(width: Theme.Desk.Team.rowBot, height: Theme.Desk.Team.rowBot)
          .opacity(member.ready ? 1 : 0.55)
        Text(verbatim: member.title).font(Theme.Desk.Side.rowFont)
          .foregroundStyle(selected || hover ? Theme.Desk.text : Theme.Desk.Side.row)
          .lineLimit(1).truncationMode(.tail)
          .frame(maxWidth: .infinity, alignment: .leading)
        Text(verbatim: member.role.rawValue).font(Theme.Desk.Side.wordFont).foregroundStyle(Theme.Desk.tertiary)
          .padding(.trailing, 4).fixedSize()
      }
      .padding(.leading, 8).padding(.trailing, 4)
      .frame(height: SidebarMetrics.row)
      .background(RoundedRectangle(cornerRadius: 8, style: .continuous)
        .fill(selected ? Theme.Desk.Side.selected : hover ? Theme.Desk.Side.hover : visible ? Theme.Desk.Side.visible : .clear))
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .onHover { hover = $0 }
    .help(member.ready ? member.name : [member.name, member.readiness].compactMap { $0 }.joined(separator: ": "))
    .accessibilityLabel("\(member.title), \(member.role.rawValue)")
    .accessibilityAddTraits(selected ? .isSelected : [])
    .accessibilityAction(named: "Open in Split") { model.showProfile(member.id, split: true) }
  }
}
#endif
