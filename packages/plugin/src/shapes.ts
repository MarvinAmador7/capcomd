// harness.v1 shapes the hooks and primitives carry (spec §3). These mirror the daemon's zod schemas in
// src/api/contract.ts (Run, Agent, Approval) and the primitives' option types in src/primitives/ops.ts; the kernel's
// schemas stay the source of truth and test/shapes.test.ts asserts the mirrors are assignable from them.

/** RFC 3339 UTC with exactly three millisecond digits (`src/api/envelope.ts` Timestamp). */
export type Timestamp = string;

/** Agent-written text. Clients and plugins render it as plain text; never derive an action from it (§11.5). */
export interface Untrusted { text: string; untrusted: true; by: string }

/** Who acts (ADR-018 §4 plus `viewer` and `plugin`, §3). */
export type Principal =
  | { kind: "operator"; clientId: string | null }
  | { kind: "driver"; clientId: string | null }
  | { kind: "agent"; agentId: string; runId: string }
  | { kind: "viewer"; clientId: string }
  | { kind: "plugin"; name: string; scopes: readonly ("read" | "steer" | "configure")[] };

export type Budget = Partial<Record<"usd" | "turns" | "wallSeconds", number>>;

export interface Run {
  id: string;
  projectId: string | null;
  label: string | null;
  state: string;
  goal: string | null;
  title: string | null;
  repo: string | null;
  createdAt: Timestamp | null;
}

export type AgentStatus = "pending" | "running" | "paused" | "done" | "failed" | "cancelled" | "handed-off";

export interface Agent {
  id: string;
  runId: string;
  parent: string | null;
  depth: number;
  profile: string | null;
  status: AgentStatus;
  text: string;
  task: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  createdAt?: Timestamp | null;
  updatedAt: Timestamp | null;
}

/** The flat, validated agent spec pinned on an agent at spawn (`src/agents/profiles.ts` AgentSpec, `pinSpec`). v2
 *  blocks (ADR-024) resolve to the same flat shape plus `profile`. */
export interface PinnedSpec {
  provider: string;
  auth: "apikey" | "subscription";
  model?: string;
  effort?: string;
  systemPrompt?: string;
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  sandbox?: "read-only" | "workspace-write" | "danger-full-access";
  egress?: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  idleAfterMs?: number;
  stuckRepeats?: number;
  noChangeAfterMs?: number;
  checkpointEveryMs?: number;
  children?: { allowSpawn?: boolean; maxDepth?: number; maxChildren?: number; maxTotalDescendants?: number; allowedChildProfiles?: string[]; budgetShare?: number };
  /** ADR-024 `tools.mode` (§16.1): `orchestrate` agents route, plan, spawn and decide; they never edit files, run work
   *  commands or push a branch. The agent provider turns it into its CLI's tool lists; the kernel refuses a verify or
   *  merge of such an agent's own ref. Default `execute`. */
  toolMode?: "execute" | "orchestrate";
  /** ADR-024 `jobs` block (§16.2): the agent's background-job limits. */
  jobs?: { foregroundMs?: number; max?: number; afterTurnMs?: number };
  profile?: { name: string; version: number; source: "project" | "user" | "bundled" | "installed" };
}

export type ApprovalKind = "merge" | "budget" | "egress" | "secret" | "spawn_widen" | "custom";
export type ApprovalStatus = "pending" | "approved" | "denied" | "expired" | "withdrawn";

export interface Approval {
  approvalId: string;
  runId: string;
  agentId: string | null;
  kind: ApprovalKind;
  question: string;
  subject: Record<string, unknown>;
  status: ApprovalStatus;
  requestedAt: Timestamp;
  expiresAt: Timestamp | null;
}

/** harness.v1 Decision (`src/api/contract.ts`): `decidedBy` and `decidedAt` are null while pending. */
export interface Decision {
  approvalId: string;
  status: ApprovalStatus;
  decidedBy: { clientId: string; principal: string } | null;
  decidedAt: Timestamp | null;
  reason: string | null;
}

/** A verification record (`vfy-…`; `src/primitives/ops.ts` VerifyOpts, finishedVerify). */
export interface Verification {
  vfyId: string;
  runId: string;
  ref: string;
  target: string;
  check: string | null;
  state: "running" | "passed" | "failed";
  /** The commit the checks ran on (the branch put on the target) and the target commit at that time. */
  tested: { sha: string; targetSha: string } | null;
  passed: boolean | null;
  reasons: string[];
}

