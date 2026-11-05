// Plugin API §16.1: an orchestrate agent (a planner, a lead) writes nothing. Its CLI's rules can be got past (codex: a
// shell redirection, `sh -c`), so the kernel looks at its checkout itself: changed files or new commits at the end of a
// turn (its CLI's result) or of its run end it, with the files named, for every provider (here Claude Code; codex in
// codex.test.ts). Nothing it wrote is committed or pushed, not even as a checkpoint.
import { beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { orchestrateWritesText } from "../../src/agents/runner";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";
import { taskBranch } from "../../src/merge/config";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";

async function setup(goal: string, over: Record<string, string> = {}) {
  const r = await bareRepo();
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-orch-writes-"));
  const provider = new FakeProvider({ hostExec: true });
  const { id } = await provider.ensure({ idemKey: `o-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = { ...loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50", ...over }), toolMode: "orchestrate" as const };
  const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal, agentId: "agt-lead1" };
  return { r, provider, id, cfg, task };
}
beforeEach(() => resetSpans());

test("a file written in a turn stops it at that turn's end; it fails naming the file; nothing is committed, pushed or checkpointed", async () => {
  // [linger]: the CLI stays up ~6 s after its result, as one open for a next turn. Checkpoints every 200 ms would
  // snapshot the edit for an execute agent.
  const s = await setup("[linger] route the work", { CAPCOMD_AGENT_CHECKPOINT_MS: "200" });
  const lines: string[] = [];
  const reports: any[] = [];
  const t0 = Date.now();
  const res = await runClaudeCode(s.provider, s.id, s.task, s.cfg, { apiKey: KEY, heartbeatMs: 100, onLog: (l) => lines.push(...l), onReport: (x) => reports.push(x) });
  expect(Date.now() - t0).toBeLessThan(5_500); // stopped at the turn's end, not when the CLI exited
  expect(res.orchestrateWrites).toEqual({ files: ["src/sum.ts"], total: 1, commits: 0, at: "turn" });
  expect(res).toMatchObject({ sha: "", stopReason: "orchestrate_wrote_files" });
  expect(lines).toContain("[capcomd] orchestrate: it changed src/sum.ts in a turn, so it was stopped there; an orchestrate agent writes nothing, so it fails (its changes are discarded, never committed or pushed)");
  expect(await s.r.sha(`refs/heads/${s.task.branch}`)).toBeNull();
  expect(await s.r.sha("refs/capcomd/checkpoints/agt-lead1")).toBeNull();
  expect(reports.filter((x) => x.type === "checkpoint")).toEqual([]);
  const span = getFinishedSpans().find((x) => x.name === "agent.claude_code")!;
  const ev = span.events.find((e) => e.name === "agent.orchestrate_discarded")!;
  expect(ev.attributes).toMatchObject({ "agent.discarded_files": 1, "agent.orchestrate_failed": true, "agent.orchestrate_at": "turn" });
}, 60_000);

test("a local commit counts too; an orchestrate agent that wrote nothing ends as it did", async () => {
  const c = await setup("[commit] route the work");
  const res = await runClaudeCode(c.provider, c.id, c.task, c.cfg, { apiKey: KEY });
  expect(res.orchestrateWrites).toMatchObject({ files: [], total: 0, commits: 1 });
  expect(await c.r.sha(`refs/heads/${c.task.branch}`)).toBeNull();

  const n = await setup("[nochange] route the work");
  const ok = await runClaudeCode(n.provider, n.id, n.task, n.cfg, { apiKey: KEY });
  expect(ok).toMatchObject({ sha: "", stopReason: "success" });
  expect(ok.orchestrateWrites).toBeUndefined();
}, 60_000);

test("what it wrote, in words", () => {
  expect(orchestrateWritesText({ files: ["notes.txt"], total: 1, commits: 0 })).toBe("changed notes.txt");
  expect(orchestrateWritesText({ files: [], total: 0, commits: 2 })).toBe("made 2 local commits");
  const many = Array.from({ length: 12 }, (_, i) => `f${i}`);
  expect(orchestrateWritesText({ files: many, total: 14, commits: 1 })).toBe(`changed ${many.slice(0, 10).join(", ")} and 4 more, and made 1 local commit`);
});
