// The memory cap on local agents (src/providers/capacity.ts): with room for two agents, four spawned at once run two at
// a time; the others wait as `pending` (their workflow isn't started) and start as the first ones finish. The fake
// sandbox gets the cap through its test knob (CAPCOMD_FAKE_MEMORY_MB), as Docker gets it from `docker info`.
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
