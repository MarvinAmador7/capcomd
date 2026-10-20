import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, trajectory, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("smoke"); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("smoke: a scripted planner spawns one worker via in-VM capcomd and reads its result", async () => {
  const run = await newRun(w);
  const worker = w.script("worker", `capcomd result --summary "wrote $CAPCOMD_TASK" --data "$($S/json file='{"path":"src/a.txt","content":"A\\n"}')"`);
  const planner = w.script("planner", `
set -e
out=$(capcomd spawn --profile worker --task "file a" --key a --budget turns=5 --children.maxChildren=0 --contract "$($S/json script='${worker}')")
echo "spawned: $out"
id=$(echo "$out" | $S/jget agentId)
capcomd await "$id" --timeout-ms 60000 > /tmp/aw-$CAPCOMD_AGENT_ID.json
cat /tmp/aw-$CAPCOMD_AGENT_ID.json
capcomd result --summary "child said: $(cat /tmp/aw-$CAPCOMD_AGENT_ID.json | $S/jget agents.0.result.summary.text | head -c 200)"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const aw = await waitAll(w, run, [root]);
  const logs = (await w.cj(["logs", run, root])).j;
  if (aw.agents[0].status !== "done") console.log(JSON.stringify(aw, null, 1), JSON.stringify(logs, null, 1));
  expect(aw.agents[0].status).toBe("done");
  expect(aw.agents[0].result.summary).toContain("untrusted:agt-");
  const t = (await w.cj(["tree", run])).j;
  expect(t.totals.agents).toBe(2);
  const types = (await trajectory(w, run)).map((e) => e.type);
  expect(types).toContain("AGENT_SPAWNED");
  expect(types.filter((x) => x === "AGENT_DONE").length).toBe(2);
}, 120_000);
