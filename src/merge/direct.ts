import { killpoint } from "../utils/killpoint";
import type { MergeConfig } from "./config";
import { taskKey, withRepoFile } from "./config";
import { findExistingMerge, openClone } from "./repo";
import { integrate } from "./integrate";
import { runTests } from "./verify";
import type { MergeOutcome, MergeRequest } from "./types";

/** Test seam: runs right before the push (e.g. to move the target and force a lease rejection). */
export const testHooks: { beforePush?: (attempt: number) => Promise<void> } = {};

const LEASE_REJECTED = /stale info|\(fetch first\)|non-fast-forward|\[rejected\]|failed to update ref|cannot lock ref|reference already exists|incorrect old value/i;

/**
 * direct mode: integrate → verify → push --force-with-lease=<target>:<expected sha>.
 * A rejected push means someone else moved the target: re-fetch, re-check idempotency,
 * re-integrate, re-verify, retry (≤ maxPushRetries). Caller holds the per-target lock.
 */
export async function directMerge(baseCfg: MergeConfig, req: MergeRequest, cloneName: string): Promise<MergeOutcome> {
  const key = taskKey(req.runId, req.taskId);
  let attempts = 0;
  for (;;) {
    attempts++;
    const git = await openClone(baseCfg, cloneName);
    const targetRef = `refs/remotes/origin/${req.target}`;
    const targetSha = await git.revParse(targetRef);
    if (!targetSha) return { status: "failed", reason: `target branch ${req.target} not found on ${baseCfg.remote}` };
    const taskSha = await git.revParse(`refs/remotes/origin/${req.branch}`);

    const existing = await findExistingMerge(git, targetRef, taskSha, key);
    if (existing) {
      return { status: "merged", sha: existing.sha, already: true, how: existing.how, strategy: baseCfg.strategy, mode: "direct", attempts };
    }
    if (!taskSha) return { status: "failed", reason: `task branch ${req.branch} not found on ${baseCfg.remote}` };

    await git.ok(["checkout", "-q", "--detach", "-f", targetSha]);
    const cfg = withRepoFile(baseCfg, git.cwd);
    killpoint("merge.after_fetch.before_integrate");

    const subject = (await git.ok(["log", "-1", "--format=%s", taskSha])) || `capcomd ${key}`;
    const merged = await integrate(git, cfg, cfg.strategy, targetSha, taskSha, key, subject);
    if (!merged.ok) return { status: "conflict", files: merged.files, targetSha, taskSha };

    const tests = await runTests(git, cfg.testCommand, { CAPCOMD_RUN_ID: req.runId, CAPCOMD_TASK_ID: req.taskId, CAPCOMD_TARGET: req.target });
    if (!tests.passed) return { status: "failed", reason: "tests failed on branch merged with latest target", output: tests.output };
    if (req.testOnly) return { status: "verified", sha: merged.head, output: tests.output };
    if (merged.head === targetSha) {
      return { status: "merged", sha: targetSha, already: true, how: "noop", strategy: cfg.strategy, mode: "direct", attempts };
    }

    killpoint("merge.before_cas");
    if (testHooks.beforePush) await testHooks.beforePush(attempts);
    // Pre-push hooks run. Lease = compare-and-swap on the remote ref.
    const push = await git.run(["push", "--porcelain", `--force-with-lease=refs/heads/${req.target}:${targetSha}`, "origin", `${merged.head}:refs/heads/${req.target}`]);
    if (push.code === 0) {
      killpoint("merge.after_cas.before_event");
      return { status: "merged", sha: merged.head, already: false, how: merged.how, strategy: cfg.strategy, mode: "direct", attempts, targetBefore: targetSha };
    }
    const text = push.stdout + push.stderr;
    if (!LEASE_REJECTED.test(text)) return { status: "failed", reason: `push failed: ${text.trim().slice(-500)}` };
    if (attempts > cfg.maxPushRetries) return { status: "failed", reason: `push rejected ${attempts} times (target keeps moving); last: ${text.trim().slice(-300)}` };
    // Lease rejected: loop → fetch, idempotency check, rebase onto the new tip, re-verify.
  }
}
