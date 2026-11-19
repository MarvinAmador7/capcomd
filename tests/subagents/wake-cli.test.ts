// ADR-026 §3: waits happen between turns, never inside a tool call. Agents don't wait in polling loops; they end their
// turn and are woken.
//
// Through a real agent CLI (fake claude in a host-exec FakeProvider, the in-VM capcomd and the supervisor feeding its
// stdin): `capcomd wake --in N` and `capcomd check --wake` answer at once with a wake id; the CLI's turn ends; the
// supervisor keeps its input open while the wake is pending; when the time comes (a durable actor alarm) or the check
// settles (its CHECK_PASSED event, matched in the transaction that appends it), the wake-up reaches the CLI on stdin as
// a new turn, once, pushed (the slow fallback poll is off here). Then, on the scope actor and the RPC directly: no lost
// wakeup (armed after the event: fires at once), no duplicate (an op that ends twice, a retried arm), the log's order,
// a wake's deadline, a time wake that survives an engine restart, what an agent may wait on (its subtree's), an agent's
// end cancelling its wakes, the durable delivery cursor, and the daemon's start-up sweep restarting a waited-on check.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "fs";
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
    // Messages reach a running agent by push only (the scope's messagesChanged): no fallback poll in time for the test.
    CAPCOMD_MESSAGE_FALLBACK_MS: "600000",
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
const events = async (run: string, type: string) => ((await (await scope(run)).getEvents({})) as any[]).filter((e) => e.type === type);
const wakeMessages = async (run: string) => events(run, "AGENT_WOKEN");
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
  expect(heard).toContain(`Wake-up ${armed.wake}: its check-in time came`);
  expect(heard).toContain("look at the build again");
  expect(heard.split("Wake-up ").length - 1).toBe(1);
  const woken = await wakeMessages(run);
  expect(woken).toHaveLength(1);
  expect(woken[0]).toMatchObject({ agentId: id, data: { wakeId: armed.wake, kind: "timer", by: "time", text: "its check-in time came" } });
  expect((await events(run, "AGENT_WAKE_ARMED"))[0]).toMatchObject({ agentId: id, data: { wakeId: armed.wake, kind: "timer", note: "look at the build again" } });
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
  expect(heard).toContain(`Wake-up ${armed.wake}: check ${armed.id} passed`);
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
  expect(heard).toContain(`Wake-up ${armed.wake}: ${kid} ended: done`);
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
  expect(inbox[1]!.body).toContain("check chk-b failed");
  expect(inbox[2]!.body).toContain("check chk-a passed");
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
  expect(b[0]!.body).toContain(`Wake-up ${wd.wakeId}: its deadline passed`);
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

// ── what an agent may wait on, its end, its delivery cursor (the RPC and the scope, in-process) ──────
const O = () => import("../../src/primitives/ops");
const rpc = async (run: string, agentId: string, op: string, args: Record<string, unknown>) => {
  const { mint, ALL_OPS } = await import("../../src/subagents/token");
  const { handleRpc } = await import("../../src/subagents/rpc");
  const { token } = mint({ run, sub: agentId, ops: [...ALL_OPS] });
  return handleRpc({ id: `t-${Math.random().toString(36).slice(2)}`, token, op, args }, { runId: run, agentId });
};
/** Two planners' trees, none started: A with its child A1, B with its child B1. */
const trees = async (run: string) => {
  const sp = (key: string, parent?: string) => O().then((o) => o.spawnAgent({ runId: run, task: `[steady] ${key}`, key, profile: "lead", start: false, ...(parent ? { parent } : {}) }).then((x) => x.agentId));
  const A = await sp("A"), B = await sp("B");
  return { A, B, A1: await sp("A1", A), B1: await sp("B1", B) };
};

test("an agent waits only on what it may see: ops, agents and events of its subtree and its siblings'", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { A, B, A1, B1 } = await trees(run);
  await s.startOp({ opId: "chk-mine", kind: "check", paramsHash: "m", data: { ...CHECK_START("chk-mine"), askedBy: A1 } });
  await s.startOp({ opId: "chk-theirs", kind: "check", paramsHash: "t", data: { ...CHECK_START("chk-theirs"), agentId: B1, askedBy: B } });
  const deny = (r: any) => { expect(r.ok).toBe(false); expect(r.error.message).toMatch(/not visible|outside your subtree/); };
  deny(await rpc(run, A1, "wake", { op: "chk-theirs" }));
  deny(await rpc(run, A1, "wake", { agents: [B1] }));
  deny(await rpc(run, A1, "wake", { events: ["agent.done"], agent: B }));
  const op = await rpc(run, A1, "wake", { op: "chk-mine", note: "merge it" }) as any;
  expect(op).toMatchObject({ ok: true, result: { wakeState: "armed", wakeKind: "op" } });
  expect((await rpc(run, A1, "wake", { agents: [A] }) as any).result.wakeState).toBe("armed");
  // An events wake hears only its subtree's (here A's): B naming its tab doesn't wake it, A doing so does.
  const ev = (await rpc(run, A1, "wake", { events: ["agent.titled"], in: "10m" }) as any).result;
  expect(ev).toMatchObject({ wakeState: "armed", wakeKind: "events" });
  await (await O()).setAgentTitle(run, B, "their work", { by: "self", setBy: B, key: "tb" });
  expect((await s.wakeList({ agentId: A1 })).find((w: any) => w.wakeId === ev.wake)?.state).toBe("armed");
  await (await O()).setAgentTitle(run, A, "our work", { by: "self", setBy: A, key: "ta" });
  expect((await s.wakeList({ agentId: A1 })).find((w: any) => w.wakeId === ev.wake)).toMatchObject({ state: "fired", reason: `agent.titled from ${A}` });
  // Unknown event types and times out of range are refused; durations read as the CLI writes them.
  expect((await rpc(run, A1, "wake", { events: ["not.a.type"] }) as any).error.message).toMatch(/not an event type/);
  expect((await rpc(run, A1, "wake", { in: "7h" }) as any).error.message).toMatch(/at most 6 hours/);
  const t = (await rpc(run, A1, "wake", { in: "90s" }) as any).result;
  expect(t.wakeAt - Date.now()).toBeGreaterThan(80_000);
  // wake --list shows its own, without the visibility root.
  const mine = (await rpc(run, A1, "wake", { list: true }) as any).result.wakes;
  expect(mine.map((w: any) => w.wake)).toContain(op.result.wake);
  expect(mine.every((w: any) => w.filter.within === undefined)).toBe(true);
  // Its end cancels what it still waits on, each with its event.
  await (await O()).cancelAgents(run, A1, "test");
  const left = await s.wakeList({ agentId: A1, state: "armed" });
  expect(left).toHaveLength(0);
  const cancelled = (await events(run, "AGENT_WAKE_CANCELLED")).filter((e: any) => e.agentId === A1);
  expect(cancelled.map((e: any) => e.data.reason)).toEqual(expect.arrayContaining(["ended"]));
  expect(cancelled.length).toBeGreaterThanOrEqual(3);
}, 60_000);

