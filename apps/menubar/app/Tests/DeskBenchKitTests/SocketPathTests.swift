import XCTest
#if canImport(SwiftUI) && os(macOS)
import CapcomdUI
#endif

/// The app finds the daemon's socket as the CLI does: the environment before its own default, so a development launch
/// with its own daemon's environment never connects to the owner's.
final class SocketPathTests: XCTestCase {
  #if canImport(SwiftUI) && os(macOS)
  func testEnvironmentComesFirst() {
    let home = "/Users/someone"
    // CAPCOMD_HARNESS_SOCKET wins over everything.
    XCTAssertEqual(Connection.socketPath(env: ["CAPCOMD_HARNESS_SOCKET": "/tmp/capcomd-sp.sock", "CAPCOMD_HOME": "/tmp/h"], defaults: "/tmp/d.sock", home: home),
                   "/tmp/capcomd-sp.sock")
    // Then CAPCOMD_HOME's harness.sock, ahead of the defaults key.
    XCTAssertEqual(Connection.socketPath(env: ["CAPCOMD_HOME": "/tmp/h"], defaults: "/tmp/d.sock", home: home), "/tmp/h/harness.sock")
    // Then the defaults key (`-capcomd.socketPath`), then ~/.capcomd/harness.sock.
    XCTAssertEqual(Connection.socketPath(env: [:], defaults: "/tmp/d.sock", home: home), "/tmp/d.sock")
    XCTAssertEqual(Connection.socketPath(env: [:], defaults: nil, home: home), "/Users/someone/.capcomd/harness.sock")
    // Empty values don't count; ~/ is the home directory.
    XCTAssertEqual(Connection.socketPath(env: ["CAPCOMD_HARNESS_SOCKET": "", "CAPCOMD_HOME": ""], defaults: "", home: home), "/Users/someone/.capcomd/harness.sock")
    XCTAssertEqual(Connection.socketPath(env: ["CAPCOMD_HARNESS_SOCKET": "~/x/h.sock"], defaults: nil, home: home), "/Users/someone/x/h.sock")
  }
  #endif
}
