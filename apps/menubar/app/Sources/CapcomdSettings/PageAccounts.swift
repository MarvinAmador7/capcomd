#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdUI

/// Accounts (SettingsSections.dc.html; States: a login needing you): each AI's login in each place, and the boxd key.
/// The login new runs need and don't have gets the prominent Log In… (and the amber count on the sidebar's row).
struct AccountsPage: View {
  @Environment(SettingsModel.self) private var model

  var body: some View {
    let live = model.connection.live
    let rows = model.loginRows
    SPage {
      ForEach(SettingsRows.providers, id: \.self) { provider in
        let mine = rows.filter { $0.provider == provider }
        if !mine.isEmpty {
          SGroup(id: "accounts.\(provider)") {
            HStack(spacing: 6) {
              ProviderHeaderMark(provider: provider)
              Text(verbatim: PlaceNames.provider(provider))
            }
          } content: {
            ForEach(Array(mine.enumerated()), id: \.element.id) { i, r in
              if i > 0 { SSep() }
              LoginRowView(row: r)
            }
          } foot: {
            if let w = mine.lazy.compactMap({ model.handOffs.waiting(HandOffKey.login($0)) }).first { OpenedFoot(command: w.command) }
          }
          .disabled(!live)
        }
      }

      SGroup("boxd", id: "accounts.boxd") { boxdKeyRow } foot: {
        if let w = model.handOffs.waiting(HandOffKey.boxdKey) { OpenedFoot(command: w.command) }
        SFoot(verbatim: "Log In… opens Terminal with the command ready. Each place keeps its own login.")
        if model.store.logins == .unavailable(.unsupported), rows.contains(where: { $0.state == .unknown }) {
          SFoot(verbatim: "Update capcomd to see every login here.")
        }
        if !live { SFoot(verbatim: "Shown when capcomd is running.") }
      }
      .disabled(!live)
    }
  }

  @ViewBuilder private var boxdKeyRow: some View {
    let state = model.boxdKey
    let waiting = model.handOffs.waiting(HandOffKey.boxdKey) != nil
    let setUp = { _ = model.handOff(HandOffKey.boxdKey, command: SettingsRows.boxdKeyCommand, baseline: "\(state)") }
    SRow("API key") {
      if waiting {
        WaitingValue()
        Button("Show Terminal") { TerminalLauncher.showTerminal() }
      } else {
        switch state {
        case .saved:
          StatusValue(.ok, "Saved in your keychain")
          Button("Change…") { setUp() }.accessibilityHint("Opens Terminal to change the boxd API key.")
        case .notSet:
          StatusValue(.empty, "Not set")
          Button("Set Up…") { setUp() }.prominent().accessibilityHint("Opens Terminal to set the boxd API key.")
        case .unknown:
          StatusValue(.empty, "Unknown")
          Button("Set Up…") { setUp() }.accessibilityHint("Opens Terminal to set the boxd API key.")
        }
      }
    }
  }
}

/// One AI's login in one place: "Local" over "Docker", its state, Log In… (States: "Logging in").
struct LoginRowView: View {
  @Environment(SettingsModel.self) private var model
  let row: LoginRow

  var body: some View {
    let place = PlaceNames.title(row.sandbox), ai = PlaceNames.provider(row.provider)
    let waiting = model.handOffs.waiting(HandOffKey.login(row)) != nil
    SRow {
      SLabel(title: place, sub: PlaceNames.engine(row.sandbox))
    } value: {
      if waiting {
        WaitingValue()
        Button("Show Terminal") { TerminalLauncher.showTerminal() }
      } else {
        value.help(row.detail ?? "")
        let button = Button(row.isLoggedIn ? "Log In Again…" : "Log In…") {
          model.handOff(HandOffKey.login(row), command: row.command, baseline: row.fingerprint)
        }
        .accessibilityLabel(row.isLoggedIn ? "Log in to \(ai) on \(place) again" : "Log in to \(ai) on \(place)")
        .accessibilityHint("Opens Terminal to log in.")
        if model.neededLogin?.id == row.id { button.prominent() } else { button }
      }
    }
  }

  @ViewBuilder private var value: some View {
    switch row.state {
    case .plan: StatusValue(.ok, "Logged in with your \(PlaceNames.plan(row.provider)) plan")
    case .apiKey: StatusValue(.ok, "Using an API key")
    case .loggedIn: StatusValue(.ok, "Logged in")
    case .notLoggedIn: StatusValue(.empty, "Not logged in")
    case .unknown: StatusValue(.empty, "Unknown")
    }
  }
}
#endif
