// SPIKE (ADR draft "Durable agents and threads"): agents don't wait in polling loops; they end their turn and are woken.
//
// Through a real agent CLI (fake claude in a host-exec FakeProvider, the in-VM capcomd and the supervisor feeding its
// stdin): `capcomd wake --in-ms N` and `capcomd check --wake` answer at once with a wake id; the CLI's turn ends; the
// supervisor keeps its input open while the wake is pending; when the time comes (a durable actor alarm) or the check
// settles (its CHECK_PASSED event, matched in the transaction that appends it), the wake-up reaches the CLI on stdin as
// a new turn, once. Then, on the scope actor directly: no lost wakeup (armed after the event: fires at once), no
// duplicate (an op that ends twice, a retried arm), the log's order, a wake's deadline, and a time wake that survives
// an engine restart.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
let dir = "";
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  // The run's checks take a few seconds: longer than a wake's answer, shorter than the test.
  const r = (repo = await bareRepo({ mode: "direct", test: "sleep 3; echo checked-ok" }));
  dir = mkdtempSync(join(tmpdir(), "capcomd-wake-cli-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 20, children: { allowSpawn: true, maxDepth: 1, maxChildren: 1, allowedChildProfiles: ["lead"] } },
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
    ANTHROPIC_API_KEY: "sk-ant-api03-WAKECLI-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("wake-cli", { port, dataDir: join(dir, "engine") });
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
const wakeMessages = async (run: string) => ((await (await scope(run)).getEvents({})) as any[]).filter((e) => e.type === "MESSAGE_SENT" && String(e.agentId).startsWith("wake-"));
const newRun = async () => { const run = (await cj(["run", "new"])).j?.runId as string; runs.push(run); return run; };

test("wake --in-ms answers at once; the CLI's turn ends; the check-in reaches it on stdin as a new turn, once", async () => {
  const run = await newRun();
  const t0 = Date.now();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[wake-in:4] build it", "--key", "checkin"])).j?.agentId;
  expect(id).toMatch(/^agt-/);
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const [first, took] = (await repo.show(agent.result.branch, "wake-start.txt")).trim().split("\n");
  const armed = JSON.parse(first!);
  expect(armed).toMatchObject({ ok: true, wakeState: "armed" });
  expect(armed.wake).toMatch(/^wk-/);
  // The call returned without waiting for the 4 s (the RPC's own round trip only).
  expect(Number(took!.split(" ")[1])).toBeLessThan(3000);
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain("a wake-up you asked for");
  expect(heard).toContain(`Wake-up ${armed.wake}: the time you asked to be woken at came`);
  expect(heard).toContain("look at the build again");
  expect(heard.split("Wake-up ").length - 1).toBe(1);
  expect(await wakeMessages(run)).toHaveLength(1);
  const w = (await (await scope(run)).wakeList({ agentId: id }))[0]!;
  expect(w).toMatchObject({ wakeId: armed.wake, state: "fired", filter: { kind: "timer" } });
  expect(w.firedAt! - w.createdAt).toBeGreaterThanOrEqual(3900);
  // Its last word is its answer to the wake-up (the fake CLI answers each message with "answered").
  expect(agent.result.summary).toBe("answered");
  expect(Date.now() - t0).toBeLessThan(80_000);
}, 120_000);

test("check --wake answers at once with the check's id; its end wakes the agent with the verdict", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[wake-check] check it", "--key", "check"])).j?.agentId;
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const [first, took] = (await repo.show(agent.result.branch, "wake-start.txt")).trim().split("\n");
  const armed = JSON.parse(first!);
  if (!armed.wake) console.log(first, (await cj(["logs", run, id, "--tail", "200"])).stdout.slice(-4000));
  expect(armed).toMatchObject({ ok: true, kind: "check", state: "running", wakeState: "armed" });
  expect(armed.id).toMatch(/^chk-/);
  expect(Number(took!.split(" ")[1])).toBeLessThan(3000); // the checks take 3 s or more
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain(`Wake-up ${armed.wake}: check ${armed.id} finished: passed`);
  expect(heard).toContain("merge it if green");
  expect(heard).toContain(`capcomd check --id ${armed.id}`);
  expect(await wakeMessages(run)).toHaveLength(1);
}, 120_000);

test("await --wake: a lead spawns a child and ends its turn instead of polling; the child's end wakes it", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[wake-await] split it", "--key", "await"])).j?.agentId;
  const agent = (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const [first, took] = (await repo.show(agent.result.branch, "wake-start.txt")).trim().split("\n");
  const armed = JSON.parse(first!);
  expect(armed).toMatchObject({ ok: true, wakeState: "armed", wakeKind: "agents" });
  expect(Number(took!.split(" ")[1])).toBeLessThan(3000);
  const kid = armed.agents[0];
  expect((await (await scope(run)).getAgent({ agentId: kid }))?.status).toBe("done");
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain(`Wake-up ${armed.wake}: agents ${kid} all ended (${kid}: done)`);
  expect(heard).toContain("verify and merge it");
  expect(await wakeMessages(run)).toHaveLength(1);
}, 120_000);

// ── the scope actor's durable wakes, directly ───────────────────────────────────────────────────
const CHECK_START = (id: string) => ({ ref: "main", branch: "main", sha: "0000000", agentId: null, askedBy: "agt-x", id });
const startOp = async (s: any, id: string) => s.startOp({ opId: id, kind: "check", paramsHash: id, data: CHECK_START(id) });
const finishOp = async (s: any, id: string, pass = true) => s.finishOp({ opId: id, state: pass ? "passed" : "failed", result: { pass, branch: "main", commit: "0000000", checks: { passed: pass, status: pass ? "passed" : "failed" } } });

test("no lost wakeup, no duplicate, the log's order", async () => {
  const run = await newRun();
  const s = await scope(run);
  // Armed after the op ended: fires at once, from the op's record.
  await startOp(s, "chk-early"); await finishOp(s, "chk-early");
  const late = await s.wakeArm({ agentId: "agt-a", filter: { kind: "op", op: "chk-early" }, at: Date.now() + 60_000, key: "late" });
  expect(late).toMatchObject({ firedNow: true, wake: { state: "fired" } });
  // A retried arm (the same key) is the same wake; it doesn't fire again.
  const again = await s.wakeArm({ agentId: "agt-a", filter: { kind: "op", op: "chk-early" }, at: Date.now() + 60_000, key: "late" });
  expect(again).toMatchObject({ replayed: true, wake: { wakeId: late.wake.wakeId } });
  // Two wakes on two running ops; B ends before A: B's message comes first. An op recorded as ended twice wakes once.
  await startOp(s, "chk-a"); await startOp(s, "chk-b");
  const wa = (await s.wakeArm({ agentId: "agt-a", filter: { kind: "op", op: "chk-a" }, at: Date.now() + 60_000, key: "a" })).wake;
  const wb = (await s.wakeArm({ agentId: "agt-a", filter: { kind: "op", op: "chk-b" }, at: Date.now() + 60_000, key: "b" })).wake;
  expect([wa.state, wb.state]).toEqual(["armed", "armed"]);
  await finishOp(s, "chk-b", false); await finishOp(s, "chk-a"); await finishOp(s, "chk-a");
  const inbox = await s.inbox({ agentId: "agt-a" });
  expect(inbox.map((m: any) => m.from)).toEqual([`wake-${late.wake.wakeId}`, `wake-${wb.wakeId}`, `wake-${wa.wakeId}`]);
  expect(inbox[1]!.body).toContain("check chk-b finished: failed");
  expect(inbox[2]!.body).toContain("check chk-a finished: passed");
  // Each wake fired at the seq of the event that satisfied it, in the log's order.
  const ws = await s.wakeList({ agentId: "agt-a" });
  const seqOf = (id: string) => ws.find((w: any) => w.wakeId === id)!.firedSeq!;
  expect(seqOf(wb.wakeId)).toBeLessThan(seqOf(wa.wakeId));
  // A wake whose op never ends: its deadline wakes it, saying so; it never fires again when the op ends later.
  await startOp(s, "chk-slow");
  const wd = (await s.wakeArm({ agentId: "agt-b", filter: { kind: "op", op: "chk-slow" }, at: Date.now() + 1500, key: "slow" })).wake;
  for (let i = 0; i < 60 && (await s.inbox({ agentId: "agt-b" })).length === 0; i++) await Bun.sleep(100);
  await finishOp(s, "chk-slow");
  const b = await s.inbox({ agentId: "agt-b" });
  expect(b).toHaveLength(1);
  expect(b[0]!.body).toContain(`Wake-up ${wd.wakeId}: the time you gave it ran out`);
}, 60_000);

test("a time wake survives an engine restart (a durable alarm)", async () => {
  const run = await newRun();
  const s = await scope(run);
  const w = (await s.wakeArm({ agentId: "agt-r", filter: { kind: "timer" }, at: Date.now() + 8000, note: "after the restart", key: "restart" })).wake;
  expect(w.state).toBe("armed");
  await engine.stop();
  await engine.start(null);
  const s2 = await scope(run);
  let msgs: any[] = [];
  for (let i = 0; i < 300 && !msgs.length; i++) { await Bun.sleep(100); msgs = await s2.inbox({ agentId: "agt-r" }).catch(() => []); }
  expect(msgs).toHaveLength(1);
  expect(msgs[0]!.body).toContain("after the restart");
  expect((await s2.wakeList({ agentId: "agt-r" }))[0]).toMatchObject({ state: "fired" });
}, 120_000);
