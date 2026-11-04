// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "CapcomdApp",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "CapcomdStore", targets: ["CapcomdStore"]),
    .library(name: "CapcomdThread", targets: ["CapcomdThread"]),
    // The capcomd app: the window and the menu bar item in one Dock app (apps/menubar/scripts/build-app.sh bundles it).
    .executable(name: "CapcomdApp", targets: ["CapcomdApp"]),
    // The desktop window's performance and debugging harness, for coding agents (DESKBENCH.md).
    .executable(name: "CapcomdDeskBench", targets: ["CapcomdDeskBench"]),
  ],
  // tools/perfloop: the performance loop's probe library (runtime knobs), linked by the desktop window itself.
  dependencies: [.package(path: "../client"), .package(path: "../../../tools/perfloop")],
  targets: [
    // Thread items (format blocks/1): decoding, merge by id/rev, link and code presentation. Foundation only.
    .target(name: "CapcomdThread"),
    // Pixel bot avatars and the menu bar mark: a port of packages/bot-avatar (its catalog embedded). Foundation only.
    .target(name: "CapcomdBot"),
    // Platform-neutral state store: no Foundation networking, no SwiftUI. Fully tested on Linux.
    .target(name: "CapcomdStore", dependencies: ["CapcomdThread"]),
    // Glue to the CapcomdClient transport: SSE subscriptions per scope and the HTTP approval decider.
    .target(name: "CapcomdLive", dependencies: ["CapcomdStore", "CapcomdThread", .product(name: "CapcomdClient", package: "client")]),
    // SwiftUI pieces the window and the menu bar draw with (the theme, bots, provider marks, the thread renderer) and the
    // session they share (the token, pairing, starting the daemon). macOS only (an empty module on Linux); declarations
    // other targets use are `package`.
    .target(name: "CapcomdUI", dependencies: ["CapcomdStore", "CapcomdThread", "CapcomdBot", "CapcomdLive", .product(name: "CapcomdClient", package: "client")]),
    // The desktop window (design/desktop) as a library: its model, reel and title bar, so the app and the bench both
    // host the same views. macOS only (an empty module on Linux).
    .target(name: "CapcomdDesk", dependencies: ["CapcomdStore", "CapcomdLive", "CapcomdThread", "CapcomdBot", "CapcomdUI", .product(name: "CapcomdClient", package: "client"),
                                                .product(name: "PerfLoopProbe", package: "perfloop")]),
    // The app: the window (CapcomdDesk) with the menu bar item and its panel, and Settings, in one Dock app. Every view
    // is behind `#if canImport(SwiftUI)`; on Linux this builds to a stub.
    .executableTarget(name: "CapcomdApp", dependencies: ["CapcomdDesk", "CapcomdStore", "CapcomdLive", "CapcomdThread", "CapcomdBot", "CapcomdUI"]),
    // The bench's pure parts (fixtures, statistics, budgets, xctrace summaries), tested without a window.
    .target(name: "DeskBenchKit", dependencies: ["CapcomdStore", "CapcomdThread", .product(name: "PerfLoopProbe", package: "perfloop")]),
    // The bench: hosts the desktop window in-process against fixture data and measures it (DESKBENCH.md).
    // BuildStamp embeds the commit, dirty flag and build time, so a copied binary still says what it was built from.
    .executableTarget(name: "CapcomdDeskBench", dependencies: ["DeskBenchKit", "CapcomdDesk", "CapcomdStore", "CapcomdThread", "CapcomdBot", "CapcomdUI",
                                                              .product(name: "PerfLoopProbe", package: "perfloop"), .product(name: "CapcomdClient", package: "client")],
                      plugins: ["BuildStamp"]),
    .plugin(name: "BuildStamp", capability: .buildTool()),
    .testTarget(name: "CapcomdStoreTests", dependencies: ["CapcomdStore", "CapcomdLive", .product(name: "CapcomdClient", package: "client")],
                resources: [.copy("Fixtures")]),
    // Decodes packages/agent-thread/fixtures/golden (shared with the daemon's own tests) in place.
    .testTarget(name: "CapcomdThreadTests", dependencies: ["CapcomdThread"]),
    // Checks the port against packages/bot-avatar/fixtures (golden bots and the catalog), read in place.
    .testTarget(name: "CapcomdBotTests", dependencies: ["CapcomdBot"]),
    // Fixtures/ holds hand-made xctrace exports, read in place.
    // CapcomdDesk for its knobs' defaults (no window is made).
    .testTarget(name: "DeskBenchKitTests", dependencies: ["DeskBenchKit", "CapcomdStore", "CapcomdDesk", .product(name: "PerfLoopProbe", package: "perfloop")], exclude: ["Fixtures"]),
  ])
