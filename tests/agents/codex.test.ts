import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runAgent, AgentError, parseDetect } from "../../src/agents/runner";
import { codexAdapter, claudeAdapter, adapterFor } from "../../src/agents/adapters";
import { loadAgentConfig, agentFromEnv, agentEgress, CODEX_VERSION } from "../../src/agents/config";
import { Redactor } from "../../src/agents/redact";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";
import { taskBranch } from "../../src/merge/config";
import { Git } from "../../src/merge/git";

const FAKE = new URL("./fake-codex.sh", import.meta.url).pathname;
const KEY = "sk-proj-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";

async function setup(goal: string, over: Record<string, string> = {}) {
  const r = await bareRepo();
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-codex-"));
  const provider = new FakeProvider({ hostExec: true });
  const { id } = await provider.ensure({ idemKey: `c-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: agentEgress("codex"), labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: FAKE, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "env", ...over });
  const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal };
  return { r, provider, id, cfg, task, W: join(workdir, "task-1-e1") };
}
beforeEach(() => resetSpans());

describe("codex adapter (fake codex exec --json)", () => {
  test("headless exec with documented flags; JSONL → turns + estimated cost; commit trailer; push", async () => {
    const s = await setup("make the failing test pass");
    const res = await runAgent(codexAdapter, s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    const argv = readFileSync(join(s.W, "argv.txt"), "utf8").split("\n");
    expect(argv.slice(0, 2)).toEqual(["exec", "--json"]);
    // No restrictions by default: the VM is the boundary.
    for (const f of ["--color", "never", "--ephemeral", "--sandbox", "danger-full-access", "-C", "-o"]) expect(argv).toContain(f);
    expect(argv).not.toContain("--full-auto");
    expect(argv).toContain("KEY_PRESENT");
    expect(res.turns).toBe(2); // command_execution + file_change
    // (10000 in × 1.25 + 1500 out × 10) / 1e6
    expect(res.costUsd).toBeCloseTo(0.0275, 6);
    expect(res.credentialMode).toBe("env");
    const g = new Git(s.r.bare);
    const msg = (await g.run(["log", "-1", "--format=%B", s.task.branch])).stdout;
    expect(msg).toContain("fixed sum with codex");
    expect(msg).toContain(`Capcomd-Agent: codex@${CODEX_VERSION}`);
    const span = getFinishedSpans().find((x) => x.name === "agent.codex")!;
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(10000);
    expect(span.events.map((e) => e.name)).toContain("agent.item_completed.file_change");
    expect(JSON.stringify(getFinishedSpans())).not.toContain(KEY);
  }, 30_000);

  test("turn guard: codex has no --max-turns, capcomd kills it past the limit", async () => {
    const s = await setup("[loop] spin", { CAPCOMD_AGENT_MAX_TURNS: "5" });
    const err = await runAgent(codexAdapter, s.provider, s.id, s.task, s.cfg, { apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("limit"); // nothing changed, so nothing to keep
    expect(err.message).toContain("max_turns");
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBeNull();
  }, 30_000);

  test("budget guard from token-estimated cost", async () => {
    const s = await setup("make it pass", { CAPCOMD_AGENT_MAX_BUDGET_USD: "0.01", CAPCOMD_AGENT_POLL_MS: "50" });
    // Fake exits right after turn.completed; outcome still ok unless guard fires first, so check the guard function directly too.
    const state = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0.02, done: false };
    expect(codexAdapter.guard(state, s.cfg)).toContain("max_budget_usd");
  });

  test("turn.failed and leaks: typed failure, key redacted", async () => {
    const f = await setup("[fail] [leak]");
    const err = await runAgent(codexAdapter, f.provider, f.id, f.task, f.cfg, { apiKey: KEY }).catch((e) => e);
    expect(err.kind).toBe("failed");
    expect(err.message).toContain("model refused");
    const n = await setup("[nochange] [leak]");
    const e2 = await runAgent(codexAdapter, n.provider, n.id, n.task, n.cfg, { apiKey: KEY }).catch((e) => e);
    expect(e2.kind).toBe("no_changes");
    expect(JSON.stringify(getFinishedSpans()) + err.message + e2.message).not.toContain(KEY);
  }, 30_000);

  test("usage limit: recognized from turn.failed (not a retry), reset parsed from the VM's UTC clock text", async () => {
    const { codexResetAt } = await import("../../src/agents/adapters");
    const cfg = loadAgentConfig({ CAPCOMD_AGENT: "codex" });
    const r = new Redactor([]);
    const now = Date.UTC(2026, 9, 22, 13, 0);
    expect(codexResetAt("You’ve hit your usage limit. Try again at 3:05 PM.", now)).toBe(Date.UTC(2026, 9, 22, 15, 5));
    expect(codexResetAt("You’ve hit your usage limit. Try again at 9:00 AM.", now)).toBe(Date.UTC(2026, 9, 23, 9, 0)); // past today: tomorrow
    expect(codexResetAt("You’ve hit your usage limit. Upgrade to Pro or try again at Oct 25th, 2026 3:05 PM.", now)).toBe(Date.UTC(2026, 9, 25, 15, 5));
    expect(codexResetAt("You’ve hit your usage limit. Try again later.", now)).toBeUndefined();
    const st = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false } as any;
    codexAdapter.parse('{"type":"error","message":"Reconnecting... 2/5 (stream disconnected)"}', r, st, cfg);
    expect(st.quota).toBeUndefined();
    codexAdapter.parse('{"type":"turn.failed","error":{"message":"You’ve hit your usage limit. Try again at 3:05 PM."}}', r, st, cfg);
    expect(st.quota).toMatchObject({ message: expect.stringContaining("usage limit") });
    expect(typeof st.quota.resetAt).toBe("number");
    const st2 = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false } as any;
    codexAdapter.parse('{"type":"turn.failed","error":{"message":"exceeded retry limit, last status: 429 Too Many Requests"}}', r, st2, cfg);
    expect(st2.quota).toBeUndefined();
    expect(codexAdapter.baseEnv().TZ).toBe("UTC");
  });

  test("parse: codex JSONL shapes; config and selection", () => {
    const st = { events: 0, turns: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, done: false };
    const cfg = loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH: "apikey" });
    // No default limits (ADR-019): an idle agent is noticed after 30 minutes, never stopped unless a window is set.
    expect([cfg.maxTurns, cfg.maxBudgetUsd, cfg.timeoutMs]).toEqual([undefined, undefined, undefined]);
    expect([cfg.idleAfterMs, cfg.stopIdle, cfg.stopStuck]).toEqual([30 * 60_000, false, false]);
    expect(loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AUTH: "apikey", CAPCOMD_AGENT_IDLE_MS: "60000" }).stopIdle).toBe(true);
    expect(codexAdapter.guard({ ...st, turns: 10_000, costUsd: 1_000 }, cfg)).toBeNull();
    const r = new Redactor([]);
    expect(codexAdapter.parse('{"type":"item.completed","item":{"type":"command_execution","command":"npm test"}}', r, st, cfg)!.tool).toBe("Bash(npm test)");
    expect(codexAdapter.parse('{"type":"error","message":"boom"}', r, st, cfg)!.text).toBe("boom");
    expect(codexAdapter.parse("{partial", r, st, cfg)).toBeNull();
    // A tool step is its own call and result, for the stuck watch (ADR-019 §2): a non-zero exit is an error.
    const ok = codexAdapter.parse('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":0,"status":"completed"}}', r, st, cfg)!;
    expect(ok.calls).toEqual(['command "npm test"']);
    expect(ok.results).toEqual([{ call: 'command "npm test"' }]);
    const bad = codexAdapter.parse('{"type":"item.completed","item":{"type":"command_execution","command":"npm test","exit_code":1,"status":"failed","aggregated_output":"1 failing: expected 3"}}', r, st, cfg)!;
    expect(bad.results).toEqual([{ call: 'command "npm test"', error: "1 failing: expected 3" }]);
    expect(codexAdapter.parse('{"type":"item.started","item":{"type":"command_execution","command":"npm test"}}', r, st, cfg)!.calls).toBeUndefined();
    expect(agentFromEnv({ CAPCOMD_AGENT: "codex" })).toBe("codex");
    expect([cfg.egress, cfg.codexSandbox]).toEqual([["*"], "danger-full-access"]); // unrestricted unless a profile narrows it
    expect(adapterFor("codex").secretName).toBe("OPENAI_API_KEY");
    expect(codexAdapter.credentialEnv("x")).toEqual({ CODEX_API_KEY: "x", OPENAI_API_KEY: "x" });
    expect(claudeAdapter.credentialEnv("x")).toEqual({ ANTHROPIC_API_KEY: "x" });
    expect(() => loadAgentConfig({ CAPCOMD_CODEX_SANDBOX: "yolo" })).toThrow();
    expect(parseDetect("bin=/usr/local/bin/codex\nversion=codex-cli 0.163.0\nnode=v22.1.0")).toEqual({ bin: "/usr/local/bin/codex", version: "0.163.0", node: "v22.1.0" });
    expect(parseDetect("node=v20.0.0")).toEqual({ node: "v20.0.0" });
  });
});
