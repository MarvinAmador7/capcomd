// ADR-022: the menu bar app reads the harness.v1 stream (apps/menubar/app/Sources/CapcomdStore/Frames.swift,
// Store.swift): snapshot.run/agents/approvals/steps/threads/end, then envelopes (agent status, activity, steps, results,
// approvals, pauses, verify/merge). Agents driven by the engine's workflow (the default) must produce the same frames
// as agents driven by agent-drive processes (CAPCOMD_AGENT_WORKFLOW=0). The same fake goal runs both ways: a planner
// whose worker writes a file, verified and merged into a protected trunk (parked, then approved), and a second agent
// paused before it starts and resumed. The test diffs what the app reads: which frame types arrive, the keys of their
// data, each agent's status sequence, and the snapshot frames' fields.
import { afterAll, expect, test } from "bun:test";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";
import { addClient, loadClients } from "../../src/api/clients";
import { rivetSource } from "../../src/api/rivet-source";
import { harnessApp } from "../../src/api/server";
import { harnessState } from "../../src/api/state";

interface Frame { event: string; data: any }
let w: World | null = null;
afterAll(async () => { await w?.stop(); });

/**
 * Read a run's stream until `stop()`, as the app opens it: the lifecycle feed with activity (badge, Active card), or the
 * full stream (a run's detail: steps, verify/merge, threads); frames as the app parses them (event name, payload).
 */
function readStream(w: World, run: string, feed: "lifecycle" | "full" = "lifecycle") {
  const clients = join(w.dir, `clients-${run}.json`);
  const { token } = addClient("frames", ["read"], clients);
  const app = harnessApp({ source: rivetSource(), clients: () => loadClients(clients), pollMs: 100, state: harnessState(null) });
  const frames: Frame[] = [];
  let stopped = false;
  const done = (async () => {
    const res = await app.request(`/v1/streams/${run}/events${feed === "lifecycle" ? "?feed=lifecycle&activity=1" : ""}`, { headers: { authorization: `Bearer ${token}` } });
    const r = res.body!.getReader(); const dec = new TextDecoder(); let buf = "";
    let pending: ReturnType<typeof r.read> | null = null;
    while (!stopped) {
      pending ??= r.read();
      const x = await Promise.race([pending, Bun.sleep(250).then(() => null)]);
      if (!x) continue;
      pending = null;
      if (x.done) break;
      buf += dec.decode(x.value);
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const event = /^event: (.*)$/m.exec(block)?.[1]; const data = /^data: (.*)$/m.exec(block)?.[1];
        if (event && data) { try { frames.push({ event, data: JSON.parse(data) }); } catch {} }
      }
    }
    r.cancel().catch(() => {});
  })();
  return { frames, stop: async () => { stopped = true; await done; } };
}

/** What the app reads, independent of ids, timing and counts. */
function shapeOf(frames: Frame[], roles: Record<string, string>) {
  const keys = (o: any) => (o && typeof o === "object" && !Array.isArray(o) ? Object.keys(o).sort() : []);
  const types: Record<string, string[]> = {};
  const add = (t: string, ks: string[]) => { types[t] = [...new Set([...(types[t] ?? []), ...ks])].sort(); };
  const statusSeq: Record<string, string[]> = {};
  const snapshot: Record<string, string[]> = {};
  for (const f of frames) {
    if (f.event.startsWith("snapshot.")) {
      const p = f.data?.data ?? f.data;
      if (f.event === "snapshot.run") snapshot["run"] = keys(p.run);
      if (f.event === "snapshot.agents") snapshot["agents"] = [...new Set((p.agents ?? []).flatMap((a: any) => keys(a)))].sort() as string[];
      if (f.event === "snapshot.approvals") snapshot["approvals"] = [...new Set((p.approvals ?? []).flatMap((a: any) => keys(a)))].sort() as string[];
      if (f.event === "snapshot.steps") snapshot["steps.types"] = [...new Set((p.steps ?? []).map((s: any) => s.type))].sort() as string[];
      if (f.event === "snapshot.threads") snapshot["threads"] = [...new Set((p.messages ?? []).flatMap((m: any) => keys(m)))].sort() as string[];
      continue;
    }
    const t = f.data?.type ?? f.event;
    add(t, keys(f.data?.data));
    const role = roles[f.data?.agentId ?? f.data?.data?.agentId ?? ""];
    if (role && /^agent\.(spawned|started|status_changed|done|failed|cancelled|paused|resumed)$/.test(t)) {
      const s = t === "agent.status_changed" ? `status:${f.data.data?.status}` : t;
      const seq = (statusSeq[role] ??= []);
      if (seq.at(-1) !== s) seq.push(s);
    }
  }
  return { types, statusSeq, snapshot };
}

