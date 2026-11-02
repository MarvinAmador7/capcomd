// The runner's warm workspace (src/agents/workspace.ts): with a warm template in the sandbox (what `capcomd env build`
// bakes into a Docker image), the agent works in it in place, and its branch, commit and trailers are exactly what a
// fresh clone gives; when the template doesn't fit, the runner clones as before. A FakeProvider runs the "sandbox" on
// this host, one workdir per sandbox, with fixed git dates so the same work makes the same commit.
import { describe, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bareRepo } from "../merge/gitfixture";
import { FakeProvider } from "../../src/providers/fake";
import { runClaudeCode } from "../../src/agents/claude-code";
import { loadAgentConfig, AGENT_EGRESS } from "../../src/agents/config";
import { templateDir } from "../../src/agents/runner";
import { TEMPLATE_CLAIM, TEMPLATE_LOCKHASH, TEMPLATE_MARKER, type TemplateMarker } from "../../src/agents/workspace";
import { getFinishedSpans, resetSpans } from "../../src/utils/tracing-simple";
import { taskBranch } from "../../src/merge/config";
import { Git } from "../../src/merge/git";

const FAKE_CLAUDE = new URL("./fake-claude.sh", import.meta.url).pathname;
const KEY = "sk-ant-api03-TESTKEY-0123456789abcdefghijklmnopqrstuvwxyz";
const LOCK = '{"name":"widgets","lockfileVersion":3}\n';
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
// Fixed dates: the same tree, parent and message make the same commit on either path.
const DATES = { GIT_AUTHOR_DATE: "2026-11-01T12:00:00Z", GIT_COMMITTER_DATE: "2026-11-01T12:00:00Z" };

type Repo = Awaited<ReturnType<typeof bareRepo>>;
async function project(): Promise<Repo> {
  const r = await bareRepo();
  await r.pushToMain("package-lock.json", LOCK, "lockfile");
  return r;
}

