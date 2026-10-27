// Payloads of today's scope events (src/actors/scope.ts addEvent), keyed by their harness.v1 dotted name.
// Two views of one shape table:
//  - LegacyEventData (published in openapi/docs): loose, so older clients tolerate new fields (§6.2: new fields don't bump the version).
//  - strictEventData (daemon side): the daemon validates what it emits, so an undeclared field fails in tests.
// SCOPE_EVENT_TYPES is the closed list scope.ts may emit (addEvent's `type` is typed by it), and
// tests/api/legacy-events.test.ts fails when a type has no schema.
import { z } from "zod";
import { AttachmentRef } from "./inline-cap";
import { AgentWorkspace } from "./workspace";

/** Text written by an agent or worker. Render as plain text only: never as markdown, links or actions. */
export const UntrustedText = z.string().meta({ "x-untrusted": true, description: "Agent-written text: render as plain text, never markdown, links or actions" });

const S = z.string(), N = z.number(), nS = z.string().nullable(), U = z.unknown(), T = UntrustedText, nT = UntrustedText.nullable();
const task = { taskId: S, holder: S, epoch: N };
const budget = { add: U, budget: U, by: U };
/** agent.done / agent.failed `result`. Every text field is agent-written. Unknown fields may appear (the agent's declared result bag). */
export const AgentResult = z.looseObject({
	summary: nT.optional(),
	report: nT.optional(),
	error: nT.optional(),
	data: U.optional(),
	verdict: U.optional(),
	branch: nS.optional(),
	commit: nS.optional(),
	costUsd: N.optional(),
	notionalCostUsd: N.optional(),
	turns: N.optional(),
	wallSeconds: N.optional(),
	billing: S.optional(),
	handoffTo: S.optional(),
	exitCode: N.optional(),
	adopted: z.boolean().optional(),
	limit: U.optional(),
	verification: U.optional(),
}).meta({ "x-untrusted": true, description: "Agent-written text: the agent's declared result. Render every string as plain text, never markdown, links or actions" });
const finish = { result: AgentResult, spent: U, budget: U };
/** Which AI provider an agent runs on (harness.v1 Agent.provider, agent.spawned agent.provider). */
export const AgentProvider = z.enum(["claude", "codex"]);
/** agent.spawned `agent`: the agent's profile as resolved at spawn (provider, auth, limits, …) plus the runner the daemon
 * chose. Open: other profile fields come along, and may be added. */
export const SpawnedAgent = z.looseObject({
	kind: z.enum(["fake", "claude-code", "codex"]).optional().describe("The runner: claude-code, codex, or fake (a local stand-in with no AI provider)"),
	provider: AgentProvider.optional().describe("The profile's provider; absent when the agent was chosen by CAPCOMD_AGENT without a profile (then see kind)"),
	model: z.string().nullable().optional().describe("The model it runs with (CAPCOMD_AGENT_MODEL, else the profile's); absent or null: the provider CLI's default"),
	effort: z.string().nullable().optional().describe("The reasoning effort it runs with (CAPCOMD_AGENT_EFFORT, else the profile's or the run's chosen level); absent or null: the provider CLI's default"),
}).describe("The agent's resolved profile and runner; null on events from daemons that recorded none");
/** Set on lifecycle-feed copies of state-change events (GET /v1/runs/{runId}/lifecycle, ?feed=lifecycle): trusted reason code. */
const cause = { cause: S.optional().describe("Lifecycle feed only: why the state changed (trusted code, see LifecycleCause)") };
const kv = { k: S, version: N, writer: S.optional() };

/** Every type scope.ts emits. Adding one here without a schema fails the guard test; emitting one not listed fails typecheck. */
export const SCOPE_EVENT_TYPES = [
	"RUN_NEW", "RUN_GRANTED",
	"AGENT_SPAWNED", "AGENT_STARTED", "AGENT_DONE", "AGENT_FAILED", "AGENT_CHECKPOINT", "AGENT_NOTICE", "AGENT_NOTICE_CLEARED",
	"AGENT_PAUSED", "AGENT_RESUMED", "AGENT_GRANTED", "AGENT_ADOPTED", "AGENT_REAPED", "AGENT_CANCELLED",
	"DEADLOCK_DETECTED", "DRIVE_FAILED", "TOKEN_REVOKED", "MESSAGE_SENT",
	"VERIFY_STARTED", "VERIFY_PASSED", "VERIFY_FAILED", "MERGE_STARTED", "MERGED", "MERGE_FAILED",
	"MERGE_AWAITING_APPROVAL", "MERGE_APPROVED", "MERGE_DENIED",
	"TASK_ADDED", "TASK_CLAIMED", "TASK_LEASE_EXPIRED", "TASK_DONE", "TASK_RELEASED",
	"KV_PUT", "KV_DELETE", "KV_CAS",
] as const;
export type ScopeEventType = (typeof SCOPE_EVENT_TYPES)[number];

