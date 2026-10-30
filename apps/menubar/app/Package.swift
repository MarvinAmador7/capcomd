// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "CapcomdMenuBar",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "CapcomdStore", targets: ["CapcomdStore"]),
    .library(name: "CapcomdThread", targets: ["CapcomdThread"]),
    .executable(name: "CapcomdMenuBar", targets: ["MenuBarApp"]),
    .executable(name: "CapcomdDesktop", targets: ["CapcomdDesktop"]),
  ],
  dependencies: [.package(path: "../client")],
  targets: [
    // Thread items (format blocks/1): decoding, merge by id/rev, link and code presentation. Foundation only.
    .target(name: "CapcomdThread"),
    // Pixel bot avatars and the menu bar mark: a port of packages/bot-avatar (its catalog embedded). Foundation only.
    .target(name: "CapcomdBot"),
    // Platform-neutral state store: no Foundation networking, no SwiftUI. Fully tested on Linux.
    .target(name: "CapcomdStore", dependencies: ["CapcomdThread"]),
    // Glue to the CapcomdClient transport: SSE subscriptions per scope and the HTTP approval decider.
    .target(name: "CapcomdLive", dependencies: ["CapcomdStore", "CapcomdThread", .product(name: "CapcomdClient", package: "client")]),
    // SwiftUI pieces both apps draw with: the theme, bots, provider marks and the thread renderer. macOS only (an
    // empty module on Linux); declarations other targets use are `package`.
    .target(name: "CapcomdUI", dependencies: ["CapcomdStore", "CapcomdThread", "CapcomdBot", "CapcomdLive", .product(name: "CapcomdClient", package: "client")]),
    // SwiftUI menu bar app. Every view is behind `#if canImport(SwiftUI)`; on Linux this builds to a stub.
    .executableTarget(name: "MenuBarApp", dependencies: ["CapcomdStore", "CapcomdLive", "CapcomdThread", "CapcomdBot", "CapcomdUI"]),
    // The desktop app (design/desktop): its own app, installable without the menu bar one.
    .executableTarget(name: "CapcomdDesktop", dependencies: ["CapcomdStore", "CapcomdLive", "CapcomdThread", "CapcomdBot", "CapcomdUI", .product(name: "CapcomdClient", package: "client")]),
    .testTarget(name: "CapcomdStoreTests", dependencies: ["CapcomdStore", "CapcomdLive", .product(name: "CapcomdClient", package: "client")],
                resources: [.copy("Fixtures")]),
    // Decodes packages/agent-thread/fixtures/golden (shared with the daemon's own tests) in place.
    .testTarget(name: "CapcomdThreadTests", dependencies: ["CapcomdThread"]),
    // Checks the port against packages/bot-avatar/fixtures (golden bots and the catalog), read in place.
    .testTarget(name: "CapcomdBotTests", dependencies: ["CapcomdBot"]),
  ])
