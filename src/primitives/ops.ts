import { isSandboxUnreachable, isTransientSandboxError } from "../providers/boxd-errors";
import { sandboxAuthError } from "../plugins/sandboxes";
import { redactShapes } from "../agents/redact";
import { bootSnapshot, EnvironmentProblem, resolveEnvSnapshot } from "../env/resolve";
import { profileFor } from "../auth/profiles";
import { withSandbox } from "../providers/run-sandbox";
import { LIFECYCLE_HINT, lifecycleProblem } from "../plugins/lifecycle";
// ADR-016 step 1: run new / spawn / await / wait-any / cancel, on top of the existing worker
// actor. The CLI is a thin client; durable state lives in the scope actor (agent tree, keys,
// events) and the worker actor (VM, agent run, push). A driver process advances one agent;
// it holds a renewable lease, so a crashed driver is taken over by the next await/wait-any.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { tmpdir } from "os";
import { client, assertEngine, cancelRun, existingActor } from "../core/relay";
import { RelayError } from "../core/errors";
import { agentsFilePath, applyOverrides, decodeAgentRef, encodeAgentRef, lifecyclePlugins, pinnedMachine, pinnedRuntime, resolveAgent, runtimeProblems, AgentConfigError, type AgentSpec, type Overrides, type ResolvedAgent } from "../profiles";
import { agentEffort, agentModel, isRealAgent } from "../agents/config";
import { available, treeSpend, paramsHash, parseBudget, parseGrant, stableId, TERMINAL_AGENT, type Budget, type Grant } from "./policy";
import { noticeOf, treeView, rollups, subtree } from "../subagents/results";
import { checkpointRef, stoppedAt } from "../agents/runner";
import type { ScopeAgent } from "../actors/scope";
import { skillBlock, type AttachedSkill } from "../agents/skills";
import { ORCHESTRATION_SKILL_NAME, pinnedSkills } from "../profiles/skills";
import { untrustedSkillsHint, untrustedSkillsProblem } from "../profiles/trust";
import { attachmentId } from "../api/inline-cap";
import { runScripted, ScriptFailed, withVmRpc } from "../subagents/driver";
import { hasVmCapcomd } from "../subagents/skill";
import { mayRunJobs } from "../subagents/token";
import { killpoint } from "../utils/killpoint";
import { captureDriveEnv, env } from "../utils/env";
import { parseVerdict } from "./review";
import type { AgentPreparing, PreparePatch, ReviewReport } from "../../packages/plugin/src/hooks";
import { agentSpanId, discardSpan, rootSpanIdForRun, withSpan } from "../utils/tracing-simple";
import { stateDir } from "../utils/home";
import { clearQuota, loginOf, quotaRetryMs, quotaUntil, recordQuota } from "./quota";
import { startDriver } from "./drivers";
import { engineDrivesAgents } from "../utils/agent-workflow-flag";
import { realSandbox, sandboxCaps, sandboxName } from "../providers/registry";
import { OPEN_EGRESS } from "../providers/sandbox";
import { normalizeTitle, shownTitle, type TitleBy } from "./agent-title";
import { applyPreparePatch, applyProfilePatch, applyRunPatch, applySpawnPatch, gates, hooks, inBackground, preparingAgent, principalOf, refusedError, refusedText, skillHash, untrusted } from "../plugins/hooks";
import { agentOf, approvalOf, mergeOf, pinnedOf, verificationOf } from "../plugins/shapes";
import { agentSeam } from "../plugins/agents";
import { sameHold, type PluginHold } from "../merge/types";
import { isInternalActorError } from "../utils/actor-errors";
export { startDriver };

/** An agent's worker for one attempt: each resume (epoch) gets a fresh worker, so a new VM and a new push. */
const workerOf = (runId: string, agentId: string, epoch = 1) => client().worker.getOrCreate(epoch > 1 ? [runId, agentId, `e${epoch}`] : [runId, agentId]);

// Read when used, not at load: with the agent workflow (ADR-022) an engine host drives agents spawned with different
// settings (withDriveEnv), and a driver process reads the same values either way.
const leaseMs = () => Number(env("DRIVER_LEASE_MS") ?? 15_000);
const pollMs = () => Number(env("AWAIT_POLL_MS") ?? 300);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Map an actor UserError (code) onto the CLI's error envelope. */
export function asRelay(e: unknown): never {
  const err = e as { code?: string; message?: string; group?: string };
  const code = err?.code;
  const msg = err?.message ?? String(e);
  if (code === "conflict") throw new RelayError("conflict", msg, "Use a new --key, or repeat the call with the same parameters.");
  if (code === "not_found") throw new RelayError("not_found", msg, "Check ids with `capcomd agents-of <runId> --json` / `capcomd run new`.");
  if (code === "children_limit" || code === "widening") throw new RelayError("config", msg, "Spawn a profile the parent allows, narrow the overrides, or (operator) pass --operator for spec widening.");
  if (code === "lease_held") throw new RelayError("conflict", msg, "Claim another task (omit the id to take the next free one), or wait for the lease to expire.");
  if (code === "lease_lost" || code === "not_claimed") throw new RelayError("conflict", msg, "Your lease was taken over (its epoch moved). Stop work on this task; claim again if it is still open.");
  if (code === "blocked") throw new RelayError("conflict", msg, "Finish its --after tasks first, or claim without an id to get the next ready task.");
  if (code === "cycle") throw new RelayError("usage", msg, "A task may only depend on tasks that don't (transitively) depend on it.");
  if (code === "too_large") throw new RelayError("usage", msg, "Store large blobs elsewhere (a branch, a file in the repo) and put a reference in kv. Cap: CAPCOMD_KV_MAX_BYTES on the engine.");
  if (code === "cas_mismatch") throw new RelayError("conflict", msg, "Re-read with `capcomd kv get`, recompute, and cas with the new --expect version.");
  if (code === "backpressure") throw new RelayError("conflict", msg, "Fan-out is at the limit your parent granted: `capcomd wait-any` for a child to finish (or cancel one), then spawn again.", { retryable: true, code: "backpressure" });
  if (code === "deadlock") throw new RelayError("conflict", msg, "Await only your own children; never an ancestor or an agent that is waiting on you.", { code: "deadlock" });
  if (code === "budget" || code === "parent_terminal") throw new RelayError("conflict", msg, "Request a smaller --budget or free budget by cancelling agents.");
  if (code === "grant") throw new RelayError("conflict", msg, "Grant less, give the parent more first (or raise the run's budget: capcomd grant <runId> --budget …), or free budget by cancelling agents.");
  if (code === "finished") throw new RelayError("conflict", msg, "A finished agent can't be given more: spawn one that continues from its branch (result.branch).");
  if (code === "rate_limited") throw new RelayError("conflict", msg, "Keep the title you have; rename only when the focus really changes.", { code: "rate_limited" });
  if (code === "usage") throw new RelayError("usage", msg, /title/.test(msg) ? TITLE_HINT : "Check the command's arguments.");
  throw e;
}

/** How a title is written (capability agents.title). */
export const TITLE_HINT = 'A title is 1 to 4 lowercase words naming what the agent works on, at most 32 characters, e.g. "login redirect".';

/**
 * Name an agent (capability agents.title): `by` self or parent from a VM (rate limited), driver from the host (CLI,
 * MCP), user from the apps (PUT …/title; null clears it). `shown: false`: the user's title holds the tab, and this
 * one shows once they clear theirs.
 */
export async function setAgentTitle(runId: string, agentId: string, title: string | null, o: { by: TitleBy; setBy: string; key?: string }) {
  await assertEngine();
  if (title !== null) {
    const n = normalizeTitle(title);
    if (!n.ok) throw new RelayError("usage", n.error, TITLE_HINT);
    title = n.title;
  }
  await getAgentOrThrow(runId, agentId);
  const r = await client().scope.getOrCreate([runId]).setTitle({ agentId, title, by: o.by, setBy: o.setBy, ...(o.key ? { key: o.key } : {}) }).catch(asRelay);
  return { runId, ...r, ...(r.shown ? {} : { note: "The user renamed this agent: their title stays on its tab until they clear it; yours is kept and shows then." }) };
}

/** The run's title from its planner (`capcomd title --run`): Run.title (titleSource agent) unless the run has a label of its own. */
export async function setRunTitle(runId: string, title: string, o: { setBy: string; key?: string }) {
  await assertEngine();
  const n = normalizeTitle(title);
  if (!n.ok) throw new RelayError("usage", n.error, TITLE_HINT);
  const r = await client().scope.getOrCreate([runId]).setRunTitle({ title: n.title, setBy: o.setBy, ...(o.key ? { key: o.key } : {}) }).catch(asRelay);
  return { runId, ...r };
}

/** Operator-named checks (`run new --checks-set name=CMD`) live here; VMs can read `_` keys, never write them. */
export const CHECKS_KV = "_checks";
/** The run's reviewer profile (`run new --reviewer P`): every verify of the run is also reviewed by it. */
export const REVIEWER_KV = "_reviewer";
/** The run's merge target (`run new --target T`): the default for every verify and merge in the run. */
export const TARGET_KV = "_target";
/** Where the run's spans are written (CAPCOMD_TRACE_DIR when the run was created), for readers in other shells. */
export const TRACE_KV = "_trace";
/** The run's goal branch (`run new --goal-branch G --base B`): {branch, base}. Its target is that branch, and reviewed
 *  work lands on it by a direct push with no approval, whatever the repo's merge mode (src/primitives/goal.ts). */
export const GOAL_KV = "_goal";

/** The run's recorded trace directory, if any. */
export async function runTraceDir(runId: string): Promise<string | undefined> {
  // A lookup, never a create (an unknown run must not get a scope actor), bounded: callers fall back to "no trace".
  const look = (async () => (await (client().scope as any).get([runId]).kvGet({ k: TRACE_KV }))?.value)().catch(() => null);
  const v: any = await Promise.race([look, new Promise((r) => setTimeout(() => r(null), 2000))]);
  return typeof v?.dir === "string" ? v.dir : undefined;
}

/** The run's target branch, if the operator set one. */
export async function runTarget(runId: string): Promise<string | undefined> {
  const v: any = (await client().scope.getOrCreate([runId]).kvGet({ k: TARGET_KV }).catch(() => null))?.value;
  return typeof v?.branch === "string" ? v.branch : undefined;
}

/** The run's goal branch and base, when it has one. */
export async function runGoal(runId: string): Promise<{ branch: string; base: string } | undefined> {
  const v: any = (await client().scope.getOrCreate([runId]).kvGet({ k: GOAL_KV }).catch(() => null))?.value;
  return typeof v?.branch === "string" && typeof v?.base === "string" ? { branch: v.branch, base: v.base } : undefined;
}
/** A merge or verify into the run's goal branch: pushed directly (no PR per child), never parked for approval. */
const onGoal = (goal: { branch: string } | undefined, target: string) => !!goal && goal.branch === target;

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;
/**
 * Create `branch` on the remote at `from`'s tip if it doesn't exist yet (a per-run staging branch, or a run's goal
 * branch). Ref work only: one `ls-remote`, a shallow fetch of `from` and a ref push, each bounded (no clone of the
 * repository). `goal`: the branch is this run's goal branch; one that exists is used only when it is this run's own
 * (`own`), or a leftover with nothing on it beyond `from` whose run has ended (`reusable`), then moved up to `from`'s tip.
 */
async function ensureBranch(runId: string, branch: string, from: string, o: { goal?: boolean; own?: boolean; reusable?: (sha: string) => Promise<string | null> } = {}): Promise<{ created: boolean; reused?: boolean; ms: number }> {
  const t0 = Date.now();
  const { loadMergeConfig } = await import("../merge/config");
  const cfg = loadMergeConfig();
  if (!cfg) {
    if (o.goal) return { created: false, ms: 0 }; // no repository: nothing to cut (dry-run merges)
    throw new RelayError("config", "--target-from needs a repository (CAPCOMD_REPO)", "Set CAPCOMD_REPO, or create the branch yourself and pass only --target.");
  }
  const R = await import("../merge/repo");
  let heads: Record<string, string | null>;
  try { heads = await R.remoteHeads(cfg, [branch, from]); }
  catch (e) { throw new RelayError("config", `couldn't read ${cfg.remote}: ${(e as Error).message}`, "Check the network and your git access to the repository, then try again.", { retryable: true }); }
  const have = heads[branch] ?? null, base = heads[from] ?? null;
  if (have && (!o.goal || o.own)) return { created: false, ms: Date.now() - t0 };
  const where = o.goal ? "--base" : "--target-from";
  if (!base) throw new RelayError("not_found", `${where} ${from}: branch not found on ${cfg.remote}`, "Name an existing branch to cut it from.", { code: o.goal ? "base" : undefined });
  if (have) {
    // A goal branch that is already there: another run's. Only a leftover with nothing of its own may be taken over.
    if (have === base) {
      const why = o.reusable ? await o.reusable(have) : null;
      if (why) throw new RelayError("conflict", `goal branch ${branch} already exists on the remote: ${why}`, "Pick a new name: each run's work lands on a branch of its own.", { code: "goalBranch" });
      return { created: false, reused: true, ms: Date.now() - t0 };
    }
    const why = o.reusable ? await o.reusable(have) : null;
    if (why) throw new RelayError("conflict", `goal branch ${branch} already exists on the remote: ${why}`, "Pick a new name: each run's work lands on a branch of its own.", { code: "goalBranch" });
    const ff = await R.pointRemoteBranch(cfg, branch, from, base, { expect: have, fastForwardOnly: true, depth: 200 });
    if (!ff.ok) throw new RelayError("conflict", `goal branch ${branch} already exists on the remote${ff.reason === "not_ancestor" ? ` with commits ${from} doesn't have` : ` and couldn't be moved to ${from} (${ff.detail})`}`, "Pick a new name: each run's work lands on a branch of its own.", { code: "goalBranch" });
    return { created: false, reused: true, ms: Date.now() - t0 };
  }
  const made = await R.pointRemoteBranch(cfg, branch, from, base, { expect: null });
  if (!made.ok) {
    // Someone else made it meanwhile: fine for a staging branch; a goal branch is checked again on the retry.
    const now = await R.remoteHeads(cfg, [branch]).catch(() => ({} as Record<string, string | null>));
    if (!now[branch] || o.goal) throw new RelayError("conflict", `could not create ${branch}: ${made.detail}`, "Check push access to the repository.");
  }
  return { created: true, ms: Date.now() - t0 };
}

/**
 * Why an existing goal branch can't be this new run's (null: it can): another run on this machine made it and hasn't
 * ended. Its commit is at (or behind) the base, so nothing landed on it. Bounded reads; a run that doesn't answer counts
 * as live.
 */
async function goalBranchOwner(runId: string, branch: string): Promise<string | null> {
  const { within } = await import("../utils/within");
  const rows = recentRuns(200).filter((r) => r.runId !== runId);
  const live = await Promise.all(rows.map(async (r) => {
    // Rows written before runs recorded their goal branch: read it from the run itself.
    if (r.goalBranch !== undefined && r.goalBranch !== branch) return null;
    try {
      return await within((async () => {
        const sc = await existingActor("scope", [r.runId]);
        if (!sc) return null;
        if (r.goalBranch === undefined) {
          const g: any = (await sc.kvGet({ k: GOAL_KV }).catch(() => null))?.value;
          if (g?.branch !== branch) return null;
        }
        const meta = await sc.getScope({});
        return meta && !meta.ended ? r.runId : null;
      })(), 5_000);
    } catch { return r.goalBranch === branch ? r.runId : null; }
  }));
  const owner = live.find(Boolean);
  return owner ? `run ${owner} uses it and hasn't ended (cancel it first, or pick a new name)` : null;
}
const CHECK_NAME = /^[A-Za-z0-9._-]{1,64}$/;

/** `name=command` pairs → { name: command }. Names: letters, digits, . _ - (max 64). */
export function parseCheckSet(pairs: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of pairs) {
    const i = p.indexOf("=");
    const name = i > 0 ? p.slice(0, i) : "", cmd = i > 0 ? p.slice(i + 1).trim() : "";
    if (!CHECK_NAME.test(name) || !cmd) throw new RelayError("usage", `bad --checks-set ${JSON.stringify(p)}`, "Use --checks-set name='command' (name: letters, digits, . _ -), once per check.");
    if (name in out) throw new RelayError("usage", `check "${name}" is set twice`, "Give each check a distinct name.");
    out[name] = cmd;
  }
  return out;
}

/** The command an operator-named check runs. Unknown names are refused with the list of known ones. */
export async function namedCheck(runId: string, name: string): Promise<string> {
  const S = await import("./state"); // state imports ops: keep the cycle out of module init
  const set = (await S.kvGet(runId, CHECKS_KV)).value as Record<string, unknown> | null;
  const cmd = CHECK_NAME.test(name) && set && Object.hasOwn(set, name) ? set[name] : undefined;
  if (typeof cmd !== "string") {
    const known = set ? Object.keys(set) : [];
    throw new RelayError("usage", `no check named "${name}" in ${runId}`, known.length ? `Known checks: ${known.join(", ")}.` : "This run has no named checks (the operator sets them with `capcomd run new --checks-set name='cmd'`).");
  }
  return cmd;
}

/** The names of the run's operator-named checks (`run new --checks-set`, or the project's `run.checks`). */
async function namedCheckNames(runId: string): Promise<string[]> {
  const set = (await (await import("./state")).kvGet(runId, CHECKS_KV)).value as Record<string, unknown> | null;
  return set ? Object.keys(set).filter((k) => typeof set[k] === "string") : [];
}

export interface RunNewOpts { budget: Budget; label?: string; goal?: string; key?: string; runId?: string; checks?: Record<string, string>; reviewer?: string; target?: string; targetFrom?: string;
  /** The run's own sandbox (`capcomd run --sandbox`): its agents and checks run there, not on the daemon's CAPCOMD_SANDBOX. */
  sandbox?: string;
  /** The run's goal branch (`--goal-branch G --base B`): cut from `base`, the run's target; reviewed work lands on it
   *  directly and the user opens a pull request from it into `base` when the planner is done. Needs `base`. */
  goalBranch?: string; base?: string;
  /** The run's plugin config (plugin API §10.2 layer 5, `--plugin-config`): only per-run settings, checked here and kept
   *  in each plugin's run storage (src/plugins/run-config.ts). */
  pluginConfig?: Record<string, Record<string, unknown>> }
/** What a run's key is scoped by: the project's repository (its clone URL), else the project's directory (the nearest
 *  .capcomd/config.json, else the working directory). */
export function projectIdentity(source: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  const repo = env("REPO", source);
  if (repo) return `repo:${(require("../merge/config") as typeof import("../merge/config")).normalizeRemote(repo)}`;
  return `dir:${(require("../config/projects") as typeof import("../config/projects")).projectDirOf(cwd, source) ?? resolve(cwd)}`;
}

/** The id `run new --key K` gives a run: the key within its project, so two projects whose drivers pick the same key
 *  (tinycalc-run-1) get two runs; the same project and key, the same run. */
export function runIdFor(key: string, source: Record<string, string | undefined> = process.env, cwd = process.cwd()): string {
  return stableId("run", `run\0${projectIdentity(source, cwd)}`, key);
}

/**
 * The run a key names here: runIdFor's, unless only a run from before keys were scoped by project (0.8 and earlier: the
 * key alone) exists, and it is this project's (the repository it recorded is this one, or neither has one). Then that
 * run, so a retry across an upgrade gets its run back; another project's old run is never handed out.
 */
async function keyedRunId(key: string): Promise<string> {
  const id = runIdFor(key);
  if (await existingActor("scope", [id]).catch(() => null)) return id;
  const legacy = stableId("run", "run", key);
  const old = await existingActor("scope", [legacy]).catch(() => null);
  if (!old || !(await old.getScope({}).catch(() => null))) return id;
  const { RUN_REPO_KV } = await import("../merge/run-config");
  const rec: any = await old.kvGet({ k: RUN_REPO_KV }).catch(() => null);
  const had = rec && !rec.deleted && typeof rec.value?.CAPCOMD_REPO === "string" ? (rec.value.CAPCOMD_REPO as string) : null;
  const repo = env("REPO");
  const { normalizeRemote } = await import("../merge/config");
  return (had && repo ? normalizeRemote(had) === normalizeRemote(repo) : !had && !repo) ? legacy : id;
}