/** Op events carry the op's own data/result bag after `id`; those stay open even on the daemon side. */
const OPEN = new Set(["verify.started", "merge.started", "verify.passed", "verify.failed", "merge.succeeded", "merge.failed"]);

export const LegacyEventShapes = {
	"run.created": { budget: U, label: nS, goal: nT.optional(), ...cause },
	"run.granted": budget,
	"agent.spawned": { parent: nS, depth: N, profile: nS.describe("Profile name, lowercase (same type as Agent.profile)"), budget: U, limits: U, agent: SpawnedAgent.nullable(), task: nT.describe("Task text, inline when ≤ 64 KB (UTF-8); null when stored as `taskAttachment`"), taskAttachment: AttachmentRef.nullable().optional(), key: nS, operator: z.boolean(), review: z.boolean().optional(), grant: U.optional(), workspace: AgentWorkspace.nullable().optional(), ...cause },
	"agent.started": { ...cause },
	"agent.done": { ...finish, ...cause },
	"agent.failed": { ...finish, ...cause },
	"agent.checkpointed": { ref: S, sha: S, at: N, reason: T, files: N },
	"agent.notice_raised": { kind: S, detail: T, at: N },
	"agent.notice_cleared": { kind: nS },
	"agent.paused": { result: U.describe("Why: limit \"quota\" (a provider usage limit; resetAt, login) or \"paused\" (the operator: `by` is operator or client:<id>); branch/commit: the work it kept"), until: U.describe("When it resumes by itself (epoch ms); null when it waits for a resume"), ...cause },
	"agent.resumed": { epoch: N, by: nS, ...cause },
	"agent.granted": budget,
	"agent.adopted": { from: S, to: S },
	"agent.reaped": { orphanOf: S, parentStatus: S, ...cause },
	"agent.cancelled": { reason: nT, by: S, ...cause },
	"deadlock.detected": { cycle: z.array(S) },
	"drive.failed": { kind: S, error_kind: S, message: T, attempt: N, driver: U, consecutive: N },
	"token.revoked": { jti: S, reason: nT },
	"message.sent": { to: U, seq: N, bytes: N, text: nT.describe("Message body, inline when ≤ 64 KB (UTF-8); null when stored as `attachment`"), attachment: AttachmentRef.nullable().describe("Set when the body is over 64 KB: the full body is stored as this attachment"), skills: z.array(S).optional().describe("Names of the skills sent with the message (POST …/messages `skills`, `capcomd send --skill`); the agent got each one's SKILL.md with it. Empty when none; absent on events from before skill attach") },
	"verify.started": { id: S },
	"verify.passed": { id: S },
	"verify.failed": { id: S },
	"merge.started": { id: S },
	"merge.succeeded": { id: S },
	"merge.failed": { id: S },
	"merge.approval_requested": { id: S, target: U, ref: U, reason: T.nullable().optional() },
	"merge.approved": { id: S, by: U },
	"merge.denied": { id: S, merged: z.boolean().optional(), status: S.optional(), by: U.optional(), reason: T.optional() },
	"task.added": { taskId: S, title: T, after: z.array(S).optional() },
	"task.claimed": { ...task, leaseUntil: N, takeoverFrom: S.optional() },
	"task.lease_expired": task,
	"task.done": { ...task, result: U.optional() },
	"task.released": task,
	"kv.put": kv,
	"kv.deleted": kv,
	"kv.swapped": kv,
} as const satisfies Record<string, z.ZodRawShape>;

export const LegacyEventData = Object.fromEntries(
	Object.entries(LegacyEventShapes).map(([t, shape]) => [t, z.looseObject(shape)]),
) as { [K in keyof typeof LegacyEventShapes]: z.ZodObject<(typeof LegacyEventShapes)[K], z.core.$loose> };

const STRICT: Record<string, z.ZodType> = Object.fromEntries(
	Object.entries(LegacyEventShapes).map(([t, shape]) => [t, OPEN.has(t) ? z.looseObject(shape) : z.strictObject(shape)]),
);

/** Daemon-side check of an outgoing payload: unknown fields and wrong types are errors. */
export function strictEventData(dotted: string, data: unknown): { ok: true } | { ok: false; error: string } {
	const s = STRICT[dotted];
	if (!s) return { ok: false, error: `no schema for ${dotted}` };
	const r = s.safeParse(data);
	return r.success ? { ok: true } : { ok: false, error: z.prettifyError(r.error) };
}
