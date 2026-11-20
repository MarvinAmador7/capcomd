// ADR-026 §5 path 2 and §6 (capability agents.park), through a real agent CLI (fake claude in a host-exec FakeProvider
// that parks machines, CAPCOMD_FAKE_HIBERNATE=1, as boxd and Docker do): a planner's machine is parked when its turn
// ends; a message wakes that same machine, and the CLI resumes the same session there (`--resume <id>`) with nothing
// restored and its checkout used as it was (no clone, no fetch). A parked machine that won't wake is given up quietly:
// one line in the agent's log, a fresh machine, and its saved session restored there (path 3).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, testPort } from "../helpers/engine";
import { bareRepo } from "../merge/gitfixture";

let engine: Engine;
let repo: Awaited<ReturnType<typeof bareRepo>>;
let env: Record<string, string>;
let dir = "";
let faults = "";
const runs: string[] = [];
const saved = { ...process.env };

beforeAll(async () => {
  const r = (repo = await bareRepo({ mode: "direct" }));
  dir = mkdtempSync(join(tmpdir(), "capcomd-parkcli-"));
  faults = join(dir, "faults.json");
  const agentsFile = join(dir, "agents.json");
  writeFileSync(agentsFile, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
    lead: { provider: "claude", auth: "apikey", maxTurns: 40, children: { allowSpawn: true, maxDepth: 1, maxChildren: 1, allowedChildProfiles: ["lead"] } },
  } }));
  env = {
    ...r.env,
    CAPCOMD_HOME: join(dir, "home"),
    CAPCOMD_AGENTS_FILE: agentsFile,
    CAPCOMD_SANDBOX: "fake-host",
    CAPCOMD_FAKE_HIBERNATE: "1",
    CAPCOMD_FAKE_OUTAGE_FILE: faults,
    CAPCOMD_AGENT_CLAUDE_BIN: new URL("../agents/fake-claude.sh", import.meta.url).pathname,
    CAPCOMD_AGENT_WORKDIR: join(dir, "vm"),
    CAPCOMD_AGENT_POLL_MS: "100",
    CAPCOMD_VM_RPC_POLL_MS: "200",
    CAPCOMD_SKIP_PREFLIGHT: "1",
    CAPCOMD_TRACE_DIR: join(dir, "traces"),
    CAPCOMD_AUTH_LEDGER: join(dir, "auths.json"),
    CAPCOMD_ENV_LEDGER: join(dir, "envs.json"),
    ANTHROPIC_API_KEY: "sk-ant-api03-PARKCLI-abcdefghijklmnopqrstuvwxyz0123456789",
    CAPCOMD_ENV: "image",
    CAPCOMD_MESSAGE_FALLBACK_MS: "600000",
  };
  Object.assign(process.env, env);
  const port = await testPort();
  engine = new Engine("park-cli", { port, dataDir: join(dir, "engine") });
  await engine.start(null);
  env.CAPCOMD_ENDPOINT = `http://127.0.0.1:${port}`;
  process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
}, 120_000);

afterAll(async () => {
  const mine = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString().split("\n").filter((l) => (dir && l.includes(dir)) || runs.some((r) => l.includes(`/${r}/`))).map((l) => Number(l.trim().split(/\s+/)[0]));
  for (const pid of mine) if (pid > 1 && pid !== process.pid) try { process.kill(pid, "SIGKILL"); } catch { /* gone */ }
  await engine?.stop();
  for (const k of Object.keys(env ?? {})) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k];
  if (dir) rmSync(dir, { recursive: true, force: true });
});

