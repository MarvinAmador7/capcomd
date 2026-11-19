import Foundation
import PerfLoopKit

/// A `.trace` embeds the recorded process's environment (tokens included: FEASIBILITY.md §1.6), so a profiled child
/// gets only what it needs to run: PerfLoop's allowlist (`TraceEnv`: the system's few, the bench's `PERFLOOP_` ones,
/// never `PERFLOOP_OWNER`) plus `profileEnv`, and never a name that looks like a secret, declared or not. It is the
/// same rule `perfloop profile` starts this bench with (ADAPTER.md §6), and PerfLoopHost's `profile` applies it again to
/// the child it records (`Bench.profileEnv`), so a bench run by hand records no more.
public enum TracePrivacy {
  /// The bench's own switches a profiled run reads beyond PerfLoop's allowlist (the manifest's `profileEnv`): the
  /// sampler (`DESKBENCH_SAMPLER=off`, the same as PerfLoopHost's `PERFLOOP_SAMPLER=off`), the hosting view's sizing
  /// (`DESKBENCH_SIZING`) and the AppKit scroll log (`DESKBENCH_APPKIT_TRACE`). Nothing secret: a name added here that
  /// looks like one is dropped anyway (DeskBenchKitTests checks none does).
  public static let profileEnv = ["DESKBENCH_SAMPLER", "DESKBENCH_SIZING", "DESKBENCH_APPKIT_TRACE"]

  /// `env` with only what a recorded process may see.
  public static func scrub(_ env: [String: String]) -> [String: String] { TraceEnv.scrub(env, declared: profileEnv) }
}
