// The hook catalog (spec §6): every hook name, its mode, payload, patch and result types, in one typed registry. A
// misspelled hook name, a wrong payload or a result of the wrong shape is a type error. The kernel fires these and
// nothing else; a plugin cannot fire a kernel hook (§6.1).
import type { Agent, AgentNotice, AgentResult, AgentStep, Approval, AttachedSkill, Budget, Decision, Job, Merge, PinnedSpec, Principal, Run, ThreadItem, Timestamp, Trigger, TriggerDecision, Untrusted, Verification, VmSpec } from "./shapes";

export type HookMode = "observe" | "veto" | "modify";

/** Shared by every result that may deny (§6.2). `reason` is shown to people as the plugin's text (untrusted). */
export type Deny = { decision: "deny"; reason: string; reasons?: string[] };
export type VetoResult = { decision: "allow" } | Deny;
export type ModifyResult<Patch> = { decision: "allow"; patch?: Patch } | Deny;
/** `merge.landing` only: `hold` parks the merge for a human approval (§6.6.15). */
export type MergeGateResult = VetoResult | { decision: "hold"; reason: string };

/** A spawn grant, as `src/primitives/policy.ts` Grant: what a parent lets a child's subtree do. Narrow-only. */
export interface Grant { allowSpawn?: boolean; maxDepth?: number; maxChildren?: number; maxTotalDescendants?: number; allowedChildProfiles?: string[]; budgetShare?: number }

// ---- payloads -------------------------------------------------------------------------------------------------

export interface DaemonStarted {
  version: string;
  api: { socket: string; capabilities: string[] };
  plugins: Array<{ name: string; version: string; runtime: "in-process" | "process"; state: "active" | "failed" | "disposed" | "validated" }>;
  sandboxes: string[];
}
export interface DaemonStopping { reason: "signal" | "operator" | "upgrade" | "error"; deadline: Timestamp }

/** `src/primitives/ops.ts` RunNewOpts and `src/api/contract.ts` CreateRunBody, resolved. `checks` are the operator's and read-only. */
export interface RunCreateOptions {
  runId: string;
  label: string | null;
  goal: Untrusted | null;
  budget: Budget;
  checks: Readonly<Record<string, string>>;
  reviewer: string | null;
  target: string | null;
  goalBranch: { branch: string; base: string } | null;
  sandbox: string | null;
  profile: string | null;
  driver: string | null;
  repo: string | null;
}
export interface RunCreating { options: RunCreateOptions }
/** `budget` may only be lowered per unit; `sandbox` must be a listed provider the run can use (§6.6.3). */
export type RunCreatePatch = { label?: string; budget?: Budget; sandbox?: string };

export type RunChange =
  | { kind: "created" } | { kind: "started" } | { kind: "paused"; by: string } | { kind: "resumed"; by: string } | { kind: "titled" }
  | { kind: "ended"; state: "completed" | "failed" | "cancelled"; reason: string | null };
export interface RunChanged { run: Run; change: RunChange }

export interface ProfileResolved {
  profile: { name: string; version: number; source: "project" | "user" | "bundled" | "installed" };
  spec: PinnedSpec;
  overrides: Readonly<Record<string, unknown>> | null;
}
/** Narrow-only (`src/agents/profiles.ts` widenings()): a patch that widens is refused with code `widening` (§6.6.5). */
export type ProfilePatch = Partial<Pick<PinnedSpec, "model" | "effort" | "allowedTools" | "disallowedTools" | "egress" | "maxTurns" | "maxBudgetUsd" | "timeoutMs" | "idleAfterMs" | "stuckRepeats" | "noChangeAfterMs" | "checkpointEveryMs" | "children">>;

/** `src/primitives/ops.ts` SpawnOpts after spawnChecks. */
export interface SpawnRequest {
  runId: string;
  parent: string | null;
  profile: string;
  task: Untrusted;
  contract: Readonly<Record<string, unknown>> | null;
  budget: Budget | null;
  grant: Grant | null;
  review: boolean;
  operator: boolean;
}
export interface AgentSpawning { spawn: SpawnRequest; spec: PinnedSpec; parent: Agent | null }
/** `budget` and `grant` narrow-only (policy.ts applyGrant); `contract` may add keys, never change one (§6.6.6). */
export type SpawnPatch = { budget?: Budget; grant?: Grant; contract?: Record<string, unknown> };

