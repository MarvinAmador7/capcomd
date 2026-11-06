// Plugin API step 6 (docs/spec/plugin-api.md §7.4, §17.2): merges land through the forge seam. The kernel fetches,
// integrates and checks, then hands the forge the checked commit under the target's lock; the forge pushes it (direct)
// or merges a pull request at the checked head (pr). The test forge (tests/merge/forge-fake) is loaded by a real plugin
// host beside the built-in forges, chosen by `merge.forge`, and records what the kernel asked of it.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import { PluginError } from "../../packages/plugin/src/errors";
import { loadManifest } from "../../packages/plugin/src/load";
import { taskBranch, taskKey, loadMergeConfig, type MergeConfig } from "../../src/merge/config";
import { produceFakeWork } from "../../src/merge/fakework";
import { GitHubHttpError } from "../../src/merge/github";
import { mergeTask } from "../../src/merge/service";
import { BUILTINS, candidateOf } from "../../src/plugins/builtins";
import { activeForges, forgeFor, ForgeNotActive, seamCall, useForges } from "../../src/plugins/forges";
import { casPush, GitForge } from "../../src/plugins/forges/git";
import { GitHubForge } from "../../src/plugins/forges/github";
import { VERSION } from "../../src/utils/self";
import { fake } from "./forge-fake/index";
import { bareRepo } from "./gitfixture";

const FAKE = join(import.meta.dir, "forge-fake");
const req = (runId: string, taskId: string, extra: object = {}) => ({ runId, taskId, branch: taskBranch(runId, taskId), target: "main", ...extra });
const withFake = (cfg: MergeConfig, extra: Partial<MergeConfig> = {}): MergeConfig => ({ ...cfg, forge: "fake", ...extra });

let host: PluginHost;
// The checks look up the run's sandbox in the engine: a closed port, so these tests never ask a running daemon.
const endpoint = process.env.CAPCOMD_ENDPOINT;
beforeAll(async () => {
  process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
  host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: () => "/nonexistent" });
  await host.start([{ source: "builtin", dir: FAKE }, ...BUILTINS.map(candidateOf)]);
  useForges(host);
});
afterAll(async () => {
  useForges(null);
  await host.stop();
  if (endpoint === undefined) delete process.env.CAPCOMD_ENDPOINT; else process.env.CAPCOMD_ENDPOINT = endpoint;
});
afterEach(() => fake.reset());

describe("the forges and how one is chosen (§7.1)", () => {
  test("the built-in forges are plugins whose manifests validate; git loads last", async () => {
    for (const b of BUILTINS) expect(loadManifest(b.manifest, { capcomd: VERSION, kernelSurface: !!b.kernelSurface })).toMatchObject({ ok: true });
    expect((await activeForges()).map((f) => [f.name, f.plugin])).toEqual([["fake", "forge-fake"], ["github", "forge-github"], ["git", "forge-git"]]);
    expect(host.get("forge-git")).toMatchObject({ state: "active", seams: [{ kind: "forge", name: "git" }] });
  });

  test("named by merge.forge, else the first that matches the remote; a named forge that isn't active is refused", async () => {
    expect((await forgeFor({ remote: "https://github.com/acme/w.git" }))!.describe().name).toBe("github");
    expect((await forgeFor({ remote: "git@gitlab.example.com:acme/w.git" }))!.describe().name).toBe("git");
    expect((await forgeFor({ remote: "/srv/repo.git", forge: "fake" }))!.describe().name).toBe("fake");
    fake.claims = ["/srv/"];
    expect((await forgeFor({ remote: "/srv/repo.git" }))!.describe().name).toBe("fake");
    await expect(forgeFor({ remote: "/srv/repo.git", forge: "gitea" })).rejects.toBeInstanceOf(ForgeNotActive);
  });

  test("config: CAPCOMD_MERGE_FORGE names it; a GitHub repository named outright names github; never .capcomd.json", () => {
    expect(loadMergeConfig({ CAPCOMD_REPO: "/x", CAPCOMD_MERGE_FORGE: "fake" })!.forge).toBe("fake");
    // The target tree's .capcomd.json is read only after the forge is chosen, so it can't name one.
    expect(loadMergeConfig({ CAPCOMD_REPO: "/x" }, { merge: { forge: "gitea", github: "acme/w" } })!.forge).toBeNull();
    expect(loadMergeConfig({ CAPCOMD_REPO: "/x", CAPCOMD_GITHUB_REPO: "acme/w" })!.forge).toBe("github");
    expect(loadMergeConfig({ CAPCOMD_REPO: "https://github.com/acme/w.git" })!.forge).toBeNull();
  });

  test("without a daemon, a process starts the forge plugins itself", async () => {
    useForges(null);
    try { expect((await activeForges()).map((f) => f.name)).toEqual(["github", "git"]); } finally { useForges(host); }
  });
});

