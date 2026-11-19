import Foundation
import DeskBenchKit

/// `Fixtures.make` once per name and seed for the whole test process: a World is a value, so every caller gets its own
/// copy, and generating `crew17` for every model test was most of this target's time. Tests of the generator itself
/// (determinism, every fixture's spec) call `Fixtures.make` directly.
enum CachedFixtures {
  private static let lock = NSLock()
  nonisolated(unsafe) private static var worlds: [String: World] = [:]

  static func make(_ name: String, seed: UInt64 = 7) -> World? {
    let key = "\(name)#\(seed)"
    lock.lock(); defer { lock.unlock() }
    if let w = worlds[key] { return w }
    let w = Fixtures.make(name, seed: seed)
    if let w { worlds[key] = w }
    return w
  }
}
