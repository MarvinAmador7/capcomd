// A boxd auth error at sandbox.ensure fails the run once, with a clear non-retryable reason.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";

let PORT = 0;
let engine: Engine;
const saved = process.env.CAPCOMD_FAKE_ENSURE_ERROR;
beforeAll(async () => {
  process.env.CAPCOMD_FAKE_ENSURE_ERROR = "auth";
  PORT = await testPort();
  engine = new Engine("auth-fail", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-authfail-")) });
  await engine.start(null);
}, 120_000);
const created: string[] = [];
afterAll(async () => {
  // No run delete API yet (#41): cancel what this test created so it leaves Active.
  for (const id of created) await capcomd(["cancel", id, "--json"], { CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}` }).catch(() => {});
  await engine?.stop();
  if (saved === undefined) delete process.env.CAPCOMD_FAKE_ENSURE_ERROR; else process.env.CAPCOMD_FAKE_ENSURE_ERROR = saved;
});

test("run fails with kind=config, retryable=false; status shows failed", async () => {
  const runId = `run-authfail-${Date.now()}`;
  created.push(runId);
  const env = { CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}` };
  const r = await capcomd(["run", "--json", "--run-id", runId, "anything"], env);
  expect(r.code).toBe(1);
  const evs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const failed = evs.find((e) => e.type === "run.failed");
  expect(failed).toMatchObject({ kind: "config", retryable: false });
  expect(failed.reason).toContain("BOXD_API_KEY");
  const s = JSON.parse((await capcomd(["status", runId, "--json"], env)).stdout);
  expect(s.run.state).toBe("failed");
}, 120_000);
