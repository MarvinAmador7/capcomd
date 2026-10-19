import { existsSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { Git } from "./git";
import type { MergeConfig } from "./config";

/**
 * A capcomd-owned clone. Disposable cache, never a source of truth: any leftover state from a
 * crash (index.lock, half-done rebase/merge) is wiped, and a broken clone is re-cloned. Git on the
 * remote wins.
 */
export async function openClone(cfg: MergeConfig, name: string): Promise<Git> {
  const dir = join(cfg.workdir, createHash("sha1").update(cfg.remote).digest("hex").slice(0, 12), name.replace(/[^a-zA-Z0-9._-]/g, "_"));
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!existsSync(join(dir, ".git"))) {
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(dir, { recursive: true });
      const git = new Git(dir);
      await git.ok(["init", "-q"]);
      await git.ok(["remote", "add", "origin", cfg.remote]);
    }
    const git = new Git(dir);
    try {
      await clean(git, dir);
      await git.ok(["fetch", "-q", "--prune", "origin", "+refs/heads/*:refs/remotes/origin/*"]);
      return git;
    } catch (e) {
      if (attempt === 1) throw e;
      rmSync(dir, { recursive: true, force: true });
    }
  }
  throw new Error("unreachable");
}

async function clean(git: Git, dir: string): Promise<void> {
  for (const f of ["index.lock", "HEAD.lock"]) rmSync(join(dir, ".git", f), { force: true });
  if (existsSync(join(dir, ".git", "rebase-merge")) || existsSync(join(dir, ".git", "rebase-apply"))) {
    await git.run(["rebase", "--abort"]);
    rmSync(join(dir, ".git", "rebase-merge"), { recursive: true, force: true });
    rmSync(join(dir, ".git", "rebase-apply"), { recursive: true, force: true });
  }
  if (existsSync(join(dir, ".git", "MERGE_HEAD"))) await git.run(["merge", "--abort"]);
  await git.run(["reset", "-q", "--hard"]);
  await git.run(["clean", "-qfdx"]);
}

export interface ExistingMerge { sha: string; how: "ancestor" | "trailer" | "patch-id" }

/**
 * Is this task's change already in `targetRef`? Checked three ways (git wins):
 *  - the task tip is an ancestor of the target (ff / merge commit / rebase that kept the commit);
 *  - a non-merge commit on the target carries `Capcomd-Task: <run>/<task>` (squash, rebase);
 *  - every task commit is patch-equivalent to one already on the target (`git cherry`).
 */
export async function findExistingMerge(git: Git, targetRef: string, taskSha: string | null, key: string): Promise<ExistingMerge | null> {
  const targetSha = await git.revParse(targetRef);
  if (!targetSha) return null;
  // Task tip already reachable from the target (ff, merge commit, rebase that kept the commit).
  // A task with no commits of its own is trivially "merged": there is nothing to land.
  if (taskSha && (await git.isAncestor(taskSha, targetSha))) return { sha: taskSha, how: "ancestor" };
  const byTrailer = await git.run(["log", "--no-merges", "--format=%H", "--fixed-strings", "--grep", `Capcomd-Task: ${key}`, "-1", targetSha]);
  if (byTrailer.stdout.trim()) return { sha: byTrailer.stdout.trim(), how: "trailer" };
  if (taskSha) {
    const cherry = await git.run(["cherry", targetSha, taskSha]);
    const lines = cherry.stdout.split("\n").filter(Boolean);
    if (cherry.code === 0 && lines.length > 0 && lines.every((l) => l.startsWith("-"))) {
      return { sha: targetSha, how: "patch-id" };
    }
  }
  return null;
}

/** Count how many times a task landed on the target (for the doubleMerge invariant). */
export async function countTaskLandings(git: Git, targetRef: string, key: string): Promise<number> {
  const r = await git.run(["log", "--no-merges", "--format=%H", "--fixed-strings", "--grep", `Capcomd-Task: ${key}`, targetRef]);
  return r.stdout.split("\n").filter(Boolean).length;
}
