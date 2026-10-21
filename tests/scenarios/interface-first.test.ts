// Interface first (stacked-work tier 1, ROADMAP.md): dependent work without stacked branches. A tiny contract
// lands first; the provider (A) and the consumer (B) then run in parallel from the target that has it; A lands
// first, and B's integration check (it needs both) passes only once A has landed. Verifying B too early fails
// for the right reason. The repo's own test command is red, so only the named checks gate.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, spawnRoot, waitAll, types, inOrder, WORKER, type World } from "./harness";

let w: World;
let worker: string;
beforeAll(async () => { w = await world("iface", { CAPCOMD_TEST_COMMAND: "exit 7" }); worker = w.script("worker", WORKER); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("interface first: contract lands, provider and consumer run in parallel, land in dependency order", async () => {
  const r = await w.cj(["run", "new", "--budget", "usd=10,turns=400,wallSeconds=3600", "--key", `if-${Date.now()}`,
    "--checks-set", "contract=test -f src/api.txt",
    "--checks-set", "provider=test -f src/api.txt && test -f src/a.txt",
    "--checks-set", "integration=test -f src/api.txt && test -f src/a.txt && test -f src/b.txt"]);
  expect(r.code).toBe(0);
  const run = r.j.runId as string;
  const p = w.script("if-planner", `W=${JSON.stringify(worker)}
spawn() { capcomd spawn --profile worker --task "$1" --key $2 --budget turns=10 --children.maxChildren=0 --check $3 --contract "$($S/json script="FILE=src/$4.txt CONTENT=$4 SPENT=2 $W")" | $S/jget agentId; }
land() { v=$(capcomd verify --ref $1 --key v-$2); [ "$(echo "$v" | $S/jget result.pass)" = true ] || { echo "verify $2 failed"; return 1; }; capcomd merge --ref $1 --require "$(echo "$v" | $S/jget id)" --key m-$2 >/dev/null && echo "landed $2"; }
# 1. the contract (the shared seam) lands first
c=$(spawn "add the api seam" contract contract api); capcomd await $c >/dev/null && land $c contract || exit 1
# 2. provider and consumer in parallel, both from the target that has the contract
a=$(spawn "implement the api" a provider a)
b=$(spawn "use the api" b integration b)
capcomd await $a $b >/dev/null || exit 1
# too early: B's integration check needs A, which hasn't landed
e=$(capcomd verify --ref $b --key v-b-early); echo "early b: pass=$(echo "$e" | $S/jget result.pass)"
# 3. land in dependency order: provider, then consumer
land $a a && land $b b || exit 1
capcomd result --summary done >/dev/null`);
  const root = await spawnRoot(w, run, "planner", p);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  expect(logs).toContain("landed contract");
  expect(logs).toContain("early b: pass=false");
  expect(logs).toContain("landed a");
  expect(logs).toContain("landed b");
  // The contract merged before A and B were spawned; B's early verify failed; then A, then B landed.
  expect(inOrder(await types(w, run), ["AGENT_SPAWNED", "AGENT_SPAWNED", "MERGED", "AGENT_SPAWNED", "AGENT_SPAWNED", "VERIFY_FAILED", "VERIFY_PASSED", "MERGED", "VERIFY_PASSED", "MERGED"])).toBe(true);
  expect((await types(w, run)).filter((t) => t === "MERGED").length).toBe(3);
  await w.repo.seed.ok(["fetch", "-q", "origin"]);
  const files = (await w.repo.seed.ok(["ls-tree", "-r", "--name-only", "origin/trunk"])).split("\n");
  expect(files).toEqual(expect.arrayContaining(["src/api.txt", "src/a.txt", "src/b.txt"]));
}, 120_000);
