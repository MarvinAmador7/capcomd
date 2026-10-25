import { describe, expect, test } from "bun:test";
import { ApprovalId, contract, EventData } from "../../src/api/contract";
import spec from "../../openapi/capcomd.json";

describe("harness.v1 contract", () => {
	test("approval events carry an approvalId that decide accepts directly", () => {
		const ev = EventData["approval.requested"].parse({ approvalId: "apr-k1", kind: "merge", question: "merge?", subject: {}, expiresAt: null });
		const input = contract.approvals.decide["~orpc"].inputSchema!;
		expect(input["~standard"].validate({ approvalId: ev.approvalId, decision: "approve" })).toMatchObject({ value: { approvalId: "apr-k1" } });
		expect(ApprovalId.safeParse("agt-1").success).toBe(false);
	});
	test("every event type is dotted lower-case", () => {
		for (const t of Object.keys(EventData)) expect(t).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
	});
	test("committed OpenAPI covers every route", () => {
		for (const p of ["/v1/runs", "/v1/runs/{runId}", "/v1/runs/{runId}/agents", "/v1/events", "/v1/approvals/{approvalId}/decision"])
			expect(Object.keys(spec.paths)).toContain(p);
	});
});