export async function runNew(o: RunNewOpts) {
  await assertEngine();
  const runId = o.runId ?? (o.key ? await keyedRunId(o.key) : stableId("run", "run"));
  const c = client();
  const hasChecks = !!o.checks && Object.keys(o.checks).length > 0;
  if (o.reviewer) reviewerSpec(o.reviewer); // unknown profiles are refused here, not at verify time
  if (o.sandbox !== undefined) {
    const n = o.sandbox.toLowerCase();
    if (!(await import("../providers/registry")).isProviderName(n)) throw new RelayError("usage", `sandbox ${JSON.stringify(o.sandbox)} isn't one capcomd knows`, `Name one of: ${(await import("../providers/registry")).LISTED_PROVIDERS.join(", ")}.`, { code: "sandbox" });
    o = { ...o, sandbox: n };
  }
  {
    // The forge the run's settings name (CAPCOMD_MERGE_FORGE) must be active (plugin API §7.1): refused now, not at its first merge.
    const { loadMergeConfig } = await import("../merge/config");
    const forge = (() => { try { return loadMergeConfig(process.env)?.forge; } catch { return null; } })();
    const off = await (await import("../plugins/forges")).inactiveForge(forge);
    if (off) throw new RelayError("config", off.message, off.hint, { code: "forge" });
  }
  if (o.target !== undefined && !BRANCH_NAME.test(o.target)) throw new RelayError("usage", `bad --target ${JSON.stringify(o.target)}`, "Name a branch, e.g. --target capcomd/integration.");
  if (o.goalBranch !== undefined || o.base !== undefined) {
    // A goal branch is the run's target, cut from its base: never "main" by default, never protected, never the base.
    if (o.goalBranch === undefined || o.base === undefined) throw new RelayError("usage", "--goal-branch and --base go together", "Pass both: --goal-branch capcomd/<topic> --base <the branch it starts from>.", { code: o.base === undefined ? "base" : "goalBranch" });
    if (o.target !== undefined && o.target !== o.goalBranch) throw new RelayError("usage", "--target and --goal-branch name different branches", "A goal branch is the run's target: pass only --goal-branch.");
    const G = await import("../merge/goal");
    const bp = G.baseProblem(o.base);
    if (bp) throw new RelayError("usage", `--base: ${bp}`, "Name the branch the goal branch starts from.", { code: "base" });
    const gp = G.goalBranchProblem(o.goalBranch, { base: o.base, env: await (await import("../merge/run-config")).runEnv(undefined) });
    if (gp) throw new RelayError("usage", `--goal-branch: ${gp}`, "Pick another goal branch name.", { code: "goalBranch" });
    // A new run's goal branch is a new branch: another run's (or anyone's) work must not end up in this run's pull request.
    const prior = await runGoal(runId);
    if (prior && (prior.branch !== o.goalBranch || prior.base !== o.base)) throw new RelayError("conflict", `run ${runId} already has goal branch ${prior.branch} (from ${prior.base})`, "Start a new run for another goal branch.", { code: "goalBranch" });
    // An existing goal branch is checked when it's cut (ensureBranch): this run's own, or a leftover of an ended run
    // with nothing on it, is used; anything else is refused.
    o = { ...o, target: o.goalBranch, targetFrom: o.base };
  }
  if (o.targetFrom !== undefined && o.target === undefined) throw new RelayError("usage", "--target-from needs --target", "Pass the branch to create: --target T --target-from <base>.");
  const RC = await import("../plugins/run-config");
  const pluginConfig = o.pluginConfig && Object.keys(o.pluginConfig).length ? await RC.checkRunPluginConfig(o.pluginConfig) : null;
  if (hooks.listening("run.creating")) o = await runCreating(runId, o);
  const ph = paramsHash({ budget: o.budget, label: o.label ?? null, ...(hasChecks ? { checks: o.checks } : {}), ...(o.reviewer ? { reviewer: o.reviewer } : {}), ...(o.target ? { target: o.target } : {}), ...(o.sandbox ? { sandbox: o.sandbox } : {}), ...(o.base ? { base: o.base } : {}) });
  const res = await c.scope.getOrCreate([runId]).init({ runId, budget: o.budget, label: o.label, ...(o.goal ? { goal: o.goal } : {}), paramsHash: ph }).catch(asRelay);
  // The run carries its repository settings, so the engine (e.g. a background service) needn't have them.
  const { repoEnvOf, RUN_REPO_KV } = await import("../merge/run-config");
  const repoEnv = repoEnvOf(process.env);
  if (Object.keys(repoEnv).length) await (await import("./state")).kvWrite(runId, { k: RUN_REPO_KV, value: repoEnv, writer: "operator" }).catch(() => {});
  if (pluginConfig) await RC.writeRunPluginConfig(runId, pluginConfig);
  // The run's place and that provider's settings as they are now (ADR-021 §2): a run keeps the idle machine lifetime
  // it started with. The place: the one asked for, else the project's (its .capcomd/config.json), else the user's
  // config, read from the files now, not from the engine's environment (src/config/sandbox.ts); none of those: the
  // engine's own. A retry keeps what the first call recorded.
  let sandbox: { name: string | null; source: import("../config/sandbox").SandboxSource };
  let branchSetup: { branch: string; from: string; created: boolean; reused?: boolean; ms: number } | null = null;
  {
    const RS = await import("../providers/run-sandbox");
    const prior = await c.scope.getOrCreate([runId]).kvGet({ k: RS.RUN_SANDBOX_KV }).catch(() => null) as { value?: unknown; deleted?: boolean } | null;
    const had = prior && !prior.deleted ? RS.parseRunSandbox(prior.value) : null;
    const choice = o.sandbox ? { name: o.sandbox, source: "run" as const } : (await import("../config/sandbox")).configuredSandbox(process.cwd());
    if (!had && "invalid" in choice && choice.invalid) throw new RelayError("config", `CAPCOMD_SANDBOX=${choice.invalid} (${choice.path ?? "environment"}) isn't a sandbox capcomd knows`, `Set it to one of: ${(await import("../providers/registry")).LISTED_PROVIDERS.join(", ")}.`, { code: "sandbox" });
    const name = o.sandbox ?? (had ? had.name : choice.name);
    sandbox = { name, source: had && !o.sandbox && had.name !== choice.name ? "run" : choice.source };
    let place: string = name ?? "fake";
    if (!name) { try { place = (await import("../providers/registry")).sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX: the default lifetime */ } }
    const settings = had?.settings.idleLifetime !== undefined ? { idleLifetime: had.settings.idleLifetime } : (await import("../providers/settings")).settingsForRun(place);
    const value = RS.runSandboxValue(name, settings);
    // Unchanged on a retry: not written again. A run on the engine's own place still starts if this write fails
    // (its machines then get the place's setting when they start); a run with a place of its own doesn't.
    if (!prior || prior.deleted || JSON.stringify(prior.value) !== JSON.stringify(value)) {
      const put = (await import("./state")).kvWrite(runId, { k: RS.RUN_SANDBOX_KV, value, writer: "operator" });
      await (name ? put : put.catch(() => {}));
    }
  }
  // The project's context settings (its .capcomd/config.json `context`: the brains it maps, each pinned to a commit), read
  // now from the files and kept with the run, so every agent of the run is briefed from the commits the run started with
  // (ADR-025 §11.2). A retry keeps what the first call recorded; a run starts without them if the write fails.
  await (await import("../context/project")).recordRunContext(runId, process.cwd()).catch(() => {});
  // Written on every (idempotent) call, so a crash between init and this put heals on retry.
  if (hasChecks) await (await import("./state")).kvWrite(runId, { k: CHECKS_KV, value: o.checks, writer: "operator" });
  if (o.reviewer) await (await import("./state")).kvWrite(runId, { k: REVIEWER_KV, value: { profile: o.reviewer }, writer: "operator" });
  if (o.target) {
    if (o.targetFrom) {
      const own = o.goalBranch ? !!(await runGoal(runId)) : false;
      const b = await ensureBranch(runId, o.target, o.targetFrom, o.goalBranch ? { goal: true, own, reusable: () => goalBranchOwner(runId, o.goalBranch!) } : {});
      branchSetup = { branch: o.target, from: o.targetFrom, created: b.created, ...(b.reused ? { reused: true } : {}), ms: b.ms };
    }
    // The goal first: a merge that reads the target and finds no goal would go the repo's way (a PR, an approval).
    if (o.goalBranch) await (await import("./state")).kvWrite(runId, { k: GOAL_KV, value: { branch: o.goalBranch, base: o.base }, writer: "operator" });
    await (await import("./state")).kvWrite(runId, { k: TARGET_KV, value: { branch: o.target }, writer: "operator" });
  }
  if (res.created) await (await import("./state")).kvWrite(runId, { k: TRACE_KV, value: { dir: (await import("../utils/tracing-simple")).traceDir() }, writer: "operator" }).catch(() => {});
  if (res.created) recordRun({ runId, label: o.label ?? null, repo: repoEnv.CAPCOMD_REPO ?? null, cwd: process.cwd(), createdAt: Date.now(), ...(o.goalBranch ? { goalBranch: o.goalBranch } : {}) });
  // The run actor gives the scope a USD ledger, `capcomd status` and the run event log.
  await c.run.getOrCreate([runId]).createRun({ runId, goal: o.label ?? "(primitives scope)", maxCost: o.budget.usd ?? 0 });
  return { runId, created: res.created, budget: res.budget, sandbox, ...(branchSetup ? { branchSetup } : {}), ...(o.goalBranch ? { goalBranch: o.goalBranch, base: o.base } : {}) };
}

/** run.creating (plugin API §6.6.3): plugins may lower the budget, relabel the run or pick its sandbox, or refuse it.
 *  The checks, the reviewer, the target and the goal branch are the operator's and read-only. */
async function runCreating(runId: string, o: RunNewOpts): Promise<RunNewOpts> {
  const { isListedProvider } = await import("../providers/registry");
  const options = { runId, label: o.label ?? null, goal: o.goal ? untrusted(o.goal, "operator") : null, budget: o.budget, checks: o.checks ?? {}, reviewer: o.reviewer ?? null,
    target: o.target ?? null, goalBranch: o.goalBranch && o.base ? { branch: o.goalBranch, base: o.base } : null, sandbox: o.sandbox ?? null, profile: null, driver: null, repo: env("REPO") ?? null };
  const out = await hooks.fire("run.creating", "modify", { options }, { principal: principalOf(null), entity: runId, runId,
    apply: (p, patch) => applyRunPatch(p, patch, isListedProvider) });
  if (out.decision === "deny") throw refusedError("run.creating", out);
  const n = out.payload.options;
  return { ...o, budget: n.budget, ...(n.label !== null ? { label: n.label } : {}), ...(n.sandbox !== null ? { sandbox: n.sandbox } : {}) };
}

/**
 * Runs this machine created, newest last (one JSON line each), so a later session can find them: `capcomd_runs`, and the
 * daemon's run list. CAPCOMD_RUNS_INDEX names another file (the live e2e scripts keep their runs out of the user's list).
 */
export const runsIndexPath = () => env("RUNS_INDEX") || join(stateDir(), "runs.jsonl");
function recordRun(r: { runId: string; label: string | null; repo: string | null; cwd: string; createdAt: number; goalBranch?: string }) {
  try { const p = runsIndexPath(); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(r) + "\n"); } catch { /* an index, not state */ }
}
export function recentRuns(limit = 20): Array<{ runId: string; label: string | null; repo: string | null; cwd: string; createdAt: number; goalBranch?: string }> {
  if (!existsSync(runsIndexPath())) return [];
  const rows = readFileSync(runsIndexPath(), "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const seen = new Set<string>();
  return rows.reverse().filter((r) => !seen.has(r.runId) && seen.add(r.runId)).slice(0, limit);
}

export interface SpawnOpts {
  runId: string; task: string; profile?: string; overrides?: Overrides; parent?: string; key?: string;
  contract?: Record<string, unknown>; budget?: Budget; operator?: boolean; start?: boolean;
  /** Pin one of the run's operator-named checks to this child (contract.check); its verify then uses it. */
  check?: string;
  /** verify's reviewer (host-side only; RPC spawns never set it): exempt from fan-out limits, see reviewSpawn. */
  review?: boolean;
  /** Report mode: read-only work; the agent's final message is its result and nothing is pushed (contract.report). */
  report?: boolean;
  /** ADR-017: children limits the parent grants this child (narrow-only; contract.children also accepted). */
  grant?: Grant;
  /** Start from this finished agent's work (contract.from): its branch, else its last checkpoint. */
  continueFrom?: string;
  /** Its title (capability agents.title), from its parent (`spawn --title` in a VM) or the driver (host CLI, MCP). */
  title?: string;
}
/**
 * What spawning `ref` (a profile, or an encoded ref with overrides) checks before anything is recorded: the profile
 * resolves, its CLI has an env snapshot on `source`'s sandbox, and the sandbox can enforce its egress. `capcomd run`
 * asks the same of its planner before it starts the run, so a run that can't start is refused, not left started.
 */
export function spawnChecks(ref: string | null, source: Record<string, string | undefined> = process.env) {
  return checkResolved(resolveProfile(ref), source);
}
function resolveProfile(ref: string | null): ResolvedAgent {
  try { return resolveAgent(ref); } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", e.message, "Check the profile with `capcomd profiles show <name>`; overrides may only narrow unless --operator.");
    throw e;
  }
}
function checkResolved(resolved: ResolvedAgent, runSource: Record<string, string | undefined>) {
  const spec = resolved.spec ? (resolved.spec as unknown as Record<string, unknown>) : null;
  // A project's profile skills reach an agent only once the operator has trusted each (ADR-024 decision 4).
  const untrustedSkills = resolved.name ? untrustedSkillsProblem(resolved.name, resolved.skills ?? []) : null;
  if (untrustedSkills) throw new RelayError("config", untrustedSkills, untrustedSkillsHint(resolved.name!), { code: "untrusted" });
  // Its machine's sandbox: its profile's (ADR-024 `sandbox.provider`), else the run's, else this process's.
  const rt = resolved.runtime ?? {};
  // What its profile was checked for, again on the spec as overridden: an override or a profile.resolved patch that
  // makes it orchestrate (narrowing) leaves an agent that runs nothing with MCP servers to run (src/profiles/runtime.ts).
  const rp = resolved.spec ? runtimeProblems(resolved.name ?? resolved.kind, rt, resolved.spec) : [];
  if (rp.length) throw new RelayError("config", rp.join("; "), "Spawn it without making it orchestrate (tools.mode), or give the MCP servers to the profiles it spawns.", { code: "orchestrate_mcp" });
  const source = rt.sandboxProvider ? withSandbox(runSource, rt.sandboxProvider) : runSource;
  const outside = isolationProblem(resolved.name, rt.sandboxProvider, runSource);
  if (outside) throw new RelayError("config", outside, "Name an isolated sandbox (docker, boxd) in the profile's sandbox.provider, or remove it so its agents run on the run's.", { code: "sandbox_isolation" });
  const envProblem = envSnapshotProblem(spec?.provider, source, rt.environment);
  if (envProblem) throw new RelayError("config", envProblem, "Run `capcomd env build` (idempotent; skips the VM when the snapshot is current), then retry the spawn.");
  if (rt.environment) environmentCheck(resolved, source);
  const unkept = egressProblem(resolved.name, spec?.egress as string[] | undefined, source);
  if (unkept) throw new RelayError("config", unkept, "Remove the profile's egress (agents get open egress by default), or use a provider that enforces it (boxd).");
  return { resolved, spec };
}

/** A profile never takes its agents out of isolation (profiles are data, ADR-024 §2.5: its MCP servers and the agent's
 *  commands run in a sandbox, never on the host): its `sandbox.provider` may run them on this host (the test fakes) only
 *  when the run's own sandbox (`runSource`'s) does too. Why not, or null. Also asked by GET /v1/run-options `planners`. */
export function isolationProblem(name: string | null | undefined, sandboxProvider: string | undefined, runSource: Record<string, string | undefined>): string | null {
  if (!sandboxProvider || realSandbox(withSandbox(runSource, sandboxProvider)) || !realSandbox(runSource)) return null;
  return `profile ${name}: sandbox.provider ${sandboxProvider} runs its agents on this host, outside any sandbox, and this run's agents are isolated (${sandboxName(runSource)})`;
}

/** A profile that limits egress must get that limit, not an open network (ADR-020: Docker has no allowlist): why its
 *  agents can't on `source`'s sandbox (their own), or null. Also asked by GET /v1/run-options `planners`, whose reason
 *  is the daemon's own text: a profile file's egress is shown only when every entry is shaped like a host (the
 *  schema's pattern), else counted, so a project's file can't word it. */
export function egressProblem(name: string | null | undefined, egress: readonly string[] | undefined, source: Record<string, string | undefined>): string | null {
  if (!egress?.length || egress.includes(OPEN_EGRESS) || !realSandbox(source) || sandboxCaps(source).egressAllowlist) return null;
  const hosts = egress.every((h) => EGRESS_HOST.test(h)) ? egress.join(", ") : `${egress.length} host${egress.length === 1 ? "" : "s"}`;
  return `profile ${name} limits egress (${hosts}), and the ${sandboxName(source)} sandbox can't enforce an egress allowlist`;
}
/** An egress entry as the profile schema's pattern allows one (src/profiles/v1.ts `egress`), at most a DNS name long. */
const EGRESS_HOST = /^[A-Za-z0-9.*-]{1,253}$/;

/** ADR-024 `sandbox.environment`: the sandbox has it, and a plan login kept in an image is one made from it (the agent
 *  boots from one image: src/env/resolve.ts `bootSnapshot`, which the worker asks again when it makes the machine). */
function environmentCheck(resolved: ResolvedAgent, source: Record<string, string | undefined>) {
  const mode = env("SPAWN_EXEC");
  const real = isRealAgent(resolved.kind) && mode !== "fake" && mode !== "script";
  let login: { agent: string; snapshot?: string; env: string } | null = null;
  if (real && resolved.spec?.auth === "subscription") {
    const p = profileFor(resolved.kind, source);
    if (p) login = { agent: resolved.kind, ...(p.snapshot ? { snapshot: p.snapshot } : {}), env: p.env };
  }
  try { bootSnapshot({ environment: resolved.runtime!.environment!, real, login }, source); } catch (e) {
    if (e instanceof EnvironmentProblem) throw new RelayError("config", `profile ${resolved.name}: ${e.message}`, "Build it (`capcomd env build`), or change the profile's sandbox.environment (`capcomd profiles show` says where it is set).", { code: "environment" });
    throw e;
  }
}

/** The id `spawnAgent` gives a top-level agent spawned with `key` (stable: the same run and key, the same id). The
 *  scope actor's plannerOf computes the same for the key "planner". */
export const rootAgentIdFor = (runId: string, key: string) => stableId("agt", `${runId}\0operator`, key);
/** kv: the run's planner agent ({agentId}), written by `capcomd run` before it spawns the planner. Reserved. */
export const PLANNER_KV = "_planner";

