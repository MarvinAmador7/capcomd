import { isBoxdAuthError } from "../providers/boxd-errors";
import { redactShapes } from "../agents/redact";
import { resolveEnvSnapshot } from "../env/resolve";
// ADR-016 step 1: run new / spawn / await / wait-any / cancel, on top of the existing worker
// actor. The CLI is a thin client; durable state lives in the scope actor (agent tree, keys,
// events) and the worker actor (VM, agent run, push). A driver process advances one agent;
// it holds a renewable lease, so a crashed driver is taken over by the next await/wait-any.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { client, assertEngine, cancelRun, existingActor } from "../core/relay";
import { RelayError } from "../core/errors";
import { agentsFilePath, encodeAgentRef, resolveAgent, AgentConfigError, type Overrides } from "../agents/profiles";
import { agentEffort, agentModel, isRealAgent } from "../agents/config";
import { available, treeSpend, paramsHash, parseBudget, parseGrant, stableId, TERMINAL_AGENT, type Budget, type Grant } from "./policy";
import { noticeOf, treeView, rollups, subtree } from "../subagents/results";
import { checkpointRef, stoppedAt } from "../agents/runner";
import type { ScopeAgent } from "../actors/scope";
import type { AttachedSkill } from "../agents/skills";
import { runScripted, ScriptFailed, withVmRpc } from "../subagents/driver";
import { killpoint } from "../utils/killpoint";
import { captureDriveEnv, env } from "../utils/env";
import { parseVerdict, reviewBrief } from "./review";
import { agentSpanId, discardSpan, rootSpanIdForRun, withSpan } from "../utils/tracing-simple";
import { stateDir } from "../utils/home";
import { clearQuota, loginOf, quotaRetryMs, quotaUntil, recordQuota } from "./quota";
import { startDriver } from "./drivers";
import { engineDrivesAgents } from "../utils/agent-workflow-flag";
import { realSandbox, sandboxCaps, sandboxName } from "../providers/registry";
import { OPEN_EGRESS } from "../providers/sandbox";
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
  throw e;
}

/** Operator-named checks (`run new --checks-set name=CMD`) live here; VMs can read `_` keys, never write them. */
export const CHECKS_KV = "_checks";
/** The run's reviewer profile (`run new --reviewer P`): every verify of the run is also reviewed by it. */
export const REVIEWER_KV = "_reviewer";
/** The run's merge target (`run new --target T`): the default for every verify and merge in the run. */
export const TARGET_KV = "_target";
/** Where the run's spans are written (CAPCOMD_TRACE_DIR when the run was created), for readers in other shells. */
export const TRACE_KV = "_trace";

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

