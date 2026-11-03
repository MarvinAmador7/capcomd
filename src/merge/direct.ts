import { existsSync } from "fs";
import { join } from "path";
import { killpoint } from "../utils/killpoint";
import { withSpan } from "../utils/tracing-simple";
import type { MergeConfig } from "./config";
import { taskKey, withRepoFile } from "./config";
import { Git } from "./git";
import { cloneDir, findExistingMerge, openClone, withCloneLock, withWorktree } from "./repo";
import { integrate } from "./integrate";
import { runTests } from "./verify";
import type { MergeOutcome, MergeRequest, MergeTimings } from "./types";

/** Test seam: runs right before the push (e.g. to move the target and force a lease rejection). `beforeFastPush`: before
 *  the fast path's push of a verified commit. */
export const testHooks: { beforePush?: (attempt: number) => Promise<void>; beforeFastPush?: () => Promise<void> } = {};

const LEASE_REJECTED = /stale info|\(fetch first\)|non-fast-forward|\[rejected\]|failed to update ref|cannot lock ref|reference already exists|incorrect old value/i;

const since = (t: number) => Date.now() - t;
const span = <T>(name: string, req: MergeRequest, fn: () => Promise<T>) =>
  withSpan(name, { "relay.run_id": req.runId, "git.ref": req.branch, "git.target": req.target }, fn);

/**
 * The branch on the target, checked: integrate it per the repo's strategy onto `targetSha` (detached, in `git`'s
 * worktree) and run the checks on the result. `merged` is the commit made (its tree is what passed).
 */
async function trial(git: Git, baseCfg: MergeConfig, req: MergeRequest, targetSha: string, taskSha: string, t: MergeTimings) {
  const key = taskKey(req.runId, req.taskId);
  await git.ok(["checkout", "-q", "--detach", "-f", targetSha]);
  const cfg = withRepoFile(baseCfg, git.cwd);
  killpoint("merge.after_fetch.before_integrate");
  const i0 = Date.now();
  const subject = (await git.ok(["log", "-1", "--format=%s", taskSha])) || `capcomd ${key}`;
  const merged = await span("merge.integrate", req, () => integrate(git, cfg, cfg.strategy, targetSha, taskSha, key, subject));
  t.integrateMs = (t.integrateMs ?? 0) + since(i0);
  if (!merged.ok) return { cfg, merged, tests: null };
  const c0 = Date.now();
  const tests = await span("merge.checks", req, () => runTests(git, req.testCommand ?? cfg.testCommand, { CAPCOMD_RUN_ID: req.runId, CAPCOMD_TASK_ID: req.taskId, CAPCOMD_TARGET: req.target }));
  t.checksMs = (t.checksMs ?? 0) + since(c0);
  t.checksWhere = tests.where ?? "none";
  return { cfg, merged, tests };
}

/**
 * direct-mode verify (testOnly): the branch on the latest target, checked, never pushed. In a private worktree of the
 * run's clone, so verifies of one target run side by side (only the fetch and the worktree's setup share a lock); the
 * commit it makes stays in the clone, for the merge's fast path.
 */
export async function directVerify(baseCfg: MergeConfig, req: MergeRequest, cloneName: string): Promise<MergeOutcome> {
  const key = taskKey(req.runId, req.taskId);
  const t: MergeTimings = {};
  const f0 = Date.now();
  const out = await withWorktree(baseCfg, cloneName, `refs/remotes/origin/${req.target}`, async (git): Promise<MergeOutcome> => {
    t.fetchMs = since(f0);
    // The worktree is at the target as this fetch saw it (a later fetch by another verify moves only the shared refs).
    const targetSha = (await git.ok(["rev-parse", "HEAD"])).trim();
    const taskSha = await git.revParse(`refs/remotes/origin/${req.branch}`);
    const existing = await findExistingMerge(git, targetSha, taskSha, key);
    if (existing) return { status: "merged", sha: existing.sha, already: true, how: existing.how, strategy: baseCfg.strategy, mode: "direct", attempts: 0 };
    if (!taskSha) return { status: "failed", reason: `task branch ${req.branch} not found on ${baseCfg.remote}` };
    if (req.expectSha && taskSha !== req.expectSha) return { status: "failed", reason: `branch ${req.branch} moved since verification (${req.expectSha.slice(0, 12)} → ${taskSha.slice(0, 12)})` };
    const { merged, tests } = await trial(git, baseCfg, req, targetSha, taskSha, t);
    if (!merged.ok) return { status: "conflict", files: merged.files, targetSha, taskSha };
    if (!tests!.passed) return { status: "failed", reason: "tests failed on branch merged with latest target", output: tests!.output };
    return { status: "verified", sha: merged.head, output: tests!.output, taskSha, targetSha, how: merged.how };
  }, req.branchSha ? { has: { ref: `refs/remotes/origin/${req.branch}`, sha: req.branchSha } } : {});
  return { ...(out ?? { status: "failed", reason: `target branch ${req.target} not found on ${baseCfg.remote}` }), timings: t };
}

