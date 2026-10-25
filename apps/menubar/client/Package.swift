// swift-tools-version:5.9
import PackageDescription
let package = Package(
  name: "CapcomdClient",
  platforms: [.macOS(.v13)],
  products: [.library(name: "CapcomdClient", targets: ["CapcomdClient"])],
  dependencies: [
    .package(url: "https://github.com/swift-server/async-http-client.git", from: "1.21.0"),
    .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.6.0"),
    .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.7.0"),
  ],
  targets: [
    .target(name: "CapcomdClient", dependencies: [
      .product(name: "AsyncHTTPClient", package: "async-http-client"),
      .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
    ], plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]),
    .testTarget(name: "CapcomdClientTests", dependencies: ["CapcomdClient"]),
  ])
