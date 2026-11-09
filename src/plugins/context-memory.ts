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
// And the fallback (ADR-025 D6a), on agent.changed `ended`: once every agent of a run that may spawn the consolidator
// (its planner) has ended, a run whose agents proposed lessons that no consolidator took gets one, started by capcomd at
// the run's top, and a consolidator's branch nobody asked to merge is verified and its merge asked for (held for a person
// by the gate above, as the planner's merge would be); lessons that came after the run's consolidator started (the
// planner's own, declared after it spawned it) get one follow-up consolidator, given only those (key `consolidator-late`,
// at most one per run). `autoConsolidate` (default on, per run too) turns it off;
// `plugin.context-memory.consolidator_started`, `merge_requested` and `consolidator_skipped` (why not) say what it did.
import { existsSync, rmSync } from "fs";
import { join } from "path";
import { definePlugin } from "../../packages/plugin/src/context";
import type { Outcome } from "../../packages/plugin/src/context-layer";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import { VERSION } from "../utils/self";
import { withDriveEnv } from "../utils/env";
import { CONSOLIDATOR_PROFILE } from "../context/consolidate";
import { memoryProvider } from "../context/memory";
import { holdOf, judgeBranch, touchesContext, type BranchFacts, type Judgement, type Review } from "../context/promotion";

export const manifest: PluginManifest = {
  schema: "capcomd.plugin/v1", name: "context-memory", version: VERSION,
  description: "Project memory: the lessons and facts a project keeps under .capcomd/context/ in its repository, as a context provider (memory) a profile names, and the gates through which they change: only from the run's consolidator, lint-clean, and (by default) after a person's look.",
  apiVersion: 1, engines: { capcomd: VERSION }, entry: { runtime: "in-process", module: "./context-memory.ts" },
  provides: ["context:memory"],
  // steer: only to emit its own events (spec §11.1), what the fallback did or why it didn't.
  scopes: ["steer"],
  // Gates are fail-closed (spec §6.5). Each may fetch the branch and the target first, so the merge's waits up to its
  // maximum, a minute, and a verify's two. agent.changed is observe (open): the fallback never holds anything up.
  contributes: {
    context: [{ name: "memory", kinds: ["memory", "fact"] }],
    hooks: { "verify.judging": { timeoutMs: 120_000 }, "merge.landing": { timeoutMs: 60_000 }, "agent.changed": {} },
    events: ["consolidator_started", "consolidator_skipped", "merge_requested"],
  },
  config: {
    type: "object", additionalProperties: false,
    properties: {
      autoConsolidate: {
        type: "boolean", default: true, "x-per-run": true,
        description: "When every agent of a run that may spawn the consolidator has ended and the run's agents proposed lessons but no consolidator ran, start one; and ask to merge a consolidator's branch nobody merged. Its merge is held for a person (review: human) as the planner's would be. false: only the planner spawns it (ADR-025 D6 as accepted).",
      },
    },
  },
};

/** The config this plugin reads (its schema's defaults over the files and environment). */
export interface MemoryConfig { autoConsolidate: boolean }

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

/** The run and agent whose branch `capcomd/<run>/<agt>` is (of any run: an agent's branch is never a person's); null for
 *  any other name. */
export function branchOwner(branch: unknown): { runId: string; id: string } | null {
  const m = typeof branch === "string" ? /^capcomd\/([A-Za-z0-9_-]+)\/(agt-[A-Za-z0-9_-]+)$/.exec(branch) : null;
  return m ? { runId: m[1]!, id: m[2]! } : null;
}

/** An agent's record as the gates read it. */
interface AgentRecord { profile: string | null; spec: unknown; result: unknown }
const commitOf = (a: AgentRecord) => { const c = (a.result as { commit?: unknown } | null)?.commit; return typeof c === "string" && c ? c : null; };
const reviewOf = (a: AgentRecord): Review => ((a.spec as { context?: { review?: string } } | null)?.context?.review === "lint" ? "lint" : "human");

