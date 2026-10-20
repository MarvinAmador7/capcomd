// ADR-016 step 3: shared state over the run's scope actor. Task board (leases with fencing
// epochs), blackboard (versioned kv with cas) and an event follower. Every write takes an
// optional --key: repeating it replays the recorded result, so a caller that crashed or lost
// the reply can retry safely; the same key with other parameters is a conflict.
import { client, assertEngine, listEvents, type EventRecord } from "../core/relay";
import { RelayError } from "../core/errors";
import { checkKey, leaseMs } from "./board";
import { paramsHash, stableId } from "./policy";
import { asRelay } from "./ops";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const usage = (e: unknown, hint: string): never => { throw new RelayError("usage", (e as Error).message, hint); };

async function scope(runId: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  if (!(await s.getScope({}))) throw new RelayError("not_found", `run ${runId} has no primitives scope`, "Create it with `capcomd run new --json`.");
  return s;
}
const lease = (v: unknown) => { try { return leaseMs(v); } catch (e) { return usage(e, "--lease-ms between 100 and 86400000"); } };

export async function taskAdd(runId: string, o: { title: string; data?: unknown; key?: string; id?: string }) {
  const s = await scope(runId);
  const taskId = o.id ?? stableId("tsk", runId, o.key);
  return s.taskAdd({ taskId, title: o.title, data: o.data, key: o.key, paramsHash: paramsHash({ title: o.title, data: o.data ?? null }) }).catch(asRelay);
}
export async function taskClaim(runId: string, o: { holder: string; taskId?: string; leaseMs?: number; key?: string }) {
  const s = await scope(runId);
  const ms = lease(o.leaseMs);
  return s.taskClaim({ holder: o.holder, taskId: o.taskId, leaseMs: ms, key: o.key, paramsHash: paramsHash({ holder: o.holder, taskId: o.taskId ?? null, leaseMs: ms }) }).catch(asRelay);
}
export async function taskRenew(runId: string, o: { taskId: string; holder: string; epoch: number; leaseMs?: number }) {
  const s = await scope(runId);
  return s.taskRenew({ taskId: o.taskId, holder: o.holder, epoch: o.epoch, leaseMs: lease(o.leaseMs) }).catch(asRelay);
}
export async function taskFinish(runId: string, o: { taskId: string; holder: string; epoch: number; outcome: "done" | "released"; result?: unknown; key?: string }) {
  const s = await scope(runId);
  return s.taskFinish({ ...o, paramsHash: paramsHash({ taskId: o.taskId, holder: o.holder, epoch: o.epoch, outcome: o.outcome, result: o.result ?? null }) }).catch(asRelay);
}
export async function taskList(runId: string, status?: string) {
  const s = await scope(runId);
  return { runId, tasks: await s.taskList({ ...(status ? { status } : {}) }) };
}
export async function taskGet(runId: string, taskId: string) {
  const s = await scope(runId);
  const t = await s.taskGet({ taskId });
  if (!t) throw new RelayError("not_found", `task ${taskId} not found`, "List tasks with `capcomd task list <runId> --json`.");
  return t;
}

export async function kvGet(runId: string, k: string) {
  const s = await scope(runId);
  return (await s.kvGet({ k })) ?? { k, value: null, version: 0, writer: null, updatedAt: 0 };
}
export async function kvWrite(runId: string, o: { k: string; value: unknown; expect?: number; writer?: string; key?: string }) {
  try { checkKey(o.k); } catch (e) { usage(e, "Keys: letters, digits and . _ : / - (max 200)."); }
  if (o.expect !== undefined && !(Number.isInteger(o.expect) && o.expect >= 0)) usage(new Error(`--expect must be a version >= 0, got ${o.expect}`), "0 means the key must not exist yet.");
  const s = await scope(runId);
  return s.kvWrite({ ...o, paramsHash: paramsHash({ k: o.k, value: o.value ?? null, expect: o.expect ?? null }) }).catch(asRelay);
}
export async function kvList(runId: string, prefix?: string) {
  const s = await scope(runId);
  return { runId, entries: await s.kvList({ ...(prefix ? { prefix } : {}) }) };
}

/** Poll the merged event log and emit each event once, in order. Stops on --until TYPE or timeout. */
export async function followEvents(runId: string, o: { emit: (e: EventRecord) => void; until?: string; timeoutMs?: number; pollMs?: number; fromStart?: boolean }) {
  const seen = new Set<string>();
  const id = (e: EventRecord) => `${e.entity}\0${e.seq}`;
  if (!o.fromStart) for (const e of await listEvents(runId)) seen.add(id(e));
  const deadline = o.timeoutMs ? Date.now() + o.timeoutMs : Infinity;
  for (;;) {
    for (const e of await listEvents(runId)) {
      if (seen.has(id(e))) continue;
      seen.add(id(e));
      o.emit(e);
      if (o.until && e.type === o.until) return { stopped: "until", type: e.type };
    }
    if (Date.now() >= deadline) return { stopped: "timeout" };
    await sleep(o.pollMs ?? 500);
  }
}
