import Foundation
#if canImport(CryptoKit)
import CryptoKit
#endif
#if canImport(Darwin)
import Darwin
#endif

// Where a number came from: which binary (the build stamp, perfloop.build/1), how many instructions the process retired,
// and what a profiled child may see of the environment.

/// The `build` block (perfloop.build/1): what was compiled, read from the stamp the BuildStamp plugin writes into the
/// binary (Plugins/BuildStamp), never from the cwd, so a copied binary still says which commit it is.
public struct BuildInfo: Codable, Sendable, Equatable {
  /// sha256 of the executable file.
  public var hash: String?
  public var commit: String?
  /// Uncommitted changes in the package's tracked sources at build time. Unknown (no git) counts as dirty.
  public var dirty: Bool
  /// The tracked sources' tree hash plus the uncommitted diff: two clean builds of one commit agree.
  public var sourceHash: String?
  public var builtAt: String?
  public var configuration: String
  public var toolchain: String?
  /// false for a binary with no stamp in it (built before the plugin, or with the plugin's output missing).
  public var stamp: Bool

  public init(hash: String?, commit: String?, dirty: Bool, sourceHash: String?, builtAt: String?, configuration: String, toolchain: String?, stamp: Bool) {
    self.hash = hash; self.commit = commit; self.dirty = dirty; self.sourceHash = sourceHash; self.builtAt = builtAt
    self.configuration = configuration; self.toolchain = toolchain; self.stamp = stamp
  }

  /// Decodes the plugin's `key=value` lines. Empty values are unknown; a missing or unreadable `dirty` is dirty.
  public init(stamp text: String?, configuration: String, hash: String?) {
    var kv: [String: String] = [:]
    for line in (text ?? "").split(whereSeparator: \.isNewline) {
      let p = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if p.count == 2, !p[1].isEmpty { kv[p[0]] = p[1] }
    }
    self.init(hash: hash, commit: kv["commit"], dirty: kv["dirty"].map { $0 != "0" && $0 != "false" } ?? true, sourceHash: kv["sourceHash"],
              builtAt: kv["builtAt"], configuration: configuration, toolchain: kv["toolchain"], stamp: !kv.isEmpty)
  }

  /// "9bcd41a (dirty) · release · built 2026-10-30T15:31:02Z".
  public var line: String {
    var s = (commit ?? "unknown commit") + (dirty ? " (dirty)" : "") + " · \(configuration)"
    if let b = builtAt { s += " · built \(b)" }
    if !stamp { s += " · no build stamp" }
    return s
  }

  /// `sha256:<hex>` of a file, mapped rather than read (the bench binary is ~50 MB).
  public static func sha256(file path: String) -> String? {
    #if canImport(CryptoKit)
    guard let d = try? Data(contentsOf: URL(fileURLWithPath: path), options: .alwaysMapped) else { return nil }
    return "sha256:" + SHA256.hash(data: d).map { String(format: "%02x", $0) }.joined()
    #else
    return nil
    #endif
  }
}

/// Hardware counters the kernel keeps per process, readable as a normal user (design/perf-loop/probes/rusage).
public enum ProcessCounters {
  /// Instructions retired by this process (all threads) so far; nil where the call fails, 0 where the counters aren't
  /// kept (a VM).
  public static func instructions() -> UInt64? {
    #if canImport(Darwin)
    var info = rusage_info_v4()
    // libproc declares the buffer as `rusage_info_t *` (void **) but writes the struct at the pointer passed: hand it
    // the struct's own address (a pointer to a pointer overruns the stack).
    let rc = withUnsafeMutablePointer(to: &info) { p -> Int32 in
      p.withMemoryRebound(to: rusage_info_t?.self, capacity: MemoryLayout<rusage_info_v4>.size / MemoryLayout<rusage_info_t?>.size) {
        proc_pid_rusage(getpid(), RUSAGE_INFO_V4, $0)
      }
    }
    return rc == 0 ? info.ri_instructions : nil
    #else
    return nil
    #endif
  }
}

/// A `.trace` embeds the recorded process's environment (tokens included: FEASIBILITY.md §1.6), so a profiled child
/// gets only what it needs to run.
public enum TracePrivacy {
  public static let allowedKeys: Set<String> = ["HOME", "USER", "LOGNAME", "PATH", "SHELL", "TMPDIR", "LANG", "TERM", "__CF_USER_TEXT_ENCODING", "DEVELOPER_DIR"]
  public static let allowedPrefixes = ["LC_", "DESKBENCH_"]
  public static func scrub(_ env: [String: String]) -> [String: String] {
    env.filter { k, _ in allowedKeys.contains(k) || allowedPrefixes.contains { k.hasPrefix($0) } }
  }
  /// The git checkout a path is inside, if any (a trace there is one `git add .` from being published).
  public static func checkout(containing path: String) -> String? {
    var u = URL(fileURLWithPath: path).standardizedFileURL.deletingLastPathComponent()
    while u.path != "/" && !u.path.isEmpty {
      if FileManager.default.fileExists(atPath: u.appendingPathComponent(".git").path) { return u.path }
      u = u.deletingLastPathComponent()
    }
    return nil
  }
  public static func warning(trace: String) -> String {
    var s = "deskbench: warning: \(trace) holds the recorded process's environment and paths (a trace can carry tokens): never commit, publish or attach it"
    if let c = checkout(containing: trace) { s += "; it is inside the git checkout \(c), move it out" }
    return s
  }
}
