// The rest of the forge seam (docs/spec/plugin-api.md §7.1, §7.4): what the kernel still did about the hosting service
// is the active forge's now. A run's base comes from the forge's `listBranches`; whether the user's own login is here
// (pull requests, publishing, who you publish as) is its `login`; a run naming a forge that isn't active is refused when
// it's validated; "pr mode" without a forge that has pull requests says so; and every forge call goes through the
// kernel's wrapper (a span, the SeamCall honoured, transient reads retried by the forge's own classifyError). The test
// forge (tests/merge/forge-fake) is loaded by a real plugin host beside the built-ins and answers what each test says.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PluginHost } from "../../packages/plugin/src/host/host";
import { RelayError } from "../../src/core/errors";
import { taskBranch } from "../../src/merge/config";
import { produceFakeWork } from "../../src/merge/fakework";
import { listBranches, resolveGoalBranch } from "../../src/merge/goal";
import { mergeTask } from "../../src/merge/service";
import { BUILTINS } from "../../src/plugins/builtins";
import { activeForges, forgeFor, forgeLogin, inactiveForge, publishForge, pullRequestLabels, useForges, withForge } from "../../src/plugins/forges";
import { GitForge } from "../../src/plugins/forges/git";
import { GitHubForge, resetGitHubLogins } from "../../src/plugins/forges/github";
import { forgeScope } from "../../src/plugins/forges/scope";
import { localCandidates, localHost } from "../../src/plugins/host";
import { publishAccounts } from "../../src/api/project-git";
import { publishLogin } from "../../src/api/projects";
import { CreateRunError } from "../../src/api/source";
import { startDetachedRun } from "../../src/api/create-run";
import { VERSION } from "../../src/utils/self";
import { fake } from "../merge/forge-fake/index";
import { bareRepo } from "../merge/gitfixture";

const FAKE = join(import.meta.dir, "..", "merge", "forge-fake");
const scratch = mkdtempSync(join(tmpdir(), "capcomd-forges-"));
let host: PluginHost;
const endpoint = process.env.CAPCOMD_ENDPOINT;
beforeAll(async () => {
  // The checks look up the run's sandbox in the engine: a closed port, so these tests never ask a running daemon.
  process.env.CAPCOMD_ENDPOINT = "http://127.0.0.1:9";
  host = new PluginHost({ capcomd: VERSION, kernel: [], emit: () => {}, dataDir: () => "/nonexistent" });
  await host.start([{ source: "builtin", dir: FAKE }, ...BUILTINS.map((b) => ({ source: "builtin" as const, manifest: b.manifest, module: b.module }))]);
  useForges(host);
});
afterAll(async () => {
  useForges(null);
  await host.stop();
  if (endpoint === undefined) delete process.env.CAPCOMD_ENDPOINT; else process.env.CAPCOMD_ENDPOINT = endpoint;
});
afterEach(() => { fake.reset(); resetGitHubLogins(); });

/** A `gh` that answers `auth status`/`auth token` with `ok`, and `api user`/`api user/orgs` as marvin of acme. */
function fakeGh(ok: boolean): string {
  const bin = join(mkdtempSync(join(scratch, "gh-")), "gh");
  writeFileSync(bin, `#!/bin/sh
case "$1 $2" in
  "auth status") exit ${ok ? 0 : 1} ;;
  "auth token") ${ok ? 'echo "gho_fake"' : "exit 1"} ;;
  "api user") ${ok ? `echo '{"login":"marvin"}'` : "exit 1"} ;;
  "api user/orgs") echo '[{"login":"acme"}]' ;;
  *) exit 1 ;;
esac
`);
  chmodSync(bin, 0o755);
  return bin;
}