export async function spawnAgent(o: SpawnOpts) {
  await assertEngine();
  // A title that would be refused refuses the spawn, before anything is recorded.
  let title: string | undefined;
  if (o.title !== undefined) {
    const n = normalizeTitle(o.title);
    if (!n.ok) throw new RelayError("usage", `--title: ${n.error}`, TITLE_HINT);
    title = n.title;
  }
  if (o.report) o = { ...o, contract: { ...(o.contract ?? {}), report: true } };
  if (o.contract?.from !== undefined) throw new RelayError("usage", "contract.from is set by --continue", "Continue an agent's work with --continue <agentId>.");
  if (o.continueFrom) o = { ...o, contract: { ...(o.contract ?? {}), from: await continuation(o.runId, o.continueFrom, o.parent) } };
  if (o.contract?.report !== undefined && o.contract.report !== true) throw new RelayError("usage", "contract.report must be true", "Spawn a read-only reporting agent with --report.");
  const pin = o.check ?? o.contract?.check;
  if (pin !== undefined) {
    if (typeof pin !== "string") throw new RelayError("usage", "contract.check must be a check name", "Pin a check with --check NAME (one of the run's --checks-set names).");
    await namedCheck(o.runId, pin); // unknown names are refused here, not at verify time
    o = { ...o, contract: { ...(o.contract ?? {}), check: pin } };
  }
  const ref = o.profile ? encodeAgentRef(o.profile, o.overrides) : null;
  const scope = o.parent ?? "operator";
  const agentId = stableId("agt", `${o.runId}\0${scope}`, o.key);
  // The run's own sandbox, if it was started on one (`capcomd run --sandbox`), else this process's.
  const runEnv = await (await import("../providers/run-sandbox")).runSandboxEnv(o.runId);
  const { resolved, spec } = hooks.listening("profile.resolved") ? checkResolved(await profileResolved(o, ref, resolveProfile(ref)), runEnv) : spawnChecks(ref, runEnv);
  reportAllowed(resolved, o.contract);
  // ADR-024 `lifecycle.onStart|onEnd`: the plugins its profile names must be there to hear it.
  const unheard = await lifecycleProblem(lifecyclePlugins(resolved.runtime?.lifecycle));
  if (unheard) throw new RelayError("config", `profile ${resolved.name} can't be spawned: its ${unheard}`, LIFECYCLE_HINT, { code: "lifecycle_inactive" });
  // Requested budget: the contract's `budget` ({usd, turns, wallSeconds}), then --budget per unit.
  let requested: Budget;
  try { requested = { ...parseBudget(o.contract?.budget), ...(o.budget ?? {}) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Budget units: usd, turns, wallSeconds (e.g. --budget usd=2,turns=40)."); }
  let grant: Grant;
  try { grant = { ...parseGrant(o.contract?.children), ...parseGrant(o.grant) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Grant fan-out with --children.maxChildren=N, --children.maxDepth=N, --children.maxTotalDescendants=N, --children.allowedChildProfiles=a,b, --children.budgetShare=0.5 (each may only narrow the ceiling)."); }
  if (hooks.listening("agent.spawning")) {
    const s = await agentSpawning(o, agentId, resolved, spec, requested, grant);
    requested = s.budget ?? {};
    grant = s.grant ?? {};
    if (s.contract) {
      o = { ...o, contract: s.contract as Record<string, unknown> };
      // What a plugin added to the contract is checked as the spawner's own was (applySpawnPatch checks its shape).
      reportAllowed(resolved, o.contract);
      if (pin === undefined && typeof o.contract?.check === "string") await namedCheck(o.runId, o.contract.check);
    }
  }
  const hasGrant = Object.keys(grant).length > 0;
  // Fan-out for a profile that can't spawn (a worker) would have no effect: refuse it by name, with what to do instead.
  const asksFanOut = grant.allowSpawn === true || (grant.maxChildren ?? 0) > 0 || (grant.maxDepth ?? 0) > 0 || (grant.maxTotalDescendants ?? 0) > 0 || !!grant.allowedChildProfiles?.length;
  if (asksFanOut && !(spec as any)?.children?.allowSpawn) throw new RelayError("config", `profile ${resolved.name} can't spawn, so children (fan-out) would have no effect on it`, "To delegate a part, spawn a profile that can lead (capcomd_profiles canLead, e.g. lead) with children {maxChildren: N, maxDepth: 1}. For an agent that works alone, leave children out.", { code: "cannot_spawn" });
  // Recorded with the agent (agent.spawned, harness.v1 Agent.model): the model it runs with, as the worker decides it
  // (loadAgentConfig: CAPCOMD_AGENT_MODEL, else the profile's). A fake agent runs no model. A consolidator whose profile
  // names none runs on the run's strongest (ADR-025 D6: the writer's quality is what transfers).
  const consolidator = resolved.name === (await import("../context/consolidate")).CONSOLIDATOR_PROFILE;
  const model = isRealAgent(resolved.kind) ? agentModel(resolved.spec) ?? (consolidator && spec?.provider ? (await (await import("../context/consolidator")).strongestModel(o.runId, String(spec.provider)).catch(() => null)) ?? undefined : undefined) : undefined;
  const effort = isRealAgent(resolved.kind) ? agentEffort(resolved.spec) : undefined;
  const ph = paramsHash({ parent: o.parent ?? null, ref, task: o.task, contract: o.contract ?? null, budget: requested, operator: !!o.operator, ...(hasGrant ? { grant } : {}), ...(o.review ? { review: true } : {}) });
  // Its profile's skills (ADR-024 §7 step 5), pinned by hash on its spec; their text is kept with the run, so whoever
  // prepares the agent (the daemon, a run's driver) gives it what was resolved here (agentPreparing).
  const skills = resolved.skills ?? [];
  const res = await client().scope.getOrCreate([o.runId]).spawn({
    runId: o.runId, agentId, key: o.key, paramsHash: ph, parent: o.parent ?? null,
    profile: resolved.name, ref: ref ?? resolved.name,
    // Its runtime blocks (ADR-024 §7 step 8: MCP servers, sandbox, environment, size, lifecycle) beside the flat spec.
    spec: { ...(spec ?? {}), kind: resolved.kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(skills.length ? { skills: skills.map(({ name, source, hash }) => ({ name, source, hash })) } : {}), ...(resolved.runtime ?? {}) },
    ...(skills.length ? { skillTexts: skills.map((s) => s.text) } : {}),
    // ADR-024 §2.4: the version of the profile it runs with and where it came from, beside the spec they pinned.
    profileVersion: resolved.profile?.version ?? null, profileSource: resolved.profile?.source ?? null,
    task: o.task, contract: o.contract ?? null, ...(Object.keys(requested).length ? { budget: requested } : {}), operator: o.operator,
    ...(hasGrant ? { grant } : {}), ...(o.review ? { review: true } : {}),
    // ADR-022: how this shell (or the parent's driver) drives agents travels with the agent, for the engine to use.
    // The agents file the driver would have resolved its children's profiles from (this shell's, or the project's).
    driveEnv: { ...captureDriveEnv(), CAPCOMD_AGENTS_FILE: resolve(agentsFilePath()) },
    ...(title ? { title: { title, ...(o.parent && !o.operator ? { by: "parent" as const, setBy: o.parent } : { by: "driver" as const, setBy: "driver" }) } } : {}),
  }).catch(asRelay);
  if (o.start !== false && !TERMINAL_AGENT.has(res.agent.status)) await startDriver(o.runId, agentId);
  return { ...view(res.agent), created: res.created };
}

/** ADR-024 §2.2 `permissions.report`: a profile may say it is never spawned to report (unset: it may be). Checked on
 *  the spawner's contract and again on the one agent.spawning leaves, as a plugin may add `report` to it. */
function reportAllowed(resolved: ResolvedAgent, contract: Record<string, unknown> | undefined) {
  if (contract?.report === true && resolved.permissions?.report === false)
    throw new RelayError("config", `profile ${resolved.name} can't be spawned with report (its permissions.report is false)`, "Spawn a profile that may report (capcomd_profiles canReport), or spawn this one without report.", { code: "report_not_allowed" });
}

/** Who asked for a spawn (§3.2): the parent agent from its VM, else the operator or driver on the host. */
const spawnPrincipal = (o: SpawnOpts) => (o.parent && !o.operator ? principalOf(o.parent, o.runId) : principalOf(null));

/** profile.resolved (plugin API §6.6.5): a plugin may narrow the resolved spec as a user override does; a widening is
 *  refused (`widening`). Fires on every resolution of a spawn, before the spawn checks run on the result. */
async function profileResolved(o: SpawnOpts, ref: string | null, resolved: ResolvedAgent): Promise<ResolvedAgent> {
  if (!resolved.spec || !resolved.name) return resolved;
  const name = resolved.name;
  const overrides = ref ? decodeAgentRef(ref).overrides?.set ?? null : null;
  const out = await hooks.fire("profile.resolved", "modify", { profile: resolved.profile ?? { name, version: 1, source: "user" }, spec: resolved.spec as unknown as import("../../packages/plugin/src/shapes").PinnedSpec, overrides },
    { principal: spawnPrincipal(o), entity: `${o.runId}/${o.parent ?? "operator"}/${o.key ?? name}`, runId: o.runId, agentId: o.parent ?? null,
      apply: (p, patch) => applyProfilePatch(p, patch, (spec, set) => applyOverrides(name, spec as unknown as AgentSpec, { set }) as unknown as Record<string, unknown>) });
  if (out.decision === "deny") throw refusedError("profile.resolved", out);
  return out.patches.length ? { ...resolved, spec: out.payload.spec as unknown as AgentSpec, overridden: true } : resolved;
}

/** agent.spawning (plugin API §6.6.6): after the spawn checks, before the scope records the agent. A plugin may lower
 *  the budget, narrow the grant, add contract keys, or refuse the spawn (`plugin:<name>`). */
async function agentSpawning(o: SpawnOpts, agentId: string, resolved: ResolvedAgent, spec: Record<string, unknown> | null, budget: Budget, grant: Grant) {
  const parent = o.parent ? await client().scope.getOrCreate([o.runId]).getAgent({ agentId: o.parent }).catch(() => null) : null;
  const spawn = { runId: o.runId, parent: o.parent ?? null, profile: resolved.name ?? resolved.kind, task: untrusted(o.task, o.parent ?? "operator"), contract: o.contract ?? null,
    budget: Object.keys(budget).length ? budget : null, grant: Object.keys(grant).length ? grant : null, review: !!o.review, operator: !!o.operator };
  const out = await hooks.fire("agent.spawning", "modify", { spawn, spec: (spec ?? {}) as unknown as import("../../packages/plugin/src/shapes").PinnedSpec, parent: parent ? agentOf(parent) : null },
    { principal: spawnPrincipal(o), entity: agentId, runId: o.runId, agentId, apply: (p, patch) => applySpawnPatch(p, patch) });
  if (out.decision === "deny") throw refusedError("agent.spawning", out);
  return out.payload.spawn;
}

/**
 * Where `spawn --continue <agt>` starts: the agent's branch (work it pushed, finished or stopped at a limit), else
 * its last checkpoint (it failed or was cancelled before pushing). A parent may continue only its own children.
 */
async function continuation(runId: string, id: string, parent?: string) {
  const src = await getAgentOrThrow(runId, id);
  if (parent !== undefined && src.parent !== parent) throw new RelayError("conflict", `agent ${id} is not your child`, "Continue only your own children's work.");
  if (!TERMINAL_AGENT.has(src.status)) throw new RelayError("conflict", `agent ${id} is ${src.status}`, src.status === "paused" ? "A paused agent continues by itself after its provider's reset (or `capcomd resume`)." : "Wait for it to finish, or cancel it first.");
  const r = (src.result ?? {}) as Record<string, unknown>;
  const ref = typeof r.branch === "string" && r.branch ? `refs/heads/${r.branch}` : src.checkpoint?.ref;
  if (!ref) throw new RelayError("conflict", `agent ${id} left no work to continue from (no branch, no checkpoint)`, "Spawn a new agent for the task instead.");
  return { agentId: id, ref, stopped: typeof r.limit === "string" ? r.limit : src.status };
}

/** TUI contract: every agent.run span ends with status, cost and turns, failed or not. */
function stampSpent(span: { attributes: Record<string, any> }, a: ScopeAgent) {
  const sp: any = a.spent ?? {};
  const r: any = a.result ?? {};
  Object.assign(span.attributes, { "agent.status": a.status, "agent.cost_usd": Number(sp.usd ?? 0), "agent.turns": Number(sp.turns ?? 0),
    ...(Number(r.notionalCostUsd) > 0 ? { "agent.notional_cost_usd": Number(r.notionalCostUsd) } : {}), ...(r.billing ? { "agent.billing": String(r.billing) } : {}) });
}

export class EnvSnapshotMissing extends Error { readonly code = "env_snapshot_missing"; }
/**
 * Real CLI agents on a provider with snapshots boot from the capcomd env snapshot (the CLIs baked in); without one
 * every agent would install its CLI first (minutes, and network the profile may not allow), so spawn asks for one.
 * A profile that names its environment (ADR-024 `sandbox.environment`, other than `default`) chose: `image` installs
 * the CLI, a build's name is checked where it is resolved (src/env/resolve.ts `bootSnapshot`).
 */
export function envSnapshotProblem(provider: unknown, source: Record<string, string | undefined> = process.env, environment?: string): string | null {
  if (provider !== "claude" && provider !== "codex") return null;
  if (environment && environment !== "default") return null;
  if (!realSandbox(source) || !sandboxCaps(source).snapshots) return null;
  if ((source.CAPCOMD_SPAWN_EXEC ?? "") === "fake" || (source.CAPCOMD_SPAWN_EXEC ?? "") === "script") return null;
  if ((source.CAPCOMD_ENV ?? "").toLowerCase() === "image") return null;
  if (resolveEnvSnapshot(source)) return null;
  const name = sandboxName(source);
  return `no capcomd env snapshot for the ${name} sandbox (the ${provider} CLI would be missing in its ${name === "docker" ? "containers" : "VMs"}); run \`capcomd env build --sandbox ${name}\` first`;
}

export function view(a: ScopeAgent) {
  return {
    agentId: a.agentId, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile,
    ...(a.profileVersion !== null ? { profileVersion: a.profileVersion, profileSource: a.profileSource } : {}), status: a.status, ...shownTitle(a.titleState, redactShapes(a.task)),
    budget: a.budget, spent: a.spent, task: a.task, key: a.key, limits: a.limits, result: a.result,
    ...(a.heartbeatAt ? { heartbeatAt: a.heartbeatAt } : {}), ...noticeView(a),
    ...(a.status === "paused" && a.pausedUntil ? { pausedUntil: new Date(a.pausedUntil).toISOString() } : {}), ...(a.epoch > 1 ? { epoch: a.epoch } : {}),
    ...(a.checkpoint ? { checkpoint: a.checkpoint } : {}),
  };
}

/** ADR-019 §2: `notice` (dead, idle, spinning, failing) and its text as `stuck`, while the agent looks stuck. */
function noticeView(a: ScopeAgent) {
  const n = noticeOf(a);
  return n ? { stuck: n.detail, notice: n } : {};
}

/** A paused agent whose reset time has passed runs again (its next epoch). True when it was woken. */
async function wakeIfDue(runId: string, a: ScopeAgent): Promise<boolean> {
  if (a.status !== "paused" || !a.pausedUntil || a.pausedUntil > Date.now()) return false;
  // ADR-022: its own workflow wakes it at the reset; a look past the reset only wakes that workflow (in case the
  // engine hasn't yet), it doesn't resume the agent itself.
  if (await engineDrivesAgents(runId)) { await startDriver(runId, a.agentId); return false; }
  const r = await client().scope.getOrCreate([runId]).resume({ agentId: a.agentId, by: "reset" });
  if (r.changed) await startDriver(runId, a.agentId);
  return r.changed;
}

/** One non-blocking look at agents (ADR-017 in-VM await polls this): kicks stale drivers. */
const kickedAt = new Map<string, number>();
export async function peekAgents(runId: string, ids: string[]) {
  const out: ScopeAgent[] = [];
  for (const id of ids) {
    const a = await getAgentOrThrow(runId, id);
    if (a.status === "paused") { if (await wakeIfDue(runId, a)) kickedAt.set(id, Date.now()); out.push(a); continue; }
    if (!TERMINAL_AGENT.has(a.status) && (!a.driver || a.driverUntil < Date.now()) && (kickedAt.get(id) ?? 0) < Date.now() - leaseMs()) { await startDriver(runId, id); kickedAt.set(id, Date.now()); }
    out.push(a);
  }
  return out;
}

export async function treeOf(runId: string, root?: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const all: ScopeAgent[] = await s.listAgents({});
  if (root && !all.some((a) => a.agentId === root)) throw new RelayError("not_found", `agent ${root} not found in ${runId}`, "Check ids with `capcomd tree <runId>`.");
  // TUI contract: per-node startedAt/endedAt (ISO, null until known), taskId (worker task label), spanId (agent.run).
  const times = new Map<string, { s?: number; e?: number }>();
  for (const ev of await s.getEvents({}).catch(() => [] as any[])) {
    if (!ev.agentId) continue;
    const t = times.get(ev.agentId) ?? {};
    if (ev.type === "AGENT_STARTED" && t.s === undefined) t.s = ev.at;
    if (["AGENT_DONE", "AGENT_FAILED", "AGENT_CANCELLED", "AGENT_REAPED"].includes(ev.type)) t.e = ev.at;
    times.set(ev.agentId, t);
  }
  const byId = new Map(all.map((a) => [a.agentId, a]));
  const iso = (n?: number) => (n ? new Date(n).toISOString() : null);
  const decorate = (n: any): any => {
    const a = byId.get(n.agentId)!; const t = times.get(n.agentId) ?? {};
    return { ...n, parent: a.parent ?? null, createdAt: iso(a.createdAt), startedAt: iso(t.s), endedAt: TERMINAL_AGENT.has(a.status) ? iso(t.e ?? a.updatedAt) : null,
      taskId: taskLabelOf(a, a.agentId), spanId: agentSpanId(runId, a.agentId), children: n.children.map(decorate) };
  };
  return { runId, root: root ?? null, tree: treeView(all, root).map(decorate), totals: rollupTotals(all, root) };
}
function rollupTotals(all: ScopeAgent[], root?: string) {
  const ids = root ? subtree(all, root) : new Set(all.map((a) => a.agentId));
  const ru = rollups(all);
  const tops = all.filter((a) => ids.has(a.agentId) && (!a.parent || !ids.has(a.parent)));
  const t = { agents: 0, usd: 0, notionalUsd: 0, turns: 0, wallSeconds: 0, byStatus: {} as Record<string, number> };
  for (const a of tops) { const r = ru.get(a.agentId)!; t.agents += r.agents; t.usd = Math.round((t.usd + r.usd) * 1e6) / 1e6; t.notionalUsd = Math.round((t.notionalUsd + r.notionalUsd) * 1e6) / 1e6; t.turns += r.turns; t.wallSeconds = Math.round((t.wallSeconds + r.wallSeconds) * 10) / 10; for (const [k, n] of Object.entries(r.byStatus)) t.byStatus[k] = (t.byStatus[k] ?? 0) + n; }
  return t;
}

/** Everything about one agent: record, children, awaits, ops it was verified/merged by, log tail, events. */
export async function inspectAgent(runId: string, agentId: string, o: { logTail?: number } = {}) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const a = await getAgentOrThrow(runId, agentId);
  const all: ScopeAgent[] = await s.listAgents({});
  const awaits = (await s.listAwaits({})).filter((w: any) => w.waiter === agentId || w.target === agentId);
  const events = (await s.getEvents({})).filter((e: any) => e.agentId === agentId || e.data?.parent === agentId).slice(-50);
  const logs = await s.getLogs({ agentId, tail: o.logTail ?? 50 });
  const w = workerOf(runId, agentId, a.epoch);
  const wk: any = await w.getWorker({ workerId: agentId }).catch(() => null);
  return {
    ...view(a), contract: a.contract, spec: a.spec, driver: a.driver, driverUntil: a.driverUntil, heartbeatNote: a.heartbeatNote,
    children: all.filter((x) => x.parent === agentId).map((x) => ({ agentId: x.agentId, status: x.status, profile: x.profile })),
    rollup: rollups(all).get(agentId), awaits, vm: wk ? { state: wk.state, vmId: wk.vmId ?? wk.context?.vmId ?? null } : null,
    events, logs,
  };
}

export async function agentLogs(runId: string, agentId: string, tail = 200, after?: number) {
  await assertEngine();
  const a = await getAgentOrThrow(runId, agentId);
  return { runId, agentId, status: a.status, lines: await client().scope.getOrCreate([runId]).getLogs({ agentId, tail, ...(after !== undefined ? { after } : {}) }) };
}

/** Budget of an agent (or the run): allocation, own spend, what children hold, what's left to carve, subtree rollup. */
export async function budgetShow(runId: string, agentId?: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const all: ScopeAgent[] = await s.listAgents({});
  if (!agentId) { const sc = await s.getScope({}); return { runId, agentId: null, budget: sc?.budget ?? {}, spent: sc?.spent ?? {}, available: sc?.unallocated ?? {}, totals: rollupTotals(all) }; }
  const a = await getAgentOrThrow(runId, agentId);
  const tree = treeSpend(all);
  const kids = all.filter((x) => x.parent === agentId).map((x) => ({ ...x, tree: tree.get(x.agentId) }));
  return { runId, agentId, budget: a.budget, spent: a.spent, available: available(a.budget, a.spent, kids), limits: a.limits, children: kids.length, rollup: rollups(all).get(agentId) };
}

/**
 * ADR-019 §4: give a live agent more budget, carved from what its parent (or the run) has left; it applies while the
 * agent runs (the engine enforces budgets from live spend) and resets its stuck window. Without an agent, raise the
 * run's budget (operator only). Additive: pass the same `key` when retrying so it counts once.
 */
export async function grantBudget(runId: string, o: { agentId?: string; add: Budget; by: string; key?: string }) {
  await assertEngine();
  if (!Object.keys(o.add).length) throw new RelayError("usage", "grant needs a budget to add", "Pass the units to add, e.g. --budget usd=2,turns=20.");
  if (o.agentId) await getAgentOrThrow(runId, o.agentId);
  const r = await client().scope.getOrCreate([runId]).grant({ ...o, paramsHash: paramsHash({ agentId: o.agentId ?? null, add: o.add, by: o.by }) }).catch(asRelay);
  return { runId, ...r };
}

/**
 * Attempts that failed only because the sandbox provider didn't answer (an outage) are run again without counting, at
 * most this many times per drive: each one's machine calls wait for the provider (up to CAPCOMD_SANDBOX_OUTAGE_MS) and
 * fail with sandbox_unreachable (final) when it stays down, so this only bounds a provider that keeps flapping.
 */
export const MAX_OUTAGE_RETRIES = 10;

/** What a failed agent's result says about an outage that ended it (the error kind, and that running it again may work). */
export function outageResult(e: unknown): Record<string, unknown> {
  return isSandboxUnreachable(e) ? { errorKind: "sandbox_unreachable", retryable: true } : {};
}

/** The engine an attempt ran against: unset until its claim answered; null from an engine that doesn't say. */
type EngineSeen = { instance?: string | null };

/**
 * After a failed attempt: did the engine go away under it? Waits (until `until`) for the scope to answer a claim again.
 * "restarted" when it didn't answer at first, the attempt never reached it, or another engine process answers now (the
 * daemon restarted: the actor call in flight died with it, and calls during the new engine's start-up fail with
 * "An internal error occurred"); "same" when the engine that ran the attempt answers (a real failure); "down" when it
 * never answered again.
 */
async function engineOutage(s: any, agentId: string, driver: string, seen: EngineSeen, until: number): Promise<"restarted" | "same" | "down"> {
  let missed = false;
  for (;;) {
    try {
      // Bounded: a call to an engine that is still starting can hang.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const c: any = await Promise.race([
        s.claimDriver({ agentId, driver, ttlMs: leaseMs() }),
        new Promise((_, no) => { timer = setTimeout(() => no(new Error("engine probe timed out")), 15_000); }),
      ]).finally(() => clearTimeout(timer));
      const now = c?.instance ?? null;
      return missed || seen.instance === undefined || now !== seen.instance ? "restarted" : "same";
    } catch (e) {
      // The scope's own refusal (a UserError) is an answer; anything else (connection refused or reset, an internal
      // error while the engine starts, an action's failure crossing as a UserError marked internal) is the engine not
      // answering.
      if ((e as any)?.group === "user" && !isInternalActorError(e)) return missed ? "restarted" : "same";
      missed = true;
      if (Date.now() > until) return "down";
      await sleep(1000);
    }
  }
}

/**
 * Advance one agent to a terminal state. Every step is idempotent (worker actor), so a new
 * driver resumes where a crashed one stopped. Returns the agent's final record.
 */
export async function driveAgent(runId: string, agentId: string): Promise<ScopeAgent> {
  try { const d = join(stateDir(), "drivers"); mkdirSync(d, { recursive: true }); writeFileSync(join(d, `${agentId}.pid`), String(process.pid)); } catch {}
  // Retry the (idempotent) steps; only an error that persists while the engine answers marks the
  // agent failed. An attempt the daemon went away under (stopped, restarted) isn't counted: the driver
  // waits for the engine to answer again and runs the attempt again (the agent's VM keeps running).
  // If the engine stays down, the driver gives up without finishing the agent: its lease expires and
  // the next await/wait-any resumes it.
  const s = client().scope.getOrCreate([runId]);
  const me = await s.getAgent({ agentId });
  // Trace parenting: agent spans nest under their parent agent's span (root agents under the run).
  return withSpan("agent.run", { "relay.run_id": runId, "agent.id": agentId, "agent.parent": me?.parent ?? null, "relay.agent_id": agentId, "relay.parent_agent_id": me?.parent ?? null, "agent.profile": me?.profile ?? null, "agent.depth": me?.depth ?? 0 }, async (span) => {
    let last: unknown;
    // One driver id for every attempt in this process, so a retry re-claims its own lease (a fresh id
    // used to find the lease still held, return "running" and exit: an endless silent loop).
    const driver = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const maxSame = Number(env("DRIVE_MAX_FAILURES") ?? 3);
    // How long one outage is waited out, and how many attempts it may cost without counting (a daemon that keeps
    // dying under the same attempt is a fault after all).
    const outageMs = Number(env("DRIVE_OUTAGE_MS") ?? 5 * 60_000);
    let restarts = 0, outages = 0, tries = 0;
    const seen: EngineSeen = {};
    for (let attempt = 1; attempt <= 3; attempt++) {
      delete seen.instance;
      try { const a = await driveOnce(runId, agentId, driver, seen); if (!TERMINAL_AGENT.has(a.status)) discardSpan(span); else stampSpent(span, a); return a; } catch (e) {
        last = e;
        const kind = String((e as any)?.code ?? (e as any)?.kind ?? (e as Error)?.name ?? "error");
        console.error(`[drive] ${new Date().toISOString()} attempt ${attempt} failed (${kind}): ${redactShapes(String((e as Error)?.message ?? e)).slice(0, 500)}`);
        // The daemon stopped or restarted under this attempt: not the agent failing. Run it again once the engine answers.
        const outage = await engineOutage(s, agentId, driver, seen, Date.now() + outageMs);
        if (outage === "down") { console.error(`[drive] the engine did not answer again; leaving ${agentId} to the next driver`); throw e; }
        if (outage === "restarted" && ++restarts <= 20) { console.error(`[drive] the engine went away under attempt ${attempt}; running it again`); attempt--; continue; }
        // Every failed attempt is visible (DRIVE_FAILED, redacted) and counted across driver processes;
        // N identical failures in a row fail the agent instead of looping.
        const df = await s.driveFailed({ agentId, kind, message: String((e as Error)?.message ?? e), attempt: ++tries, driver }).catch(() => null);
        // The sandbox provider didn't answer (an outage): not the agent failing. Run the attempt again without counting
        // it; its machine calls wait for the provider (and fail with sandbox_unreachable, final, when it stays down).
        if (!isSandboxUnreachable(e) && isTransientSandboxError(e) && ++outages <= MAX_OUTAGE_RETRIES) {
          console.error(`[drive] the sandbox provider didn't answer under attempt ${attempt}; running it again`);
          attempt--; await sleep(2000 * Math.min(outages, 5)); continue;
        }
        if (df && df.consecutive >= maxSame) break;
        // A rejected credential never heals by retrying; a scripted agent's exit code is its answer.
        // A limit (timeout, turns, budget) is a decision, not a fault: running the same task again hits it again.
        // So does a configuration problem (an unknown or invalid profile, no credentials): its message says what to fix.
        // And a provider that didn't answer for the whole outage window: the agent waited that long already.
        if (sandboxAuthError(e) || e instanceof ScriptFailed || e instanceof EnvSnapshotMissing || kind === "limit" || kind === "config" || isSandboxUnreachable(e)) break;
        await sleep(2000 * attempt);
      }
    }
    const res = await resultOf(runId, agentId);
    const fin = await s.finish({ agentId, status: "failed", result: { ...res, error: (last as Error)?.message?.slice(0, 500) ?? String(last), ...(last instanceof ScriptFailed ? { exitCode: last.exitCode } : {}), ...outageResult(last) } });
    // A failed agent's jobs settle and its machine goes too (its worker retries a destroy the provider didn't answer).
    await endJobs(runId, agentId, "its agent failed");
    await workerOf(runId, agentId, fin.agent.epoch).drainWorker({ workerId: agentId }).catch(() => {});
    stampSpent(span, fin.agent);
    return fin.agent;
  }, { spanId: agentSpanId(runId, agentId), parentSpanId: me?.parent ? agentSpanId(runId, me.parent) : rootSpanIdForRun(runId) });
}

/** A reviewer's review target (set by verify in the contract; RPC spawns can't set it). */
function reviewOf(a: ScopeAgent): { sha: string; branch: string; target: string; targetSha?: string } | null {
  const r: any = (a.contract as any)?.review;
  return r && typeof r.sha === "string" && typeof r.branch === "string" && typeof r.target === "string" ? { sha: r.sha, branch: r.branch, target: r.target, ...(typeof r.targetSha === "string" && /^[0-9a-f]{40,64}$/.test(r.targetSha) ? { targetSha: r.targetSha } : {}) } : null;
}

/** The structured result an agent declared with `capcomd result` (kv _result/<agt>), if any. */
async function resultOf(runId: string, agentId: string): Promise<Record<string, unknown>> {
  const r = await client().scope.getOrCreate([runId]).kvGet({ k: `_result/${agentId}` }).catch(() => null);
  const v = r && !r.deleted ? (r.value as any) : null;
  return v ? { summary: v.summary, artifacts: v.artifacts, ...(v.data !== undefined ? { data: v.data } : {}), ...(v.truncated ? { truncated: v.truncated } : {}) } : {};
}

/** "paused by the operator", naming the API client when one asked (client:<id>). */
const pausedBy = (by: string) => `${stoppedAt("paused")}${by === "operator" ? "" : ` (${by})`}`;

/** How this agent runs: its profile ref for a real agent, else undefined (the fake or a scripted one). */
const execOf = (a: ScopeAgent) => { const mode = env("SPAWN_EXEC"); return mode === "fake" || mode === "script" ? undefined : (a.ref ?? undefined); };

/**
 * Before an agent gets a VM: the operator's pause asked while nothing ran it, a missing env snapshot (thrown: never
 * retried), and its login's usage limit (ADR-019 §6: wait for the reset, don't run). Returns the paused agent, or null
 * to go on.
 */
async function preflightDrive(runId: string, agentId: string, s: any, a: ScopeAgent): Promise<ScopeAgent | null> {
  // The operator asked to pause it while no driver ran it: pause it now, before a VM is made.
  if (a.pauseRequested) return (await s.pause({ agentId, until: 0, result: { limit: "paused", by: a.pauseRequested, error: `${pausedBy(a.pauseRequested)}; it runs on \`capcomd resume\`` } })).agent;
  // Test/eval knob: run the fake agent while profiles still govern policy (no real CLI/repo).
  // The CLI is launched with the profile's own caps only: the engine enforces the agent's budget from its live spend,
  // so a grant (ADR-019 §4) raises it while it runs.
  const exec = execOf(a);
  const rt = pinnedRuntime(a.spec);
  // Fail fast (no retries, no driverless "running"): a real agent on boxd needs the env snapshot (on its profile's
  // sandbox, else its run's).
  const envProblem = exec ? envSnapshotProblem((a.spec as any)?.provider, await (await import("../providers/run-sandbox")).agentSandboxEnv(runId, rt.sandboxProvider), rt.environment) : null;
  if (envProblem) throw new EnvSnapshotMissing(envProblem);
  // ADR-024 `lifecycle`: the plugins its profile names must hear it (they may have been disabled since its spawn).
  const unheard = await lifecycleProblem(lifecyclePlugins(rt.lifecycle));
  if (unheard) throw new RelayError("config", `${agentId} can't start: its profile's ${unheard}`, LIFECYCLE_HINT, { code: "lifecycle_inactive" });
  // ADR-019 §6: the login this agent spends from is out of quota (another agent hit it): wait for the reset, don't run.
  const login = exec ? loginOf(a.spec) : null;
  const waitUntil = login ? quotaUntil(login) : 0;
  if (waitUntil) return (await s.pause({ agentId, until: waitUntil, result: { limit: "quota", login, resetAt: waitUntil, error: `waiting for ${login}'s usage limit to reset (${new Date(waitUntil).toISOString()})` } })).agent;
  return null;
}

/** The agent's VM, provisioned (idempotent by its name) and assigned its task. True when it was cancelled meanwhile. */
async function ensureWorker(runId: string, a: ScopeAgent, w: any, prepared: PreparedSpec = null): Promise<boolean> {
  const agentId = a.agentId, epoch = a.epoch, exec = execOf(a);
  const s = client().scope.getOrCreate([runId]);
  let wk = await w.getWorker({ workerId: agentId });
  if (!wk || wk.state === "provisioning" || wk.state === "failed") {
    const spec = prepared ?? a.spec;
    const machine = pinnedMachine(a.spec);
    await w.provisionWorker({ workerId: agentId, runId, epoch, ...(exec ? { agent: exec, ...(spec ? { agentSpec: spec as Record<string, unknown> } : {}) } : {}), ...(Object.keys(machine).length ? { machine } : {}) });
    wk = await w.getWorker({ workerId: agentId });
  }
  if ((await s.getAgent({ agentId }))?.status === "cancelled") { await w.drainWorker({ workerId: agentId }); return true; }
  if (wk?.state === "idle") await w.assignTask({ workerId: agentId, taskId: taskLabelOf(a, agentId), epoch });
  return false;
}

/** What one run of an agent came to: its push (as the worker recorded it), or an end it reached itself. JSON only. */
export type AttemptOutcome = { kind: "pushed"; pushed: any; vmRpc: boolean } | { kind: "ended" };

/**
 * One run of the agent on its VM: a scripted agent's script, a handoff, then the push (the runner for a real agent).
 * `push` is the worker's pushBranch: an action call from a driver process, the worker's own code from its workflow.
 */
export async function runAttempt(runId: string, a: ScopeAgent, w: any, push: (params: Record<string, unknown>) => Promise<any> = (p) => w.pushBranch(p), prepared: PreparedSpec = null): Promise<AttemptOutcome> {
  const agentId = a.agentId, epoch = a.epoch, exec = execOf(a), mode = env("SPAWN_EXEC");
  const s = client().scope.getOrCreate([runId]);
  const cancelled = async () => (await s.getAgent({ agentId }))?.status === "cancelled";
  const branch = `capcomd/${runId}/${agentId}`;
  // The commit's Capcomd-Task trailer names the task: the contract's planTask when set (the
  // hierarchical recipe, so landings match the legacy `<run>/<task>` key), else the agent id.
  const taskLabel = taskLabelOf(a, agentId);
  // ADR-017: scripted fake agents run now (with in-VM capcomd on a local spool).
  let fakeFile: { path?: string; content?: string } = {};
  if (mode === "script") {
    const done = await s.getAgent({ agentId });
    const r0 = await resultOf(runId, agentId);
    if (!r0.summary || !done?.result) {
      killpoint("spawn.script.before");
      const { exitCode } = await runScripted(runId, a);
      if (await cancelled()) { await w.drainWorker({ workerId: agentId }); return { kind: "ended" }; }
      if (exitCode !== 0) throw new ScriptFailed(`scripted agent exited ${exitCode}`, exitCode);
    }
    const r = await resultOf(runId, agentId);
    const f = (r.data as any)?.file;
    if (f && typeof f.path === "string") fakeFile = { path: f.path, content: String(f.content ?? "") };
  }
  // Handoff: my result is my successor's. Await it before finishing (finishing would reap it).
  const ho = await s.kvGet({ k: `handoff/${agentId}` }).catch(() => null);
  if (ho && !ho.deleted && (ho.value as any)?.to) {
    const to = String((ho.value as any).to);
    const [succ] = (await awaitAgents(runId, [to])).agents as any[];
    await w.drainWorker({ workerId: agentId }).catch(() => {});
    const st = succ.status === "done" ? "done" : "failed";
    await s.finish({ agentId, status: st, spent: { usd: 0, turns: 0, wallSeconds: 0 }, result: { ...(succ.result ?? {}), handoffTo: to } });
    return { kind: "ended" };
  }
  const vmRpc = exec && hasVmCapcomd(a) ? await vmRpcFor(runId, a, w, agentId, prepared) : null;
  const review = reviewOf(a);
  const report = (a.contract as any)?.report === true;
  const from = (a.contract as any)?.from as { agentId: string; ref: string; stopped: string } | undefined;
  // ADR-025 §5.2: a consolidator answers with deltas, which the kernel stages on its branch when it ends (settlePushed);
  // a real one reads the run's candidates and outcomes in its prompt (a scripted one reads them with its capcomd).
  const { isConsolidator, consolidationInputs } = await import("../context/consolidator");
  // The brain its profile names, which its prompt says it may propose new drafts to (ADR-025 step 5).
  const brain = isConsolidator(a) ? (await import("../context/consolidate")).brainOf((a.spec as { context?: import("../../packages/plugin/src/context-layer").ContextSpec } | null)?.context) : null;
  const consolidate = isConsolidator(a) && !review && !report ? { inputs: exec && mode !== "script" ? await consolidationInputs(runId) : "", ...(brain ? { brain } : {}) } : null;
  // Children branch from the run's target (a staging branch) when the operator set one.
  const target = await runTarget(runId);
  // Its title (the driver's --title, its parent's, the user's or its own), for its commit's subject; not one derived from the brief.
  const named = shownTitle(a.titleState, a.task);
  const title = named.title && named.titleSource !== "derived" ? named.title : null;
  const machine = pinnedMachine(a.spec);
  const doPush = () => push({ workerId: agentId, parentAgentId: a.parent ?? null, taskId: taskLabel, epoch, ...(epoch > 1 ? { resumed: true } : {}), branch, runId, goal: a.task, ...(title ? { title } : {}), ...(Object.keys(machine).length ? { machine } : {}), ...(exec ? { agent: exec, ...(prepared ?? a.spec ? { agentSpec: (prepared ?? a.spec) as Record<string, unknown> } : {}) } : {}), ...fakeFileParams(fakeFile), ...(vmRpc ? { subagents: vmRpc.params } : {}), ...(review ? { review } : {}), ...(report ? { report: true } : {}), ...(consolidate ? { consolidate } : {}), ...(from ? { from } : {}), ...(target ? { target } : {}) });
  const pushed: any = vmRpc ? await vmRpc.run(doPush) : await doPush();
  // `vmRpc`: an agent that may spawn ran with its capcomd, so its work may be all its children's (no branch of its own).
  return { kind: "pushed", pushed, vmRpc: !!vmRpc && a.limits.allowSpawn };
}

/** After a push: charge it, release the VM, then finish the agent (or pause it at a usage limit or the operator's ask). */
async function settlePushed(runId: string, a: ScopeAgent, w: any, out: Extract<AttemptOutcome, { kind: "pushed" }>): Promise<ScopeAgent> {
  const c = client();
  const agentId = a.agentId, exec = execOf(a), mode = env("SPAWN_EXEC");
  const s = c.scope.getOrCreate([runId]);
  const cancelled = async () => (await s.getAgent({ agentId }))?.status === "cancelled";
  const login = exec ? loginOf(a.spec) : null;
  const branch = `capcomd/${runId}/${agentId}`;
  const review = reviewOf(a);
  const report = (a.contract as any)?.report === true;
  const pushed = out.pushed;
  const rec = pushed.recorded ?? pushed; // a replayed push reports what the first push recorded
  const costUsd = Number(rec.costUsd ?? 0);
  let spent: Budget = { usd: costUsd, turns: Number(rec.turns ?? 0), wallSeconds: Number(rec.wallSeconds ?? 0) };
  // Scripted fake agents simulate spend (result data.spent) so rollups and budget limits are testable.
  if (mode === "script") { const d: any = (await resultOf(runId, agentId)).data; if (d?.spent) spent = { ...spent, ...parseBudgetLoose(d.spent) }; }
  if (costUsd > 0 && !pushed.already) await c.run.getOrCreate([runId]).chargeBudget({ runId, chargeId: `${agentId}-agent`, amount: costUsd });
  await w.taskDone({ workerId: agentId });
  await w.drainWorker({ workerId: agentId });
  if (await cancelled()) return (await s.getAgent({ agentId }))!;
  // Plugin API §16.1: an orchestrate agent writes nothing. One whose checkout had changed files or new commits at the end
  // of a turn or of its run fails, naming them; nothing it wrote was committed or pushed (its children's work stands).
  const ow = rec.orchestrateWrites as import("../agents/runner").OrchestrateWrites | undefined;
  if (ow && (a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate") {
    const { orchestrateWritesText } = await import("../agents/runner");
    const declared = await resultOf(runId, agentId);
    const said = typeof rec.resultText === "string" && rec.resultText.trim() ? rec.resultText.trim().slice(0, 2000) : null;
    const error = `${agentId} is an orchestrate agent and it ${orchestrateWritesText(ow)} in its checkout${ow.at === "turn" ? " (stopped at the end of that turn)" : ""}. An orchestrate agent writes nothing, so it failed; its changes were discarded, never committed or pushed. Give that work to a worker it spawns.`;
    const fin = await s.finish({ agentId, status: "failed", spent, result: { ...declared, ...(!declared.summary && said ? { summary: said } : {}), error, errorKind: "orchestrate_wrote_files", wrote: { files: ow.files, total: ow.total, commits: ow.commits, at: ow.at }, verification: null, branch: null, commit: null, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds, billing: rec.billing ?? (costUsd ? "api" : "subscription-or-fake"), ...(Number(rec.notionalCostUsd) > 0 ? { notionalCostUsd: Number(rec.notionalCostUsd) } : {}) } });
    return fin.agent;
  }
  // ADR-019 §6: the provider's usage limit is a pause, not a failure. Its login waits for the reset too.
  if (rec.limit === "quota") {
    const until = Number(rec.resetAt) || Date.now() + quotaRetryMs();
    if (login) recordQuota(login, { until, at: Date.now(), runId, agentId });
    const p = await s.pause({ agentId, until, spent, result: { limit: "quota", login, resetAt: Number(rec.resetAt) || null, error: `${stoppedAt("quota")}; it resumes at ${new Date(until).toISOString()} (or on \`capcomd resume\`)${pushed.sha ? `, from its work on ${branch}` : ""}`, branch: pushed.sha ? branch : null, commit: pushed.sha || null, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds } });
    return p.agent;
  }
  // The operator's pause: stopped with its work kept, it waits for `resume` (no reset time).
  if (rec.limit === "paused") {
    const by = (await s.getAgent({ agentId }))?.pauseRequested ?? "operator";
    const p = await s.pause({ agentId, until: 0, spent, result: { limit: "paused", by, error: `${pausedBy(by)}; it runs on \`capcomd resume\`${pushed.sha ? `, from its work on ${branch}` : ""}`, branch: pushed.sha ? branch : null, commit: pushed.sha || null, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds } });
    return p.agent;
  }
  const declared = await resultOf(runId, agentId);
  const verdictOf = review ? { verdict: parseVerdict(declared.data, rec.resultText) } : {};
  // Report mode: the agent's final message is its result (a scripted one declares its summary itself).
  const reportText = report && typeof rec.resultText === "string" ? rec.resultText.slice(0, 8000) : null;
  // Stopped at a limit: the agent failed, but its work so far is on its branch for a continuation (not retried).
  const limit = typeof rec.limit === "string" ? rec.limit : null;
  const limitOf = limit ? { limit, error: `${stoppedAt(limit)}; its work so far is on ${branch}${pushed.sha ? ` (${String(pushed.sha).slice(0, 12)})` : ""}` } : {};
  const reportOf = report ? { ...(reportText ? { report: reportText } : {}), ...(!declared.summary && reportText ? { summary: reportText.slice(0, 2000) } : {}) } : {};
  // Plugin API §16.1: an orchestrate agent's work is the agents it spawns. One that spawned none (its tools refused,
  // or it gave up) did nothing that can land: it failed, with its own last words, never a silent "done".
  const orchestrate = (a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate";
  const lastWords = typeof rec.resultText === "string" && rec.resultText.trim() ? rec.resultText.trim().slice(0, 2000) : null;
  const blocked = orchestrate && !limit && !(await s.listAgents({})).some((x: ScopeAgent) => x.parent === agentId)
    ? { error: `${agentId} is an orchestrate agent and spawned no agents, so nothing it did can land${lastWords ? `. It said: ${lastWords.slice(0, 500)}` : ""}`, errorKind: "orchestrate_no_children" } : {};
  // An agent that declared no summary (`capcomd result --summary`) has its final message as one, so its parent reads
  // what it said it did (a reviewer's final message is its verdict, not a summary).
  const said = !review && !declared.summary && lastWords ? { summary: lastWords } : {};
  // ADR-025 §5.2: a consolidator's answer is staged on its branch by the kernel; that branch is its work.
  const consolidated = !limit && !review && !report ? await consolidatedOf(runId, a, declared, rec) : null;
  // A consolidator's work is only what was staged: no list, nothing to stage or a staging that failed is no branch.
  const work = consolidated ? { branch: consolidated.staged?.sha ? branch : null, commit: consolidated.staged?.sha ?? null } : { branch: review || report || (!pushed.sha && out.vmRpc) ? null : branch, commit: pushed.sha || null };
  const fin = await s.finish({ agentId, status: limit || "error" in blocked || consolidated?.error ? "failed" : "done", spent, result: { ...declared, ...said, ...blocked, ...verdictOf, ...reportOf, ...limitOf, ...consolidated?.result, verification: null, ...work, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds, billing: rec.billing ?? (costUsd ? "api" : "subscription-or-fake"), ...(Number(rec.notionalCostUsd) > 0 ? { notionalCostUsd: Number(rec.notionalCostUsd) } : {}), ...(pushed.adopted ? { adopted: true } : {}) } });
  return fin.agent;
}

/**
 * A consolidator's end (ADR-025 §5.2, §5.3): its `context` list (in its declared result's data, else its final message)
 * staged on its branch (src/context/consolidator.ts); what was applied and refused goes on its result (`context`),
 * with a summary in the kernel's words when it gave none. null for any other agent. One it can't stage ends failed.
 */
async function consolidatedOf(runId: string, a: ScopeAgent, declared: Record<string, any>, rec: any) {
  const { isConsolidator, stageOnBranch } = await import("../context/consolidator");
  if (!isConsolidator(a)) return null;
  const { deltasIn } = await import("../context/consolidate");
  const given = declared.data?.context;
  const raw = Array.isArray(given) ? given : deltasIn(typeof rec.resultText === "string" ? rec.resultText : null);
  const summary = (text: string) => (declared.summary ? {} : { summary: text });
  if (!raw) return { staged: null, error: null, result: { ...summary("It gave no list of memory changes, so nothing was staged."), context: { applied: [], refused: [], ignored: [] } } };
  try {
    const st = await stageOnBranch(runId, { agentId: a.agentId, profile: a.profile, spec: a.spec, taskId: taskLabelOf(a, a.agentId) }, raw);
    const changes = st.applied.filter((x) => x.op !== "duplicate").length;
    const text = st.sha
      ? `Staged ${changes} memory change${changes === 1 ? "" : "s"} on ${st.branch} (${st.applied.map((x) => (x.op === "supersede" ? `supersede ${x.target} with ${x.id}` : `${x.op} ${x.id}`)).join(", ")})${st.refused.length ? `; ${st.refused.length} refused` : ""}.`
      : `Nothing to stage: ${st.applied.length ? "the project's memory says it already" : st.refused.length ? `all ${st.refused.length} of its changes were refused` : st.brain.proposals.length ? "its changes are all for the brain" : "it gave no changes"}.`;
    const brain = await brainProposalsOf(runId, a, st.brain);
    return { staged: st, error: null, result: { ...summary(brain ? `${text} ${brain.text}` : text), context: { applied: st.applied, refused: [...st.refused, ...st.brain.refused].sort((x, y) => x.n - y.n).map(({ n, reason }) => ({ n, reason })), ignored: st.ignored, lint: { errors: st.lint.errors.length, warnings: st.lint.warnings }, ...(brain ? { brain: brain.result } : {}) } } };
  } catch (e) {
    const error = `its memory changes could not be staged: ${String((e as Error)?.message ?? e).slice(0, 500)}`;
    return { staged: { sha: null }, error, result: { error, context: { applied: [], refused: [], ignored: [] } } };
  }
}

/**
 * A consolidator's proposals to the brain its profile names (ADR-025 step 5, src/context/brain-proposals.ts), kept when
 * it was staged: under `review: lint` sent now, as capcomd, each a draft on the run's proposal branch of the brain's
 * repository and a pull request there; under `review: human` (the default) they wait for a person to send them, as
 * themselves. What its result says of them (`context.brain`), and a sentence for its summary. null: it proposed none.
 */
async function brainProposalsOf(runId: string, a: ScopeAgent, b: import("../context/consolidator").StagedBranch["brain"]) {
  if (!b.name || !b.proposals.length) return null;
  const n = b.proposals.length;
  const listed = b.proposals.map(({ n: k, title, type }) => ({ n: k, title, type }));
  const lint = (a.spec as { context?: { review?: string } } | null)?.context?.review === "lint";
  if (!lint) {
    return {
      result: { name: b.name, proposals: listed, awaits: "person" as const, sent: [] },
      text: `${n} proposal${n === 1 ? "" : "s"} to brain ${b.name} wait${n === 1 ? "s" : ""} for a person: capcomd context brain propose --run ${runId} --yes`,
    };
  }
  const { sendBrainProposals, LINT_SEND_BUDGET_MS } = await import("../context/brain-proposals");
  // Kept already: a send that can't even start leaves them for a person, never fails the memory staged on the branch.
  // Bounded as a whole (the settle step it runs in has its own deadline); what is left is sent with the command.
  const sent = await sendBrainProposals(runId, { agentId: a.agentId, by: { kind: "agent", agentId: a.agentId, runId }, budgetMs: LINT_SEND_BUDGET_MS }).catch((e: unknown) => e as Error);
  if (sent instanceof Error) {
    return {
      result: { name: b.name, proposals: listed, awaits: "person" as const, sent: [], error: String(sent.message ?? sent).slice(0, 500) },
      text: `${n} proposal${n === 1 ? "" : "s"} to brain ${b.name} couldn't be sent (${String(sent.message ?? sent).slice(0, 200)}): send ${n === 1 ? "it" : "them"} with capcomd context brain propose --run ${runId} --yes`,
    };
  }
  const ok = sent.filter((x) => x.ok);
  return {
    result: { name: b.name, proposals: listed, awaits: null, sent: sent.map((x) => (x.ok ? { id: x.id, item: x.item, where: x.where } : { id: x.id, error: x.error })) },
    text: `Proposed ${ok.length} of ${n} to brain ${b.name}${ok[0]?.where ? ` (${ok[0].where})` : ""}${ok.length < n ? `; the rest can be sent again with capcomd context brain propose --run ${runId} --yes` : ""}.`,
  };
}

async function driveOnce(runId: string, agentId: string, driver = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`, seen: EngineSeen = {}): Promise<ScopeAgent> {
  const s = client().scope.getOrCreate([runId]);
  const claim = await s.claimDriver({ agentId, driver, ttlMs: leaseMs() }).catch(asRelay);
  seen.instance = (claim as { instance?: string }).instance ?? null;
  if (!claim.ok) return claim.agent;
  const a = claim.agent;
  const paused = await preflightDrive(runId, agentId, s, a);
  if (paused) return paused;
  const hb = setInterval(() => { s.claimDriver({ agentId, driver, ttlMs: leaseMs() }).catch(() => {}); }, Math.max(500, leaseMs() / 3));
  const w = workerOf(runId, agentId, a.epoch);
  const cancelled = async () => (await s.getAgent({ agentId }))?.status === "cancelled";
  try {
    const prepared = (await preparing(a)) ? await agentPreparing(runId, a) : null;
    if (await ensureWorker(runId, a, w, prepared)) return (await s.getAgent({ agentId }))!;
    const out = await runAttempt(runId, a, w, undefined, prepared);
    if (out.kind === "ended") return (await s.getAgent({ agentId }))!;
    return await settlePushed(runId, a, w, out);
  } catch (e) {
    if (await cancelled().catch(() => false)) { await w.drainWorker({ workerId: agentId }).catch(() => {}); return (await s.getAgent({ agentId }))!; }
    throw e;
  } finally {
    clearInterval(hb);
  }
}

// ── ADR-022 (the default; not with CAPCOMD_AGENT_WORKFLOW=0): the same steps, called from the worker actor's workflow ──

/** Claim the agent for the workflow and make the driver's checks. "end": nothing to do (finished, paused, cancelled,
 *  or driven by a live driver); "paused": paused before it ran (its usage reset, or 0). */
export async function prepareDrive(runId: string, agentId: string, driver: string, ttlMs: number): Promise<{ kind: "go"; startedAt: number } | { kind: "end" } | { kind: "paused"; until: number }> {
  const s = client().scope.getOrCreate([runId]);
  const claim = await s.claimDriver({ agentId, driver, ttlMs }).catch(asRelay);
  if (!claim.ok) return { kind: "end" };
  const paused = await preflightDrive(runId, agentId, s, claim.agent);
  return paused ? { kind: "paused", until: Number(paused.pausedUntil ?? 0) } : { kind: "go", startedAt: Date.now() };
}

/** The workflow's ensure-machine step. `prepared`: the spec agent.preparing's plugins made for this attempt, which its
 *  run uses too (the workflow keeps it in the drive loop's state). */
export async function ensureMachine(runId: string, agentId: string, epoch: number, attempt = 1): Promise<{ kind: "ok"; prepared?: Record<string, unknown> } | { kind: "ended" }> {
  const a = await getAgentOrThrow(runId, agentId);
  if (TERMINAL_AGENT.has(a.status)) return { kind: "ended" };
  const prepared = (await preparing(a)) ? await agentPreparing(runId, a, attempt) : null;
  return (await ensureWorker(runId, a, workerOf(runId, agentId, epoch), prepared)) ? { kind: "ended" } : { kind: "ok", ...(prepared ? { prepared } : {}) };
}

/**
 * Whether agent `a` is prepared here: its profile pinned skills, or a plugin prepares agents. The built-in orchestration
 * skill does in every process (src/plugins/skill-orchestration.ts): an attempt prepared here waits for this process's
 * plugins (the daemon's host, else a local one, src/plugins/hooks.ts `gates`), so an agent that may spawn always gets
 * it, even one resumed before they loaded.
 */
async function preparing(a: ScopeAgent): Promise<boolean> {
  await gates();
  return hooks.listening("agent.preparing") || pinnedSkills(a.spec).length > 0;
}

/** The spec an attempt runs with when agent.preparing's plugins or its profile's skills changed it; null: the agent's own. */
export type PreparedSpec = Record<string, unknown> | null;

/**
 * The skills agent `a` was pinned with at spawn (its profile's, ADR-024 §7 step 5), with the text the run keeps for
 * each (scope `spawn`'s `skillTexts`), checked against its pin: one that isn't there as pinned fails the attempt for
 * good, never runs it without the skill or with another text.
 */
async function pinnedSkillTexts(runId: string, a: ScopeAgent): Promise<AgentPreparing["prompt"]["skills"]> {
  const s = client().scope.getOrCreate([runId]);
  const out: AgentPreparing["prompt"]["skills"] = [];
  for (const p of pinnedSkills(a.spec)) {
    const att = await s.getAttachment({ id: attachmentId(p.hash) });
    if (!att || skillHash(att.body) !== p.hash)
      throw new RelayError("config", `${a.agentId}'s profile skill ${p.name} (sha256 ${p.hash.slice(0, 12)}…) isn't in run ${runId}'s records as it was pinned at spawn`, "Spawn the agent again: its profile's skills are read and pinned when it is spawned.");
    out.push({ name: p.name, hash: p.hash, source: p.source, text: att.body });
  }
  return out;
}

/**
 * agent.preparing (plugin API §6.6.7): once per attempt, before its machine is ensured. The payload has the profile's
 * own prompt and skills (pinned at spawn); a plugin may append to the agent's system prompt, add skills or variables,
 * remove egress hosts, or refuse the attempt (it fails, naming the plugin). Returns the spec the attempt's machine and
 * run get, or null when neither a plugin nor the profile's skills changed it.
 */
export async function agentPreparing(runId: string, a: ScopeAgent, attempt = 1): Promise<PreparedSpec> {
  const spec = pinnedOf(a);
  const RS = await import("../providers/run-sandbox");
  // Where its machine runs: its profile's sandbox, else its run's (ADR-024 `sandbox.provider`).
  const machine = pinnedMachine(a.spec);
  const source = await RS.agentSandboxEnv(runId, machine.sandbox);
  let egress: string[] = [], credentialMode: "secret" | "env" | "subscription" | "none" = "none";
  if (execOf(a)) {
    try {
      const cfg = (await import("../agents/config")).loadAgentConfig(source, a.ref, a.spec);
      egress = cfg.egress;
      credentialMode = cfg.credentialMode === "auto" ? "secret" : cfg.credentialMode;
    } catch { /* the run reports a bad profile itself */ }
  }
  let provider = "fake";
  try { provider = (await RS.agentSandbox(runId, machine.sandbox)) ?? sandboxName(); } catch { /* an unknown CAPCOMD_SANDBOX: the run reports it */ }
  const skills = await pinnedSkillTexts(runId, a);
  const payload = { agent: agentOf(a), spec, prompt: { system: spec.systemPrompt ?? null, append: spec.appendSystemPrompt ?? null, skills }, env: agentEnvNames(spec.provider), egress, credentialMode, sandbox: { provider, environment: machine.environment ?? null } };
  let n: AgentPreparing = payload, patches: Array<{ patch: PreparePatch }> = [];
  // The kernel's own listeners read the agent's record from here, not the engine again (the orchestration skill); the
  // context router leaves the bundles its brief cites here, for the attempt's runner to place (ADR-025 §6.2).
  const kernel: { runId: string; agentId: string; record: unknown; bundles?: unknown[] } = { runId, agentId: a.agentId, record: a };
  if (hooks.listening("agent.preparing")) {
    const out = await preparingAgent.run(kernel, () => hooks.fire("agent.preparing", "modify", payload, { principal: principalOf(null), entity: `${a.agentId}/e${a.epoch}`, attempt, runId, agentId: a.agentId,
      apply: (p, patch) => applyPreparePatch(p, patch) }));
    // A final error (code config): the attempt isn't retried, the agent fails with the plugin's reason.
    if (out.decision === "deny") throw refusedError("agent.preparing", out, "config");
    n = out.payload;
    patches = out.patches;
  }
  if (!patches.length && !skills.length) return null;
  // Skills go after the profile's text and the plugins' appends: the profile's first, then the plugins' in the order
  // they added them, each in a block named for it as a message's are (src/agents/skills.ts `skillBlock`). The agent
  // reads them as its instructions (Claude Code's appended system prompt, Codex's prompt); the spec records which, by hash.
  const append = [n.prompt.append, ...n.prompt.skills.map((s) => skillBlock(s.name, s.text))].filter(Boolean).join("\n\n");
  const env = Object.assign({}, ...patches.map((x) => x.patch.env ?? {})) as Record<string, string>;
  return {
    ...(a.spec ?? {}), ...(append ? { appendSystemPrompt: append } : {}), ...(JSON.stringify(n.egress) !== JSON.stringify(egress) ? { egress: n.egress } : {}),
    ...(n.prompt.skills.length ? { skills: n.prompt.skills.map(({ name, hash, source }) => ({ name, hash, source })) } : {}),
    ...(Object.keys(env).length ? { pluginEnv: env } : {}),
    ...(kernel.bundles?.length ? { contextBundles: kernel.bundles } : {}),
  };
}

/** The variables an agent's environment has before any plugin adds one (agent.preparing `env`, §6.6.7): what the runner
 *  sets (its PATH and HOME, the in-VM capcomd's), and its provider's own and its credential's. Names, never values. */
export function agentEnvNames(provider: string | undefined): string[] {
  const names = new Set(["HOME", "PATH", "CAPCOMD_RPC_DIR", "CAPCOMD_CHECKOUT"]);
  const p = provider ? agentSeam(provider) : null;
  if (p) {
    for (const k of Object.keys(p.baseEnv())) names.add(k);
    for (const k of Object.keys(p.credentialEnv("x"))) names.add(k);
    names.add(p.describe().secretName);
  }
  return [...names];
}

/** The workflow's settle step after a run that came to an outcome. Returns the agent as it ends (paused included). */
export async function settleAttempt(runId: string, agentId: string, epoch: number, out: AttemptOutcome): Promise<ScopeAgent> {
  const a = await getAgentOrThrow(runId, agentId);
  const w = workerOf(runId, agentId, epoch);
  if (out.kind === "ended" || TERMINAL_AGENT.has(a.status)) return settleEnded(runId, agentId, epoch);
  return settlePushed(runId, a, w, out);
}

/** Ended without a push (cancelled, or a handoff finished it): release its VM when it was cancelled. */
export async function settleEnded(runId: string, agentId: string, epoch: number): Promise<ScopeAgent> {
  const a = await getAgentOrThrow(runId, agentId);
  if (a.status === "cancelled") {
    await endJobs(runId, agentId, "its agent was cancelled");
    await workerOf(runId, agentId, epoch).drainWorker({ workerId: agentId }).catch(() => {});
  }
  return getAgentOrThrow(runId, agentId);
}

/**
 * Plugin API §16.2 rule 4: an agent that ended for good (failed or cancelled) has its background jobs settled now, before
 * its machine goes: killed while its machine is attached here, else `lost`; never left `running` until someone reads them.
 */
async function endJobs(runId: string, agentId: string, reason: string): Promise<void> {
  await (await import("../jobs/service")).endAgentJobs(runId, agentId, reason).catch((e) => console.error(`[jobs] ${agentId}: ending its jobs: ${(e as Error)?.message ?? e}`));
}

/** Record one failed attempt (DRIVE_FAILED) and say whether to try again: the driver's rules (3 attempts, N identical
 *  failures in a row, never for a final kind). */
export async function recordDriveFailure(runId: string, agentId: string, driver: string, attempt: number, err: { kind: string; message: string; final: boolean; transient?: boolean } | null, maxAttempts: number, o: { outages?: number } = {}): Promise<{ retry: boolean; outage?: boolean }> {
  if (!err) return { retry: false };
  const s = client().scope.getOrCreate([runId]);
  const df = await s.driveFailed({ agentId, kind: err.kind, message: err.message, attempt, driver }).catch(() => null);
  // The sandbox provider's outage: run it again without counting (MAX_OUTAGE_RETRIES bounds a provider that flaps).
  const outages = o.outages ?? 0;
  if (err.transient && !err.final && outages < MAX_OUTAGE_RETRIES) return { retry: true, outage: true };
  const maxSame = Number(env("DRIVE_MAX_FAILURES") ?? 3);
  return { retry: !err.final && attempt - outages < maxAttempts && !(df && df.consecutive >= maxSame) };
}

/**
 * The agent.run span the driver opens around a drive, for an agent the workflow drove (one per agent that ended, as the
 * driver's: a paused attempt's is dropped), written to the run's trace (its CAPCOMD_TRACE_DIR at `run new`).
 */
export async function recordAgentRunSpan(runId: string, agentId: string, startedAt: number): Promise<void> {
  const a = await getAgentOrThrow(runId, agentId);
  if (!TERMINAL_AGENT.has(a.status) || env("TRACE") === "off") return;
  const { traceIdForRun, tracePath, traceDir } = await import("../utils/tracing-simple");
  const span = {
    traceId: traceIdForRun(runId), spanId: agentSpanId(runId, agentId), parentSpanId: a.parent ? agentSpanId(runId, a.parent) : rootSpanIdForRun(runId),
    name: "agent.run", startTime: startedAt, endTime: Date.now(), events: [], status: { code: 1 },
    attributes: { "relay.run_id": runId, "agent.id": agentId, "agent.parent": a.parent ?? null, "relay.agent_id": agentId, "relay.parent_agent_id": a.parent ?? null, "agent.profile": a.profile ?? null, "agent.depth": a.depth ?? 0, "agent.driver": "workflow" } as Record<string, any>,
  };
  stampSpent(span, a);
  try {
    const dir = (await runTraceDir(runId).catch(() => undefined)) ?? traceDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(tracePath(runId, dir), JSON.stringify(span) + "\n");
  } catch { /* tracing must never break the run */ }
}

/** The agent failed for good: its result says why (a cancel meanwhile wins: its VM is released). */
export async function finishFailed(runId: string, agentId: string, epoch: number, err: { message: string; exitCode?: number; kind?: string }): Promise<ScopeAgent> {
  const a = await getAgentOrThrow(runId, agentId);
  if (a.status === "cancelled") return settleEnded(runId, agentId, epoch);
  // Its jobs settle and its machine goes once it has failed (here too when an earlier settle recorded the failure but
  // stopped before this).
  const drain = async () => { await endJobs(runId, agentId, "its agent failed"); await workerOf(runId, agentId, epoch).drainWorker({ workerId: agentId }).catch(() => {}); };
  if (TERMINAL_AGENT.has(a.status)) { if (a.status === "failed") await drain(); return a; }
  const res = await resultOf(runId, agentId);
  const fin = await client().scope.getOrCreate([runId]).finish({ agentId, status: "failed", result: { ...res, error: String(err.message ?? "").slice(0, 500), ...(err.exitCode !== undefined ? { exitCode: err.exitCode } : {}), ...outageResult(err) } });
  await drain();
  return fin.agent;
}

function parseBudgetLoose(v: unknown): Budget { try { return parseBudget(v); } catch { return {}; } }

function fakeFileParams(f: { path?: string; content?: string }) {
  return f.path ? { fakePath: f.path, fakeContent: f.content ?? "" } : {};
}

/** Real agent with the in-VM capcomd (`hasVmCapcomd`): token + pump on its VM; the runner installs CLI, MCP and skill
 *  (the orchestration skill for one that may spawn, the worker's lines for any other). */
async function vmRpcFor(runId: string, a: ScopeAgent, w: any, agentId: string, prepared: PreparedSpec) {
  const wk: any = await w.getWorker({ workerId: agentId });
  const vmId = wk?.context?.vmId;
  if (!vmId) return null;
  // Its machine's sandbox, as recorded on its worker when it was made (its profile's, else the run's).
  const made = typeof wk?.context?.sandbox === "string" && wk.context.sandbox ? wk.context.sandbox as string : null;
  const { provider, sandbox } = await (await import("../dependencies")).providerForAgent(runId, pinnedMachine(a.spec).sandbox ?? made);
  const { VM_RPC_DIR, workerSkill } = await import("../subagents/skill");
  const kind = (a.spec as any)?.kind ?? (a.spec as any)?.provider;
  // The test sandbox that runs "VMs" on this host shares one /tmp: each agent's spool gets its own folder there.
  const place = sandbox ?? (() => { try { return sandboxName(); } catch { return null; } })();
  const rpcDir = place === "fake-host" ? join(tmpdir(), "capcomd-rpc", runId, agentId) : VM_RPC_DIR;
  const maySpawn = a.limits.allowSpawn;
  // The job ops: by its profile and the config it runs with (the daemon's tool and sandbox settings narrow it too).
  const effective = await (async () => { try { return (await import("../agents/config")).loadAgentConfig(withSandbox(process.env, sandbox), a.ref, a.spec); } catch { return null; } })();
  const jobs = mayRunJobs(a.spec, effective);
  const orchestrate = (a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate";
  const skill = maySpawn ? await unpreparedSkill(runId, a, prepared) : workerSkill({ mcp: true, jobs: jobs && !orchestrate });
  const params = { kind, rpcDir, ...(skill ? { skill } : {}), ...(maySpawn ? {} : { maySpawn: false }) };
  return { params, run: <T>(fn: () => Promise<T>) => withVmRpc(runId, a, provider, vmId, undefined, fn, rpcDir, { jobs }) };
}

/**
 * An agent that may spawn gets its orchestration skill with its spec: the skill-orchestration plugin attaches it at
 * agent.preparing. An attempt no plugin prepared (`prepared` null: its workflow passed that step under a capcomd before
 * the skill was a plugin's, and starts or restarts the agent after an upgrade), or prepared without it (only its
 * profile's skills, no plugin listening), gets it here instead, as it always did.
 */
export async function unpreparedSkill(runId: string, a: ScopeAgent, prepared: PreparedSpec): Promise<string | undefined> {
  const has = Array.isArray(prepared?.skills) && (prepared.skills as Array<{ name?: unknown }>).some((s) => s?.name === ORCHESTRATION_SKILL_NAME);
  // In its block, as a prepared attempt gets it (agentPreparing).
  return has ? undefined : skillBlock(ORCHESTRATION_SKILL_NAME, await (await import("../plugins/skill-orchestration")).skillText(runId, a));
}

export async function getAgentOrThrow(runId: string, agentId: string): Promise<ScopeAgent> {
  const a = await client().scope.getOrCreate([runId]).getAgent({ agentId });
  if (!a) throw new RelayError("not_found", `agent ${agentId} not found in ${runId}`, "Check ids with `capcomd agents-of <runId> --json`.");
  return a;
}

/**
 * Wait until the agents are terminal; take over stale drivers. Timeout returns status "timeout". With `notices`
 * (ADR-019 §2), a stuck notice raised on an awaited agent while waiting ends the wait too, as `notices`, so the
 * waiter hears about trouble when it happens; one already showing when the wait began doesn't.
 * `ops` (vfy-… / mrg-… ids) are waited on with the agents: an op is finished once it isn't running (passed, failed,
 * merged, or parked for an approval); `ops` in the result has each one's record. With `any`, the first agent or op to
 * finish ends the wait. An op left running by a caller that went away (another session, a restarted server) is resumed
 * here, as a call with its id would (idempotent: the verifier shares one run per op).
 */
export async function awaitAgents(runId: string, ids: string[], opts: { timeoutMs?: number; any?: boolean; notices?: boolean; ops?: string[] } = {}) {
  await assertEngine();
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const kicked = new Map<string, number>();
  const done = new Map<string, ScopeAgent>();
  const latest = new Map<string, ScopeAgent>();
  const noticeAt = new Map<string, number>();
  const opIds = [...new Set(opts.ops ?? [])];
  const opsDone = new Map<string, ReturnType<typeof opView>>();
  const opsLatest = new Map<string, ReturnType<typeof opView>>();
  const resumed = new Set<string>();
  // ADR-022: with the agent workflow, wait for the scope's "agents changed" event instead of polling every pollMs()
  // (a slow poll stays as the fallback: an event missed while reconnecting, a kick that's due). Ops always wait on the
  // scope's "ops changed" event, and on the settling of an op this process runs.
  const feed = opIds.length || (await engineDrivesAgents(runId)) ? changeFeed(runId) : null;
  const s = client().scope.getOrCreate([runId]);
  const opsView = () => opIds.map((i) => opsDone.get(i) ?? opsLatest.get(i)!);
  try {
  for (let poll = 0; ; poll++) {
    const noticed: ScopeAgent[] = [];
    for (const id of ids) {
      if (done.has(id)) continue;
      const a = await getAgentOrThrow(runId, id);
      latest.set(id, a);
      if (TERMINAL_AGENT.has(a.status)) { done.set(id, a); continue; }
      // A paused agent wakes at its reset time; until then nothing drives it.
      if (a.status === "paused") { if (await wakeIfDue(runId, a)) kicked.set(id, Date.now()); continue; }
      const stale = !a.driver || a.driverUntil < Date.now();
      if (stale && (kicked.get(id) ?? 0) < Date.now() - leaseMs()) { await startDriver(runId, id); kicked.set(id, Date.now()); }
      const at = a.notice?.at ?? 0;
      if (opts.notices && poll > 0 && at && at !== noticeAt.get(id)) noticed.push(a);
      noticeAt.set(id, at);
    }
    for (const id of opIds) {
      if (opsDone.has(id)) continue;
      const op = await s.getOp({ opId: id });
      // Started here a moment ago and not recorded yet (a verify answers with its id before it has resolved its ref).
      if (!op && inflightOps.has(id)) {
        opsLatest.set(id, { id, kind: id.startsWith("vfy-") ? "verify" : id.startsWith("chk-") ? "check" : "merge", state: "running" } as any);
        if (feed) void inflightOps.get(id)!.then(feed.poke, feed.poke);
        continue;
      }
      if (!op || (op.kind !== "verify" && op.kind !== "merge" && op.kind !== "check")) throw new RelayError("not_found", `${id} not found in ${runId}`, "Pass the vfy-… / mrg-… / chk-… ids capcomd verify, merge and check returned.");
      const v = opView(op);
      opsLatest.set(id, v);
      if (op.state !== "running") { opsDone.set(id, v); continue; }
      const mine = inflightOps.get(id);
      if (mine) { if (feed) void mine.then(feed.poke, feed.poke); }
      else if (!resumed.has(id)) {
        resumed.add(id);
        const p = op.kind === "verify" ? verifyRef({ runId, ref: op.data.ref as string, id }) : op.kind === "check" ? checkRef({ runId, id }) : mergeRef({ runId, ref: op.data.ref as string, id });
        p.catch(() => {}); // its record says how it ended; the next look reads it
        if (feed) void p.then(feed.poke, feed.poke);
      }
    }
    const anyDone = done.size + opsDone.size > 0;
    const withOps = opIds.length ? { ops: opsView() } : {};
    if (opts.any && anyDone) {
      const first = done.size ? [...done.values()].sort((x, y) => x.updatedAt - y.updatedAt)[0] : null;
      return { ...(first ? { first: view(first) } : {}), agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "running" })), ...withOps };
    }
    if (done.size === ids.length && opsDone.size === opIds.length) return { agents: ids.map((i) => view(done.get(i)!)), ...withOps };
    if (noticed.length) return { notices: noticed.map((a) => ({ agentId: a.agentId, ...a.notice! })), agents: ids.map((i) => view(done.get(i) ?? latest.get(i)!)), ...withOps };
    if (Date.now() > deadline) return { timeout: true, agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "timeout" })), ...withOps };
    if (feed) await feed.wait(Math.min(eventFallbackMs(), Math.max(0, deadline - Date.now()) + 1)); else await sleep(pollMs());
  }
  } finally { feed?.close(); }
}

