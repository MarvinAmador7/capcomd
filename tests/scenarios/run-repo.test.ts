// A run carries its repository settings: `run new` records the caller's CAPCOMD_REPO, merge mode, target, …
// (kv _repo), and the engine (the verifier, the worker's push) uses the run's. The engine here starts WITHOUT
// any repo settings, like a background service would; the CLI has them. The change must still land on trunk.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, spawnRoot, waitAll, WORKER, type World } from "./harness";

const REPO_KEYS = ["CAPCOMD_REPO", "CAPCOMD_MERGE_MODE", "CAPCOMD_MERGE_STRATEGY", "CAPCOMD_MERGE_TARGET", "CAPCOMD_TEST_COMMAND", "CAPCOMD_GITHUB_REPO"];
let w: World;
let worker: string;
beforeAll(async () => { w = await world("runrepo", {}, { engineOmit: REPO_KEYS }); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("an engine without repo settings verifies and merges a run on the run's recorded repository", async () => {
  const run = (await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `rr-${Date.now()}`])).j.runId as string;
  const recorded = (await w.cj(["kv", "get", run, "_repo"])).j.value;
  expect(recorded).toMatchObject({ CAPCOMD_REPO: w.env.CAPCOMD_REPO, CAPCOMD_MERGE_TARGET: "trunk", CAPCOMD_MERGE_MODE: "direct" });
  const p = w.script("rr-planner", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write r" --key r --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/r.txt CONTENT=r SPENT=2 $W")" | $S/jget agentId)
capcomd await $id >/dev/null || exit 1
v=$(capcomd verify --ref $id --key v-r); echo "verify: $(echo "$v" | $S/jget state) $(echo "$v" | $S/jget result.checks.output)"
m=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-r); echo "merge: $(echo "$m" | $S/jget state) $(echo "$m" | $S/jget result.mode)"
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain("merge: merged direct"); // a real merge, not the no-repository dry run (mode "none")
  expect(logs).not.toContain("no repository configured");
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  expect((await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n")).toContain("src/r.txt");
}, 120_000);
