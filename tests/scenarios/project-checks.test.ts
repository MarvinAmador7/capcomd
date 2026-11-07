// A project's named check (`run.checks` in its .capcomd/config.json, as `capcomd setup project` writes it) is what a
// run started in its checkout verifies with: `run new` records it with the run, and a verify that names no check, of a
// child pinned to none, in a repository with no test command of its own, runs the run's one named check (plugin API
// §16.1, as `capcomd check` does) instead of passing on "no test command configured". The merge re-runs that command.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { world, spawnRoot, waitAll, WORKER, type World } from "./harness";
import { CLI } from "../helpers/engine";

const CHECK = "grep -qx good src/p.txt";
let w: World;
let worker: string;
let project: string;
// The repository has no test command (bareRepo's CAPCOMD_TEST_COMMAND is empty).
beforeAll(async () => {
  w = await world("project-checks");
  worker = w.script("worker", WORKER);
  project = join(w.dir, "project");
  mkdirSync(join(project, ".capcomd"), { recursive: true });
  writeFileSync(join(project, ".capcomd", "config.json"), JSON.stringify({ run: { checks: { unit: CHECK } } }));
}, 120_000);
afterAll(async () => { await w?.stop(); });

/** `capcomd run new` as a person types it in the project's checkout: its config read (the tests' CAPCOMD_NO_CONFIG off). */
async function runNewInProject(key: string): Promise<string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries({ ...process.env, ...w.env })) if (v !== undefined && k !== "CAPCOMD_NO_CONFIG") env[k] = v;
  const p = Bun.spawn(["bun", CLI, "run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `${key}-${Date.now()}`, "--json"], { cwd: project, env: { ...env, PWD: project }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`run new: ${code} ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!).runId as string;
}

async function spawnDone(run: string, key: string, content: string) {
  const sp = await w.cj(["spawn", run, "--profile", "worker", "--task", `write ${key}`, "--key", key, "--contract", JSON.stringify({ script: `FILE=src/p.txt CONTENT=${content} ${worker}` })]);
  const id = sp.j.agentId as string;
  expect((await waitAll(w, run, [id])).agents[0].status).toBe("done");
  return id;
}

test("run new in a project's checkout verifies with the project's one named check, and the merge re-runs it", async () => {
  const run = await runNewInProject("proj");
  expect((await w.cj(["kv", "get", run, "_checks"])).j.value).toEqual({ unit: CHECK });

  // The check fails for this one: before, the verify passed without running anything.
  const bad = await spawnDone(run, "bad", "bad");
  const vb = (await w.cj(["verify", run, "--ref", bad, "--key", "v-bad"])).j;
  expect(vb).toMatchObject({ state: "failed", check: "unit", checks: CHECK });

  const good = await spawnDone(run, "good", "good");
  const v = (await w.cj(["verify", run, "--ref", good, "--key", "v-good"])).j;
  expect(v).toMatchObject({ state: "passed", check: "unit", checks: CHECK });
  const m = (await w.cj(["merge", run, "--ref", good, "--require", v.id, "--key", "m-good"])).j;
  expect(m).toMatchObject({ state: "merged", result: { merged: true } });
}, 180_000);

test("an unpinned child's in-VM verify takes the project's one check too, though naming it from the VM is still refused", async () => {
  // The live run's shape: a lead verifies its children from its VM, none pinned to a check at spawn.
  const run = await runNewInProject("vm");
  const p = w.script("vm-verify", `W=${JSON.stringify(worker)}
c=$(capcomd spawn --profile worker --task "write p" --key c --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/p.txt CONTENT=bad SPENT=2 $W")" | $S/jget agentId)
capcomd await $c >/dev/null || exit 1
capcomd verify --ref $c --check unit --key named; echo "named rc=$?"
v=$(capcomd verify --ref $c --key v-c)
echo "recorded: $(echo "$v" | $S/jget check) $(echo "$v" | $S/jget state)"
capcomd result --summary checked >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  expect((await waitAll(w, run, [root])).agents[0].status).toBe("done");
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  // ADR-017: a child gets a named check only through a pin; the run's one check is the run's checks, not a name it picks.
  expect(logs).toMatch(/verify → error forbidden: agt-\S+ has no pinned check; named checks are pinned at spawn/);
  // Before, it passed on "no test command configured" without running anything.
  expect(logs).toContain("recorded: unit failed");
}, 180_000);

test("with several named checks and no repository command, an unpinned verify is as it was: nothing is chosen for it", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `several-${Date.now()}`, "--checks-set", `unit=${CHECK}`, "--checks-set", "lint=true"]);
  const run = r.j.runId as string;
  const id = await spawnDone(run, "several", "bad");
  const v = (await w.cj(["verify", run, "--ref", id, "--key", "v-several"])).j;
  expect(v.check).toBeUndefined();
  expect(v.checks).toBeNull();
}, 180_000);
