// ADR-026 §3 schedules: the timer form of a wake, by Vercel Board's rules (the slot logic itself: tests/unit/schedules.test.ts).
//
// Through a real agent CLI (fake claude in a host-exec FakeProvider, the in-VM capcomd and the supervisor feeding its
// stdin): `capcomd wake --every 6s --times 2` books a recurring check-in; the first reaches the CLI as a new turn, and
// the agent's turn then ends idle with the schedule still armed; the second continues the idle agent (its next attempt,
// the same conversation), and the schedule is over. On the scope actor: a schedule outlives its agent's turn, and ends
// when its agent is cancelled or its run archived.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let env: Record<string, string>;
let dir = "";
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  const r = await bareRepo({ mode: "direct" });
  dir = mkdtempSync(join(tmpdir(), "capcomd-schedules-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, allowedChildProfiles: ["lead", "worker"] } },
    worker: { provider: "claude", auth: "apikey", maxTurns: 20 },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    CAPCOMD_RPC_KEY: `sched-${Math.random()}`,
    ANTHROPIC_API_KEY: "sk-ant-api03-SCHEDULE-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_MESSAGE_FALLBACK_MS: "600000",
    // Schedules repeat at most once a minute; here, every few seconds.
    CAPCOMD_SCHEDULE_MIN_MS: "1000",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("schedules", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => (dir && l.includes(dir)) || runs.some((r) => l.includes(`/${r}/`))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const scope = async (run: string) => (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
const events = async (run: string, type?: string) => ((await (await scope(run)).getEvents({})) as any[]).filter((e) => !type || e.type === type);
const newRun = async () => { const run = (await cj(["run", "new"])).j?.runId as string; runs.push(run); return run; };
const awaitOne = async (run: string, id: string) => (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
/** What the fake CLI wrote in the agent's stable directory (`${workdir}/<agentId>/`, the parent of its checkout). */
const seen = (id: string, f: string) => { const p = join(dir, "vm", id, f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
const lastJson = (s: string) => JSON.parse(s.trim().split("\n").filter(Boolean).pop()!);
/** Until `pred` holds of the agent's record (an attempt ending, a continued one starting), at most `ms`. */
async function until(run: string, id: string, pred: (a: any) => boolean, ms = 90_000) {
  const t = Date.now();
  for (;;) {
    const a = await (await scope(run)).getAgent({ agentId: id });
    if (a && pred(a)) return a;
    if (Date.now() - t > ms) throw new Error(`${id} never got there: ${JSON.stringify({ status: a?.status, epoch: a?.epoch, asked: a?.asked })}`);
    await Bun.sleep(150);
  }
}

test("a recurring check-in: the first reaches the working agent, the next continues it once idle, then the schedule is over", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[wake-every:6] watch CI", "--key", "watch"])).j?.agentId;
  // Its first attempt ends idle after the first check-in; the schedule stays armed.
  const first = await until(run, id, (x) => x.status === "done" && x.epoch === 1);
  expect(first.result?.summary).toBe("answered");
  const w = (await (await scope(run)).wakeList({ agentId: id }))[0]!;
  expect(w).toMatchObject({ filter: { kind: "timer", every: 6000, times: 2 }, slot: 1 });
  expect(lastJson(seen(id, "every-start.txt"))).toMatchObject({ ok: true, wake: w.wakeId, wakeState: "armed", wakeKind: "timer" });
  // The second check-in continues the idle agent: its next attempt resumes the same session with the wake-up.
  const second = await until(run, id, (x) => x.epoch === 2 && x.status === "done", 60_000);
  expect(second.continued).toMatchObject({ by: `wake-${w.wakeId}`, from: "done" });
  expect(seen(id, "prompt-seen.txt")).toContain(`Wake-up ${w.wakeId}: its check-in time came (2 of 2, every 6 s).`);
  expect(seen(id, "argv.txt")).toContain("--resume");
  const woken = (await events(run, "AGENT_WOKEN")).filter((e) => e.data.wakeId === w.wakeId);
  expect(woken.map((e) => e.data.slot)).toEqual([0, 1]);
  expect((await events(run, "AGENT_CONTINUED"))[0]).toMatchObject({ agentId: id, data: { by: `wake-${w.wakeId}`, epoch: 2 } });
  expect((await (await scope(run)).wakeList({ agentId: id }))[0]).toMatchObject({ state: "fired", slot: 2 });
  // No third: it booked two.
  await Bun.sleep(7000);
  expect((await (await scope(run)).getAgent({ agentId: id }))!.epoch).toBe(2);
}, 180_000);

const O = () => import("../../src/primitives/ops");
const rpc = async (run: string, agentId: string, op: string, args: Record<string, unknown>) => {
  const { mint, ALL_OPS } = await import("../../src/subagents/token");
  const { handleRpc } = await import("../../src/subagents/rpc");
  const { token } = mint({ run, sub: agentId, ops: [...ALL_OPS] });
  return handleRpc({ id: `t-${Math.random().toString(36).slice(2)}`, token, op, args }, { runId: run, agentId }) as Promise<any>;
};
const spawn = (run: string, key: string) => O().then((o) => o.spawnAgent({ runId: run, task: `[steady] ${key}`, key, profile: "lead", start: false }).then((x) => x.agentId));

test("a schedule outlives its agent's turn, and ends when the agent is cancelled or the run archived", async () => {
  const run = await newRun();
  const s = await scope(run);
  const A = await spawn(run, "A"), B = await spawn(run, "B");
  // Too often is refused; one booked answers with its wake.
  expect((await rpc(run, A, "wake", { every: "500ms" })).error.message).toMatch(/at most once every 1 s/);
  expect((await rpc(run, A, "wake", { every: "7h" })).error.message).toMatch(/at most 6 hours ahead/);
  const a = (await rpc(run, A, "wake", { every: "10m", note: "look at CI" })).result;
  expect(a).toMatchObject({ wakeState: "armed", wakeKind: "timer" });
  expect(a.wakeAt - Date.now()).toBeGreaterThan(9 * 60_000);
  expect((await events(run, "AGENT_WAKE_ARMED")).find((e) => e.data.wakeId === a.wake)).toMatchObject({ data: { every: 600_000, times: null } });
  // Cancelling the agent ends it.
  await (await O()).cancelAgents(run, A, "test");
  expect((await s.wakeList({ agentId: A, state: "armed" }))).toEqual([]);
  // B's turn ends (done): its check-in stays armed (other waits end with the turn), until the run is archived.
  const b = (await rpc(run, B, "wake", { every: "10m" })).result;
  const op = (await rpc(run, B, "wake", { events: ["agent.titled"], in: "1h" })).result;
  expect(op.wakeState).toBe("armed");
  await s.claimDriver({ agentId: B, driver: "test", ttlMs: 60_000 });
  await s.finish({ agentId: B, status: "done", result: { summary: "ok" }, readsMessages: false });
  const left = await s.wakeList({ agentId: B });
  expect(left.find((w: any) => w.wakeId === b.wake)!.state).toBe("armed");
  expect(left.find((w: any) => w.wakeId === op.wake)).toMatchObject({ state: "cancelled", reason: "ended" });
  await s.archive({ by: "operator" });
  expect((await s.wakeList({ agentId: B })).find((w: any) => w.wakeId === b.wake)).toMatchObject({ state: "cancelled", reason: "archived" });
  expect((await events(run, "AGENT_WAKE_CANCELLED")).find((e) => e.data.wakeId === b.wake)).toMatchObject({ agentId: B, data: { reason: "archived" } });
}, 60_000);