const cj = async (args: string[]) => {
  const x = await capcomd([...args, "--json"], env);
  let j: any = null;
  try { j = JSON.parse(x.stdout.trim().split("\n").pop()!); } catch {}
  return { ...x, j };
};
const newRun = async () => { const run = (await cj(["run", "new"])).j?.runId as string; runs.push(run); return run; };
const awaitOne = async (run: string, id: string) => (await cj(["await", run, id, "--timeout-ms", "90000"])).j?.agents?.[0];
/** What the fake CLI wrote in the agent's stable directory (`${workdir}/<agentId>/`, the parent of its checkout). */
const seen = (id: string, f: string) => { const p = join(dir, "vm", id, f); return existsSync(p) ? readFileSync(p, "utf8") : ""; };
const argOf = (id: string, flag: string) => { const a = seen(id, "argv.txt").split("\n"); const i = a.indexOf(flag); return i >= 0 ? a[i + 1] ?? null : null; };
const worker = async (run: string, id: string, epoch = 1) => (await (await import("../../src/core/relay")).client().worker.getOrCreate(epoch > 1 ? [run, id, `e${epoch}`] : [run, id]).getWorker({ workerId: id })) as { state: string; context: any } | null;
const logs = async (run: string, id: string) => (await capcomd(["logs", run, id, "--json"], env)).stdout;

test("a planner's machine is parked when its turn ends; a message wakes the same machine and resumes the same session, restoring nothing", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "add the sum helper", "--key", "first"])).j?.agentId;
  expect((await awaitOne(run, id))?.status).toBe("done");
  const sid = argOf(id, "--session-id");
  expect(sid).toMatch(/^[0-9a-f-]{36}$/);
  const first = await worker(run, id);
  expect(first?.state).toBe("parked");
  expect(await logs(run, id)).toContain("its machine is parked until");

  expect((await cj(["send", run, id, "now explain what you changed", "--key", "followup"])).j).toMatchObject({ continued: true, epoch: 2 });
  const second = await awaitOne(run, id);
  expect(second).toMatchObject({ status: "done", epoch: 2 });
  expect(second?.result?.summary).toBe("fixed sum");
  // The same machine, woken (its key carried over), and the same conversation: --resume with the first session's id.
  const w2 = await worker(run, id, 2);
  expect(w2?.context).toMatchObject({ vmId: first!.context.vmId, idemKey: first!.context.idemKey, woke: true });
  expect((await worker(run, id))?.state).toBe("released");
  expect(argOf(id, "--resume")).toBe(sid);
  expect(seen(id, "prompt-seen.txt")).toContain("now explain what you changed");
  // Nothing was restored or cloned: the session file and the checkout were still there.
  const log = await logs(run, id);
  expect(log).toContain("nothing to restore");
  expect(log).toContain("its parked machine's checkout, as it was");
  expect(log).not.toContain("session: restored");
  expect(log).not.toContain("couldn't be woken");
  // Parked again when that turn ended.
  expect(w2?.state).toBe("parked");
}, 180_000);

test("a parked machine that won't wake: one line in its log, a fresh machine, its saved session restored there (path 3)", async () => {
  const run = await newRun();
  const id = (await cj(["spawn", run, "--profile", "lead", "--task", "add the sum helper", "--key", "first"])).j?.agentId;
  expect((await awaitOne(run, id))?.status).toBe("done");
  const sid = argOf(id, "--session-id");
  const first = await worker(run, id);
  expect(first?.state).toBe("parked");
  // The provider can't find it any more (deleted behind capcomd's back).
  writeFileSync(faults, JSON.stringify({ until: Date.now() + 120_000, error: "not_found", ops: ["wake"] }));
  try {
    expect((await cj(["send", run, id, "now explain what you changed", "--key", "followup"])).j).toMatchObject({ continued: true, epoch: 2 });
    const second = await awaitOne(run, id);
    expect(second).toMatchObject({ status: "done", epoch: 2 });
  } finally { rmSync(faults, { force: true }); }
  const w2 = await worker(run, id, 2);
  expect(w2?.context.vmId).not.toBe(first!.context.vmId);
  expect(w2?.context.woke).toBeUndefined();
  const log = await logs(run, id);
  expect(log.split("\n").filter((l) => l.includes("couldn't be woken"))).toHaveLength(1);
  expect(log).toContain("session: restored");
  expect(argOf(id, "--resume")).toBe(sid);
  // No failure shown for it.
  const ev = (await (await (await import("../../src/core/relay")).client().scope.getOrCreate([run])).getEvents({})) as any[];
  expect(ev.filter((e) => e.type === "AGENT_FAILED")).toEqual([]);
}, 180_000);
