// The live e2e of 2026-10-29: boxd stopped answering for a few minutes while agents ran, and the runner's next look at
// the agent ("exec timed out after 120000ms") failed them although they kept working in their VMs. Now the runner keeps
// looking for up to the outage window (the agent carries on), and only past it fails with sandbox_unreachable.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { resilientProvider, withOutageListener, type Outage } from "../../src/providers/resilient";
import { SandboxUnreachableError } from "../../src/providers/boxd-errors";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";
import { taskBranch } from "../../src/merge/config";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const saved = { o: process.env.CAPCOMD_SANDBOX_OUTAGE_MS, b: process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS };

async function setup(goal: string) {
  const r = await bareRepo();
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-agent-"));
  const raw = new FakeProvider({ hostExec: true });
  const provider = resilientProvider(raw, { name: "boxd" });
  const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" });
  const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal };
  return { r, raw, provider, id, cfg, task };
}

beforeEach(() => { resetSpans(); process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS = "50"; });
afterEach(() => {
  if (saved.o === undefined) delete process.env.CAPCOMD_SANDBOX_OUTAGE_MS; else process.env.CAPCOMD_SANDBOX_OUTAGE_MS = saved.o;
  if (saved.b === undefined) delete process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS; else process.env.CAPCOMD_SANDBOX_RETRY_BASE_MS = saved.b;
});

describe("a sandbox provider outage while the agent works", () => {
  test("shorter than the window: the runner waits for the machine, the agent finishes and its work is pushed", async () => {
    process.env.CAPCOMD_SANDBOX_OUTAGE_MS = "8000";
    const s = await setup("[slow] steady work");
    let hit = false;
    const heard: Array<Outage | null> = [];
    // The outage starts once the agent is running (its first event): every call fails, the probe included.
    const res = await withOutageListener((o) => heard.push(o), () => runClaudeCode(s.provider, s.id, s.task, s.cfg, {
      apiKey: KEY,
      onEvent: () => { if (!hit) { hit = true; s.raw.faults = { until: Date.now() + 1500 }; } },
    }));
    expect(hit).toBe(true);
    expect(s.raw.faulted.exec).toBeGreaterThan(0);
    expect(res.stopReason).toBe("success");
    expect(res.limit).toBeUndefined();
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBe(res.sha);
    expect(heard[0]).toMatchObject({ provider: "boxd", what: "exec" });
    expect(heard.at(-1)).toBeNull();
    const names = getFinishedSpans().find((x) => x.name === "agent.claude_code")!.events.map((e) => e.name);
    expect(names).toContain("agent.sandbox_outage");
    expect(names).toContain("agent.sandbox_answered");
  }, 60_000);

  test("longer than the window: the agent fails with sandbox_unreachable, naming the provider and how long", async () => {
    process.env.CAPCOMD_SANDBOX_OUTAGE_MS = "1500";
    const s = await setup("[slow] steady work");
    let hit = false;
    const t0 = Date.now();
    const e = await runClaudeCode(s.provider, s.id, s.task, s.cfg, {
      apiKey: KEY,
      onEvent: () => { if (!hit) { hit = true; s.raw.faults = { until: Date.now() + 60_000 }; } },
    }).catch((x) => x);
    expect(e).toBeInstanceOf(SandboxUnreachableError);
    expect(e.kind).toBe("sandbox_unreachable");
    expect(e.message).toMatch(/^the sandbox provider \(boxd\) didn't answer for [\d.]+ s \(exec: /);
    expect(Date.now() - t0).toBeLessThan(20_000);
    s.raw.faults = null;
  }, 60_000);
});
