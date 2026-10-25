import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventData } from "../../src/api/contract";
import { dottedType } from "../../src/api/envelope";
import { SCOPE_EVENT_TYPES, strictEventData } from "../../src/api/legacy-events";

test("every type in SCOPE_EVENT_TYPES has a harness.v1 payload schema and a dotted name", () => {
	const missing = SCOPE_EVENT_TYPES.filter((t) => !(dottedType(t) in EventData));
	expect(missing).toEqual([]);
	expect(new Set(SCOPE_EVENT_TYPES.map(dottedType)).size).toBe(SCOPE_EVENT_TYPES.length);
});

test("every upper-case type literal in scope.ts is listed (ternaries and variables included)", () => {
	// addEvent's `type` is typed as ScopeEventType, so typecheck is the main guard; this catches literals anywhere in the file.
	const src = readFileSync("src/actors/scope.ts", "utf8");
	const lits = new Set([...src.matchAll(/"([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*)"/g)].map((m) => m[1]!));
	const known = new Set<string>(SCOPE_EVENT_TYPES);
	const emitted = [...lits].filter((t) => known.has(t) || /^(RUN|AGENT|DEADLOCK|DRIVE|TOKEN|MESSAGE|VERIFY|MERGE|TASK|KV)_/.test(t) || t === "MERGED");
	expect(emitted.filter((t) => !known.has(t))).toEqual([]);
	for (const t of ["AGENT_DONE", "AGENT_NOTICE_CLEARED", "VERIFY_STARTED", "MERGED", "MERGE_FAILED", "KV_CAS"]) expect(lits.has(t)).toBe(true);
});

test("dottedType covers single-word types", () => {
	expect(dottedType("MERGED")).toBe("merge.succeeded");
	expect(dottedType("AGENT_NOTICE_CLEARED")).toBe("agent.notice_cleared");
});

test("published schemas keep extra fields (old clients tolerate new fields)", () => {
	const d = EventData["drive.failed"].parse({ kind: "exec", error_kind: "exec", message: "x", attempt: 1, driver: "boxd", consecutive: 3, extra: 1 });
	expect(d).toMatchObject({ extra: 1 });
	expect(EventData["task.claimed"].safeParse({ taskId: "t", holder: "h", epoch: 1 }).success).toBe(false);
});

test("the daemon-side check is strict except for op bags", () => {
	expect(strictEventData("kv.put", { k: "a", version: 1 }).ok).toBe(true);
	expect(strictEventData("kv.put", { k: "a", version: 1, extra: 1 }).ok).toBe(false);
	expect(strictEventData("agent.notice_cleared", { kind: null }).ok).toBe(true);
	expect(strictEventData("verify.passed", { id: "vfy-1", checks: [] }).ok).toBe(true);
	expect(strictEventData("nope.x", {}).ok).toBe(false);
});

test("decision 9: every harness.v1 type is dotted lowercase noun.verb-past; MERGED → merge.succeeded is final", () => {
	// Past verbs and participles; `cleared`, `expired` etc. all end in -ed. `done`, `sent` are irregular past participles.
	const past = /(ed|done|sent|put)$/;
	for (const t of Object.keys(EventData)) {
		expect(t).toMatch(/^[a-z]+(\.[a-z_]+)+$/);
		expect(t.split(".").at(-1)!).toMatch(past);
	}
	expect(dottedType("MERGED")).toBe("merge.succeeded");
	expect(dottedType("RUN_NEW")).toBe("run.created");
	expect(dottedType("AGENT_CHECKPOINT")).toBe("agent.checkpointed");
	expect(dottedType("MERGE_AWAITING_APPROVAL")).toBe("merge.approval_requested");
	expect(readFileSync("src/api/envelope.ts", "utf8")).not.toMatch(/temporar/i);
});