/** One sandbox: its own workdir (the container's filesystem), optionally with a warm template as env build leaves it. */
async function sandbox(r: Repo, o: { warm?: boolean; marker?: Partial<TemplateMarker>; at?: string } = {}) {
  const workdir = mkdtempSync(join(tmpdir(), "capcomd-warm-"));
  const cfg = loadAgentConfig({ CAPCOMD_AGENT_WORKDIR: workdir, CAPCOMD_AGENT_CLAUDE_BIN: FAKE_CLAUDE, CAPCOMD_AGENT_POLL_MS: "50" });
  if (o.warm) {
    const T = templateDir(cfg);
    await new Git(workdir).ok(["clone", "-q", "--no-tags", "--branch", "main", r.bare, T]);
    const g = new Git(T);
    if (o.at) await g.ok(["reset", "-q", "--hard", o.at]);
    mkdirSync(join(T, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(T, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    writeFileSync(join(T, ".git", "info", "exclude"), "node_modules\n");
    const commit = (await g.ok(["rev-parse", "HEAD"])).trim();
    const marker: TemplateMarker = { schema: 1, repo: r.bare, target: "main", commit, lockFile: "package-lock.json", lockHash: sha256(LOCK), depsInstalled: true, ...o.marker };
    writeFileSync(join(T, TEMPLATE_LOCKHASH), marker.lockHash);
    writeFileSync(join(T, TEMPLATE_MARKER), JSON.stringify(marker));
  }
  const provider = new FakeProvider({ hostExec: true, vmEnv: DATES });
  const { id } = await provider.ensure({ idemKey: `t-${Math.random()}`, isolated: true, ttlSeconds: 60, egressAllow: AGENT_EGRESS, labels: {} });
  await provider.waitReady(id, 1000);
  return { workdir, cfg, provider, id, T: templateDir(cfg) };
}

const task = (r: Repo, over: Record<string, unknown> = {}) => ({ runId: "r1", taskId: "task-1", epoch: 1, branch: taskBranch("r1", "task-1"), target: "main", repoUrl: r.bare, goal: "make the failing test pass", ...over });
const workspaceOf = () => getFinishedSpans().filter((s) => s.name === "agent.claude_code").at(-1)?.events.find((e) => e.name === "agent.workspace")?.attributes ?? null;
const deleteBranch = (r: Repo, b: string) => new Git(r.bare).ok(["update-ref", "-d", `refs/heads/${b}`]);

describe("warm workspace", () => {
  test("in place: the same branch, commit and trailers as a fresh clone, no clone made, the template claimed", async () => {
    const r = await project();
    const t = task(r);
    // The clone path (no template), then the same task in a warm sandbox from the same remote state.
    const a = await sandbox(r);
    resetSpans();
    const viaClone = await runClaudeCode(a.provider, a.id, t, a.cfg, { apiKey: KEY, warmTemplate: true });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "clone" });
    expect(String(workspaceOf()!["agent.workspace_reason"])).toContain("no warm template");
    expect(existsSync(join(a.workdir, "task-1-e1", "repo", ".git"))).toBe(true);

    await deleteBranch(r, t.branch);
    const b = await sandbox(r, { warm: true });
    resetSpans();
    const logs: string[] = [];
    const inPlace = await runClaudeCode(b.provider, b.id, t, b.cfg, { apiKey: KEY, warmTemplate: true, onLog: (l) => logs.push(...l) });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "in_place" });
    expect(logs.some((l) => l.startsWith("[capcomd] workspace: the env image's warm checkout, in place"))).toBe(true);
    // Exactly the clone's commit: same tree, parent, message and trailers (dates are fixed).
    expect(inPlace.sha).toBe(viaClone.sha);
    expect(await r.sha(`refs/heads/${t.branch}`)).toBe(inPlace.sha);
    const msg = await new Git(r.bare).ok(["log", "-1", "--format=%B", inPlace.sha]);
    expect(msg).toContain("Capcomd-Task: r1/task-1");
    expect(msg).toContain("Capcomd-Epoch: 1");
    // node_modules stayed out of the commit; the template is the checkout, on the task branch; nothing was cloned.
    expect(await new Git(r.bare).ok(["ls-tree", "-r", "--name-only", inPlace.sha])).not.toContain("node_modules");
    expect(existsSync(join(b.workdir, "task-1-e1", "repo"))).toBe(false);
    const g = new Git(b.T);
    expect((await g.ok(["rev-parse", "--abbrev-ref", "HEAD"])).trim()).toBe(t.branch);
    // The local branches a clone has: the target at its tip (tracking origin) and the task branch.
    expect((await g.ok(["for-each-ref", "--format=%(refname:short)", "refs/heads/"])).trim().split("\n").sort()).toEqual([t.branch, "main"].sort());
    expect((await g.ok(["rev-parse", "main"])).trim()).toBe((await r.sha("refs/heads/main"))!);
    expect(existsSync(join(b.T, TEMPLATE_CLAIM))).toBe(true);
  }, 60_000);

  test("a template behind the target is fine (fetched, then branched from the tip); an existing branch and rework match the clone", async () => {
    const r = await project();
    const old = (await r.sha("refs/heads/main"))!;
    await r.pushToMain("later.txt", "after the image was built\n");
    const t = task(r);
    const b = await sandbox(r, { warm: true, at: old });
    resetSpans();
    const first = await runClaudeCode(b.provider, b.id, t, b.cfg, { apiKey: KEY, warmTemplate: true });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "in_place" });
    expect(await r.show(first.sha, "later.txt")).toContain("after the image was built");

    // The branch exists now: a second run (next epoch, a new sandbox) continues it, as a clone would.
    const t2 = { ...t, epoch: 2, resumed: true };
    const c = await sandbox(r, { warm: true });
    resetSpans();
    const second = await runClaudeCode(c.provider, c.id, t2, c.cfg, { apiKey: KEY, warmTemplate: true });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "in_place" });
    const d = await sandbox(r);
    const viaClone = await (async () => { await new Git(r.bare).ok(["update-ref", `refs/heads/${t.branch}`, first.sha]); return runClaudeCode(d.provider, d.id, t2, d.cfg, { apiKey: KEY }); })();
    expect(viaClone.sha).toBe(second.sha);

    // Rework starts from the target again on both paths.
    const t3 = { ...t, epoch: 3, rework: true };
    await new Git(r.bare).ok(["update-ref", `refs/heads/${t.branch}`, first.sha]);
    const e = await sandbox(r, { warm: true });
    const reworked = await runClaudeCode(e.provider, e.id, t3, e.cfg, { apiKey: KEY, warmTemplate: true });
    await new Git(r.bare).ok(["update-ref", `refs/heads/${t.branch}`, first.sha]);
    const f = await sandbox(r);
    expect((await runClaudeCode(f.provider, f.id, t3, f.cfg, { apiKey: KEY })).sha).toBe(reworked.sha);
    expect((await new Git(r.bare).ok(["rev-parse", `${reworked.sha}^`])).trim()).toBe((await r.sha("refs/heads/main"))!);
  }, 90_000);

  test("review mode in place: detached at the reviewed commit, nothing pushed", async () => {
    const r = await project();
    const t = task(r);
    const a = await sandbox(r);
    const pushed = await runClaudeCode(a.provider, a.id, t, a.cfg, { apiKey: KEY });
    const b = await sandbox(r, { warm: true });
    resetSpans();
    const res = await runClaudeCode(b.provider, b.id, { ...t, taskId: "rev-1", goal: "Acceptance criteria:\n- sum adds", review: { sha: pushed.sha, branch: t.branch, target: "main" } }, b.cfg, { apiKey: KEY, warmTemplate: true });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "in_place" });
    expect(res).toMatchObject({ sha: "", resultText: "fixed sum" });
    expect((await new Git(b.T).ok(["rev-parse", "HEAD"])).trim()).toBe(pushed.sha);
    expect(await r.sha(`refs/heads/${t.branch}`)).toBe(pushed.sha);
  }, 60_000);

  test("falls back to the clone: lockfile changed, stale (not in the target's history), another repo, already used", async () => {
    const r = await project();
    const t = task(r);
    const reasonFor = async (o: Parameters<typeof sandbox>[1], k: string) => {
      const s = await sandbox(r, o);
      resetSpans();
      await deleteBranch(r, t.branch).catch(() => {});
      const res = await runClaudeCode(s.provider, s.id, t, s.cfg, { apiKey: KEY, warmTemplate: true });
      expect(workspaceOf()).toMatchObject({ "agent.workspace": "clone" });
      expect(String(workspaceOf()!["agent.workspace_reason"])).toContain(k);
      expect(existsSync(join(s.workdir, "task-1-e1", "repo", ".git"))).toBe(true);
      return { s, res };
    };
    const { s: changed } = await reasonFor({ warm: true, marker: { lockHash: sha256("an older lockfile") } }, "lockfile changed");
    // The clone path doesn't copy node_modules built for another lockfile either.
    expect(existsSync(join(changed.workdir, "task-1-e1", "repo", "node_modules"))).toBe(false);
    await reasonFor({ warm: true, marker: { commit: "b".repeat(40) } }, "isn't in the target's history");
    await reasonFor({ warm: true, marker: { repo: "https://github.com/acme/other.git" } }, "another repository");

    // A retry in the same sandbox: the template was used (and maybe changed) by the first run, so it clones, and it
    // doesn't copy the used template's node_modules.
    const s = await sandbox(r, { warm: true });
    await deleteBranch(r, t.branch).catch(() => {});
    const first = await runClaudeCode(s.provider, s.id, t, s.cfg, { apiKey: KEY, warmTemplate: true });
    await deleteBranch(r, t.branch);
    resetSpans();
    const again = await runClaudeCode(s.provider, s.id, t, s.cfg, { apiKey: KEY, warmTemplate: true });
    expect(workspaceOf()).toMatchObject({ "agent.workspace": "clone" });
    expect(String(workspaceOf()!["agent.workspace_reason"])).toContain("earlier run");
    expect(again.sha).toBe(first.sha);
    expect(existsSync(join(s.workdir, "task-1-e1", "repo", "node_modules"))).toBe(false);
  }, 90_000);

  test("off (boxd, the fakes): no workspace decision at all, the clone as before, deps copied from the template", async () => {
    const r = await project();
    const s = await sandbox(r, { warm: true });
    resetSpans();
    const logs: string[] = [];
    await runClaudeCode(s.provider, s.id, task(r), s.cfg, { apiKey: KEY, onLog: (l) => logs.push(...l) });
    expect(workspaceOf()).toBeNull();
    expect(logs.some((l) => l.includes("workspace:"))).toBe(false);
    expect(existsSync(join(s.workdir, "task-1-e1", "repo", "node_modules", "left-pad"))).toBe(true);
    expect(existsSync(join(s.T, TEMPLATE_CLAIM))).toBe(false);
  }, 60_000);
});
