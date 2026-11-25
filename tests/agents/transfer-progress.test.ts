// A big repository's clone is never silent (the 2026-11-05 boxd measurement: 20+ minutes uploading a 478 MB bundle,
// with nothing in the agent's log): the runner puts the transfer's progress in the agent's log (`capcomd logs`) and in
// engine.log while the host uploads the bundle a chunk at a time. FakeProvider runs the "sandbox" on this host.
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "crypto";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { taskBranch } from "../../src/merge/config";
import type { SetupState } from "../../src/agents/activity";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const KNOBS = ["CAPCOMD_TRANSFER_CHUNK_BYTES", "CAPCOMD_TRANSFER_PROGRESS_SECONDS"];
let saved: Record<string, string | undefined> = {};
beforeEach(() => { saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]])); });
afterEach(() => { for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

describe("transfer progress in the agent's log", () => {
  test("a clone bigger than a chunk reports its upload in the agent's log and engine.log", async () => {
    process.env.CAPCOMD_TRANSFER_CHUNK_BYTES = String(64 * 1024);
    process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS = "0";
    const r = await bareRepo();
    writeFileSync(join(r.root, "seed", "big.bin"), randomBytes(320 * 1024));
    await r.seed.ok(["add", "big.bin"]);
    await r.seed.ok(["commit", "-q", "-m", "big"]);
    await r.seed.ok(["push", "-q", "origin", "main"]);
    const workdir = mkdtempSync(join(tmpdir(), "capcomd-progress-"));
    const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" });
    const provider = new FakeProvider({ hostExec: true });
    const { id } = await provider.ensure({ idemKey: `p-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
    await provider.waitReady(id, 1000);
    const logs: string[] = [];
    const engineLines: string[] = [];
    const engine = spyOn(console, "error").mockImplementation((...a: unknown[]) => { engineLines.push(String(a[0])); });
    try {
      const t = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
      const res = await runClaudeCode(provider, id, t, cfg, { apiKey: KEY, onLog: (l) => logs.push(...l) });
      expect(await r.sha(`refs/heads/${t.branch}`)).toBe(res.sha);
    } finally { engine.mockRestore(); }
    const clone = logs.filter((l) => l.startsWith("[capcomd] git clone: "));
    expect(clone.some((l) => /^\[capcomd\] git clone: uploading [\d.]+ MB of [\d.]+ MB \(\d+%\) to the sandbox, \d+s at [\d.]+ MB\/s$/.test(l))).toBe(true);
    expect(clone.some((l) => /^\[capcomd\] git clone: uploaded [\d.]+ MB to the sandbox in \d+s/.test(l))).toBe(true);
    expect(engineLines.some((l) => l.startsWith("[agent] task-1: git clone: uploaded "))).toBe(true);
  }, 60_000);

  test("getting it ready is reported as setup phases (Agent.activity kind setup): the copy's bytes as each chunk goes, ending with its CLI starting", async () => {
    process.env.CAPCOMD_TRANSFER_CHUNK_BYTES = String(64 * 1024);
    delete process.env.CAPCOMD_TRANSFER_PROGRESS_SECONDS; // the log's throttle (15 s) doesn't hold the setup's progress back
    const r = await bareRepo();
    writeFileSync(join(r.root, "seed", "big.bin"), randomBytes(320 * 1024));
    await r.seed.ok(["add", "big.bin"]);
    await r.seed.ok(["commit", "-q", "-m", "big"]);
    await r.seed.ok(["push", "-q", "origin", "main"]);
    const workdir = mkdtempSync(join(tmpdir(), "capcomd-setup-"));
    const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" });
    const provider = new FakeProvider({ hostExec: true });
    const { id } = await provider.ensure({ idemKey: `p-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
    await provider.waitReady(id, 1000);
    const phases: SetupState[] = [];
    let firstEventAfter = -1;
    const engine = spyOn(console, "error").mockImplementation(() => {});
    try {
      const t = { runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
      await runClaudeCode(provider, id, t, cfg, { apiKey: KEY, onSetup: (s) => phases.push(s), onEvent: () => { if (firstEventAfter < 0) firstEventAfter = phases.length; } });
    } finally { engine.mockRestore(); }
    // One line per phase change (the progress collapsed): workspace, the copy, the rest of the workspace, its CLI.
    const order = phases.map((p) => p.phase).filter((p, i, a) => p !== a[i - 1]);
    expect(order.filter((p) => p !== "fetch")).toEqual(["workspace", "copy", "workspace", "agent"]);
    const copies = phases.filter((p) => p.phase === "copy");
    expect(copies[0]).toMatchObject({ bytes: 0 });
    expect(copies.length).toBeGreaterThan(3); // a chunk at a time
    const total = copies[0]!.total!;
    expect(total).toBeGreaterThan(320 * 1024);
    expect(copies.every((c) => c.total === total)).toBe(true);
    expect(copies.at(-1)!.bytes).toBe(total);
    for (let i = 1; i < copies.length; i++) expect(copies[i]!.bytes!).toBeGreaterThanOrEqual(copies[i - 1]!.bytes!);
    // Every phase was reported before the CLI's first event.
    expect(firstEventAfter).toBe(phases.length);
  }, 60_000);
});