const BRANCH_NAME = /^(?!-)(?!.*\.\.)(?!.*\/\/)[A-Za-z0-9._\/-]{1,200}(?<![./])$/;
/** Create `branch` on the remote from `from` if it doesn't exist yet (a per-run staging branch). */
async function ensureBranch(runId: string, branch: string, from: string): Promise<{ created: boolean }> {
  const { loadMergeConfig } = await import("../merge/config");
  const cfg = loadMergeConfig();
  if (!cfg) throw new RelayError("config", "--target-from needs a repository (CAPCOMD_REPO)", "Set CAPCOMD_REPO, or create the branch yourself and pass only --target.");
  const { openClone } = await import("../merge/repo");
  const git = await openClone(cfg, `${runId}-setup`);
  if (await git.revParse(`refs/remotes/origin/${branch}`)) return { created: false };
  const base = await git.revParse(`refs/remotes/origin/${from}`);
  if (!base) throw new RelayError("not_found", `--target-from ${from}: branch not found on ${cfg.remote}`, "Name an existing branch to cut the target from.");
  const push = await git.run(["push", "--porcelain", "origin", `${base}:refs/heads/${branch}`]);
  if (push.code !== 0 && !(await git.ok(["ls-remote", "--heads", "origin", branch]).catch(() => ""))) throw new RelayError("conflict", `could not create ${branch}: ${(push.stdout + push.stderr).trim().slice(-300)}`, "Check push access to the repository.");
  return { created: true };
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

export interface RunNewOpts { budget: Budget; label?: string; goal?: string; key?: string; runId?: string; checks?: Record<string, string>; reviewer?: string; target?: string; targetFrom?: string;
  /** The run's own sandbox (`capcomd run --sandbox`): its agents and checks run there, not on the daemon's CAPCOMD_SANDBOX. */
  sandbox?: string }
export async function runNew(o: RunNewOpts) {
  await assertEngine();
  const runId = o.runId ?? stableId("run", "run", o.key);
  const c = client();
  const hasChecks = !!o.checks && Object.keys(o.checks).length > 0;
  if (o.reviewer) reviewerSpec(o.reviewer); // unknown profiles are refused here, not at verify time
  if (o.target !== undefined && !BRANCH_NAME.test(o.target)) throw new RelayError("usage", `bad --target ${JSON.stringify(o.target)}`, "Name a branch, e.g. --target capcomd/integration.");
  if (o.targetFrom !== undefined && o.target === undefined) throw new RelayError("usage", "--target-from needs --target", "Pass the branch to create: --target T --target-from main.");
  const ph = paramsHash({ budget: o.budget, label: o.label ?? null, ...(hasChecks ? { checks: o.checks } : {}), ...(o.reviewer ? { reviewer: o.reviewer } : {}), ...(o.target ? { target: o.target } : {}), ...(o.sandbox ? { sandbox: o.sandbox } : {}) });
  const res = await c.scope.getOrCreate([runId]).init({ runId, budget: o.budget, label: o.label, ...(o.goal ? { goal: o.goal } : {}), paramsHash: ph }).catch(asRelay);
  // The run carries its repository settings, so the engine (e.g. a background service) needn't have them.
  const { repoEnvOf, RUN_REPO_KV } = await import("../merge/run-config");
  const repoEnv = repoEnvOf(process.env);
  if (Object.keys(repoEnv).length) await (await import("./state")).kvWrite(runId, { k: RUN_REPO_KV, value: repoEnv, writer: "operator" }).catch(() => {});
  // The run's place (when it has its own) and that provider's settings as they are now (ADR-021 §2): a run keeps the
  // idle machine lifetime it started with. A retry keeps the settings the first call recorded.
  {
    const RS = await import("../providers/run-sandbox");
    const prior = await c.scope.getOrCreate([runId]).kvGet({ k: RS.RUN_SANDBOX_KV }).catch(() => null) as { value?: unknown; deleted?: boolean } | null;
    const had = prior && !prior.deleted ? RS.parseRunSandbox(prior.value) : null;
    let place: string = o.sandbox ?? "fake";
    if (!o.sandbox) { try { place = (await import("../providers/registry")).sandboxName(); } catch { /* unknown CAPCOMD_SANDBOX: the default lifetime */ } }
    const settings = had?.settings.idleLifetime !== undefined ? { idleLifetime: had.settings.idleLifetime } : (await import("../providers/settings")).settingsForRun(place);
    const value = RS.runSandboxValue(o.sandbox, settings);
    // Unchanged on a retry: not written again. A run on the daemon's own place still starts if this write fails
    // (its machines then get the place's setting when they start); a run with its own place doesn't.
    if (!prior || prior.deleted || JSON.stringify(prior.value) !== JSON.stringify(value)) {
      const put = (await import("./state")).kvWrite(runId, { k: RS.RUN_SANDBOX_KV, value, writer: "operator" });
      await (o.sandbox ? put : put.catch(() => {}));
    }
  }
  // Written on every (idempotent) call, so a crash between init and this put heals on retry.
  if (hasChecks) await (await import("./state")).kvWrite(runId, { k: CHECKS_KV, value: o.checks, writer: "operator" });
  if (o.reviewer) await (await import("./state")).kvWrite(runId, { k: REVIEWER_KV, value: { profile: o.reviewer }, writer: "operator" });
  if (o.target) {
    if (o.targetFrom) await ensureBranch(runId, o.target, o.targetFrom);
    await (await import("./state")).kvWrite(runId, { k: TARGET_KV, value: { branch: o.target }, writer: "operator" });
  }
  if (res.created) await (await import("./state")).kvWrite(runId, { k: TRACE_KV, value: { dir: (await import("../utils/tracing-simple")).traceDir() }, writer: "operator" }).catch(() => {});
  if (res.created) recordRun({ runId, label: o.label ?? null, repo: repoEnv.CAPCOMD_REPO ?? null, cwd: process.cwd(), createdAt: Date.now() });
  // The run actor gives the scope a USD ledger, `capcomd status` and the run event log.
  await c.run.getOrCreate([runId]).createRun({ runId, goal: o.label ?? "(primitives scope)", maxCost: o.budget.usd ?? 0 });
  return { runId, created: res.created, budget: res.budget };
}

/**
 * Runs this machine created, newest last (one JSON line each), so a later session can find them: `capcomd_runs`, and the
 * daemon's run list. CAPCOMD_RUNS_INDEX names another file (the live e2e scripts keep their runs out of the user's list).
 */
export const runsIndexPath = () => env("RUNS_INDEX") || join(stateDir(), "runs.jsonl");
function recordRun(r: { runId: string; label: string | null; repo: string | null; cwd: string; createdAt: number }) {
  try { const p = runsIndexPath(); mkdirSync(dirname(p), { recursive: true }); appendFileSync(p, JSON.stringify(r) + "\n"); } catch { /* an index, not state */ }
}
export function recentRuns(limit = 20): Array<{ runId: string; label: string | null; repo: string | null; cwd: string; createdAt: number }> {
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
}
/**
 * What spawning `ref` (a profile, or an encoded ref with overrides) checks before anything is recorded: the profile
 * resolves, its CLI has an env snapshot on `source`'s sandbox, and the sandbox can enforce its egress. `capcomd run`
 * asks the same of its planner before it starts the run, so a run that can't start is refused, not left started.
 */
export function spawnChecks(ref: string | null, source: Record<string, string | undefined> = process.env) {
  let resolved;
  try { resolved = resolveAgent(ref); } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", e.message, "Check the profile with `capcomd agents show <name>`; overrides may only narrow unless --operator.");
    throw e;
  }
  const spec = resolved.spec ? (resolved.spec as unknown as Record<string, unknown>) : null;
  const envProblem = envSnapshotProblem(spec?.provider, source);
  if (envProblem) throw new RelayError("config", envProblem, "Run `capcomd env build` (idempotent; skips the VM when the snapshot is current), then retry the spawn.");
  // A profile that limits egress must get that limit, not an open network (ADR-020: Docker has no allowlist).
  const egress = spec?.egress as string[] | undefined;
  if (egress?.length && !egress.includes(OPEN_EGRESS) && realSandbox(source) && !sandboxCaps(source).egressAllowlist)
    throw new RelayError("config", `profile ${resolved.name} limits egress (${egress.join(", ")}), and the ${sandboxName(source)} sandbox can't enforce an egress allowlist`, "Remove the profile's egress (agents get open egress by default), or use a provider that enforces it (boxd).");
  return { resolved, spec };
}

