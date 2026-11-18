import Foundation
import PerfLoopKit

/// A `.trace` embeds the recorded process's environment (tokens included: FEASIBILITY.md §1.6), so a profiled child
/// gets only what it needs to run: PerfLoop's allowlist (`TraceEnv`: the system's few, the bench's `PERFLOOP_` ones,
/// never `PERFLOOP_OWNER`) plus `profileEnv`, and never a name that looks like a secret, declared or not. It is the
/// same rule `perfloop profile` starts this bench with (ADAPTER.md §6), applied again to the environment the bench was
/// given (never one rebuilt from a login shell or a config file), so a bench run by hand records no more.
public enum TracePrivacy {
  /// The bench's own switches a profiled run reads beyond PerfLoop's allowlist (the manifest's `profileEnv`): the
  /// sampler (`DESKBENCH_SAMPLER=off`), the hosting view's sizing (`DESKBENCH_SIZING`), the scene's menu commands
  /// (`DESKBENCH_NO_COMMANDS`), and the swipe and AppKit scroll logs (`DESKBENCH_SWIPE_TRACE`, `DESKBENCH_APPKIT_TRACE`).
  /// Nothing secret: a name added here that looks like one is dropped anyway (DeskBenchKitTests checks none does).
  public static let profileEnv = ["DESKBENCH_SAMPLER", "DESKBENCH_SIZING", "DESKBENCH_NO_COMMANDS", "DESKBENCH_SWIPE_TRACE", "DESKBENCH_APPKIT_TRACE"]

  /// `env` with only what a recorded process may see.
  public static func scrub(_ env: [String: String]) -> [String: String] { TraceEnv.scrub(env, declared: profileEnv) }

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