async function goal(mode: "1" | "0") {
  w = await world(`frames-${mode}`, { CAPCOMD_PROTECTED_BRANCHES: "trunk", CAPCOMD_AGENT_WORKFLOW: mode });
  const worker = w.script("worker", WORKER);
  const planner = w.script("planner", `W=${JSON.stringify(worker)}
id=$(capcomd spawn --profile worker --task "write a" --key a --budget turns=10 --children.maxChildren=0 --contract "$($S/json script="FILE=src/a.txt CONTENT=a SPENT=2 $W")" | $S/jget agentId)
capcomd await $id >/dev/null || exit 1
v=$(capcomd verify --ref $id --key v-a)
m=$(capcomd merge --ref $id --require "$(echo "$v" | $S/jget id)" --key m-a)
capcomd kv put "mrg-a" "$($S/json id=$(echo "$m" | $S/jget id))" >/dev/null
capcomd result --summary "planned a" >/dev/null`);
  const run = await newRun(w);
  const live = readStream(w, run);
  const full = readStream(w, run, "full");
  await Bun.sleep(500);
  const root = await spawnRoot(w, run, "planner", planner);
  // A second agent, paused before it starts, then resumed.
  const later = (await w.cj(["spawn", run, "--profile", "worker", "--task", "write b", "--key", "b", "--no-start", "--contract", JSON.stringify({ script: worker })])).j.agentId as string;
  expect((await w.cj(["pause", run, later])).code).toBe(0);
  expect((await w.cj(["resume", run, later])).code).toBe(0);
  expect((await waitAll(w, run, [root, later])).agents.map((a: any) => a.status)).toEqual(["done", "done"]);
  const child = ((await w.cj(["tree", run])).j.tree[0].children[0]?.agentId) as string;
  const ma = (await w.cj(["kv", "get", run, "mrg-a"])).j.value.id as string;
  expect((await w.cj(["approve", run, ma, "--by", "frames@test"])).j).toMatchObject({ state: "merged" });
  await Bun.sleep(3000);
  await live.stop();
  await full.stop();
  // The opening snapshot of a stream opened after everything ended (what the app shows for a finished run).
  const after = readStream(w, run);
  const afterFull = readStream(w, run, "full");
  await Bun.sleep(2500);
  await after.stop();
  await afterFull.stop();
  const roles = { [root]: "planner", [child]: "worker", [later]: "paused-then-resumed" };
  const out = { live: shapeOf(live.frames, roles), full: shapeOf(full.frames, roles), after: shapeOf(after.frames, roles), afterFull: shapeOf(afterFull.frames, roles) };
  await w.stop(); w = null;
  return out;
}

test("the app's frames are the same whether the engine's workflow or agent-drive processes drive the agents", async () => {
  const on = await goal("1");
  const off = await goal("0");
  // What the app needs at all is there.
  console.log(`  frame types (both ways): ${Object.keys(on.live.types).sort().join(", ")}`);
  console.log(`  full-stream types: ${Object.keys(on.full.types).sort().join(", ")}`);
  console.log(`  snapshot frames: ${Object.keys(on.after.snapshot).sort().join(", ")} | full: ${Object.keys(on.afterFull.snapshot).sort().join(", ")}`);
  for (const t of ["agent.spawned", "agent.done", "agent.paused", "agent.resumed", "approval.requested", "approval.decided"]) {
    expect({ t, on: !!on.live.types[t] }).toEqual({ t, on: true });
  }
  const diff = (a: Record<string, string[]>, b: Record<string, string[]>) =>
    [...new Set([...Object.keys(a), ...Object.keys(b)])].sort().filter((k) => JSON.stringify(a[k] ?? null) !== JSON.stringify(b[k] ?? null)).map((k) => `${k}: workflow ${JSON.stringify(a[k] ?? null)} vs agent-drive ${JSON.stringify(b[k] ?? null)}`);
  const d = [...diff(on.live.types, off.live.types).map((x) => `type ${x}`), ...diff(on.live.statusSeq, off.live.statusSeq).map((x) => `status ${x}`),
    ...diff(on.after.snapshot, off.after.snapshot).map((x) => `snapshot ${x}`), ...diff(on.after.types, off.after.types).map((x) => `snapshot-replay ${x}`),
    ...diff(on.full.types, off.full.types).map((x) => `full ${x}`), ...diff(on.full.statusSeq, off.full.statusSeq).map((x) => `full-status ${x}`),
    ...diff(on.afterFull.snapshot, off.afterFull.snapshot).map((x) => `full-snapshot ${x}`)];
  if (d.length) console.log(d.join("\n"));
  expect(d).toEqual([]);
}, 600_000);
