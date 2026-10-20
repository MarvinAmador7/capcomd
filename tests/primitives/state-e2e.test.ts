// ADR-016 step 3 end to end against a real engine: task board (add/claim/renew/release/done,
// fencing, lease expiry takeover, keyed replays), blackboard (put/cas/get/list, keyed replays,
// concurrent cas race) and events --follow.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn } from "child_process";
import { Engine } from "../chaos/engine";
import { capcomd } from "../helpers/engine";
import { primitivesAgentsFile } from "./helpers";

const PORT = 7681;
let engine: Engine;
let env: Record<string, string>;
const saved = { ...process.env };
const ROOT = new URL("../..", import.meta.url).pathname;

beforeAll(async () => {
  env = { CAPCOMD_AGENTS_FILE: primitivesAgentsFile(), CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1" };
  Object.assign(process.env, env);
  engine = new Engine("primitives-state-e2e", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-state-eng-")) });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${PORT}`;
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const r = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(r.stdout.trim().split("\n").pop()!); } catch {}
  return { ...r, j };
};

test("task board: claim, fencing, expiry takeover, keyed replay, done", async () => {
  const runId = (await cj(["run", "new", "--budget", "usd=1", "--key", `st-${Date.now()}`])).j.runId;
  const a = await cj(["task", "add", runId, "--title", "write tests", "--data", '{"files":["a.ts"]}', "--key", "t1"]);
  expect(a.j).toMatchObject({ ok: true, created: true, task: { status: "open", epoch: 0, data: { files: ["a.ts"] } } });
  const tid = a.j.task.taskId;
  expect(tid).toMatch(/^tsk-k[0-9a-f]{16}$/);
  expect((await cj(["task", "add", runId, "--title", "write tests", "--data", '{"files":["a.ts"]}', "--key", "t1"])).j).toMatchObject({ created: false, task: { taskId: tid } });
  expect((await cj(["task", "add", runId, "--title", "other", "--key", "t1"])).j).toMatchObject({ ok: false, error: { code: "conflict" } });

  const c1 = await cj(["task", "claim", runId, "--holder", "w1", "--lease-ms", "1500", "--key", "c-w1"]);
  expect(c1.j).toMatchObject({ claimed: true, taskId: tid, holder: "w1", epoch: 1, takeover: null });
  expect((await cj(["task", "claim", runId, "--holder", "w1", "--lease-ms", "1500", "--key", "c-w1"])).j).toMatchObject({ epoch: 1, replayed: true });
  expect((await cj(["task", "claim", runId, tid, "--holder", "w2"])).j).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect((await cj(["task", "claim", runId, "--holder", "w2"])).j).toMatchObject({ claimed: false });
  expect((await cj(["task", "renew", runId, tid, "--holder", "w1", "--epoch", "1", "--lease-ms", "1500"])).j).toMatchObject({ ok: true, epoch: 1 });

  await Bun.sleep(1700); // w1's lease expires; w2 takes over
  const c2 = await cj(["task", "claim", runId, "--holder", "w2", "--lease-ms", "60000", "--key", "c-w2"]);
  expect(c2.j).toMatchObject({ claimed: true, taskId: tid, holder: "w2", epoch: 2, takeover: { holder: "w1", epoch: 1 } });
  // w1 comes back late: fenced out of renew and done
  expect((await cj(["task", "renew", runId, tid, "--holder", "w1", "--epoch", "1"])).j).toMatchObject({ ok: false, error: { code: "conflict" } });
  const late = await cj(["task", "done", runId, tid, "--holder", "w1", "--epoch", "1", "--result", '"stale"']);
  expect(late.j).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(late.j.error.message).toContain("lease lost");

  expect((await cj(["task", "release", runId, tid, "--holder", "w2", "--epoch", "2"])).j).toMatchObject({ status: "open" });
  const c3 = await cj(["task", "claim", runId, tid, "--holder", "w3"]);
  expect(c3.j).toMatchObject({ epoch: 3, takeover: null });
  const d = await cj(["task", "done", runId, tid, "--holder", "w3", "--epoch", "3", "--result", '{"pr":7}', "--key", "d3"]);
  expect(d.j).toMatchObject({ status: "done", epoch: 3 });
  expect((await cj(["task", "done", runId, tid, "--holder", "w3", "--epoch", "3", "--result", '{"pr":7}', "--key", "d3"])).j).toMatchObject({ replayed: true });
  expect((await cj(["task", "show", runId, tid])).j).toMatchObject({ status: "done", holder: "w3", epoch: 3, result: { pr: 7 } });
  expect((await cj(["task", "list", runId, "--status", "done"])).j.tasks).toHaveLength(1);

  const evs = (await cj(["events", runId, "--limit", "1000"])).j.events.map((e: any) => e.type);
  for (const [type, n] of [["TASK_ADDED", 1], ["TASK_CLAIMED", 3], ["TASK_LEASE_EXPIRED", 1], ["TASK_RELEASED", 1], ["TASK_DONE", 1]] as const) {
    expect(evs.filter((t: string) => t === type).length).toBe(n);
  }
}, 120_000);

test("blackboard: put, cas, replay, race, list; events --follow", async () => {
  const runId = (await cj(["run", "new", "--budget", "usd=1", "--key", `kv-${Date.now()}`])).j.runId;
  // follower started first, stops at the 2nd KV_CAS of key 'plan'... we stop on KV_PUT of 'done'
  const follow = spawn(process.execPath, ["src/cli/index.ts", "events", runId, "--follow", "--until", "KV_PUT", "--timeout-ms", "60000", "--json"], { cwd: ROOT, env: { ...process.env, ...env } });
  let fout = "";
  follow.stdout.on("data", (d) => (fout += d));
  const followed = new Promise<number>((r) => follow.on("close", (c) => r(c ?? 1)));
  await Bun.sleep(1500);

  expect((await cj(["kv", "get", runId, "plan"])).j).toMatchObject({ version: 0, value: null });
  expect((await cj(["kv", "cas", runId, "plan", '{"step":1}', "--expect", "0", "--key", "p1"])).j).toMatchObject({ ok: true, version: 1 });
  expect((await cj(["kv", "cas", runId, "plan", '{"step":1}', "--expect", "0", "--key", "p1"])).j).toMatchObject({ version: 1, replayed: true });
  const stale = await cj(["kv", "cas", runId, "plan", '{"step":9}', "--expect", "0"]);
  expect(stale.j).toMatchObject({ ok: false, error: { code: "conflict" } });
  expect(stale.j.error.message).toContain("version is 1");

  // 6 writers race to increment a counter with read-cas-retry; exactly 6 increments land.
  const writer = async (i: number) => {
    for (let n = 0; n < 50; n++) {
      const cur = (await cj(["kv", "get", runId, "counter"])).j;
      const r = await cj(["kv", "cas", runId, "counter", String((cur.value ?? 0) + 1), "--expect", String(cur.version), "--key", `inc-${i}-${cur.version}`]);
      if (r.j?.ok === true && r.j.version) return n;
    }
    throw new Error(`writer ${i} starved`);
  };
  await Promise.all([0, 1, 2, 3, 4, 5].map(writer));
  expect((await cj(["kv", "get", runId, "counter"])).j).toMatchObject({ value: 6, version: 6 });

  expect((await cj(["kv", "put", runId, "done", "true"])).j).toMatchObject({ version: 1 });
  expect((await cj(["kv", "list", runId])).j.entries.map((e: any) => e.k)).toEqual(["counter", "done", "plan"]);
  expect((await cj(["kv", "list", runId, "--prefix", "pl"])).j.entries).toHaveLength(1);
  expect((await cj(["kv", "put", runId, "bad key", "1"])).j).toMatchObject({ ok: false, error: { code: "usage" } });

  expect(await followed).toBe(0);
  const lines = fout.trim().split("\n").map((l) => JSON.parse(l));
  const types = lines.filter((l) => l.event).map((l) => l.event.type);
  expect(types.filter((t) => t === "KV_CAS")).toHaveLength(7);
  expect(types.at(-1)).toBe("KV_PUT");
  expect(lines.at(-1)).toMatchObject({ end: { stopped: "until", type: "KV_PUT" } });
}, 180_000);
