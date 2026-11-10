// Regression (live Mac run): a drive attempt that fails in the worker push used to retry silently
// forever (only TOKEN_REVOKED events, agent STUCK "running"). Now: DRIVE_FAILED per attempt
// (redacted, with error_kind), and N identical failures in a row fail the agent.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { world, newRun, spawnRoot, waitAll, WORKER, type World } from "./harness";

describe("a push that keeps failing", () => {
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
});

// Live re-check: a worker told not to change files ended `no_changes` and was run again, and again, to the same end.
describe("a worker that changes nothing", () => {
  let w: World;
  beforeAll(async () => { w = await world("nochange"); }, 120_000);
  afterAll(async () => { await w?.stop(); });

  test("fails after one attempt, says to spawn it with --report, and keeps what it found", async () => {
    const run = await newRun(w);
    // It writes README.md as the target already has it: no change of its own.
    const found = "the bug is in parse(): it drops the last token";
    const root = await spawnRoot(w, run, "worker", w.script("nc", `FILE=README.md CONTENT='# fixture\n' SUMMARY='${found}'\n${WORKER}`));
    const aw = await waitAll(w, run, [root], 60_000);
    expect(aw.timeout ?? false).toBe(false);
    expect(aw.agents[0].status).toBe("failed");
    const result = aw.agents[0].result;
    expect(result.error).toContain("made no changes");
    expect(result.error).toContain("spawn it with --report for work that changes no files");
    expect(result.errorKind).toBe("no_changes");
    expect(result.summary).toBe(found);
    const ev: any[] = (await w.cj(["events", run])).j.events;
    const df = ev.filter((e) => e.type === "DRIVE_FAILED" && e.agentId === root);
    expect(df.length).toBe(1);
    expect(df[0].event.error_kind).toBe("no_changes");
    expect(df[0].event.message).toContain("--report");
    expect(ev.filter((e) => e.type === "AGENT_FAILED" && e.agentId === root).length).toBe(1);
  }, 90_000);

  test("one that declared no summary: its final words are its summary on the failure", async () => {
    const run = await newRun(w);
    const agent = (await w.cj(["spawn", run, "--profile", "worker", "--task", "look around", "--no-start", "--contract", JSON.stringify({ script: w.script("quiet", "exit 0") })])).j.agentId as string;
    const s = (await import("../../src/core/relay")).client().scope.getOrCreate([run]);
    const a = await s.getAgent({ agentId: agent });
    const { finishFailed } = await import("../../src/primitives/ops");
    const fin = await finishFailed(run, agent, a!.epoch, { kind: "no_changes", message: "made no changes; spawn it with --report for work that changes no files", resultText: "  the flaky test is the clock one  " });
    expect(fin.status).toBe("failed");
    expect((await s.getAgent({ agentId: agent }))!.result).toMatchObject({ errorKind: "no_changes", summary: "the flaky test is the clock one" });
    // Any other failure: no errorKind, its words aren't a summary.
    const other = (await w.cj(["spawn", run, "--profile", "worker", "--task", "look around", "--no-start", "--contract", JSON.stringify({ script: w.script("quiet2", "exit 0") })])).j.agentId as string;
    await finishFailed(run, other, (await s.getAgent({ agentId: other }))!.epoch, { kind: "git", message: "git push failed", resultText: "words" });
    const r2 = (await s.getAgent({ agentId: other }))!.result;
    expect(r2.errorKind).toBeUndefined();
    expect(r2.summary ?? null).toBeNull();
  }, 60_000);
});