export interface AgentPreparing {
  agent: Agent;
  spec: PinnedSpec;
  prompt: { system: string | null; append: string | null; skills: AttachedSkill[] };
  /** Names of the environment variables the agent gets (never values: they may be secrets). */
  env: string[];
  egress: string[];
  credentialMode: "secret" | "env" | "subscription" | "none";
  sandbox: { provider: string; environment: string | null };
}
/** `prompt.append` is appended after the profile's own; `skills` are added; `env` adds variables (keys `^[A-Z][A-Z0-9_]*$`
 *  not already set, values that match no secret pattern); `egress` may only remove hosts (§6.6.7). */
export type PreparePatch = { prompt?: { append?: string; skills?: AttachedSkill[] }; env?: Record<string, string>; egress?: string[] };

export type AgentChange =
  | { kind: "spawned" }
  | { kind: "started"; machine: { id: string; provider: string }; attempt: number }
  | { kind: "step"; step: AgentStep }
  /** A checkpoint the in-VM supervisor took (ADR-019 §3): the progress signal a watchdog reads (§16.4). */
  | { kind: "checkpointed"; files: number; commit: string | null; at: Timestamp }
  | { kind: "notice"; notice: AgentNotice | null }
  | { kind: "paused"; by: string } | { kind: "resumed"; by: string } | { kind: "titled" }
  | { kind: "ended"; status: "done" | "failed" | "cancelled" | "handed-off"; result: AgentResult | null };
export interface AgentChanged { agent: Agent; change: AgentChange }
export interface AgentItem { agent: Pick<Agent, "id" | "runId" | "profile">; item: ThreadItem }

export interface SandboxEnsuring {
  runId: string | null;
  agentId: string | null;
  purpose: "agent" | "check" | "login" | "env_build" | "doctor" | "job";
  provider: string;
  spec: VmSpec;
}
/** `labels` adds keys (prefixed `plugin.<name>.` by the kernel); `size` may not grow; `ttlSeconds` may not grow (§6.6.10). */
export type SandboxPatch = { labels?: Record<string, string>; size?: VmSpec["size"]; ttlSeconds?: number };

export type SandboxChange = { kind: "ready"; createdMs: number } | { kind: "destroying"; reason: string } | { kind: "destroyed" };
export interface SandboxChanged { provider: string; machine: { id: string }; runId: string | null; agentId: string | null; change: SandboxChange }

export interface VerifyStarting {
  verification: Pick<Verification, "vfyId" | "runId" | "ref" | "target" | "check">;
  acceptance: unknown;
  reviewer: string | null;
  requestedBy: Principal;
}
/** Only `acceptance` (§6.6.12); the checks are the operator's (ADR-017 §2). */
export type VerifyPatch = { acceptance?: unknown };

export interface VerifyJudging {
  verification: Verification & { tested: NonNullable<Verification["tested"]> };
  acceptance: unknown;
  /** The task the change was made for (the verified agent's), when known. */
  task: Untrusted | null;
  reviewer: string | null;
}

export type VerifyChange =
  | { kind: "started" }
  | { kind: "checked"; passed: boolean; where: "vm" | "host" | "reused" | "none"; excerpt: string | null }
  | { kind: "judged"; by: string; passed: boolean; reasons: string[] }
  | { kind: "finished"; passed: boolean };
export interface VerifyChanged { verification: Verification; change: VerifyChange }

export interface MergeLanding {
  merge: Merge;
  verification: Verification | null;
  target: { branch: string; protected: boolean; sha: string };
  sha: string;
  fastPath: boolean;
  operator: boolean;
  requestedBy: Principal;
}

export type MergeChange =
  | { kind: "requested" }
  | { kind: "landed"; sha: string; pr: number | null; bypassedVetoes: Array<{ plugin: string; reason: string }> }
  | { kind: "failed"; reason: string }
  | { kind: "parked"; approvalId: string };
export interface MergeChanged { merge: Merge; change: MergeChange }

export type JobChange =
  | { kind: "started" }
  /** Output since the last frame (exec jobs; coalesced to at most one frame per second, ≤ 16 KB). */
  | { kind: "output"; stdout: string; stderr: string }
  | { kind: "fired"; n: number }
  | { kind: "ended"; state: "done" | "failed" | "killed" | "lost" };
