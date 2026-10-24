// `capcomd run "<goal>" --planner P`: the run gets the project's gates and a planner agent (scripted here) spawns,
// verifies and merges its children; the command shows the tree as it changes and ends with the planner's summary.
// On real VMs (boxd) the placeholder planner isn't used unless asked for (--recipe/--legacy).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { capcomd } from "../helpers/engine";
import { world, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("runplanner"); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("capcomd run --planner: a planner agent splits, verifies and merges; the command reports the tree and its summary", async () => {
  const planner = w.script("planner", `
W=${JSON.stringify(worker)}
ids=""
for f in a b; do
  id=$(capcomd spawn --profile worker --task "write $f" --key $f --contract "$($S/json script="FILE=src/$f.txt CONTENT=$f $W")" | $S/jget agentId)
  ids="$ids $id"
done
capcomd await $ids > /dev/null || exit 1
merged=0
for id in $ids; do
  v=$(capcomd verify --ref $id --key v-$id)
  [ "$(echo "$v" | $S/jget result.pass)" = true ] && capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-$id > /dev/null && merged=$((merged+1))
done
capcomd result --summary "merged $merged of 2"`);
  const env = { ...w.env, CAPCOMD_SCRIPT_PLANNER: planner, PWD: w.dir };
  const r = await capcomd(["run", "write a and b", "--planner", "planner", "--json"], env);
  const lines = r.stdout.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  if (r.code !== 0) console.log(r.stdout.slice(-3000), r.stderr.slice(-2000));
  expect(r.code).toBe(0);
  const types = lines.map((l) => l.type);
  expect(types).toEqual(expect.arrayContaining(["run.started", "planner.spawned", "agent.status", "run.completed", "run.result"]));
  const runId = lines[0].runId;
  const root = lines.find((l) => l.type === "planner.spawned").agentId;
  expect(lines.find((l) => l.type === "run.completed")).toMatchObject({ agentId: root, summary: "merged 2 of 2" });
  // every agent's last status was shown: the planner and its two workers, done
  const last = new Map<string, string>();
  for (const l of lines.filter((x) => x.type === "agent.status")) last.set(l.agentId, l.status);
  expect([...last.values()].filter((s) => s === "done").length).toBe(3);
  const t = (await w.cj(["tree", runId])).j;
  expect(t.tree[0]).toMatchObject({ agentId: root, profile: "planner", status: "done" });
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  expect((await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n")).toEqual(expect.arrayContaining(["src/a.txt", "src/b.txt"]));
}, 180_000);

test("on real VMs, capcomd run needs a planner agent: without one it refuses (unless --recipe), and a profile that can't spawn isn't one", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-noplanner-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "subscription" } } }));
  const env = { ...w.env, CAPCOMD_AGENTS_FILE: agentsFile, CAPCOMD_SANDBOX: "boxd", PWD: dir };
  const none = await capcomd(["run", "do it"], env);
  expect(none.code).not.toBe(0);
  expect(none.stdout + none.stderr).toContain('no planner profile: capcomd run needs a profile named "planner"');
  const notOne = await capcomd(["run", "do it", "--planner", "worker"], env);
  expect(notOne.stdout + notOne.stderr).toContain("profile worker can't plan");
}, 60_000);
