# ADR-013: Real git merges replace the faked merge CAS

Status: accepted (2026-10-19). Default mode: **pr** (chosen by Marvin).

## Context
`merge.before_cas` / `merge.after_cas.before_event` guarded a merge that never touched git. A task could be marked
`merged` without any commit landing, and nothing reconciled against the repository.

## Decision
`src/merge/` implements merges against a real remote. `mergeTask(req, cfg)` is the only entry point, called by the
verifier actor. Without `CAPCOMD_REPO` it is an explicit dry run (`mode:"none"`).

- **Branches**: one per task, `capcomd/<run>/<task>`, cut from the target tip. Commits carry `Capcomd-Task: <run>/<task>`
  (merge commits: `Capcomd-Merge:`).
- **Verify on the merged result**: the task is trial-integrated onto the latest target, then `CAPCOMD_TEST_COMMAND` runs there.
- **pr mode (default)**: typed `GitHubApi` adapter (REST + GraphQL auto-merge). It finds or creates the PR and merges it.
  On 405/409 (branch protection, required checks, merge queue) it enables auto-merge and polls. GitHub decides; the merged
  sha comes from GitHub. `dirty` means conflict; `closed` means failed; timeout is retryable.
- **direct mode**: ff, then rebase, then merge per strategy (`squash|rebase|merge`). The push is a real CAS:
  `--force-with-lease=refs/heads/<target>:<expected sha>`. On a lease rejection it refetches, re-integrates, re-tests and
  retries, up to `CAPCOMD_MERGE_MAX_RETRIES` (5).
- **Conflicts**: the conflicting files are returned. The task goes back to `pending` (retry+1, epoch+1, rework branch from the
  new tip) within its retry budget, else `failed` (escalated) with `context.conflict`.
- **Serialization**: per (remote, target). An in-process promise chain plus an O_EXCL lock file {pid, starttime}; a lock
  left by a dead owner is stolen.
- **Idempotent recovery, git wins**: before any work it checks (1) task tip is an ancestor of the target, (2) a trailer on the
  target, (3) `git cherry` patch-id, (4) pr mode: a merged PR for the head. Any hit is recorded as `already:true` and never merged again.
- **Protected targets**: the verifier runs `testOnly`; the task waits in `awaiting_approval`; `APPROVED` leads to `approved`, and the
  run loop then merges and records `MERGED`. Signed commits (`CAPCOMD_SIGN_COMMITS`, `-S`) and repo hooks are honored; we
  never pass `--no-verify`.
- **Config**: env `CAPCOMD_MERGE_*` / `CAPCOMD_GITHUB_*`, or `.capcomd.json` `{merge:{...}}`.

## Crash points
`merge.lock.acquired`, `merge.after_fetch.before_integrate`, `merge.before_cas`, `merge.after_cas.before_event`,
`merge.pr.before_merge`, `merge.after_pr_merge.before_event`. They are covered by SIGKILL subprocess tests
(`tests/merge/*.test.ts`), and the first four are also covered in chaos:fast against per-case bare repos. The audit checks for:
no double landing, merged task ⇒ exactly 1 landing + recorded sha, non-merged ⇒ 0 landings.

## Consequences
- The local clone is a disposable cache (`CAPCOMD_WORKDIR`). It is reset or re-cloned on any inconsistency.
- The fake sandbox produces commits on the orchestrator host. Real sandboxes must push the task branch themselves.
- GitHub limits: `GitHubHttpError.rateLimited` detects primary and secondary rate limits (surfaced as retryable). The live test
  (`tests/merge/github-live.test.ts`) is opt-in via `CAPCOMD_GH_LIVE=1`. It creates and deletes a private repo, and deleting needs the gh `delete_repo` scope.