export async function spawnAgent(o: SpawnOpts) {
  await assertEngine();
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
  const { resolved, spec } = spawnChecks(ref, await (await import("../providers/run-sandbox")).runSandboxEnv(o.runId));
  // Requested budget: the contract's `budget` ({usd, turns, wallSeconds}), then --budget per unit.
  let requested: Budget;
  try { requested = { ...parseBudget(o.contract?.budget), ...(o.budget ?? {}) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Budget units: usd, turns, wallSeconds (e.g. --budget usd=2,turns=40)."); }
  let grant: Grant;
  try { grant = { ...parseGrant(o.contract?.children), ...parseGrant(o.grant) }; } catch (e) { throw new RelayError("usage", (e as Error).message, "Grant fan-out with --children.maxChildren=N, --children.maxDepth=N, --children.maxTotalDescendants=N, --children.allowedChildProfiles=a,b, --children.budgetShare=0.5 (each may only narrow the ceiling)."); }
  const hasGrant = Object.keys(grant).length > 0;
  // Recorded with the agent (agent.spawned, harness.v1 Agent.model): the model it runs with, as the worker decides it
  // (loadAgentConfig: CAPCOMD_AGENT_MODEL, else the profile's). A fake agent runs no model.
  const model = isRealAgent(resolved.kind) ? agentModel(resolved.spec) : undefined;
  const effort = isRealAgent(resolved.kind) ? agentEffort(resolved.spec) : undefined;
  const ph = paramsHash({ parent: o.parent ?? null, ref, task: o.task, contract: o.contract ?? null, budget: requested, operator: !!o.operator, ...(hasGrant ? { grant } : {}), ...(o.review ? { review: true } : {}) });
  const res = await client().scope.getOrCreate([o.runId]).spawn({
    runId: o.runId, agentId, key: o.key, paramsHash: ph, parent: o.parent ?? null,
    profile: resolved.name, ref: ref ?? resolved.name, spec: { ...(spec ?? {}), kind: resolved.kind, ...(model ? { model } : {}), ...(effort ? { effort } : {}) },
    task: o.task, contract: o.contract ?? null, ...(Object.keys(requested).length ? { budget: requested } : {}), operator: o.operator,
    ...(hasGrant ? { grant } : {}), ...(o.review ? { review: true } : {}),
    // ADR-022: how this shell (or the parent's driver) drives agents travels with the agent, for the engine to use.
    // The agents file the driver would have resolved its children's profiles from (this shell's, or the project's).
    driveEnv: { ...captureDriveEnv(), CAPCOMD_AGENTS_FILE: resolve(agentsFilePath()) },
  }).catch(asRelay);
  if (o.start !== false && !TERMINAL_AGENT.has(res.agent.status)) await startDriver(o.runId, agentId);
  return { ...view(res.agent), created: res.created };
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
 */
export function envSnapshotProblem(provider: unknown, source: Record<string, string | undefined> = process.env): string | null {
  if (provider !== "claude" && provider !== "codex") return null;
  if (!realSandbox(source) || !sandboxCaps(source).snapshots) return null;
  if ((source.CAPCOMD_SPAWN_EXEC ?? "") === "fake" || (source.CAPCOMD_SPAWN_EXEC ?? "") === "script") return null;
  if ((source.CAPCOMD_ENV ?? "").toLowerCase() === "image") return null;
  if (resolveEnvSnapshot(source)) return null;
  const name = sandboxName(source);
  return `no capcomd env snapshot for the ${name} sandbox (the ${provider} CLI would be missing in its ${name === "docker" ? "containers" : "VMs"}); run \`capcomd env build --sandbox ${name}\` first`;
}

export function view(a: ScopeAgent) {
  return {
    agentId: a.agentId, runId: a.runId, parent: a.parent, depth: a.depth, profile: a.profile, status: a.status,
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
      // error while the engine starts) is the engine not answering.
      if ((e as any)?.group === "user") return missed ? "restarted" : "same";
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
    let restarts = 0;
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
        const df = await s.driveFailed({ agentId, kind, message: String((e as Error)?.message ?? e), attempt, driver }).catch(() => null);
        if (df && df.consecutive >= maxSame) break;
        // A rejected credential never heals by retrying; a scripted agent's exit code is its answer.
        // A limit (timeout, turns, budget) is a decision, not a fault: running the same task again hits it again.
        // So does a configuration problem (an unknown or invalid profile, no credentials): its message says what to fix.
        if (isBoxdAuthError(e) || e instanceof ScriptFailed || e instanceof EnvSnapshotMissing || kind === "limit" || kind === "config") break;
        await sleep(2000 * attempt);
      }
    }
    const res = await resultOf(runId, agentId);
    const fin = await s.finish({ agentId, status: "failed", result: { ...res, error: (last as Error)?.message?.slice(0, 500) ?? String(last), ...(last instanceof ScriptFailed ? { exitCode: last.exitCode } : {}) } });
    stampSpent(span, fin.agent);
    return fin.agent;
  }, { spanId: agentSpanId(runId, agentId), parentSpanId: me?.parent ? agentSpanId(runId, me.parent) : rootSpanIdForRun(runId) });
}

