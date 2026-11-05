// `capcomd check <ref>` (docs/spec/plugin-api.md §16.1): the run's checks on one commit of a branch as it is. Nothing is
// integrated, merged or pushed, and nothing is reviewed: it is how an orchestrate agent (or anyone) knows whether the
// combined code (a goal branch, a target after merges, a child's branch) passes, without running anything itself. The
// command runs where verify's does (a fresh sandbox of the run's provider, or this host with the test fakes).
import { withSpan } from "../utils/tracing-simple";
import type { MergeConfig } from "./config";
import { withRepoFile } from "./config";
import { withWorktree } from "./repo";
import { runTests, type ChecksMode, type ChecksStage } from "./verify";

/** How much of a check's output is kept: its end, up to this many characters. */
export const CHECK_OUTPUT_CHARS = 64 * 1024;

export interface CheckRequest {
  runId: string;
  /** The check's id (chk-…): the checks see it as CAPCOMD_TASK_ID. */
  checkId: string;
  branch: string;
  /** The commit to check: the branch's tip when the check was asked for. */
  sha: string;
  /** The command, when the caller named one (`--check NAME`, `--checks CMD`); else the repository's. */
  testCommand?: string;
  /** Called just before the command really runs (not for a reused pass): may wait, returns what to call after. */
  beforeRun?: (where: ChecksMode, source: Record<string, string | undefined>) => Promise<() => void>;
}

export type CheckOutcome =
  | { status: "passed" | "failed"; sha: string; command: string; output: string; where: ChecksMode | "reused" | "none"; stage?: ChecksStage; fetchMs: number; checksMs: number }
  /** missing: the branch or the commit isn't on the repository; error: the check couldn't run (no machine slot came
   *  free, git or the sandbox failed). Neither ran the command. */
  | { status: "missing" | "error"; reason: string; fetchMs: number };

/**
 * Check `req.sha` (the tip of `req.branch` when asked): fetched into a private worktree of the run's clone (the one its
 * verifies and merges share, so a tree that already passed the same command there isn't run again), checked out
 * detached, and the command run on it. A branch that moved since is still checked at `req.sha` when the clone has it.
 */
export async function checkCommit(cfg: MergeConfig, req: CheckRequest): Promise<CheckOutcome> {
  const f0 = Date.now();
  const out = await withWorktree(cfg, `${req.runId}-merge`, `refs/remotes/origin/${req.branch}`, async (git): Promise<CheckOutcome> => {
    const fetchMs = Date.now() - f0;
    if ((await git.run(["cat-file", "-e", `${req.sha}^{commit}`])).code !== 0) return { status: "missing", reason: `commit ${req.sha.slice(0, 12)} of ${req.branch} isn't on ${cfg.remote} any more`, fetchMs };
    await git.ok(["checkout", "-q", "--detach", "-f", req.sha]);
    // The repository's own settings at that commit (`.capcomd.json`), as a merge onto it would read them.
    const command = req.testCommand ?? withRepoFile(cfg, git.cwd).testCommand;
    const c0 = Date.now();
    const t = await withSpan("check.run", { "relay.run_id": req.runId, "git.ref": req.branch, "git.sha": req.sha }, () =>
      runTests(git, command, { CAPCOMD_RUN_ID: req.runId, CAPCOMD_TASK_ID: req.checkId, CAPCOMD_TARGET: req.branch }, { outputChars: CHECK_OUTPUT_CHARS, ...(req.beforeRun ? { beforeRun: req.beforeRun } : {}) }));
    return { status: t.passed ? "passed" : "failed", sha: req.sha, command, output: t.output, where: command.trim() ? (t.where ?? "host") : "none", ...(t.stage ? { stage: t.stage } : {}), fetchMs, checksMs: Date.now() - c0 };
  });
  return out ?? { status: "missing", reason: `branch ${req.branch} not found on ${cfg.remote}`, fetchMs: Date.now() - f0 };
}
