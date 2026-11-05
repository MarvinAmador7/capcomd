import { killpoint } from "../utils/killpoint";
import type { MergeConfig } from "./config";
import { taskKey, withRepoFile } from "./config";
import { findExistingMerge, openClone } from "./repo";
import { integrate } from "./integrate";
import { checksFailReason, runTests } from "./verify";
import type { MergeOutcome, MergeRequest } from "./types";
import { MergeRetryableError } from "./types";
import type { Forge } from "../../packages/plugin/src/seams";
import { land, withForge } from "../plugins/forges";

/** What a pull request's calls around the wait may take, on top of the project's wait (CAPCOMD_GITHUB_TIMEOUT_MS). */
const PR_CALLS_MS = 5 * 60_000;

/**
 * pr mode (default): verify locally on the branch merged with the latest target, then hand the checked head to the
 * project's forge (docs/spec/plugin-api.md §7.4), which opens (or finds) the pull request and has the hosting service
 * merge it. Branch protection, required checks and the merge queue decide; capcomd waits and records the merged sha.
 * Idempotent: a merged PR for the head branch, or the task already in the target (git), is recorded without merging
 * again. Called under the target's lock.
 */
export async function prMerge(baseCfg: MergeConfig, req: MergeRequest, forge: Forge, cloneName: string): Promise<MergeOutcome> {
  const key = taskKey(req.runId, req.taskId);
  const scope = { merge: baseCfg };

  const existingPr = await withForge(scope, PR_CALLS_MS, (c) => forge.findPullRequest({ remote: baseCfg.remote, head: req.branch, base: req.target }, c));
  if (existingPr?.state === "merged" && existingPr.mergeSha) {
    return { status: "merged", sha: existingPr.mergeSha, already: true, how: "pr-already-merged", strategy: baseCfg.strategy, mode: "pr", attempts: 0, pr: existingPr.number };
  }

  const git = await openClone(baseCfg, cloneName);
  const targetRef = `refs/remotes/origin/${req.target}`;
  const targetSha = await git.revParse(targetRef);
  if (!targetSha) return { status: "failed", reason: `target branch ${req.target} not found` };
  const taskSha = await git.revParse(`refs/remotes/origin/${req.branch}`);
  const existing = await findExistingMerge(git, targetRef, taskSha, key);
  if (existing) return { status: "merged", sha: existing.sha, already: true, how: existing.how, strategy: baseCfg.strategy, mode: "pr", attempts: 0, pr: existingPr?.number };
  if (!taskSha) return { status: "failed", reason: `task branch ${req.branch} not pushed` };

  if (req.expectSha && taskSha !== req.expectSha) return { status: "failed", reason: `branch ${req.branch} moved since verification (${req.expectSha.slice(0, 12)} → ${taskSha.slice(0, 12)})` };
  await git.ok(["checkout", "-q", "--detach", "-f", targetSha]);
  const cfg = withRepoFile(baseCfg, git.cwd);
  const subject = (await git.ok(["log", "-1", "--format=%s", taskSha])) || `capcomd ${key}`;
  const trial = await integrate(git, cfg, cfg.strategy, targetSha, taskSha, key, subject);
  if (!trial.ok) return { status: "conflict", files: trial.files, targetSha, taskSha };
  const tests = await runTests(git, req.testCommand ?? cfg.testCommand, { CAPCOMD_RUN_ID: req.runId, CAPCOMD_TASK_ID: req.taskId, CAPCOMD_TARGET: req.target });
  if (!tests.passed) return { status: "failed", reason: checksFailReason(tests), output: tests.output };
  if (req.testOnly) return { status: "verified", sha: trial.head, output: tests.output, taskSha, targetSha, how: trial.how };

  // The forge lands it: the pull request is merged at exactly the head the checks ran on.
  const out = await land(forge, {
    runId: req.runId, mrgId: req.gate?.merge.mrgId ?? key, remote: cfg.remote, repo: cfg.github.repo, branch: req.branch, target: req.target,
    sha: trial.head, targetSha, branchSha: taskSha, mode: "pr", strategy: cfg.strategy, subject, body: `Opened by capcomd.\n\nCapcomd-Task: ${key}`,
    trailers: { "Capcomd-Task": key }, workdir: git.cwd,
  }, { merge: cfg }, cfg.github.timeoutMs + PR_CALLS_MS).catch((e) => {
    if (e instanceof Error && e.name === "PluginError" && (e as { code?: string }).code === "timeout") throw new MergeRetryableError(e.message);
    throw e;
  });
  if (out.status === "conflict") return { status: "conflict", files: [], targetSha, taskSha };
  if (out.status === "failed") {
    if (out.retryable) throw new MergeRetryableError(out.reason);
    return { status: "failed", reason: out.reason };
  }
  killpoint("merge.after_pr_merge.before_event");
  return { status: "merged", sha: out.sha, already: out.already, how: out.how, strategy: cfg.strategy, mode: "pr", attempts: out.already ? 0 : 1, ...(out.pr !== null ? { pr: out.pr } : {}), ...(out.already ? {} : { targetBefore: targetSha }) };
}