/**
 * The fast path of a merge after a passing verify (direct mode): push the very commit the verify made and checked, in
 * one atomic push whose leases say the target is still where the verify put the branch on it and the branch is still
 * the verified commit. One round trip to the remote, no fetch, integration or check run. Anything else (the target or
 * the branch moved, the commit isn't in this clone, the remote has no atomic pushes) is a fallback to the full path.
 */
async function landVerified(baseCfg: MergeConfig, req: MergeRequest, cloneName: string, t: MergeTimings): Promise<MergeOutcome | { fallback: string }> {
  const v = req.verified!;
  if (!req.expectSha) return { fallback: "no verified branch commit" };
  if (v.sha === v.targetSha) return { fallback: "the verified change is already on the target" };
  const dir = cloneDir(baseCfg, cloneName);
  if (!existsSync(join(dir, ".git"))) return { fallback: "the verify's clone is gone" };
  const git = new Git(dir);
  if ((await git.run(["cat-file", "-e", `${v.sha}^{commit}`])).code !== 0) return { fallback: "the verified commit isn't in the clone" };
  if (!(await git.isAncestor(v.targetSha, v.sha))) return { fallback: "the verified commit isn't on the target it was verified on" };
  killpoint("merge.before_cas");
  if (testHooks.beforeFastPush) await testHooks.beforeFastPush();
  const p0 = Date.now();
  const push = await withCloneLock(baseCfg, cloneName, () => span("merge.push", req, () => git.run(["push", "--porcelain", "--atomic",
    `--force-with-lease=refs/heads/${req.target}:${v.targetSha}`, `--force-with-lease=refs/heads/${req.branch}:${req.expectSha}`,
    "origin", `${v.sha}:refs/heads/${req.target}`, `${req.expectSha}:refs/heads/${req.branch}`])));
  t.pushMs = since(p0);
  if (push.code !== 0) return { fallback: LEASE_REJECTED.test(push.stdout + push.stderr) ? "the target or the branch moved since the verify" : `push failed: ${(push.stdout + push.stderr).trim().slice(-300)}` };
  killpoint("merge.after_cas.before_event");
  // "=" for the target: it was there already (a retry after a crash between the push and its record).
  const already = push.stdout.split("\n").some((l) => l.startsWith("=") && l.includes(`:refs/heads/${req.target}\t`));
  return { status: "merged", sha: v.sha, already, how: v.how ?? baseCfg.strategy, strategy: baseCfg.strategy, mode: "direct", attempts: 1, targetBefore: v.targetSha };
}

/**
 * direct mode: integrate → verify → push --force-with-lease=<target>:<expected sha>.
 * A rejected push means someone else moved the target: re-fetch, re-check idempotency,
 * re-integrate, re-verify, retry (≤ maxPushRetries). Caller holds the per-target lock.
 * With `req.verified` (a passing verify's commit), the fast path is tried first: see landVerified.
 */
