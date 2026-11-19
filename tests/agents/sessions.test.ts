// ADR-026 §2 and §5 path 3, end to end with the fake CLIs on this host (fake-host's FakeProvider): an agent's CLI session
// is saved as it runs (redacted, compressed, on the host), put back on a fresh machine at another path, and the next
// attempt continues it (`--resume <id>`, codex's `exec … resume <id>`); a session the CLI can't find fails as
// SessionMissingError.
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { agentHome, runAgent, SessionMissingError } from "../../src/agents/runner";
import { claudeAdapter, codexAdapter } from "../../src/agents/adapters";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { taskBranch } from "../../src/merge/config";
import { hostSessionStore } from "../../src/sessions/host";
import { latestSession, readSession, replicaIdle, useSessionStores } from "../../src/sessions/store";
import { restoreSession } from "../../src/sessions/restore";
import { icloudDriveStore } from "../../src/sessions/icloud-drive";
import { claudeProjectSlug } from "../../src/plugins/agent-claude";
import { codexRolloutDay } from "../../src/plugins/agent-codex";
import { REDACTED } from "../../src/agents/redact";

setDefaultTimeout(60_000);
const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const FAKE_CODEX = new URL("./fake-codex.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-SESSIONKEY-0123456789abcdefghijklmnopqrstuvwxyz";
afterEach(() => useSessionStores(null));
const made: string[] = [];
const tmp = (prefix: string) => { const d = mkdtempSync(join(tmpdir(), prefix)); made.push(d); return d; };
afterAll(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

/** A machine of its own (its own work folder, so its own home and checkout paths). */
async function machine(kind: "claude" | "codex") {
  const workdir = tmp(`capcomd-sess-${kind}-`);
  const provider = new FakeProvider({ hostExec: true });
  const { id } = await provider.ensure({ idemKey: `s-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  const cfg = kind === "claude"
    ? loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" })
    : loadAgentConfig({ CAPCOMD_AGENT: "codex", CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_BIN: FAKE_CODEX, CAPCOMD_AGENT_POLL_MS: "50", CAPCOMD_CREDENTIALS: "env" });
  return { workdir, provider, id, cfg, home: agentHome(cfg) };
}

function stores() {
  const dir = tmp("capcomd-sess-store-");
  const primary = hostSessionStore(join(dir, "sessions"));
  const replica = icloudDriveStore({ root: join(dir, "drive"), keyFile: join(dir, "replica.key") });
  useSessionStores({ primary, replica });
  return { dir, primary, replica };
}

describe("durable sessions (fake CLIs, fake-host)", () => {
  test("Claude Code: saved as it runs (redacted, with its folder), restored on a fresh machine at another path, continued", async () => {
    const { dir } = stores();
    const r = await bareRepo();
    const a = await machine("claude");
    const task = { runId: "run-sess1", agentId: "agt-sess1", taskId: "task-1", epoch: 1, branch: taskBranch("run-sess1", "task-1"), target: "main", repoUrl: r.bare, goal: "fix it [session-folder] [session-secret]" };
    const res = await runAgent(claudeAdapter, a.provider, a.id, task, a.cfg, { apiKey: KEY });
    expect(res.stopReason).toBe("success");
    const argv = readFileSync(join(a.workdir, "task-1-e1", "argv.txt"), "utf8").split("\n");
    const sid = argv[argv.indexOf("--session-id") + 1]!;
    expect(sid).toMatch(/^[0-9a-f-]{36}$/);

    // Saved on the host under the run and agent, gzipped, 0600, the key and a credential-named field redacted.
    const ref = await latestSession("run-sess1", "agt-sess1");
    expect(ref).toMatchObject({ cli: "claude", sessionId: sid, file: `${sid}.jsonl` });
    const host = join(dir, "sessions", "run-sess1", "agt-sess1");
    expect(statSync(join(host, "ref.json")).mode & 0o777).toBe(0o600);
    expect(statSync(host).mode & 0o777).toBe(0o700);
    const saved = (await readSession("run-sess1", "agt-sess1"))!;
    const text = new TextDecoder().decode(saved.file);
    expect(ref!.bytes).toBe(saved.file.length);
    expect(text).toContain("fix it [session-folder]");
    expect(text).toContain("fixed sum");
    expect(text).not.toContain(KEY);
    expect(text).toContain(`the key is ${REDACTED}`);
    expect(text).not.toContain("plain-token-value");
    expect(saved.folder.map((f) => f.path)).toEqual(["subagents/agent-a1.jsonl"]);
    // The VM's own file kept the secret (the agent read it); only the saved copy is redacted.
    const vmFile = join(a.home, ".claude", "projects", claudeProjectSlug(join(a.workdir, "task-1-e1", "repo")), `${sid}.jsonl`);
    expect(readFileSync(vmFile, "utf8")).toContain(KEY);
    // And the replica got everything, sealed.
    await replicaIdle();
    expect(existsSync(join(dir, "drive", "run-sess1", "agt-sess1", "ref.json.ccs"))).toBe(true);

    // A fresh machine, another work folder: restored where Claude Code looks for it from the new checkout.
    const b = await machine("claude");
    const cwd = join(b.workdir, "task-1-e2", "repo");
    const back = await restoreSession({ runId: "run-sess1", agentId: "agt-sess1", provider: b.provider, machineId: b.id, home: b.home, cwd });
    expect(back).toEqual({ sessionId: sid, cli: "claude" });
    const placed = join(b.home, ".claude", "projects", claudeProjectSlug(cwd), `${sid}.jsonl`);
    expect(readFileSync(placed, "utf8")).toBe(text);
    expect(existsSync(join(b.home, ".claude", "projects", claudeProjectSlug(cwd), sid, "subagents", "agent-a1.jsonl"))).toBe(true);

    // The next attempt continues it: --resume, the history there, and what it adds saved after what was.
    const res2 = await runAgent(claudeAdapter, b.provider, b.id, { ...task, epoch: 2, goal: "carry on", resumeSession: sid }, b.cfg, { apiKey: KEY });
    expect(res2.stopReason).toBe("success");
    const argv2 = readFileSync(join(b.workdir, "task-1-e2", "argv.txt"), "utf8").split("\n");
    expect(argv2[argv2.indexOf("--resume") + 1]).toBe(sid);
    expect(argv2).not.toContain("--session-id");
    const resumed = readFileSync(join(b.workdir, "task-1-e2", "resumed.txt"), "utf8");
    expect(resumed).toContain(`lines=${text.split("\n").filter(Boolean).length}`);
    expect(resumed).toContain("fix it [session-folder]");
    const after = (await readSession("run-sess1", "agt-sess1"))!;
    expect(after.ref.segments).toBeGreaterThan(saved.ref.segments);
    const all = new TextDecoder().decode(after.file);
    expect(all.startsWith(text)).toBe(true);
    expect(all.slice(text.length)).toContain("carry on");
    // The folder saved at the first run is still part of the record.
    expect(after.folder.map((f) => f.path)).toEqual(["subagents/agent-a1.jsonl"]);
  });

  test("Claude Code: a session it can't find fails as SessionMissingError (the caller starts a fresh one)", async () => {
    stores();
    const r = await bareRepo();
    const a = await machine("claude");
    const task = { runId: "run-sess2", agentId: "agt-sess2", taskId: "task-1", epoch: 2, branch: taskBranch("run-sess2", "task-1"), target: "main", repoUrl: r.bare, goal: "carry on", resumeSession: "00000000-0000-4000-8000-000000000000" };
    const err = await runAgent(claudeAdapter, a.provider, a.id, task, a.cfg, { apiKey: KEY }).catch((e) => e);
    expect(err).toBeInstanceOf(SessionMissingError);
    expect(err.kind).toBe("failed");
    expect(err.sessionId).toBe("00000000-0000-4000-8000-000000000000");
    // And nothing to restore for an agent that saved none.
    expect(await restoreSession({ runId: "run-sess2", agentId: "agt-sess2", provider: a.provider, machineId: a.id, home: a.home, cwd: "/nowhere" })).toBeNull();
  });

  test("codex: not --ephemeral; its own id read from thread.started; the rollout restored under its name and resumed", async () => {
    stores();
    const r = await bareRepo();
    const a = await machine("codex");
    const task = { runId: "run-sess3", agentId: "agt-sess3", taskId: "task-1", epoch: 1, branch: taskBranch("run-sess3", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
    await runAgent(codexAdapter, a.provider, a.id, task, a.cfg, { apiKey: "sk-proj-SESSIONKEY-0123456789abcdefghijklmnop" });
    const ref = (await latestSession("run-sess3", "agt-sess3"))!;
    expect(ref.cli).toBe("codex");
    expect(ref.sessionId).toMatch(/^th-/);
    expect(ref.file).toMatch(new RegExp(`^rollout-\\d{4}-\\d{2}-\\d{2}T[\\d-]+-${ref.sessionId}\\.jsonl$`));

    const b = await machine("codex");
    const back = await restoreSession({ runId: "run-sess3", agentId: "agt-sess3", provider: b.provider, machineId: b.id, home: b.home, cwd: join(b.workdir, "task-1-e2", "repo") });
    expect(back).toEqual({ sessionId: ref.sessionId, cli: "codex" });
    expect(existsSync(join(b.home, ".codex", "sessions", codexRolloutDay(ref.file), ref.file))).toBe(true);

    await runAgent(codexAdapter, b.provider, b.id, { ...task, epoch: 2, goal: "carry on", resumeSession: ref.sessionId }, b.cfg, { apiKey: "sk-proj-SESSIONKEY-0123456789abcdefghijklmnop" });
    const argv = readFileSync(join(b.workdir, "task-1-e2", "argv.txt"), "utf8").split("\n");
    expect(argv[argv.indexOf("resume") + 1]).toBe(ref.sessionId);
    expect(argv[argv.indexOf("resume") + 2]).toStartWith("You are working");
    expect(argv.join("\n")).toContain("Task: carry on");
    expect(readFileSync(join(b.workdir, "task-1-e2", "resumed.txt"), "utf8")).toContain("lines=3");
    const all = new TextDecoder().decode((await readSession("run-sess3", "agt-sess3"))!.file);
    expect(all).toContain("make the failing test pass");
    expect(all).toContain("carry on");
  });

  test("an agent without an id (a test's, a driver's own) and a reviewer keep no session: no session flags", async () => {
    stores();
    const r = await bareRepo();
    const a = await machine("claude");
    const task = { runId: "run-sess4", taskId: "task-1", epoch: 1, branch: taskBranch("run-sess4", "task-1"), target: "main", repoUrl: r.bare, goal: "fix it" };
    await runAgent(claudeAdapter, a.provider, a.id, task, a.cfg, { apiKey: KEY });
    const argv = readFileSync(join(a.workdir, "task-1-e1", "argv.txt"), "utf8").split("\n");
    expect(argv).not.toContain("--session-id");
    expect(argv).not.toContain("--resume");
  });
});
