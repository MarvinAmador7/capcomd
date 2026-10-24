// A real agent that can't spawn has no in-VM capcomd, so it never calls `capcomd heartbeat`. Its liveness is reported
// up by the in-VM supervisor (ADR-019), which also checkpoints its workspace: a worker that keeps working past the
// stuck window is not flagged stuck. (fake claude in a host-exec FakeProvider, spawned through the engine.)
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
const saved = { ...process.env };

beforeAll(async () => {
  const r = (repo = await bareRepo({ mode: "direct" }));
  const dir = mkdtempSync(join(tmpdir(), "capcomd-liveness-"));
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: { worker: { provider: "claude", auth: "apikey", maxTurns: 20 }, ckpt: { provider: "claude", auth: "apikey", checkpointEveryMs: 1000 }, spender: { provider: "claude", auth: "apikey" }, listener: { provider: "claude", auth: "apikey" }, coder: { provider: "codex", auth: "apikey" } } }));
  env = {
    ...r.env,
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_STUCK_AFTER_MS: "1500",
    CAPCOMD_DRIVER_LEASE_MS: "3000",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"), // never the checkout's real .relay/ ledgers
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-LIVENESS-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
  };
  Object.assign(process.env, env); // the engine (actors) inherits process.env
  const port = await testPort();
  engine = new Engine("liveness", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};

test("a worker without the in-VM CLI that keeps working is not flagged stuck", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  expect(run).toMatch(/^run-/);
  const sp = await cj(["spawn", run, "--profile", "worker", "--task", "[slow] make the failing test pass", "--key", "slow"]);
  const id = sp.j?.agentId;
  expect(id).toMatch(/^agt-/);
  // Watch it while it works: past the 1.5s stuck window it must carry an engine heartbeat and no stuck flag.
  const t0 = Date.now();
  let seen = 0;
  let flagged: string | undefined;
  for (let i = 0; i < 200; i++) {
    await Bun.sleep(150);
    const j = (await cj(["inspect", run, id])).j;
    if (j?.status !== "running") { if (j?.status && j.status !== "pending") break; continue; }
    if (j.stuck) flagged = j.stuck;
    if (Date.now() - t0 > 2500 && j.heartbeatAt) seen++;
  }
  expect(flagged).toBeUndefined();
  expect(seen).toBeGreaterThan(0);
  const aw = await cj(["await", run, id, "--timeout-ms", "60000"]);
  expect(aw.j?.agents?.[0]?.status).toBe("done");
}, 120_000);

// Keep this before the next test: that one merges src/sum.ts (which every fake agent here writes) into the shared
// repo, after which this agent would change nothing.
test("spend passing a quarter of its budget checkpoints the work (no interval checkpoint due)", async () => {
  // $2 a message, 4 a second for ~10 s, against $100: the 5 s spend reports pass 25% and 75%.
  const run = (await cj(["run", "new", "--budget", "usd=100"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "spender", "--task", "[spend] costly work", "--key", "spender"])).j?.agentId;
  const agent = (await cj(["await", run, id, "--timeout-ms", "60000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  expect(agent.checkpoint).toMatchObject({ ref: `refs/capcomd/checkpoints/${id}`, reason: "spend" });
}, 120_000);

test("the supervisor's checkpoints reach the remote and the agent's record while it works", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "ckpt", "--task", "[steady] add sum", "--key", "ckpt"])).j?.agentId;
  const aw = await cj(["await", run, id, "--timeout-ms", "60000"]);
  const agent = aw.j?.agents?.[0];
  expect(agent?.status).toBe("done");
  expect(agent.checkpoint).toMatchObject({ ref: `refs/capcomd/checkpoints/${id}`, reason: "interval", files: 1 });
  expect(await repo.sha(`refs/capcomd/checkpoints/${id}`)).toBe(agent.checkpoint.sha);
  expect(await repo.show(agent.checkpoint.sha, "src/sum.ts")).toContain("a + b");
  expect((await capcomd(["events", run, "--json"], env)).stdout).toContain("AGENT_CHECKPOINT");
  // Once its work lands, its checkpoints go (they were only for continuing it).
  const m = await cj(["merge", run, "--ref", id, "--operator"]);
  expect(m.j).toMatchObject({ state: "merged" });
  expect(await repo.sha(`refs/capcomd/checkpoints/${id}`)).toBeFalsy();
}, 120_000);

test("capcomd send reaches a running claude worker: the supervisor hands it to the CLI on stdin", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "listener", "--task", "[listen] wait for word", "--key", "listen"])).j?.agentId;
  for (let i = 0; i < 100 && (await cj(["inspect", run, id])).j?.status !== "running"; i++) await Bun.sleep(100);
  expect((await cj(["send", run, id, "use", "tabs", "please"])).code).toBe(0);
  const agent = (await cj(["await", run, id, "--timeout-ms", "60000"])).j?.agents?.[0];
  expect(agent?.status).toBe("done");
  const heard = await repo.show(agent.result.branch, "messages.txt");
  expect(heard).toContain("Message from the operator");
  expect(heard).toContain("use tabs please");
}, 120_000);

test("capcomd logs shows what a real (CLI) agent does, and --follow streams it until the agent finishes", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const id = (await cj(["spawn", run, "--profile", "worker", "--task", "[slow] make the failing test pass", "--key", "logs"])).j?.agentId;
  const follow = await capcomd(["logs", run, id, "--follow"], env); // returns once the agent is finished
  expect(follow.code).toBe(0);
  expect(follow.stdout).toMatch(/agent +tool Edit/);
  expect(follow.stdout).toMatch(/agent +say step 1\n/);
  const r = (await cj(["logs", run, id])).j;
  // Finished either way: "failed" with no changes when an earlier test here already merged the same edit.
  expect(["done", "failed"]).toContain(r.status);
  expect(r.lines.map((l: any) => l.line)).toEqual(expect.arrayContaining([expect.stringMatching(/^tool Edit/), expect.stringMatching(/^result/)]));
}, 120_000);

test("send says when the agent can't read the message now: a Codex worker, a finished agent; nothing for a Claude worker", async () => {
  const run = (await cj(["run", "new"])).j?.runId;
  const codex = (await cj(["spawn", run, "--profile", "coder", "--task", "x", "--key", "cx", "--no-start"])).j?.agentId;
  expect((await cj(["send", run, codex, "hello"])).j?.note).toContain("Codex agent that can't read messages while it works");
  const claude = (await cj(["spawn", run, "--profile", "listener", "--task", "y", "--key", "cl", "--no-start"])).j?.agentId;
  expect((await cj(["send", run, claude, "hello"])).j?.note).toBeUndefined();
  await cj(["cancel", run, claude]);
  expect((await cj(["send", run, claude, "late"])).j?.note).toBe(`${claude} is cancelled: nothing will read this message`);
}, 60_000);
