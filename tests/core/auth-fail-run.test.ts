// A boxd auth error at sandbox.ensure fails the run once, with a clear non-retryable reason. The worker recorded the VM
// it was about to make in capcomd's machines ledger before asking the provider (ADR-021 §3): the record stays, since a
// failed ensure may still have left a machine behind, and only a machine in the ledger can be deleted as left behind.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../chaos/engine";
import { capcomd, testPort } from "../helpers/engine";

let PORT = 0;
let engine: Engine;
const saved = process.env.CAPCOMD_FAKE_ENSURE_ERROR;
const savedLedger = process.env.CAPCOMD_MACHINES_LEDGER;
const ledger = mkdtempSync(join(tmpdir(), "capcomd-authfail-ledger-"));
beforeAll(async () => {
  process.env.CAPCOMD_FAKE_ENSURE_ERROR = "auth";
  process.env.CAPCOMD_MACHINES_LEDGER = ledger;
  PORT = await testPort();
  engine = new Engine("auth-fail", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-authfail-")) });
  await engine.start(null);
}, 120_000);
afterAll(async () => {
  await engine?.stop();
  if (saved === undefined) delete process.env.CAPCOMD_FAKE_ENSURE_ERROR; else process.env.CAPCOMD_FAKE_ENSURE_ERROR = saved;
  if (savedLedger === undefined) delete process.env.CAPCOMD_MACHINES_LEDGER; else process.env.CAPCOMD_MACHINES_LEDGER = savedLedger;
});

test("run fails with kind=config, retryable=false; status shows failed", async () => {
  const runId = `run-authfail-${Date.now()}`;
  const env = { CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}` };
  const r = await capcomd(["run", "--json", "--run-id", runId, "anything"], env);
  expect(r.code).toBe(1);
  const evs = r.stdout.trim().split("\n").map((l) => JSON.parse(l));
  const failed = evs.find((e) => e.type === "run.failed");
  expect(failed).toMatchObject({ kind: "config", retryable: false });
  expect(failed.reason).toContain("BOXD_API_KEY");
  const s = JSON.parse((await capcomd(["status", runId, "--json"], env)).stdout);
  expect(s.run.state).toBe("failed");
  const files = readdirSync(ledger);
  expect(files).toEqual([expect.stringMatching(/^relay-[0-9a-f]{16}\.json$/)]);
  const rec = JSON.parse(readFileSync(join(ledger, files[0]!), "utf8"));
  expect(rec).toMatchObject({ name: files[0]!.slice(0, -5), sandbox: "fake", kind: "agent", runId, agentId: expect.stringMatching(/^agt-/) });
  expect(rec.workerKey).toEqual([runId, rec.agentId]);
}, 120_000);
