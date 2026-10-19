import type { Git } from "./git";
import type { MergeConfig, MergeStrategy } from "./config";

export type Integrated = { ok: true; head: string; how: "ff" | "rebase" | "squash" | "merge-commit" | "noop" } | { ok: false; files: string[] };

/**
 * Put the task on top of `targetSha` in a detached HEAD, per the repo's strategy:
 *  - squash: one commit with `Capcomd-Task:` trailer;
 *  - rebase: fast-forward if possible, else rebase the task commits onto the target;
 *  - merge:  fast-forward if possible, else a merge commit (`Capcomd-Merge:` trailer).
 * Conflicts abort cleanly and return the conflicting files.
 */
export async function integrate(git: Git, cfg: MergeConfig, strategy: MergeStrategy, targetSha: string, taskSha: string, key: string, title: string): Promise<Integrated> {
  const sign = cfg.signCommits ? ["-S"] : [];
  await git.ok(["checkout", "-q", "--detach", "-f", targetSha]);
  await git.ok(["reset", "-q", "--hard", targetSha]);

  if (strategy === "squash") {
    const r = await git.run(["merge", "--squash", taskSha]);
    if (r.code !== 0) {
      const files = await git.unmergedFiles();
      await git.run(["reset", "-q", "--hard", targetSha]);
      if (files.length) return { ok: false, files };
      throw new Error(`squash failed: ${r.stderr}`);
    }
    const staged = await git.run(["diff", "--cached", "--quiet"]);
    if (staged.code === 0) return { ok: true, head: targetSha, how: "noop" };
    // Hooks run (no --no-verify): pre-commit / commit-msg apply to capcomd's own commits too.
    await git.ok(["commit", "-q", ...sign, "-m", `${title}\n\nCapcomd-Task: ${key}`]);
    return { ok: true, head: await git.ok(["rev-parse", "HEAD"]), how: "squash" };
  }

  if (await git.isAncestor(targetSha, taskSha)) {
    await git.ok(["reset", "-q", "--hard", taskSha]);
    return { ok: true, head: taskSha, how: "ff" };
  }

  if (strategy === "rebase") {
    await git.ok(["checkout", "-q", "--detach", "-f", taskSha]);
    const r = await git.run(["rebase", ...(cfg.signCommits ? ["--gpg-sign"] : []), targetSha]);
    if (r.code !== 0) {
      const files = await git.unmergedFiles();
      await git.run(["rebase", "--abort"]);
      await git.run(["reset", "-q", "--hard", targetSha]);
      if (files.length) return { ok: false, files };
      throw new Error(`rebase failed: ${r.stderr}`);
    }
    return { ok: true, head: await git.ok(["rev-parse", "HEAD"]), how: "rebase" };
  }

  const r = await git.run(["merge", "--no-ff", ...sign, "-m", `Merge ${title}\n\nCapcomd-Merge: ${key}`, taskSha]);
  if (r.code !== 0) {
    const files = await git.unmergedFiles();
    await git.run(["merge", "--abort"]);
    await git.run(["reset", "-q", "--hard", targetSha]);
    if (files.length) return { ok: false, files };
    throw new Error(`merge failed: ${r.stderr}`);
  }
  return { ok: true, head: await git.ok(["rev-parse", "HEAD"]), how: "merge-commit" };
}
