import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import type { MergeConfig } from "./config";
import { taskKey } from "./config";
import { openClone } from "./repo";

/**
 * Stand-in for a worker VM's git work when the sandbox is the in-memory fake: cut
 * capcomd/<run>/<task> from the target tip, commit tasks/<taskId>.md (with the Capcomd-Task
 * trailer), push the branch. Idempotent: an existing remote branch is reused unless `rework`
 * (after a merge conflict), which re-cuts from the latest target and force-pushes with a lease.
 */
export async function produceFakeWork(cfg: MergeConfig, p: { runId: string; taskId: string; branch: string; target: string; epoch: number; rework?: boolean; content?: string; path?: string }): Promise<string> {
  // One clone per task: agents finish concurrently, and a shared clone let one task's checkout/add
  // interleave with another's (a commit picked up the other task's file).
  const git = await openClone(cfg, `${p.runId}-worker-${p.taskId}`);
  const existing = await git.revParse(`refs/remotes/origin/${p.branch}`);
  if (existing && !p.rework) return existing;
  const base = await git.revParse(`refs/remotes/origin/${p.target}`);
  if (!base) throw new Error(`target branch ${p.target} not found on ${cfg.remote}`);
  await git.ok(["checkout", "-q", "-B", "capcomd-work", base]);
  const rel = p.path ?? join("tasks", `${p.taskId}.md`);
  mkdirSync(join(git.cwd, rel, ".."), { recursive: true });
  writeFileSync(join(git.cwd, rel), p.content ?? `# ${p.taskId}\n\nrun ${p.runId}, epoch ${p.epoch}\n`);
  await git.ok(["add", rel]);
  await git.ok(["commit", "-q", ...(cfg.signCommits ? ["-S"] : []), "-m", `${p.taskId}: work for ${p.runId}\n\nCapcomd-Task: ${taskKey(p.runId, p.taskId)}`]);
  const sha = await git.ok(["rev-parse", "HEAD"]);
  await git.ok(["push", "-q", `--force-with-lease=refs/heads/${p.branch}:${existing ?? ""}`, "origin", `${sha}:refs/heads/${p.branch}`]);
  return sha;
}
