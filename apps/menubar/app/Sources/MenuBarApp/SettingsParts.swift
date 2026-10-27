#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import AppKit
import CapcomdStore
import CapcomdBot

/// A status dot (`.dot`) or the empty ring (`.empty`) before a value. The value's text always says the state too.
struct StatusDot: View {
  enum Kind { case ok, warn, bad, empty }
  let kind: Kind
  var body: some View {
    Group {
      switch kind {
      case .ok: Circle().fill(Theme.Settings.ok)
      case .warn: Circle().fill(Theme.Settings.warn)
      case .bad: Circle().fill(Theme.Settings.bad)
      case .empty: Circle().strokeBorder(Theme.Settings.ring, lineWidth: Theme.Settings.ringWidth)
      }
    }
    .frame(width: Theme.Settings.dot, height: Theme.Settings.dot)
    .accessibilityHidden(true)
  }
}

/// A row's value (`.val`): the dot and the text, secondary.
struct StatusValue: View {
  let kind: StatusDot.Kind?
  let text: String
  init(_ kind: StatusDot.Kind?, _ text: String) { self.kind = kind; self.text = text }
  var body: some View {
    HStack(spacing: Theme.Settings.valueGap) {
      if let kind { StatusDot(kind: kind) }
      Text(verbatim: text).lineLimit(1).truncationMode(.tail)
    }
    .foregroundStyle(.secondary)
    .help(text)
  }
}

/// "Waiting for Terminal…" with the system's small spinner (States board).
struct WaitingValue: View {
  var text = "Waiting for Terminal…"
  var body: some View {
    HStack(spacing: Theme.Settings.valueGap) {
      ProgressView().controlSize(.mini).accessibilityHidden(true)
      Text(verbatim: text)
    }
    .foregroundStyle(.secondary)
  }
}

/// The "Default" badge in a place's section header (`.badge`): accent text on an accent tint, 5 pt corners, a label and
/// not a control. The fixed accent, so it stays blue (`Color.accentColor` turns graphite whenever the app isn't active).
struct DefaultBadge: View {
  var body: some View {
    Text("Default").font(Theme.Settings.badgeFont).foregroundStyle(Theme.Settings.badgeText)
      .padding(.horizontal, Theme.Settings.badgePaddingH).padding(.vertical, Theme.Settings.badgePaddingV)
      .background(RoundedRectangle(cornerRadius: Theme.Settings.badgeRadius, style: .continuous).fill(Theme.accent.opacity(Theme.Settings.badgeFill)))
      .fixedSize()
      .allowsHitTesting(false)
      .accessibilityAddTraits(.isStaticText)
  }
}

/// A place's mark in its section header, by the descriptor's `mark` id (PlaceMarks): Docker's (one colour), the cloud
/// for boxd (a stand-in until boxd's own mark), else a glyph by kind. Without a descriptor, the place's name is the id.
struct PlaceMark: View {
  let mark: String
  var kind: SandboxDescriptor.Kind? = nil
  init(name: String) { mark = name }
  init(mark: String, kind: SandboxDescriptor.Kind) { self.mark = mark; self.kind = kind }
  var body: some View {
    let side = Theme.Settings.placeMark
    Group {
      switch PlaceMarks.glyph(mark, kind: kind) {
      case .path(_, let path): SVGShape(path: path, viewBox: 24).frame(width: side, height: side)
      case .symbol(let s): Image(systemName: s).font(.system(size: side * 0.8)).frame(width: side, height: side)
      }
    }
    .accessibilityHidden(true)
  }
}

extension Tone {
  /// The StatusDot for a tone; `.none` draws no dot.
  var dot: StatusDot.Kind? {
    switch self { case .ok: .ok; case .warn: .warn; case .bad: .bad; case .empty: .empty; case .none: nil }
  }
}

/// A provider's mark in its Accounts section header: Claude's spark in its coral, Codex's stand-in glyph.
struct ProviderHeaderMark: View {
  let provider: String
  var body: some View {
    if let p = Provider(wire: provider) {
      ProviderMark(provider: p, size: Theme.Settings.providerMark)
        .foregroundStyle(p == .claude ? Theme.Provider.claude : Color.secondary)
        .accessibilityHidden(true)
    }
  }
}

/// A section footer (`.foot`): 11 pt, secondary.
struct Foot: View {
  let text: Text
  init(_ text: Text) { self.text = text }
  init(verbatim s: String) { text = Text(verbatim: s) }
  var body: some View {
    text.font(Theme.Settings.footFont).foregroundStyle(.secondary).multilineTextAlignment(.leading)
      .fixedSize(horizontal: false, vertical: true)
      .frame(maxWidth: .infinity, alignment: .leading)   // flush left under its group (`.foot`), never trailing
  }
}

/// "Opened: `capcomd auth login claude --sandbox docker`": the command a waiting row handed to Terminal.
struct OpenedFoot: View {
  let command: String
  var body: some View {
    Foot(Text("Opened: ") + Text(verbatim: command).font(Theme.Settings.footMono)).textSelection(.enabled)
  }
}

/// Bot faces' preview: the menu bar mark as it is now, on a 32 pt tile.
struct BotFacePreview: View {
  let face: MenuBarFace
  var body: some View {
    Image(nsImage: MarkImages.image(face)).renderingMode(.template).foregroundStyle(.primary)
      .frame(width: Theme.Settings.faceMark, height: Theme.Settings.faceMark)
      .frame(width: Theme.Settings.faceTile, height: Theme.Settings.faceTile)
      .background(RoundedRectangle(cornerRadius: Theme.Settings.faceTileRadius, style: .continuous).fill(Theme.Settings.faceTileFill))
      .accessibilityHidden(true)
  }
}

/// Paste a token (no token yet, rejected, or after Reset…): the existing replace-token flow in a sheet.
struct TokenSheet: View {
  @Environment(AppModel.self) private var model
  @Environment(\.dismiss) private var dismiss
  @State private var token = ""
  @State private var failed = false
  /// After Reset…: Terminal is making the new token.
  let afterReset: Bool

  var body: some View {
    VStack(alignment: .leading, spacing: Theme.Settings.sheetGap) {
      Text(afterReset ? "Paste the new token" : "Paste a token").font(.headline)
      Text(afterReset ? "Copy the token Terminal shows and paste it here."
                      : "Make one with `capcomd clients add menubar --scopes read,steer,approve` and paste it here. capcomd shows it only once.")
        .foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
      SecureField("Token", text: $token).textFieldStyle(.roundedBorder).onSubmit(save)
      if failed { Text("Couldn’t save the token to the Keychain.").foregroundStyle(.secondary) }
      HStack {
        Spacer()
        Button("Cancel", role: .cancel) { dismiss() }.keyboardShortcut(.cancelAction)
        Button("Connect", action: save).keyboardShortcut(.defaultAction).disabled(token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
      }
    }
    .padding(Theme.Settings.sheetPadding)
    .frame(width: Theme.Settings.sheetWidth)
  }

  private func save() {
    failed = !model.submitToken(token)
    if !failed { token = ""; dismiss() }
  }
}

extension View {
  /// The one prominent action of a row (`.btn.pri`): the system's bordered prominent button in the accent colour. The
  /// tint is explicit: a Form styles a row's value secondary, and a prominent button left to inherit that drew dark grey.
  func prominent() -> some View { buttonStyle(.borderedProminent).tint(Color.accentColor) }

  /// A row whose data comes from capcomd: disabled while it can't be reached (it keeps showing the last values).
  func daemonRow(_ live: Bool) -> some View { disabled(!live) }
}
#endif
