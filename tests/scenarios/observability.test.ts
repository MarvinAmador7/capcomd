// ADR-017 scenarios: observability from inside and outside the VM: stuck detection via heartbeats,
// explicit truncation of oversized results, and in-VM `events --follow` resume by seq.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, type World } from "./harness";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

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

test("activity line: the daemon records what an agent does from the capcomd ops it calls; harness.v1 shows it live, then in past tense", async () => {
  const run = await newRun(w);
  const child = w.script("slowchild", `sleep 4; capcomd result --summary "c" >/dev/null`);
  const planner = w.script("spawner", `
set -e
id=$(capcomd spawn --profile worker --task slow --key slow --children.maxChildren=0 --contract "$($S/json script='${child}')" | $S/jget agentId)
capcomd await "$id" --timeout-ms 60000 >/dev/null
capcomd result --summary "ok"
`);
  const root = await spawnRoot(w, run, "planner", planner);
  const clients = join(w.dir, "harness-clients.json");
  const { token } = addClient("activity", ["read"], clients);
  const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), pollMs: 100, state: harnessState(null) });
  const res = await app.request(`/v1/streams/${run}/events?feed=lifecycle&activity=1`, { headers: { authorization: `Bearer ${token}` } });
  expect(res.status).toBe(200);
  const r = res.body!.getReader(); const dec = new TextDecoder(); let t = ""; const end = Date.now() + 20_000;
  let pending: ReturnType<typeof r.read> | null = null;
  while (Date.now() < end && !/"text":"Waiting for sub-agents"/.test(t)) {
    pending ??= r.read();
    const x = await Promise.race([pending, Bun.sleep(500).then(() => null)]);
    if (!x) continue;
    pending = null;
    if (x.value) t += dec.decode(x.value);
    if (x.done) break;
  }
  r.cancel().catch(() => {});
  if (!t.includes("Waiting for sub-agents")) console.log(t);
  const frame = t.split("\n\n").find((f) => f.includes("event: agent.activity_changed") && f.includes("Waiting for sub-agents"));
  expect(frame).toBeDefined();
  expect(frame).not.toMatch(/^id: /m);
  expect(JSON.parse(frame!.slice(frame!.indexOf("data: ") + 6))).toMatchObject({ durability: "ephemeral", agentId: root, data: { status: "running", activity: { kind: "wait" } } });
  const aw = await waitAll(w, run, [root]);
  expect(aw.agents[0].status).toBe("done");
  const agents = (await rivetSource().agents(run))!;
  // Its last step was `capcomd result`; once done, the line is in past tense.
  expect(agents.find((a) => a.id === root)!.activity).toMatchObject({ kind: "report", text: "Reported back" });
  // Its step history (agent.step), from the same ops: one durable event per finished step, in order, the last one
  // recorded when it ended. Await's polls are one step.
  const evs = await (await app.request(`/v1/events?scope=${run}`, { headers: { authorization: `Bearer ${token}` } })).json() as any[];
  const steps = evs.filter((e) => e.type === "agent.step" && e.agentId === root);
  expect(steps.map((e) => [e.data.kind, e.data.n, e.text])).toEqual([["spawn", 1, "Started a sub-agent"], ["wait", 1, "Waited for sub-agents"], ["report", 1, "Reported back"]]);
  expect(steps.at(-1).seq).toBeLessThan(evs.find((e) => e.type === "agent.done" && e.agentId === root).seq);
}, 120_000);
