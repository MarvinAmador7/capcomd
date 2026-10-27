// lifecycle_events (decided Oct 25, 2026; docs/harness-architecture.md §13): the feed of ONLY run and agent state changes
// plus approval requested/decided. Tool calls and messages stay in step and thread events.
// Persistence: a deterministic projection of the run's durable scope_events log (written in the same transaction as each
// state change), so every lifecycle event has a stable `seq` (the source event's seq) and survives daemon restarts. Run-level
// states are folded from the agent states in seq order: run.started on the first agent start, run.paused when every live agent
// is paused, run.resumed when one resumes, and run.completed / run.failed / run.cancelled when the last live agent ends
// (always run.cancelled when a run-wide cancel ended it).
import { z } from "zod";
import { approvalIdFor, mergeApprovalText, toEnvelope, type RawEvent } from "./source";
import { dottedType, type HarnessEvent } from "./envelope";

/** Trusted, machine-readable reason for a state change. Agent-written detail (cancel reason, error) stays in its own untrusted field. */
export const LifecycleCause = z.enum([
	"created", "spawned", "started", "resumed", "paused", "usage_limit", "finished", "error", "cancelled", "parent_ended",
	"all_agents_done", "agent_failed", "all_agents_cancelled", "all_agents_paused", "approval_needed", "approved", "denied", "deleted",
]).describe("Why the state changed (trusted, machine-readable)");
export type LifecycleCause = z.infer<typeof LifecycleCause>;

/** Every lifecycle type. Agent and approval names reuse the existing harness.v1 names (decision 9). */
export const LIFECYCLE_TYPES = [
	"run.created", "run.started", "run.paused", "run.resumed", "run.completed", "run.failed", "run.cancelled", "run.deleted",
	"agent.spawned", "agent.started", "agent.paused", "agent.resumed", "agent.done", "agent.failed", "agent.cancelled", "agent.reaped",
	"approval.requested", "approval.decided",
] as const;
export type LifecycleType = (typeof LIFECYCLE_TYPES)[number];

const runData = z.looseObject({ cause: LifecycleCause, agentId: z.string().nullable().describe("Agent whose change moved the run, if any") });
/** New run.* payloads (agent/approval payloads are the existing ones plus `cause`). */
export const RunLifecycleData = {
	"run.started": runData, "run.paused": runData, "run.resumed": runData,
	"run.completed": runData, "run.failed": runData, "run.cancelled": runData, "run.deleted": runData,
} as const;

const AGENT_CAUSE: Record<string, LifecycleCause> = {
	AGENT_SPAWNED: "spawned", AGENT_STARTED: "started", AGENT_RESUMED: "resumed", AGENT_DONE: "finished",
	AGENT_FAILED: "error", AGENT_CANCELLED: "cancelled", AGENT_REAPED: "parent_ended",
};
const TERMINAL = new Set(["AGENT_DONE", "AGENT_FAILED", "AGENT_CANCELLED", "AGENT_REAPED"]);

const RUN_TEXT: Record<string, string> = {
	"run.started": "The run started.", "run.paused": "The run is paused: every working agent is paused.", "run.resumed": "The run resumed.",
	"run.completed": "The run finished: all agents are done.", "run.failed": "The run ended with a failed agent.", "run.cancelled": "The run was cancelled.", "run.deleted": "The run was deleted.",
};
const AGENT_TEXT_CAUSE: Partial<Record<LifecycleCause, string>> = { usage_limit: " (usage limit reached)", parent_ended: " (its parent ended)" };