/** A merge record (`mrg-…`; `src/primitives/ops.ts` MergeOpts, `src/merge/types.ts` MergeOutcome). */
export interface Merge {
  mrgId: string;
  runId: string;
  ref: string;
  target: string;
  state: "running" | "merged" | "failed" | "parked";
  sha: string | null;
  pr: number | null;
  reason: string | null;
}

/** A sandbox machine (`src/providers/sandbox.ts` VmSpec). `isolated` is always true: a profile cannot ask for a
 *  machine that shares anything with the host. */
export interface VmSpec {
  idemKey: string;
  fromSnapshot?: string;
  forkOf?: string;
  size?: { vcpu: 1 | 2 | 4 | 8 };
  egressAllow: string[];
  isolated: true;
  ttlSeconds: number;
  labels: Record<string, string>;
}

/** One item of an agent's thread, as `packages/agent-thread` produces it and GET …/thread serves it (harness.v1
 *  ThreadItem). Opaque here: a plugin reads it through the agent-thread types. */
export interface ThreadItem {
  id: string;
  agentId: string;
  rev: number;
  kind: "message" | "tool_call" | "tool_result" | "reasoning" | "error" | "system";
  at: Timestamp;
  body: Record<string, unknown>;
  untrusted: true;
}

/** `stalled` is raised by a watchdog plugin through `ctx.agents.notice` (§8.4, §16.4); the kernel raises the others. */
export type AgentNotice = { kind: "idle" | "spinning" | "failing" | "quota" | "stalled"; detail: Untrusted; at: Timestamp };
export type AgentStep = { kind: string; n: number; startedAt: Timestamp; endedAt: Timestamp };
export type AgentResult = { ok: boolean; summary: Untrusted | null; claim: Untrusted | null; data: unknown; spent: Budget };

/** A skill attached to an agent's prompt or a message (`src/agents/skills.ts` AttachedSkill), pinned by hash. */
export interface AttachedSkill { name: string; hash: string; source: "builtin" | "user" | "project" | "plugin"; text: string }

/** A background job (§16.2): work that outlives the call that started it and reports back as events. `exec` runs argv
 *  in a sandbox machine (the owner agent's, or a run-owned job machine); `timer` fires at a time or on an interval. */
export type JobSpec =
  | { kind: "exec"; runId: string; owner: { agentId: string } | { run: true }; cmd: string[]; cwd?: string; env?: Record<string, string>; label: string; foregroundMs?: number; timeoutMs?: number }
  | { kind: "timer"; runId: string | null; owner: { agentId: string } | { run: true } | { plugin: true }; label: string; at?: Timestamp; everyMs?: number; until?: Timestamp };

export type JobState = "running" | "stopping" | "done" | "failed" | "killed" | "lost";
export interface Job {
  jobId: string;
  plugin: string | null;
  spec: JobSpec;
  state: JobState;
  startedAt: Timestamp;
  endedAt: Timestamp | null;
  /** exec: exit code and the tail of its output (≤ 64 KB, redacted); timer: how many times it fired. */
  result: { code: number; stdout: string; stderr: string; truncated: boolean } | { fired: number } | null;
  reason: string | null;
}

/** An external event a source plugin received (§16.3). Immutable; `(source, id)` is the dedupe key. */
export interface Trigger {
  source: string;
  id: string;
  /** The conversation it belongs to, in the source's own terms (a PR, an issue, a chat); the unit a run subscribes to. */
  thread: string;
  at: Timestamp;
  /** The sender's identity in the source's own terms (never mapped across sources). */
  actor: { id: string; display: string; bot: boolean };
  /** Whether the message addresses the agent: a mention or a direct message, or neither. */
  addressed: "mention" | "direct" | null;
  text: Untrusted;
  /** Where a reply goes, in the source's terms. */
  replyTo: string | null;
  /** Structured facts the source extracted (a CI result, a label), never used for authorization. */
  data: Record<string, unknown>;
}

/** What the kernel's intake decided about a trigger (§16.3). */
export type TriggerDecision =
  | { kind: "deduped"; first: Timestamp }
  | { kind: "denied"; by: "allowlist" | "mode" | "plugin"; reason: string }
  | { kind: "recorded"; wouldHave: "start" | "continue"; runId: string | null }
  | { kind: "started"; runId: string }
  | { kind: "continued"; runId: string; seq: number };

export interface TriggerSubscription { runId: string; source: string; thread: string; until: Timestamp }
