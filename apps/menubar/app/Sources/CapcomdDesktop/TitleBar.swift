#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot
import CapcomdUI

/// The title bar (ReelStack, ReelTabs): the open project as one group with its crew tabs, every other project folded
/// into a deck, and Follow on the right. Each piece reads only its own slice.
struct TitleBar: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    HStack(spacing: 8) {
      ScrollView(.horizontal, showsIndicators: false) {
        HStack(spacing: 8) {
          ForEach(model.decks) { deck in
            if deck.id == model.openProjectId { OpenGroup(deck: deck) } else { FoldedDeck(deck: deck) }
          }
        }
        .padding(.vertical, 6)
      }
      Spacer(minLength: 0)
      FollowButton()
    }
    .padding(.leading, Theme.Desk.titleLeading).padding(.trailing, 10)
    .frame(height: Theme.Desk.titleBar)
  }
}

/// The open project: its name and clock, then its crew in tree order, with the on-screen columns bracketed.
struct OpenGroup: View {
  @Environment(DeskModel.self) private var model
  let deck: DeckInfo
  var body: some View {
    let cols = model.columns, seen = model.onScreen
    let first = cols.firstIndex(where: seen.contains), last = cols.lastIndex(where: seen.contains)
    HStack(spacing: 2) {
      PlaceIcon(sandbox: deck.sandbox).padding(.trailing, 6)
      VStack(alignment: .leading, spacing: 1) {
        Text(verbatim: deck.title).font(Theme.Desk.name).foregroundStyle(Theme.Desk.text).lineLimit(1)
        DeckClock(deck: deck)
      }
      .frame(maxWidth: 200, alignment: .leading)
      .padding(.trailing, 8)
      if let first, let last {
        ForEach(cols[..<first], id: \.self) { CrewTab(agentId: $0) }
        HStack(spacing: 2) { ForEach(cols[first...last], id: \.self) { CrewTab(agentId: $0) } }
          .padding(2)
          .background(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius + 2, style: .continuous).fill(Theme.Desk.bracketFill))
          .overlay(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius + 2, style: .continuous).strokeBorder(Theme.Desk.bracketStroke, lineWidth: 0.5))
          .accessibilityElement(children: .contain).accessibilityLabel("On screen")
        ForEach(cols[(last + 1)...], id: \.self) { CrewTab(agentId: $0) }
      } else {
        ForEach(cols, id: \.self) { CrewTab(agentId: $0) }
      }
    }
    .padding(.leading, 12).padding(.trailing, 4)
    .frame(height: Theme.Desk.groupHeight)
    .background(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).fill(Theme.Desk.groupFill))
    .overlay(RoundedRectangle(cornerRadius: Theme.Desk.groupRadius, style: .continuous).strokeBorder(Theme.Desk.groupStroke, lineWidth: 0.5))
  }
}

/// The run's clock: elapsed while it runs (drawn by the system each second, no re-render), its duration once ended.
struct DeckClock: View {
  let deck: DeckInfo
  var body: some View {
    HStack(spacing: 0) {
      if let p = Place(sandbox: deck.sandbox) { Text(verbatim: p.word + " · ") }
      if let start = deck.startedAtMs, deck.endedAtMs == nil {
        Text(Date(timeIntervalSince1970: Double(start) / 1000), style: .timer)
      } else if let start = deck.startedAtMs, let end = deck.endedAtMs {
        Text(verbatim: Duration.milliseconds(end - start).formatted(.time(pattern: .minuteSecond)))
      }
    }
    .font(Theme.Desk.mono).foregroundStyle(Theme.Desk.tertiary).monospacedDigit()
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

/// One agent's tab: its head and short name; amber when it asks, dim while queued. A click scrolls the reel to it.
struct CrewTab: View {
  @Environment(DeskModel.self) private var model
  let agentId: String
  var body: some View {
    if let a = model.agent(agentId) {
      let h = a.header, asks = a.approval != nil
      Button { model.scroll(to: agentId) } label: {
        HStack(spacing: 5) {
          BotAvatar(traits: a.bot, size: .xs, cell: 1.5)
          Text(verbatim: h.suffix ?? h.name).font(Theme.Desk.label)
          if asks { Text("asks").font(Theme.Desk.label).foregroundStyle(Theme.amber) }
        }
        .foregroundStyle(asks || model.onScreen.contains(agentId) ? Theme.Desk.text : Theme.Desk.secondary)
        .padding(.leading, 4).padding(.trailing, 9)
        .frame(height: Theme.Desk.tabHeight)
        .background(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius, style: .continuous).fill(asks ? Theme.Desk.askFill : .clear))
        .overlay(RoundedRectangle(cornerRadius: Theme.Desk.tabRadius, style: .continuous).strokeBorder(asks ? Theme.Desk.askStroke : .clear, lineWidth: 1))
        .opacity(h.status == .pending ? 0.6 : 1)
        .contentShape(Rectangle())
      }
      .buttonStyle(PressableStyle())
      .accessibilityLabel([h.name, h.suffix, asks ? "asks" : nil].compactMap { $0 }.joined(separator: " "))
    }
  }
}

/// A folded project: its name and one status line, then its crew's heads stacked. Amber when an agent in it asks.
struct FoldedDeck: View {
  @Environment(DeskModel.self) private var model
  let deck: DeckInfo
  var body: some View {
    let asks = deck.askingAgentId != nil
    Button { model.open(project: deck.id) } label: {
      HStack(spacing: 9) {
        PlaceIcon(sandbox: deck.sandbox)
        VStack(alignment: .leading, spacing: 1) {
          Text(verbatim: deck.title).font(Theme.Desk.label).foregroundStyle(Theme.Desk.text).lineLimit(1)
          if asks, let who = deck.askingName { Text(verbatim: "\(who) asks").font(Theme.Desk.meta).foregroundStyle(Theme.amber) }
          else { DeckClock(deck: deck) }
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
#endif
