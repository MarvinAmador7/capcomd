import { join } from "path";
import { killpoint } from "../utils/killpoint";
import { loadMergeConfig, type MergeConfig } from "./config";
import { withTargetLock } from "./lock";
import { directMerge } from "./direct";
import { prMerge } from "./pr";
import { HttpGitHub, githubToken, type GitHubApi } from "./github";
import type { MergeOutcome, MergeRequest } from "./types";

let githubOverride: GitHubApi | null = null;
/** Tests inject a fake GitHub adapter. */
export function setGitHubApi(api: GitHubApi | null) { githubOverride = api; }

async function github(cfg: MergeConfig): Promise<GitHubApi> {
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
  return withTargetLock(join(cfg.workdir, "locks"), cfg.remote, req.target, async () => {
    killpoint("merge.lock.acquired");
    return cfg.mode === "direct" ? directMerge(cfg, req, clone) : prMerge(cfg, req, await github(cfg), clone);
  });
}
