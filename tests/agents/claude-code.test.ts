import { describe, expect, test, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runClaudeCode, AgentError, parseStreamLine, buildPrompt, installScript } from "../../src/agents/claude-code";
import { loadAgentConfig, agentFromEnv, AGENT_EGRESS, CLAUDE_CODE_VERSION } from "../../src/agents/config";
import { Redactor, REDACTED } from "../../src/agents/redact";
import { githubGitCredentials } from "../../src/agents/credentials";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";
import { taskBranch } from "../../src/merge/config";
import { Git } from "../../src/merge/git";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";

async function setup(goal: string, cfgOver: Record<string, string> = {}) {
  const r = await bareRepo();
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-agent-"));
  const log: Array<{ cmd: string[]; envKeys: string[]; env?: Record<string, string> }> = [];
  const provider = new FakeProvider({ hostExec: true, log });
  const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50", ...cfgOver });
  const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal };
  return { r, provider, id, cfg, task, log, workdir, W: join(workdir, "task-1-e1") };
}
const traceText = () => JSON.stringify(getFinishedSpans());

beforeEach(() => resetSpans());

describe("claude-code adapter (fake claude in FakeProvider)", () => {
  test("runs headless with guards, streams events into the trace, commits with trailers, pushes the task branch", async () => {
    const s = await setup("make the failing test pass");
    const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(res).toMatchObject({ already: false, turns: 3, stopReason: "success" });
    expect(res.costUsd).toBeCloseTo(0.123);
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBe(res.sha);
    const msg = await new Git(s.r.bare).ok(["log", "-1", "--format=%B", s.task.branch]);
    expect(msg).toContain("Capcomd-Task: r1/task-1");
    expect(msg).toContain("Capcomd-Epoch: 1");
    expect(msg).toContain(`Capcomd-Agent: claude-code@${CLAUDE_CODE_VERSION}`);
    expect(await s.r.show(s.task.branch, "src/sum.ts")).toContain("a + b");

    const argv = readFileSync(join(s.W, "argv.txt"), "utf8").split("\n");
    for (const flag of ["--output-format", "stream-json", "--allowedTools", "--disallowedTools"]) expect(argv).toContain(flag);
    // No limits unless a profile sets them (ADR-019): no turn or budget flags, no `timeout` wrapper.
    expect(argv).not.toContain("--max-turns");
    expect(argv).not.toContain("--max-budget-usd");
    expect(readFileSync(join(s.W, "run.sh"), "utf8")).not.toContain("timeout ");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toContain("Bash(npm test:*)");
    expect(argv[argv.indexOf("--disallowedTools") + 1]).toContain("Bash(git push:*)");
    expect(argv).toContain("KEY_PRESENT");

    const span = getFinishedSpans().find((x) => x.name === "agent.claude_code")!;
    expect(span.attributes["agent.cost_usd"]).toBeCloseTo(0.123);
    const names = span.events.map((e) => e.name);
    expect(names).toEqual(["agent.system.init", "agent.assistant", "agent.user", "agent.result.success"]);
    expect(span.events[1]!.attributes!["agent.tool"]).toBe("Edit");

    // The key went into exactly one exec env (the claude start), never into git execs.
    const withKey = s.log.filter((l) => l.envKeys.includes("ANTHROPIC_API_KEY"));
    expect(withKey.length).toBe(1);
    expect(withKey[0]!.cmd.join(" ")).toContain("setsid nohup");
    expect(s.log.filter((l) => l.cmd[0] === "git").every((l) => !l.envKeys.includes("ANTHROPIC_API_KEY"))).toBe(true);
    expect(s.log.every((l) => !l.cmd.join(" ").includes(KEY))).toBe(true);
    expect(readFileSync(join(s.W, "prompt.txt"), "utf8")).not.toContain(KEY);
  });

  test("review mode: detached at the reviewed commit, review prompt, final message returned, nothing pushed", async () => {
    const s = await setup("make the failing test pass");
    const pushed = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    const review = { sha: pushed.sha, branch: s.task.branch, target: s.task.target };
    const rv = { ...s.task, taskId: "rev-1", goal: "Acceptance criteria:\n- sum adds", review };
    const res = await runClaudeCode(s.provider, s.id, rv, s.cfg, { apiKey: KEY });
    expect(res).toMatchObject({ sha: "", already: false, stopReason: "success", resultText: "fixed sum" });
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBe(pushed.sha); // the fake edited a file; nothing was pushed
    const W = join(s.workdir, "rev-1-e1");
    const prompt = readFileSync(join(W, "prompt.txt"), "utf8");
    expect(prompt).toContain(`You are reviewing a change. The repository is checked out at commit ${pushed.sha}`);
    expect(prompt).toContain("Acceptance criteria:\n- sum adds");
    expect(prompt).toContain('{"passed": true|false, "reasons": ["..."]}');
    expect((await new Git(join(W, "repo")).ok(["rev-parse", "HEAD"])).trim()).toBe(pushed.sha);
    expect(getFinishedSpans().some((x) => x.name === "agent.claude_code" && x.attributes["agent.review"] === true)).toBe(true);
  });

  test("report mode: read-only prompt, final message returned, nothing committed or pushed", async () => {
    const s = await setup("Find where sum is defined and report");
    const res = await runClaudeCode(s.provider, s.id, { ...s.task, report: true }, s.cfg, { apiKey: KEY });
    expect(res).toMatchObject({ sha: "", already: false, stopReason: "success", resultText: "fixed sum" });
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBeNull(); // the fake edited a file; no branch was pushed
    const prompt = readFileSync(join(s.W, "prompt.txt"), "utf8");
    expect(prompt).toContain("read-only git checkout of the repository at main");
    expect(prompt).toContain("Your final message is your report");
    expect(getFinishedSpans().some((x) => x.name === "agent.claude_code" && x.attributes["agent.report"] === true)).toBe(true);
  });

  test("redaction: a leaking agent never puts the key into trace, events, commit or errors", async () => {
    const s = await setup("[leak] do it");
    const events: any[] = [];
    const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY, onEvent: (e) => events.push(e) });
    expect(traceText()).not.toContain(KEY);
    expect(traceText()).toContain(REDACTED);
    expect(JSON.stringify(events)).not.toContain(KEY);
    const msg = await new Git(s.r.bare).ok(["log", "-1", "--format=%B", res.sha]);
    expect(msg).not.toContain(KEY);
    expect(msg).toContain(REDACTED);

    const f = await setup("[leak] [fail] boom");
    const err = await runClaudeCode(f.provider, f.id, f.task, f.cfg, { apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("failed");
    expect(err.message).not.toContain(KEY);
    expect(err.message).toContain(REDACTED);
    expect(traceText()).not.toContain(KEY);
  });

  test("idempotent: same epoch after a crash post-push reuses the pushed commit without rerunning claude", async () => {
    const s = await setup("make it pass");
    const first = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    const before = s.log.filter((l) => l.envKeys.includes("ANTHROPIC_API_KEY")).length;
    const again = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(again).toMatchObject({ already: true, sha: first.sha });
    expect(s.log.filter((l) => l.envKeys.includes("ANTHROPIC_API_KEY")).length).toBe(before);
    // A new epoch (rework) does run the agent again from the latest target.
    const rework = await runClaudeCode(s.provider, s.id, { ...s.task, epoch: 2, rework: true }, s.cfg, { apiKey: KEY });
    expect(rework.already).toBe(false);
    expect(rework.sha).not.toBe(first.sha);
  });

  test("limits a profile sets reach the CLI: --max-turns, --max-budget-usd and the timeout wrapper", async () => {
    const s = await setup("make the failing test pass", { CAPCOMD_AGENT_MAX_TURNS: "30", CAPCOMD_AGENT_MAX_BUDGET_USD: "2", CAPCOMD_AGENT_TIMEOUT_MS: "60000" });
    await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    const argv = readFileSync(join(s.W, "argv.txt"), "utf8").split("\n");
    expect(argv[argv.indexOf("--max-turns") + 1]).toBe("30");
    expect(argv[argv.indexOf("--max-budget-usd") + 1]).toBe("2");
    expect(readFileSync(join(s.W, "run.sh"), "utf8")).toContain("timeout -k 10 60 ");
  });

  test("an agent whose CLI goes silent is stopped as idle, and keeps its work", async () => {
    const s = await setup("[wip] long job", { CAPCOMD_AGENT_IDLE_MS: "1500" });
    const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(res.limit).toBe("idle");
    const msg = (await new Git(s.r.bare).run(["log", "-1", "--format=%B", s.task.branch])).stdout;
    expect(msg).toContain("Capcomd-Stop: idle");
    expect(await s.r.show(s.task.branch, "src/sum.ts")).toContain("a + b");
    expect(getFinishedSpans().find((x) => x.name === "agent.claude_code")!.events.map((e) => e.name)).toContain("agent.idle");
  }, 60_000);

  test("idle is silence, not total time: an agent that keeps producing events runs past the idle window", async () => {
    const s = await setup("[slow] steady work", { CAPCOMD_AGENT_IDLE_MS: "1000" });
    const renewals: number[] = [];
    const extend = s.provider.extendTtl.bind(s.provider);
    s.provider.extendTtl = async (id, seconds) => { renewals.push(seconds); return extend(id, seconds); };
    const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(res.limit).toBeUndefined();
    expect(res.stopReason).toBe("success");
    expect(renewals[0]).toBe(3600); // the VM's delete deadline is renewed while the agent runs
  }, 60_000);

  test("timeout kills the agent process group", async () => {
    const s = await setup("[sleep] hang", { CAPCOMD_AGENT_TIMEOUT_MS: "1500" });
    const t0 = Date.now();
    const err = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("limit"); // a limit with nothing changed: nothing to keep, not retried
    expect(err.message).toContain("timeout");
    expect(Date.now() - t0).toBeLessThan(40_000);
    const pid = Number(readFileSync(join(s.W, "agent.pid"), "utf8"));
    await Bun.sleep(1500);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBeNull();
  }, 60_000);

  test("a limit keeps the work: what the agent changed is pushed with a Capcomd-Stop trailer, and a replay reports the stop", async () => {
    const s = await setup("[wip] long job", { CAPCOMD_AGENT_TIMEOUT_MS: "1500" });
    const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(res.limit).toBe("timeout");
    expect(res.sha).toBeTruthy();
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBe(res.sha);
    const msg = (await new Git(s.r.bare).run(["log", "-1", "--format=%B", s.task.branch])).stdout;
    expect(msg).toStartWith("WIP (stopped: timeout) task-1:");
    expect(msg).toContain("Capcomd-Stop: timeout");
    expect(await s.r.show(s.task.branch, "src/sum.ts")).toContain("a + b");
    // A driver that crashed after this push runs the task again: it reuses the commit and still reports the stop.
    const again = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY });
    expect(again).toMatchObject({ already: true, sha: res.sha, limit: "timeout" });
  }, 60_000);

  test("cancel path: isCancelled stops the agent, nothing is pushed", async () => {
    const s = await setup("[sleep] hang");
    let polls = 0;
    const err = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY, isCancelled: async () => ++polls >= 3 }).catch((e) => e);
    expect(err.kind).toBe("cancelled");
    const pid = Number(readFileSync(join(s.W, "agent.pid"), "utf8"));
    await Bun.sleep(1500);
    expect(existsSync(`/proc/${pid}`)).toBe(false);
    expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBeNull();
    expect(getFinishedSpans().find((x) => x.name === "agent.claude_code")!.events.map((e) => e.name)).toContain("agent.cancelled");
  }, 30_000);

  test("no changes and agent errors are typed failures", async () => {
    const n = await setup("[nochange] look around");
    expect((await runClaudeCode(n.provider, n.id, n.task, n.cfg, { apiKey: KEY }).catch((e) => e)).kind).toBe("no_changes");
    const f = await setup("[fail] boom");
    expect((await runClaudeCode(f.provider, f.id, f.task, f.cfg, { apiKey: KEY }).catch((e) => e)).kind).toBe("failed");
  });
});

