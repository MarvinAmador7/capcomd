// The only randomness in the bot engine, ported from packages/bot-avatar/src/hash.ts bit for bit. All arithmetic is
// unsigned 32-bit with explicit wrap-around (&*, &+), which is what Math.imul and >>> 0 do in the TypeScript.
//
//   fnv1a32(bytes): h = 0x811C9DC5; for each byte b: h = (h XOR b) * 0x01000193
//   fmix32(h):      h ^= h >> 16; h *= 0x85EBCA6B; h ^= h >> 13; h *= 0xC2B2AE35; h ^= h >> 16   (MurmurHash3 finalizer)
//   h32(s)        = fmix32(fnv1a32(UTF-8 bytes of s))
//
// Keys are joined with U+001F (unit separator), e.g. h32("agt-1f3a\u{1F}head\u{1F}dome\u{1F}0").

/// FNV-1a, 32 bits.
public func fnv1a32<S: Sequence>(_ bytes: S) -> UInt32 where S.Element == UInt8 {
  var h: UInt32 = 0x811C_9DC5
  for b in bytes { h = (h ^ UInt32(b)) &* 0x0100_0193 }
  return h
}

/// MurmurHash3's 32-bit finalizer.
public func fmix32(_ x: UInt32) -> UInt32 {
  var h = x
  h ^= h >> 16
  h = h &* 0x85EB_CA6B
  h ^= h >> 13
  h = h &* 0xC2B2_AE35
  h ^= h >> 16
  return h
}

/// The separator `hkey` joins its parts with (U+001F).
public let botKeySeparator = "\u{1F}"

/// Stable 32-bit hash of a string (its UTF-8 bytes).
public func h32(_ s: String) -> UInt32 { fmix32(fnv1a32(s.utf8)) }

/// h32 of the parts joined with U+001F. Numbers are joined as their decimal form, as JavaScript's `join` does.
public func hkey(_ parts: String...) -> UInt32 { h32(parts.joined(separator: botKeySeparator)) }

/// mulberry32, seeded with a u32. Each call returns the next u32:
///   state += 0x6D2B79F5; t = state; t = (t ^ t >> 15) * (t | 1); t ^= t + (t ^ t >> 7) * (t | 61); return t ^ t >> 14
/// For decorative layouts (confetti, sparkles), never for picking parts: picks use rendezvous hashing so that adding a
/// part to the catalog leaves every other bot alone.
public struct Mulberry32: Sendable, Hashable {
  public private(set) var state: UInt32

  public init(seed: UInt32) { state = seed }

  public mutating func next() -> UInt32 {
    state = state &+ 0x6D2B_79F5
    var t = state
    t = (t ^ (t >> 15)) &* (t | 1)
    t = t ^ (t &+ ((t ^ (t >> 7)) &* (t | 61)))
    return t ^ (t >> 14)
  }
}

/// A PRNG for one named stream of one seed: mulberry32(hkey(seed, stream)).
public func botRNG(seed: String, stream: String) -> Mulberry32 { Mulberry32(seed: hkey(seed, stream)) }
