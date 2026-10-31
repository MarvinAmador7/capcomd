import Foundation

/// `ab`'s order of runs: each pair's first side, "AB" (A ran first) or "BA". Counterbalanced so running second (after
/// the other build's window, on a machine one run warmer) costs both builds alike; seeded so a recorded run's order can
/// be drawn again.
public enum PairOrder {
  /// random: a seeded shuffle of as many AB as BA pairs (the odd one out drawn too); abba: AB BA AB BA …
  public static func draw(pairs n: Int, mode: String, seed: UInt64) -> [String] {
    guard n > 0 else { return [] }
    if mode == "abba" { return (0..<n).map { $0 % 2 == 0 ? "AB" : "BA" } }
    var rng = SplitMix64(seed: seed)
    var xs = Array(repeating: "AB", count: n / 2) + Array(repeating: "BA", count: n / 2)
    if n % 2 == 1 { xs.append(rng.next() & 1 == 0 ? "AB" : "BA") }
    // Fisher-Yates by hand: the standard library's shuffle may change its algorithm, and a seed must redraw the order.
    for i in stride(from: xs.count - 1, to: 0, by: -1) { xs.swapAt(i, Int(rng.next() % UInt64(i + 1))) }
    return xs
  }
}

/// A small seeded generator (SplitMix64): the same seed draws the same order on every machine and Swift version.
public struct SplitMix64: RandomNumberGenerator {
  var state: UInt64
  public init(seed: UInt64) { state = seed }
  public mutating func next() -> UInt64 {
    state &+= 0x9E37_79B9_7F4A_7C15
    var z = state
    z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
    z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
    return z ^ (z >> 31)
  }
}
