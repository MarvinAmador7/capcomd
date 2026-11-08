// Events the host emits about plugins (spec §13.1), on the `daemon` stream unless a run is named. These are harness.v1
// event types (`src/api/contract.ts` EventData will grow them); they are not hooks. Their names follow the one event
// type pattern (event-type.ts) and the kernel's past-tense rule: the kernel's own `plugin.*` types have two parts, so
// they never collide with a plugin's own `plugin.<name>.<event>`.
import type { HookFailureKind, PluginFailureCause } from "./errors";
import type { HookName } from "./hooks";

export interface PluginEventData {
  /** state → loading → active. */
  "plugin.loaded": { plugin: string; version: string; runtime: "in-process" | "process"; hooks: HookName[]; seams: string[]; ms: number };
  "plugin.failed": { plugin: string; version: string | null; cause: PluginFailureCause; message: string };
  "plugin.disposed": { plugin: string; cause: "daemon_stopping" | "disabled" | "breaker" | "replaced" | "failed" };
  "plugin.version_refused": { plugin: string; version: string; engines: string; capcomd: string; apiVersion: number };
  /** Two manifests of the same name; the later source is refused (§4.8). */
  "plugin.duplicate_refused": { plugin: string; kept: "builtin" | "user" | "project"; refused: "builtin" | "user" | "project"; path: string };
  /** A plugin's config failed its schema: it is failed with cause config_invalid (§10.4). */
  "plugin.config_refused": { plugin: string; errors: Array<{ path: string; message: string }>; layer: "user" | "project" | "env" | "run" | "default" };
  /** One listener call that produced no usable result (§6.5). `effect` says what the host did. */
  "plugin.hook_failed": { plugin: string; hook: HookName; callId: string; kind: HookFailureKind; message: string; effect: "denied" | "skipped" };
  /** The breaker tripped: the plugin's listeners are suspended until `capcomd plugins enable` or a restart (§6.5). */
  "plugin.suspended": { plugin: string; failures: number; lastHook: HookName };
  "plugin.resumed": { plugin: string; by: string };
  /** A gate listener denied or held an operation (on the run's stream). */
  "plugin.gate_denied": { plugin: string; hook: HookName; entity: string; decision: "deny" | "hold"; reason: string };
  /** An operator merge bypassed plugin vetoes (decision 2; on the run's stream). */
  "plugin.gate_bypassed": { hook: "merge.landing"; entity: string; by: string; plugins: Array<{ plugin: string; reason: string }> };
  /** A plugin listens to a deprecated hook, once per daemon start (§12.4). */
  "plugin.hook_deprecated": { plugin: string; hook: HookName; since: string; replacement: HookName | null };
  /** An out-of-process plugin lost its hooks stream, reconnected, or was restarted (§9.5). */
  "plugin.process_changed": { plugin: string; event: "started" | "disconnected" | "reconnected" | "exited" | "restarting"; pid: number | null; code: number | null; restarts: number };
  "plugin.trusted": { plugin: string; source: "project"; hash: string; by: string };
  /** §16.2: on the job's run stream (the daemon stream for plugin-owned timers). */
  "job.started": { jobId: string; kind: "exec" | "timer"; owner: string; label: string; plugin: string | null };
  "job.ended": { jobId: string; state: "done" | "failed" | "killed" | "lost"; code: number | null; reason: string | null; ms: number };
  /** §16.3: on the daemon stream, one per trigger the intake saw; `decision` is the audit of record-only mode. */
  "trigger.received": { source: string; id: string; thread: string; actor: string; addressed: "mention" | "direct" | null; decision: string; runId: string | null; restarted?: string; unrecorded?: string[] };
  /** `until` is null while the run works and nobody set one (it ends 14 days after the run does). */
  "trigger.subscribed": { source: string; thread: string; runId: string; until: string | null };
  "trigger.unsubscribed": { source: string; thread: string; runId: string; cause: "expired" | "unsubscribed" | "stopped" };
  /** §16.3.7: a run that ended answered its request on the request's thread, through the source's reply path. */
  "trigger.replied": { source: string; thread: string; runId: string; id: string; url: string | null };
}
export type PluginEventType = keyof PluginEventData;

/** Every type above, for tests and generated docs: a type missing here, or listed and not declared, fails typecheck. */
export const PLUGIN_EVENT_TYPES = [
  "plugin.loaded", "plugin.failed", "plugin.disposed", "plugin.version_refused", "plugin.duplicate_refused",
  "plugin.config_refused", "plugin.hook_failed", "plugin.suspended", "plugin.resumed", "plugin.gate_denied",
  "plugin.gate_bypassed", "plugin.hook_deprecated", "plugin.process_changed", "plugin.trusted",
  "job.started", "job.ended", "trigger.received", "trigger.subscribed", "trigger.unsubscribed", "trigger.replied",
] as const satisfies readonly PluginEventType[];
type Missing = Exclude<PluginEventType, (typeof PLUGIN_EVENT_TYPES)[number]>;
const _allListed: [Missing] extends [never] ? true : Missing = true;
void _allListed;
