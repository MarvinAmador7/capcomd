// Payloads of today's scope events (src/actors/scope.ts addEvent), keyed by their harness.v1 dotted name.
// Two views of one shape table:
//  - LegacyEventData (published in openapi/docs): loose, so older clients tolerate new fields (§6.2: new fields don't bump the version).
//  - strictEventData (daemon side): the daemon validates what it emits, so an undeclared field fails in tests.
// SCOPE_EVENT_TYPES is the closed list scope.ts may emit (addEvent's `type` is typed by it), and
// tests/api/legacy-events.test.ts fails when a type has no schema.
import { z } from "zod";

/** Text written by an agent or worker. Render as plain text only: never as markdown, links or actions. */
export const UntrustedText = z.string().meta({ "x-untrusted": true, description: "Agent-written text: render as plain text, never markdown, links or actions" });

const S = z.string(), N = z.number(), nS = z.string().nullable(), U = z.unknown(), T = UntrustedText, nT = UntrustedText.nullable();
const task = { taskId: S, holder: S, epoch: N };
const budget = { add: U, budget: U, by: U };
const finish = { result: U, spent: U, budget: U };
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
	"run.created": { budget: U, label: nS, goal: nT.optional() },
	"run.granted": budget,
	"agent.spawned": { parent: nS, depth: N, profile: U, budget: U, limits: U, agent: U, task: T, key: nS, operator: z.boolean(), review: z.boolean().optional(), grant: U.optional() },
	"agent.started": {},
	"agent.done": finish,
	"agent.failed": finish,
	"agent.checkpointed": { ref: S, sha: S, at: N, reason: T, files: N },
	"agent.notice_raised": { kind: S, detail: T, at: N },
	"agent.notice_cleared": { kind: nS },
	"agent.paused": { result: U, until: U },
	"agent.resumed": { epoch: N, by: nS },
	"agent.granted": budget,
	"agent.adopted": { from: S, to: S },
	"agent.reaped": { orphanOf: S, parentStatus: S },
	"agent.cancelled": { reason: nT, by: S },
	"deadlock.detected": { cycle: z.array(S) },
	"drive.failed": { kind: S, error_kind: S, message: T, attempt: N, driver: U, consecutive: N },
	"token.revoked": { jti: S, reason: nT },
	"message.sent": { to: U, seq: N, bytes: N },
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
