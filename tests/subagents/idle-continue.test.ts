// ADR-026 §1, §5 (capability agents.idle): an agent is idle, not done; a message wakes it.
//
// Through a real agent CLI (fake claude in a host-exec FakeProvider, the supervisor feeding its stdin): a message to an
// agent whose attempt ended (done, or cancelled, in a run that isn't archived) continues it as its next attempt (epoch),
// at the agent's stable checkout path, with a fresh session whose prompt is rebuilt from its thread (no session is
// saved yet: §5 path 4) and one quiet `note` item saying so; it answers. An archived run refuses (and takes messages
// again once restored); an await counts the idle agent as ended and waits again once it is woken; its wall time counts
// only while it works (idle in between, it pauses), its turns across attempts; and a message can change the model its
// next turn runs with: at once for an idle agent, after its current turn for a working one (held, then continued).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
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
  const r = (repo = await bareRepo({ mode: "direct" }));
  dir = mkdtempSync(join(tmpdir(), "capcomd-idle-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    // A lead may finish with no changes of its own (its work may be its children's), so a follow-up that changes nothing
    // more still ends done.
    lead: { provider: "claude", auth: "apikey", maxTurns: 40, children: { allowSpawn: true, maxDepth: 1, maxChildren: 1, allowedChildProfiles: ["lead"] } },
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
    ANTHROPIC_API_KEY: "sk-ant-api03-IDLECONT-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_MESSAGE_FALLBACK_MS: "600000",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("idle-continue", { port, dataDir: join(dir, "engine") });
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
const newRun = async () => { const run = (await cj(["run", "new"])).j?.runId as string; runs.push(run); return run; };
const awaitOne = async (run: string, id: string) => (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
/** What the fake CLI wrote in the agent's stable directory (`${workdir}/<agentId>/`, the parent of its checkout). */
const seen = (id: string, f: string) => { const p = join(dir, "vm", id, f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
const items = async (run: string, id: string) => (await (await scope(run)).getItems({ agentId: id, limit: 500 })) as any[];

test("a message to a done agent continues it: a new attempt at the same checkout, a session rebuilt from its thread, and it answers", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "add the sum helper", "--key", "first"])).j?.agentId;
  const first = await awaitOne(run, id);
  expect(first?.status).toBe("done");
  expect(seen(id, "prompt-seen.txt")).toContain("Task: add the sum helper");
  const sent = await cj(["send", run, id, "now explain what you changed", "--key", "followup"]);
  expect(sent.code).toBe(0);
  expect(sent.j).toMatchObject({ continued: true, epoch: 2 });
  expect(sent.j.note).toContain(`${id} was idle`);
  const second = await awaitOne(run, id);
  expect(second?.status).toBe("done");
  expect(second?.epoch).toBe(2);
  expect(second?.result?.summary).toBe("fixed sum");
  // Its prompt: its thread rebuilt (path 4: nothing saved to resume), its task and last hand-back, then the new message.
  const prompt = seen(id, "prompt-seen.txt");
  expect(prompt).toContain("Your earlier session couldn't be resumed");
  expect(prompt).toContain("add the sum helper");
  expect(prompt).toContain("Your last hand-back, in full:\nfixed sum");
  expect(prompt).toContain("now explain what you changed");
  expect(prompt.indexOf("now explain")).toBeGreaterThan(prompt.indexOf("Your last hand-back"));
  // One quiet line in its thread, and the event.
  const notes = (await items(run, id)).filter((i) => i.kind === "note");
  expect(notes.map((n) => n.text)).toEqual(["Picked up from the thread: the earlier session couldn't be resumed."]);
  expect((await events(run, "AGENT_CONTINUED"))[0]).toMatchObject({ agentId: id, data: { epoch: 2, from: "done", by: "operator" } });
  expect((await events(run, "AGENT_DONE")).filter((e) => e.agentId === id)).toHaveLength(2);
  // The message isn't handed to it again: its cursor moved past it.
  const a = await (await scope(run)).getAgent({ agentId: id });
  expect(a.continued).toMatchObject({ epoch: 2, from: "done" });
  expect(((await (await scope(run)).pullMessages({ agentId: id })) as any[])).toEqual([]);
}, 180_000);

test("a cancelled agent of a run that isn't archived takes a message too: it continues", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[slow] look around", "--key", "c"])).j?.agentId;
  expect((await cj(["cancel", run, id])).code).toBe(0);
  expect((await awaitOne(run, id))?.status).toBe("cancelled");
  const sent = await cj(["send", run, id, "carry on, smaller this time"]);
  expect(sent.j).toMatchObject({ continued: true });
  const again = await awaitOne(run, id);
  expect(again?.status).toBe("done");
  expect((await events(run, "AGENT_CONTINUED"))[0]).toMatchObject({ agentId: id, data: { from: "cancelled" } });
  expect(seen(id, "prompt-seen.txt")).toContain("carry on, smaller this time");
}, 180_000);