describe("direct mode: the forge lands the checked commit under the target's lock", () => {
  test("one land: the integrated commit onto the target it was integrated on, leased there", async () => {
    const r = await bareRepo({ test: "test -f tasks/$CAPCOMD_TASK_ID.md" });
    const before = (await r.sha("main"))!;
    await produceFakeWork(r.cfg, { ...req("f1", "t"), epoch: 1 });
    fake.lockDir = join(r.cfg.workdir, "locks");
    const out = await mergeTask(req("f1", "t"), withFake(r.cfg));
    expect(out).toMatchObject({ status: "merged", mode: "direct", already: false, attempts: 1, targetBefore: before });
    expect(fake.lands.length).toBe(1);
    const { req: land, lockHeld } = fake.lands[0]!;
    expect(lockHeld).toBe(true);
    expect(land).toMatchObject({ mode: "direct", target: "main", branch: taskBranch("f1", "t"), targetSha: before, remote: r.bare, trailers: { "Capcomd-Task": taskKey("f1", "t") } });
    expect(land!.sha).toBe((await r.sha("main"))!);
    expect((out as { sha: string }).sha).toBe(land!.sha);
    expect(await r.landings(taskKey("f1", "t"))).toBe(1);
    // Again: git says it is there; the forge isn't asked.
    expect(await mergeTask(req("f1", "t"), withFake(r.cfg))).toMatchObject({ status: "merged", already: true });
    expect(fake.lands.length).toBe(1);
  }, 20_000);

  test("the target moves before the land: conflict → the kernel fetches, integrates and checks again", async () => {
    const r = await bareRepo({ strategy: "rebase" });
    await produceFakeWork(r.cfg, { ...req("f2", "t"), epoch: 1 });
    fake.beforeLand = async (_q, n) => { if (n === 1) await r.pushToMain("race.txt", "r\n"); };
    const out = await mergeTask(req("f2", "t"), withFake(r.cfg));
    expect(out).toMatchObject({ status: "merged", attempts: 2 });
    expect(fake.lands.length).toBe(2);
    expect(fake.lands[1]!.req.targetSha).not.toBe(fake.lands[0]!.req.targetSha);
    expect(await r.show("main", "race.txt")).toBe("r");
    expect(await r.landings(taskKey("f2", "t"))).toBe(1);
  });

  test("after a passing verify: the verified commit, the branch leased beside the target (the fast path)", async () => {
    const r = await bareRepo();
    await produceFakeWork(r.cfg, { ...req("f3", "t"), epoch: 1 });
    const v = await mergeTask(req("f3", "t", { testOnly: true }), withFake(r.cfg));
    expect(v.status).toBe("verified");
    if (v.status !== "verified") return;
    expect(fake.lands.length).toBe(0);
    const out = await mergeTask(req("f3", "t", { expectSha: v.taskSha, verified: { sha: v.sha, targetSha: v.targetSha!, how: v.how } }), withFake(r.cfg));
    expect(out).toMatchObject({ status: "merged", sha: v.sha, timings: { path: "fast" } });
    expect(fake.lands.map((l) => l.req)).toMatchObject([{ sha: v.sha, targetSha: v.targetSha, branchSha: v.taskSha, leaseBranch: true }]);
  });

  test("a land the forge fails is a failed merge, and nothing landed", async () => {
    const r = await bareRepo();
    const before = await r.sha("main");
    await produceFakeWork(r.cfg, { ...req("f4", "t"), epoch: 1 });
    fake.failNext = { status: "failed", reason: "the forge said no", retryable: false };
    expect(await mergeTask(req("f4", "t"), withFake(r.cfg))).toMatchObject({ status: "failed", reason: "push failed: the forge said no" });
    expect(await r.sha("main")).toBe(before);
    // A land that rejects (its SeamCall cancelled, or the forge's own error) is a failed push too, not a thrown merge.
    fake.beforeLand = async () => { throw new PluginError("timeout", "git push to main was cancelled"); };
    expect(await mergeTask(req("f4", "t"), withFake(r.cfg))).toMatchObject({ status: "failed", reason: "push failed: git push to main was cancelled" });
    expect(await r.sha("main")).toBe(before);
  });

  test("a forge that is disabled is refused by name; enabled again, it lands", async () => {
    const r = await bareRepo();
    await produceFakeWork(r.cfg, { ...req("f5", "t"), epoch: 1 });
    await host.disable("forge-fake");
    try {
      expect(await mergeTask(req("f5", "t"), withFake(r.cfg))).toMatchObject({ status: "failed", reason: "merge.forge names fake, which no active plugin provides" });
    } finally { await host.enable("forge-fake"); }
    expect(await mergeTask(req("f5", "t"), withFake(r.cfg))).toMatchObject({ status: "merged" });
  });
});