/** A reviewer's review target (set by verify in the contract; RPC spawns can't set it). */
function reviewOf(a: ScopeAgent): { sha: string; branch: string; target: string } | null {
  const r: any = (a.contract as any)?.review;
  return r && typeof r.sha === "string" && typeof r.branch === "string" && typeof r.target === "string" ? { sha: r.sha, branch: r.branch, target: r.target } : null;
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
  // Fail fast (no retries, no driverless "running"): a real agent on boxd needs the env snapshot.
  const envProblem = exec ? envSnapshotProblem((a.spec as any)?.provider, await (await import("../providers/run-sandbox")).runSandboxEnv(runId)) : null;
  if (envProblem) throw new EnvSnapshotMissing(envProblem);
  // ADR-019 §6: the login this agent spends from is out of quota (another agent hit it): wait for the reset, don't run.
  const login = exec ? loginOf(a.spec) : null;
  const waitUntil = login ? quotaUntil(login) : 0;
  if (waitUntil) return (await s.pause({ agentId, until: waitUntil, result: { limit: "quota", login, resetAt: waitUntil, error: `waiting for ${login}'s usage limit to reset (${new Date(waitUntil).toISOString()})` } })).agent;
  return null;
}

/** The agent's VM, provisioned (idempotent by its name) and assigned its task. True when it was cancelled meanwhile. */
async function ensureWorker(runId: string, a: ScopeAgent, w: any): Promise<boolean> {
  const agentId = a.agentId, epoch = a.epoch, exec = execOf(a);
  const s = client().scope.getOrCreate([runId]);
  let wk = await w.getWorker({ workerId: agentId });
  if (!wk || wk.state === "provisioning" || wk.state === "failed") {
    await w.provisionWorker({ workerId: agentId, runId, epoch, ...(exec ? { agent: exec, ...(a.spec ? { agentSpec: a.spec as Record<string, unknown> } : {}) } : {}) });
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
export async function runAttempt(runId: string, a: ScopeAgent, w: any, push: (params: Record<string, unknown>) => Promise<any> = (p) => w.pushBranch(p)): Promise<AttemptOutcome> {
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
  const vmRpc = exec && a.limits.allowSpawn ? await vmRpcFor(runId, a, w, agentId) : null;
  const review = reviewOf(a);
  const report = (a.contract as any)?.report === true;
  const from = (a.contract as any)?.from as { agentId: string; ref: string; stopped: string } | undefined;
  // Children branch from the run's target (a staging branch) when the operator set one.
  const target = await runTarget(runId);
  const doPush = () => push({ workerId: agentId, parentAgentId: a.parent ?? null, taskId: taskLabel, epoch, ...(epoch > 1 ? { resumed: true } : {}), branch, runId, goal: a.task, ...(exec ? { agent: exec, ...(a.spec ? { agentSpec: a.spec as Record<string, unknown> } : {}) } : {}), ...fakeFileParams(fakeFile), ...(vmRpc ? { subagents: vmRpc.params } : {}), ...(review ? { review } : {}), ...(report ? { report: true } : {}), ...(from ? { from } : {}), ...(target ? { target } : {}) });
  const pushed: any = vmRpc ? await vmRpc.run(doPush) : await doPush();
  return { kind: "pushed", pushed, vmRpc: !!vmRpc };
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
  const fin = await s.finish({ agentId, status: limit ? "failed" : "done", spent, result: { ...declared, ...verdictOf, ...reportOf, ...limitOf, verification: null, branch: review || report || (!pushed.sha && out.vmRpc) ? null : branch, commit: pushed.sha || null, costUsd, turns: spent.turns, wallSeconds: spent.wallSeconds, billing: rec.billing ?? (costUsd ? "api" : "subscription-or-fake"), ...(Number(rec.notionalCostUsd) > 0 ? { notionalCostUsd: Number(rec.notionalCostUsd) } : {}), ...(pushed.adopted ? { adopted: true } : {}) } });
  return fin.agent;
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
    if (await ensureWorker(runId, a, w)) return (await s.getAgent({ agentId }))!;
    const out = await runAttempt(runId, a, w);
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

/** The workflow's ensure-machine step. */
export async function ensureMachine(runId: string, agentId: string, epoch: number): Promise<{ kind: "ok" } | { kind: "ended" }> {
  const a = await getAgentOrThrow(runId, agentId);
  if (TERMINAL_AGENT.has(a.status)) return { kind: "ended" };
  return (await ensureWorker(runId, a, workerOf(runId, agentId, epoch))) ? { kind: "ended" } : { kind: "ok" };
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
  if (a.status === "cancelled") await workerOf(runId, agentId, epoch).drainWorker({ workerId: agentId }).catch(() => {});
  return getAgentOrThrow(runId, agentId);
}

/** Record one failed attempt (DRIVE_FAILED) and say whether to try again: the driver's rules (3 attempts, N identical
 *  failures in a row, never for a final kind). */
export async function recordDriveFailure(runId: string, agentId: string, driver: string, attempt: number, err: { kind: string; message: string; final: boolean } | null, maxAttempts: number): Promise<{ retry: boolean }> {
  if (!err) return { retry: false };
  const s = client().scope.getOrCreate([runId]);
  const df = await s.driveFailed({ agentId, kind: err.kind, message: err.message, attempt, driver }).catch(() => null);
  const maxSame = Number(env("DRIVE_MAX_FAILURES") ?? 3);
  return { retry: !err.final && attempt < maxAttempts && !(df && df.consecutive >= maxSame) };
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
export async function finishFailed(runId: string, agentId: string, epoch: number, err: { message: string; exitCode?: number }): Promise<ScopeAgent> {
  const a = await getAgentOrThrow(runId, agentId);
  if (a.status === "cancelled") return settleEnded(runId, agentId, epoch);
  if (TERMINAL_AGENT.has(a.status)) return a;
  const res = await resultOf(runId, agentId);
  const fin = await client().scope.getOrCreate([runId]).finish({ agentId, status: "failed", result: { ...res, error: String(err.message ?? "").slice(0, 500), ...(err.exitCode !== undefined ? { exitCode: err.exitCode } : {}) } });
  return fin.agent;
}

function parseBudgetLoose(v: unknown): Budget { try { return parseBudget(v); } catch { return {}; } }

function fakeFileParams(f: { path?: string; content?: string }) {
  return f.path ? { fakePath: f.path, fakeContent: f.content ?? "" } : {};
}

/** Real agent allowed to spawn: token + pump on its VM; the runner installs CLI, MCP and skill. */
async function vmRpcFor(runId: string, a: ScopeAgent, w: any, agentId: string) {
  const wk: any = await w.getWorker({ workerId: agentId });
  const vmId = wk?.context?.vmId;
  if (!vmId) return null;
  const { provider } = await (await import("../dependencies")).providerForRun(runId);
  const { orchestrationSkill } = await import("../subagents/skill");
  const kind = (a.spec as any)?.kind ?? (a.spec as any)?.provider;
  const params = { skill: orchestrationSkill({ agentId, limits: a.limits, budget: a.budget, mcp: true }), kind };
  return { params, run: <T>(fn: () => Promise<T>) => withVmRpc(runId, a, provider, vmId, undefined, fn) };
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
 */
export async function awaitAgents(runId: string, ids: string[], opts: { timeoutMs?: number; any?: boolean; notices?: boolean } = {}) {
  await assertEngine();
  const deadline = Date.now() + (opts.timeoutMs ?? 30 * 60_000);
  const kicked = new Map<string, number>();
  const done = new Map<string, ScopeAgent>();
  const latest = new Map<string, ScopeAgent>();
  const noticeAt = new Map<string, number>();
  // ADR-022: with the agent workflow, wait for the scope's "agents changed" event instead of polling every pollMs()
  // (a slow poll stays as the fallback: an event missed while reconnecting, a kick that's due).
  const feed = (await engineDrivesAgents(runId)) ? changeFeed(runId) : null;
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
    if (opts.any && done.size) { const [first] = [...done.values()].sort((x, y) => x.updatedAt - y.updatedAt); return { first: view(first!), agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "running" })) }; }
    if (done.size === ids.length) return { agents: ids.map((i) => view(done.get(i)!)) };
    if (noticed.length) return { notices: noticed.map((a) => ({ agentId: a.agentId, ...a.notice! })), agents: ids.map((i) => view(done.get(i) ?? latest.get(i)!)) };
    if (Date.now() > deadline) return { timeout: true, agents: ids.map((i) => (done.has(i) ? view(done.get(i)!) : { agentId: i, status: "timeout" })) };
    if (feed) await feed.wait(Math.min(eventFallbackMs(), Math.max(0, deadline - Date.now()) + 1)); else await sleep(pollMs());
  }
  } finally { feed?.close(); }
}

