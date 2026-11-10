// recipe-hierarchical (plugin API §17.1; ADR-023 §4 judgment call and decision 5): `capcomd run` without a planner
// agent, the placeholder-model planner → worker → judge flow, as the recipe over the primitives (src/recipes/
// hierarchical.ts, `--recipe`, CAPCOMD_RUN_PATH=recipe) or the hard-wired loop it replaced (src/core/relay.ts
// executeRun, `--legacy`, CAPCOMD_RUN_PATH=legacy). A built-in kept for the parity eval and the tests, off until a person
// turns it on (`capcomd plugins enable recipe-hierarchical`, or CAPCOMD_PLUGIN_RECIPE_HIERARCHICAL_ENABLED=true): a run
// that needs it while it's off is refused before anything starts, naming it (front-run's `run`, src/cli/groups/run.ts).
// It is loaded wherever `capcomd run` runs (the CLI, a detached run's process). Neither way lands a branch that changes
// the project's memory (`memoryRefusal`, ADR-025 §5.3).
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { definePlugin } from "../../packages/plugin/src/context";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { RunOptions, RunResult } from "../core/relay";
import type { MergeConfig } from "../merge/config";
import type { MergeOutcome } from "../merge/types";
import { touchesContext } from "../context/promotion";
import { VERSION } from "../utils/self";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "recipe-hierarchical", version: VERSION,
  description: "capcomd run without a planner agent: a placeholder planner that makes the same generic tasks for any goal, workers, and a judge that judges nothing. Kept for comparisons and tests; off unless turned on.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./recipe-hierarchical.ts" },
  // A card for the settings screen (§4.7.5): while it's on, runs without a planner agent judge nothing.
  contributes: { ui: [{ kind: "card", id: "recipe" }] },
};

/** The card's lines (plain text, §4.7.5). */
export const CARD = {
  title: "Runs without a planner agent",
  lines: ["On: capcomd run without a planner agent plans with a placeholder model (the same generic tasks for any goal) and judges nothing.", "Turn it off: capcomd plugins disable recipe-hierarchical"],
} as const;

/** The two ways it runs a goal. */
export interface HierarchicalRecipe {
  /** The recipe over the primitives (ADR-016 step 4). */
  recipe(o: RunOptions & { budgetUsd?: number }): Promise<RunResult>;
  /** The legacy hard-wired loop. */
  legacy(o: RunOptions): Promise<RunResult>;
}

/** What this process's active recipe-hierarchical registered; null while it isn't active here. */
let active: HierarchicalRecipe | null = null;

export const plugin = definePlugin({
  activate(ctx) {
    const mine: HierarchicalRecipe = {
      recipe: async (o) => (await import("../recipes/hierarchical")).runHierarchicalRecipe(o),
      legacy: async (o) => (await import("../core/relay")).executeRun(o),
    };
    active = mine;
    ctx.onDispose(() => { if (active === mine) active = null; });
    ctx.ui.descriptor({ kind: "card", id: "recipe", title: CARD.title, read: async () => ({ lines: [...CARD.lines], state: "warn" }) });
  },
});

/** The recipe, from this process's plugin host (src/plugins/host.ts `localHost`); while recipe-hierarchical isn't
 *  active, the refusal that says so and how to turn it on (`config`, reason `plugin:recipe-hierarchical`). */
export async function hierarchicalRecipe(): Promise<HierarchicalRecipe> {
  await (await import("./host")).localHost();
  if (active) return active;
  throw await (await import("../cli/front-doors")).notRunning(manifest.name, "capcomd run without a planner agent (--recipe, --legacy, CAPCOMD_RUN_PATH) is the recipe-hierarchical plugin's");
}

// ---- the memory gate these runs don't have (ADR-025 §5.3) ----------------------------------------------------------
// `--legacy` merges with no merge.landing gate at all (no plugin is asked), and neither way spawns a consolidator: a
// branch that changes the project's memory is refused before its merge, whoever's it is, so it never depends on which
// plugins are on. Fail-closed: a branch it can't read doesn't land either.

/** What a refused branch is told: memory lands from a consolidator (a planner run's) or a person, never from here. */
export const MEMORY_REFUSED = "capcomd run --legacy/--recipe doesn't land changes to .capcomd/context/ (memory lands only from a consolidator or a person): run the goal with a planner agent (capcomd run without --legacy or --recipe), whose context-consolidator lands lessons through the memory gate, or commit the change yourself";

/** The bare host repo it reads branches in, one per repository (where src/merge/repo.ts keeps its clones). */
const MEMORY_CLONE = "recipe-memory";
const SAFE_BRANCH = (b: string) => !!b && !/[^A-Za-z0-9._/-]|\.\.|^[-/]/.test(b);