describe("pr mode: the forge opens and merges the pull request at the checked head", () => {
  test("one pull request, merged once; a replay finds it merged and records it", async () => {
    const r = await bareRepo({ mode: "pr" });
    await produceFakeWork(r.cfg, { ...req("p1", "t"), epoch: 1 });
    const taskSha = await r.sha(taskBranch("p1", "t"));
    fake.lockDir = join(r.cfg.workdir, "locks");
    const out = await mergeTask(req("p1", "t"), withFake(r.cfg));
    expect(out).toMatchObject({ status: "merged", mode: "pr", pr: 1, already: false, how: "pr-fake" });
    expect((out as { sha: string }).sha).toBe((await r.sha("main"))!);
    expect(fake.lands).toMatchObject([{ lockHeld: true, req: { mode: "pr", branchSha: taskSha, strategy: "squash", mrgId: taskKey("p1", "t") } }]);
    expect(fake.pulls).toMatchObject([{ number: 1, state: "merged", head: taskBranch("p1", "t"), base: "main" }]);
    const again = await mergeTask(req("p1", "t"), withFake(r.cfg));
    expect(again).toMatchObject({ status: "merged", already: true, how: "pr-already-merged", pr: 1 });
    expect(fake.lands.length).toBe(1);
  });

  test("a verify never opens a pull request", async () => {
    const r = await bareRepo({ mode: "pr" });
    await produceFakeWork(r.cfg, { ...req("p2", "t"), epoch: 1 });
    expect((await mergeTask(req("p2", "t", { testOnly: true }), withFake(r.cfg))).status).toBe("verified");
    expect(fake.lands.length).toBe(0);
    expect(fake.pulls.length).toBe(0);
  });

  test("a forge without pull requests can't land in pr mode: refused before anything is pushed", async () => {
    const r = await bareRepo({ mode: "pr" });
    const before = await r.sha("main");
    await produceFakeWork(r.cfg, { ...req("p3", "t"), epoch: 1 });
    const out = await mergeTask(req("p3", "t"), withFake(r.cfg, { forge: "git" }));
    expect(out).toMatchObject({ status: "failed" });
    // Said in the words of the active forges with pull requests (here the test forge and GitHub).
    expect((out as { reason: string }).reason).toMatch(/^pr mode needs a (.+ or )?GitHub repo/);
    fake.pullRequests = false;
    expect((await mergeTask(req("p3", "t"), withFake(r.cfg))).status).toBe("failed");
    expect(fake.lands.length).toBe(0);
    expect(await r.sha("main")).toBe(before);
  });
});

describe("the built-in forges' contracts (§7.2.3, §7.4)", () => {
  test("classifyError: GitHub's rate limit is quota, 401/403 auth, 5xx transient; a cancelled push is timeout", () => {
    const gh = new GitHubForge();
    expect(gh.classifyError(new GitHubHttpError(403, "API rate limit exceeded", true))).toMatchObject({ kind: "quota", retryable: true });
    expect(gh.classifyError(new GitHubHttpError(401, "Bad credentials", false))).toMatchObject({ kind: "auth", retryable: false });
    expect(gh.classifyError(new GitHubHttpError(502, "bad gateway", false))).toMatchObject({ kind: "transient" });
    expect(gh.classifyError(new Error("?"))).toEqual({ kind: "unknown", retryable: false });
    const git = new GitForge();
    expect(git.classifyError(new PluginError("timeout", "cancelled"))).toEqual({ kind: "timeout", retryable: true });
    expect(git.classifyError(new Error("fatal: unable to access 'https://x/': Could not resolve host: x"))).toMatchObject({ kind: "transient" });
  });

  test("git: no pull requests (unsupported); matches every remote; describes itself", async () => {
    const git = new GitForge();
    expect(git.describe()).toEqual({ name: "git", label: "Git", pullRequests: false });
    expect(git.matches("anything")).toBe(true);
    const c = seamCall(5_000);
    try {
      await expect(git.land({ mode: "pr" } as never, c)).rejects.toMatchObject({ code: "unsupported" });
      await expect(git.findPullRequest()).rejects.toMatchObject({ code: "unsupported" });
      await expect(git.publishRepository()).rejects.toMatchObject({ code: "unsupported" });
    } finally { c.done(); }
  });

  test("the CAS push honours its SeamCall: cancelled, it rejects timeout and pushes nothing", async () => {
    const r = await bareRepo();
    const before = (await r.sha("main"))!;
    const ac = new AbortController();
    ac.abort();
    const land = { runId: "x", mrgId: "x", remote: r.bare, repo: null, branch: "b", target: "main", sha: before, targetSha: before, mode: "direct" as const, strategy: "squash" as const, subject: "s", body: "", trailers: {}, workdir: r.root };
    await expect(casPush(land, { signal: ac.signal, deadline: new Date().toISOString(), trace: { traceId: "", spanId: "" } })).rejects.toMatchObject({ code: "timeout" });
    expect(await r.sha("main")).toBe(before);
  });
});