const eventFallbackMs = () => Number(env("AWAIT_FALLBACK_MS") ?? 5000);

/**
 * The scope's `agentsChanged` and `opsChanged` events (ADR-022) as a wait: resolves at the next event, or after `ms`.
 * No wake-up is lost: an event (or a `poke`) that came while nobody waited makes the next wait return at once, and so
 * does each (re)connect, since events sent before it can't have reached this connection.
 */
function changeFeed(runId: string): { wait: (ms: number) => Promise<void>; poke: () => void; close: () => void } | null {
  try {
    const conn: any = client().scope.getOrCreate([runId]).connect();
    let dirty = false;
    let wake: (() => void) | null = null;
    const poke = () => { if (wake) { const w = wake; wake = null; w(); } else dirty = true; };
    conn.on("agentsChanged", poke);
    conn.on("opsChanged", poke);
    conn.onOpen?.(poke);
    conn.onError?.(() => {});
    return {
      wait: (ms) => new Promise<void>((resolve) => {
        if (dirty) { dirty = false; resolve(); return; }
        const t = setTimeout(() => { wake = null; resolve(); }, ms);
        wake = () => { clearTimeout(t); resolve(); };
      }),
      poke,
      close: () => { try { void conn.dispose?.(); } catch {} },
    };
  } catch { return null; }
}

