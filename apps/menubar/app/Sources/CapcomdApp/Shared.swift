#if canImport(SwiftUI) && os(macOS)
// The shared SwiftUI pieces (theme, bots, thread renderer), visible to every file of the app.
@_exported import CapcomdUI
import SwiftUI

/// A zero-size button that only answers a ⌘-shortcut, so the keyboard path can skip the click's animation.
@ViewBuilder func keyboardOnly(_ key: KeyEquivalent, _ action: @escaping () -> Void) -> some View {
  Button(action: action) { EmptyView() }.keyboardShortcut(key, modifiers: .command).opacity(0).frame(width: 0, height: 0)
    .accessibilityHidden(true)
}
#endif
