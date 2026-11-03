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

/** Delete a ref on the remote (no clone needed). True when it is gone, including when it never existed. */
export async function deleteRemoteRef(cfg: MergeConfig, ref: string): Promise<boolean> {
  const dir = join(cfg.workdir, createHash("sha1").update(cfg.remote).digest("hex").slice(0, 12), "_refs");
  if (!existsSync(join(dir, ".git"))) { mkdirSync(dir, { recursive: true }); await new Git(dir).ok(["init", "-q"]); }
  const res = await new Git(dir).run(["push", "--porcelain", cfg.remote, `:${ref}`]);
  return res.code === 0 || /remote ref does not exist|unable to delete .*: remote ref does not exist/.test(res.stdout + res.stderr);
}

/** The commit a branch points at on the remote (no clone needed), or null when it doesn't exist. Throws when git fails. */
export async function remoteBranchSha(cfg: MergeConfig, branch: string, timeoutMs = 30_000): Promise<string | null> {
  const dir = join(cfg.workdir, createHash("sha1").update(cfg.remote).digest("hex").slice(0, 12), "_refs");
  if (!existsSync(join(dir, ".git"))) { mkdirSync(dir, { recursive: true }); await new Git(dir).ok(["init", "-q"]); }
  const res = await new Git(dir).run(["ls-remote", cfg.remote, `refs/heads/${branch}`], { timeoutMs });
  if (res.code !== 0) throw new Error(`git ls-remote failed${res.timedOut ? " (timed out)" : ""}: ${(res.stderr || res.stdout).trim().slice(-300)}`);
  const sha = res.stdout.trim().split(/\s+/)[0];
  return sha && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** The scratch repository per remote that ref-only work runs in (ls-remote, a shallow fetch, a ref push): no clone. */
async function refsRepo(cfg: MergeConfig): Promise<Git> {
  const dir = join(cfg.workdir, createHash("sha1").update(cfg.remote).digest("hex").slice(0, 12), "_refs");
  if (!existsSync(join(dir, ".git"))) { mkdirSync(dir, { recursive: true }); await new Git(dir).ok(["init", "-q"]); }
  return new Git(dir);
}

/** Where each of `branches` points on the remote (null: no such branch), in one `git ls-remote`. Throws when git fails. */
export async function remoteHeads(cfg: MergeConfig, branches: string[], timeoutMs = 20_000): Promise<Record<string, string | null>> {
  const git = await refsRepo(cfg);
  const res = await git.run(["ls-remote", cfg.remote, ...branches.map((b) => `refs/heads/${b}`)], { timeoutMs });
  if (res.code !== 0) throw new Error(`git ls-remote failed${res.timedOut ? " (timed out)" : ""}: ${(res.stderr || res.stdout).trim().slice(-300)}`);
  const out: Record<string, string | null> = Object.fromEntries(branches.map((b) => [b, null]));
  // Patterns match ref suffixes: keep exact names only.
  for (const line of res.stdout.split("\n")) {
    const m = /^([0-9a-f]{40,64})\trefs\/heads\/(.+)$/.exec(line.trim());
    if (m && m[2]! in out) out[m[2]!] = m[1]!;
  }
  return out;
}

/**
 * Point `branch` on the remote at `from`'s commit `sha` without a clone: a shallow fetch of `from` (depth `depth`) and a
 * ref push with a lease (`expect`: the commit `branch` must be at now, null: it must not exist). With `fastForwardFrom`
 * the push only goes ahead when that commit is in `from`'s fetched history (so nothing on `branch` is lost).
 */
export async function pointRemoteBranch(cfg: MergeConfig, branch: string, from: string, sha: string, o: { expect: string | null; fastForwardOnly?: boolean; depth?: number; timeoutMs?: number }): Promise<{ ok: true } | { ok: false; reason: "not_ancestor" | "push"; detail: string }> {
  const git = await refsRepo(cfg);
  const timeoutMs = o.timeoutMs ?? 60_000;
  const ref = `refs/capcomd/point-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    const f = await git.run(["fetch", "-q", "--no-tags", `--depth=${o.depth ?? 1}`, cfg.remote, `+refs/heads/${from}:${ref}`], { timeoutMs });
    if (f.code !== 0) return { ok: false, reason: "push", detail: `git fetch ${from} failed${f.timedOut ? " (timed out)" : ""}: ${(f.stderr || f.stdout).trim().slice(-300)}` };
    const got = (await git.run(["rev-parse", ref])).stdout.trim();
    if (got !== sha) return { ok: false, reason: "push", detail: `${from} moved while capcomd read it (${sha.slice(0, 12)} → ${got.slice(0, 12)}); try again` };
    if (o.fastForwardOnly && o.expect) {
      const anc = await git.run(["merge-base", "--is-ancestor", o.expect, ref]);
      if (anc.code !== 0) return { ok: false, reason: "not_ancestor", detail: `${branch} (${o.expect.slice(0, 12)}) has commits ${from} doesn't have` };
    }
    const lease = `--force-with-lease=refs/heads/${branch}:${o.expect ?? ""}`;
    const p = await git.run(["push", "--porcelain", lease, cfg.remote, `${sha}:refs/heads/${branch}`], { timeoutMs });
    if (p.code !== 0) return { ok: false, reason: "push", detail: `git push failed${p.timedOut ? " (timed out)" : ""}: ${(p.stdout + p.stderr).trim().slice(-300)}` };
    return { ok: true };
  } finally {
    await git.run(["update-ref", "-d", ref]).catch(() => {});
  }
}