describe("agent config, redaction, credentials, egress", () => {
  test("CAPCOMD_AGENT selects claude-code; default stays fake", () => {
    expect(agentFromEnv({})).toBe("fake");
    expect(agentFromEnv({ CAPCOMD_AGENT: "claude-code" })).toBe("claude-code");
    expect(() => agentFromEnv({ CAPCOMD_AGENT: "gpt" })).toThrow();
    const c = loadAgentConfig({});
    expect(c.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(c.maxTurns).toBeUndefined(); // limits are optional: none unless set
    expect(c.maxBudgetUsd).toBeUndefined();
    expect(loadAgentConfig({ CAPCOMD_AGENT_MAX_TURNS: "12" }).maxTurns).toBe(12);
    expect(() => loadAgentConfig({ CAPCOMD_AGENT_MAX_BUDGET_USD: "-1" })).toThrow();
  });

  test("egress allowlist is exactly GitHub, Anthropic API and the bootstrap registries", () => {
    expect([...AGENT_EGRESS].sort()).toEqual(["api.anthropic.com", "github.com", "nodejs.org", "registry.npmjs.org"]);
    expect(installScript(loadAgentConfig({}), "/h")).toContain(`@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}`);
    expect(installScript(loadAgentConfig({}), "/h")).not.toMatch(/https?:\/\/(?!nodejs\.org)/);
  });

  test("Redactor masks known values and token shapes, deep in objects", () => {
    const r = new Redactor(["supersecretvalue"]);
    expect(r.text("a supersecretvalue b")).toBe(`a ${REDACTED} b`);
    expect(r.text(`key ${KEY}`)).toBe(`key ${REDACTED}`);
    expect(r.text("ghp_abcdefghijklmnopqrstuvwxyz0123")).toBe(REDACTED);
    expect(r.text("https://x-access-token:abc123@github.com/o/r")).toBe(`https://x-access-token:${REDACTED}@github.com/o/r`);
    expect(r.value({ a: [{ b: "supersecretvalue" }], apiKey: "whatever" })).toEqual({ a: [{ b: REDACTED }], apiKey: REDACTED });
    expect(parseStreamLine('{"type":"assistant","message":{"content":[{"type":"text","text":"x supersecretvalue"}]}}', r)!.text).toBe(`x ${REDACTED}`);
    expect(parseStreamLine('{"type":"assist', r)).toBeNull();
  });

  test("prompt carries the goal and rules, never secrets", () => {
    const p = buildPrompt({ runId: "r", taskId: "t", epoch: 1, branch: "b", target: "main", repoUrl: "u", goal: "make the failing test pass", conflictFiles: ["a.ts"] });
    expect(p).toContain("make the failing test pass");
    expect(p).toContain("a.ts");
    expect(p).toContain("Do not commit, push");
  });

  test("git credential hook: token only in the env of network git execs, via an inline helper", async () => {
    const hook = githubGitCredentials(async () => "ghs_shortlived0123456789abcdef");
    const env = await hook({ vmId: "v", labels: {}, cmd: ["git", "push", "origin", "HEAD:refs/heads/x"] });
    expect(env!.CAPCOMD_GIT_TOKEN).toBe("ghs_shortlived0123456789abcdef");
    expect(env!.GIT_CONFIG_VALUE_1).not.toContain("ghs_");
    expect(env!.GIT_CONFIG_VALUE_1).toContain("$CAPCOMD_GIT_TOKEN");
    expect(await hook({ vmId: "v", labels: {}, cmd: ["git", "commit", "-m", "x"] })).toBeNull();
  });
});