const eventFallbackMs = () => Number(env("AWAIT_FALLBACK_MS") ?? 5000);

/**
 * The scope's `agentsChanged` events (ADR-022) as a wait: resolves at the next event, or after `ms`. An event that
 * came while nobody waited makes the next wait return at once, so none is lost between a look and the wait.
 */
function changeFeed(runId: string): { wait: (ms: number) => Promise<void>; close: () => void } | null {
  try {
    const conn: any = client().scope.getOrCreate([runId]).connect();
    let dirty = false;
    let wake: (() => void) | null = null;
    conn.on("agentsChanged", () => { if (wake) { const w = wake; wake = null; w(); } else dirty = true; });
    conn.onError?.(() => {});
    return {
      wait: (ms) => new Promise<void>((resolve) => {
        if (dirty) { dirty = false; resolve(); return; }
        const t = setTimeout(() => { wake = null; resolve(); }, ms);
        wake = () => { clearTimeout(t); resolve(); };
      }),
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
  return a.limits.allowSpawn
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
    // A run its agents didn't end (none ever ran: it never started, or its planner couldn't be spawned) ends here.
    runEnded = await endRun(runId, "cancelled", reason ?? "run cancelled", by).then((r) => r.changed, () => false);
  }
  return { runId, target: agentId ?? null, cancelled: res.cancelled, affected: affected.map((a: { agentId: string; status: string }) => ({ agentId: a.agentId, status: a.status })), ...(runEnded ? { runEnded } : {}) };
}

/**
 * Record that the run itself ended (scope RUN_ENDED → lifecycle run.failed / run.cancelled), unless it already has:
 * by its agents (the lifecycle feed's own fold) or an earlier end. `changed`: this call ended it.
 */
export async function endRun(runId: string, state: "failed" | "cancelled", reason: string, by?: string | null): Promise<{ changed: boolean; state: string }> {
  await assertEngine();
  const s = client().scope.getOrCreate([runId]);
  const had = (await s.getScope({}))?.ended;
  if (had) return { changed: false, state: had.state };
  const { runPhase } = await import("../api/lifecycle");
  if (runPhase(runId, await s.getEvents({})) === "ended") return { changed: false, state: "ended" };
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
    const branch = a.result?.branch as string | undefined;
    if (a.status !== "done" || !branch) throw new RelayError("conflict", `agent ${ref} is ${a.status}; only a done agent's branch can be verified`, `Wait with \`capcomd await ${runId} ${ref}\`.`);
    const pin = a.contract?.check;
    return { branch, agentId: ref, label: taskLabelOf(a, ref), ...(typeof pin === "string" ? { pinnedCheck: pin } : {}) };
  }
  return { branch: ref, agentId: null, label: ref };
}

