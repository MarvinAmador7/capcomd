import { join } from "path";
import { killpoint } from "../utils/killpoint";
import { loadMergeConfig, type MergeConfig } from "./config";
import { withTargetLock } from "./lock";
import { directMerge, directVerify } from "./direct";
import { prMerge } from "./pr";
import { HttpGitHub, githubToken, type GitHubApi } from "./github";
import type { MergeOutcome, MergeRequest, MergeTimings } from "./types";

let githubOverride: GitHubApi | null = null;
/** Tests inject a fake GitHub adapter. */
export function setGitHubApi(api: GitHubApi | null) { githubOverride = api; }
/** A test injected a GitHub adapter (so no login is needed). */
export const hasGitHubOverride = () => githubOverride !== null;

/** The GitHub API for `cfg`'s repository: the injected fake, else REST with the user's token (GITHUB_TOKEN, GH_TOKEN, `gh auth token`). */
export async function github(cfg: MergeConfig): Promise<GitHubApi> {
  return githubOverride ?? new HttpGitHub(cfg.github.api, await githubToken());
}

/**
 * Land (or, with testOnly, just verify) one task. Serialized per (remote, target).
 * Returns `mode: "none"` when no repository is configured (explicit dry run).
 */
export async function mergeTask(req: MergeRequest, cfg: MergeConfig | null = loadMergeConfig()): Promise<MergeOutcome> {
  if (!cfg) {
    // No repo: nothing to merge. Kept so the orchestrator runs without git (and the old killpoints still fire).
    killpoint("merge.before_cas");
    killpoint("merge.after_cas.before_event");
    return req.testOnly
      ? { status: "verified", sha: "", output: "(no repository configured)" }
      : { status: "merged", sha: "", already: false, how: "none", strategy: "none", mode: "none", attempts: 0 };
  }
  const clone = `${req.runId}-merge`;
  const direct = (req.mode ?? cfg.mode) === "direct";
  // A direct-mode verify pushes nothing: it works in a worktree of its own, beside the others and the merges.
  if (direct && req.testOnly) return directVerify(cfg, req, clone);
  const asked = Date.now();
  return withTargetLock(join(cfg.workdir, "locks"), cfg.remote, req.target, async () => {
    killpoint("merge.lock.acquired");
    const t: MergeTimings = { lockWaitMs: Date.now() - asked };
    if (direct) return directMerge(cfg, req, clone, t);
    const out = await prMerge(cfg, req, await github(cfg), clone);
    return { ...out, timings: { ...t, ...out.timings } };
  });
}
