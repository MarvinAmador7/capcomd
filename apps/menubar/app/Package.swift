// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "CapcomdMenuBar",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "CapcomdStore", targets: ["CapcomdStore"]),
    .library(name: "CapcomdThread", targets: ["CapcomdThread"]),
    .executable(name: "CapcomdMenuBar", targets: ["MenuBarApp"]),
  ],
  dependencies: [.package(path: "../client")],
  targets: [
    // Thread items (format blocks/1): decoding, merge by id/rev, link and code presentation. Foundation only.
    .target(name: "CapcomdThread"),
    // Platform-neutral state store: no Foundation networking, no SwiftUI. Fully tested on Linux.
    .target(name: "CapcomdStore", dependencies: ["CapcomdThread"]),
    // Glue to the CapcomdClient transport: SSE subscriptions per scope and the HTTP approval decider.
    .target(name: "CapcomdLive", dependencies: ["CapcomdStore", "CapcomdThread", .product(name: "CapcomdClient", package: "client")]),
    // SwiftUI menu bar app. Every view is behind `#if canImport(SwiftUI)`; on Linux this builds to a stub.
    .executableTarget(name: "MenuBarApp", dependencies: ["CapcomdStore", "CapcomdLive", "CapcomdThread"]),
    .testTarget(name: "CapcomdStoreTests", dependencies: ["CapcomdStore", "CapcomdLive", .product(name: "CapcomdClient", package: "client")],
                resources: [.copy("Fixtures")]),
    // Decodes packages/agent-thread/fixtures/golden (shared with the daemon's own tests) in place.
    .testTarget(name: "CapcomdThreadTests", dependencies: ["CapcomdThread"]),
  ])
