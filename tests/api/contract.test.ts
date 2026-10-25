import { describe, expect, test } from "bun:test";
import { ApiError, ApprovalId, contract, EventData, Scope, StreamFrames } from "../../src/api/contract";
import { HarnessEvent } from "../../src/api/envelope";
import { bodyHash, resolveDecide } from "../../src/api/idempotency";
import spec from "../../openapi/capcomd.json";

const paths = spec.paths as Record<string, any>;

describe("harness.v1 contract", () => {
	test("approval events carry an approvalId that decide accepts directly", () => {
		const ev = EventData["approval.requested"].parse({ approvalId: "apr-k1", kind: "merge", question: "merge?", requestedBy: { agentId: null, runId: "run-1" }, subject: {}, expiresAt: null });
		const input = contract.approvals.decide["~orpc"].inputSchema!;
		const v = input["~standard"].validate({ params: { approvalId: ev.approvalId }, headers: { "idempotency-key": "k-12345678" }, body: { decision: "approve" } });
		expect(v).toMatchObject({ value: { params: { approvalId: "apr-k1" } } });
		expect(input["~standard"].validate({ params: { approvalId: "apr-k1" }, headers: {}, body: { decision: "approve" } })).toHaveProperty("issues");
		expect(ApprovalId.safeParse("agt-1").success).toBe(false);
	});
	test("every event type is dotted lower-case", () => {
		for (const t of [...Object.keys(EventData), ...Object.keys(StreamFrames)]) expect(t).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
	});
	test("committed OpenAPI covers every route, with a scoped stream and no global one", () => {
		for (const p of ["/v1/health", "/v1/runs", "/v1/runs/{runId}", "/v1/runs/{runId}/agents", "/v1/events", "/v1/streams/{scope}/events", "/v1/approvals/{approvalId}/decision"])
			expect(Object.keys(paths)).toContain(p);
		expect(Object.keys(paths)).not.toContain("/v1/events/stream");
		expect(paths["/v1/streams/{scope}/events"].get.responses["200"].content).toHaveProperty("text/event-stream");
	});
	test("scope is daemon, prj-… or run-…", () => {
		for (const s of ["daemon", "prj-a1", "run-mvhd"]) expect(Scope.safeParse(s).success).toBe(true);
		for (const s of ["agt-1", "daemonx", "run-"]) expect(Scope.safeParse(s).success).toBe(false);
	});
	test("every route but health models 401/404/409/422 with the shared Error", () => {
		for (const [p, ops] of Object.entries(paths)) for (const op of Object.values<any>(ops)) {
			if (p === "/v1/health") continue;
			for (const s of ["401", "404", "409", "422"]) expect(op.responses[s].content["application/json"].schema.$ref).toBe("#/components/schemas/Error");
		}
		expect((spec as any).components.schemas.Error.required).toEqual(["code", "message"]);
	});
	test("no anyOf-null unions; nullable fields use type: [T, null]", () => {
		const txt = JSON.stringify(spec);
		expect(txt).not.toMatch(/"anyOf":\[[^\]]*\{"type":"null"\}/);
		expect(txt).toContain('["string","null"]');
	});
	test("agent-written strings are marked x-untrusted", () => {
		const s = JSON.stringify(spec);
		expect((s.match(/"x-untrusted":true/g) ?? []).length).toBeGreaterThan(0);
		expect(JSON.stringify(EventData["approval.requested"].shape.question.meta())).toContain("x-untrusted");
	});
	test("an old client decodes a payload with an unknown new field (§6.2)", () => {
		const line = { v: 1, id: "evt_9", scope: "run-1", seq: 9, entity: "approval:apr-k1", entitySeq: 1, type: "approval.requested", typeVersion: 1, durability: "durable",
			ts: "2026-10-25T03:55:00.000Z", epochMs: 1792900500000, projectId: null, runId: "run-1", agentId: null, text: "Merged.", futureEnvelopeField: 1,
			data: { approvalId: "apr-k1", kind: "merge", question: "q", requestedBy: { agentId: null, runId: "run-1" }, subject: {}, expiresAt: null, priority: "high" } };
		const ev = HarnessEvent.parse(line);
		expect(EventData["approval.requested"].parse(ev.data)).toMatchObject({ priority: "high" });
		expect(EventData["kv.put"].safeParse({ k: "a", version: 1, newField: true }).success).toBe(true);
		const err = ApiError.parse({ code: "already_decided", message: "m", retryAfter: 3,
			decision: { approvalId: "apr-k1", status: "approved", decidedBy: { clientId: "c", principal: "p", via: "x" }, decidedAt: null, reason: null, extra: 1 } });
		expect(err).toMatchObject({ retryAfter: 3, decision: { extra: 1, decidedBy: { via: "x" } } });
		expect(JSON.stringify(spec)).not.toContain('"additionalProperties":false');
	});
});

describe("decision idempotency (§7.4)", () => {
	const body = { decision: "approve" as const };
	const decided = { approvalId: "apr-k1", status: "approved", decidedBy: { clientId: "cli-a", principal: "operator" }, decidedAt: "2026-10-25T03:55:03.000Z", reason: null };
	test("same key, same body: replay the first result", () => {
		expect(resolveDecide({ prior: { approvalId: "apr-k1", bodyHash: bodyHash("apr-k1", body), status: 200, result: decided }, approvalId: "apr-k1", body, existingDecision: decided }))
			.toEqual({ kind: "replay", status: 200, result: decided });
	});
	test("same key, different body: 409 idempotency_conflict", () => {
		expect(resolveDecide({ prior: { approvalId: "apr-k1", bodyHash: bodyHash("apr-k1", body), status: 200, result: decided }, approvalId: "apr-k1", body: { decision: "deny" }, existingDecision: decided }))
			.toMatchObject({ status: 409, code: "idempotency_conflict" });
	});
	test("new key on a decided approval: 409 already_decided with who and when", () => {
		expect(resolveDecide({ prior: undefined, approvalId: "apr-k1", body, existingDecision: decided })).toEqual({ kind: "error", status: 409, code: "already_decided", existing: decided });
		expect(resolveDecide({ prior: undefined, approvalId: "apr-k1", body, existingDecision: null })).toEqual({ kind: "apply" });
	});
});

describe("published payload schemas (phase 1)", () => {
	const schemas = (spec as any).components.schemas as Record<string, any>;
	const byType = new Map(Object.values(schemas).filter((s) => s["x-event-type"]).map((s) => [s["x-event-type"], s]));
	test("every event payload and stream frame is under components.schemas", () => {
		for (const t of [...Object.keys(EventData), ...Object.keys(StreamFrames)]) expect(byType.has(t)).toBe(true);
		expect(byType.get("stream.reset").required).toEqual(["snapshotSeq", "reason"]);
	});
	test("timestamps carry one pattern and format date-time, no allOf", () => {
		const ts = schemas.ApprovalRequestedData.properties.expiresAt;
		expect(ts.format).toBe("date-time");
		expect(ts.allOf).toBeUndefined();
		expect(typeof ts.pattern).toBe("string");
	});
});
