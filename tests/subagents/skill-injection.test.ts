// ADR-017 skill injection: a (fake) Claude Code agent with the in-VM capcomd gets it, its MCP config and its skill;
// one without gets nothing. The rest of the sub-agents' unit tests are in tests/unit/subagents.test.ts.
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { orchestrationSkill, workerSkill } from "../../src/subagents/skill";
import { FakeProvider } from "../../src/providers/fake";

const CLI = new URL("../../src/subagents/vm-cli.mjs", import.meta.url).pathname;

test("skill injection: agents with the in-VM capcomd get it + MCP + their skill; others get nothing", async () => {
  const { bareRepo } = await import("../merge/gitfixture");
  const { runClaudeCode } = await import("../../src/agents/claude-code");
  const { loadAgentConfig } = await import("../../src/agents/config");
  const { taskBranch } = await import("../../src/merge/config");
  const FAKE = new URL("../agents/fake-claude.sh", import.meta.url).pathname;
  const run = async (withSkill: boolean, env: Record<string, string> = {}, o: { goal?: string; worker?: boolean } = {}) => {
    const worker = o.worker ? o : null;
    const r = await bareRepo();
    const workdir = mkdtempSync(join(tmpdir(), "capcomd-agent-"));
    const rpcDir = mkdtempSync(join(tmpdir(), "capcomd-rpcdir-"));
    const provider = new FakeProvider({ hostExec: true });
    const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: [], labels: {} });
    await provider.waitReady(id, 1000);
    const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE, CAPCOMD_AGENT_POLL_MS: "50", ...env });
    const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: o.goal ?? "make the failing test pass" };
    const skill = worker ? workerSkill({ mcp: true, jobs: true }) : orchestrationSkill({ agentId: "agt-p", limits: { allowSpawn: true, maxDepth: 1, maxChildren: 3, allowedChildProfiles: ["worker"], budgetShare: 0.5 }, budget: { turns: 40 }, mcp: true });
    const out = await runClaudeCode(provider, id, task, cfg, { apiKey: "sk-ant-x", ...(withSkill ? { subagents: { skill, cliSource: readFileSync(CLI, "utf8"), rpcDir, ...(worker ? { maySpawn: false } : {}) } } : {}) } as any).then((x) => x, (e: Error) => e);
    const W = join(workdir, "task-1-e1");
    return { argv: readFileSync(join(W, "argv.txt"), "utf8").split("\n"), W, rpcDir, out };
  };
  // A worker that may not spawn: its capcomd and its own lines; its work is its own, so ending with no change fails it
  // (an orchestrator's work is its children's: no change is fine), and its final message comes back with the push.
  const worker = await run(true, {}, { worker: true });
  expect(worker.argv).toContain("--mcp-config");
  expect(readFileSync(join(worker.W, "append-system.txt"), "utf8")).toContain("# Your capcomd");
  expect(readFileSync(join(worker.W, "append-system.txt"), "utf8")).not.toContain("# Orchestrating child agents (capcomd)");
  expect(existsSync(join(worker.rpcDir, "bin", "capcomd"))).toBe(true);
  expect(worker.out).toMatchObject({ resultText: "fixed sum" });
  expect((worker.out as { sha: string }).sha).toMatch(/^[0-9a-f]{40}$/);
  expect((await run(true, {}, { worker: true, goal: "fix it [nochange]" })).out).toMatchObject({ kind: "no_changes" });
  expect((await run(true, {}, { goal: "plan it [nochange]" })).out).toMatchObject({ sha: "", resultText: "fixed sum" });
  const yes = await run(true);
  expect(yes.argv).toContain("--mcp-config");
  expect(yes.argv[yes.argv.indexOf("--permission-mode") + 1]).toBe("bypassPermissions"); // every tool, capcomd's included
  // A profile with an allowlist gets capcomd's CLI and MCP tools added to it.
  const listed = await run(true, { CAPCOMD_AGENT_ALLOWED_TOOLS: "Read,Edit" });
  expect(listed.argv[listed.argv.indexOf("--allowedTools") + 1]).toBe("Read,Edit,Bash(capcomd:*),mcp__capcomd");
  expect(readFileSync(join(yes.W, "append-system.txt"), "utf8")).toContain("# Orchestrating child agents (capcomd)");
  expect(readFileSync(join(yes.W, "append-system.txt"), "utf8")).toContain("--children.maxChildren=0");
  expect(existsSync(join(yes.rpcDir, "bin", "capcomd"))).toBe(true);
  expect(JSON.parse(readFileSync(join(yes.W, "capcomd-mcp.json"), "utf8")).mcpServers.capcomd.args[1]).toBe("mcp");
  const no = await run(false);
  expect(no.argv).not.toContain("--mcp-config");
  expect(no.argv.join(" ")).not.toContain("capcomd:");
  expect(existsSync(join(no.W, "append-system.txt"))).toBe(false);
  expect(existsSync(join(no.rpcDir, "bin", "capcomd"))).toBe(false);
}, 60_000);

