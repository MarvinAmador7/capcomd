// Machine checks for the live e2e (scripts/mac-subagents-e2e.sh), ADR-026 §5–§6. boxd only: each command exits 3 on
// another provider ("skipped"). Talks to the run's engine (CAPCOMD_ENDPOINT) and to boxd itself, never to capcomd's
// own idea of what it did. The boxd key comes as the CLI gets it (environment, then the keychain), never printed.
//
//   watch   <run> <out.ndjson> [everyMs]   sample the run's agents and their boxd machines until killed
//   workers <run> <out.ndjson> <planner>   each worker's machine was destroyed when its agent ended (≤ 120 s)
//   parked  <run> <agent> [holdSeconds]    its machine is parked (hibernated), with its delete-after about the
//                                          retention, and stays hibernated (nothing pings it) for holdSeconds
//   machine <run> <agent>                  JSON: the agent's latest machine (vm id, name, boxd state, delete-at)
//   gone    <run> <agent> [waitSeconds]    every machine the agent ever had is gone at boxd
//   remove  <vmId>                         delete a machine at boxd (the e2e's "parked machine deleted by hand")
//
// Exit: 0 ok, 1 failed, 2 could not check, 3 skipped (not boxd).
import "../src/cli/apply-config";
import { appendFileSync, readFileSync } from "node:fs";
import { createClient } from "rivetkit/client";
import { BoxdProvider, vmNameFor } from "../src/providers/boxd";

const [cmd, a1, a2, a3] = process.argv.slice(2);
const usage = () => { console.error("usage: e2e-machines.ts watch|workers|parked|machine|gone|remove …"); process.exit(2); };
if (!cmd) usage();
if ((process.env.CAPCOMD_SANDBOX ?? "boxd") !== "boxd") { console.log(`SKIPPED: the provider is ${process.env.CAPCOMD_SANDBOX}, not boxd (parked checks are boxd-only here)`); process.exit(3); }
if (!process.env.BOXD_API_KEY) { console.log("UNKNOWN: no boxd key (BOXD_API_KEY or the keychain)"); process.exit(2); }

