// Run titles (harness.v1 Run.title, titleSource): the rules, checked against the fixture the menu bar app's port reads
// too (tests/api/run-titles.json), and the title on GET /v1/runs and snapshot.run as the run goes on.
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addClient, loadClients } from "../../src/api/clients";
import { Run } from "../../src/api/contract";
import { runTitle, shortTitle, TITLE_MAX } from "../../src/api/run-title";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";
import { memorySource } from "../../src/api/source";
import fixture from "./run-titles.json";

const graphemes = (s: string) => [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(s)].length;

describe("shortTitle", () => {
	for (const c of fixture.short) {
		test(`${JSON.stringify(c.input.slice(0, 48))} → ${JSON.stringify(c.title)}`, () => {
			expect(shortTitle(c.input)).toBe(c.title);
		});
	}
	test("never longer than TITLE_MAX characters, never empty", () => {
		for (const c of fixture.short) if (c.title !== null) {
			expect(graphemes(c.title)).toBeLessThanOrEqual(TITLE_MAX);
			expect(c.title.trim().length).toBeGreaterThan(0);
		}
	});
	test("a cut never splits a bracket pair or ends on a dangling word", () => {
		expect(shortTitle("Add a multiply(a, b) function to src/math.ts and a bun test for it")).toBe("Add a multiply(a, b) function to src/math.ts");
		expect(shortTitle("Make the onboarding flow remember the last folder the user picked across launches")).not.toMatch(/\b(the|a|to|of)…$/);
	});
});

describe("runTitle", () => {
	for (const c of fixture.runs) {
		test(c.name, () => {
			expect(runTitle(c.run as Parameters<typeof runTitle>[0])).toEqual({ title: c.title, titleSource: c.titleSource as never });
		});
	}
});

describe("Run.title on the API", () => {
	const dir = mkdtempSync(join(tmpdir(), "harness-title-"));
	const path = join(dir, "clients.json");
	const token = addClient("reader", ["read"], path).token;
	const goal = "Add a multiply(a, b) function to src/math.ts and a bun test for it";
	const planner = { id: "agt-p", runId: "run-t", parent: null, depth: 0, profile: "planner", status: "running" as const, text: "Running.", activity: null, task: goal, taskAttachment: null, result: null, workspace: null, provider: null, model: null, effort: null, updatedAt: null };
	const worker = { ...planner, id: "agt-w", parent: "agt-p", depth: 1, profile: "worker", task: "Add multiply(a, b) to src/math.ts with a test\n\nExport it next to add().", result: null as Record<string, unknown> | null };

	test("goal-derived while the run works, the merged work's subject once it merged; titled runs validate", async () => {
		const src = memorySource({
			runs: [{ id: "run-t", projectId: null, label: goal, state: "running", goal, repo: "/r", createdAt: "2026-10-29T09:00:00.000Z" }],
			agents: { "run-t": [planner, worker] },
		});
		const app = harnessApp({ source: src, clients: () => loadClients(path), heartbeatMs: 60_000, pollMs: 20, state: harnessState(null) });
		const get = async () => (await (await app.request("/v1/runs/run-t", { headers: { authorization: `Bearer ${token}` } })).json()) as Record<string, unknown>;

		const before = await get();
		expect(before).toMatchObject({ title: "Add a multiply(a, b) function to src/math.ts", titleSource: "goal" });
		expect(Run.safeParse(before).success).toBe(true);

		worker.result = { summary: "done", merge: { id: "mrg-1", target: "main", state: "merged", sha: "abc" } };
		expect(await get()).toMatchObject({ title: "Add multiply(a, b) to src/math.ts with a test", titleSource: "merge" });
	});

	test("a run started through POST /v1/runs is titled from its goal at once", async () => {
		const src = memorySource({});
		const run = await src.createRun({ goal: "please fix the flaky login test" });
		expect(run).toMatchObject({ title: "Fix the flaky login test", titleSource: "goal" });
	});
});
