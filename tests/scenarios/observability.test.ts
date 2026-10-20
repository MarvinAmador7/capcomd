// ADR-017 scenarios: observability from inside and outside the VM: stuck detection via heartbeats,
// explicit truncation of oversized results, and in-VM `events --follow` resume by seq.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, type World } from "./harness";

let w: World;
beforeAll(async () => { w = await world("observe", { CAPCOMD_STUCK_AFTER_MS: "1500" }); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("stuck detection: a silent child is flagged stuck in tree/inspect, then clears on heartbeat", async () => {
  const run = await newRun(w);
  const child = w.script("silent", `sleep 5; capcomd heartbeat "back" >/dev/null; sleep 3; capcomd result --summary "recovered" >/dev/null`);
  const planner = w.script("watcher", `
set -e
id=$(capcomd spawn --profile worker --task silent --key silent --children.maxChildren=0 --contract "$($S/json script='${child}')" | $S/jget agentId)
echo "$id" > "$S/silent-id"
capcomd await "$id" --timeout-ms 60000 >/dev/null
capcomd result --summary "ok"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const idFile = `${w.dir}/s/silent-id`;
  let id = "";
  for (let i = 0; i < 100 && !id; i++) { await Bun.sleep(100); id = (await Bun.file(idFile).text().catch(() => "")).trim(); }
  expect(id).toMatch(/^agt-/);
  // while silent: stuck shows up (no heartbeat for > 1.5s)
  let stuck: string | undefined;
  for (let i = 0; i < 40 && !stuck; i++) { await Bun.sleep(150); stuck = (await w.cj(["inspect", run, id])).j?.stuck; }
  expect(stuck).toContain("no heartbeat");
  // after the heartbeat: cleared
  let cleared = false;
  for (let i = 0; i < 40 && !cleared; i++) { await Bun.sleep(100); const j = (await w.cj(["inspect", run, id])).j; cleared = j?.status === "running" && !j?.stuck && j?.heartbeatNote === "back"; if (j?.status === "done") break; }
  expect(cleared).toBe(true);
  const aw = await waitAll(w, run, [root]);
  expect(aw.agents[0].status).toBe("done");
}, 120_000);

test("oversized result: summary capped with an explicit truncation record; oversized data dropped and recorded", async () => {
  const run = await newRun(w);
  const big = w.script("big", `
s=$(node -e 'process.stdout.write("x".repeat(20000))')
d=$(node -e 'process.stdout.write(JSON.stringify({blob:"y".repeat(20000)}))')
capcomd result --summary "$s" --data "$d" >/dev/null`);
  const root = await spawnRoot(w, run, "worker", big);
  const aw = await waitAll(w, run, [root]);
  expect(aw.agents[0].status).toBe("done");
  const r = aw.agents[0].result;
  expect(Buffer.byteLength(r.summary)).toBeLessThanOrEqual(8192);
  expect(r.truncated).toEqual(expect.arrayContaining([
    expect.objectContaining({ field: "summary", bytes: 20000, kept: 8192 }),
    expect.objectContaining({ field: "data", kept: 0 }),
  ]));
  expect(r.data).toBeUndefined();
}, 120_000);

test("in-VM events --follow: parent sees its child's lifecycle with seq + ts + agentId; --since-seq resumes", async () => {
  const run = await newRun(w);
  const child = w.script("quick", `sleep 1; capcomd result --summary "c" >/dev/null`);
  const planner = w.script("follower", `
set -e
id=$(capcomd spawn --profile worker --task q --key q --children.maxChildren=0 --contract "$($S/json script='${child}')" | $S/jget agentId)
capcomd events --follow --until AGENT_DONE --timeout-ms 40000 > "$S/follow-$CAPCOMD_AGENT_ID.ndjson"
last=$(head -n 1 "$S/follow-$CAPCOMD_AGENT_ID.ndjson" | $S/jget event.seq)
capcomd events --since-seq "$last" > "$S/resume-$CAPCOMD_AGENT_ID.ndjson"
capcomd await "$id" --timeout-ms 30000 >/dev/null
capcomd result --summary "child=$id last=$last"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const aw = await waitAll(w, run, [root]);
  if (aw.agents[0].status !== "done") console.log(JSON.stringify((await w.cj(["logs", run, root])).j, null, 1));
  expect(aw.agents[0].status).toBe("done");
  const lines = (await Bun.file(`${w.dir}/s/follow-${root}.ndjson`).text()).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event);
  const evs = lines.map((l) => l.event);
  expect(evs.length).toBeGreaterThan(1);
  for (const e of evs) { expect(typeof e.seq).toBe("number"); expect(e.ts).toMatch(/Z$/); expect("agentId" in e).toBe(true); }
  for (let i = 1; i < evs.length; i++) expect(evs[i].seq).toBeGreaterThan(evs[i - 1].seq);
  const childId = String(aw.agents[0].result.summary).match(/child=(agt-[\w]+)/)?.[1];
  expect(evs.some((e) => e.type === "AGENT_DONE" && e.agentId === childId)).toBe(true);
  const resumed = (await Bun.file(`${w.dir}/s/resume-${root}.ndjson`).text()).trim().split("\n").map((l) => JSON.parse(l)).filter((l) => l.event).map((l) => l.event);
  const last = Number(String(aw.agents[0].result.summary).match(/last=(\d+)/)?.[1]);
  for (const e of resumed) expect(e.seq).toBeGreaterThan(last);
  expect(resumed.some((e) => e.type === "AGENT_DONE")).toBe(true);
}, 120_000);
