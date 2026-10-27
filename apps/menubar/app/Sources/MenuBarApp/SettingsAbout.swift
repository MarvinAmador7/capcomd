#if canImport(SwiftUI) && os(macOS)
import SwiftUI
import CapcomdStore
import CapcomdBot

/// Settings › About (About.dc.html): the identity moment. The happy bot and the pixel wordmark (brand orange, the one
/// pane besides the menu bar mark that carries the brand), the versions, links, licence. Not a Form: one column.
struct AboutPane: View {
  @Environment(AppModel.self) private var model
  @Environment(\.openURL) private var openURL

  private typealias A = Theme.Settings.About

  var body: some View {
    VStack(spacing: 0) {
      BotAvatar(traits: BrandBot.happy, size: .full, cell: A.botCell)
        .accessibilityElement(children: .ignore).accessibilityLabel("\(BrandBot.name), the capcomd bot, smiling").accessibilityAddTraits(.isImage)
      PixelWordmark(cell: A.wordmarkCell).padding(.top, A.wordmarkTop)
      Text("Agent orchestration for your Mac").font(A.taglineFont).foregroundStyle(.secondary).padding(.top, A.taglineTop)
      Text(verbatim: "App \(AppInfo.version) · " + (model.daemonVersion.map { "capcomd \($0)" } ?? "capcomd isn't connected"))
        .font(A.smallFont).foregroundStyle(.secondary).padding(.top, A.versionTop)
        .textSelection(.enabled)
      HStack(spacing: A.linksGap) {
        Button("GitHub") { openURL(AppInfo.repo) }
        Button("Changelog") { openURL(AppInfo.changelog) }
        Button("Report an Issue…") { openURL(AppInfo.newIssue) }
      }
      .padding(.top, A.linksTop)
      Text("MIT License").font(A.smallFont).foregroundStyle(.tertiary).padding(.top, A.licenseTop)
    }
    .padding(.top, A.paddingTop).padding(.horizontal, A.paddingH).padding(.bottom, A.paddingBottom)
    .frame(maxWidth: .infinity, minHeight: A.height)
    .accessibilityElement(children: .contain)
  }
}
#endif