test("the delivery cursor: a message the CLI took is never handed to it again, by any attempt", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { A } = await trees(run);
  const m1 = (await s.sendMessage({ to: A, from: "operator", body: "first" })).seq;
  const m2 = (await s.sendMessage({ to: A, from: "operator", body: "second" })).seq;
  expect((await s.pullMessages({ agentId: A, after: 0 })).map((m: any) => m.seq)).toEqual([m1, m2]);
  await s.messagesDelivered({ agentId: A, seq: m1 });
  // A new attempt starts from 0: the cursor still skips what was taken.
  expect((await s.pullMessages({ agentId: A, after: 0 })).map((m: any) => m.body)).toEqual(["second"]);
  // It never moves back.
  await s.messagesDelivered({ agentId: A, seq: m2 });
  await s.messagesDelivered({ agentId: A, seq: m1 });
  expect(await s.pullMessages({ agentId: A, after: 0 })).toEqual([]);
}, 30_000);

test("start-up sweep: a check an armed wake waits on, left running by a daemon that went away, is restarted", async () => {
  const run = await newRun();
  const s = await scope(run);
  const { A } = await trees(run);
  const { Git } = await import("../../src/merge/git");
  const sha = (await new Git(repo.bare).run(["rev-parse", "main"])).stdout.trim();
  // As a daemon would have recorded it before it went away: running, with nobody running it.
  await s.startOp({ opId: "chk-orphan", kind: "check", paramsHash: "o", data: { ref: "main", branch: "main", sha, agentId: null, checks: "echo swept-ok", askedBy: A } });
  const r = (await rpc(run, A, "wake", { op: "chk-orphan", note: "merge when green" }) as any).result;
  expect(r.wakeState).toBe("armed");
  const W = await import("../../src/primitives/wake-sweep");
  // (Other tests' runs may have ops of their own waited on: at least this one.)
  expect(await W.resumeWaitedOps()).toBeGreaterThanOrEqual(1);
  let w: any;
  for (let i = 0; i < 300; i++) { w = (await s.wakeList({ agentId: A })).find((x: any) => x.wakeId === r.wake); if (w.state !== "armed") break; await Bun.sleep(100); }
  expect(w).toMatchObject({ state: "fired", reason: "check chk-orphan passed" });
  expect((await s.inbox({ agentId: A }))[0]!.body).toContain("merge when green");
  // Nothing left to wait on: the run's marker goes at the next sweep.
  const marker = join((await import("../../src/utils/home")).stateDir(), "wakes", run);
  expect(existsSync(marker)).toBe(true);
  await W.resumeWaitedOps();
  expect(existsSync(marker)).toBe(false);
}, 120_000);

test("the contract: the wake events on the lifecycle feed, and a waiting agent's activity", async () => {
  const { lifecycleEvents } = await import("../../src/api/lifecycle");
  const { describeEvent, waitActivity } = await import("../../src/api/describe");
  const raw = [
    { seq: 1, at: 1000, type: "AGENT_WAKE_ARMED", agentId: "agt-p", data: { wakeId: "wk-1", kind: "op", op: "vfy-9", opKind: "verify", at: 2000, note: null } },
    { seq: 2, at: 1500, type: "AGENT_WOKEN", agentId: "agt-p", data: { wakeId: "wk-1", kind: "op", by: "event", text: "verify vfy-9 passed", causeSeq: 1, messageSeq: 3, armedAt: 1000 } },
  ];
  const lc = lifecycleEvents("run-x", raw as any);
  expect(lc.map((e) => [e.type, (e.data as any).cause])).toEqual([["agent.wake_armed", "waiting"], ["agent.woken", "woken"]]);
  expect(lc[0]!.text).toBe("Agent agt-p ended its turn, waiting for verify vfy-9.");
  expect(lc[1]!.text).toBe("Agent agt-p was woken: what it waited for happened.");
  expect(describeEvent("agent.wake_cancelled", { reason: "ended" }, "agt-p")).toBe("Agent agt-p ended while it waited.");
  const a = waitActivity({ wakeId: "wk-2", kind: "agents", agents: ["agt-1", "agt-2", "agt-3"], mode: "all", armedAt: 1000, at: null });
  expect(a).toMatchObject({ kind: "wait", text: "Waiting for 3 agents", wake: { id: "wk-2", kind: "agents", armedAt: new Date(1000).toISOString(), at: null } });
});
