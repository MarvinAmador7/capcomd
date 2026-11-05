// How far the env image's warm template (Docker, `capcomd env build`) is from the project's target now: commits behind,
// and whether the lockfile changed (then agents clone and install their own dependencies). Images change only on
// `capcomd env build` (no automatic rebuilds): `env status` and `doctor` say when one is due. Read on this host from
// a capcomd-owned mirror of commits and trees only (no file contents), next to the merge clones.
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Git } from "../merge/git";
import { hostRepoProblems, initHostRepo, isHostRepo, remoteGit } from "../merge/host-git";
import type { MergeConfig } from "../merge/config";
import { LOCKFILES } from "../agents/workspace";
import type { EnvManifest, EnvRecord } from "./resolve";

export const REBUILD = "capcomd env build --sandbox docker";

export interface DriftFacts {
  /** The project's target and its tip now; null tip when it couldn't be read. */
  target: string;
  tip: string | null;
  /** The template's commit is in the target's history. */
  ancestor: boolean | null;
  /** Commits on the target since the template's commit. */
  behind: number | null;
  /** The lockfile at the tip isn't the template's (another file, or other contents). */
  lockChanged: boolean | null;
  error?: string;
}
export interface Drift {
  state: "current" | "behind" | "lockfile" | "diverged" | "unknown";
  behind: number | null;
  lockChanged: boolean | null;
  /** One line for `env status` / `doctor`. */
  message: string;
}

/** What the facts mean for agents, and what to do about it. */
export function driftOf(commit: string, f: DriftFacts): Drift {
  const at = commit.slice(0, 12);
  if (f.error || f.tip === null || f.ancestor === null) return { state: "unknown", behind: null, lockChanged: null, message: `warm template at ${at}: couldn't compare it with ${f.target}${f.error ? ` (${f.error})` : ""}` };
  if (!f.ancestor) return { state: "diverged", behind: null, lockChanged: f.lockChanged, message: `warm template at ${at} isn't in ${f.target}'s history any more (rewritten?): agents clone instead; run \`${REBUILD}\`` };
  const n = f.behind ?? 0;
  const commits = `${n} commit${n === 1 ? "" : "s"} behind ${f.target}`;
  if (f.lockChanged) return { state: "lockfile", behind: n, lockChanged: true, message: `warm template at ${at} is ${commits} and the lockfile changed since: agents clone and install their own dependencies until you run \`${REBUILD}\`` };
  if (n > 0) return { state: "behind", behind: n, lockChanged: false, message: `warm template at ${at} is ${commits} (agents fetch the difference); \`${REBUILD}\` brings it up to date` };
  return { state: "current", behind: 0, lockChanged: false, message: `warm template at ${at} is up to date with ${f.target}` };
}

/** The first lockfile (capcomd's order) in a `git ls-tree` listing, as "name blob". */
function lockOf(lsTree: string): string {
  const entries = new Map(lsTree.split("\n").filter(Boolean).map((l) => { const [meta, name] = l.split("\t"); return [name!, meta!.split(/\s+/)[2]!] as const; }));
  const name = LOCKFILES.find((f) => entries.has(f));
  return name ? `${name} ${entries.get(name)}` : "none";
}

/** Reads the facts for a manifest's warm template from the remote (fetches commits and trees of the target only). */
export async function templateDriftFacts(m: EnvManifest, cfg: MergeConfig, o: { timeoutMs?: number } = {}): Promise<DriftFacts> {
  const target = cfg.target;
  const commit = m.template?.commit ?? "";
  const timeoutMs = o.timeoutMs ?? 60_000;
  const dir = join(cfg.workdir, createHash("sha1").update(cfg.remote).digest("hex").slice(0, 12), "_envdrift");
  let g = new Git(dir);
  try {
    // A host repo (src/merge/host-git.ts), started over when it isn't one or fails the check.
    if (!existsSync(join(dir, "HEAD")) || !isHostRepo(dir) || (await hostRepoProblems(g)).length) { rmSync(dir, { recursive: true, force: true }); g = await initHostRepo(dir, { bare: true }); }
    const fetched = await remoteGit(g, ["fetch", "-q", "--no-tags", "--filter=blob:none", cfg.remote, `+refs/heads/${target}:refs/remotes/origin/${target}`], cfg.remote, { timeoutMs });
    if (fetched.code !== 0) return { target, tip: null, ancestor: null, behind: null, lockChanged: null, error: `git fetch failed: ${(fetched.stderr || fetched.stdout).trim().slice(-200)}` };
    const tip = (await g.ok(["rev-parse", `refs/remotes/origin/${target}`])).trim();
    if ((await g.run(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) await remoteGit(g, ["fetch", "-q", "--no-tags", "--filter=blob:none", cfg.remote, commit], cfg.remote, { timeoutMs });
    if ((await g.run(["cat-file", "-e", `${commit}^{commit}`])).code !== 0) return { target, tip, ancestor: false, behind: null, lockChanged: null };
    const ancestor = (await g.run(["merge-base", "--is-ancestor", commit, tip])).code === 0;
    const behind = ancestor ? Number((await g.ok(["rev-list", "--count", `${commit}..${tip}`])).trim()) : null;
    const lockAt = async (ref: string) => lockOf((await g.ok(["ls-tree", ref, "--", ...LOCKFILES])));
    const lockChanged = (await lockAt(commit)) !== (await lockAt(tip));
    return { target, tip, ancestor, behind, lockChanged };
  } catch (e) {
    return { target, tip: null, ancestor: null, behind: null, lockChanged: null, error: String((e as Error)?.message ?? e).slice(0, 200) };
  }
}

/** The drift of an env build's warm template, or null when it has none (a shallow template, or no repository). */
export async function templateDrift(rec: EnvRecord | undefined, cfg: MergeConfig | null, o: { timeoutMs?: number } = {}): Promise<Drift | null> {
  if (!rec?.manifest.template || !cfg) return null;
  const f = await templateDriftFacts(rec.manifest, cfg, o);
  // Without installed dependencies a lockfile change costs nothing: agents install their own either way. (A record of
  // an image this ledger found already built, buildMs 0, doesn't know: then the change counts.)
  const noDeps = rec.buildMs > 0 && !rec.depsInstalled;
  return driftOf(rec.manifest.template.commit, noDeps ? { ...f, lockChanged: f.lockChanged === null ? null : false } : f);
}

/**
 * Plan logins saved on an older env image than `current`: agents with that login boot from the login's image, so they
 * get its warm template (and CLIs), not the current one's. `capcomd env build --sandbox docker` moves them onto the new
 * image itself (src/auth/carry.ts), so one left here is one it couldn't move: the note says what to run.
 */
export function loginsOnOlderEnv(current: string | undefined, profiles: Array<{ agent: string; snapshot?: string; env: string }>): string[] {
  if (!current) return [];
  return profiles.filter((p) => p.snapshot && p.env !== current).map((p) => {
    const cli = p.agent === "claude-code" ? "claude" : "codex";
    return `plan login for ${cli} is still on ${p.env}: its agents boot from that image (its warm template), not ${current}. \`${REBUILD}\` moves it (it tries again), or run \`capcomd auth login ${cli} --sandbox docker\``;
  });
}
