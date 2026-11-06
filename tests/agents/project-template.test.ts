// An agent on a project template (src/env/templates.ts), on the fake sandbox: its VM boots from the template (here, a
// copy of what the template build left), the host sends it only what changed since (a delta bundle), and it works in
// the template in place; without a template, or with one it can't use, it clones the whole repository (the full
// bundle) and the worker is told to rebuild. FakeProvider runs each "VM" on this host, in its own directory.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { randomBytes } from "crypto";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { activeAdapters } from "../../src/agents/adapters";
import { agentHome, templateDir } from "../../src/agents/runner";
import { taskBranch } from "../../src/merge/config";
import { buildProjectTemplate, rebuildReason } from "../../src/env/templates";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const KNOBS = ["CAPCOMD_SANDBOX", "CAPCOMD_TEMPLATE_LEDGER", "CAPCOMD_TEMPLATE_REBUILD_MB"];
let saved: Record<string, string | undefined> = {};
let state: string;
beforeEach(() => {
  saved = Object.fromEntries(KNOBS.map((k) => [k, process.env[k]]));
  state = mkdtempSync(join(tmpdir(), "capcomd-tpl-agent-"));
  process.env.CAPCOMD_SANDBOX = "boxd";
  process.env.CAPCOMD_TEMPLATE_LEDGER = join(state, "templates.json");
});
afterEach(() => { for (const k of KNOBS) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });

type Repo = Awaited<ReturnType<typeof bareRepo>>;
type Ws = { path: "in_place" | "clone"; reason?: string; bytes: number };

/** A project with some history (so the full bundle is clearly bigger than a delta) and a lockfile. */
async function project(): Promise<Repo> {
  const r = await bareRepo();
  writeFileSync(join(r.root, "seed", "history.bin"), randomBytes(200 * 1024));
  await r.seed.ok(["add", "history.bin"]);
  await r.seed.ok(["commit", "-q", "-m", "history"]);
  await r.seed.ok(["push", "-q", "origin", "main"]);
  await r.pushToMain("package-lock.json", '{"lockfileVersion":3}\n', "lockfile");
  return r;
}

/** The template build, in its own "VM" directory; answers that directory's template. */
async function buildTemplate(r: Repo, hostGit: { workdir: string }) {
  const p = new FakeProvider({ hostExec: true });
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-tpl-build-"));
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_CREDENTIALS: "auto", CAPCOMD_AGENT: "fake" });
  const bin = join(agentHome(cfg), "npm", "bin");
  mkdirSync(bin, { recursive: true });
  for (const a of activeAdapters()) { writeFileSync(join(bin, a.bin), `#!/bin/sh\necho "${a.bin} 9.9.9"\n`); chmodSync(join(bin, a.bin), 0o755); }
  // A setup step that warms dependencies without touching the tracked tree.
  await buildProjectTemplate({ provider: p, repo: r.bare, cfg, hostGit, setup: "mkdir -p node_modules/left-pad && echo 'module.exports = 1' > node_modules/left-pad/index.js" });
  return templateDir(cfg);
}

/** An agent's VM: booted from the template (a copy of it at the runner's template path) or from nothing. */
async function agentVm(template: string | null) {
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-tpl-vm-"));
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" });
  if (template) cpSync(template, templateDir(cfg), { recursive: true });
  const provider = new FakeProvider({ hostExec: true });
  const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  return { provider, id, cfg };
}

async function runOn(r: Repo, hostGit: { workdir: string }, template: string | null, n: number, on?: Awaited<ReturnType<typeof agentVm>>) {
  const vm = on ?? await agentVm(template);
  const seen: Ws[] = [];
  const t = { runId: "r1", taskId: `task-${n}`, epoch: 1, branch: taskBranch("r1", `task-${n}`), target: "main", repoUrl: r.bare, goal: "make the failing test pass" };
  const res = await runClaudeCode(vm.provider, vm.id, t, vm.cfg, { apiKey: KEY, warmTemplate: "vm", hostGit, onWorkspace: (w) => seen.push(w) });
  expect(await r.sha(`refs/heads/${t.branch}`)).toBe(res.sha);
  return seen[0]!;
}

describe("agents on a project template", () => {
  test("template plus delta vs the full bundle, and a rebuild past the threshold", async () => {
    const r = await project();
    const hostGit = { workdir: join(state, "host-git") };
    const tpl = await buildTemplate(r, hostGit);

    // No template: a clone, the whole repository.
    const full = await runOn(r, hostGit, null, 1);
    expect(full.path).toBe("clone");
    expect(full.reason).toContain("no warm template");
    expect(full.bytes).toBeGreaterThan(200 * 1024);
    expect(rebuildReason(full)).toContain("couldn't use it");

    // On the template: in place, and only the delta. Workers 1 and 2 get the same small delta (the branch pushed
    // by the first agent above is new since the build).
    const w1 = await runOn(r, hostGit, tpl, 2);
    const w2 = await runOn(r, hostGit, tpl, 3);
    for (const w of [w1, w2]) { expect(w.path).toBe("in_place"); expect(w.bytes).toBeLessThan(full.bytes / 10); expect(rebuildReason(w)).toBeNull(); }

    // About 5 KB of new commits on main: still a small delta. 300 KB with a 0.25 MB threshold: rebuild.
    await r.pushToMain("small.txt", "s".repeat(5 * 1024));
    const small = await runOn(r, hostGit, tpl, 4);
    expect(small.path).toBe("in_place");
    expect(small.bytes).toBeLessThan(full.bytes / 4);
    process.env.CAPCOMD_TEMPLATE_REBUILD_MB = "0.25";
    writeFileSync(join(r.root, "seed", "big.bin"), randomBytes(300 * 1024));
    await r.seed.ok(["add", "big.bin"]);
    await r.seed.ok(["commit", "-q", "-m", "big"]);
    await r.seed.ok(["push", "-q", "origin", "HEAD:main"]);
    const big = await runOn(r, hostGit, tpl, 5);
    expect(big.path).toBe("in_place");
    expect(big.bytes).toBeGreaterThan(0.25 * 1024 ** 2);
    expect(rebuildReason(big)).toMatch(/^an agent's delta was 0\.\d MB, over 0 MB$/);
  }, 120_000);

  test("a template it can't use in place (the lockfile changed): a clone that borrows its objects, and a rebuild", async () => {
    const r = await project();
    const hostGit = { workdir: join(state, "host-git") };
    const tpl = await buildTemplate(r, hostGit);
    await r.pushToMain("package-lock.json", '{"lockfileVersion":3,"packages":{}}\n', "lockfile bump");
    const w = await runOn(r, hostGit, tpl, 1);
    expect(w.path).toBe("clone");
    expect(w.reason).toContain("lockfile changed");
    // Only what the template lacks: the lockfile commit, not the 200 KB of history.
    expect(w.bytes).toBeLessThan(50 * 1024);
    expect(rebuildReason(w)).toContain("couldn't use it (the lockfile changed");
  }, 120_000);

  test("a retry in the same VM (the template already used): a clone that borrows its objects, no rebuild", async () => {
    const r = await project();
    const hostGit = { workdir: join(state, "host-git") };
    const tpl = await buildTemplate(r, hostGit);
    const vm = await agentVm(tpl);
    expect((await runOn(r, hostGit, tpl, 1, vm)).path).toBe("in_place");
    const again = await runOn(r, hostGit, tpl, 2, vm);
    expect(again.path).toBe("clone");
    expect(again.reason).toContain("used by an earlier run");
    expect(again.bytes).toBeLessThan(50 * 1024);
    expect(rebuildReason(again)).toBeNull();
  }, 120_000);
});
