// The memory cap on local agents (src/providers/capacity.ts): with room for two agents, four spawned at once run two at
// a time; the others wait as `pending` (their workflow isn't started) and start as the first ones finish. The fake
// sandbox gets the cap through its test knob (CAPCOMD_FAKE_MEMORY_MB), as Docker gets it from `docker info`. The cap
// covers `capcomd run` (the recipe spawns its agents through the same workflow), and an agent whose workflow ends before
// it has a machine gives its slot back at once instead of after the 10-minute grace.
import { expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../helpers/test-engine";
import { capcomd, sleep, testPort } from "../helpers/engine";

const last = (s: string) => JSON.parse(s.trim().split("\n").pop()!);

test("four agents, room for two: never more than two running, the rest pending, all four done", async () => {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-slots-"));
  const port = await testPort();
  const shared = { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_HOME: join(dir, "home") };
  // 2 GB at 1 GB per agent: two slots. A slowed push keeps each agent running a while; waiting agents ask every 300 ms.
  const engine = new Engine(`slots-${port}`, { port, dataDir: join(dir, "engine"), env: { ...shared, CAPCOMD_FAKE_PUSH_DELAY_MS: "2500", CAPCOMD_FAKE_MEMORY_MB: "2048", CAPCOMD_ADMIT_RETRY_MS: "300" } });
  await engine.start(null);
  try {
    const env: Record<string, string> = { ...shared, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`, CAPCOMD_SPAWN_EXEC: "fake" };
    const run = last((await capcomd(["run", "new", "--json"], env)).stdout).runId;
    const ids: string[] = [];
    for (const k of ["a", "b", "c", "d"]) ids.push(last((await capcomd(["spawn", run, "--task", `slow push ${k}`, "--key", k, "--json"], env)).stdout).agentId);
    let most = 0, sawPending = false;
    const statuses = async () => {
      const tree: Array<{ agentId: string; status: string }> = last((await capcomd(["tree", run, "--json"], env)).stdout).tree ?? [];
      return ids.map((id) => tree.find((a) => a.agentId === id)?.status ?? "?");
    };
    for (let i = 0; i < 150; i++) {
      const st = await statuses();
      most = Math.max(most, st.filter((s) => s === "running").length);
      if (st.includes("pending") && st.filter((s) => s === "running").length === 2) sawPending = true;
      if (st.every((s) => s === "done")) break;
      await sleep(200);
    }
    expect(await statuses()).toEqual(["done", "done", "done", "done"]);
    expect(most).toBe(2);
    expect(sawPending).toBe(true);
    // A waiting agent says so in its log, and again when it starts.
    const logs = (await capcomd(["logs", run, ids[3]!, "--json"], env)).stdout;
    expect(logs).toContain("waiting for a local agent slot: 2 of 2 in use");
    expect(logs).toContain("a local agent slot is free: starting");
  } finally { await engine.stop(); }
}, 240_000);

/** An engine with room for one agent (1 GB of memory at 1 GB each), slowed pushes, and quick asks for a slot. */
async function oneSlot(name: string, extra: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), `capcomd-${name}-`));
  const port = await testPort();
  const shared = { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_HOME: join(dir, "home") };
  const engine = new Engine(`${name}-${port}`, { port, dataDir: join(dir, "engine"), env: { ...shared, CAPCOMD_FAKE_MEMORY_MB: "1024", CAPCOMD_ADMIT_RETRY_MS: "300", ...extra } });
  await engine.start(null);
  const env: Record<string, string> = { ...shared, CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`, CAPCOMD_SPAWN_EXEC: "fake" };
  const tree = async (run: string): Promise<Array<{ agentId: string; status: string }>> => last((await capcomd(["tree", run, "--json"], env)).stdout).tree ?? [];
  return { engine, env, dir, tree };
}

test("capcomd run (the recipe): its agents wait for a slot like any other, then the run completes", async () => {
  const { engine, env, tree } = await oneSlot("slots-recipe", { CAPCOMD_FAKE_PUSH_DELAY_MS: "4000" });
  try {
    // Another run's agent holds the only slot for a while.
    const other = last((await capcomd(["run", "new", "--json"], env)).stdout).runId;
    const holder = last((await capcomd(["spawn", other, "--task", "slow push holder", "--key", "h", "--json"], env)).stdout).agentId;
    for (let i = 0; i < 50 && (await tree(other)).find((a) => a.agentId === holder)?.status !== "running"; i++) await sleep(100);
    const runId = `run-slots-recipe-${Date.now()}`;
    // The recipe is the recipe-hierarchical plugin's, off unless turned on.
    const r = await capcomd(["run", "--recipe", "--json", "--run-id", runId, "Build a thing"], { ...env, CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED: "true" });
    expect(r.code).toBe(0);
    const evs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
    expect(evs.at(-1)).toMatchObject({ type: "run.result", ok: true, state: "completed" });
    // Its first agent asked while the holder ran: it waited, and said so.
    const first = (await tree(runId))[0]!;
    const logs = (await capcomd(["logs", runId, first.agentId, "--json"], env)).stdout;
    expect(logs).toContain("waiting for a local agent slot: 1 of 1 in use");
    expect(logs).toContain("a local agent slot is free: starting");
  } finally { await engine.stop(); }
}, 240_000);

test("an admitted agent whose workflow ends before it has a machine gives its slot back at once (not after the grace)", async () => {
  const { engine, env, tree } = await oneSlot("slots-free");
  try {
    // An agent that was paused before it started, then asked to start: it is admitted (takes the only slot), and its
    // workflow ends at once (nothing to run). Its machine never appears.
    const a = last((await capcomd(["run", "new", "--json"], env)).stdout).runId;
    const paused = last((await capcomd(["spawn", a, "--task", "never runs", "--key", "p", "--no-start", "--json"], env)).stdout).agentId;
    expect((await capcomd(["pause", a, paused, "--json"], env)).code).toBe(0);
    process.env.CAPCOMD_ENDPOINT = env.CAPCOMD_ENDPOINT;
    const { client } = await import("../../src/core/relay");
    expect(await (client().worker.getOrCreate([a, paused]) as any).startAgent({ runId: a, agentId: paused, epoch: 1 })).toMatchObject({ queued: true });
    // The next agent (another run) starts right away and finishes: the slot came back when that workflow ended.
    const b = last((await capcomd(["run", "new", "--json"], env)).stdout).runId;
    const next = last((await capcomd(["spawn", b, "--task", "next", "--key", "n", "--json"], env)).stdout).agentId;
    let st = "";
    for (let i = 0; i < 150 && st !== "done"; i++) { st = (await tree(b)).find((x) => x.agentId === next)?.status ?? ""; if (st !== "done") await sleep(200); }
    expect(st).toBe("done");
    expect((await capcomd(["logs", b, next, "--json"], env)).stdout).not.toContain("waiting for a local agent slot");
    expect((await tree(a)).find((x) => x.agentId === paused)?.status).toBe("paused");
  } finally { await engine.stop(); }
}, 120_000);