/**
 * Wait for one agent that may pause on its provider's usage limit (ADR-019 §6). A pause isn't a failure and can
 * outlast any wait (a weekly limit, by days), so a timeout while it is paused waits again, for its reset or
 * `capcomd resume`; `onPaused` hears about each such wait.
 */
export async function awaitThroughPauses(runId: string, agentId: string, o: { timeoutMs: number; onPaused?: (a: ScopeAgent) => void }) {
  for (;;) {
    const r = await awaitAgents(runId, [agentId], { timeoutMs: o.timeoutMs });
    if (!("timeout" in r)) return r;
    const a = await getAgentOrThrow(runId, agentId);
    if (a.status !== "paused") return r;
    o.onPaused?.(a);
  }
}

/**
 * When the agent a message is sent to will read it, if not right away: a running Claude agent reads it at its next
 * step (ADR-019 §3), but `codex exec` reads no input after its prompt, and a finished agent reads nothing. Null when
 * it will read it now (or the agent isn't known here).
 */
export async function messageNote(runId: string, to: string): Promise<string | null> {
  const a: ScopeAgent | null = await client().scope.getOrCreate([runId]).getAgent({ agentId: to }).catch(() => null);
  if (!a) return null;
  if (TERMINAL_AGENT.has(a.status)) return `${to} is ${a.status}: nothing will read this message`;
  if ((a.spec as { provider?: string } | null)?.provider !== "codex") return null;
  return hasVmCapcomd(a)
    ? `${to} is a Codex agent: it can't read messages while it works, only when it checks its inbox (capcomd inbox)`
    : `${to} is a Codex agent that can't read messages while it works: this one stays in its inbox, unread`;
}

