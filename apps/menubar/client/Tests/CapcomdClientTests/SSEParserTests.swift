import XCTest
@testable import CapcomdClient

/// The SSE parser on its own: no mock daemon (TransportTests starts one for every test).
final class SSEParserTests: XCTestCase {
  func testSSEParserChunkBoundaries() {
    var p = SSEParser(); let s = Array("id: 7\nevent: event\ndata: {\"a\":\ndata: 1}\n\n: comment\r\ndata: x\r\n\r\n".utf8)
    var out = [SSEFrame](); for b in s { out += p.feed([b]) }
    XCTAssertEqual(out, [SSEFrame(id: "7", event: "event", data: "{\"a\":\n1}"), SSEFrame(id: nil, event: "message", data: "x")])
  }
}
