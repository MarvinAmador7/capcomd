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
  // `ab`'s paired verdict (init(metric:pairs:)); nil in `compare` and `run --baseline`, and in older results.
  /// Two-sided Mann-Whitney U p-value of the two sides (exact).
  public var pValue: Double? = nil
  /// Complete A/B pairs the verdict used, and in how many of them B was worse / better.
  public var pairs: Int? = nil
  public var worsePairs: Int? = nil
  public var betterPairs: Int? = nil
  /// Beyond the band but p ≥ 0.05: neither a regression nor an improvement yet; more pairs would decide.
  public var unsure: Bool? = nil

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

extension Regression {
  /// `ab`'s verdict from A/B pairs (one run of each build per pair, back to back, the first side counterbalanced). The
  /// effect is the median of the per-pair differences B − A, so drift that moves both runs of a pair (the machine
  /// getting busier) cancels; the band is max(1.4826 × MAD of those differences, `floorPct` of A's median,
  /// `absoluteFloor`); a change counts only when the Mann-Whitney U test on the two sides also gives p < `alpha`
  /// (SPEC §5.1; 5 v 5 can reach 0.008). Beyond the band at p ≥ `alpha` is `unsure`: run more pairs.
  public init(metric: String, pairs ps: [(a: Double, b: Double)], higherIsWorse: Bool = true, floorPct: Double = 10, absoluteFloor: Double = 0, alpha: Double = 0.05) {
    let a = ps.map(\.a), b = ps.map(\.b), d = ps.map { $0.b - $0.a }
    self.init(metric: metric, baseline: a, candidate: b, higherIsWorse: higherIsWorse, floorPct: floorPct, absoluteFloor: absoluteFloor)
    let base = Stats.median(a), effect = Stats.median(d)
    let band = max(Stats.mad(d) * 1.4826, abs(base) * floorPct / 100, absoluteFloor)
    noiseBandPct = base == 0 ? (band == 0 ? 0 : 100) : Stats.round(band / abs(base) * 100, 1)
    deltaPct = base == 0 ? (effect == 0 ? 0 : 100) : Stats.round(effect / abs(base) * 100, 1)
    let p = RankTests.mannWhitneyP(a, b)
    let worse = higherIsWorse ? effect : -effect
    let w = d.filter { higherIsWorse ? $0 > 0 : $0 < 0 }.count, bt = d.filter { higherIsWorse ? $0 < 0 : $0 > 0 }.count
    pValue = Stats.round(p, 4); pairs = ps.count; worsePairs = w; betterPairs = bt
    regression = worse > band && p < alpha
    improvement = -worse > band && p < alpha
    unsure = abs(worse) > band && p >= alpha
    let moved = "\(metric) \(baselineMedian) → \(candidateMedian) (\(deltaPct > 0 ? "+" : "")\(deltaPct) % per pair, B worse in \(w) of \(ps.count) pairs, p = \(Stats.round(p, 3)))"
    if ps.count < 3 {
      reason = "\(moved): fewer than 3 pairs, the band is a guess"
    } else if regression {
      reason = "\(moved), outside the ±\(noiseBandPct) % noise band"
    } else if improvement {
      reason = "\(moved), outside the ±\(noiseBandPct) % noise band"
    } else if unsure == true {
      reason = "\(moved): outside the ±\(noiseBandPct) % band but not significant (p ≥ \(alpha)); more pairs would decide"
    } else {
      reason = "\(moved) is inside the ±\(noiseBandPct) % noise band"
    }
  }
}

/// Rank tests for small samples, exact (no normal approximation): what a handful of repetitions on a busy machine can
/// and can't show.
public enum RankTests {
  /// Two-sided Mann-Whitney U (Wilcoxon rank-sum) p-value, exact and conditional on ties (mid-ranks): the share of the
  /// ways to split the pooled values into groups of these sizes whose rank sum lies at least as far from its mean as
  /// the observed one. 1 when either side is empty.
  public static func mannWhitneyP(_ a: [Double], _ b: [Double]) -> Double {
    let n = a.count, m = b.count, total = n + m
    guard n > 0, m > 0 else { return 1 }
    // Doubled mid-ranks are integers.
    let pooled = (a.map { ($0, 0) } + b.map { ($0, 1) }).sorted { $0.0 < $1.0 }
    var ranks = [Int](repeating: 0, count: total)
    var i = 0
    while i < total {
      var j = i
      while j + 1 < total, pooled[j + 1].0 == pooled[i].0 { j += 1 }
      for k in i...j { ranks[k] = i + j + 2 }   // 2 × the mean of ranks i+1 … j+1
      i = j + 1
    }
    let observed = zip(pooled, ranks).filter { $0.0.1 == 0 }.reduce(0) { $0 + $1.1 }
    let maxSum = ranks.reduce(0, +)
    // ways[k][s]: subsets of k of the pooled values with doubled rank sum s.
    var ways = [[Double]](repeating: [Double](repeating: 0, count: maxSum + 1), count: n + 1)
    ways[0][0] = 1
    for r in ranks {
      for k in stride(from: min(n, total), through: 1, by: -1) {
        for s in stride(from: maxSum, through: r, by: -1) where ways[k - 1][s - r] > 0 { ways[k][s] += ways[k - 1][s - r] }
      }
    }
    let mean = Double(n) * Double(total + 1)   // doubled
    let dist = abs(Double(observed) - mean)
    var tail = 0.0, all = 0.0
    for (s, w) in ways[n].enumerated() where w > 0 {
      all += w
      if abs(Double(s) - mean) >= dist - 1e-9 { tail += w }
    }
    return all > 0 ? min(1, tail / all) : 1
  }

  /// Two-sided sign test: how likely a split at least this uneven is when each pair is a coin flip.
  public static func signP(worse: Int, better: Int) -> Double {
    let n = worse + better, k = min(worse, better)
    guard n > 0 else { return 1 }
    var c = 1.0, tail = 0.0
    for i in 0...k { if i > 0 { c = c * Double(n - i + 1) / Double(i) }; tail += c }
    return min(1, 2 * tail / pow(2, Double(n)))
  }
}