/** Project a run's durable scope events (all of them, from seq 1) onto lifecycle envelopes. */
export function lifecycleEvents(runId: string, evs: RawEvent[], projectId: string | null = null): HarnessEvent[] {
	const out: HarnessEvent[] = [];
	const n = new Map<string, number>();
	const next = (k: string) => { const s = (n.get(k) ?? 0) + 1; n.set(k, s); return s; };
	const status = new Map<string, "pending" | "running" | "paused" | "done" | "failed" | "cancelled">();
	let run: "new" | "running" | "paused" | "ended" = "new";
	// runCancel: a run-wide cancel (agent.cancelled with by "run", the operator's Stop) ended the run, whatever ended before.
	let anyFailed = false, anyDone = false, runCancel = false;
	const runEvt = (e: RawEvent, type: keyof typeof RunLifecycleData, cause: LifecycleCause) => {
		const env = toEnvelope(runId, { ...e, type, agentId: null, data: { cause, agentId: e.agentId } }, next(runId), projectId);
		env.agentId = e.agentId; env.entity = runId; env.id = `evt_${runId}_${e.seq}_${type}`; env.text = RUN_TEXT[type]!;
		out.push(env);
	};
	for (const e of evs) {
		const t = /^[A-Z]/.test(e.type) ? e.type : e.type;
		const k = e.agentId ?? runId;
		if (t === "RUN_NEW" || t === "run.created") {
			const env = toEnvelope(runId, { ...e, type: "RUN_NEW", data: { ...e.data, cause: "created" } }, next(runId), projectId);
			out.push(env); continue;
		}
		if (t === "RUN_DELETED" || t === "run.deleted") { runEvt({ ...e, agentId: null }, "run.deleted", "deleted"); run = "ended"; continue; }
		if (t === "MERGE_AWAITING_APPROVAL") {
			const d = e.data as any, text = mergeApprovalText(d);
			const env = toEnvelope(runId, { ...e, type: "approval.requested", data: {
				approvalId: approvalIdFor(runId, String(d.id)), kind: "merge", question: text.question,
				requestedBy: { agentId: e.agentId, runId }, subject: text.subject, expiresAt: null, cause: "approval_needed",
			} }, next(k), projectId);
			out.push(env); continue;
		}
		if (t === "MERGE_APPROVED" || t === "MERGE_DENIED") {
			const d = e.data as any; const ok = t === "MERGE_APPROVED";
			const by = typeof d.by === "string" ? d.by : null;
			const env = toEnvelope(runId, { ...e, type: "approval.decided", data: {
				approvalId: approvalIdFor(runId, String(d.id)), status: ok ? "approved" : "denied",
				decidedBy: by ? { clientId: by, principal: by } : null, decidedAt: new Date(e.at).toISOString(),
				reason: typeof d.reason === "string" ? d.reason : null, cause: ok ? "approved" : "denied",
			} }, next(k), projectId);
			out.push(env); continue;
		}
		const isPause = t === "AGENT_PAUSED";
		if (!isPause && !(t in AGENT_CAUSE) || !e.agentId) continue;
		const cause: LifecycleCause = isPause ? ((e.data as any)?.result?.limit === "quota" ? "usage_limit" : "paused") : AGENT_CAUSE[t]!;
		const env = toEnvelope(runId, { ...e, data: { ...e.data, cause } }, next(k), projectId);
		if (AGENT_TEXT_CAUSE[cause]) env.text = env.text.replace(/\.$/, `${AGENT_TEXT_CAUSE[cause]}.`);
		out.push(env);
		// fold run state
		const a = e.agentId;
		if (t === "AGENT_SPAWNED") status.set(a, "pending");
		else if (t === "AGENT_STARTED" || t === "AGENT_RESUMED") status.set(a, "running");
		else if (isPause) status.set(a, "paused");
		else if (t === "AGENT_DONE") { status.set(a, "done"); anyDone = true; }
		else if (t === "AGENT_FAILED") { status.set(a, "failed"); anyFailed = true; }
		else if (TERMINAL.has(t)) { status.set(a, "cancelled"); if (t === "AGENT_CANCELLED" && (e.data as any)?.by === "run") runCancel = true; }
		const live = [...status.values()].filter((s) => s === "pending" || s === "running" || s === "paused");
		if ((t === "AGENT_STARTED" || t === "AGENT_RESUMED") && (run === "new" || run === "ended")) { runEvt(e, "run.started", "started"); run = "running"; }
		else if (t === "AGENT_RESUMED" && run === "paused") { runEvt(e, "run.resumed", "resumed"); run = "running"; }
		else if (isPause && run === "running" && live.length && live.every((s) => s === "paused")) { runEvt(e, "run.paused", "all_agents_paused"); run = "paused"; }
		else if (TERMINAL.has(t) && run !== "new" && run !== "ended" && live.length === 0) {
			if (runCancel && (anyFailed || anyDone)) runEvt(e, "run.cancelled", "cancelled");
			else if (anyFailed) runEvt(e, "run.failed", "agent_failed");
			else if (anyDone) runEvt(e, "run.completed", "all_agents_done");
			else runEvt(e, "run.cancelled", "all_agents_cancelled");
			run = "ended"; anyFailed = false; anyDone = false; runCancel = false;
		}
	}
	return out;
}
export const isLifecycleType = (t: string): t is LifecycleType => (LIFECYCLE_TYPES as readonly string[]).includes(t);
export { dottedType };
