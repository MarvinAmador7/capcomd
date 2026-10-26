// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "CapcomdMenuBar",
  platforms: [.macOS(.v14)],
  products: [
    .library(name: "CapcomdStore", targets: ["CapcomdStore"]),
    .executable(name: "CapcomdMenuBar", targets: ["MenuBarApp"]),
  ],
  dependencies: [.package(path: "../client")],
  targets: [
    // Platform-neutral state store: no Foundation networking, no SwiftUI. Fully tested on Linux.
    .target(name: "CapcomdStore"),
    // Glue to the CapcomdClient transport: SSE subscriptions per scope and the HTTP approval decider.
    .target(name: "CapcomdLive", dependencies: ["CapcomdStore", .product(name: "CapcomdClient", package: "client")]),
    // SwiftUI menu bar app. Every view is behind `#if canImport(SwiftUI)`; on Linux this builds to a stub.
    .executableTarget(name: "MenuBarApp", dependencies: ["CapcomdStore", "CapcomdLive"]),
    .testTarget(name: "CapcomdStoreTests", dependencies: ["CapcomdStore", "CapcomdLive", .product(name: "CapcomdClient", package: "client")],
                resources: [.copy("Fixtures")]),
  ])