/** The paths `commit` (else `branch`'s tip on the remote) changes from where it left `target`, a rename as both paths,
 *  and that commit (`tip`: a merge bound to it lands what was read, or nothing). */
export async function changedPaths(cfg: MergeConfig, w: { branch: string; commit?: string | null; target: string }): Promise<{ paths: string[]; tip: string }> {
  if (!SAFE_BRANCH(w.branch) || !SAFE_BRANCH(w.target)) throw new Error("not a branch name");
  const commit = w.commit && /^[0-9a-f]{40,64}$/.test(w.commit) ? w.commit : null;
  const { cloneDir, withCloneLock } = await import("../merge/repo");
  const { hostRepoProblems, initHostRepo, isHostRepo, remoteGit } = await import("../merge/host-git");
  const { Git } = await import("../merge/git");
  const ref = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
  const { git, tip } = await withCloneLock(cfg, MEMORY_CLONE, async () => {
    const dir = cloneDir(cfg, MEMORY_CLONE);
    let g = new Git(dir);
    if (!existsSync(join(dir, "HEAD")) || !isHostRepo(dir) || (await hostRepoProblems(g)).length) { rmSync(dir, { recursive: true, force: true }); g = await initHostRepo(dir, { bare: true }); }
    const f = await remoteGit(g, ["fetch", "-q", "--no-tags", cfg.remote, ref(w.target), ref(w.branch)], cfg.remote);
    if (f.code !== 0) throw new Error(`git fetch ${cfg.remote} failed: ${(f.stderr || f.stdout).trim().slice(0, 200)}`);
    const has = async (sha: string) => (await g.run(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
    // The commit the worker handed off, by its id when its branch has moved on since.
    if (commit && !(await has(commit))) await remoteGit(g, ["fetch", "-q", "--no-tags", cfg.remote, commit], cfg.remote);
    if (commit && !(await has(commit))) throw new Error(`commit ${commit.slice(0, 12)} isn't on ${cfg.remote}`);
    // Else the branch's tip as this fetch found it, by its id: another read's fetch may move the ref once the lock is gone.
    return { git: g, tip: commit ?? (await g.run(["rev-parse", "--verify", "-q", `refs/remotes/origin/${w.branch}^{commit}`])).stdout.trim() };
  });
  if (!/^[0-9a-f]{40,64}$/.test(tip)) throw new Error(`${w.branch} isn't on ${cfg.remote}`);
  const base = (await git.run(["merge-base", tip, `refs/remotes/origin/${w.target}`])).stdout.trim();
  if (!base) throw new Error(`${w.branch} has no common history with ${w.target}`);
  const d = await git.run(["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", base, tip]);
  if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim().slice(0, 200)}`);
  return { paths: d.stdout.split("\0").filter(Boolean), tip };
}

/** Why `branch` may not land (it changes `.capcomd/context/`, or it can't be read), or null to merge it as before. No
 *  repository (`cfg` null) is a dry run: nothing lands anywhere, so nothing is refused. */
export async function memoryRefusal(cfg: MergeConfig | null, w: { branch: string; commit?: string | null; target: string }): Promise<string | null> {
  return (await judgeMemory(cfg, w)).refused;
}

/** `memoryRefusal`, with the commit it judged (null when it read none). */
async function judgeMemory(cfg: MergeConfig | null, w: { branch: string; commit?: string | null; target: string }): Promise<{ refused: string | null; tip: string | null }> {
  if (!cfg) return { refused: null, tip: null };
  let read: { paths: string[]; tip: string };
  try { read = await changedPaths(cfg, w); } catch (e) {
    return { refused: `can't tell whether ${w.branch} changes .capcomd/context/, so it doesn't land: ${(e as Error)?.message ?? String(e)}`, tip: null };
  }
  const memory = read.paths.filter((p) => touchesContext(p));
  if (!memory.length) return { refused: null, tip: read.tip };
  return { refused: `${w.branch} changes ${memory.slice(0, 5).join(", ")}${memory.length > 5 ? ` and ${memory.length - 5} more` : ""}; ${MEMORY_REFUSED}`, tip: read.tip };
}

/** `--legacy`'s verify-and-merge of a task's branch (its tip; no `target` is the verifier's default, `main`): `land` only
 *  when `memoryRefusal` lets it, given the commit that was judged so that it lands that one or nothing (a branch moved in
 *  between fails as moved, never lands unread), else the failed outcome a failed verification is, with nothing landed. */
export async function landUnlessMemory(cfg: MergeConfig | null, w: { branch: string; target: string | undefined }, land: (judged: string | undefined) => Promise<MergeOutcome>): Promise<MergeOutcome> {
  const j = await judgeMemory(cfg, { branch: w.branch, target: w.target ?? "main" });
  return j.refused ? { status: "failed", reason: j.refused } : land(j.tip ?? undefined);
}