/** What the gates read besides the payload (a test replaces it). */
export const promotionKernel = {
  /** An agent's record in its run: its profile, pinned spec and result. An agent (or a run) the engine doesn't have
   *  throws, so the gate fails closed; a run that isn't there is never made by asking. */
  record: async (runId: string, id: string): Promise<AgentRecord> => {
    const s = await (await import("../core/relay")).existingActor("scope", [runId]);
    const a = s ? ((await s.getAgent({ agentId: id })) as AgentRecord | null) : null;
    if (!a) throw new Error(`agent ${id} isn't one of run ${runId} here, so the gate can't say whose work ${id}'s branch is`);
    return a;
  },
  /** The agent whose work a verify's or a merge's ref lands, with its commit; null for a ref that is no agent's (a
   *  person's branch). A branch `capcomd/<run>/<agt>` is that agent's, in whichever run it is (one of another run is
   *  no person's either). An agent id lands its result's branch, as the merge does (resolveRef): an agent that handed
   *  off has its successor's branch and commit as its result, so the successor is the one judged. */
  agent: async (runId: string, ref: string): Promise<BranchAgent | null> => {
    if (!/^agt-[A-Za-z0-9_-]+$/.test(ref)) {
      const owner = branchOwner(ref);
      if (!owner) return null;
      const a = await promotionKernel.record(owner.runId, owner.id);
      return { id: owner.id, profile: a.profile, review: reviewOf(a), commit: commitOf(a), branch: ref };
    }
    const a = await promotionKernel.record(runId, ref);
    const owner = branchOwner((a.result as { branch?: unknown } | null)?.branch) ?? { runId, id: ref };
    const o = owner.runId === runId && owner.id === ref ? a : await promotionKernel.record(owner.runId, owner.id);
    return { id: owner.id, profile: o.profile, review: reviewOf(o), commit: commitOf(a), branch: `capcomd/${owner.runId}/${owner.id}` };
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

// ---- the fallback (ADR-025 D6 as amended, D6a): a run whose lessons no consolidator took ---------------------------

/** An agent of the run as the fallback reads it (the kernel's record). */
export interface RunAgent {
  agentId: string; parent: string | null; profile: string | null; status: string;
  limits: { allowSpawn: boolean; allowedChildProfiles: string[] };
  driveEnv?: Record<string, string> | null;
}
/** Why the fallback did nothing for a run that had something to consolidate (`plugin.context-memory.consolidator_skipped`). */
export type SkipReason = "off" | "late_lessons" | "cancelled" | "consolidator_failed" | "spawn_refused" | "verify_failed" | "merge_failed";
export type FallbackPlan =
  /** `after`: for the follow-up (key `consolidator-late`), the last consolidator that ended done before these lessons. */
  | { do: "spawn"; lessons: number; key: string; after?: string }
  | { do: "land"; agentId: string; commit: string }
  | { do: "skip"; reason: SkipReason; text: string };

/** The task a consolidator the fallback starts is given (fixed, so a replayed spawn is the same spawn). */
export const FALLBACK_TASK = "Consolidate this run's lessons";
/** The key it is spawned with, at the run's top: the same agent however often the fallback asks. */
export const FALLBACK_KEY = "consolidate";
/** The follow-up's task and key (D6a): one per run, for the lessons proposed after its consolidator started. */
export const LATE_TASK = "Consolidate the lessons this run's agents proposed after its consolidator started";
export const LATE_KEY = "consolidator-late";

const ENDED = new Set(["done", "failed", "cancelled"]);
/** An agent whose orchestration skill tells it to spawn the consolidator (src/subagents/skill.ts consolidatorRule). */
export const mayConsolidate = (a: Pick<RunAgent, "limits">) => a.limits.allowSpawn && a.limits.allowedChildProfiles.includes(CONSOLIDATOR_PROFILE);

/**
 * What the fallback does for a run now (pure): nothing (null) while an agent that may spawn the consolidator still works
 * (it is theirs to do, D6), or a consolidator still runs (its end decides), or the run has nothing to consolidate; else
 * land the branch of a consolidator that ended with one nobody asked to merge; else, with candidates and no consolidator,
 * start one; else, when a consolidator ended done and lessons came after it started (`lessons.late`: the planner's own,
 * declared after it spawned it), start one follow-up for those (key `consolidator-late`, at most one per run). `skip`
 * says why not, when there was something to do: the setting is off (`late_lessons` for the follow-up), the run's planner
 * was cancelled (a person stopped it), or the consolidator it had failed or was cancelled (capcomd starts no other).
 */
export function fallbackPlan(o: { agents: ReadonlyArray<RunAgent>; lessons: import("../context/consolidator").RunLessons; merged: ReadonlySet<string>; enabled: boolean }): FallbackPlan | null {
  const owners = o.agents.filter(mayConsolidate);
  if (!owners.length || owners.some((a) => !ENDED.has(a.status))) return null;
  const cs = o.lessons.consolidators;
  if (cs.some((c) => !ENDED.has(c.status))) return null;
  const cancelled = owners.find((a) => a.status === "cancelled");
  const unmerged = cs.find((c) => c.status === "done" && c.commit && !o.merged.has(c.agentId));
  const n = o.lessons.candidates + o.lessons.pending;
  const done = cs.filter((c) => c.status === "done");
  if (!unmerged && !n) return null;
  if (!unmerged && done.length) {
    const late = o.lessons.late;
    if (!late) return null;
    // At most one follow-up per run: once it ended done, what came after it is left (it is said in `capcomd status`).
    const again = cs.find((c) => c.key === LATE_KEY);
    if (again?.status === "done") return null;
    const last = done[done.length - 1]!;
    const what = `the run's agents proposed ${late} lesson${late === 1 ? "" : "s"} after ${last.agentId} (${CONSOLIDATOR_PROFILE}) started`;
    if (again) return { do: "skip", reason: "consolidator_failed", text: `${what}, and ${again.agentId}, started for them, ended ${again.status}, so capcomd starts no other.` };
    if (!o.enabled) return { do: "skip", reason: "late_lessons", text: `${what}; autoConsolidate is off, so capcomd leaves them to the planner.` };
    if (cancelled) return { do: "skip", reason: "cancelled", text: `${what}; ${cancelled.agentId} was cancelled, so capcomd leaves them.` };
    return { do: "spawn", lessons: late, key: LATE_KEY, after: last.agentId };
  }
  const lessons = `the run's agents proposed ${n} lesson${n === 1 ? "" : "s"}`;
  // Every consolidator so far failed or was cancelled: capcomd starts no other.
  const failed = unmerged ? undefined : cs[0];
  const what = unmerged ? `${unmerged.agentId}'s memory change (${unmerged.commit!.slice(0, 12)}) was never merged`
    : failed ? `${lessons} and ${failed.agentId} (${CONSOLIDATOR_PROFILE}) ended ${failed.status}` : `${lessons} and no ${CONSOLIDATOR_PROFILE} ran`;
  if (!o.enabled) return { do: "skip", reason: "off", text: `${what}; autoConsolidate is off, so capcomd leaves it to the planner.` };
  if (cancelled) return { do: "skip", reason: "cancelled", text: `${what}; ${cancelled.agentId} was cancelled, so capcomd leaves it.` };
  if (unmerged) return { do: "land", agentId: unmerged.agentId, commit: unmerged.commit! };
  if (failed) return { do: "skip", reason: "consolidator_failed", text: `${what}, so capcomd starts no other.` };
  return { do: "spawn", lessons: n, key: FALLBACK_KEY };
}

/** What the fallback reads and does besides the payload (a test replaces it). */
export const fallbackKernel = {
  /** The ended agent, as the kernel recorded it. */
  agent: async (runId: string, agentId: string): Promise<RunAgent> => (await (await import("../primitives/ops")).getAgentOrThrow(runId, agentId)) as unknown as RunAgent,
  /** The run's agents, what it holds for its memory, and the agents whose work a merge was asked for (any state). */
  state: async (runId: string): Promise<{ agents: RunAgent[]; lessons: import("../context/consolidator").RunLessons; merged: Set<string> }> => {
    const { client } = await import("../core/relay");
    const s = client().scope.getOrCreate([runId]);
    const agents = (await s.listAgents({})) as unknown as RunAgent[];
    const merges = (await s.listOps({ kind: "merge" })) as Array<{ data: { agentId?: unknown } }>;
    const { runLessons } = await import("../context/consolidator");
    return { agents, lessons: await runLessons(runId), merged: new Set(merges.map((m) => m.data.agentId).filter((x): x is string => typeof x === "string")) };
  },
  /** Start the run's consolidator at its top (`key`: the fallback's, or its follow-up's), with the drive settings of the
   *  agent that ended (its agents file: the project's profiles). Idempotent by its key. */
  spawn: async (runId: string, driveEnv: Record<string, string> | null, key: string = FALLBACK_KEY): Promise<{ agentId: string; created: boolean }> => {
    const { spawnAgent } = await import("../primitives/ops");
    const late = key === LATE_KEY;
    const a = await withDriveEnv(driveEnv, () => spawnAgent({ runId, profile: CONSOLIDATOR_PROFILE, task: late ? LATE_TASK : FALLBACK_TASK, key, title: late ? "late memory lessons" : "memory lessons" }));
    return { agentId: a.agentId, created: !!a.created };
  },
  /** Verify consolidator `agentId`'s branch at `commit` (a passed verify of that commit is used again), then ask to
   *  merge it as an agent's merge is asked: parked for a person on a protected target, and held by this plugin's gate
   *  under `review: human`. Idempotent by its keys. */
  land: async (runId: string, agentId: string, commit: string): Promise<{ verify: { id: string; state: string }; merge: { id: string; state: string; heldBy?: unknown } | null }> => {
    const O = await import("../primitives/ops");
    const { client } = await import("../core/relay");
    const ops = (await client().scope.getOrCreate([runId]).listOps({ kind: "verify", state: "passed" })) as Array<{ id: string; data: { agentId?: unknown }; result?: { commit?: unknown } | null }>;
    const done = ops.find((v) => v.data.agentId === agentId && v.result?.commit === commit);
    const v = done ? { id: done.id, state: "passed" } : ((await O.verifyRef({ runId, ref: agentId, key: `memory-verify-${agentId}` })) as { id: string; state: string });
    if (v.state !== "passed") return { verify: v, merge: null };
    const m = (await O.mergeRef({ runId, ref: agentId, require: v.id, key: `memory-merge-${agentId}`, requestApproval: true })) as { id: string; state: string; heldBy?: unknown };
    return { verify: v, merge: m };
  },
};

/** Landings in flight in this process (a test waits for them: `settleFallbacks`). */
const landing = new Set<Promise<unknown>>();
/** Wait (at most `ms`) for the fallback's landings this process started. */
export async function settleFallbacks(ms = 60_000): Promise<void> {
  if (landing.size) await Promise.race([Promise.allSettled([...landing]), new Promise((r) => setTimeout(r, ms))]);
}

type Emit = (type: string, text: string, data: Record<string, unknown>, key: string) => Promise<unknown>;

/**
 * The fallback for run `runId` after agent `ended` ended (ADR-025 D6a): `fallbackPlan` on the run as it is now, then
 * what it says: a consolidator started (and its end comes back here), a branch verified and its merge asked (in the
 * background: a verify takes minutes, an observe listener must not), or why not. After a landing it plans again, as
 * if that branch were merged (another branch nobody merged, or late lessons a follow-up takes). Every event is keyed,
 * so a replayed change records nothing twice; the spawn, the verify and the merge are idempotent by their keys.
 * Returns the first plan.
 */
export async function fallback(runId: string, ended: RunAgent, o: { enabled: boolean; emit: Emit; log: (m: string, f: Record<string, unknown>) => void }): Promise<FallbackPlan | null> {
  const st = await fallbackKernel.state(runId);
  const merged = new Set(st.merged);
  let first: FallbackPlan | null = null;
  // Bounded: each landing marks one more consolidator merged, and any other plan ends it.
  for (let i = 0; i <= st.lessons.consolidators.length; i++) {
    const plan = fallbackPlan({ ...st, merged, enabled: o.enabled });
    if (!plan) break;
    first ??= plan;
    await act(runId, ended, st, plan, o);
    if (plan.do !== "land") break;
    merged.add(plan.agentId);
  }
  return first;
}

/** Do what `plan` says for run `runId` (`fallback`). */
async function act(runId: string, ended: RunAgent, st: Awaited<ReturnType<typeof fallbackKernel.state>>, plan: FallbackPlan, o: { emit: Emit; log: (m: string, f: Record<string, unknown>) => void }): Promise<void> {
  const skipped = (reason: SkipReason, text: string, data: Record<string, unknown> = {}) => o.emit("consolidator_skipped", text, { reason, ...data }, `consolidator-skipped:${runId}:${reason}${typeof data.agentId === "string" ? `:${data.agentId}` : ""}`);
  if (plan.do === "skip") { await skipped(plan.reason, plan.text); return; }
  if (plan.do === "spawn") {
    const owner = st.agents.find((a) => a.agentId === ended.agentId && mayConsolidate(a)) ?? st.agents.find(mayConsolidate);
    const who = owner?.agentId ?? "The run's planner";
    const n = `${plan.lessons} candidate lesson${plan.lessons === 1 ? "" : "s"}`;
    const late = plan.key === LATE_KEY;
    try {
      const a = await fallbackKernel.spawn(runId, owner?.driveEnv ?? null, plan.key);
      const text = late
        ? `${who} ended with ${n} that came after ${plan.after} (${CONSOLIDATOR_PROFILE}) started, so it never read them: capcomd started ${a.agentId} to consolidate only those; its change waits for a person before it lands.`
        : `${who} ended with ${n} and no ${CONSOLIDATOR_PROFILE}: capcomd started ${a.agentId} to consolidate them; its change waits for a person before it lands.`;
      await o.emit("consolidator_started", text, { agentId: a.agentId, after: owner?.agentId ?? null, lessons: plan.lessons, ...(late ? { late: true, consolidator: plan.after ?? null } : {}) },
        `consolidator-started:${runId}${late ? `:${LATE_KEY}` : ""}`);
    } catch (e) {
      const why = String((e as Error)?.message ?? e).slice(0, 500);
      await skipped("spawn_refused", `capcomd couldn't start ${CONSOLIDATOR_PROFILE} for the run's ${plan.lessons} lesson${plan.lessons === 1 ? "" : "s"}: ${why}`, { error: why });
    }
    return;
  }
  // The verify and the merge resolve the run's reviewer and checks from the consolidator's agents file (its drive
  // settings, the project's profiles), as its spawner's in-VM verify would: never the daemon's own file, nor whichever
  // agent's settings this listener's queue happened to start under.
  const cons = st.agents.find((a) => a.agentId === plan.agentId);
  const driveEnv = cons?.driveEnv ?? st.agents.find(mayConsolidate)?.driveEnv ?? null;
  const p: Promise<unknown> = withDriveEnv(driveEnv, () => fallbackKernel.land(runId, plan.agentId, plan.commit)).then(async (r) => {
    if (!r.merge) return skipped("verify_failed", `${plan.agentId}'s memory change didn't pass its verify (${r.verify.id}: ${r.verify.state}), so capcomd didn't ask to merge it.`, { agentId: plan.agentId, verify: r.verify.id });
    const held = r.merge.state === "awaiting_approval";
    return o.emit("merge_requested", `capcomd asked to merge ${plan.agentId}'s memory change (${r.merge.id}): ${held ? `it waits for a person: capcomd approve ${runId} ${r.merge.id}` : r.merge.state}.`,
      { agentId: plan.agentId, commit: plan.commit, verify: r.verify.id, merge: r.merge.id, state: r.merge.state }, `merge-requested:${r.merge.id}`);
  }).catch(async (e) => {
    const why = String((e as Error)?.message ?? e).slice(0, 500);
    o.log("could not land a consolidator's branch", { runId, agentId: plan.agentId, error: why });
    await skipped("merge_failed", `capcomd couldn't ask to merge ${plan.agentId}'s memory change: ${why}`, { agentId: plan.agentId, error: why }).catch(() => {});
  }).finally(() => landing.delete(p));
  landing.add(p);
}

export const plugin = definePlugin<MemoryConfig>({
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

    // The fallback (ADR-025 D6a): after the end of an agent that may spawn the consolidator, or of a consolidator. Only
    // in the daemon, where agents end; it never throws (an observe listener that failed three times running would
    // suspend the gates with it, spec §6.5).
    ctx.hooks.on("agent.changed", async (call) => {
      const { agent, change } = call.payload;
      if (change.kind !== "ended") return;
      try {
        const a = await fallbackKernel.agent(agent.runId, agent.id);
        if (a.profile !== CONSOLIDATOR_PROFILE && !mayConsolidate(a)) return;
        // A run may turn it off (`capcomd run --plugin-config context-memory.autoConsolidate=false`) over the files.
        const own = (await ctx.storage.get({ runId: agent.runId }, "config").catch(() => undefined)) as Partial<MemoryConfig> | undefined;
        const enabled = typeof own?.autoConsolidate === "boolean" ? own.autoConsolidate : ctx.config.get().autoConsolidate !== false;
        const emit: Emit = (type, text, data, key) => ctx.events.emit({ type, stream: agent.runId, entity: typeof data.agentId === "string" ? data.agentId : agent.id, text, data }, { key });
        await fallback(agent.runId, a, { enabled, emit, log: (m, f) => ctx.log.warn(m, f) });
      } catch (e) {
        ctx.log.warn("the memory fallback couldn't look at the run", { runId: agent.runId, agentId: agent.id, error: (e as Error)?.message ?? String(e) });
      }
    });
  },
});
