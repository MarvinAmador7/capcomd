// S1 (docs/durability.md, "Ground rules"): there is no outbox. A transition's side effects run where it happens, each
// with its own idempotency key; nothing is queued to run "later, on wake". Before, rows were written for a lease grant
// and a worker's provisioning and then marked dispatched on wake (or by `flushOutbox`) without anything running them.
// Across an engine restart (every actor wakes again) nothing is re-run, invented or lost: the event logs and states
// read the same as before it, and there is no `flushOutbox` to call.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { testPort } from "../helpers/engine";

let engine: Engine;
const saved = { ...process.env };
const env: Record<string, string> = { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1" };

beforeAll(async () => {
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("no-outbox", { port, dataDir: mkdtempSync(join(tmpdir(), "capcomd-no-outbox-")) });
  await engine.start(null);
  process.env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  for (const k of [...Object.keys(env), "CAPCOMD_ENDPOINT"]) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

test("transitions that used to write outbox rows leave nothing to re-dispatch; a restart re-runs and loses nothing", async () => {
  const { client } = await import("../../src/core/relay");
  const c = client() as any;
  const runId = `run-nooutbox-${Date.now().toString(36)}`;
  const board = c.taskBoard.getOrCreate([runId]);
  const worker = c.worker.getOrCreate([runId, `${runId}-worker-1`]);
  await board.createTask({ taskId: "t1", goal: "g", runId, maxRetries: 3 });
  // Both used to write outbox rows (taskEvent + leaseEvent; workerEvent).
  const lease = await board.grantLease({ taskId: "t1", workerId: `${runId}-worker-1` });
  expect(lease).toMatchObject({ taskId: "t1", epoch: 1 });
  await worker.provisionWorker({ workerId: `${runId}-worker-1`, runId, epoch: 1 });

  const before = {
    board: await board.listEventSeqs({}), worker: await worker.listEventSeqs({}),
    task: await board.getTask({ taskId: "t1" }), w: await worker.getWorker({ workerId: `${runId}-worker-1` }),
  };
  expect(before.task.state).toBe("leased");
  expect(before.w.state).toBe("idle");
  // Nothing is queued for later: the action that "flushed" it is gone.
  await expect(board.flushOutbox({})).rejects.toThrow();
  await expect(worker.flushOutbox({})).rejects.toThrow();

  // The engine goes away and comes back on the same data: every actor wakes again.
  await engine.stop();
  await engine.start(null);
  const after = {
    board: await board.listEventSeqs({}), worker: await worker.listEventSeqs({}),
    task: await board.getTask({ taskId: "t1" }), w: await worker.getWorker({ workerId: `${runId}-worker-1` }),
  };
  expect(after).toEqual(before);
}, 240_000);