/** `capcomd send`: append a message to `to`'s mailbox (idempotent by key), with a note when it won't be read right away. */
export async function sendToAgent(runId: string, o: { to: string; from: string; body: string; key?: string; skills?: AttachedSkill[] }) {
  await assertEngine();
  const r = await client().scope.getOrCreate([runId]).sendMessage({ to: o.to, from: o.from, body: o.body, ...(o.key ? { key: o.key } : {}), ...(o.skills?.length ? { skills: o.skills } : {}) });
  return { ...r, note: await messageNote(runId, o.to) };
}

/**
 * ADR-019 §6: run paused agents again now (an agent and its paused descendants, as `pauseAgents` paused them, or every
 * paused agent in the run), each from its work so far. It is the operator saying the login can work: its recorded quota
 * is cleared, so other waiting agents may go too.
 */
export async function resumeAgents(runId: string, agentId?: string, by = "operator") {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  let all: ScopeAgent[];
  if (agentId) {
    const target = await getAgentOrThrow(runId, agentId);
    const every: ScopeAgent[] = await s.listAgents({});
    const kids = new Map<string | null, ScopeAgent[]>();
    for (const a of every) kids.set(a.parent, [...(kids.get(a.parent) ?? []), a]);
    all = [];
    const walk = (a: ScopeAgent) => { all.push(a); for (const k of kids.get(a.agentId) ?? []) walk(k); };
    walk(target);
  } else all = await s.listAgents({});
  const paused = all.filter((a) => a.status === "paused");
  if (agentId && !paused.length) throw new RelayError("conflict", `agent ${agentId} is ${all[0]!.status}, not paused${all.length > 1 ? ", and none of its descendants is paused" : ""}`, "Only a paused agent can be resumed; see `capcomd tree`.");
  const resumed: string[] = [];
  for (const a of paused) {
    const login = loginOf(a.spec);
    if (login) clearQuota(login);
    const r = await s.resume({ agentId: a.agentId, by });
    if (r.changed) { resumed.push(a.agentId); await startDriver(runId, a.agentId); }
  }
  return { runId, resumed };
}

/**
 * The operator pauses an agent and its descendants (or the whole run). One that hasn't started is paused now; a running
 * one stops at its runner's next poll with its work pushed to its branch, then is paused (`resume` runs it on as its
 * next epoch). `paused`: paused now; `pausing`: asked to stop (each ends as paused, or done/failed if it finished first).
 */
export async function pauseAgents(runId: string, agentId?: string, by = "operator") {
  await assertEngine();
  const r = await client().scope.getOrCreate([runId]).requestPause({ ...(agentId ? { agentId } : {}), by }).catch(asRelay);
  return { runId, target: agentId ?? null, paused: r.paused, pausing: r.pausing };
}

/**
 * `capcomd cancel <runId> [agt]`. A recipe run (the planner flow over the primitives) keeps the run-level cancel
 * ({state, changed}) and its scope agents are cancelled alongside; a primitives run cancels agents (cancelAgents); a run
 * with no scope cancels the run actor.
 */
export async function cancelAny(runId: string, agentId?: string, reason?: string, by?: string): Promise<
  | { kind: "run"; run: { runId: string; state: string; changed: boolean }; agents: { cancelled: string[] } | null }
  | { kind: "agents"; agents: Awaited<ReturnType<typeof cancelAgents>> }> {
  const S = await import("./state");
  const scoped = await listScope(runId).then(() => true, () => false);
  const recipeRun = !agentId && scoped && await S.kvGet(runId, "recipe/plan").then((e: any) => e.version > 0, () => false);
  if (recipeRun) {
    const run = await cancelRun(runId);
    const agents = run.changed ? await cancelAgents(runId, undefined, reason ?? "run cancelled").catch(() => null) : null;
    return { kind: "run", run, agents };
  }
  if (agentId || scoped) return { kind: "agents", agents: await cancelAgents(runId, agentId, reason, by) };
  return { kind: "run", run: await cancelRun(runId), agents: null };
}

/** Cancel an agent (or the whole run) and every descendant; destroy their VMs. Idempotent. */
export async function cancelAgents(runId: string, agentId?: string, reason?: string, by?: string) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const res = await s.cancel({ ...(agentId ? { agentId } : {}), ...(reason ? { reason } : {}) }).catch(asRelay);
  const all = await s.listAgents({});
  const affected = all.filter((a: { agentId: string; status: string }) => res.affected.includes(a.agentId));
  for (const a of affected) {
    if (a.status !== "cancelled") continue;
    const w = workerOf(runId, a.agentId, (a as ScopeAgent).epoch);
    const wk = await w.getWorker({ workerId: a.agentId });
    if (wk && wk.state !== "destroyed") await w.drainWorker({ workerId: a.agentId });
  }
  let runEnded = false;
  if (!agentId) {
    await c.run.getOrCreate([runId]).cancel({ runId });
    // A run-wide cancel ends the run as cancelled, whatever its agents did (it reads "cancelled" everywhere, never idle).
    runEnded = await endRun(runId, "cancelled", reason ?? "run cancelled", by, { evenIfAgentsEnded: true }).then((r) => r.changed, () => false);
  }
  return { runId, target: agentId ?? null, cancelled: res.cancelled, affected: affected.map((a: { agentId: string; status: string }) => ({ agentId: a.agentId, status: a.status })), ...(runEnded ? { runEnded } : {}) };
}

/**
 * Record that the run itself ended (scope RUN_ENDED → lifecycle run.failed / run.cancelled), unless it already has:
 * by its agents (the lifecycle feed's own fold) or an earlier end. `changed`: this call ended it.
 */
export async function endRun(runId: string, state: "failed" | "cancelled", reason: string, by?: string | null, o: { evenIfAgentsEnded?: boolean } = {}): Promise<{ changed: boolean; state: string }> {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const had = (await s.getScope({}))?.ended;
  if (had) return { changed: false, state: had.state };
  const { runPhase } = await import("../api/lifecycle");
  if (!o.evenIfAgentsEnded && runPhase(runId, await s.getEvents({})) === "ended") return { changed: false, state: "ended" };
  const r = await s.endRun({ state, reason, by: by ?? null });
  if (r.changed && state === "failed") await client().run.getOrCreate([runId]).configFail({ runId, reason }).catch(() => {});
  return { changed: r.changed, state: r.ended.state };
}

export async function listScope(runId: string) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const scope = await s.getScope({});
  if (!scope) throw new RelayError("not_found", `run ${runId} has no primitives scope`, "Create one with `capcomd run new`.");
  return { runId, ...scope, agents: (await s.listAgents({})).map(view) };
}

// ── ADR-016 step 2: verify + merge --require ────────────────────────────────────────────────

function taskLabelOf(a: any, agentId: string): string {
  const p = a?.contract?.planTask;
  return typeof p === "string" && /^[A-Za-z0-9._-]{1,64}$/.test(p) ? p : agentId;
}

