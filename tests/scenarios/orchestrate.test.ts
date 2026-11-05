// Plugin API §16.1 (ADR-024 `tools.mode`): an orchestrate agent works through the agents it spawns and has no work of
// its own. A scripted router (toolMode: orchestrate) spawns a worker, verifies and merges it; after it finishes, the
// operator's verify and merge of the router's own ref are refused (from its VM its ref is outside its subtree anyway).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { PROFILES, world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

let w: World;
beforeAll(async () => {
  const agents = join(mkdtempSync(join(tmpdir(), "capcomd-scn-orchestrate-")), "agents.json");
  writeFileSync(agents, JSON.stringify({ ...PROFILES, agents: { ...PROFILES.agents, router: { ...PROFILES.agents.planner, toolMode: "orchestrate" } } }));
  w = await world("orchestrate", { CAPCOMD_AGENTS_FILE: agents });
}, 120_000);
afterAll(async () => { await w?.stop(); });

test("an orchestrate agent's own ref is never verified or merged; its children's work lands", async () => {
  const run = await newRun(w);
  const worker = w.script("worker", WORKER);
  const router = w.script("router", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write a" --key a --budget turns=5 --children.maxChildren=0 --contract "$($S/json script="FILE=src/a.txt CONTENT=a $W")" | $S/jget agentId)
capcomd await $id >/dev/null || exit 1
v=$(capcomd verify --ref $id --key v-a)
capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-a | $S/jget state
capcomd result --summary routed >/dev/null`);
  const root = await spawnRoot(w, run, "router", router);
  const done = (await waitAll(w, run, [root])).agents[0];
  const logs = (await w.cj(["logs", run, root])).j.lines.map((l: any) => l.line).join("\n");
  if (done.status !== "done") console.log(logs);
  expect(done.status).toBe("done");
  // The worker's change merged.
  expect(logs).toMatch(/^merged$/m);

  // The operator is refused, for a verify and for an unverified merge.
  const v = await w.cj(["verify", run, "--ref", root]);
  expect(v.code).not.toBe(0);
  expect(`${v.stdout}${v.stderr}`).toContain("an orchestrate agent has no work of its own");
  const m = await w.cj(["merge", run, "--ref", root, "--operator"]);
  expect(m.code).not.toBe(0);
  expect(`${m.stdout}${m.stderr}`).toContain("an orchestrate agent has no work of its own");
}, 120_000);