export interface VerifyOpts {
  runId: string; ref: string; checks?: string; check?: string; acceptance?: unknown; target?: string; key?: string;
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
/** A verify with a review runs for minutes; calls for the same vfy while it runs share one run. */
const inflightVerify = new Map<string, Promise<any>>();

/**
 * Run checks (the repo's test command, --checks, or the operator-named --check) on the ref merged with the latest target, in
 * the verifier actor (ADR-003: the result comes from running it, never from the agent's report).
 * With a reviewer (the run's, or --review-profile), a reviewer agent then reads the commit against the
 * acceptance criteria; both must pass, and no verdict is a fail.
 * Records vfy-… with the exact branch commit tested, which `merge --require` checks.
 */
export function verifyRef(o: VerifyOpts): Promise<any> {
  const id = verifyIdFor(o.runId, o.ref, o.key);
  const live = inflightVerify.get(id);
  if (live) return live;
  const p = verifyOnce(o).finally(() => inflightVerify.delete(id));
  inflightVerify.set(id, p);
  return p;
}

/** The run's reviewer profile, if the operator set one. */
export async function runReviewer(runId: string): Promise<string | undefined> {
  const v: any = (await client().scope.getOrCreate([runId]).kvGet({ k: REVIEWER_KV }).catch(() => null))?.value;
  return typeof v?.profile === "string" ? v.profile : undefined;
}

/** A reviewer profile's resolved spec (unknown profiles are a config error). */
function reviewerSpec(profile: string): Record<string, any> | null {
  try { return (resolveAgent(encodeAgentRef(profile)).spec as any) ?? null; } catch (e) {
    if (e instanceof AgentConfigError) throw new RelayError("config", `reviewer: ${e.message}`, "Name an agent profile (`capcomd agents list`), e.g. --reviewer reviewer.");
    throw e;
  }
}

interface Review { profile: string; agentId: string | null; passed: boolean; reasons: string[]; error?: string }

/** Spawn the reviewer for this verification (keyed: a retry reuses it), await it, read its verdict. Fails closed. */
async function reviewRef(o: { runId: string; vfyId: string; profile: string; branch: string; sha: string; target: string; agentId: string | null; acceptance?: unknown; parent?: string }): Promise<Review> {
  let reviewer: string | null = null;
  try {
    const spec = reviewerSpec(o.profile);
    const childTask = o.agentId ? (await getAgentOrThrow(o.runId, o.agentId)).task : null;
    const requested: Budget = {};
    if (spec?.maxTurns) requested.turns = spec.maxTurns;
    if (spec?.timeoutMs) requested.wallSeconds = Math.ceil(spec.timeoutMs / 1000);
    if (spec?.maxBudgetUsd) requested.usd = spec.maxBudgetUsd;
    const r = await spawnAgent({
      runId: o.runId, task: reviewBrief({ criteria: o.acceptance, childTask }), profile: o.profile, key: `review-${o.vfyId}`,
      ...(o.parent ? { parent: o.parent } : {}), contract: { review: { sha: o.sha, branch: o.branch, target: o.target, of: o.agentId ?? o.branch } },
      ...(Object.keys(requested).length ? { budget: requested } : {}), review: true,
    });
    reviewer = r.agentId;
    const [a] = (await awaitAgents(o.runId, [r.agentId], { timeoutMs: spec?.timeoutMs ? spec.timeoutMs + 10 * 60_000 : Infinity })).agents as any[];
    const v = a?.status === "done" ? (a.result?.verdict ?? null) : null;
    if (v) return { profile: o.profile, agentId: reviewer, passed: v.passed === true, reasons: v.reasons ?? [] };
    return { profile: o.profile, agentId: reviewer, passed: false, reasons: [], error: a?.status === "done" ? 'the reviewer gave no verdict (expected a final line {"passed": true|false, "reasons": [...]})' : `the reviewer ended ${a?.status ?? "unknown"}${a?.result?.error ? `: ${String(a.result.error).slice(0, 300)}` : ""}` };
  } catch (e) {
    return { profile: o.profile, agentId: reviewer, passed: false, reasons: [], error: `review failed: ${String((e as Error)?.message ?? e).slice(0, 300)}` };
  }
}

async function verifyOnce(o: VerifyOpts) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([o.runId]);
  const cfg = await (await import("../merge/run-config")).mergeConfigFor(o.runId);
  const target = o.target ?? (await runTarget(o.runId)) ?? cfg?.target ?? "main";
  const { branch, agentId, label, pinnedCheck } = await resolveRef(o.runId, o.ref);
  if (o.check !== undefined && o.checks) throw new RelayError("usage", "pass --check NAME or --checks CMD, not both", "--check picks one of the run's operator-named checks.");
  // A child pinned to a check at spawn is verified with it unless the caller names another.
  if (o.check === undefined && !o.checks && pinnedCheck) o = { ...o, check: pinnedCheck };
  const checks = o.check !== undefined ? await namedCheck(o.runId, o.check) : o.checks;
  const vfyId = verifyIdFor(o.runId, o.ref, o.key);
  const reviewProfile = o.reviewProfile ?? o.judgeProfile ?? (await runReviewer(o.runId));
  if (reviewProfile) reviewerSpec(reviewProfile); // an unknown reviewer is refused before anything runs
  // The record names the check and the exact command it ran; merge --require re-runs that command.
  const data = { ref: o.ref, agentId, branch, target, ...(o.check !== undefined ? { check: o.check } : {}), checks: checks ?? null, acceptance: o.acceptance ?? null, reviewProfile: reviewProfile ?? null };
  const st = await s.startOp({ opId: vfyId, kind: "verify", paramsHash: paramsHash(data), data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  const res: any = await c.verifier.getOrCreate([o.runId, vfyId]).verify({
    verifierId: vfyId, taskId: label, branch, runId: o.runId, target, testOnly: true, ...(checks ? { testCommand: checks } : {}),
  });
  const out = res.outcome as import("../merge/types").MergeOutcome;
  // Already on the target (merged earlier): nothing new to check or review, so it passes as already merged.
  const alreadyMerged = out.status === "merged";
  const checksPassed = out.status === "verified" || alreadyMerged;
  // Checks first (cheap, deterministic); the reviewer only reads a commit that already passes them.
  const review = checksPassed && reviewProfile && out.status === "verified" && out.taskSha
    ? await reviewRef({ runId: o.runId, vfyId, profile: reviewProfile, branch, sha: out.taskSha, target, agentId, acceptance: o.acceptance, ...(o.reviewParent ? { parent: o.reviewParent } : {}) })
    : null;
  const pass = checksPassed && (review ? review.passed : true);
  const result = {
    pass, branch, target, commit: out.status === "verified" ? (out.taskSha ?? null) : null, ...(alreadyMerged ? { alreadyMerged: true, mergedSha: out.sha } : {}),
    checks: { passed: checksPassed, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}), output: "output" in out && out.output ? String(out.output).slice(-2000) : null },
    // `judge` mirrors `review` for callers of the old --judge-profile contract.
    ...(review ? { review, judge: { profile: review.profile, passed: review.passed, feedback: (review.error ?? review.reasons.join("; ")).slice(0, 1000) } } : {}),
  };
  const fin = opView(await s.finishOp({ opId: vfyId, state: pass ? "passed" : "failed", result }));
  // A failed check says how on the agent's result too, with the lines of its output that name the failure (the app's card).
  const failedChecks = out.status === "failed" ? { reason: String(out.reason ?? "").slice(0, 300), excerpt: checkExcerpt("output" in out ? String(out.output ?? "") : "") } : {};
  if (agentId) await s.annotateResult({ agentId, patch: { verification: { id: vfyId, pass, commit: result.commit, checks: { passed: checksPassed, status: out.status, ...failedChecks }, ...(review ? { review: { passed: review.passed, agentId: review.agentId } } : {}) } } }).catch(() => {});
  return fin;
}

