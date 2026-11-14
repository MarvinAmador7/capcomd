#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdUI

enum RailMetrics {
  /// NavC / NavB `.rail`: 60 pt wide, 34 pt buttons with 9 pt corners, 6 pt apart.
  static let width: CGFloat = 60, button: CGFloat = 34, radius: CGFloat = 9, gap: CGFloat = 6
}

/// The folded window's rail (C folded: NavC, RexStates "Folded"): the Needs you hand with its amber count, Home, Crew and
/// History; Settings at the foot. Beside it the approved title bar and reel, unchanged. It reads only the Needs you
/// count and whether Home shows.
struct Rail: View {
  @Environment(DeskModel.self) private var model
  var body: some View {
    DeskProbe.body("Rail")
    return VStack(spacing: RailMetrics.gap) {
      NeedsHand(style: .rail)
      SideButton(glyph: AnyView(HouseGlyph().stroke(style: StrokeStyle(lineWidth: 1.3, lineJoin: .round)).frame(width: 16, height: 16)),
                 on: model.homeShown, help: "Home (⌘0)", label: "Home", size: RailMetrics.button) { model.toggleHome() }
      // Crew (the agent profiles) has no screen yet: it keeps its place, disabled.
      Button {} label: {
        Image(systemName: "person.2").font(.system(size: 14)).foregroundStyle(Theme.Desk.tertiary)
          .frame(width: RailMetrics.button, height: RailMetrics.button)
      }
      .buttonStyle(SideButtonStyle(radius: RailMetrics.radius))
      .disabled(true).opacity(0.5)
      .help("Crew (not built yet)")
      .accessibilityLabel("Crew, not available yet")
      HistoryButton(size: RailMetrics.button)
      Spacer(minLength: 0)
      SettingsButton(size: RailMetrics.button)
    }
    .padding(.top, 2).padding(.bottom, 12)
    .frame(width: RailMetrics.width)
    .frame(maxHeight: .infinity)
    .accessibilityElement(children: .contain)
    .accessibilityLabel("Places")
  }
}
#endif
