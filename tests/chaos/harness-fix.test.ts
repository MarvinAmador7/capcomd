// A serve hard-killed at merge.before_cas leaves nothing bound, and a restart on the same data dir comes up
// without coordinator "transaction closed" errors.
//
// Every process this test kills is one it started: the serve runs in its own process group on a private port
// block, data dir and harness socket, and Engine (./engine) kills that group plus the rivet-engine found by this
// instance's own ports or pid file. It used to `pkill -9 bun`, which took down every Bun process on the machine:
// a developer's `capcomd serve` daemon, editors' language servers, other test runs and this test runner itself.
import { describe, test, expect } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine, pidsListening, runClient, sleep, type EngineOpts } from "./engine";
import { testPort } from "../helpers/engine";

const logSize = (path: string) => (existsSync(path) ? statSync(path).size : 0);

async function waitPortsFree(ports: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms;
  for (;;) {
    const holders = (await Promise.all(ports.map((p) => pidsListening(p)))).flat();
    if (holders.length === 0 || Date.now() > deadline) return holders;
    await sleep(100);
  }
}

describe("Chaos - Fixed Harness", () => {
  test("merge.before_cas with proper cleanup", async () => {
    const port = await testPort();
    const dataDir = mkdtempSync(join(tmpdir(), "capcomd-harness-fix-"));
    const opts: EngineOpts = { port, dataDir, env: { CAPCOMD_HOME: join(dataDir, "home") } };
    const engine = new Engine(`harness-fix-${port}`, opts);
    const runId = `chaos-harness-fix-${Date.now()}-p${port}`;
    try {
      // Serve with the killpoint; the run's merge reaches it and serve dies by SIGKILL. Engine then
      // SIGKILLs serve's process group and this instance's rivet-engine (its own ports), nothing else.
      await engine.start("merge.before_cas:1");
      await runClient(runId, opts);
      expect(engine.sawKill).toBe(true);
      expect(readFileSync(engine.logPath, "utf8")).toContain("[KILLPOINT] Exiting at merge.before_cas:1");

      // Nothing of the killed instance still listens (guard, api-peer, metrics).
      expect(await waitPortsFree([port, port + 1, port + 10], 5_000)).toEqual([]);
      console.log("  ✓ ports free");

      // Restart on the same data dir and watch it for coordinator errors.
      console.log("  Restarting serve...");
      const offset = logSize(engine.logPath);
      await engine.start(null);
      await sleep(8_000);
      const output = readFileSync(engine.logPath, "utf8").slice(offset);
      const coordinatorErrors = output.match(/transaction.*closed/g)?.length ?? 0;
      console.log(`  Coordinator errors: ${coordinatorErrors}`);
      expect(coordinatorErrors).toBe(0);
    } finally {
      await engine.stop().catch((e) => console.log(`  cleanup error: ${e instanceof Error ? e.message : e}`));
      rmSync(dataDir, { recursive: true, force: true });
    }
  }, 180_000);
});