export interface MergeOpts {
  runId: string; ref: string; require?: string; target?: string; operator?: boolean; key?: string;
  /** In-VM merges: a protected target parks the merge for `capcomd approve <runId> <mrgId>` instead of refusing. */
  requestApproval?: boolean;
}

/** Land a ref. Requires a passing vfy for that exact commit and target, unless --operator. */
export async function mergeRef(o: MergeOpts) {
  await assertEngine();
  const c = client();
  const s = c.scope.getOrCreate([o.runId]);
  const { isProtectedBranch } = await import("../utils/protected");
  const RC = await import("../merge/run-config");
  const runEnv = await RC.runEnv(o.runId);
  const cfg = (await import("../merge/config")).loadMergeConfig(runEnv);
  const target = o.target ?? (await runTarget(o.runId)) ?? cfg?.target ?? "main";
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
  const needsApproval = !!cfg && isProtectedBranch(target, runEnv) && !o.operator;
  if (needsApproval && !o.requestApproval) throw new RelayError("conflict", `target ${target} is protected`, "Protected targets need an operator: pass --operator (or use `capcomd run` + `capcomd approve`).");
  const mrgId = stableId("mrg", `${o.runId}\0${o.ref}\0${target}`, o.key);
  const data = { ref: o.ref, agentId, branch, target, require: o.require ?? null, operator: !!o.operator, expectSha: expectSha ?? null, ...(needsApproval ? { approval: true } : {}) };
  const st = await s.startOp({ opId: mrgId, kind: "merge", paramsHash: paramsHash(data), data }).catch(asRelay);
  if (st.op.state !== "running") return opView(st.op);
  if (needsApproval) {
    // The person deciding sees what lands: the files the verified commit changes (best effort, never blocks the park).
    const diff = await (await import("../api/run-files")).approvalDiff({ remote: cfg!.remote, target, workdir: cfg!.workdir }, { agentId, sha: expectSha ?? null, branch }).catch(() => null);
    return opView(await s.parkOp({ opId: mrgId, reason: `target ${target} is protected`, ...(diff ? { diff } : {}) }));
  }
  return executeMerge(o.runId, st.op);
}