describe("a remote's branches come from its forge (§7.4 listBranches)", () => {
  test("the forge merge.forge names reads them: from the remote itself, or from its service, by its name", async () => {
    const r = await bareRepo();
    await r.seed.ok(["push", "-q", "origin", "main:dev"]);
    const viaGit = await listBranches({ remote: r.bare, merge: { ...r.cfg, forge: "fake" }, cwd: scratch });
    expect(viaGit).toEqual({ defaultBranch: "main", branches: ["dev", "main"], source: "git", note: null });
    expect(fake.calls).toEqual([`branches ${r.bare}`]);
    fake.branches = { defaultBranch: "trunk", branches: ["trunk", "b", "a"], source: "service", note: null };
    expect(await listBranches({ remote: r.bare, forge: "fake", cwd: scratch })).toEqual({ defaultBranch: "trunk", branches: ["a", "b", "trunk"], source: "fake", note: null });
  });

  test("a remote the forge can't read: the checkout's own refs, with the forge's reason; a forge that isn't active: the same, saying so", async () => {
    fake.branches = new Error("the fake service is down");
    const local = () => ({ defaultBranch: "main", branches: ["main", "x"] });
    expect(await listBranches({ remote: "/srv/x.git", forge: "fake", cwd: scratch, local })).toEqual({ defaultBranch: "main", branches: ["main", "x"], source: "local", note: "the fake service is down" });
    expect(await listBranches({ remote: "/srv/x.git", forge: "gitea", cwd: scratch, local })).toMatchObject({ source: "local", note: "merge.forge names gitea, which no active plugin provides" });
  });

  test("a transient failure is tried again by the kernel's wrapper, inside the call's deadline, and the forge gets a trace", async () => {
    const r = await bareRepo();
    fake.flakyBranches = 2;
    expect(await listBranches({ remote: r.bare, forge: "fake", cwd: scratch })).toMatchObject({ source: "git", defaultBranch: "main" });
    expect(fake.calls.filter((c) => c.startsWith("branches")).length).toBe(3);
    expect(fake.seen.every((s) => s.method === "listBranches" && s.traceId.length > 0 && Date.parse(s.deadline) > Date.now())).toBe(true);
    // Past its retries: the local refs, with the forge's last word.
    fake.flakyBranches = 5;
    expect(await listBranches({ remote: r.bare, forge: "fake", cwd: scratch })).toMatchObject({ source: "local", note: "the fake service hiccupped" });
  });

  test("a run's base is the forge's default branch (POST /v1/runs, `capcomd run`)", async () => {
    const r = await bareRepo();
    await r.seed.ok(["push", "-q", "origin", "main:develop"]);
    fake.branches = { defaultBranch: "develop", branches: ["develop", "main"], source: "service", note: null };
    const got = await resolveGoalBranch({ goal: "Add x", remote: r.bare, merge: { ...r.cfg, forge: "fake" }, cwd: scratch, env: {} });
    expect(got).toMatchObject({ base: "develop", baseSource: "remote", goalBranch: "capcomd/add-x", listing: { source: "fake" } });
    // A base the forge doesn't list is refused with the field.
    expect(await resolveGoalBranch({ goal: "Add x", base: "nope", remote: r.bare, merge: { ...r.cfg, forge: "fake" }, cwd: scratch, env: {} }).catch((e) => [e.code, e.reason])).toEqual(["not_found", "base"]);
  });

  test("git: ls-remote, its HEAD the default; an unreadable remote rejects with why", async () => {
    const r = await bareRepo();
    const c = { signal: new AbortController().signal, deadline: new Date(Date.now() + 10_000).toISOString(), trace: { traceId: "", spanId: "" } };
    expect(await new GitForge().listBranches({ remote: r.bare, cwd: scratch, max: 10 }, c)).toEqual({ defaultBranch: "main", branches: ["main"], source: "git", note: null });
    await expect(new GitForge().listBranches({ remote: join(scratch, "nowhere.git"), cwd: scratch, max: 10 }, c)).rejects.toMatchObject({ code: "unavailable", message: expect.stringContaining("git ls-remote failed") });
  });
});

describe("a forge that isn't active is refused when a run is validated (§7.1)", () => {
  test("named and inactive: the refusal and the forges there are; unset or active: nothing", async () => {
    expect(await inactiveForge(null)).toBeNull();
    expect(await inactiveForge("fake")).toBeNull();
    expect(await inactiveForge("gitea")).toEqual({
      message: "merge.forge names gitea, which no active plugin provides",
      hint: "Name one that is (fake, github, git) in CAPCOMD_MERGE_FORGE, or see `capcomd plugins list` for why gitea isn't loaded.",
    });
    await host.disable("forge-fake");
    try { expect((await inactiveForge("fake"))?.message).toBe("merge.forge names fake, which no active plugin provides"); }
    finally { await host.enable("forge-fake"); }
  });

  test("a run's base resolution refuses it (`capcomd run`, `capcomd_run_new`): config, reason forge", async () => {
    const r = await bareRepo();
    const err = await resolveGoalBranch({ goal: "x", base: "main", remote: r.bare, merge: { ...r.cfg, forge: "gitea" }, cwd: scratch, env: {} }).catch((e) => e);
    expect(err).toBeInstanceOf(RelayError);
    expect(err).toMatchObject({ code: "config", reason: "forge", message: "merge.forge names gitea, which no active plugin provides" });
  });

  test("POST /v1/runs: the daemon refuses it (a 422) before it starts `capcomd run`", async () => {
    let spawned = false;
    const env = { CAPCOMD_HOME: join(scratch, "home"), CAPCOMD_NO_CONFIG: "1", CAPCOMD_REPO: "/srv/app.git", CAPCOMD_MERGE_FORGE: "gitea" };
    const err = await startDetachedRun({ goal: "x", runId: "run-forge-x" }, { env, cwd: scratch, spawn: (() => { spawned = true; throw new Error("not started"); }) as never }).catch((e) => e);
    expect(err).toBeInstanceOf(CreateRunError);
    expect(err.message).toBe("merge.forge names gitea, which no active plugin provides. Name one that is (fake, github, git) in CAPCOMD_MERGE_FORGE, or see `capcomd plugins list` for why gitea isn't loaded.");
    expect(spawned).toBe(false);
  });
});

