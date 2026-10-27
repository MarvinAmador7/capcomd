import Foundation

/// @ mentions in a steer. The agent reads plain text, so the body spells each mention as its handle and ends with one
/// line naming the agents: "…@worker-4423…\n\n(@worker-4423 is agent agt-wk03; @worker is agent agt-wk04)". The panel
/// reads that line back to draw the mentions as pills and hides it.
public enum SteerMentions {
  public struct Mention: Equatable, Sendable {
    public let handle: String, agentId: String
    public init(handle: String, agentId: String) { self.handle = handle; self.agentId = agentId }
  }

  public static func compose(_ body: String, _ mentions: [Mention]) -> String {
    mentions.isEmpty ? body : body + "\n\n(" + mentions.map { "\($0.handle) is agent \($0.agentId)" }.joined(separator: "; ") + ")"
  }

  /// The text as typed, and the mentions its last line names (in order); the text unchanged and none if that line
  /// isn't there or doesn't parse.
  public static func parse(_ text: String) -> (body: String, mentions: [Mention]) {
    guard text.hasSuffix(")"), let open = text.range(of: "\n\n(@", options: .backwards) else { return (text, []) }
    let inner = text[text.index(open.upperBound, offsetBy: -1)..<text.index(before: text.endIndex)]
    var out: [Mention] = []
    for part in inner.components(separatedBy: "; ") {
      let kv = part.components(separatedBy: " is agent ")
      guard kv.count == 2, kv[0].hasPrefix("@"), kv[0].count > 1, !kv[1].isEmpty, !kv[1].contains(" ") else { return (text, []) }
      out.append(Mention(handle: kv[0], agentId: kv[1]))
    }
    return (String(text[..<open.lowerBound]), out)
  }
}
