import { describe, expect, test } from "bun:test";
import { HarnessEvent, dottedType } from "../../src/api/envelope";

const ok = {
	v: 1, id: "evt_01JB", scope: "run-mvhd", seq: 1842, entity: "scope:agt-k30", entitySeq: 57,
	type: "agent.turn.item", typeVersion: 1, durability: "durable",
	ts: "2026-10-25T05:55:00.000Z", epochMs: 1792900500000,
	projectId: null, runId: "run-mvhd", agentId: "agt-k30", data: {},
};

describe("harness.v1 envelope", () => {
	test("accepts the documented example", () => expect(HarnessEvent.safeParse(ok).success).toBe(true));
	test("rejects upper-case types and bad scopes", () => {
		expect(HarnessEvent.safeParse({ ...ok, type: "AGENT_SPAWNED" }).success).toBe(false);
		expect(HarnessEvent.safeParse({ ...ok, scope: "agt-x" }).success).toBe(false);
	});
	test("maps legacy types to dotted names", () => {
		expect(dottedType("AGENT_SPAWNED")).toBe("agent.spawned");
		expect(dottedType("DRIVE_FAILED")).toBe("drive.failed");
		expect(dottedType("TOKEN_REVOKED")).toBe("token.revoked");
		expect(() => dottedType("agent.spawned")).toThrow();
	});
});