describe("pr mode without a forge that has pull requests (§7.4)", () => {
  test("in the words of the forges that have them; with none active, that no active forge supports them", async () => {
    expect(await pullRequestLabels()).toEqual(["Fake forge", "GitHub"]);
    const r = await bareRepo({ mode: "pr" });
    await produceFakeWork(r.cfg, { runId: "n1", taskId: "t", branch: taskBranch("n1", "t"), target: "main", epoch: 1 });
    const req = { runId: "n1", taskId: "t", branch: taskBranch("n1", "t"), target: "main" };
    expect(await mergeTask(req, { ...r.cfg, forge: "git" })).toMatchObject({ status: "failed", reason: `pr mode needs a Fake forge or GitHub repo (one its forge claims, or CAPCOMD_MERGE_FORGE naming a forge with pull requests); remote is ${r.bare}` });
    await host.disable("forge-fake");
    await host.disable("forge-github");
    try {
      expect(await pullRequestLabels()).toEqual([]);
      expect(await mergeTask(req, { ...r.cfg, forge: "git" })).toMatchObject({ status: "failed", reason: `pr mode needs a forge with pull requests, and no active forge supports them (see \`capcomd plugins list\`); remote is ${r.bare}` });
    } finally { await host.enable("forge-github"); await host.enable("forge-fake"); }
  });
});

describe("the user's own login is the forge's (§7.4 login)", () => {
  test("the wrapper hands back what the forge says, and never rejects: a throw is no login, with the forge's hint", async () => {
    const forge = (await forgeFor({ remote: "/x", forge: "fake" }))!;
    expect(await forgeLogin(forge, { use: "pullRequests" })).toEqual({ ok: true, accounts: [] });
    fake.logins.pullRequests = { ok: false, reason: "nobody is logged in to the fake forge", fix: "Run `fake login`." };
    expect(await forgeLogin(forge, { use: "pullRequests" })).toEqual({ ok: false, reason: "nobody is logged in to the fake forge", fix: "Run `fake login`." });
    fake.loginThrows = true;
    expect(await forgeLogin(forge, { use: "publish" })).toEqual({ ok: false, reason: "the fake forge can't tell who you are", fix: "Log in to the fake forge" });
    expect(fake.calls).toEqual(["login pullRequests", "login pullRequests", "login publish"]);
  });

  test("publishing asks the first forge that publishes: whether you're logged in, and who you can publish as", async () => {
    expect((await publishForge())!.describe().name).toBe("fake");
    fake.logins.publish = { ok: true, accounts: [{ login: "marvin", kind: "user" }, { login: "acme", kind: "org" }] };
    expect(await publishLogin()).toBe(true);
    expect(await publishAccounts({})).toEqual([{ login: "marvin", kind: "user" }, { login: "acme", kind: "org" }]);
    fake.logins.publish = { ok: false, reason: "no", fix: null };
    expect(await publishLogin()).toBe(false);
    expect(await publishAccounts({})).toEqual([]);
    // A forge that doesn't publish isn't asked: GitHub is next (its gh says it isn't logged in).
    fake.publish = false;
    expect((await publishForge())!.describe().name).toBe("github");
    expect(await publishLogin({ CAPCOMD_GH_CLI: fakeGh(false) })).toBe(false);
    expect(fake.calls.filter((c) => c.startsWith("login")).length).toBe(4);
  });

  test("GitHub: a token for pull requests; the GitHub CLI's login for publishing, and its user and organizations", async () => {
    const gh = new GitHubForge();
    const c = { signal: new AbortController().signal, deadline: new Date(Date.now() + 10_000).toISOString(), trace: { traceId: "", spanId: "" } };
    const as = <T>(env: Record<string, string>, fn: () => Promise<T>) => forgeScope.run({ env }, fn);
    expect(await as({ GITHUB_TOKEN: "t" }, () => gh.login({ use: "pullRequests" }, c))).toEqual({ ok: true, accounts: [] });
    expect(await as({ GITHUB_TOKEN: "", GH_TOKEN: "", CAPCOMD_GH_CLI: fakeGh(false) }, () => gh.login({ use: "pullRequests" }, c)))
      .toEqual({ ok: false, reason: "there is no GitHub login on this machine", fix: "run `gh auth login` (or set GITHUB_TOKEN)" });
    const yes = fakeGh(true);
    expect(await as({ GITHUB_TOKEN: "", GH_TOKEN: "", CAPCOMD_GH_CLI: yes }, () => gh.login({ use: "pullRequests" }, c))).toEqual({ ok: true, accounts: [] });
    expect(await as({ CAPCOMD_GH_CLI: yes }, () => gh.login({ use: "publish" }, c))).toEqual({ ok: true, accounts: [] });
    expect(await as({ CAPCOMD_GH_CLI: yes }, () => gh.login({ use: "publish", accounts: true }, c))).toEqual({ ok: true, accounts: [{ login: "marvin", kind: "user" }, { login: "acme", kind: "org" }] });
    expect(await as({ CAPCOMD_GH_CLI: fakeGh(false) }, () => gh.login({ use: "publish" }, c))).toEqual({ ok: false, reason: "the GitHub CLI isn't logged in on this machine", fix: "run `gh auth login` in Terminal" });
    expect(new GitForge().describe()).toEqual({ name: "git", label: "Git", pullRequests: false });
    expect((await new GitForge().login({ use: "pullRequests" })).ok).toBe(false);
  });
});

