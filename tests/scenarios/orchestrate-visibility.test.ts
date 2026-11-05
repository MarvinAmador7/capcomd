// Plugin API §16.1: an orchestrate agent sees everything and runs nothing. A scripted router (toolMode: orchestrate)
// lands two workers' changes and learns everything from capcomd: each merge's result says whether the checks ran on the
// combined code (`result.combined`), `capcomd fetch` brings the merged target into its checkout to read with git, and
// `capcomd logs` shows its own capcomd calls. An orchestrate agent that spawns nothing ends failed, not done.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { agentsOf, PROFILES, world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

let w: World;
beforeAll(async () => {
  const agents = join(mkdtempSync(join(tmpdir(), "capcomd-scn-orch-vis-")), "agents.json");
  writeFileSync(agents, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, router: { ...PROFILES.agents.planner, toolMode: "orchestrate" } } }));
  // A check that runs (on this host), so a merge's checks are real.
  w = await world("orch-vis", { CAPCOMD_AGENTS_FILE: agents, CAPCOMD_TEST_COMMAND: "test -d ." });
}, 120_000);
afterAll(async () => { await w?.stop(); });

test("a merge says whether the checks ran on the combined code; capcomd fetch shows the merged target", async () => {
  const run = await newRun(w);
  const worker = w.script("worker", WORKER);
  const router = w.script("router", `W=${JSON.stringify(worker)}
a=$(capcomd spawn --profile worker --task "write a" --key a --children.maxChildren=0 --contract "$($S/json script="FILE=src/a.txt CONTENT=a $W")" | $S/jget agentId)
b=$(capcomd spawn --profile worker --task "write b" --key b --children.maxChildren=0 --contract "$($S/json script="FILE=src/b.txt CONTENT=b $W")" | $S/jget agentId)
capcomd await $a $b >/dev/null || exit 1
va=$(capcomd verify --ref $a --key v-a | $S/jget id)
vb=$(capcomd verify --ref $b --key v-b | $S/jget id)
echo "merge-a: $(capcomd merge --ref $a --require $va --key m-a | $S/jget result.combined.text)"
echo "merge-b: $(capcomd merge --ref $b --require $vb --key m-b | $S/jget result.combined.text)"
d=$(mktemp -d); git clone -q ${JSON.stringify(w.repo.bare)} $d/c && cd $d/c
echo "fetched: $(capcomd fetch trunk | $S/jget branches.0.branch)"
echo "trunk-log: $(git log --format=%s origin/trunk | tr '\\n' '|')"
capcomd result --summary routed >/dev/null`);
  const root = await spawnRoot(w, run, "router", router);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  // a landed by the fast path (trunk hadn't moved since its verify); b's verify ran before a landed, so its merge put
  // it on trunk with a and ran the checks again.
  expect(logs).toContain("merge-a: checks ran on the combined code (this change on trunk with 0 earlier merges from this run) at its verify, and trunk hadn't moved since, so what landed is the tree that passed: pass");
  expect(logs).toContain("merge-b: checks ran on the combined code (this change on trunk with 1 earlier merge from this run): pass");
  // The host fetched the merged trunk into the router's checkout: both merges are there to read.
  expect(logs).toContain("fetched: trunk");
  expect(logs).toMatch(/trunk-log: [^|\n]*work for[^|\n]*\|[^|\n]*work for[^|\n]*\|seed\|/);
  // Its own capcomd calls are in its log.
  expect(logs).toMatch(/\[capcomd\] fetch → ok/);

  // The operator's view of the same merges: the record carries `combined`, and the CLI prints its line.
  const b = (await agentsOf(run)).find((x: any) => x.task === "write b")!.agentId;
  const mergeB = await w.cj(["merge", run, "--ref", b, "--key", `${root}:m-b`]);
  expect(mergeB.j?.result?.combined).toMatchObject({ checked: true, passed: true, at: "merge", earlierMerges: 1 });
}, 120_000);

test("an orchestrate agent that spawns nothing ends failed, with what it said", async () => {
  const run = await newRun(w);
  const router = w.script("idle-router", `capcomd result --summary "blocked before delegation; nothing landed" >/dev/null`);
  const root = await spawnRoot(w, run, "router", router);
  const done = (await waitAll(w, run, [root])).agents[0];
  expect(done.status).toBe("failed");
  expect(done.result.errorKind).toBe("orchestrate_no_children");
  expect(done.result.error).toContain("is an orchestrate agent and spawned no agents, so nothing it did can land");
  expect(done.result.summary).toBe("blocked before delegation; nothing landed");
}, 120_000);
