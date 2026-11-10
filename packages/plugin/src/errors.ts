// Named errors (spec §5.6, §8.3). Every error a plugin can see or raise through the API is one of these codes; the
// relay.v1 envelope (`src/core/errors.ts` RelayError) carries `code` and `hint`, and `reason: "plugin:<name>"` when a
// plugin denied a gate.

export const PLUGIN_ERROR_CODES = [
  /** The call needs a scope the plugin's principal lacks (§11.1). */
  "forbidden",
  /** The primitive is not reachable from this runtime (today: a `ctx` call with no harness.v1 route, out of process; §9.6). */
  "unsupported",
  /** A `modify` result widened something the kernel only narrows (§6.2). Never retryable. */
  "widening",
  /** The payload's shape or a result's shape failed validation. */
  "invalid",
  /** A registration collides with another plugin's or the kernel's (§4.7). */
  "conflict",
  /** The named run, agent, approval, key or resource does not exist. */
  "not_found",
  /** The plugin is disposing: `ctx.signal` is aborted and new calls are refused. */
  "disposed",
  /** The deadline passed (`HookCall.deadline`, a primitive's `timeoutMs`), or a primitive's `signal` aborted (§8.2). */
  "timeout",
  /** The kernel could not do it now (the engine is unreachable, a provider did not answer); `retryable` is true. */
  "unavailable",
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

export class PluginError extends Error {
  override readonly name = "PluginError";
  constructor(readonly code: PluginErrorCode, message: string, readonly hint?: string, readonly retryable = false) {
    super(message);
  }
}

/** Why a hook listener's call did not produce a usable result (§6.5; event `plugin.hook_failed`). */
export type HookFailureKind = "timeout" | "threw" | "crashed" | "invalid_result" | "disconnected" | "suspended";

/** A listener's call that failed for a reason the host knows, not the listener's own throw: an out-of-process plugin's
 *  process exited with the call in flight (`crashed`) or its hooks stream is gone (`disconnected`, §9.5). The registry
 *  records its `kind` instead of `threw`. */
export class HookFailure extends Error {
  override readonly name = "HookFailure";
  constructor(readonly kind: HookFailureKind, message: string) {
    super(message);
  }
}

/** Why a plugin is `failed` (§5.4; event `plugin.failed`). */
export type PluginFailureCause =
  | "invalid_manifest" | "incompatible" | "duplicate" | "untrusted" | "disabled"
  | "unresolved" | "cycle" | "seam_conflict" | "config_invalid"
  | "activate_threw" | "activate_timeout" | "conflict" | "handshake_timeout" | "crashed" | "restart_limit"
  | "dispose_timeout";
