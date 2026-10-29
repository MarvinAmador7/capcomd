// CAPCOMD_RUNS_INDEX names the runs index (the live e2e scripts keep their runs out of the user's daemon's run list);
// without it the index is the state dir's runs.jsonl.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { recentRuns, runsIndexPath } from "../../src/primitives/ops";
import { stateDir } from "../../src/utils/home";

const saved = { idx: process.env.CAPCOMD_RUNS_INDEX, home: process.env.CAPCOMD_HOME };
afterEach(() => {
	if (saved.idx === undefined) delete process.env.CAPCOMD_RUNS_INDEX; else process.env.CAPCOMD_RUNS_INDEX = saved.idx;
	if (saved.home === undefined) delete process.env.CAPCOMD_HOME; else process.env.CAPCOMD_HOME = saved.home;
});

test("the runs index is CAPCOMD_RUNS_INDEX when set, else <state>/runs.jsonl", () => {
	const dir = mkdtempSync(join(tmpdir(), "capcomd-runs-index-"));
	process.env.CAPCOMD_HOME = join(dir, "home");
	delete process.env.CAPCOMD_RUNS_INDEX;
	expect(runsIndexPath()).toBe(join(dir, "home", "state", "runs.jsonl"));
	expect(runsIndexPath()).toBe(join(stateDir(), "runs.jsonl"));

	const own = join(dir, "work", "runs.jsonl");
	process.env.CAPCOMD_RUNS_INDEX = own;
	expect(runsIndexPath()).toBe(own);
	expect(stateDir()).toBe(join(dir, "home", "state")); // the rest of the state stays where it was
	expect(recentRuns()).toEqual([]);
	mkdirSync(join(dir, "work"));
	writeFileSync(own, JSON.stringify({ runId: "run-a", label: "a", repo: null, cwd: dir, createdAt: 1 }) + "\n");
	expect(recentRuns().map((r) => r.runId)).toEqual(["run-a"]);
});
