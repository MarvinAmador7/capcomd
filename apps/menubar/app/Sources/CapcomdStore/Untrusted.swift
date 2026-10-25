/// Agent-written text (`x-untrusted: true` in the contract). Plain text only: the UI must render it with
/// `Text(verbatim:)`, never as markdown, a link, or an action. Construction strips control and bidi-override
/// characters and caps length so a hostile string can't spoof layout.
public struct UntrustedText: Hashable, Sendable, CustomStringConvertible {
  public let plain: String
  public static let maxLength = 2000
  public init(_ raw: String) {
    var out = String.UnicodeScalarView()
    for u in raw.unicodeScalars {
      let v = u.value
      if v == 0x0A || v == 0x09 { out.append(u); continue }
      if v < 0x20 || (0x7F...0x9F).contains(v) { continue }            // C0/C1 controls
      if (0x202A...0x202E).contains(v) || (0x2066...0x2069).contains(v) || v == 0x200E || v == 0x200F { continue } // bidi
      out.append(u)
    }
    var s = String(out)
    if s.count > Self.maxLength { s = String(s.prefix(Self.maxLength)) + "…" }
    plain = s
  }
  public var description: String { plain }
  /// First line, for one-row summaries.
  public var firstLine: String { plain.split(separator: "\n", omittingEmptySubsequences: true).first.map(String.init) ?? "" }

  /// The daemon's literal redaction marker. Rendered dimmed, still as plain text.
  public static let redactionMarker = "[REDACTED]"
  /// Splits `plain` into runs of text and redaction markers, in order, for dimmed rendering of `[REDACTED]`.
  public var segments: [Segment] { Self.segments(plain) }
  public static func segments(_ s: String) -> [Segment] {
    var out: [Segment] = []; var rest = Substring(s)
    while let r = rest.range(of: redactionMarker) {
      if r.lowerBound > rest.startIndex { out.append(.text(String(rest[rest.startIndex..<r.lowerBound]))) }
      out.append(.redacted); rest = rest[r.upperBound...]
    }
    if !rest.isEmpty { out.append(.text(String(rest))) }
    return out
  }
  public enum Segment: Hashable, Sendable { case text(String), redacted }
}
