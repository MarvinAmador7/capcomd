// ADR-026 §6 (capability agents.park), on the in-memory fake with parking turned on (CAPCOMD_FAKE_HIBERNATE=1, as boxd
// and Docker park): a root agent (the planner the user talks to) keeps its machine parked when its turn ends, a worker
// (a child) has its machine destroyed as before; a message wakes the parked machine (the same one, its key carried over);
// a parked machine is deleted when its retention runs out (recorded with the run), when more than the limit are parked at
// its place (the oldest first), when its run is archived (its saved session stays) or its agent cancelled; and a parked
// machine holds no memory slot. The real CLI's side (its checkout and session reused, no restore; a machine that won't
// wake) is tests/subagents/park.test.ts.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, sleep, testPort } from "../helpers/engine";
import { parkedMachines } from "../../src/providers/machines";

const last = (s: string) => JSON.parse(s.trim().split("\n").pop()!);
let engine: Engine;
let dir = "";
let env: Record<string, string>;
const saved = process.env.CAPCOMD_ENDPOINT;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "capcomd-park-"));
  const port = await testPort();
  // A lead may spawn helpers (fake agents all the same: CAPCOMD_SPAWN_EXEC=fake; profiles govern only policy).
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", children: { allowSpawn: true, maxDepth: 1, maxChildren: 2, allowedChildProfiles: ["helper"] } },
    helper: { provider: "claude", auth: "apikey" },
  } }));
  const shared = { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_HOME: join(dir, "home"), CAPCOMD_AGENTS_FILE: agentsFile, ANTHROPIC_API_KEY: "sk-ant-api03-PARKTEST-abcdefghijklmnopqrstuvwxyz0123456789" };
  // Room for one agent (1 GB at 1 GB each), so a parked machine that held its slot would keep the next agent waiting.
  engine = new Engine(`park-${port}`, { port, dataDir: join(dir, "engine"), env: { ...shared, CAPCOMD_FAKE_HIBERNATE: "1", CAPCOMD_PARKED_MAX: "2", CAPCOMD_FAKE_MEMORY_MB: "1024", CAPCOMD_ADMIT_RETRY_MS: "300" } });
  await engine.start(null);
  env = { ...shared, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`, CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "200" };
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  if (saved === undefined) delete process.env.CAPCOMD_ENDPOINT; else process.env.CAPCOMD_ENDPOINT = saved;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const cj = async (args: string[], extra: Record<string, string> = {}) => { const x = await capcomd([...args, "--json"], { ...env, ...extra }); let j: any = null; try { j = last(x.stdout); } catch {} return { ...x, j }; };
const newRun = async (extra: Record<string, string> = {}) => (await cj(["run", "new"], extra)).j?.runId as string;
const spawn = async (run: string, key: string, more: string[] = []) => (await cj(["spawn", run, "--task", `work ${key}`, "--key", key, ...more])).j?.agentId as string;
const awaitOne = async (run: string, id: string) => (await cj(["await", run, id, "--timeout-ms", "60000"])).j?.agents?.[0];
const client = async () => (await import("../../src/core/relay")).client();
const worker = async (run: string, id: string, epoch = 1) => (await (await client()).worker.getOrCreate(epoch > 1 ? [run, id, `e${epoch}`] : [run, id]).getWorker({ workerId: id })) as { state: string; context: any } | null;
const parked = (o: { runId?: string; agentId?: string } = {}) => parkedMachines(o, { CAPCOMD_HOME: join(dir, "home") });
const until = async (ok: () => Promise<boolean> | boolean, ms = 20_000) => { const t = Date.now() + ms; while (Date.now() < t) { if (await ok()) return true; await sleep(150); } return false; };

test("a root agent's machine is parked when its turn ends; a message wakes the same machine; a child's machine is destroyed", async () => {
  const run = await newRun();
  // Not started yet, so its child (a worker: an agent with a parent) can be spawned under it first.
  const lead = await spawn(run, "lead", ["--no-start", "--profile", "lead"]);
  const kid = await spawn(run, "kid", ["--parent", lead, "--profile", "helper"]);
  expect((await awaitOne(run, kid))?.status).toBe("done");
  // A worker is destroyed when it ends, as before.
  expect((await worker(run, kid))?.state).toBe("destroyed");
  expect(parked({ runId: run, agentId: kid })).toEqual([]);
  expect((await awaitOne(run, lead))?.status).toBe("done");
  const first = await worker(run, lead);
  expect(first?.state).toBe("parked");
  const rec = parked({ runId: run, agentId: lead });
  expect(rec).toHaveLength(1);
  expect(rec[0]!.parked).toMatchObject({ vmId: first!.context.vmId, idemKey: first!.context.idemKey });
  // Its retention: the default (24 h), as recorded with the run.
  expect(rec[0]!.parked.deleteAt - rec[0]!.parked.at).toBe(86_400_000);
  // A message wakes it: its next attempt's machine is the parked one (its key carried over, not the epoch's).
  expect((await cj(["send", run, lead, "one more thing"])).j).toMatchObject({ continued: true, epoch: 2 });
  expect((await awaitOne(run, lead))).toMatchObject({ status: "done", epoch: 2 });
  expect((await worker(run, lead))?.state).toBe("released");
  const second = await worker(run, lead, 2);
  expect(second?.context).toMatchObject({ vmId: first!.context.vmId, idemKey: first!.context.idemKey, woke: true });
  // Parked again, by its new worker, under the same key.
  expect(second?.state).toBe("parked");
  expect(parked({ runId: run, agentId: lead }).map((m) => [m.parked.idemKey, m.workerKey])).toEqual([[first!.context.idemKey, [run, lead, "e2"]]]);
}, 120_000);

test("cancel and archive delete the parked machines (a restored run's agents get fresh ones)", async () => {
  const run = await newRun();
  const a = await spawn(run, "a"), b = await spawn(run, "b");
  for (const id of [a, b]) expect((await awaitOne(run, id))?.status).toBe("done");
  expect(parked({ runId: run })).toHaveLength(2);
  expect((await cj(["cancel", run, a])).code).toBe(0);
  expect((await worker(run, a))?.state).toBe("destroyed");
  expect(parked({ runId: run }).map((m) => m.agentId)).toEqual([b]);
  expect((await cj(["run", "archive", run])).j).toMatchObject({ changed: true });
  expect((await worker(run, b))?.state).toBe("destroyed");
  expect(parked({ runId: run })).toEqual([]);
  // Restored, its agent takes a message on a fresh machine.
  expect((await cj(["run", "restore", run])).j).toMatchObject({ changed: true });
  expect((await cj(["send", run, b, "back again"])).j).toMatchObject({ continued: true });
  expect(await awaitOne(run, b)).toMatchObject({ status: "done", epoch: 2 });
  const fresh = await worker(run, b, 2);
  expect(fresh?.context.woke).toBeUndefined();
  expect(fresh?.context.idemKey).not.toBe((await worker(run, b))?.context.idemKey);
}, 120_000);

test("retention: the run's recorded retention runs out and its worker deletes the parked machine", async () => {
  const run = await newRun({ CAPCOMD_PARKED_RETENTION_SECONDS: "3" });
  const id = await spawn(run, "short");
  expect((await awaitOne(run, id))?.status).toBe("done");
  const rec = parked({ runId: run });
  expect(rec).toHaveLength(1);
  expect(rec[0]!.parked.deleteAt - rec[0]!.parked.at).toBe(3000);
  expect(await until(async () => (await worker(run, id))?.state === "destroyed", 20_000)).toBe(true);
  expect(parked({ runId: run })).toEqual([]);
  // A message after that gets a fresh machine.
  expect((await cj(["send", run, id, "still there?"])).j).toMatchObject({ continued: true });
  expect(await awaitOne(run, id)).toMatchObject({ status: "done", epoch: 2 });
  expect((await worker(run, id, 2))?.context.woke).toBeUndefined();
}, 120_000);

test("at most the limit parked per place (2 here): the oldest goes first; and a parked machine holds no slot", async () => {
  // Earlier tests' parked machines go first: one run of its own, the place's whole list read before and after.
  for (const m of parked()) await cj(["run", "archive", m.runId]);
  expect(parked()).toEqual([]);
  const run = await newRun();
  const ids: string[] = [];
  // One slot: each starts only once the one before it ended, so a parked machine holding its slot would stall the next.
  for (const k of ["p1", "p2", "p3"]) {
    const id = await spawn(run, k);
    ids.push(id);
    expect((await awaitOne(run, id))?.status).toBe("done");
    const logs = (await cj(["logs", run, id])).stdout;
    expect(logs).not.toContain("waiting for a local agent slot");
  }
  expect(parked({ runId: run }).map((m) => m.agentId)).toEqual([ids[1]!, ids[2]!]);
  expect((await worker(run, ids[0]!))?.state).toBe("destroyed");
  for (const id of ids.slice(1)) expect((await worker(run, id))?.state).toBe("parked");
}, 120_000);
