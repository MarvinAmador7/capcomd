// context-memory (ADR-025 §5.3, §11.1, steps 1 and 3): the built-in context provider `memory`, the project layer, and
// the gates that keep it. A profile with `context: {providers: [{name: memory}]}` (or ADR-024's `memory: {scope:
// project}`) is briefed from the items under `.capcomd/context/` in the run's repository, at the tip of the branch its
// agents start from (src/context/memory.ts). Agents propose lessons as candidates of their run (the context router's
// capture, src/context/capture.ts); the run's consolidator answers with changes the kernel stages on its branch
// (src/context/consolidator.ts); and promotion is a merge, judged here (src/context/promotion.ts):
//   verify.judging   lint as a check on any branch that changes .capcomd/context/: only a consolidator's, nothing
//                    outside that directory, and `capcomd context lint` clean against the commit it left its target at;
//   merge.landing    the same, denied when it fails (fail-closed); a consolidator's branch is held for a person
//                    (`review: human`, the default) or lands on lint alone (`review: lint`, its profile's context block).
// A branch that isn't an agent's (a person's) and one that doesn't touch .capcomd/context/ are let through unjudged.
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { definePlugin } from "../../packages/plugin/src/context";
import type { Outcome } from "../../packages/plugin/src/context-layer";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import { memoryProvider } from "../context/memory";
import { holdOf, judgeBranch, touchesContext, type BranchFacts, type Judgement, type Review } from "../context/promotion";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context-memory", version: VERSION,
  description: "Project memory: the lessons and facts a project keeps under .capcomd/context/ in its repository, as a context provider (memory) a profile names, and the gates through which they change: only from the run's consolidator, lint-clean, and (by default) after a person's look.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context-memory.ts" },
  provides: ["context:memory"],
  // Gates are fail-closed (spec §6.5). Each may fetch the branch and the target first, so the merge's waits up to its
  // maximum, a minute, and a verify's two.
  contributes: { context: [{ name: "memory", kinds: ["memory", "fact"] }], hooks: { "verify.judging": { timeoutMs: 120_000 }, "merge.landing": { timeoutMs: 60_000 } } },
};

/** The bare host repo the gates read branches in, one per repository (where src/merge/repo.ts keeps its clones). */
const GATES_CLONE = "context-gates";

/** `git diff --name-status -z` as paths (a rename or copy with the path it came from). */
export function nameStatus(z: string): Array<{ path: string; oldPath: string | null }> {
  const f = z.split("\0");
  const out: Array<{ path: string; oldPath: string | null }> = [];
  for (let i = 0; i < f.length; i++) {
    const s = f[i]!;
    if (!s) continue;
    if (/^[RC]\d*$/.test(s)) { out.push({ oldPath: f[i + 1] ?? null, path: f[i + 2] ?? "" }); i += 2; }
    else { out.push({ path: f[i + 1] ?? "", oldPath: null }); i += 1; }
  }
  return out.filter((x) => x.path);
}

/** What a branch's agent and commit are, as the gates need them. */
export interface BranchAgent { id: string; profile: string | null; review: Review; commit: string | null; branch: string }

/** The agent whose branch `capcomd/<run>/<agt>` is, in run `runId`; null for any other name. */
const branchAgent = (runId: string, branch: string) => new RegExp(`^capcomd/${runId.replace(/[^A-Za-z0-9_-]/g, "")}/(agt-[A-Za-z0-9_-]+)$`).exec(branch)?.[1] ?? null;

