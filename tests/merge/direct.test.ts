import { describe, expect, test, afterEach } from "bun:test";
import { bareRepo } from "./gitfixture";
import { mergeTask } from "../../src/merge/service";
import { directMerge, testHooks } from "../../src/merge/direct";
import { produceFakeWork } from "../../src/merge/fakework";
import { taskBranch, taskKey, loadMergeConfig } from "../../src/merge/config";
import { withTargetLock } from "../../src/merge/lock";
import { join } from "path";

const ROOT = new URL("../..", import.meta.url).pathname;

async function sub(env: Record<string, string>, req: unknown) {
  const proc = Bun.spawn([process.execPath, "tests/merge/merge-cli.ts", JSON.stringify(req)], { cwd: ROOT, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, out, err, signal: proc.signalCode };
}

const req = (runId: string, taskId: string, extra: object = {}) => ({ runId, taskId, branch: taskBranch(runId, taskId), target: "main", ...extra });

afterEach(() => { testHooks.beforePush = undefined; });

describe("direct merge against a local bare repo", () => {
  for (const strategy of ["squash", "rebase", "merge"] as const) {
    test(`${strategy}: lands once, records the sha, idempotent on retry`, async () => {
      const r = await bareRepo({ strategy, test: "test -f tasks/$CAPCOMD_TASK_ID.md" });
      await r.pushToMain("other.txt", "moved\n"); // target moved after the branch was cut? (cut happens next, so ff possible for rebase/merge)
      await produceFakeWork(r.cfg, { ...req("run1", "task-1"), epoch: 1 });
      await r.pushToMain("later.txt", "later\n"); // now the task branch is behind: needs rebase/squash/merge commit
      const a = await mergeTask(req("run1", "task-1"), r.cfg);
      expect(a.status).toBe("merged");
      if (a.status !== "merged") return;
      expect(a.already).toBe(false);
      expect(a.sha).toBe((await r.sha("main"))!);
      expect(await r.landings(taskKey("run1", "task-1"))).toBe(1);
      expect(await r.show("main", "later.txt")).toBe("later");
      const b = await mergeTask(req("run1", "task-1"), r.cfg);
      expect(b).toMatchObject({ status: "merged", already: true });
      expect(await r.landings(taskKey("run1", "task-1"))).toBe(1);
    });
  }

  test("tests run on the branch merged with the latest target (failing tests block the merge)", async () => {
    const r = await bareRepo({ test: "test -f later.txt" });
    await produceFakeWork(r.cfg, { ...req("run2", "t"), epoch: 1 });
    const before = await r.sha("main");
    const bad = await mergeTask(req("run2", "t"), { ...r.cfg, testCommand: "test -f does-not-exist" });
    expect(bad.status).toBe("failed");
    expect(await r.sha("main")).toBe(before);
    await r.pushToMain("later.txt", "x\n"); // only exists on the latest target, not on the task branch
    expect((await mergeTask(req("run2", "t"), r.cfg)).status).toBe("merged");
  });

  test("lease rejection: target moves between verify and push → rebase, re-verify, retry", async () => {
    const r = await bareRepo({ strategy: "rebase" });
    await produceFakeWork(r.cfg, { ...req("run3", "t"), epoch: 1 });
    let moved = 0;
    testHooks.beforePush = async (attempt) => {
      if (attempt <= 2) { moved++; await r.pushToMain(`race-${attempt}.txt`, "r\n"); }
    };
    const out = await mergeTask(req("run3", "t"), r.cfg);
    expect(out).toMatchObject({ status: "merged", attempts: 3 });
    expect(moved).toBe(2);
    expect(await r.show("main", "race-1.txt")).toBe("r");
    expect(await r.show("main", "race-2.txt")).toBe("r");
    expect(await r.landings(taskKey("run3", "t"))).toBe(1);
  });

  test("lease rejection retries are capped", async () => {
    const r = await bareRepo({ extraEnv: { CAPCOMD_MERGE_MAX_RETRIES: "2" } });
    await produceFakeWork(r.cfg, { ...req("run4", "t"), epoch: 1 });
    testHooks.beforePush = async (attempt) => { await r.pushToMain(`race-${attempt}.txt`, "r\n"); };
    const out = await mergeTask(req("run4", "t"), r.cfg);
    expect(out.status).toBe("failed");
    expect((out as any).reason).toContain("rejected 3 times");
    expect(await r.landings(taskKey("run4", "t"))).toBe(0);
  });

  test("concurrent pushes from two hosts (no shared lock): both land exactly once, linear", async () => {
    const r = await bareRepo({ strategy: "rebase" });
    const ids = ["a", "b", "c", "d"];
    for (const id of ids) await produceFakeWork(r.cfg, { ...req("run5", id), epoch: 1 });
    // Separate clones + no lock = separate orchestrator hosts racing on the same target.
    const results = await Promise.all(ids.map((id) => directMerge(r.cfg, req("run5", id), `host-${id}`)));
    expect(results.every((x) => x.status === "merged")).toBe(true);
    expect(results.some((x) => (x as any).attempts > 1)).toBe(true); // someone lost the lease race
    for (const id of ids) expect(await r.landings(taskKey("run5", id))).toBe(1);
  });

  test("real conflict: reported with the files, target untouched; rework after re-cut lands", async () => {
    const r = await bareRepo();
    await produceFakeWork(r.cfg, { ...req("run6", "x"), epoch: 1, path: "shared.txt", content: "line 1\nX\nline 3\n" });
    await produceFakeWork(r.cfg, { ...req("run6", "y"), epoch: 1, path: "shared.txt", content: "line 1\nY\nline 3\n" });
    expect((await mergeTask(req("run6", "x"), r.cfg)).status).toBe("merged");
    const before = await r.sha("main");
    const c = await mergeTask(req("run6", "y"), r.cfg);
    expect(c).toMatchObject({ status: "conflict", files: ["shared.txt"] });
    expect(await r.sha("main")).toBe(before);
    // Back to a worker: re-cut from the new tip and redo.
    await produceFakeWork(r.cfg, { ...req("run6", "y"), epoch: 2, rework: true, path: "shared.txt", content: "line 1\nX\nY\nline 3\n" });
    expect((await mergeTask(req("run6", "y"), r.cfg)).status).toBe("merged");
    expect(await r.show("main", "shared.txt")).toBe("line 1\nX\nY\nline 3");
  });

  test("per-target serialization: merges on one target run one at a time", async () => {
    const r = await bareRepo();
    let active = 0, peak = 0;
    const lockDir = join(r.root, "locks");
    await Promise.all([1, 2, 3].map(() => withTargetLock(lockDir, r.bare, "main", async () => {
      active++; peak = Math.max(peak, active); await Bun.sleep(30); active--;
    })));
    expect(peak).toBe(1);
  });

  test("protected flow: testOnly verifies but never pushes", async () => {
    const r = await bareRepo();
    await produceFakeWork(r.cfg, { ...req("run7", "t"), epoch: 1 });
    const before = await r.sha("main");
    expect((await mergeTask(req("run7", "t", { testOnly: true }), r.cfg)).status).toBe("verified");
    expect(await r.sha("main")).toBe(before);
  });

  test("hooks run on capcomd's own commits (pre-commit can veto a squash)", async () => {
    const r = await bareRepo();
    await produceFakeWork(r.cfg, { ...req("run8", "t"), epoch: 1 });
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "core.hooksPath";
    const hooks = join(r.root, "hooks");
    await Bun.write(join(hooks, "pre-commit"), "#!/bin/sh\necho vetoed by hook >&2\nexit 1\n");
    Bun.spawnSync(["chmod", "+x", join(hooks, "pre-commit")]);
    process.env.GIT_CONFIG_VALUE_0 = hooks;
    try {
      await expect(mergeTask(req("run8", "t"), r.cfg)).rejects.toThrow(/vetoed by hook/);
    } finally {
      delete process.env.GIT_CONFIG_COUNT; delete process.env.GIT_CONFIG_KEY_0; delete process.env.GIT_CONFIG_VALUE_0;
    }
    expect(await r.landings(taskKey("run8", "t"))).toBe(0);
  });
});

describe("merge after a verify: the fast path", () => {
  /** A check command that counts its runs in a file (the checks run on the host here). */
  const counted = (root: string) => ({ cmd: `echo run >> ${join(root, "check-runs")}; test -f tasks/$CAPCOMD_TASK_ID.md`, runs: async () => (await Bun.file(join(root, "check-runs")).text().catch(() => "")).split("\n").filter(Boolean).length });
  const verified = (v: any) => ({ sha: v.sha, targetSha: v.targetSha, how: v.how });

  test("target unchanged since the verify: the verified commit lands as it is, checks not run again", async () => {
    const r = await bareRepo();
    const c = counted(r.root);
    const tip = await produceFakeWork(r.cfg, { ...req("rf1", "t"), epoch: 1 });
    const v: any = await mergeTask(req("rf1", "t", { testOnly: true, testCommand: c.cmd }), r.cfg);
    expect(v).toMatchObject({ status: "verified", taskSha: tip, targetSha: await r.sha("main") });
    expect(await c.runs()).toBe(1);
    const m: any = await mergeTask(req("rf1", "t", { testCommand: c.cmd, expectSha: tip, verified: verified(v) }), r.cfg);
    expect(m).toMatchObject({ status: "merged", sha: v.sha, already: false, timings: { path: "fast" } });
    expect(m.timings.checksMs).toBeUndefined();
    expect(await c.runs()).toBe(1);
    expect(await r.sha("main")).toBe(v.sha);
    expect(await r.landings(taskKey("rf1", "t"))).toBe(1);
    // A retry (a crash after the push, before its record): the target is there already.
    const again: any = await mergeTask(req("rf1", "t", { testCommand: c.cmd, expectSha: tip, verified: verified(v) }), r.cfg);
    expect(again).toMatchObject({ status: "merged", already: true });
    expect(await r.landings(taskKey("rf1", "t"))).toBe(1);
  }, 60_000);

  test("target moved since the verify (by someone else): the push is refused, the merge checks again on the new target", async () => {
    const r = await bareRepo();
    const c = counted(r.root);
    const tip = await produceFakeWork(r.cfg, { ...req("rf2", "t"), epoch: 1 });
    const v: any = await mergeTask(req("rf2", "t", { testOnly: true, testCommand: c.cmd }), r.cfg);
    await r.pushToMain("other.txt", "moved\n");
    const moved = await r.sha("main");
    const m: any = await mergeTask(req("rf2", "t", { testCommand: c.cmd, expectSha: tip, verified: verified(v) }), r.cfg);
    expect(m).toMatchObject({ status: "merged", already: false, targetBefore: moved, timings: { path: "full", checksWhere: "host" } });
    expect(m.timings.fastFallback).toContain("moved");
    expect(await c.runs()).toBe(2);
    expect(await r.show("main", "other.txt")).toBe("moved");
    expect(await r.landings(taskKey("rf2", "t"))).toBe(1);
  }, 60_000);

  test("target moved by a merge from here: no doomed fast push, the checks run again from the clone's refs", async () => {
    const r = await bareRepo();
    const c = counted(r.root);
    const a = await produceFakeWork(r.cfg, { ...req("rf3", "a"), epoch: 1 });
    const b = await produceFakeWork(r.cfg, { ...req("rf3", "b"), epoch: 1 });
    const [va, vb]: any[] = await Promise.all([mergeTask(req("rf3", "a", { testOnly: true, testCommand: c.cmd }), r.cfg), mergeTask(req("rf3", "b", { testOnly: true, testCommand: c.cmd }), r.cfg)]);
    expect([va.status, vb.status]).toEqual(["verified", "verified"]);
    expect(va.timings.lockWaitMs).toBeUndefined(); // verifies don't queue on the target's lock
    expect((await mergeTask(req("rf3", "a", { testCommand: c.cmd, expectSha: a, verified: verified(va) }), r.cfg) as any).timings.path).toBe("fast");
    const mb: any = await mergeTask(req("rf3", "b", { testCommand: c.cmd, expectSha: b, verified: verified(vb) }), r.cfg);
    expect(mb).toMatchObject({ status: "merged", timings: { path: "full", fastFallback: "the target moved since the verify" } });
    expect(mb.timings.pushMs).toBeGreaterThanOrEqual(0);
    expect(await c.runs()).toBe(3);
    expect(await r.landings(taskKey("rf3", "a"))).toBe(1);
    expect(await r.landings(taskKey("rf3", "b"))).toBe(1);
  }, 60_000);

  test("branch moved since the verify: refused, whichever path", async () => {
    const r = await bareRepo();
    const tip = await produceFakeWork(r.cfg, { ...req("rf4", "t"), epoch: 1 });
    const v: any = await mergeTask(req("rf4", "t", { testOnly: true }), r.cfg);
    await produceFakeWork(r.cfg, { ...req("rf4", "t"), epoch: 2, rework: true, content: "sneaky\n" });
    const before = await r.sha("main");
    const m: any = await mergeTask(req("rf4", "t", { expectSha: tip, verified: verified(v) }), r.cfg);
    expect(m.status).toBe("failed");
    expect(m.reason).toContain("moved since verification");
    expect(await r.sha("main")).toBe(before);
  }, 60_000);
});

describe("direct merge crash recovery (real SIGKILL subprocess)", () => {
  for (const kp of ["merge.lock.acquired", "merge.after_fetch.before_integrate", "merge.before_cas", "merge.after_cas.before_event"]) {
    test(`crash at ${kp} → rerun lands exactly once`, async () => {
      const r = await bareRepo({ strategy: "squash" });
      const q = { ...req("runk", "t"), produce: true };
      const crashed = await sub({ ...r.env, CAPCOMD_KILLPOINT: `${kp}:1` }, q);
      expect(crashed.signal).toBe("SIGKILL");
      const pushedBeforeCrash = kp === "merge.after_cas.before_event";
      expect(await r.landings(taskKey("runk", "t"))).toBe(pushedBeforeCrash ? 1 : 0);
      const again = await sub(r.env, q);
      expect(again.code).toBe(0);
      const out = JSON.parse(again.out.trim().split("\n").pop()!);
      expect(out).toMatchObject({ status: "merged", already: pushedBeforeCrash });
      expect(await r.landings(taskKey("runk", "t"))).toBe(1);
    }, 30_000);
  }
});

describe("config", () => {
  test("defaults: pr mode, squash, main; none without CAPCOMD_REPO", () => {
    expect(loadMergeConfig({})).toBeNull();
    expect(loadMergeConfig({ CAPCOMD_REPO: "git@github.com:acme/w.git" })).toMatchObject({ mode: "pr", strategy: "squash", target: "main", github: { repo: "acme/w" } });
    expect(loadMergeConfig({ RELAY_REPO: "/x", RELAY_MERGE_MODE: "direct" })).toMatchObject({ mode: "direct" });
    expect(() => loadMergeConfig({ CAPCOMD_REPO: "/x", CAPCOMD_MERGE_STRATEGY: "octopus" })).toThrow();
    expect(loadMergeConfig({ CAPCOMD_REPO: "/x" }, { merge: { mode: "direct", strategy: "rebase", test: "bun test" } })).toMatchObject({ mode: "direct", strategy: "rebase", testCommand: "bun test" });
  });
});

describe("signed commits", () => {
  test("CAPCOMD_SIGN_COMMITS=1 signs capcomd's commit via the user's git signing setup (gpg.program)", async () => {
    const r = await bareRepo({ extraEnv: { CAPCOMD_SIGN_COMMITS: "1" } });
    // Stand-in signer with git's gpg.program contract: data on stdin, armored sig on stdout, SIG_CREATED on the status fd.
    const signer = join(r.root, "fake-gpg");
    await Bun.write(signer, "#!/bin/sh\ncat >/dev/null\necho '[GNUPG:] SIG_CREATED D 1 8 00 0 0 0' >&2\nprintf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n-----END PGP SIGNATURE-----\\n'\n");
    Bun.spawnSync(["chmod", "+x", signer]);
    Object.assign(process.env, { GIT_CONFIG_COUNT: "2", GIT_CONFIG_KEY_0: "gpg.program", GIT_CONFIG_VALUE_0: signer, GIT_CONFIG_KEY_1: "user.signingkey", GIT_CONFIG_VALUE_1: "TESTKEY" });
    try {
      await produceFakeWork(r.cfg, { ...req("runs", "t"), epoch: 1 });
      await r.pushToMain("moved.txt", "m\n");
      const out = await mergeTask(req("runs", "t"), r.cfg);
      expect(out.status).toBe("merged");
      const raw = Bun.spawnSync(["git", "cat-file", "-p", "main"], { cwd: r.bare }).stdout.toString();
      expect(raw).toContain("gpgsig -----BEGIN PGP SIGNATURE-----");
    } finally {
      for (const k of ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0", "GIT_CONFIG_KEY_1", "GIT_CONFIG_VALUE_1"]) delete process.env[k];
    }
  });
});
