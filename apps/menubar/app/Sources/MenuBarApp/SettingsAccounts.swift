#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot

/// Settings › Accounts (Accounts.dc.html; States: logging in, reset the app token): who the agents act as in each
/// place, the boxd key, and this app's own token.
struct AccountsPane: View {
  @Environment(AppModel.self) private var model
  @State private var confirmReset = false
  @State private var sheet: SheetKind?
  enum SheetKind: Identifiable { case paste, afterReset; var id: Self { self } }

  var body: some View {
    let live = model.connection.live
    let rows = model.loginRows
    Form {
      ForEach(Array(SettingsRows.providers.enumerated()), id: \.element) { i, provider in
        let mine = rows.filter { $0.provider == provider }
        Section {
          ForEach(mine) { LoginRowView(row: $0) }
        } header: {
          HStack(spacing: Theme.Settings.headerGap) {
            ProviderHeaderMark(provider: provider)
            Text(verbatim: PlaceNames.provider(provider))
          }
        } footer: {
          VStack(alignment: .leading, spacing: 4) {
            if let w = mine.lazy.compactMap({ model.handOffs.waiting(HandOffKey.login($0)) }).first { OpenedFoot(command: w.command) }
            if i == SettingsRows.providers.count - 1 {
              Foot(verbatim: "Log In opens Terminal with the command ready, so your login never passes through this app. Each place agents run keeps its own login. On Cloud, a login is kept as a boxd secret that only works on its AI's API (api.anthropic.com, api.openai.com), so it can't be sent anywhere else.")
              if model.store.logins == .unavailable(.unsupported), rows.contains(where: { $0.state == .unknown }) {
                Foot(verbatim: "Update capcomd to see every login here.")
              }
            }
            if !live { Foot(verbatim: "Shown when capcomd is running.") }
          }
        }
        .disabled(!live)
      }

      Section {
        boxdKeyRow
      } header: {
        Text("boxd")
      } footer: {
        VStack(alignment: .leading, spacing: 4) {
          if let w = model.handOffs.waiting(HandOffKey.boxdKey) { OpenedFoot(command: w.command) }
          Foot(verbatim: "Agents on Cloud run on boxd machines, billed to this key.")
        }
      }
      .disabled(!live)

      Section {
        tokenRow
      } header: {
        Text("This app")
      } footer: {
        Foot(verbatim: "The menu bar app talks to capcomd with its own token. Reset it if it may have been copied: the old one stops working at once.")
      }
    }
    .formStyle(.grouped)
    .alert("Reset the app token?", isPresented: $confirmReset) {
      Button("Reset", role: .destructive) { if model.resetToken() { sheet = .afterReset } }
      Button("Cancel", role: .cancel) {}
    } message: {
      Text("This app gets a new token, and the old one stops working at once. Anything else using it needs the new one.")
    }
    .dialogIcon(BotImages.scaled(BrandBot.happy, size: .full, cell: 2).map { Image(nsImage: $0) })
    .sheet(item: $sheet) { TokenSheet(afterReset: $0 == .afterReset) }
  }

  @ViewBuilder private var boxdKeyRow: some View {
    let state = model.boxdKey
    let waiting = model.handOffs.waiting(HandOffKey.boxdKey) != nil
    let setUp = { _ = model.handOff(HandOffKey.boxdKey, command: SettingsRows.boxdKeyCommand, baseline: "\(state)") }
    LabeledContent("API key") {
      HStack(spacing: Theme.Settings.rowGap) {
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

  @ViewBuilder private var tokenRow: some View {
    LabeledContent {
      HStack(spacing: Theme.Settings.rowGap) {
        switch model.connection {
        case .waitingForKeychain: WaitingValue(text: "Waiting for Keychain access…")
        case .noToken:
          StatusValue(nil, "Not set")
          Button("Paste Token…") { sheet = .paste }.prominent()
        case .rejected:
          StatusValue(.bad, "capcomd rejected it")
          Button("Paste Token…") { sheet = .paste }.prominent()
        default:
          if model.tokenFromEnvironment {
            StatusValue(nil, "From CAPCOMD_TOKEN")
          } else {
            StatusValue(nil, "Saved in your keychain")
            Button("Reset…") { confirmReset = true }
          }
        }
      }
    } label: {
      Text("App token")
      Text("Can read runs, message agents and approve merges")
    }
  }
}

/// One AI's login in one place (States: "Logging in").
struct LoginRowView: View {
  @Environment(AppModel.self) private var model
  let row: LoginRow

  var body: some View {
    let place = PlaceNames.title(row.sandbox), ai = PlaceNames.provider(row.provider)
    let waiting = model.handOffs.waiting(HandOffKey.login(row)) != nil
    LabeledContent {
      HStack(spacing: Theme.Settings.rowGap) {
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
          // The AI new runs start with, not logged in here: the one thing to do on this pane (Accounts board).
          if !row.isLoggedIn && row.provider == (model.startDriver?.provider ?? "claude") { button.prominent() } else { button }
        }
      }
    } label: {
      Text(verbatim: place)
      Text(verbatim: waiting ? "Finish logging in in the Terminal window." : PlaceNames.detail(row.sandbox))
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

extension BotImages {
  /// The bot as an image `cell` points per cell, drawn without interpolation (an alert's icon).
  static func scaled(_ traits: BotTraits, size: BotSize, cell: CGFloat) -> NSImage? {
    guard let base = image(traits, size: size) else { return nil }
    let side = CGFloat(BotAvatar.cells(size)) * cell
    return NSImage(size: NSSize(width: side, height: side), flipped: false) { rect in
      NSGraphicsContext.current?.imageInterpolation = .none
      base.draw(in: rect)
      return true
    }
  }
}
#endif