/** What the gates read besides the payload (a test replaces it). */
export const promotionKernel = {
  /** An agent's record: its profile, pinned spec and result. */
  record: async (runId: string, id: string): Promise<{ profile: string | null; spec: unknown; result: unknown }> => (await import("../primitives/ops")).getAgentOrThrow(runId, id),
  /** The agent a verify's or a merge's ref names (its id, or its branch `capcomd/<run>/<agt>`), with its commit; null
   *  for a ref that is no agent's (a person's branch). The work is judged as the agent whose branch it is: one that
   *  handed off has its successor's branch and commit as its result, so its successor's profile is what's judged. */
  agent: async (runId: string, ref: string): Promise<BranchAgent | null> => {
    const named = /^agt-[A-Za-z0-9_-]+$/.test(ref) ? ref : branchAgent(runId, ref);
    if (!named) return null;
    const a = await promotionKernel.record(runId, named);
    const r = (a.result ?? {}) as { commit?: unknown; branch?: unknown };
    const id = (typeof r.branch === "string" && branchAgent(runId, r.branch)) || named;
    const owner = id === named ? a : await promotionKernel.record(runId, id);
    const review = (owner.spec as { context?: { review?: string } } | null)?.context?.review === "lint" ? "lint" : "human";
    return { id, profile: owner.profile, review, commit: typeof r.commit === "string" && r.commit ? r.commit : null, branch: `capcomd/${runId}/${id}` };
  },
  /** What `commit` changes from where it left the run's target (its merge base with `targetSha` when known, else with
   *  the target's tip), and `.capcomd/context/` there and at `commit`: read in a bare host repo the gates keep per
   *  repository (src/merge/host-git.ts), local reads once it has fetched what it needs. */
  branch: async (runId: string, o: { commit: string; branch: string; targetSha: string | null }): Promise<Omit<BranchFacts, "agent">> => {
    const cfg = await (await import("../merge/run-config")).mergeConfigFor(runId);
    if (!cfg) throw new Error("the run has no repository");
    const target = (await (await import("../primitives/ops")).runTarget(runId)) ?? cfg.target;
    const { cloneDir, withCloneLock } = await import("../merge/repo");
    const { hostRepoProblems, initHostRepo, isHostRepo, remoteGit } = await import("../merge/host-git");
    const { Git } = await import("../merge/git");
    const { readContextAt } = await import("../context/lint");
    const SHA = /^[0-9a-f]{40,64}$/;
    if (!SHA.test(o.commit) || (o.targetSha && !SHA.test(o.targetSha)) || /[^A-Za-z0-9._/-]|\.\./.test(`${o.branch}${target}`)) throw new Error("not a commit or a branch");
    // Its own bare host repo, fetched under a lock that holds across processes (a CLI's verify, the daemon's merge):
    // only the target and the branch, and the commit by its id when its branch has moved on since. Nothing when it has
    // both commits already (a merge after its verify read them): a merge's fast path stays one round trip.
    const git = await withCloneLock(cfg, GATES_CLONE, async () => {
      const dir = cloneDir(cfg, GATES_CLONE);
      let g = new Git(dir);
      if (!existsSync(join(dir, "HEAD")) || !isHostRepo(dir) || (await hostRepoProblems(g)).length) { rmSync(dir, { recursive: true, force: true }); g = await initHostRepo(dir, { bare: true }); }
      const has = async (sha: string) => (await g.run(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
      if (o.targetSha && (await has(o.commit)) && (await has(o.targetSha))) return g;
      const ref = (b: string) => `+refs/heads/${b}:refs/remotes/origin/${b}`;
      const f = await remoteGit(g, ["fetch", "-q", "--no-tags", cfg.remote, ref(target), ...(await has(o.commit) ? [] : [ref(o.branch)])], cfg.remote);
      if (f.code !== 0 && !(await has(o.commit))) await remoteGit(g, ["fetch", "-q", "--no-tags", cfg.remote, ref(target)], cfg.remote);
      if (!(await has(o.commit))) await remoteGit(g, ["fetch", "-q", "--no-tags", cfg.remote, o.commit], cfg.remote);
      if (!(await has(o.commit))) throw new Error(`commit ${o.commit.slice(0, 12)} isn't on ${cfg.remote}`);
      return g;
    });
    const has = async (sha: string) => (await git.run(["cat-file", "-e", `${sha}^{commit}`])).code === 0;
    const against = o.targetSha && (await has(o.targetSha)) ? o.targetSha : `refs/remotes/origin/${target}`;
    const base = (await git.run(["merge-base", o.commit, against])).stdout.trim();
    if (!base) throw new Error(`${o.branch} has no common history with ${target}`);
    const d = await git.run(["-c", "core.quotepath=off", "diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "-M", base, o.commit]);
    if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim().slice(0, 200)}`);
    return { files: nameStatus(d.stdout), after: readContextAt(git.cwd, o.commit), before: readContextAt(git.cwd, base) };
  },
  /** Whether an outcome is a passed verify or a landed merge of the run. */
  outcome: async (runId: string): Promise<(o: Outcome) => boolean> => {
    const { outcomeIn, runOps } = await import("../context/consolidator");
    return outcomeIn(await runOps(runId));
  },
  /** Every secret value the kernel put in the run (src/context/scan.ts). */
  secrets: async (runId: string): Promise<string[]> => {
    const cfg = await (await import("../merge/run-config")).mergeConfigFor(runId).catch(() => null);
    return (await import("../context/scan")).runSecrets({ runId, remote: cfg?.remote ?? null });
  },
};

/** Judge the branch `ref` names in run `runId` at `commit` (else its agent's): null when there is nothing to judge (a
 *  person's branch, no work, nothing under .capcomd/context/). */
export async function judgeRef(runId: string, ref: string, o: { commit?: string | null; targetSha?: string | null } = {}): Promise<(Judgement & { agent: BranchAgent; commit: string }) | null> {
  const agent = await promotionKernel.agent(runId, ref);
  const commit = o.commit || agent?.commit;
  if (!agent || !commit) return null;
  const facts = await promotionKernel.branch(runId, { commit, branch: agent.branch, targetSha: o.targetSha ?? null });
  if (!facts.files.some((f) => touchesContext(f.path) || touchesContext(f.oldPath))) return null;
  const { secretScan } = await import("../context/scan");
  const { DEFAULT_LIMITS } = await import("../context/limits");
  const j = judgeBranch({ ...facts, agent }, {
    scan: secretScan(await promotionKernel.secrets(runId)), outcome: await promotionKernel.outcome(runId),
    itemBytes: DEFAULT_LIMITS.itemBytes, descriptionChars: DEFAULT_LIMITS.descriptionChars,
  });
  return j.touches ? { ...j, agent, commit } : null;
}

export const plugin = definePlugin({
  activate(ctx) {
    ctx.context.register(memoryProvider());

    // Lint as a check (ADR-025 §5.3): the verify of a branch that changes the project's memory fails on what would stop
    // its merge, so its parent hears it before it asks to merge.
    ctx.hooks.on("verify.judging", async (call) => {
      const v = call.payload.verification;
      const j = await judgeRef(v.runId, v.ref, { commit: v.tested.commit, targetSha: v.tested.targetSha });
      if (!j?.problems.length) return { decision: "allow" };
      return { decision: "deny", reason: j.problems[0]!, reasons: j.problems };
    });

    // The gate (ADR-025 §5.3): under the target's lock, before anything is pushed. Fail-closed: a branch it can't read
    // doesn't land.
    ctx.hooks.on("merge.landing", async (call) => {
      const { merge, target } = call.payload;
      // From where it left the target as its verify saw it (when it has one), so a merge right after it reads nothing new.
      const j = await judgeRef(merge.runId, merge.ref, { targetSha: target.sha || null });
      if (!j) return { decision: "allow" };
      if (j.problems.length) return { decision: "deny", reason: j.problems.join(" ").slice(0, 2000) };
      if (j.review === "lint") return { decision: "allow" };
      return { decision: "hold", ...holdOf(j, j.commit) };
    });
  },
});
