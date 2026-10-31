import Foundation

/// Order statistics the bench reports. Percentiles use the nearest-rank method on the sorted sample, so a value the
/// bench prints is one that was measured, never an interpolation.
public enum Stats {
  public static func percentile(_ xs: [Double], _ p: Double) -> Double {
    guard !xs.isEmpty else { return 0 }
    let s = xs.sorted()
    let rank = Int((p / 100 * Double(s.count)).rounded(.up))
    return s[max(0, min(s.count - 1, rank - 1))]
  }
  public static func median(_ xs: [Double]) -> Double { percentile(xs, 50) }
  /// Median absolute deviation: the spread that one wild repetition can't move.
  public static func mad(_ xs: [Double]) -> Double {
    guard xs.count > 1 else { return 0 }
    let m = median(xs)
    return median(xs.map { abs($0 - m) })
  }
  public static func round(_ x: Double, _ places: Int = 2) -> Double {
    let f = pow(10, Double(places)); return (x * f).rounded() / f
  }
}

/// A sample's shape in six numbers.
public struct Dist: Codable, Sendable, Equatable {
  public var n: Int
  public var min: Double
  public var median: Double
  public var p95: Double
  public var max: Double
  /// Median absolute deviation.
  public var mad: Double
  public init(_ xs: [Double]) {
    n = xs.count
    min = Stats.round(xs.min() ?? 0, 3); max = Stats.round(xs.max() ?? 0, 3)
    median = Stats.round(Stats.median(xs), 3); p95 = Stats.round(Stats.percentile(xs, 95), 3); mad = Stats.round(Stats.mad(xs), 3)
  }
}

/// Is B worse than A by more than the noise? The band is the larger of the two samples' spreads (MAD, scaled to a
/// standard deviation) plus a floor, so a few repetitions on a busy machine never call a regression by themselves.
public struct Regression: Codable, Sendable, Equatable {
  public var metric: String
  public var baselineMedian: Double
  public var candidateMedian: Double
  public var deltaPct: Double
  /// Half-width of the band inside which a difference is noise, as a share of the baseline median.
  public var noiseBandPct: Double
  public var regression: Bool
  public var improvement: Bool
  public var reason: String
  /// objective | guard | info. Only the objective and the guards decide a verdict; nil (older results) decides.
  public var role: String?
  public var decides: Bool { role != "info" }

  /// `higherIsWorse`: true for durations and counts. `floorPct`: the smallest change worth reporting (default 10 %).
  /// `absoluteFloor`: a change below this many units is never a regression (frames, ms).
  public init(metric: String, baseline: [Double], candidate: [Double], higherIsWorse: Bool = true, floorPct: Double = 10, absoluteFloor: Double = 0) {
    self.metric = metric
    let a = Stats.median(baseline), b = Stats.median(candidate)
    baselineMedian = Stats.round(a, 3); candidateMedian = Stats.round(b, 3)
    let spread = max(Stats.mad(baseline), Stats.mad(candidate)) * 1.4826
    let band = max(spread, abs(a) * floorPct / 100, absoluteFloor)
    noiseBandPct = a == 0 ? (band == 0 ? 0 : 100) : Stats.round(band / abs(a) * 100, 1)
    deltaPct = a == 0 ? (b == 0 ? 0 : 100) : Stats.round((b - a) / abs(a) * 100, 1)
    let worse = higherIsWorse ? b - a : a - b
    regression = worse > band
    improvement = -worse > band
    if baseline.count < 3 || candidate.count < 3 {
      reason = "fewer than 3 repetitions a side: the band is a guess"
    } else if regression {
      reason = "\(metric) moved from \(baselineMedian) to \(candidateMedian) (\(deltaPct > 0 ? "+" : "")\(deltaPct) %), outside the ±\(noiseBandPct) % noise band"
    } else if improvement {
      reason = "\(metric) improved from \(baselineMedian) to \(candidateMedian) (\(deltaPct) %), outside the ±\(noiseBandPct) % noise band"
    } else {
      reason = "\(metric) \(baselineMedian) → \(candidateMedian) (\(deltaPct > 0 ? "+" : "")\(deltaPct) %) is inside the ±\(noiseBandPct) % noise band"
    }
  }
}