export interface JobChanged { job: Job; change: JobChange }

/** The kernel's gate already ran: `gate` says what it found. A listener may only deny (§16.3.3). */
export interface TriggerAdmitting {
  trigger: Trigger;
  gate: { allowed: boolean; strength: "explicit" | "inferred"; mode: "off" | "observe" | "auto"; subscribed: { runId: string } | null };
}
export interface TriggerChanged { trigger: Trigger; decision: TriggerDecision }

export interface ApprovalDeciding { approval: Approval; decision: "approve" | "deny"; by: Principal; reason: string | null }
export type ApprovalChange = { kind: "requested" } | { kind: "decided"; decision: Decision } | { kind: "expired" } | { kind: "withdrawn" };
export interface ApprovalChanged { approval: Approval; change: ApprovalChange }

// ---- the registry -----------------------------------------------------------------------------------------------

/** Name → mode, payload, patch (modify only) and result. The single place a hook's types live. */
export interface HookTable {
  "daemon.started": { mode: "observe"; payload: DaemonStarted; patch: never; result: void };
  "daemon.stopping": { mode: "observe"; payload: DaemonStopping; patch: never; result: void };
  "run.creating": { mode: "modify"; payload: RunCreating; patch: RunCreatePatch; result: ModifyResult<RunCreatePatch> };
  "run.changed": { mode: "observe"; payload: RunChanged; patch: never; result: void };
  "profile.resolved": { mode: "modify"; payload: ProfileResolved; patch: ProfilePatch; result: ModifyResult<ProfilePatch> };
  "agent.spawning": { mode: "modify"; payload: AgentSpawning; patch: SpawnPatch; result: ModifyResult<SpawnPatch> };
  "agent.preparing": { mode: "modify"; payload: AgentPreparing; patch: PreparePatch; result: ModifyResult<PreparePatch> };
  "agent.changed": { mode: "observe"; payload: AgentChanged; patch: never; result: void };
  "agent.item": { mode: "observe"; payload: AgentItem; patch: never; result: void };
  "sandbox.ensuring": { mode: "modify"; payload: SandboxEnsuring; patch: SandboxPatch; result: ModifyResult<SandboxPatch> };
  "sandbox.changed": { mode: "observe"; payload: SandboxChanged; patch: never; result: void };
  "verify.starting": { mode: "modify"; payload: VerifyStarting; patch: VerifyPatch; result: ModifyResult<VerifyPatch> };
  "verify.judging": { mode: "veto"; payload: VerifyJudging; patch: never; result: VetoResult };
  "verify.changed": { mode: "observe"; payload: VerifyChanged; patch: never; result: void };
  "merge.landing": { mode: "veto"; payload: MergeLanding; patch: never; result: MergeGateResult };
  "merge.changed": { mode: "observe"; payload: MergeChanged; patch: never; result: void };
  "approval.deciding": { mode: "veto"; payload: ApprovalDeciding; patch: never; result: VetoResult };
  "approval.changed": { mode: "observe"; payload: ApprovalChanged; patch: never; result: void };
  "job.changed": { mode: "observe"; payload: JobChanged; patch: never; result: void };
  "trigger.admitting": { mode: "veto"; payload: TriggerAdmitting; patch: never; result: VetoResult };
  "trigger.changed": { mode: "observe"; payload: TriggerChanged; patch: never; result: void };
}
export type HookName = keyof HookTable;
export type HookPayload<N extends HookName> = HookTable[N]["payload"];
export type HookPatch<N extends HookName> = HookTable[N]["patch"];
export type HookResult<N extends HookName> = HookTable[N]["result"];
export type HookModeOf<N extends HookName> = HookTable[N]["mode"];

/** Runtime facts about a hook the host enforces (§6.4, §6.5). `satisfies` ties it to the table. */
export interface HookMeta {
  mode: HookMode;
  /** A gate hook fails closed whatever the manifest says (§6.5). */
  gate: boolean;
  /** Default and maximum listener deadline, in ms (§6.4). */
  timeoutMs: { default: number; max: number };
  /** How often it fires for one entity: once per kernel decision, or many times. Observe hooks may repeat after a replay (§6.7). */
  fires: "once" | "many";
  /** Version of the payload shape (§12.3). */
  payloadVersion: 1;
}

