// ADR-022: the engine decides how agents are driven (its CAPCOMD_AGENT_WORKFLOW: the workflow by default, agent-drive
// processes with =0). A CLI whose own setting differs follows the engine it talks to, and says so once on stderr.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, sleep, testPort } from "../helpers/engine";

const saved = { ...process.env };
afterAll(() => { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); });

/** This run's `capcomd agent-drive` processes. */
const drivers = (run: string) => Bun.spawnSync(["ps", "-A", "-o", "command="]).stdout.toString().split("\n").filter((l) => l.includes(` agent-drive ${run} `));

async function scenario(engineSetting: "0" | undefined, cliSetting: "0" | "1" | undefined) {
  const dir = mkdtempSync(join(tmpdir(), "capcomd-wf-mode-"));
  const port = await testPort();
  // A slowed push, so a driver process (if any) is there long enough to see.
  const engineEnv: Record<string, string> = { CAPCOMD_SANDBOX: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_FAKE_PUSH_DELAY_MS: "3000", CAPCOMD_HOME: join(dir, "home"), ...(engineSetting ? { CAPCOMD_AGENT_WORKFLOW: engineSetting } : {}) };
  delete process.env.CAPCOMD_AGENT_WORKFLOW;
  const engine = new Engine(`wf-mode-${port}`, { port, dataDir: join(dir, "engine"), env: engineEnv });
  await engine.start(null);
  try {
    const env: Record<string, string> = { CAPCOMD_ENDPOINT: `http://127.0.0.1:${port}`, CAPCOMD_SANDBOX: "fake", CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_HOME: join(dir, "home") };
    const cli = cliSetting === undefined ? env : { ...env, CAPCOMD_AGENT_WORKFLOW: cliSetting };
    const run = JSON.parse((await capcomd(["run", "new", "--json"], cli)).stdout.trim().split("\n").pop()!).runId;
    const sp = await capcomd(["spawn", run, "--task", "slow push", "--key", "s", "--json"], cli);
    const agent = JSON.parse(sp.stdout.trim().split("\n").pop()!).agentId;
    let sawDriver = false;
    for (let i = 0; i < 20 && !sawDriver; i++) { sawDriver = drivers(run).length > 0; await sleep(100); }
    const aw = await capcomd(["await", run, agent, "--timeout-ms", "60000", "--json"], cli);
    const status = JSON.parse(aw.stdout.trim().split("\n").pop()!).agents?.[0]?.status;
    for (let i = 0; i < 50 && drivers(run).length; i++) await sleep(200);
    return { status, sawDriver, stderr: sp.stderr };
  } finally { await engine.stop(); }
}

test("an engine on the default (workflow) drives agents with its workflow even for a CLI with CAPCOMD_AGENT_WORKFLOW=0", async () => {
  const r = await scenario(undefined, "0");
  expect(r.status).toBe("done");
  expect(r.sawDriver).toBe(false);
  expect(r.stderr).toContain("the engine drives agents with its workflow");
}, 240_000);

test("an engine with CAPCOMD_AGENT_WORKFLOW=0 gets agent-drive processes even from a CLI on the default", async () => {
  const r = await scenario("0", undefined);
  expect(r.status).toBe("done");
  expect(r.sawDriver).toBe(true);
  expect(r.stderr).not.toContain("doesn't apply"); // nothing set here: nothing to correct
  const r2 = await scenario("0", "1");
  expect(r2.status).toBe("done");
  expect(r2.sawDriver).toBe(true);
  expect(r2.stderr).toContain("the engine drives agents with agent-drive processes");
}, 360_000);
