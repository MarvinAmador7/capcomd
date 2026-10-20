// boxd host-bound secrets: the VM env holds only a bxds_ placeholder; the real key never enters the VM.
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runAgent, AgentError } from "../../src/agents/runner";
import { claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import type { AgentAdapter } from "../../src/agents/types";
import { loadAgentConfig, agentEgress } from "../../src/agents/config";
import { secretsSync } from "../../src/env/secrets";
import { taskBranch } from "../../src/merge/config";

const ANTH = "sk-ant-api03-REALKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const OPENAI = "sk-proj-REALKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const BIN: Record<string, string> = { "claude-code": new URL("./fake-claude.sh", import.meta.url).pathname, codex: new URL("./fake-codex.sh", import.meta.url).pathname };

async function setup(a: AgentAdapter, over: Record<string, string> = {}, sync = true) {
  const r = await bareRepo();
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-sec-"));
  const log: Array<{ cmd: string[]; envKeys: string[]; env?: Record<string, string> }> = [];
  const provider = new FakeProvider({ hostExec: true, log });
  if (sync) await secretsSync(provider, { ANTHROPIC_API_KEY: ANTH, OPENAI_API_KEY: OPENAI });
  const { id } = await provider.ensure({ idemKey: `s-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: agentEgress(a.kind), labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = loadAgentConfig({ CAPCOMD_AGENT: a.kind, CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: BIN[a.kind]!, CAPCOMD_AGENT_POLL_MS: "50", ...over });
  const task = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
  return { provider, id, cfg, task, log, W: join(workdir, "task-1-e1") };
}

describe("host-bound secrets", () => {
  test("secrets sync: both keys, private scope, bound to their API host; result carries no values", async () => {
    const p = new FakeProvider();
    const lines = await secretsSync(p, { ANTHROPIC_API_KEY: ANTH, OPENAI_API_KEY: OPENAI });
    expect(lines.map((l) => [l.name, l.status, l.domains])).toEqual([
      ["ANTHROPIC_API_KEY", "set", ["api.anthropic.com"]],
      ["OPENAI_API_KEY", "set", ["api.openai.com"]],
    ]);
    expect(await p.secretList()).toEqual([
      { name: "ANTHROPIC_API_KEY", scope: "private", domains: ["api.anthropic.com"] },
      { name: "OPENAI_API_KEY", scope: "private", domains: ["api.openai.com"] },
    ]);
    expect(JSON.stringify(lines)).not.toContain("REALKEY");
    const partial = await secretsSync(new FakeProvider(), { ANTHROPIC_API_KEY: ANTH });
    expect(partial.find((l) => l.name === "OPENAI_API_KEY")!.status).toBe("skipped");
  });

  for (const a of [claudeAdapter, codexAdapter]) {
    test(`${a.kind}: the agent sees the bxds_ placeholder, never the real key, even when the key is set locally`, async () => {
      const real = a.kind === "codex" ? OPENAI : ANTH;
      const s = await setup(a);
      // Real key also present locally: the placeholder must still win.
      const res = await runAgent(a, s.provider, s.id, s.task, s.cfg, { apiKey: real });
      expect(res.credentialMode).toBe("secret");
      const seen = readFileSync(join(s.W, "keyseen.txt"), "utf8");
      expect(seen).toStartWith("bxds_");
      expect(seen).toBe(s.provider.machineEnv()[a.secretName]!);
      expect(seen).not.toContain(real);
      // No exec into the VM ever carried the real value.
      expect(JSON.stringify(s.log)).not.toContain(real);
    }, 30_000);
  }

  test("fallback: no secret → env injection; CAPCOMD_CREDENTIALS=secret refuses instead", async () => {
    const s = await setup(claudeAdapter, {}, false);
    const res = await runAgent(claudeAdapter, s.provider, s.id, s.task, s.cfg, { apiKey: ANTH });
    expect(res.credentialMode).toBe("env");
    expect(readFileSync(join(s.W, "keyseen.txt"), "utf8")).toBe(ANTH);
    const strict = await setup(claudeAdapter, { CAPCOMD_CREDENTIALS: "secret" }, false);
    const err = await runAgent(claudeAdapter, strict.provider, strict.id, strict.task, strict.cfg, { apiKey: ANTH }).catch((e) => e);
    expect(err).toBeInstanceOf(AgentError);
    expect(err.kind).toBe("credentials");
    const none = await setup(codexAdapter, {}, false);
    expect((await runAgent(codexAdapter, none.provider, none.id, none.task, none.cfg, {}).catch((e) => e)).kind).toBe("credentials");
  }, 30_000);
});