describe("a goal branch's pull request names the forge it is on", () => {
  test("its description says where to merge it: the forge's label, GitHub when none is given", async () => {
    const { pullRequestBody } = await import("../../src/primitives/goal");
    const o = { runId: "run-f", branch: "capcomd/x", summary: null, landed: [], notLanded: [] };
    expect(pullRequestBody({ ...o, forge: "Fake forge" }).endsWith("capcomd never merges this pull request: review and merge it on Fake forge.")).toBe(true);
    expect(pullRequestBody(o).endsWith("review and merge it on GitHub.")).toBe(true);
  });
});

describe("every forge call goes through the kernel's wrapper (§7.1)", () => {
  test("a forge that ignores its SeamCall still answers timeout at the deadline", async () => {
    const forge = (await forgeFor({ remote: "/x", forge: "fake" }))!;
    fake.hangFind = true;
    const t0 = Date.now();
    await expect(withForge({}, 200, (c) => forge.findPullRequest({ remote: "/x", head: "b", base: "main" }, c))).rejects.toMatchObject({ name: "PluginError", code: "timeout" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(fake.seen.at(-1)).toMatchObject({ method: "findPullRequest" });
    expect(fake.seen.at(-1)!.traceId).not.toBe("");
  });

  test("consumers get the wrapper, never the plugin's object; classifyError and matches never throw at them", async () => {
    const all = await activeForges();
    expect(all.map((f) => f.name)).toEqual(["fake", "github", "git"]);
    const raw = host.contributions.get("seam", "forge/fake")!.value.impl;
    expect(all[0]!.forge).not.toBe(raw);
    expect(all[0]!.forge.classifyError(new Error("?"))).toEqual({ kind: "unknown", retryable: false });
  });
});

describe("one local host in a process that isn't the daemon", () => {
  test("its gates and its forges are the same host's, started once", async () => {
    useForges(null);
    try {
      const a = localHost(), b = localHost();
      expect(a).toBe(b);
      const names = (await a).list().map((p) => p.name);
      expect(names).toEqual(expect.arrayContaining(["gate-reviewer", "forge-github", "forge-git"]));
      expect((await activeForges()).map((f) => f.plugin)).toEqual(["forge-github", "forge-git"]);
      // CAPCOMD_TEST_PLUGINS is read once, in one place.
      expect(localCandidates({ NODE_ENV: "test", CAPCOMD_TEST_PLUGINS: `${FAKE}:` }).filter((c) => c.dir).map((c) => c.dir)).toEqual([FAKE]);
      expect(localCandidates({ CAPCOMD_TEST_PLUGINS: FAKE }).some((c) => c.dir)).toBe(false);
    } finally { useForges(host); }
  });
});