test("an archived run refuses messages until it is restored; archiving waits for working agents", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[slow] tidy", "--key", "a"])).j?.agentId;
  const busy = await cj(["run", "archive", run]);
  expect(busy.code).not.toBe(0);
  expect(busy.stdout + busy.stderr).toContain("still working");
  expect((await awaitOne(run, id))?.status).toBe("done");
  expect((await cj(["run", "archive", run])).j).toMatchObject({ runId: run, changed: true });
  const refused = await cj(["send", run, id, "hello?"]);
  expect(refused.code).not.toBe(0);
  expect(refused.stdout + refused.stderr).toContain("archived · restore to continue");
  expect((await (await scope(run)).getAgent({ agentId: id })).status).toBe("done");
  expect((await cj(["run", "restore", run])).j).toMatchObject({ runId: run, changed: true });
  expect((await cj(["send", run, id, "hello again"])).j).toMatchObject({ continued: true });
  expect((await awaitOne(run, id))?.status).toBe("done");
  expect((await events(run, "RUN_ARCHIVED"))).toHaveLength(1);
  expect((await events(run, "RUN_RESTORED"))).toHaveLength(1);
}, 180_000);

test("an await counts an idle agent as ended, and a woken one as running again until its next turn ends", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "write the notes", "--key", "w"])).j?.agentId;
  expect((await awaitOne(run, id))?.status).toBe("done");
  // Idle: an await returns at once.
  const t0 = Date.now();
  expect((await awaitOne(run, id))?.status).toBe("done");
  expect(Date.now() - t0).toBeLessThan(10_000);
  await cj(["send", run, id, "[steady] one more pass"]);
  const tree = (await cj(["tree", run])).j;
  expect(JSON.stringify(tree)).toContain('"status":"running"');
  const woken = await awaitOne(run, id);
  expect(woken).toMatchObject({ status: "done", epoch: 2 });
  // The lifecycle feed: the run started again with it.
  const { lifecycleEvents } = await import("../../src/api/lifecycle");
  const life = lifecycleEvents(run, (await (await scope(run)).getEvents({})) as any).map((e) => e.type);
  expect(life.filter((t) => t === "run.started")).toHaveLength(2);
  expect(life).toContain("agent.continued");
}, 180_000);

test("wall time counts only while it works (idle in between, it pauses); turns count across attempts", async () => {
  const run = await newRun();
  const t0 = Date.now();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "first pass", "--key", "b", "--budget", "wallSeconds=600"])).j?.agentId;
  const one = await awaitOne(run, id);
  const firstTurns = Number(one.spent.turns);
  expect(firstTurns).toBeGreaterThan(0);
  await new Promise((r) => setTimeout(r, 8000)); // idle
  await cj(["send", run, id, "second pass"]);
  const two = await awaitOne(run, id);
  const elapsed = (Date.now() - t0) / 1000;
  expect(Number(two.spent.turns)).toBeGreaterThan(firstTurns);
  expect(Number(two.spent.wallSeconds)).toBeGreaterThan(Number(one.spent.wallSeconds));
  // The 8 s it was idle are in neither attempt.
  expect(Number(two.spent.wallSeconds)).toBeLessThan(elapsed - 7);
}, 180_000);

test("a message's model applies to the next turn: at once for an idle agent (its next attempt's CLI runs with it)", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "plain work", "--key", "m"])).j?.agentId;
  await awaitOne(run, id);
  expect(seen(id, "argv.txt")).not.toContain("claude-opus-5-5");
  const bad = await cj(["send", run, id, "x", "--model", "gpt-nope"]);
  expect(bad.code).not.toBe(0);
  const sent = await cj(["send", run, id, "use the big model", "--model", "claude-opus-5-5", "--effort", "high"]);
  expect(sent.j).toMatchObject({ continued: true });
  expect((await awaitOne(run, id))?.status).toBe("done");
  const argv = seen(id, "argv.txt").split("\n");
  expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  expect(argv[argv.indexOf("--effort") + 1]).toBe("high");
  expect((await events(run, "AGENT_MODEL_CHANGED"))[0]).toMatchObject({ agentId: id, data: { model: "claude-opus-5-5", effort: "high", applied: true } });
  expect((await items(run, id)).filter((i) => i.kind === "note").map((i) => i.text)).toContain("model → claude-opus-5-5 · effort high");
  expect(((await (await scope(run)).getAgent({ agentId: id })).spec as any).model).toBe("claude-opus-5-5");
}, 180_000);

test("a model change sent while it works is held: its turn ends, then it continues as a new attempt with it", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "[listen:6] work and listen", "--key", "h"])).j?.agentId;
  for (let i = 0; i < 100 && !existsSync(join(dir, "vm", id, "prompt-seen.txt")); i++) await new Promise((r) => setTimeout(r, 200));
  const sent = await cj(["send", run, id, "switch models please", "--model", "claude-opus-5-5"]);
  expect(sent.j?.continued).toBeUndefined();
  const done = await awaitOne(run, id);
  // The first attempt never read it (a running CLI can't switch model): its next attempt starts with it.
  const later = done?.epoch === 2 ? done : await awaitOne(run, id);
  expect(later).toMatchObject({ status: "done", epoch: 2 });
  expect((await events(run, "AGENT_MODEL_CHANGED"))[0]).toMatchObject({ data: { applied: false } });
  expect((await events(run, "AGENT_CONTINUED"))[0]).toMatchObject({ agentId: id, data: { epoch: 2 } });
  const argv = seen(id, "argv.txt").split("\n");
  expect(argv[argv.indexOf("--model") + 1]).toBe("claude-opus-5-5");
  expect(seen(id, "prompt-seen.txt")).toContain("switch models please");
}, 180_000);
