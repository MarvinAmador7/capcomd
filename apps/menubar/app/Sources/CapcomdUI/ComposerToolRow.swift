#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore

// The new-project composer's tool row and folder chip, as the menu bar's composer board draws them, shared by the menu
// bar panel (StartProjectField) and the window's Home (CapcomdDesk). Each takes data and actions only: what the menus
// offer and where a pick goes stay with the composer that hosts them. With SendCircle and Chip2 (ComposerParts.swift).

/// The round + : a filled 30 pt circle that opens `items`.
package struct ComposerAddMenu<Items: View>: View {
  let label: String
  let items: Items
  package init(label: String = "Add", @ViewBuilder items: () -> Items) { self.label = label; self.items = items() }
  package var body: some View {
    Menu { items } label: {
      Image(systemName: "plus").font(Theme.Composer2.plusFont).foregroundStyle(.white)
        .frame(width: Theme.Composer2.round, height: Theme.Composer2.round)
        .background(Circle().fill(Theme.Composer2.roundFill)).overlay(Circle().strokeBorder(Theme.Composer2.roundStroke, lineWidth: 0.5))
        .contentShape(Circle())
    }
    .menuStyle(.button).buttonStyle(.plain).menuIndicator(.hidden).fixedSize()
    .accessibilityLabel(label)
  }
}

/// Where the run's agents work (owner's reference: the Web · Computer · Files group): Local (Docker on this Mac) or
/// Cloud (boxd), as the daemon offers them, icons only (owner's call; the name is the tooltip and what VoiceOver reads).
/// The picked one is a raised capsule; one that can't be used now is dimmed, with its reason. Absent with one place.
package struct ComposerPlaceSwitch: View {
  @Environment(\.accessibilityReduceMotion) private var reduceMotion
  let places: [SandboxInfo]
  let current: String?
  let pick: (String) -> Void
  package init(places: [SandboxInfo], current: String?, pick: @escaping (String) -> Void) {
    self.places = places; self.current = current; self.pick = pick
  }
  /// A place's glyph: the cloud for boxd, the laptop for anything on this Mac.
  package static func symbol(_ name: String) -> String { name == "boxd" ? "cloud" : "laptopcomputer" }

  package var body: some View {
    if let current, places.count > 1 {
      HStack(spacing: Theme.Composer2.segmentGap) {
        ForEach(places) { s in
          let on = s.name == current
          Button { pick(s.name) } label: {
            Image(systemName: Self.symbol(s.name)).font(Theme.Composer2.segmentIcon)
              .foregroundStyle(on ? Color.white : Theme.Composer2.pillText)
              .frame(width: Theme.Composer2.segmentWidth, height: Theme.Composer2.pillHeight)
              .background {
                if on {
                  Capsule().fill(Theme.Composer2.segmentOn)
                    .overlay(Capsule().strokeBorder(Theme.Composer2.segmentOnStroke, lineWidth: 0.5))
                    .shadow(color: Theme.Composer2.segmentShadow, radius: 2, y: 1)
                }
              }
              .contentShape(Capsule())
          }
          .buttonStyle(PressableStyle()).disabled(!s.available).opacity(s.available ? 1 : Theme.Composer2.segmentOffOpacity)
          .help(s.available ? (s.name == "boxd" ? "\(s.label): agents run on boxd machines" : "\(s.label): agents run in Docker on this Mac")
                            : "\(s.label): \(s.reason ?? "unavailable")")
          .accessibilityLabel(s.label).accessibilityAddTraits(on ? .isSelected : [])
        }
      }
      .padding(Theme.Composer2.pillGroupPadding).background(Capsule().fill(Theme.Composer2.pillGroupFill))
      .fixedSize()
      // The raised capsule crossfades to the new pick (opacity only).
      .animation(reduceMotion ? Theme.Motion.reduced : Theme.Motion.fast, value: current)
      .accessibilityElement(children: .contain).accessibilityLabel("Where it runs")
    }
  }
}

/// The driver chip's face: the provider's mark in its colour, the planner's model (or the driver's name), the effort as
/// signal bars when one is picked (none for Auto), a chevron. Dimmed, the mark grey, when no driver can run here.
/// The composer wraps it in its own menu (the panel's native menu, the window's model menu).
package struct DriverChipLabel: View {
  let provider: Provider?
  let text: String
  /// The picked effort's place among the driver's levels; nil: Auto, or a driver whose effort can't be set.
  let effort: (level: Int, of: Int)?
  let available: Bool
  package init(provider: Provider?, text: String, effort: (level: Int, of: Int)?, available: Bool) {
    self.provider = provider; self.text = text; self.effort = effort; self.available = available
  }
  package var body: some View {
    Chip2(leading: Group {
            if let provider {
              ProviderMark(provider: provider, size: Theme.Provider.chipMark)
                .foregroundStyle(available ? ProviderMarks.badgeTint(provider) : Theme.Composer2.chipX)
            }
          },
          text: text, chevron: true, onRemove: nil,
          trailing: available ? effort.map { AnyView(EffortBars(level: $0.level, of: $0.of)) } : nil)
      .opacity(available ? 1 : Theme.Composer2.unavailableOpacity)
  }
}

/// Where the run goes, as a chip: a picked folder being looked at or set up (its name, a spinner or the orange "not
/// set up" dot; × cancels), the remembered project checkout (× goes back to the default project), or the daemon's
/// default project (a click chooses a folder).
package struct ComposerFolderChip: View {
  package enum Where: Equatable {
    case settingUp(name: String, path: String, loading: Bool)
    case checkout(path: String)
    case defaultProject
  }
  let place: Where
  let remove: () -> Void
  let choose: () -> Void
  package init(_ place: Where, remove: @escaping () -> Void, choose: @escaping () -> Void) {
    self.place = place; self.remove = remove; self.choose = choose
  }
  package var body: some View {
    switch place {
    case .settingUp(let name, let path, let loading):
      Chip2(leading: AnyView(Image(systemName: "folder").font(.system(size: 11))), text: name, onRemove: remove,
            trailing: AnyView(Group {
              if loading { ProgressView().controlSize(.mini).frame(width: Theme.Setup.spinner, height: Theme.Setup.spinner).accessibilityLabel("Looking at the folder") }
              else { SetupDot() }
            }))
        .fixedSize().help(path)
    case .checkout(let path):
      Chip2(icon: "folder", text: (path as NSString).lastPathComponent, onRemove: remove).fixedSize().help(path)
    case .defaultProject:
      Button(action: choose) { Chip2(icon: "folder", text: "Default project", onRemove: nil) }
        .buttonStyle(PressableStyle()).fixedSize().help("capcomd's default project; click to choose a checkout")
    }
  }
}

/// The mic: hands the goal field the keyboard (`focus`) and starts macOS dictation into it (Edit › Start Dictation),
/// until the app has voice input of its own.
package struct ComposerMicButton: View {
  let focus: () -> Void
  package init(focus: @escaping () -> Void) { self.focus = focus }
  package var body: some View {
    Button {
      focus()
      DispatchQueue.main.async { NSApp.sendAction(Selector(("startDictation:")), to: nil, from: nil) }
    } label: {
      Image(systemName: "mic").font(Theme.Composer2.micFont).foregroundStyle(Theme.Composer2.micText)
        .frame(width: Theme.Composer2.round, height: Theme.Composer2.round).contentShape(Circle())
    }
    .buttonStyle(PressableStyle())
    .help("Dictate")
    .accessibilityLabel("Dictate the goal")
  }
}
#endif
