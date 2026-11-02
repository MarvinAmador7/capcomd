import XCTest
@testable import CapcomdClient

final class BackoffTests: XCTestCase {
  /// Full jitter: every delay is in [0, min(cap, base * 2^(attempt-1))], and the draws spread out instead of repeating.
  func testJitteredBackoffStaysUnderItsCeilingAndSpreads() {
    for attempt in 1...40 {
      let ceiling = min(5_000.0, 50.0 * pow(2, Double(attempt - 1)))
      for _ in 0..<50 {
        let d = jitteredBackoff(base: .milliseconds(50), attempt: attempt, cap: .seconds(5))
        XCTAssertGreaterThanOrEqual(d, .zero)
        XCTAssertLessThanOrEqual(d, .milliseconds(Int64(ceiling)), "attempt \(attempt)")
      }
    }
    let draws = Set((0..<20).map { _ in jitteredBackoff(base: .milliseconds(500), attempt: 6) })
    XCTAssertGreaterThan(draws.count, 1)
    XCTAssertLessThanOrEqual(jitteredBackoff(base: .milliseconds(500), attempt: Int.max), .seconds(30))
  }
}
