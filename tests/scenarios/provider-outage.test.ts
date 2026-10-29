// The live e2e of 2026-10-29: boxd's API stopped answering for a few minutes, and every agent running then failed
// (`machines.get failed … Deadline exceeded after 60.000s`) and left its VM running. Fault injection through the fake
// provider (CAPCOMD_FAKE_OUTAGE_FILE, read by the engine at every provider call), with a short outage window:
//  (a) an outage shorter than the window: the agent waits for its machine (a notice says so) and finishes;
//  (b) longer than the window: it fails with sandbox_unreachable (retryable), and its machine is destroyed once the
//      provider answers again;
//  (c) a destroy that fails for a while: retried (by the worker's own alarm) until nothing is left behind;
//  (d) a permanent error still fails at once.
// The same with the agent workflow (the default) and with CAPCOMD_AGENT_WORKFLOW=0.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

const WINDOW_MS = 3000;
let w: World;
const dir = mkdtempSync(join(tmpdir(), "capcomd-outage-"));
const faultFile = join(dir, "fault.json");
const ledger = join(dir, "machines");
const outage = (f: { ms: number; error?: string; ops?: string[] }) => writeFileSync(faultFile, JSON.stringify({ until: Date.now() + f.ms, ...(f.error ? { error: f.error } : {}), ...(f.ops ? { ops: f.ops } : {}) }));
const noOutage = () => rmSync(faultFile, { force: true });

beforeAll(async () => {
  w = await world("outage", {
    CAPCOMD_FAKE_OUTAGE_FILE: faultFile, CAPCOMD_SANDBOX_OUTAGE_MS: String(WINDOW_MS), CAPCOMD_SANDBOX_RETRY_BASE_MS: "100",
    CAPCOMD_MACHINES_LEDGER: ledger,
  });
}, 120_000);
afterAll(async () => { await w?.stop(); }, 60_000);

const client = async () => (await import("../../src/core/relay")).client();
const workerState = async (run: string, id: string) => (await (await client()).worker.getOrCreate([run, id]).getWorker({ workerId: id }))?.state ?? null;
const machinesLeft = () => { try { return readdirSync(ledger).filter((f) => f.endsWith(".json")); } catch { return []; } };
async function until<T>(what: string, fn: () => Promise<T>, ok: (v: T) => boolean, ms: number): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await fn(); if (ok(v)) return v; if (Date.now() > end) throw new Error(`${what}: still ${JSON.stringify(v)}`); await new Promise((r) => setTimeout(r, 200)); }
}
const events = async (run: string, id: string) => ((await w.cj(["events", run])).j.events as any[]).filter((e) => e.agentId === id);

test("(a) an outage shorter than the window: the agent waits for its machine, says so, and finishes; nothing is left", async () => {
  const run = await newRun(w);
  outage({ ms: 1200 });
  const id = await spawnRoot(w, run, "worker", w.script("a", WORKER));
  const aw = await waitAll(w, run, [id], 60_000);
  expect(aw.agents[0].status).toBe("done");
  const ev = await events(run, id);
  expect(ev.filter((e) => e.type === "DRIVE_FAILED")).toEqual([]);
  const notices = ev.filter((e) => e.type === "AGENT_NOTICE").map((e) => e.event);
  expect(notices[0]?.kind).toBe("sandbox_outage");
  expect(notices[0]?.detail).toContain("the sandbox provider (fake) hasn't answered since");
  expect(ev.some((e) => e.type === "AGENT_NOTICE_CLEARED")).toBe(true);
  await until("worker", () => workerState(run, id), (s) => s === "destroyed", 20_000);
  expect(machinesLeft()).toEqual([]);
}, 90_000);

test("(b) longer than the window: the agent fails with sandbox_unreachable, and its machine goes once the provider answers", async () => {
  noOutage();
  const run = await newRun(w);
  const id = await spawnRoot(w, run, "worker", w.script("b", `sleep 2\n${WORKER}`));
  // Its machine is up and the agent works: now the provider stops answering, for longer than the window.
  await until("worker busy", () => workerState(run, id), (s) => s === "busy", 30_000);
  const t0 = Date.now();
  outage({ ms: 9000 });
  const aw = await waitAll(w, run, [id], 60_000);
  expect(aw.agents[0].status).toBe("failed");
  expect(aw.agents[0].result.errorKind).toBe("sandbox_unreachable");
  expect(aw.agents[0].result.retryable).toBe(true);
  expect(aw.agents[0].result.error).toMatch(/the sandbox provider \(fake\) didn't answer for/);
  expect(Date.now() - t0).toBeLessThan(25_000);
  // Not counted as ordinary failures: one attempt, failed for good (no retries that would wait the window again).
  const df = (await events(run, id)).filter((e) => e.type === "DRIVE_FAILED");
  expect(df.length).toBe(1);
  expect(df[0].event.error_kind).toBe("sandbox_unreachable");
  // The provider answers again (the injected outage ends): the worker's alarm destroys the machine.
  await until("worker destroyed", () => workerState(run, id), (s) => s === "destroyed", 45_000);
  expect(machinesLeft()).toEqual([]);
}, 120_000);

test("(c) a destroy that fails for a while is tried again until nothing is left; the agent is done", async () => {
  noOutage();
  const run = await newRun(w);
  outage({ ms: 6000, ops: ["destroy"] });
  const id = await spawnRoot(w, run, "worker", w.script("c", WORKER));
  const aw = await waitAll(w, run, [id], 60_000);
  expect(aw.agents[0].status).toBe("done");
  await until("worker destroyed", () => workerState(run, id), (s) => s === "destroyed", 45_000);
  expect(machinesLeft()).toEqual([]);
}, 120_000);

test("(d) a permanent error fails at once, without waiting for the window", async () => {
  const run = await newRun(w);
  outage({ ms: 60_000, error: "auth", ops: ["ensure"] });
  const t0 = Date.now();
  const id = await spawnRoot(w, run, "worker", w.script("d", WORKER));
  const aw = await waitAll(w, run, [id], 60_000);
  noOutage();
  expect(aw.agents[0].status).toBe("failed");
  expect(aw.agents[0].result.error).toContain("BOXD_API_KEY was rejected");
  expect(aw.agents[0].result.errorKind).toBeUndefined();
  expect(Date.now() - t0).toBeLessThan(WINDOW_MS + 5000);
  expect((await events(run, id)).filter((e) => e.type === "AGENT_NOTICE")).toEqual([]);
}, 90_000);
