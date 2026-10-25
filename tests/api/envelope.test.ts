import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { HarnessEvent, dottedType, isoTs, Timestamp, TIMESTAMP_PATTERN } from "../../src/api/envelope";

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

describe("timestamp format", () => {
	const re = new RegExp(TIMESTAMP_PATTERN);
	test("isoTs always emits UTC with exactly 3 ms digits", () => {
		for (const ms of [0, 1, 999, 1_761_379_020_000, Date.now()]) expect(isoTs(ms)).toMatch(re);
	});
	test("fixture ts/decidedAt/expiresAt match, and the schema rejects other precisions", () => {
		const lines = readFileSync("apps/tui/fixtures/harness-v1/events.ndjson", "utf8").trim().split("\n").map((l) => JSON.parse(l));
		for (const e of lines) {
			if (e.ts) expect(e.ts).toMatch(re);
			for (const k of ["decidedAt", "expiresAt"]) if (e.data?.[k] != null) expect(e.data[k]).toMatch(re);
		}
		expect(Timestamp.safeParse("2026-10-25T07:57:00.000Z").success).toBe(true);
		for (const bad of ["2026-10-25T07:57:00Z", "2026-10-25T07:57:00.0Z", "2026-10-25T07:57:00.000000Z", "2026-10-25T01:57:00.000-06:00"]) expect(Timestamp.safeParse(bad).success).toBe(false);
	});
});