export async function directMerge(baseCfg: MergeConfig, req: MergeRequest, cloneName: string, t: MergeTimings = {}): Promise<MergeOutcome> {
  if (req.testOnly) return directVerify(baseCfg, req, cloneName);
  const targetRef = `refs/remotes/origin/${req.target}`;
  // The clone's view of the target: its last fetch, or this host's last push to it (a push moves it too).
  const local = req.verified && existsSync(join(cloneDir(baseCfg, cloneName), ".git")) ? await new Git(cloneDir(baseCfg, cloneName)).revParse(targetRef) : null;
  if (req.verified) {
    // Known to have moved (a merge from here landed on it since the verify): the fast push would only be refused.
    const fast = local && local !== req.verified.targetSha ? { fallback: "the target moved since the verify" } : await landVerified(baseCfg, req, cloneName, t);
    if (!("fallback" in fast)) return { ...fast, timings: { ...t, path: "fast" } };
    t.fastFallback = fast.fallback;
  }
  t.path = "full";
  const done = (o: MergeOutcome): MergeOutcome => ({ ...o, timings: t });
  const key = taskKey(req.runId, req.taskId);
  // After a verify, the first attempt works from the clone's refs without a fetch when they hold the verified branch
  // commit: on a run's goal branch capcomd is the only writer, so they are current, and if not, the push's lease
  // refuses and the next attempt fetches.
  let fetch = !(req.verified && local && req.expectSha);
  let attempts = 0;
  for (;;) {
    attempts++;
    const f0 = Date.now();
    const git = await openClone(baseCfg, cloneName, { fetch });
    t.fetchMs = (t.fetchMs ?? 0) + since(f0);
    const targetSha = await git.revParse(targetRef);
    const taskSha = await git.revParse(`refs/remotes/origin/${req.branch}`);
    if (!fetch && (!targetSha || taskSha !== req.expectSha)) { fetch = true; attempts--; continue; }
    // Unfetched refs: the push also leases the branch (atomically), so a branch that moved since is still refused.
    const leaseBranch = !fetch;
    fetch = true;
    if (!targetSha) return done({ status: "failed", reason: `target branch ${req.target} not found on ${baseCfg.remote}` });

    const existing = await findExistingMerge(git, targetRef, taskSha, key);
    if (existing) {
      return done({ status: "merged", sha: existing.sha, already: true, how: existing.how, strategy: baseCfg.strategy, mode: "direct", attempts });
    }
    if (!taskSha) return done({ status: "failed", reason: `task branch ${req.branch} not found on ${baseCfg.remote}` });

    if (req.expectSha && taskSha !== req.expectSha) return done({ status: "failed", reason: `branch ${req.branch} moved since verification (${req.expectSha.slice(0, 12)} → ${taskSha.slice(0, 12)})` });
    const { cfg, merged, tests } = await trial(git, baseCfg, req, targetSha, taskSha, t);
    if (!merged.ok) return done({ status: "conflict", files: merged.files, targetSha, taskSha });
    if (!tests!.passed) return done({ status: "failed", reason: "tests failed on branch merged with latest target", output: tests!.output });
    if (merged.head === targetSha) {
      return done({ status: "merged", sha: targetSha, already: true, how: "noop", strategy: cfg.strategy, mode: "direct", attempts });
    }

    killpoint("merge.before_cas");
    if (testHooks.beforePush) await testHooks.beforePush(attempts);
    // Pre-push hooks run. Lease = compare-and-swap on the remote ref.
    const p0 = Date.now();
    const push = await withCloneLock(baseCfg, cloneName, () => span("merge.push", req, () => git.run(leaseBranch
      ? ["push", "--porcelain", "--atomic", `--force-with-lease=refs/heads/${req.target}:${targetSha}`, `--force-with-lease=refs/heads/${req.branch}:${req.expectSha}`, "origin", `${merged.head}:refs/heads/${req.target}`, `${req.expectSha}:refs/heads/${req.branch}`]
      : ["push", "--porcelain", `--force-with-lease=refs/heads/${req.target}:${targetSha}`, "origin", `${merged.head}:refs/heads/${req.target}`])));
    t.pushMs = (t.pushMs ?? 0) + since(p0);
    if (push.code === 0) {
      killpoint("merge.after_cas.before_event");
      return done({ status: "merged", sha: merged.head, already: false, how: merged.how, strategy: cfg.strategy, mode: "direct", attempts, targetBefore: targetSha });
    }
    const text = push.stdout + push.stderr;
    // No atomic pushes on this remote: the next attempt fetches and pushes the target alone, as before.
    if (leaseBranch && /atomic/i.test(text) && !LEASE_REJECTED.test(text)) { attempts--; continue; }
    if (!LEASE_REJECTED.test(text)) return done({ status: "failed", reason: `push failed: ${text.trim().slice(-500)}` });
    if (attempts > cfg.maxPushRetries) return done({ status: "failed", reason: `push rejected ${attempts} times (target keeps moving); last: ${text.trim().slice(-300)}` });
    // Lease rejected: loop → fetch, idempotency check, rebase onto the new tip, re-verify.
  }
}