const ENDED = new Set(["done", "failed", "cancelled"]);
const GONE = new Set(["destroyed", "deleted", "failed", "deleting"]);
const PARKED = new Set(["hibernated", "sleeping"]);
const endpoint = process.env.CAPCOMD_ENDPOINT ?? "http://127.0.0.1:6420";
const engine: any = createClient({ endpoint });
const boxd = new BoxdProvider({ keepaliveMs: 0, dbPath: ":memory:" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString().slice(11, 19) : "-");
const done = async (code: number): Promise<never> => { await boxd.close().catch(() => {}); process.exit(code); };

type Agent = { agentId: string; profile: string | null; parent: string | null; status: string; epoch: number; updatedAt: number };
type Box = { id: string; name: string; state: string; deleteAt: number | null };
type Attempt = { epoch: number; vmId: string | null; name: string | null; state: string };

const workerKey = (run: string, agentId: string, epoch: number) => (epoch > 1 ? [run, agentId, `e${epoch}`] : [run, agentId]);
async function agents(run: string): Promise<Agent[]> {
  const xs = await engine.scope.getOrCreate([run]).listAgents({});
  return xs.map((x: any) => ({ agentId: x.agentId, profile: x.profile, parent: x.parent, status: x.status, epoch: Number(x.epoch ?? 1), updatedAt: Number(x.updatedAt) }));
}
/** Every attempt's machine of `a` as its worker recorded it (a worker that doesn't exist yet is skipped, never created). */
async function attempts(run: string, a: Agent): Promise<Attempt[]> {
  const out: Attempt[] = [];
  for (let e = 1; e <= a.epoch; e++) {
    const w = await engine.worker.get(workerKey(run, a.agentId, e)).getWorker({ workerId: a.agentId }).catch(() => null);
    if (!w) continue;
    const idem = w.context?.idemKey as string | undefined;
    out.push({ epoch: e, vmId: (w.context?.vmId as string | undefined) ?? null, name: idem ? vmNameFor(idem) : null, state: String(w.state) });
  }
  return out;
}
async function machines(): Promise<Box[]> {
  return (await boxd.list("relay-")).map((m) => ({ id: m.id, name: m.name, state: m.state, deleteAt: m.deleteAt ?? null }));
}
const matching = (all: Box[], at: Attempt[]) => all.filter((m) => at.some((x) => (x.name && m.name === x.name) || (x.vmId && m.id === x.vmId)));
const alive = (ms: Box[]) => ms.filter((m) => !GONE.has(m.state));

if (cmd === "watch") {
  const [run, out] = [a1 ?? usage(), a2 ?? usage()];
  const every = Number(a3 ?? 10_000);
  const seen = new Map<string, Attempt[]>();
  for (;;) {
    try {
      const t = Date.now();
      const as = await agents(run);
      for (const a of as) seen.set(a.agentId, await attempts(run, a));
      const all = await machines();
      const byAgent: Record<string, Box[]> = {};
      for (const a of as) byAgent[a.agentId] = matching(all, seen.get(a.agentId) ?? []);
      appendFileSync(out, JSON.stringify({ t, agents: as, attempts: Object.fromEntries(seen), machines: byAgent }) + "\n");
    } catch (e) { appendFileSync(out, JSON.stringify({ t: Date.now(), error: String((e as Error)?.message ?? e).slice(0, 300) }) + "\n"); }
    await sleep(every);
  }
}

if (cmd === "workers") {
  const [run, file, planner] = [a1 ?? usage(), a2 ?? usage(), a3 ?? usage()];
  let text = "";
  try { text = readFileSync(file, "utf8"); } catch { /* no samples */ }
  const snaps = text.trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((s) => !s.error);
  if (!snaps.length) { console.log("WORKER MACHINES: UNKNOWN (no samples)"); await done(2); }
  const ids = new Set<string>();
  for (const s of snaps) for (const a of s.agents as Agent[]) if (a.agentId !== planner) ids.add(a.agentId);
  let late = 0, left = 0, checked = 0;
  const LATE_MS = 120_000;
  for (const id of ids) {
    const rows = snaps.map((s) => ({ t: s.t as number, all: s.agents as Agent[], a: (s.agents as Agent[]).find((x) => x.agentId === id), m: (s.machines[id] ?? []) as Box[] })).filter((r) => r.a);
    const first = rows[0]!.a!;
    const everAlive = rows.filter((r) => alive(r.m).length);
    // Each time it ended (an agent the planner messaged runs again: its new machine is legitimate).
    let endedAt: number | null = null, destroyedBy: number | null = null, flagged = false;
    const lines: string[] = [];
    for (const r of rows) {
      const ended = ENDED.has(r.a!.status);
      if (ended && endedAt === null) { endedAt = r.a!.updatedAt; destroyedBy = null; flagged = false; }
      if (!ended && endedAt !== null) { endedAt = null; lines.push("ran again"); }
      if (endedAt === null) continue;
      if (alive(r.m).length) {
        if (r.t - endedAt > LATE_MS && !flagged) { flagged = true; late++; lines.push(`LATE: machine ${alive(r.m).map((m) => `${m.id}=${m.state}`).join(",")} alive ${Math.round((r.t - endedAt) / 1000)}s after it ended`); }
      } else if (destroyedBy === null) {
        destroyedBy = r.t;
        const siblings = r.all.filter((x) => x.agentId !== id && x.agentId !== planner && x.status === "running").length;
        lines.push(`ended ${iso(endedAt)}, machine gone by ${iso(r.t)} (+${Math.max(0, Math.round((r.t - endedAt) / 1000))}s; ${siblings} other agent(s) running then)`);
      }
    }
    const last = rows.at(-1)!;
    if (ENDED.has(last.a!.status) && alive(last.m).length) { left++; lines.push(`LEFT: ${alive(last.m).map((m) => `${m.id}=${m.state}`).join(",")} at the last sample`); }
    if (!ENDED.has(last.a!.status)) lines.push(`still ${last.a!.status} at the last sample`);
    checked++;
    const ms = [...new Set(everAlive.flatMap((r) => r.m.map((m) => m.id)))];
    console.log(`   ${id} [${first.profile}] machine(s) ${ms.join(",") || "(never sampled alive)"}: ${lines.join("; ") || "-"}`);
  }
  if (!checked) { console.log(`WORKER MACHINES: FAIL (no worker sampled in ${snaps.length} samples)`); await done(1); }
  const ok = late === 0 && left === 0;
  console.log(`WORKER MACHINES: ${ok ? "OK" : "FAIL"} (${checked} agent(s), ${late} late, ${left} left; ${snaps.length} samples)`);
  await done(ok ? 0 : 1);
}

/** The agent's latest attempt with a machine, and that machine at boxd now. */
async function latest(run: string, agentId: string) {
  const a = (await agents(run)).find((x) => x.agentId === agentId);
  if (!a) throw new Error(`no agent ${agentId}`);
  const at = (await attempts(run, a)).filter((x) => x.vmId || x.name);
  const all = await machines();
  const cur = at.at(-1) ?? null;
  const box = cur ? all.find((m) => m.id === cur.vmId) ?? all.find((m) => m.name === cur.name) ?? null : null;
  return { agent: a, attempt: cur, box, every: matching(all, at) };
}

if (cmd === "machine") {
  const r = await latest(a1 ?? usage(), a2 ?? usage());
  console.log(JSON.stringify({ status: r.agent.status, epoch: r.agent.epoch, attemptEpoch: r.attempt?.epoch ?? null, workerState: r.attempt?.state ?? null, vmId: r.attempt?.vmId ?? null, name: r.attempt?.name ?? null, boxd: r.box }));
  await done(0);
}

if (cmd === "parked") {
  const [run, agentId] = [a1 ?? usage(), a2 ?? usage()];
  const hold = Number(a3 ?? 120);
  const { agentParkedRetention } = await import("../src/providers/run-sandbox");
  const { currentParkedRetention } = await import("../src/providers/settings");
  const retention = await agentParkedRetention(run, null, "boxd").catch(() => currentParkedRetention("boxd").seconds);
  // Its turn just ended: wait (up to 3 min) for its machine to reach hibernated.
  let r = await latest(run, agentId);
  const t0 = Date.now();
  while (!(r.box && PARKED.has(r.box.state)) && Date.now() - t0 < 180_000) { await sleep(5_000); r = await latest(run, agentId); }
  if (!r.box) { console.log(`PARKED: FAIL (no machine at boxd for ${agentId}: worker ${r.attempt?.state ?? "none"}, vm ${r.attempt?.vmId ?? "none"})`); await done(1); }
  const box = r.box!;
  if (!PARKED.has(box.state)) { console.log(`PARKED: FAIL (${box.id} ${box.name} is ${box.state} 180s after the turn ended; worker ${r.attempt?.state})`); await done(1); }
  const parkedSeen = Date.now();
  const leftS = box.deleteAt ? Math.round((box.deleteAt - parkedSeen) / 1000) : null;
  // The delete-after was set when it was parked (≤ 3 min ago): allow 15 min of margin either way.
  const ttlOk = leftS !== null && Math.abs(leftS - retention) <= 900;
  const states: string[] = [box.state];
  const stableFrom = Date.now();
  while (Date.now() - stableFrom < hold * 1000) {
    await sleep(15_000);
    const m = (await machines()).find((x) => x.id === box.id);
    states.push(m ? m.state : "gone");
  }
  const stayed = states.every((s) => PARKED.has(s));
  const counts = Object.entries(states.reduce((o, s) => ({ ...o, [s]: (o[s] ?? 0) + 1 }), {} as Record<string, number>)).map(([s, n]) => `${s}×${n}`).join(" ");
  const line = `id=${box.id} name=${box.name} epoch=${r.attempt?.epoch} worker=${r.attempt?.state} state=${box.state} deleteAt=${box.deleteAt ? new Date(box.deleteAt).toISOString() : "none"} (in ${leftS ?? "?"}s; retention ${retention}s) held ${hold}s: ${counts}`;
  const ok = ttlOk && stayed;
  console.log(`PARKED: ${ok ? "OK" : "FAIL"} ${line}${ttlOk ? "" : " [delete-after not about the retention]"}${stayed ? "" : " [it didn't stay hibernated]"}`);
  await done(ok ? 0 : 1);
}

if (cmd === "gone") {
  const [run, agentId] = [a1 ?? usage(), a2 ?? usage()];
  const wait = Number(a3 ?? 180);
  const t0 = Date.now();
  let r = await latest(run, agentId);
  while (alive(r.every).length && Date.now() - t0 < wait * 1000) { await sleep(5_000); r = await latest(run, agentId); }
  const left = alive(r.every);
  console.log(left.length ? `GONE: FAIL (${left.map((m) => `${m.id} ${m.name}=${m.state}`).join(", ")} after ${wait}s)` : `GONE: OK (none of ${agentId}'s machines is at boxd; ${Math.round((Date.now() - t0) / 1000)}s)`);
  await done(left.length ? 1 : 0);
}

if (cmd === "remove") {
  const id = a1 ?? usage();
  await boxd.client.machines.delete(id);
  console.log(`removed ${id}`);
  await done(0);
}
usage();
