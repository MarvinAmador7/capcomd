import XCTest
@testable import CapcomdStore

final class SteerMentionsTests: XCTestCase {
  let bolt = SteerMentions.Mention(handle: "@worker-4423", agentId: "agt-wk03")
  let wren = SteerMentions.Mention(handle: "@worker", agentId: "agt-wk04")

  func testComposeNamesEachMentionedAgentOnALastLine() {
    XCTAssertEqual(SteerMentions.compose("ask @worker-4423 and @worker", [bolt, wren]),
                   "ask @worker-4423 and @worker\n\n(@worker-4423 is agent agt-wk03; @worker is agent agt-wk04)")
    XCTAssertEqual(SteerMentions.compose("no mentions", []), "no mentions")
  }

  func testParseReadsComposeBack() {
    let sent = SteerMentions.compose("ask @worker-4423\nthen @worker", [bolt, wren])
    let (body, mentions) = SteerMentions.parse(sent)
    XCTAssertEqual(body, "ask @worker-4423\nthen @worker")
    XCTAssertEqual(mentions, [bolt, wren])
  }

  func testTextThatOnlyLooksLikeItIsLeftAlone() {
    for t in ["plain", "note (see above)", "x\n\n(@a is the agent)", "x\n\n(@ is agent agt-1)", "x\n\n(@a is agent two words)", "x\n\n(@a is agent agt-1"] {
      let (body, mentions) = SteerMentions.parse(t)
      XCTAssertEqual(body, t); XCTAssertEqual(mentions, [])
    }
  }
}
