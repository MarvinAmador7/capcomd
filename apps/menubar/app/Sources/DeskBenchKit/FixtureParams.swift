import Foundation

// Parametric fixtures (CAPABILITIES.md C8): any generated fixture with some of its numbers changed, named
// `NAME@key=value,key=value` (`crew@agents=24,items=100`). That is how `perfloop sweep` reaches the generator
// through `--fixture` (manifest protocol 1: the fixture entry's `parametric` lists the keys and their ranges), and
// the name travels unchanged into the result's `fixture`, so every point of a sweep says what it ran on.

extension Fixtures {
  /// The keys a fixture name may set and the values each accepts. `items` is per thread: `items=100` is 80–120
  /// (± 20 %, so threads differ as they do in a run), `items=40-60` an explicit range. `seed` replaces the seed.
  public static let parameterRanges: [String: [Int]] = ["agents": [1, 128], "items": [1, 2000], "projects": [1, 8], "asks": [0, 8], "seed": [0, 1_000_000]]

  /// The base name, the spec with the parameters applied, and a seed if one was given; nil for an unknown base, an
  /// unknown key or a value out of range (`problem` says which).
  public static func resolve(_ name: String) -> (base: String, spec: FixtureSpec, seed: UInt64?)? {
    guard case .success(let r) = parse(name) else { return nil }
    return r
  }

  /// Why `name` names no fixture, or nil when it does.
  public static func problem(_ name: String) -> String? {
    if name.hasPrefix(CapturedFixture.prefix) {
      do { _ = try CapturedFixture.world(name); return nil } catch { return "\(error)" }
    }
    if case .failure(let e) = parse(name) { return e.description }
    return nil
  }

  struct ParamError: Error, CustomStringConvertible { var description: String }

  static func parse(_ name: String) -> Result<(base: String, spec: FixtureSpec, seed: UInt64?), ParamError> {
    let parts = name.split(separator: "@", maxSplits: 1).map(String.init)
    let base = parts.first ?? name
    guard var spec = all.first(where: { $0.name == base }) else {
      return .failure(ParamError(description: "unknown fixture '\(base)'; see `deskbench list fixtures` (or file:PATH for a captured one)"))
    }
    guard parts.count == 2 else { return .success((base, spec, nil)) }
    var seed: UInt64?
    for kv in parts[1].split(separator: ",") {
      let p = kv.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      guard p.count == 2, let range = parameterRanges[p[0]] else {
        return .failure(ParamError(description: "fixture \(base): '\(kv)' is not one of \(parameterRanges.keys.sorted().map { "\($0)=N" }.joined(separator: ", "))"))
      }
      let (k, v) = (p[0], p[1])
      func number(_ s: String) -> Int? { Int(s).flatMap { $0 >= range[0] && $0 <= range[1] ? $0 : nil } }
      let bad = ParamError(description: "fixture \(base): \(k)=\(v) is outside \(range[0])…\(range[1])")
      switch k {
      case "items":
        let lohi = v.split(separator: "-", maxSplits: 1).map(String.init)
        if lohi.count == 2 {
          guard let lo = number(lohi[0]), let hi = number(lohi[1]), lo <= hi else { return .failure(bad) }
          spec.itemsPerThread = lo...hi
        } else {
          guard let n = number(v) else { return .failure(bad) }
          spec.itemsPerThread = max(1, n * 4 / 5)...max(1, (n * 6 + 4) / 5)
        }
      case "agents": guard let n = number(v) else { return .failure(bad) }; spec.openAgents = n
      case "projects": guard let n = number(v) else { return .failure(bad) }; spec.projects = n
      case "asks": guard let n = number(v) else { return .failure(bad) }; spec.asks = n
      case "seed": guard let n = number(v) else { return .failure(bad) }; seed = UInt64(n)
      default: return .failure(bad)
      }
    }
    // Asks land on workers: a tree too small for them has fewer.
    spec.asks = min(spec.asks, tree(count: spec.openAgents, run: "run-x-1").filter { $0.profile == "worker" }.count)
    spec.name = name
    spec.summary = "\(base) with \(parts[1]): \(spec.openAgents) agents, \(spec.itemsPerThread.lowerBound)–\(spec.itemsPerThread.upperBound) items a thread, \(spec.projects) project(s), \(spec.asks) ask(s)"
    return .success((base, spec, seed))
  }
}
