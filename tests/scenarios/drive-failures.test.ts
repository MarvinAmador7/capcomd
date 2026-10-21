// Regression (live Mac run): a drive attempt that fails in the worker push used to retry silently
// forever (only TOKEN_REVOKED events, agent STUCK "running"). Now: DRIVE_FAILED per attempt
// (redacted, with error_kind), and N identical failures in a row fail the agent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

let w: World;
const MSG = "upload /tmp/capcomd-rpc/bin/capcomd: no such file or directory (token cct1.AAAAAAAAAAAA.BBBBBBBBBBBB)";
beforeAll(async () => { w = await world("drivefail", { CAPCOMD_FAKE_PUSH_FAIL: MSG, CAPCOMD_DRIVE_MAX_FAILURES: "3" }); }, 120_000);
afterAll(async () => { await w?.stop(); });

test("failing drive attempts are evented, counted, and fail the agent instead of looping", async () => {
  const run = await newRun(w);
  const root = await spawnRoot(w, run, "planner", w.script("pl", WORKER));
  const t0 = Date.now();
  const aw = await waitAll(w, run, [root], 60_000);
  expect(aw.timeout ?? false).toBe(false);
  expect(aw.agents[0].status).toBe("failed");
  expect(aw.agents[0].result.error).toContain("no such file or directory");
  expect(Date.now() - t0).toBeLessThan(45_000);
  const ev: any[] = (await w.cj(["events", run])).j.events;
  const df = ev.filter((e) => e.type === "DRIVE_FAILED");
  expect(df.length).toBe(3);
  expect(df.map((e) => e.event.consecutive)).toEqual([1, 2, 3]);
  for (const e of df) {
    expect(e.agentId).toBe(root);
    expect(typeof e.event.error_kind).toBe("string");
    expect(e.event.message).toContain("no such file or directory");
    expect(e.event.message).not.toContain("cct1.AAAA"); // redacted
  }
  expect(ev.some((e) => e.type === "AGENT_FAILED" && e.agentId === root)).toBe(true);
  for (const e of ev.filter((e) => e.type === "TOKEN_REVOKED")) expect(e.agentId).toBe(root);
}, 90_000);
