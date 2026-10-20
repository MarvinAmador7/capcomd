import { killpoint } from "../utils/killpoint";
import type { MergeConfig } from "./config";
import { taskKey, withRepoFile } from "./config";
import type { GitHubApi, PullRequest } from "./github";
import { findExistingMerge, openClone } from "./repo";
import { integrate } from "./integrate";
import { runTests } from "./verify";
import type { MergeOutcome, MergeRequest } from "./types";
import { MergeRetryableError } from "./types";

/**
 * pr mode (default): verify locally on the branch merged with the latest target, then open (or
 * find) the PR and ask GitHub to merge it. Branch protection, required checks and the merge queue
 * decide; capcomd waits and records the merged sha. Idempotent: a merged PR for the head branch,
 * or the task already in the target (git), is recorded without merging again.
 */
export async function prMerge(baseCfg: MergeConfig, req: MergeRequest, gh: GitHubApi, cloneName: string, sleep = (ms: number) => Bun.sleep(ms)): Promise<MergeOutcome> {
  const repo = baseCfg.github.repo;
  if (!repo) return { status: "failed", reason: `pr mode needs a GitHub repo (CAPCOMD_GITHUB_REPO or a github.com remote); remote is ${baseCfg.remote}` };
  const key = taskKey(req.runId, req.taskId);

  const existingPr = await gh.findPullByHead(repo, req.branch, req.target);
  if (existingPr?.merged && existingPr.merge_commit_sha) {
    return { status: "merged", sha: existingPr.merge_commit_sha, already: true, how: "pr-already-merged", strategy: baseCfg.strategy, mode: "pr", attempts: 0, pr: existingPr.number };
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
  if (!tests.passed) return { status: "failed", reason: "tests failed on branch merged with latest target", output: tests.output };
  if (req.testOnly) return { status: "verified", sha: trial.head, output: tests.output, taskSha };

  let pr: PullRequest = existingPr && existingPr.state === "open"
    ? existingPr
    : await gh.createPull(repo, { head: req.branch, base: req.target, title: subject, body: `Opened by capcomd.\n\nCapcomd-Task: ${key}` });

  killpoint("merge.pr.before_merge");
  const commitMessage = `Capcomd-Task: ${key}`;
  let res = await gh.mergePull(repo, pr.number, { merge_method: cfg.strategy, sha: taskSha, commit_title: `${subject} (#${pr.number})`, commit_message: commitMessage });
  if (!res.merged && (res.status === 405 || res.status === 409)) {
    // Protection, pending required checks or a merge queue: hand it to auto-merge and wait.
    await gh.enableAutoMerge(repo, pr, cfg.strategy).catch(() => false);
    const deadline = Date.now() + cfg.github.timeoutMs;
    for (;;) {
      pr = await gh.getPull(repo, pr.number);
      if (pr.merged && pr.merge_commit_sha) break;
      if (pr.state === "closed") return { status: "failed", reason: `PR #${pr.number} was closed without merging` };
      if (pr.mergeable_state === "dirty") {
        return { status: "conflict", files: [], targetSha, taskSha };
      }
      if (Date.now() > deadline) throw new MergeRetryableError(`PR #${pr.number} not merged after ${cfg.github.timeoutMs}ms (${res.message ?? pr.mergeable_state})`);
      await sleep(cfg.github.pollMs);
      // Some repos have no auto-merge: retry the merge call once checks may have passed.
      if (pr.mergeable_state === "clean") {
        res = await gh.mergePull(repo, pr.number, { merge_method: cfg.strategy, sha: taskSha, commit_title: `${subject} (#${pr.number})`, commit_message: commitMessage });
        if (res.merged) { pr = await gh.getPull(repo, pr.number); break; }
      }
    }
  } else if (!res.merged) {
    return { status: "failed", reason: `GitHub refused merge of PR #${pr.number} (${res.status}): ${res.message}` };
  } else {
    pr = await gh.getPull(repo, pr.number);
  }
  killpoint("merge.after_pr_merge.before_event");
  return { status: "merged", sha: pr.merge_commit_sha ?? res.sha ?? "", already: false, how: `pr-${cfg.strategy}`, strategy: cfg.strategy, mode: "pr", attempts: 1, pr: pr.number, targetBefore: targetSha };
}