async function dropCheckpoints(runId: string, agentId: string) {
  const cfg = (await import("../merge/config")).loadMergeConfig(await (await import("../merge/run-config")).runEnv(runId));
  if (cfg) await (await import("../merge/repo")).deleteRemoteRef(cfg, checkpointRef(agentId));
}

/** Run a recorded merge op: land its ref (only the verified commit, re-running the checks verify passed with). */
async function executeMerge(runId: string, op: import("../actors/scope").ScopeOp) {
  const c = client();
  const s = c.scope.getOrCreate([runId]);
  const d = op.data as { ref: string; agentId?: string | null; branch: string; target: string; require: string | null; expectSha: string | null };
  const { label } = await resolveRef(runId, d.ref);
  // Re-run the checks that verification passed with (the target may have moved), not the repo default.
  const v = d.require ? await s.getOp({ opId: d.require }) : null;
  const checks = typeof v?.data.checks === "string" && v.data.checks ? (v.data.checks as string) : undefined;
  const res: any = await c.verifier.getOrCreate([runId, op.id]).verify({
    verifierId: op.id, taskId: label, branch: d.branch, runId, target: d.target, testOnly: false, ...(d.expectSha ? { expectSha: d.expectSha } : {}), ...(checks ? { testCommand: checks } : {}),
  });
  const out = res.outcome as import("../merge/types").MergeOutcome;
  const merged = out.status === "merged";
  // Its checkpoints were only for continuing the work, which has landed now (best effort).
  if (merged && d.agentId) await dropCheckpoints(runId, d.agentId).catch(() => {});
  const result = merged
    ? { merged: true, sha: out.sha, how: out.how, already: out.already, mode: out.mode, ...(out.pr ? { pr: out.pr } : {}), ...(out.targetBefore ? { targetBefore: out.targetBefore } : {}) }
    : { merged: false, status: out.status, ...(out.status === "failed" ? { reason: out.reason } : {}), ...(out.status === "conflict" ? { files: out.files } : {}) };
  const fin = opView(await s.finishOp({ opId: op.id, state: merged ? "merged" : "failed", result }));
  if (d.agentId) await s.annotateResult({ agentId: d.agentId, patch: { merge: { id: op.id, target: d.target, state: merged ? "merged" : "failed", ...(merged ? { sha: out.sha, ...(out.pr ? { pr: out.pr } : {}) } : { status: out.status }) } } }).catch(() => {});
  return fin;
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
  const { decided, op: now } = await s.decideOp({ opId: mrgId, approve: o.approve, by: o.by ?? "operator", ...(o.reason ? { reason: o.reason } : {}) });
  // Approved (now, or by an earlier call that crashed before merging): run it.
  if (o.approve && now.state === "running") return executeMerge(runId, now);
  if (!decided && now.state === "running") throw new RelayError("conflict", `${mrgId} is already merging`, "Wait for it, then check its state.");
  if (decided && !o.approve && typeof op.data.agentId === "string")
    await s.annotateResult({ agentId: op.data.agentId, patch: { merge: { id: mrgId, target: op.data.target ?? null, state: "denied" } } }).catch(() => {});
  return opView(now);
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
