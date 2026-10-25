// harness.v1 client contract (docs/harness-architecture.md §6-7). Phase 0: schemas and procedures, no server yet.
// openapi/capcomd.json and docs/events.md are generated from this file (scripts/gen-harness-contract.ts --check in CI).
import { oc } from "@orpc/contract";
import { z } from "zod";
import { HarnessEvent } from "./envelope";
import { LegacyEventData } from "./legacy-events";

export const ApprovalId = z.string().regex(/^apr-[A-Za-z0-9]+$/).describe("Stable approval id, carried on approval events; decide with it directly");
export const ApprovalKind = z.enum(["merge", "budget", "egress", "secret", "spawn_widen", "custom"]);
export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired", "withdrawn"]);
export const AgentStatus = z.enum(["pending", "running", "paused", "done", "failed", "cancelled", "handed-off"]);

export const Run = z.object({ id: z.string(), projectId: z.string().nullable(), label: z.string().nullable(), state: z.string(), goal: z.string().nullable() });
export const Agent = z.object({ id: z.string(), runId: z.string(), parent: z.string().nullable(), depth: z.number().int(), profile: z.string().nullable(), status: AgentStatus });
export const Decision = z.object({
	approvalId: ApprovalId,
	status: ApprovalStatus,
	decidedBy: z.object({ clientId: z.string(), principal: z.string() }).nullable(),
	decidedAt: z.iso.datetime().nullable(),
	reason: z.string().nullable(),
});

/** SSE event payloads (data field) by dotted type. docs/events.md is generated from this map. */
export const EventData = {
	...LegacyEventData,
	"run.created": z.object({ runId: z.string(), goal: z.string().nullable() }),
	"agent.status": z.object({ agentId: z.string(), status: AgentStatus }),
	"approval.requested": z.object({ approvalId: ApprovalId, kind: ApprovalKind, question: z.string(), subject: z.record(z.string(), z.unknown()), expiresAt: z.iso.datetime().nullable() }),
	"approval.decided": Decision,
} as const;
export type EventType = keyof typeof EventData;

export const contract = {
	runs: {
		list: oc.route({ method: "GET", path: "/v1/runs" }).output(z.array(Run)),
		get: oc.route({ method: "GET", path: "/v1/runs/{runId}" }).input(z.object({ runId: z.string() })).output(Run),
	},
	agents: {
		tree: oc.route({ method: "GET", path: "/v1/runs/{runId}/agents" }).input(z.object({ runId: z.string() })).output(z.array(Agent)),
	},
	events: {
		replay: oc
			.route({ method: "GET", path: "/v1/events", description: "Durable events after `after` (resume cursor = seq). The live SSE stream uses the same envelope." })
			.input(z.object({ scope: z.string(), after: z.coerce.number().int().nonnegative().optional() }))
			.output(z.array(HarnessEvent)),
	},
	approvals: {
		decide: oc
			.route({ method: "POST", path: "/v1/approvals/{approvalId}/decision", description: "Idempotent: deciding again returns the first decision unchanged. No prior read needed." })
			.input(z.object({ approvalId: ApprovalId, decision: z.enum(["approve", "deny"]), reason: z.string().optional() }))
			.output(Decision),
	},
};
