import { describe, expect, test, afterEach } from "bun:test";
import { bareRepo } from "./gitfixture";
import { fakeGitHub } from "./fake-github";
import { mergeTask, setGitHubApi } from "../../src/merge/service";
import { HttpGitHub } from "../../src/merge/github";
import { produceFakeWork } from "../../src/merge/fakework";
import { taskBranch, taskKey } from "../../src/merge/config";

const ROOT = new URL("../..", import.meta.url).pathname;
const req = (runId: string, taskId: string, extra: object = {}) => ({ runId, taskId, branch: taskBranch(runId, taskId), target: "main", ...extra });
const servers: Array<{ stop(): void }> = [];
afterEach(() => { setGitHubApi(null); while (servers.length) servers.pop()!.stop(); });

async function setup(opts: Parameters<typeof fakeGitHub>[1] = {}, strategy: "squash" | "rebase" | "merge" = "squash") {
  const r = await bareRepo({ mode: "pr", strategy });
  const gh = fakeGitHub(r.bare, opts);
  servers.push(gh);
  setGitHubApi(new HttpGitHub(gh.url, "fake-token"));
  return { r, gh, env: { ...r.env, CAPCOMD_GITHUB_API: gh.url, GITHUB_TOKEN: "fake-token" } };
}

describe("pr mode against a fake GitHub (backed by a real bare repo)", () => {
  for (const strategy of ["squash", "rebase", "merge"] as const) {
    test(`${strategy}: opens a PR, GitHub merges it, merged sha recorded; idempotent`, async () => {
      const { r, gh } = await setup({}, strategy);
      await produceFakeWork(r.cfg, { ...req("p1", "t"), epoch: 1 });
      const out = await mergeTask(req("p1", "t"), r.cfg);
      expect(out).toMatchObject({ status: "merged", mode: "pr", pr: 1, already: false });
      expect((out as any).sha).toBe((await r.sha("main"))!);
      expect(await r.landings(taskKey("p1", "t"))).toBe(1);
      const again = await mergeTask(req("p1", "t"), r.cfg);
      expect(again).toMatchObject({ status: "merged", already: true, how: "pr-already-merged", pr: 1 });
      expect(gh.pulls.length).toBe(1);
      expect(gh.calls.filter((c) => c.endsWith("/merge")).length).toBe(1);
    });
  }

  test("required checks pending → auto-merge enabled, waits, records once checks pass", async () => {
    const { r, gh } = await setup({ requireChecks: true });
    await produceFakeWork(r.cfg, { ...req("p2", "t"), epoch: 1 });
    const p = mergeTask(req("p2", "t"), r.cfg);
    await Bun.sleep(300);
    expect(gh.pulls[0]?.merged).toBe(false);
    expect(gh.pulls[0]?.autoMerge).toBe("squash");
    await gh.passChecks();
    expect(await p).toMatchObject({ status: "merged", pr: 1 });
    expect(await r.landings(taskKey("p2", "t"))).toBe(1);
  });

  test("merge queue: merge call refused, PR handed to auto-merge, queue lands it", async () => {
    const { r, gh } = await setup({ mergeQueue: true });
    await produceFakeWork(r.cfg, { ...req("p3", "t"), epoch: 1 });
    const p = mergeTask(req("p3", "t"), r.cfg);
    await Bun.sleep(300);
    expect(gh.pulls[0]?.autoMerge).toBe("squash");
    await gh.passChecks(); // queue runs
    expect(await p).toMatchObject({ status: "merged" });
  });

  test("local conflict with the latest target is caught before a PR is opened", async () => {
    const { r, gh } = await setup();
    await produceFakeWork(r.cfg, { ...req("p4", "t"), epoch: 1, path: "shared.txt", content: "line 1\nA\nline 3\n" });
    await r.pushToMain("shared.txt", "line 1\nB\nline 3\n");
    expect(await mergeTask(req("p4", "t"), r.cfg)).toMatchObject({ status: "conflict", files: ["shared.txt"] });
    expect(gh.pulls.length).toBe(0);
  });

  test("protected target: testOnly never opens a PR", async () => {
    const { r, gh } = await setup();
    await produceFakeWork(r.cfg, { ...req("p5", "t"), epoch: 1 });
    expect((await mergeTask(req("p5", "t", { testOnly: true }), r.cfg)).status).toBe("verified");
    expect(gh.pulls.length).toBe(0);
  });

  for (const kp of ["merge.pr.before_merge", "merge.after_pr_merge.before_event"]) {
    test(`crash at ${kp} (SIGKILL) → rerun: one PR, one merge, sha recorded`, async () => {
      const { r, gh, env } = await setup();
      const q = JSON.stringify({ ...req("p6", "t"), produce: true });
      const run = (extra: Record<string, string>) => {
        const proc = Bun.spawn([process.execPath, "tests/merge/merge-cli.ts", q], { cwd: ROOT, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
        return Promise.all([new Response(proc.stdout).text(), proc.exited]).then(([out, code]) => ({ out, code, signal: proc.signalCode }));
      };
      const crashed = await run({ CAPCOMD_KILLPOINT: `${kp}:1` });
      expect(crashed.signal).toBe("SIGKILL");
      const mergedBeforeCrash = kp === "merge.after_pr_merge.before_event";
      expect(gh.pulls[0]?.merged ?? false).toBe(mergedBeforeCrash);
      const again = await run({});
      expect(again.code).toBe(0);
      const out = JSON.parse(again.out.trim().split("\n").pop()!);
      expect(out).toMatchObject({ status: "merged", already: mergedBeforeCrash, pr: 1 });
      expect(out.sha).toBe(gh.pulls[0]!.merge_commit_sha);
      expect(gh.pulls.length).toBe(1);
      expect(gh.calls.filter((c) => c.endsWith("/merge")).length).toBe(1);
      expect(await r.landings(taskKey("p6", "t"))).toBe(1);
    }, 30_000);
  }

  test("git wins: change already on target without a merged PR is recorded, not re-merged", async () => {
    const { r, gh } = await setup();
    await produceFakeWork(r.cfg, { ...req("p7", "t"), epoch: 1 });
    // Someone landed it out of band (e.g. by hand).
    await r.seed.ok(["fetch", "-q", "origin"]);
    await r.seed.ok(["reset", "-q", "--hard", "origin/main"]);
    await r.seed.ok(["merge", "-q", "--ff-only", `origin/${taskBranch("p7", "t")}`]);
    await r.seed.ok(["push", "-q", "origin", "HEAD:main"]);
    expect(await mergeTask(req("p7", "t"), r.cfg)).toMatchObject({ status: "merged", already: true, how: "ancestor" });
    expect(gh.pulls.length).toBe(0);
  });
});
