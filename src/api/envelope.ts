// harness.v1 event envelope (docs/harness-architecture.md §6.1). Phase 0 of the harness: the contract first.
import { z } from "zod";

export const Durability = z.enum(["durable", "ephemeral"]);

export const HarnessEvent = z.object({
	v: z.literal(1),
	id: z.string().regex(/^evt_/),
	scope: z.string().regex(/^(run-|prj-|daemon$)/),
	// Persisted per scope in the same transaction as the event write: survives daemon restarts, never reused or skipped.
	seq: z.number().int().nonnegative().describe("Resume cursor; persisted per scope with the event write, stable across daemon restarts"),
	entity: z.string().min(1),
	entitySeq: z.number().int().nonnegative(),
	type: z.string().regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/),
	typeVersion: z.number().int().positive(),
	durability: Durability,
	ts: z.iso.datetime(),
	epochMs: z.number().int(),
	projectId: z.string().nullable(),
	runId: z.string().nullable(),
	agentId: z.string().nullable(),
	data: z.record(z.string(), z.unknown()),
});
export type HarnessEvent = z.infer<typeof HarnessEvent>;

/** Single-word legacy types have no namespace; they get an explicit dotted name (decision 9). */
const DOTTED_OVERRIDES: Record<string, string> = { MERGED: "merge.succeeded" };

/** Today's upper-case event types (capcomd.v1) map to dotted lower-case names in harness.v1: AGENT_SPAWNED → agent.spawned, MERGED → merge.succeeded. */
export function dottedType(legacy: string): string {
	if (legacy in DOTTED_OVERRIDES) return DOTTED_OVERRIDES[legacy]!;
	if (!/^[A-Z][A-Z0-9]*(_[A-Z0-9]+)+$/.test(legacy)) throw new Error(`not a capcomd.v1 event type: ${legacy}`);
	const [head, ...rest] = legacy.toLowerCase().split("_");
	return `${head}.${rest.join("_")}`;
}