export const HOOKS = {
  "daemon.started": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "daemon.stopping": { mode: "observe", gate: false, timeoutMs: { default: 5_000, max: 10_000 }, fires: "once", payloadVersion: 1 },
  "run.creating": { mode: "modify", gate: false, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "run.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "profile.resolved": { mode: "modify", gate: false, timeoutMs: { default: 10_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "agent.spawning": { mode: "modify", gate: false, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "agent.preparing": { mode: "modify", gate: false, timeoutMs: { default: 10_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "agent.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "agent.item": { mode: "observe", gate: false, timeoutMs: { default: 5_000, max: 30_000 }, fires: "many", payloadVersion: 1 },
  "sandbox.ensuring": { mode: "modify", gate: false, timeoutMs: { default: 10_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "sandbox.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "verify.starting": { mode: "modify", gate: true, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "verify.judging": { mode: "veto", gate: true, timeoutMs: { default: 1_800_000, max: 3_600_000 }, fires: "once", payloadVersion: 1 },
  "verify.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "merge.landing": { mode: "veto", gate: true, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "merge.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "approval.deciding": { mode: "veto", gate: true, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "approval.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
  "job.changed": { mode: "observe", gate: false, timeoutMs: { default: 5_000, max: 30_000 }, fires: "many", payloadVersion: 1 },
  "trigger.admitting": { mode: "veto", gate: true, timeoutMs: { default: 10_000, max: 60_000 }, fires: "once", payloadVersion: 1 },
  "trigger.changed": { mode: "observe", gate: false, timeoutMs: { default: 30_000, max: 60_000 }, fires: "many", payloadVersion: 1 },
} as const satisfies { [N in HookName]: HookMeta & { mode: HookModeOf<N> } };

export const HOOK_NAMES: readonly HookName[] = Object.keys(HOOKS) as HookName[];

/** The hooks of one mode. */
export type HooksOfMode<M extends HookMode> = { [N in HookName]: HookModeOf<N> extends M ? N : never }[HookName];
export type ObserveHook = HooksOfMode<"observe">;
export type VetoHook = HooksOfMode<"veto">;
export type ModifyHook = HooksOfMode<"modify">;

/** The top-level keys a `modify` patch may carry, per hook (§6.6). A patch with any other key is an `invalid_result`;
 *  whether the values only narrow is the kernel's check at the call site (a widening is refused with `widening`). */
export const PATCH_KEYS = {
  "run.creating": ["label", "budget", "sandbox"],
  "profile.resolved": ["model", "effort", "allowedTools", "disallowedTools", "egress", "maxTurns", "maxBudgetUsd", "timeoutMs", "idleAfterMs", "stuckRepeats", "noChangeAfterMs", "checkpointEveryMs", "children"],
  "agent.spawning": ["budget", "grant", "contract"],
  "agent.preparing": ["prompt", "env", "egress"],
  "sandbox.ensuring": ["labels", "size", "ttlSeconds"],
  "verify.starting": ["acceptance"],
} as const satisfies { [N in ModifyHook]: ReadonlyArray<keyof HookPatch<N>> };

/** One invocation of a listener (§6.1). The same object shape travels on the wire out of process (§9.4). */
export interface HookCall<N extends HookName = HookName> {
  /** Unique per invocation. */
  callId: string;
  hook: N;
  mode: HookModeOf<N>;
  payloadVersion: 1;
  /** Stable across kernel replays of the same decision (§6.7): `<hook>:<entity id>:<attempt>`. */
  idempotencyKey: string;
  /** Absolute deadline; after it the host applies the failure policy whatever the listener returns. */
  deadline: Timestamp;
  /** Aborted at the deadline and when the plugin disposes. In-process only; out of process the deadline is the signal. */
  signal: AbortSignal;
  trace: { traceId: string; spanId: string };
  /** Who caused the operation (never the plugin itself). */
  principal: Principal;
  runId: string | null;
  agentId: string | null;
  at: Timestamp;
  /** Set while the hook is deprecated (§12.4). */
  deprecated?: { since: string; replacement: HookName | null };
  payload: HookPayload<N>;
}

export type HookListener<N extends HookName> = (call: HookCall<N>) => HookResult<N> | Promise<HookResult<N>>;