/** A ref is an agent id (its pushed branch) or a branch name. */
async function resolveRef(runId: string, ref: string): Promise<{ branch: string; agentId: string | null; label: string; pinnedCheck?: string }> {
  if (ref.startsWith("agt-")) {
    const a = await getAgentOrThrow(runId, ref);
    // Plugin API §16.1: an orchestrate agent (a planner, a lead) works through the agents it spawns; nothing of its own lands.
    if ((a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate")
      throw new RelayError("usage", `agent ${ref} is an orchestrate agent: an orchestrate agent has no work of its own`, "Verify and merge the work of the agents it spawned.", { code: "invalid" });
    const branch = a.result?.branch as string | undefined;
    if (a.status !== "done" || !branch) throw new RelayError("conflict", `agent ${ref} is ${a.status}; only a done agent's branch can be verified`, `Wait with \`capcomd await ${runId} ${ref}\`.`);
    const pin = a.contract?.check;
    return { branch, agentId: ref, label: taskLabelOf(a, ref), ...(typeof pin === "string" ? { pinnedCheck: pin } : {}) };
  }
  return { branch: ref, agentId: null, label: ref };
}

export interface VerifyOpts {
  runId: string; ref: string; checks?: string; check?: string; acceptance?: unknown; target?: string; key?: string;
  /** The verification's id (vfy-…): an existing one is polled (attached to: its record, or its run until it ends); a new
   *  one (with ref) is started under this id. Without it, the id comes from the key (a random one without a key). */
  id?: string;
  /** Reviewer profile; default: the run's (`run new --reviewer`). In-VM verify never sets it. */
  reviewProfile?: string;
  /** Deprecated alias of reviewProfile. */
  judgeProfile?: string;
  /** In-VM verify: the calling agent, which pays for the reviewer (the operator's verify: the run). */
  reviewParent?: string;
}

export const verifyIdFor = (runId: string, ref: string, key?: string) => stableId("vfy", `${runId}\0${ref}`, key);

/** A finished verification's record (null while it runs or before it starts): what a poll returns at once. */
export async function finishedVerify(runId: string, vfyId: string) {
  const op = await client().scope.getOrCreate([runId]).getOp({ opId: vfyId }).catch(() => null);
  return op && op.kind === "verify" && op.state !== "running" ? opView(op) : null;
}
/** The verifies and merges this process runs, by id: a second call for one shares its run (never a second run here). */
const inflightOps = new Map<string, Promise<any>>();
/** Run `work` as the one run of op `id` in this process (the caller checked there is none). */
function track<T>(id: string, work: () => Promise<T>): Promise<T> {
  const p = work().finally(() => { if (inflightOps.get(id) === p) inflightOps.delete(id); });
  inflightOps.set(id, p);
  return p;
}

const sameJson = (a: unknown, b: unknown) => paramsHash(a ?? null) === paramsHash(b ?? null);
/** A call for an op that exists conflicts only on a parameter it gives explicitly that differs from the recorded one:
 *  a poll (the id or the key, and nothing else) never does. */
function assertSameOp(id: string, op: import("../actors/scope").ScopeOp, given: Record<string, unknown>) {
  const differ = Object.entries(given).filter(([k, v]) => v !== undefined && !sameJson(v, op.data[k])).map(([k]) => k);
  if (differ.length) throw new RelayError("conflict", `${id} already exists with different parameters (${differ.join(", ")})`,
    `Poll it with just its id (or the same key) and no other parameters, or pass a new key for a new ${op.kind}.`);
}

/**
 * Run checks (the repo's test command, --checks, or the operator-named --check) on the ref merged with the latest target, in
 * the verifier actor (ADR-003: the result comes from running it, never from the agent's report).
 * With a reviewer (the run's, or --review-profile), a reviewer agent then reads the commit against the
 * acceptance criteria; both must pass, and no verdict is a fail.
 * Records vfy-… with the exact branch commit tested, which `merge --require` checks.
 * Idempotent by id (the key's, or `id`): a call for one that exists returns its record, or shares its run while it
 * runs (resuming it when the process that ran it is gone); only a parameter given explicitly that differs conflicts.
 */
export function verifyRef(o: VerifyOpts): Promise<any> {
  const id = o.id ?? verifyIdFor(o.runId, o.ref, o.key);
  if (!/^vfy-[A-Za-z0-9]+$/.test(id)) return Promise.reject(new RelayError("usage", `${id} isn't a verification id`, "Pass the vfy-… id capcomd verify returned."));
  const given = { ref: o.ref || undefined, check: o.check, checks: o.check === undefined ? o.checks : undefined, acceptance: o.acceptance, target: o.target, reviewProfile: o.reviewProfile ?? o.judgeProfile };
  const live = inflightOps.get(id);
  if (live) return (async () => { const op = await client().scope.getOrCreate([o.runId]).getOp({ opId: id }); if (op) assertSameOp(id, op, given); return live; })();
  return track(id, async () => {
    await assertEngine();
    await gates(); // its judges (the reviewer gate) listen in this process (plugin API §6.1)
    const op = await client().scope.getOrCreate([o.runId]).getOp({ opId: id });
    if (op) {
      if (op.kind !== "verify") throw new RelayError("not_found", `${id} is a ${op.kind}, not a verification`, "Pass the vfy-… id capcomd verify returned.");
      assertSameOp(id, op, given);
      return op.state === "running" ? runVerify(o.runId, op, o.reviewParent) : opView(op);
    }
    if (!o.ref) throw new RelayError("not_found", `verification ${id} not found in ${o.runId}`, "Pass the vfy-… id capcomd verify returned, or a ref to start one.");
    return verifyOnce(o, id);
  });
}

/** The run's reviewer profile, if the operator set one. */
export async function runReviewer(runId: string): Promise<string | undefined> {
  const v: any = (await client().scope.getOrCreate([runId]).kvGet({ k: REVIEWER_KV }).catch(() => null))?.value;
  return typeof v?.profile === "string" ? v.profile : undefined;
}

/** A reviewer profile's resolved spec (unknown profiles are a config error). */
export function reviewerSpec(profile: string): Record<string, any> | null {
  try { return (resolveAgent(encodeAgentRef(profile)).spec as any) ?? null; } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", `reviewer: ${e.message}`, "Name an agent profile (`capcomd profiles list`), e.g. --reviewer reviewer.");
    throw e;
  }
}

/** A verification's review (its `review` field): what the judge that ran the run's reviewer reported (§6.6.13). */
interface Review { profile: string; agentId: string | null; passed: boolean; reasons: string[]; error?: string; retryable?: boolean }

/**
 * Whether a review read what the checks tested: the same agent commit, put on the same target commit (when the checks
 * say which). One that read another (the branch or the target moved in between) never counts: both must pass for the
 * same tree. The reviewer gate replaces such a reviewer with one for the tested tree.
 */
export function reviewFits(started: { sha: string; targetSha?: string }, tested: { taskSha: string; targetSha?: string }): boolean {
  if (started.sha !== tested.taskSha) return false;
  return !tested.targetSha || started.targetSha === tested.targetSha;
}

/**
 * The review of a verification whose checks passed, from its judges (§6.6.13). The kernel keeps the gate: a reviewer
 * configured for it must have judged the tested tree and passed it. A report for another tree, or none at all when the
 * judges let it through (the reviewer gate isn't active), fails it; judges that denied it before the reviewer was asked
 * leave no review (the verify has failed already).
 */
function reviewOfJudges(profile: string | undefined, judges: { passed: boolean; reviews: Array<{ plugin: string; review: ReviewReport }> } | null, tested: { taskSha: string; targetSha?: string }): { review: Review; startedAt: number | null } | null {
  if (!profile) return null;
  const r = judges?.reviews.find((x) => x.review.profile === profile)?.review;
  if (!r) return judges && !judges.passed ? null : { review: { profile, agentId: null, passed: false, reasons: [], error: "no judge ran the reviewer: the gate-reviewer plugin isn't active (`capcomd plugins list`)" }, startedAt: null };
  const startedAt = r.startedAt ? Date.parse(r.startedAt) : null;
  if (!reviewFits(r, tested)) return { review: { profile, agentId: r.agentId, passed: false, reasons: [], error: "the review read another tree than the checks tested" }, startedAt };
  return { review: { profile: r.profile, agentId: r.agentId, passed: r.passed, reasons: r.reasons, ...(r.error ? { error: r.error } : {}), ...(r.retryable ? { retryable: true } : {}) }, startedAt };
}

/** Review-mode agents a judge started for this verification (contract.review.vfyId) that are still running when it
 *  ends (its checks failed, the work had landed, another judge denied it): stopped, best effort. */
function stopReviewers(runId: string, vfyId: string, why: string) {
  inBackground((async () => {
    const all: ScopeAgent[] = await client().scope.getOrCreate([runId]).listAgents({});
    for (const a of all) if ((a.contract as any)?.review?.vfyId === vfyId && !TERMINAL_AGENT.has(a.status)) await cancelAgents(runId, a.agentId, why).catch(() => {});
  })());
}

async function verifyOnce(o: VerifyOpts, vfyId: string) {
  const s = client().scope.getOrCreate([o.runId]);
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(o.runId);
  // No repository (cfg null) is a dry run: "main" only labels it, nothing is merged anywhere.
  const target = o.target ?? (await runTarget(o.runId)) ?? cfg?.target ?? "main";
  const { branch, agentId, pinnedCheck } = await resolveRef(o.runId, o.ref);
  if (o.check !== undefined && o.checks) throw new RelayError("usage", "pass --check NAME or --checks CMD, not both", "--check picks one of the run's operator-named checks.");
  // A child pinned to a check at spawn is verified with it unless the caller names another.
  if (o.check === undefined && !o.checks && pinnedCheck) o = { ...o, check: pinnedCheck };
  // No check named, given or pinned, and no command configured for the repository: the run's one named check (the
  // project's `run.checks` that `run new` recorded, or a lone --checks-set), as `capcomd check` takes it, so the verify
  // doesn't pass on "no test command configured". With several, the repository's as before: an unpinned child's in-VM
  // verify can't name one.
  if (o.check === undefined && !o.checks && cfg && !cfg.testCommand.trim()) {
    const names = await namedCheckNames(o.runId);
    if (names.length === 1) o = { ...o, check: names[0]! };
  }
  const checks = o.check !== undefined ? await namedCheck(o.runId, o.check) : o.checks;
  const reviewProfile = o.reviewProfile ?? o.judgeProfile ?? (await runReviewer(o.runId));
  if (reviewProfile) reviewerSpec(reviewProfile); // an unknown reviewer is refused before anything runs
  // The record names the check and the exact command it ran; merge --require re-runs that command.
  const data = { ref: o.ref, agentId, branch, target, ...(o.check !== undefined ? { check: o.check } : {}), checks: checks ?? null, acceptance: o.acceptance ?? null, reviewProfile: reviewProfile ?? null };
  // Who asked (an in-VM verify's agent) isn't a parameter of the verification, as for a merge: it is kept beside it, so
  // its changes name the agent that caused them (plugin API §3.2) and a resume asks the gates as that agent again.
  const st = await s.startOp({ opId: vfyId, kind: "verify", paramsHash: paramsHash(data), data: o.reviewParent ? { ...data, askedBy: o.reviewParent } : data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  return runVerify(o.runId, st.op, o.reviewParent);
}

/** Run (or resume: everything it calls is keyed by the op) a recorded verification, from its recorded parameters. */
async function runVerify(runId: string, op: import("../actors/scope").ScopeOp, reviewParent: string | undefined = typeof op.data.askedBy === "string" ? op.data.askedBy : undefined) {
  const t0 = Date.now();
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const vfyId = op.id;
  const d = op.data as { ref: string; agentId: string | null; branch: string; target: string; checks: string | null; acceptance: unknown; reviewProfile: string | null };
  const { branch, agentId, target } = d;
  const { label } = await resolveRef(runId, d.ref);
  const direct = onGoal(await runGoal(runId), target);
  const reviewProfile = d.reviewProfile ?? undefined;
  // verify.starting (plugin API §6.6.12): plugins may change the acceptance criteria (never the checks), or fail it.
  let acceptance = d.acceptance;
  if (hooks.listening("verify.starting")) {
    const out = await hooks.fire("verify.starting", "modify", { verification: { vfyId, runId, ref: d.ref, target, check: (op.data.check as string | undefined) ?? null }, acceptance, reviewer: reviewProfile ?? null, requestedBy: principalOf(reviewParent ?? null, runId) },
      { principal: principalOf(reviewParent ?? null, runId), entity: vfyId, runId, agentId, apply: (p, patch) => ({ ...p, ...(patch.acceptance !== undefined ? { acceptance: patch.acceptance } : {}) }) });
    if (out.decision === "deny") return refusedVerify(runId, op, out);
    acceptance = out.payload.acceptance;
  }
  // The commit the agent pushed (its result), which the checks are about to test on the target (a reviewer the reviewer
  // gate started at verify.starting reads the same already, merged onto the target as it is now).
  const pushed = agentId ? ((await getAgentOrThrow(runId, agentId)).result?.commit as string | undefined) : undefined;
  const c0 = Date.now();
  const res: any = await c.verifier.getOrCreate([runId, vfyId]).verify({
    verifierId: vfyId, taskId: label, branch, runId, target, testOnly: true, ...(d.checks ? { testCommand: d.checks } : {}), ...(direct ? { mode: "direct" as const } : {}),
    ...(pushed ? { branchSha: pushed } : {}),
  });
  const checksMs = Date.now() - c0;
  const out = res.outcome as import("../merge/types").MergeOutcome;
  // Already on the target (merged earlier): nothing new to check or review, so it passes as already merged.
  const alreadyMerged = out.status === "merged";
  const checksPassed = out.status === "verified" || alreadyMerged;
  if (hooks.listening("verify.changed")) verifyChanged(runId, op, { kind: "checked", passed: checksPassed, where: out.timings?.checksWhere ?? (alreadyMerged ? "reused" : "none"), excerpt: out.status === "failed" ? checkExcerpt("output" in out ? String(out.output ?? "") : "") : null });
  // verify.judging (plugin API §6.6.13): the judges (the reviewer gate among them) judge the tree the checks passed; the
  // checks and every judge must pass, and a reviewer configured for the verify must have passed that same tree.
  const judges = out.status === "verified" && out.sha && out.targetSha && out.taskSha && hooks.listening("verify.judging") ? await verifyJudging(runId, op, { sha: out.sha, targetSha: out.targetSha, commit: out.taskSha }, acceptance, reviewProfile ?? null, agentId, reviewParent)
    .catch((e) => ({ passed: false, plugins: [] as string[], deniedBy: "capcomd", reasons: [`the judges could not be asked: ${String((e as Error)?.message ?? e).slice(0, 300)}`], reviews: [] })) : null;
  const judged = checksPassed && out.status === "verified" && out.taskSha ? reviewOfJudges(reviewProfile, judges, { taskSha: out.taskSha, ...(out.targetSha ? { targetSha: out.targetSha } : {}) }) : null;
  const review = judged?.review ?? null;
  const reviewStarted = judged?.startedAt ?? null;
  if (review && hooks.listening("verify.changed")) verifyChanged(runId, op, { kind: "judged", by: `reviewer:${review.profile}`, passed: review.passed, reasons: review.reasons });
  const pass = checksPassed && (review ? review.passed : true) && (judges ? judges.passed : true);
  const g = out.timings ?? {};
  const end = Date.now();
  // Where the time went: the checks (fetch, integrate, run), the review (from its start; with the checks when it ran
  // alongside them), and the wait for the target's lock.
  const timings = {
    totalMs: end - t0, checksMs, queueMs: g.lockWaitMs ?? 0,
    ...(g.fetchMs !== undefined ? { fetchMs: g.fetchMs } : {}), ...(g.integrateMs !== undefined ? { integrateMs: g.integrateMs } : {}),
    ...(g.checksMs !== undefined ? { checksRunMs: g.checksMs, checksWhere: g.checksWhere } : {}),
    ...(review && reviewStarted ? { reviewMs: end - reviewStarted, reviewWith: reviewStarted < c0 + checksMs ? "checks" : "after_checks" } : {}),
  };
  // Said plainly: the checks ran on this change put on the target as it is now, the run's earlier merges included.
  const ranChecks = out.status === "verified" || (out.status === "failed" && g.checksMs !== undefined);
  const combinedOn = out.status === "verified" ? (out.targetSha ?? null) : null;
  const none = g.checksWhere === "none";
  const combined: CombinedChecks | null = ranChecks ? await earlierMergesOf(runId, target, { on: combinedOn, before: Date.now() })
    .then((n) => none
      ? { checked: false, passed: null, at: "verify" as const, on: combinedOn, earlierMerges: n, text: `no checks are configured, so nothing ran on the combined code (this change on ${target} as it is now, with ${mergesText(n)})` }
      : { checked: true, passed: checksPassed, at: "verify" as const, on: combinedOn, earlierMerges: n, text: `checks ran on the combined code (this change on ${target} as it is now, with ${mergesText(n)}): ${checksPassed ? "pass" : "fail"}` })
    .catch(() => null) : null;
  const result = {
    pass, branch, target, commit: out.status === "verified" ? (out.taskSha ?? null) : null, ...(alreadyMerged ? { alreadyMerged: true, mergedSha: out.sha } : {}),
    ...(combined ? { combined } : {}),
    // What the checks ran on: the branch put on the target (`sha`, the commit a merge pushes when the target is still `targetSha`).
    ...(out.status === "verified" && out.sha && out.targetSha ? { tested: { sha: out.sha, targetSha: out.targetSha, ...(out.how ? { how: out.how } : {}) } } : {}),
    checks: { passed: checksPassed, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}), output: "output" in out && out.output ? String(out.output).slice(-2000) : null },
    // `judge` mirrors `review` for callers of the old --judge-profile contract.
    ...(review ? { review, judge: { profile: review.profile, passed: review.passed, feedback: (review.error ?? review.reasons.join("; ")).slice(0, 1000) } } : {}),
    ...(judges ? { judges: { passed: judges.passed, plugins: judges.plugins, deniedBy: judges.deniedBy, reasons: judges.reasons } } : {}),
    timings,
  };
  const fin = opView(await s.finishOp({ opId: vfyId, state: pass ? "passed" : "failed", result }));
  if (reviewProfile) stopReviewers(runId, vfyId, alreadyMerged ? "not needed: the work is on the target already" : !checksPassed ? "not needed: the checks failed" : "not needed: the verification ended");
  // A failed check says how on the agent's result too, with the lines of its output that name the failure (the app's card).
  const failedChecks = out.status === "failed" ? { reason: String(out.reason ?? "").slice(0, 300), excerpt: checkExcerpt("output" in out ? String(out.output ?? "") : "") } : {};
  if (agentId) await s.annotateResult({ agentId, patch: { verification: { id: vfyId, pass, commit: result.commit, checks: { passed: checksPassed, status: out.status, ...failedChecks }, ...(review ? { review: { passed: review.passed, agentId: review.agentId } } : {}) } } }).catch(() => {});
  return fin;
}

/** verify.changed (plugin API §6.6.14) for what only the verify knows: its checks' result and each judge's verdict.
 *  `started` and `finished` come from the run's events (src/plugins/changes.ts). */
function verifyChanged(runId: string, op: import("../actors/scope").ScopeOp, change: import("../../packages/plugin/src/hooks").VerifyChange) {
  hooks.fire("verify.changed", "observe", { verification: verificationOf(runId, op), change }, { principal: principalOf(null), entity: `${op.id}#${change.kind === "judged" ? `judged:${change.by}` : change.kind}`, runId, agentId: (op.data.agentId as string | null) ?? null });
}

/** The plugins' judges of a verification (§6.6.13), in order: the first deny fails it, with its reasons (at most 20 of
 *  500 chars, as a reviewer's). Fail-closed: a judge that doesn't answer is a deny (the registry's gate policy). The
 *  reviews the judges reported come back with it. */
async function verifyJudging(runId: string, op: import("../actors/scope").ScopeOp, tested: { sha: string; targetSha: string; commit: string }, acceptance: unknown, reviewer: string | null, agentId: string | null, reviewParent?: string) {
  const a = agentId ? await getAgentOrThrow(runId, agentId).catch(() => null) : null;
  const judges = hooks.order("verify.judging");
  const out = await hooks.fire("verify.judging", "veto", { verification: { ...verificationOf(runId, op), tested }, acceptance, task: a ? untrusted(a.task, a.parent ?? "operator") : null, reviewer },
    { principal: principalOf(reviewParent ?? null, runId), entity: op.id, runId, agentId });
  const reasons = out.decision === "deny" ? (out.reasons.length ? out.reasons : [out.text]).slice(0, 20).map((r) => String(r).slice(0, 500)) : [];
  if (hooks.listening("verify.changed")) {
    for (const by of judges) {
      const denied = out.decision === "deny" && out.plugin === by;
      verifyChanged(runId, op, { kind: "judged", by, passed: !denied, reasons: denied ? reasons : [] });
      if (denied) break;
    }
  }
  return { passed: out.decision !== "deny", plugins: judges, deniedBy: out.decision === "deny" ? (out.plugin ?? "daemon stopping") : null, reasons, reviews: out.reviews ?? [] };
}

/** A verification a verify.starting plugin refused: failed, with the plugin's reason, before anything ran. */
async function refusedVerify(runId: string, op: import("../actors/scope").ScopeOp, out: import("../../packages/plugin/src/host/registry").Refusal) {
  const s = client().scope.getOrCreate([runId]);
  const reason = refusedText(out);
  const result = { pass: false, branch: op.data.branch ?? null, target: op.data.target ?? null, commit: null, checks: { passed: false, status: "refused", reason, output: null }, refused: { plugin: out.plugin, reason: out.text }, timings: { totalMs: 0, checksMs: 0, queueMs: 0 } };
  const fin = opView(await s.finishOp({ opId: op.id, state: "failed", result }));
  if (op.data.reviewProfile) stopReviewers(runId, op.id, "not needed: a plugin refused the verification");
  const agentId = (op.data.agentId as string | null) ?? null;
  if (agentId) await s.annotateResult({ agentId, patch: { verification: { id: op.id, pass: false, commit: null, checks: { passed: false, status: "refused", reason } } } }).catch(() => {});
  return fin;
}

// ── capcomd check <ref> (plugin API §16.1) ──────────────────────────────────────────────────────────

export interface CheckOpts {
  runId: string;
  /** An agent id (its pushed branch) or a branch name; default: the run's target (its goal branch, when it has one). */
  ref?: string;
  /** One of the run's operator-named checks; default: the one pinned to the agent at spawn, else `checks`, else the
   *  repository's test command. */
  check?: string;
  /** A command (the operator's and a driver's checks only; never from an agent's VM). */
  checks?: string;
  /** Mixed into the id: checks a commit again that was checked already with the same command (a flaky check). */
  key?: string;
  /** A check's id (chk-…) to poll: its record, or, while it runs, the run (shared; never a second one). */
  id?: string;
  /** The agent that asked (an in-VM `capcomd check`): its events go on that agent's column. Not a parameter of the check. */
  askedBy?: string;
}

/** A check's id: one per (run, commit, command, key), so identical checks of the same commit share one run and one record. */
export const checkIdFor = (runId: string, sha: string, command: string, key?: string) => `chk-c${paramsHash({ runId, sha, command, key: key ?? null })}`;

/**
 * `capcomd check <ref>`: the run's checks on a ref's commit as it is (the goal branch, the target, a child's branch), in
 * a sandbox as verify's run, with the full output (its last 64 KB) and pass/fail. It integrates, merges and reviews
 * nothing and needs no work of the caller's own, so an orchestrate agent (a planner, a lead) may ask for it from its VM:
 * it is how a router knows the state of the combined code without running anything itself. The commit is the branch's
 * tip when asked; identical checks of one commit (same command, same key) are one: a second call while it runs shares
 * it, one after it ended gets its record. Recorded on the run (check.started, check.passed/failed) and in the trace.
 */
export async function checkRef(o: CheckOpts): Promise<any> {
  return (await startCheck(o)).done;
}

/** A check started (or found: identical ones share): its id at once, and its record when it ends. */
export async function startCheck(o: CheckOpts): Promise<{ id: string; done: Promise<any> }> {
  await assertEngine();
  const s = client().scope.getOrCreate([o.runId]);
  if (o.id && !o.ref) {
    const id = o.id;
    if (!/^chk-[A-Za-z0-9]+$/.test(id)) throw new RelayError("usage", `${id} isn't a check id`, "Pass the chk-… id capcomd check returned.");
    const op = await s.getOp({ opId: id });
    if (!op || op.kind !== "check") throw new RelayError("not_found", `check ${id} not found in ${o.runId}`, "Pass the chk-… id capcomd check returned, or a ref to check.");
    if (op.state !== "running") return { id, done: Promise.resolve(opView(op)) };
    return { id, done: inflightOps.get(id) ?? track(id, () => runCheck(o.runId, op)) };
  }
  const r = await resolveCheck(o);
  const id = checkIdFor(o.runId, r.sha, r.spec, o.key);
  const live = inflightOps.get(id);
  if (live) return { id, done: live };
  return { id, done: track(id, async () => {
    const data = { ref: r.ref, branch: r.branch, sha: r.sha, agentId: r.agentId, ...(r.check !== undefined ? { check: r.check } : {}), checks: r.checks, ...(o.key ? { key: o.key } : {}) };
    // Who asked is kept beside the check, not in its parameters: two agents asking for the same check share it.
    const st = await s.startOp({ opId: id, kind: "check", paramsHash: paramsHash({ sha: r.sha, command: r.spec, key: o.key ?? null }), data: o.askedBy ? { ...data, askedBy: o.askedBy } : data }).catch(asRelay);
    if (st.op.state !== "running") return opView(st.op);
    return runCheck(o.runId, st.op);
  }) };
}

/** What a check is of: the branch and its commit now, and the command (named, given, pinned, or the repository's). */
async function resolveCheck(o: CheckOpts): Promise<{ ref: string; branch: string; sha: string; agentId: string | null; check?: string; checks: string | null; spec: string }> {
  if (o.check !== undefined && o.checks) throw new RelayError("usage", "pass --check NAME or --checks CMD, not both", "--check picks one of the run's operator-named checks.");
  const ref = o.ref?.trim() || (await mergeTargetOf(o.runId));
  let branch = ref, agentId: string | null = null, pinned: string | undefined;
  if (ref.startsWith("agt-")) {
    const a = await getAgentOrThrow(o.runId, ref);
    if ((a.spec as { toolMode?: string } | null)?.toolMode === "orchestrate")
      throw new RelayError("usage", `agent ${ref} is an orchestrate agent: it has no branch of its own`, "Check the branch its helpers' work lands on (capcomd check with no ref checks the run's target), or one of its helpers.", { code: "invalid" });
    const b = a.result?.branch;
    if (typeof b !== "string" || !b) throw new RelayError("conflict", `agent ${ref} has no pushed branch yet (it is ${a.status})`, `Wait with \`capcomd await ${o.runId} ${ref}\`, or check a branch.`);
    branch = b; agentId = ref;
    if (typeof a.contract?.check === "string") pinned = a.contract.check;
  } else if (!BRANCH_NAME.test(ref)) throw new RelayError("usage", `not a branch name: ${JSON.stringify(ref).slice(0, 200)}`, "Pass an agent id (agt-…) or a branch, e.g. capcomd check <runId> main.");
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(o.runId);
  let check = o.check ?? (o.checks ? undefined : pinned);
  // No command named and none configured for the repository, but the run has named checks (the project's
  // `run.checks`): its one check is the run's checks; with several, the caller picks one (never "nothing ran: pass").
  if (check === undefined && !o.checks && cfg && !cfg.testCommand.trim()) {
    const names = await namedCheckNames(o.runId);
    if (names.length === 1) check = names[0]!;
    else if (names.length > 1) throw new RelayError("usage", `this run has ${names.length} named checks and no default one: name the one to run`, `Pass --check NAME (check: in the tool): ${names.join(", ")}.`);
  }
  const checks = check !== undefined ? await namedCheck(o.runId, check) : o.checks ?? null;
  let sha = "";
  if (cfg) {
    const heads = await (await import("../merge/repo")).remoteHeads(cfg, [branch])
      .catch((e) => { throw new RelayError("conflict", `couldn't read ${branch} on ${cfg.remote}: ${String((e as Error)?.message ?? e).slice(0, 300)}`, "Try again in a moment.", { code: "unavailable", retryable: true }); });
    sha = heads[branch] ?? "";
    if (!sha) throw new RelayError("not_found", `branch ${branch} isn't on ${cfg.remote}`, "Pass a branch the run's repository has (capcomd fetch lists them), or an agent id.");
  }
  return { ref, branch, sha, agentId, ...(check !== undefined ? { check } : {}), checks, spec: check !== undefined ? `check:${check}` : checks !== null ? `cmd:${checks}` : "repo" };
}

/** Run (or rejoin: the verifier actor runs each check once in the engine) a recorded check, and record how it went. */
async function runCheck(runId: string, op: import("../actors/scope").ScopeOp) {
  const t0 = Date.now();
  const s = client().scope.getOrCreate([runId]);
  const d = op.data as { ref: string; branch: string; sha: string; agentId: string | null; checks: string | null };
  const res = await client().verifier.getOrCreate([runId, op.id]).check({ checkId: op.id, runId, branch: d.branch, sha: d.sha, ...(d.checks ? { testCommand: d.checks } : {}) }) as import("../actors/verifier").CheckResult;
  const o = res.outcome;
  const ran = o.status === "passed" || o.status === "failed";
  const pass = o.status === "passed";
  const where = ran ? o.where : null;
  const reason = o.status === "failed" ? (o.stage === "setup" ? "checks couldn't run: setting up the checks sandbox failed (not the code's tests)" : o.stage === "deps" ? "installing dependencies failed" : "the checks failed")
    : "reason" in o ? o.reason : null;
  const at = `${d.branch}${d.sha ? ` at ${d.sha.slice(0, 12)}` : ""}`;
  // What's on it from this run: its merges into that branch up to that commit (the combined code).
  const merges = d.sha ? await earlierMergesOf(runId, d.branch, { on: d.sha }).catch(() => 0) : 0;
  const withMerges = merges ? ` (with ${merges} merge${merges === 1 ? "" : "s"} from this run)` : "";
  const text = !ran ? `the checks didn't run on ${at}: ${reason}`
    : where === "none" ? `no checks are configured, so nothing ran on ${at}${withMerges}`
    : where === "reused" ? `${at}${withMerges} is a tree that already passed these checks in this run: pass`
    : `checks ran on ${at}${withMerges}: ${pass ? "pass" : `fail (${reason})`}`;
  const result = {
    pass, ref: d.ref, branch: d.branch, commit: d.sha, mergesOn: merges, text,
    checks: { passed: pass, status: o.status, ...(where ? { where } : {}), ...(ran && o.command ? { command: o.command } : {}), ...(reason ? { reason } : {}), output: ran ? o.output : null },
    timings: { totalMs: Date.now() - t0, slotWaitMs: res.slotWaitMs, fetchMs: o.fetchMs, ...(ran ? { checksMs: o.checksMs } : {}) },
  };
  return opView(await s.finishOp({ opId: op.id, state: pass ? "passed" : "failed", result }));
}

export interface MergeOpts {
  runId: string; ref: string; require?: string; target?: string; operator?: boolean; key?: string;
  /** The merge's id (mrg-…): an existing one is polled (its record, or its run until it ends); a new one (with ref and
   *  require) is started under this id. Without it, the id comes from the key (a random one without a key). */
  id?: string;
  /** In-VM merges: a protected target parks the merge for `capcomd approve <runId> <mrgId>` instead of refusing. */
  requestApproval?: boolean;
  /** The agent that asked for the merge (in-VM merges): it waits on the decision, so the approval shows on its column. */
  askedBy?: string;
}

/** The merge target a call means: its own, else the run's, else the repository's, else "main" (a dry run's label). */
async function mergeTargetOf(runId: string, target?: string): Promise<string> {
  if (target) return target;
  const runEnv = await (await import("../merge/run-config")).runEnv(runId);
  return (await runTarget(runId)) ?? (await import("../merge/config")).loadMergeConfig(runEnv)?.target ?? "main";
}

/** The id a merge call gets: from its key (random without one). */
export async function mergeIdFor(runId: string, ref: string, key?: string, target?: string): Promise<string> {
  return stableId("mrg", `${runId}\0${ref}\0${await mergeTargetOf(runId, target)}`, key);
}

/** Land a ref. Requires a passing vfy for that exact commit and target, unless --operator. Idempotent by id, like verifyRef. */
export async function mergeRef(o: MergeOpts) {
  const id = o.id ?? (await mergeIdFor(o.runId, o.ref, o.key, o.target));
  if (!/^mrg-[A-Za-z0-9]+$/.test(id)) throw new RelayError("usage", `${id} isn't a merge id`, "Pass the mrg-… id capcomd merge returned.");
  const given = { ref: o.ref || undefined, require: o.require, target: o.target, operator: o.operator || undefined };
  const live = inflightOps.get(id);
  if (live) { const op = await client().scope.getOrCreate([o.runId]).getOp({ opId: id }); if (op) assertSameOp(id, op, given); return live; }
  return track(id, async () => {
    await assertEngine();
    const op = await client().scope.getOrCreate([o.runId]).getOp({ opId: id });
    if (op) {
      if (op.kind !== "merge") throw new RelayError("not_found", `${id} is a ${op.kind}, not a merge`, "Pass the mrg-… id capcomd merge returned.");
      assertSameOp(id, op, given);
      return op.state === "running" ? executeMerge(o.runId, op) : opView(op);
    }
    if (!o.ref) throw new RelayError("not_found", `merge ${id} not found in ${o.runId}`, "Pass the mrg-… id capcomd merge returned, or a ref and require to start one.");
    return startMerge(o, id);
  });
}

async function startMerge(o: MergeOpts, mrgId: string) {
  const c = client();
  const s = c.scope.getOrCreate([o.runId]);
  const { isProtectedBranch } = await import("../utils/protected");
  const RC = await import("../merge/run-config");
  const runEnv = await RC.runEnv(o.runId);
  const cfg = (await import("../merge/config")).loadMergeConfig(runEnv);
  // No repository (cfg null) is a dry run: "main" only labels it, nothing is merged anywhere.
  const target = o.target ?? (await runTarget(o.runId)) ?? cfg?.target ?? "main";
  const goal = onGoal(await runGoal(o.runId), target);
  const { branch, agentId } = await resolveRef(o.runId, o.ref);
  let expectSha: string | undefined;
  if (!o.require && !o.operator) throw new RelayError("usage", "merge needs --require <vfyId> (a passing `capcomd verify` of this ref)", "Run `capcomd verify <runId> --ref <ref>` first, or pass --operator to merge unverified.");
  if (o.require) {
    const v = await s.getOp({ opId: o.require });
    if (!v || v.kind !== "verify") throw new RelayError("not_found", `verification ${o.require} not found in ${o.runId}`, "Pass the id `capcomd verify` returned.");
    if (v.state !== "passed") throw new RelayError("conflict", `verification ${o.require} is ${v.state}`, "Only a passing verification can gate a merge.");
    if (v.data.branch !== branch || v.data.target !== target) throw new RelayError("conflict", `verification ${o.require} covers ${v.data.branch} → ${v.data.target}, not ${branch} → ${target}`, "Verify this ref against this target.");
    expectSha = (v.result?.commit as string | null) ?? undefined;
  }
  // No repo configured (fake merges, like the legacy loop without CAPCOMD_REPO): nothing to protect.
  // The run's goal branch takes reviewed work with no human step: the person decides once, on the pull request into the
  // base, when the planner is done (it can't be a protected branch: `run new` refuses that).
  const needsApproval = !!cfg && !goal && isProtectedBranch(target, runEnv) && !o.operator;
  if (needsApproval && !o.requestApproval) throw new RelayError("conflict", `target ${target} is protected`, "Protected targets need an operator: pass --operator (or use `capcomd run` + `capcomd approve`).");
  const data = { ref: o.ref, agentId, branch, target, require: o.require ?? null, operator: !!o.operator, expectSha: expectSha ?? null, ...(needsApproval ? { approval: true } : {}) };
  // Who asked is not a parameter of the merge: a retry by another caller is the same merge.
  const st = await s.startOp({ opId: mrgId, kind: "merge", paramsHash: paramsHash(data), data: o.askedBy ? { ...data, askedBy: o.askedBy } : data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  if (needsApproval) {
    // The person deciding sees what lands: the files the verified commit changes (best effort, never blocks the park).
    const diff = await (await import("../api/run-files")).approvalDiff({ remote: cfg!.remote, target, workdir: cfg!.workdir }, { agentId, sha: expectSha ?? null, branch }).catch(() => null);
    return opView(await s.parkOp({ opId: mrgId, reason: `target ${target} is protected`, ...(diff ? { diff } : {}) }));
  }
  return executeMerge(o.runId, st.op);
}

/** The files a held merge's verified commit changes against where its branch left the target (the approval's
 *  subject.files), as startMerge reads them for a protected target's park. Null without a repository or a commit. */
async function heldMergeDiff(runId: string, d: { agentId?: string | null; branch: string; target: string; expectSha: string | null }) {
  const cfg = (await import("../merge/config")).loadMergeConfig(await (await import("../merge/run-config")).runEnv(runId));
  if (!cfg) return null;
  return (await import("../api/run-files")).approvalDiff({ remote: cfg.remote, target: d.target, workdir: cfg.workdir }, { agentId: d.agentId ?? null, sha: d.expectSha, branch: d.branch });
}

async function dropCheckpoints(runId: string, agentId: string) {
  const cfg = (await import("../merge/config")).loadMergeConfig(await (await import("../merge/run-config")).runEnv(runId));
  if (cfg) await (await import("../merge/repo")).deleteRemoteRef(cfg, checkpointRef(agentId));
}

/** Cleanups started after a merge was recorded (a remote round trip each), off the merge's path. */
const cleanups = new Set<Promise<unknown>>();
/** Wait (at most `ms`) for the cleanups this process started: a CLI that exits right after a merge calls it. */
export async function settleCleanups(ms = 30_000) {
  if (cleanups.size) await Promise.race([Promise.allSettled([...cleanups]), sleep(ms)]);
}

/** Run a recorded merge op: land its ref (only the verified commit; the fast path when the target hasn't moved since
 *  the verify, else re-running the checks verify passed with). */
async function executeMerge(runId: string, op: import("../actors/scope").ScopeOp) {
  const t0 = Date.now();
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const d = op.data as { ref: string; agentId?: string | null; branch: string; target: string; require: string | null; expectSha: string | null; operator?: boolean; askedBy?: string; heldBy?: PluginHold; approvedHolds?: PluginHold[]; diff?: unknown };
  const { label } = await resolveRef(runId, d.ref);
  // Re-run the checks that verification passed with (the target may have moved), not the repo default.
  const v = d.require ? await s.getOp({ opId: d.require }) : null;
  const checks = typeof v?.data.checks === "string" && v.data.checks ? (v.data.checks as string) : undefined;
  // What the verification tested, for the exact commit this merge lands: pushed as it is while the target hasn't moved.
  const tested = v?.result?.tested as { sha?: string; targetSha?: string; how?: string } | undefined;
  const verified = d.expectSha && v?.result?.commit === d.expectSha && tested?.sha && tested.targetSha ? { sha: tested.sha, targetSha: tested.targetSha, ...(tested.how ? { how: tested.how } : {}) } : undefined;
  const direct = onGoal(await runGoal(runId), d.target);
  // What merge.landing's plugins are asked, where the merge runs (the engine host): this process can't tell whether one
  // listens there, so it always says. A running merge with a plugin's hold on record is one a person approved after that
  // hold (decideOp): that hold, and the ones approved before it, no longer stop it; any other plugin's still does. Each
  // approved hold makes the next landing a new attempt (its own idempotency key, §6.7); a replay of one keeps its key.
  // The approval put that hold on the record's `approvedHolds` already (decideOp); a merge approved before it did, not.
  const prior = d.approvedHolds ?? [];
  const approvedHolds = [...prior, ...(d.heldBy && !prior.some((h) => sameHold(h, { ...d.heldBy!, text: d.heldBy!.reason })) ? [d.heldBy] : [])];
  const gate: import("../merge/types").MergeGate = {
    merge: mergeOf(runId, op), verification: v ? verificationOf(runId, v) : null, operator: !!d.operator, requestedBy: principalOf(d.askedBy ?? null, runId),
    attempt: approvedHolds.length + 1, ...(approvedHolds.length ? { approvedHolds } : {}),
  };
  const res: any = await c.verifier.getOrCreate([runId, op.id]).verify({
    verifierId: op.id, taskId: label, branch: d.branch, runId, target: d.target, testOnly: false, ...(d.expectSha ? { expectSha: d.expectSha } : {}), ...(checks ? { testCommand: checks } : {}), ...(direct ? { mode: "direct" as const } : {}),
    ...(verified ? { verified } : {}), gate,
  });
  const out = res.outcome as import("../merge/types").MergeOutcome;
  // A plugin held it: parked for a person's approval, as a protected target's merge is. The hold is kept on the merge,
  // so the approval shows the plugin's reason and only an approval of this hold satisfies it. The person sees what
  // lands, as for a protected target: the files the verified commit changes, read now unless an earlier park read them
  // (best effort, never blocks the park).
  if (out.status === "failed" && out.held) {
    const heldBy: PluginHold = { plugin: out.held.plugin, reason: out.reason, ...(out.held.holdId !== undefined ? { holdId: out.held.holdId } : {}) };
    const diff = d.diff ? null : await heldMergeDiff(runId, d).catch(() => null);
    return opView(await s.parkOp({ opId: op.id, reason: `held by the ${heldBy.plugin} plugin: ${heldBy.reason}`, heldBy, approvedHolds, ...(diff ? { diff } : {}) }));
  }
  const merged = out.status === "merged";
  const g = out.timings ?? {};
  const timings = { totalMs: Date.now() - t0, queueMs: g.lockWaitMs ?? 0, ...Object.fromEntries(Object.entries(g).filter(([k]) => k !== "lockWaitMs")) };
  const combined = await combinedOfMerge(runId, op, d.target, out, (v?.result?.timings as { checksWhere?: string } | undefined)?.checksWhere);
  const result = merged
    ? { merged: true, sha: out.sha, how: out.how, already: out.already, mode: out.mode, ...(out.pr ? { pr: out.pr } : {}), ...(out.targetBefore ? { targetBefore: out.targetBefore } : {}), ...(out.bypassedVetoes?.length ? { bypassedVetoes: out.bypassedVetoes } : {}), ...(combined ? { combined } : {}), timings }
    : { merged: false, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}), ...(combined ? { combined } : {}), timings };
  const fin = opView(await s.finishOp({ opId: op.id, state: merged ? "merged" : "failed", result }));
  if (d.agentId) await s.annotateResult({ agentId: d.agentId, patch: { merge: { id: op.id, target: d.target, state: merged ? "merged" : "failed", ...(merged ? { sha: out.sha, ...(out.pr ? { pr: out.pr } : {}) } : { status: out.status }) } } }).catch(() => {});
  // Its checkpoints were only for continuing the work, which has landed now: deleted after the record, off its path
  // (a remote round trip), best effort.
  if (merged && d.agentId) {
    const p: Promise<unknown> = dropCheckpoints(runId, d.agentId).catch(() => {}).finally(() => cleanups.delete(p));
    cleanups.add(p);
  }
  return fin;
}

/**
 * Whether a verify's or a merge's checks ran on the combined code, said plainly (`result.combined`, additive): the
 * change put on the target as it was then, with the run's earlier merges into that target already on it. Every merge
 * that lands in direct mode lands a tree that passed: the one its verify checked (the fast path: the target hadn't
 * moved), or the change put on the target again and checked again (the full path).
 */
export interface CombinedChecks {
  /** The checks ran on this change combined with the target (false: nothing new was checked, e.g. already merged). */
  checked: boolean;
  passed: boolean | null;
  /** When they ran: at the verify (a fast-path merge lands that very tree) or at the merge. */
  at: "verify" | "merge";
  /** The target commit the change was put on, when known. */
  on: string | null;
  /** The run's merges into this target already on `on` (or, without it, merged before this one). */
  earlierMerges: number;
  text: string;
}

/** How many of the run's merges into `target` the commit `on` holds (the merges landed up to it), else all merged before `before`. */
async function earlierMergesOf(runId: string, target: string, o: { on?: string | null; before?: number; except?: string }): Promise<number> {
  const ops = (await client().scope.getOrCreate([runId]).listOps({ kind: "merge", state: "merged" }) as import("../actors/scope").ScopeOp[])
    .filter((m) => m.id !== o.except && m.data.target === target && m.result?.merged && !m.result.already && typeof m.result.sha === "string")
    .sort((a, b) => a.updatedAt - b.updatedAt);
  const at = o.on ? ops.findIndex((m) => m.result!.sha === o.on) : -1;
  if (at >= 0) return at + 1;
  return o.before !== undefined ? ops.filter((m) => m.updatedAt <= o.before!).length : 0;
}
const mergesText = (n: number) => `${n} earlier merge${n === 1 ? "" : "s"} from this run`;

async function combinedOfMerge(runId: string, op: import("../actors/scope").ScopeOp, target: string, out: import("../merge/types").MergeOutcome, verifiedWhere?: string): Promise<CombinedChecks | null> {
  const g = out.timings ?? {};
  try {
    if (out.status === "merged") {
      if (out.already) return { checked: false, passed: null, at: "merge", on: null, earlierMerges: await earlierMergesOf(runId, target, { before: Date.now(), except: op.id }), text: `already on ${target}: nothing new landed, so no checks ran` };
      const on = out.targetBefore ?? null;
      const n = await earlierMergesOf(runId, target, { on, before: op.createdAt, except: op.id });
      // No check command configured: nothing ran, on any tree.
      if ((g.path === "fast" ? verifiedWhere : g.checksWhere) === "none") return { checked: false, passed: null, at: g.path === "fast" ? "verify" : "merge", on, earlierMerges: n, text: `no checks are configured, so nothing ran on the combined code (this change on ${target} with ${mergesText(n)})` };
      if (g.path === "fast") return { checked: true, passed: true, at: "verify", on, earlierMerges: n, text: `checks ran on the combined code (this change on ${target} with ${mergesText(n)}) at its verify, and ${target} hadn't moved since, so what landed is the tree that passed: pass` };
      if (g.checksWhere === "reused") return { checked: true, passed: true, at: "merge", on, earlierMerges: n, text: `the combined code (this change on ${target} with ${mergesText(n)}) is a tree that already passed the checks: pass` };
      if (g.checksMs !== undefined) return { checked: true, passed: true, at: "merge", on, earlierMerges: n, text: `checks ran on the combined code (this change on ${target} with ${mergesText(n)}): pass` };
      return null;
    }
    const n = await earlierMergesOf(runId, target, { before: Date.now(), except: op.id });
    if (out.status === "conflict") return { checked: false, passed: null, at: "merge", on: out.targetSha || null, earlierMerges: n, text: `this change doesn't combine with ${target} (${mergesText(n)}): conflicts in ${out.files.slice(0, 5).join(", ")}; no checks ran` };
    if (out.status === "failed" && g.checksMs !== undefined && g.pushMs === undefined && !out.held) return { checked: true, passed: false, at: "merge", on: null, earlierMerges: n, text: `checks ran on the combined code (this change on ${target} with ${mergesText(n)}): fail` };
  } catch { /* best effort: the merge's record stands without it */ }
  return null;
}

/** The last lines of a check's output that name the failure ("expected …", "1 fail"), at most 3 of 160 characters, or else
 *  its last 3 lines. Untrusted: it is the checked code's own output. */
export function checkExcerpt(output: string): string | null {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").split(/\r?\n/).map((l) => l.trimEnd()).filter((l) => l.trim());
  if (!lines.length) return null;
  const named = lines.filter((l) => /\b(fail(s|ed|ure|ing)?|error|expected|received|assert(ion)?)\b|✗|×/i.test(l));
  return (named.length ? named : lines).slice(-3).map((l) => (l.length > 160 ? `${l.slice(0, 159)}…` : l)).join("\n");
}

/**
 * The operator's decision on a merge an agent parked (protected target): approve runs it now, with the
 * same gate (the verified commit only); deny fails it. Idempotent: a decided merge returns its record.
 */
export async function decideMerge(runId: string, mrgId: string, o: { approve: boolean; by?: string; reason?: string }) {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const op = await s.getOp({ opId: mrgId });
  if (!op || op.kind !== "merge") throw new RelayError("not_found", `merge ${mrgId} not found in ${runId}`, `List pending merges with \`capcomd status ${runId} --json\` (pendingApprovals).`);
  if (op.state !== "awaiting_approval" && op.state !== "running") return opView(op);
  // approval.deciding (plugin API §6.6.17): a plugin may refuse the decision (a second approver, a four-eyes rule); it
  // can never make one.
  if (op.state === "awaiting_approval" && hooks.listening("approval.deciding")) {
    const { approvalIdFor } = await import("../api/source");
    const by = o.by ?? "operator";
    const out = await hooks.fire("approval.deciding", "veto", { approval: approvalOf(runId, op, approvalIdFor(runId, mrgId)), decision: o.approve ? "approve" : "deny", by: principalOf(by, runId), reason: o.reason ?? null },
      { principal: principalOf(by, runId), entity: mrgId, runId, agentId: (op.data.agentId as string | null) ?? null });
    if (out.decision === "deny") throw refusedError("approval.deciding", out);
  }
  const { decided, op: now } = await s.decideOp({ opId: mrgId, approve: o.approve, by: o.by ?? "operator", ...(o.reason ? { reason: o.reason } : {}) });
  // Approved (now, or by an earlier call that crashed before merging): run it.
  if (o.approve && now.state === "running") return inflightOps.get(mrgId) ?? track(mrgId, () => executeMerge(runId, now));
  if (!decided && now.state === "running") throw new RelayError("conflict", `${mrgId} is already merging`, "Wait for it, then check its state.");
  // Denied after a plugin held it: the verifier left its record in flight for the approved re-run, which won't come.
  if (decided && !o.approve && op.data.heldBy) await settleHeldMerge(runId, mrgId, o.reason).catch((e) => console.error(`capcomd: ${mrgId}: settling the held merge's record: ${(e as Error)?.message ?? e}`));
  if (decided && !o.approve && typeof op.data.agentId === "string")
    await s.annotateResult({ agentId: op.data.agentId, patch: { merge: { id: mrgId, target: op.data.target ?? null, state: "denied" } } }).catch(() => {});
  return opView(now);
}

async function settleHeldMerge(runId: string, mrgId: string, reason?: string) {
  const v = await existingActor("verifier", [runId, mrgId]);
  await v?.settleHeld({ verifierId: mrgId, reason: reason ? `denied: ${reason}` : "denied" });
}

/** Merges parked for approval in a run, oldest first. */
export async function pendingMerges(runId: string) {
  // A read: a run without a scope on this engine has none pending (never create its scope to ask).
  const ops = (await existingActor("scope", [runId]).then((s) => s?.listOps({ state: "awaiting_approval", kind: "merge" }) ?? []).catch(() => [])) as import("../actors/scope").ScopeOp[];
  return ops.map((op) => ({ taskId: op.id, kind: "merge" as const, targetBranch: (op.data.target as string) ?? null, since: new Date(op.updatedAt).toISOString(), ref: op.data.ref as string }));
}

function opView(op: import("../actors/scope").ScopeOp) {
  return { id: op.id, kind: op.kind, state: op.state, ...op.data, result: op.result };
}
