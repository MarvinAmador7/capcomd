// harness.v1 event envelope (docs/harness-architecture.md §6.1). Phase 0 of the harness: the contract first.
import { z } from "zod";
import { EVENT_TYPE_DOC, EVENT_TYPE_PATTERN } from "../../packages/plugin/src/event-type";

/** The one event type pattern (packages/plugin/src/event-type.ts): the kernel's types and every plugin's own. */
export { EVENT_TYPE_DOC, EVENT_TYPE_PATTERN };
export const EventType = z.string().regex(new RegExp(EVENT_TYPE_PATTERN)).describe(EVENT_TYPE_DOC);

/** Every server timestamp: RFC 3339 UTC, exactly 3 millisecond digits (2026-10-25T07:57:00.000Z). Date#toISOString() always produces this. */
export const TIMESTAMP_PATTERN = "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$";
export const TIMESTAMP_DOC = "RFC 3339 UTC with exactly 3 millisecond digits, e.g. 2026-10-25T07:57:00.000Z";
export const Timestamp = z.iso.datetime({ precision: 3 }).regex(new RegExp(TIMESTAMP_PATTERN));
export const isoTs = (epochMs: number): string => new Date(epochMs).toISOString();

export const Durability = z.enum(["durable", "ephemeral"]);

export const HarnessEvent = z.object({
	v: z.literal(1),
	id: z.string().regex(/^evt_/),
	scope: z.string().regex(/^(run-|prj-|daemon$)/),
	// Persisted per scope in the same transaction as the event write: survives daemon restarts, never reused or skipped.
	seq: z.number().int().nonnegative().describe("Resume cursor; persisted per scope with the event write, stable across daemon restarts"),
	entity: z.string().min(1),
	entitySeq: z.number().int().nonnegative(),
	type: EventType,
	typeVersion: z.number().int().positive(),
	durability: Durability,
	ts: Timestamp,
	epochMs: z.number().int(),
	projectId: z.string().nullable(),
	runId: z.string().nullable(),
	agentId: z.string().nullable(),
	text: z.string().describe("Plain-language sentence for this step, written by the daemon from trusted fields only. On a plugin's own event (plugin.<plugin name>.<event>) it is that plugin's sentence instead: render it as plain text, never markdown, links or actions"),
	data: z.record(z.string(), z.unknown()),
});
export type HarnessEvent = z.infer<typeof HarnessEvent>;

/**
 * Decision 9 (final, Oct 25 2026): harness.v1 types are dotted lowercase noun.verb-past. Legacy names that are not
 * already a past verb get an explicit name here; MERGED → merge.succeeded is final.
 */
export const DOTTED_OVERRIDES: Record<string, string> = {
	MERGED: "merge.succeeded",
	RUN_NEW: "run.created",
	AGENT_CHECKPOINT: "agent.checkpointed",
	AGENT_NOTICE: "agent.notice_raised",
	MERGE_AWAITING_APPROVAL: "merge.approval_requested",
	KV_DELETE: "kv.deleted",
	KV_CAS: "kv.swapped",
};

/** Today's upper-case event types (capcomd.v1) map to dotted lower-case names in harness.v1: AGENT_SPAWNED → agent.spawned, MERGED → merge.succeeded, RUN_NEW → run.created. */
export function dottedType(legacy: string): string {
	if (legacy in DOTTED_OVERRIDES) return DOTTED_OVERRIDES[legacy]!;
	if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(legacy)) throw new Error(`not a capcomd.v1 event type: ${legacy}`);
	const [head, ...rest] = legacy.toLowerCase().split("_");
	return `${head}.${rest.join("_")}`;
}
