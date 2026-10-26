import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { harnessState, KEY_TTL_MS } from "../../src/api/state";

const tmp = () => join(mkdtempSync(join(tmpdir(), "hs-")), "harness-state.json");
const k = (approvalId: string) => ({ approvalId, bodyHash: "h", status: 200, result: { ok: true } });

test("idempotency keys expire after 24h, decisions are kept", () => {
	const p = tmp(); let t = 1_000;
	const s = harnessState(p, { now: () => t });
	s.recordDecision("c:k1", k("apr_1"), { decision: "approve" });
	t += KEY_TTL_MS - 1;
	expect(s.key("c:k1")?.approvalId).toBe("apr_1");
	t += 1;
	expect(s.key("c:k1")).toBeUndefined();
	expect(s.decision("apr_1")).toEqual({ decision: "approve" });
	expect(JSON.parse(readFileSync(p, "utf8")).keys).toEqual({});
});

test("expired keys are pruned on load; legacy keys without a timestamp get a fresh 24h clock", () => {
	const p = tmp();
	writeFileSync(p, JSON.stringify({ keys: { old: { ...k("a"), at: 0 }, legacy: k("b") }, decisions: {}, runSeq: {}, nextSeq: 1 }));
	let t = KEY_TTL_MS + 5;
	const s = harnessState(p, { now: () => t });
	const disk = JSON.parse(readFileSync(p, "utf8"));
	expect(Object.keys(disk.keys)).toEqual(["legacy"]);
	expect(disk.keys.legacy.at).toBe(t);
	expect(s.key("legacy")?.approvalId).toBe("b");
	t += KEY_TTL_MS;
	expect(harnessState(p, { now: () => t }).key("legacy")).toBeUndefined();
});

test("only a confirmed deletion drops a seq, and seqs are never reused (also across restart)", () => {
	const p = tmp();
	const s = harnessState(p);
	const m1 = s.seqs([{ id: "r1", createdAt: "1" }, { id: "r2", createdAt: "2" }, { id: "r3", createdAt: "3" }]);
	expect([...m1.values()]).toEqual([1, 2, 3]);
	s.runDeleted("r2"); s.runDeleted("r3");
	const m2 = s.seqs([{ id: "r1", createdAt: "1" }, { id: "r4", createdAt: "4" }]);
	expect(m2.get("r1")).toBe(1);
	expect(m2.get("r4")).toBe(4);
	const disk = JSON.parse(readFileSync(p, "utf8"));
	expect(disk.runSeq).toEqual({ r1: 1, r4: 4 });
	expect(disk.nextSeq).toBe(5);
	expect(harnessState(p).seqs([{ id: "r5", createdAt: "5" }]).get("r5")).toBe(5);
	expect(harnessState(p).seqs([{ id: "r6" }]).get("r6")).toBe(6);
});

test("regression: an empty or partial run list keeps every seq", () => {
	const p = tmp();
	const s = harnessState(p);
	s.seqs([{ id: "r1", createdAt: "1" }, { id: "r2", createdAt: "2" }, { id: "r3", createdAt: "3" }]);
	expect(s.seqs([]).size).toBe(0);
	expect(s.seqs([{ id: "r2", createdAt: "2" }]).get("r2")).toBe(2);
	expect(JSON.parse(readFileSync(p, "utf8")).runSeq).toEqual({ r1: 1, r2: 2, r3: 3 });
	const back = harnessState(p).seqs([{ id: "r1" }, { id: "r2" }, { id: "r3" }, { id: "r4" }]);
	expect([...back.values()]).toEqual([1, 2, 3, 4]);
});

test("a state file whose nextSeq is behind its runSeq is repaired on load", () => {
	const p = tmp();
	writeFileSync(p, JSON.stringify({ keys: {}, decisions: {}, runSeq: { r1: 7 }, nextSeq: 2 }));
	expect(harnessState(p).seqs([{ id: "r1" }, { id: "r2" }]).get("r2")).toBe(8);
});
