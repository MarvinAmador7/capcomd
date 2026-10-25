import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventData } from "../../src/api/contract";
import { dottedType } from "../../src/api/envelope";

test("every event type scope.ts emits has a harness.v1 payload schema", () => {
	const src = readFileSync("src/actors/scope.ts", "utf8");
	const types = [...new Set([...src.matchAll(/addEvent\(\s*tx,\s*"([A-Z_]+)"/g)].map((m) => m[1]!))];
	expect(types.length).toBeGreaterThan(20);
	const missing = types.filter((t) => !(dottedType(t) in EventData));
	expect(missing).toEqual([]);
});

test("schemas accept real payloads and keep extra fields", () => {
	const d = EventData["drive.failed"].parse({ kind: "exec", error_kind: "exec", message: "x", attempt: 1, driver: "boxd", consecutive: 3, extra: 1 });
	expect(d).toMatchObject({ extra: 1 });
	expect(EventData["task.claimed"].safeParse({ taskId: "t", holder: "h", epoch: 1 }).success).toBe(false);
});
