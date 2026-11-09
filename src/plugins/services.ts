// The kernel's primitives for a plugin (docs/spec/plugin-api.md §8.1, §8.4), beyond `ctx.jobs` (src/jobs/service.ts),
// `ctx.storage` (src/plugins/storage.ts) and `ctx.triggers` (src/triggers/intake.ts). In the daemon only (`daemonServices`):
// `ctx.runs`, `ctx.agents`, `ctx.messages`, `ctx.kv`, `ctx.board`, `ctx.gates` and `ctx.profiles`, which act on the engine
// or resolve as a spawn does. In every process (`localServices`), like the gates: `ctx.sandboxes` and `ctx.auth`, facts
// about this process's places and logins. Each is the kernel's own path (src/primitives/ops.ts, the scope actor), with
// the plugin as the caller; the host has already checked the plugin's scopes (packages/plugin/src/host/context.ts). A
// call never creates a run: an unknown one is `not_found`. A mutating call's `key` (§8.2) is the plugin's own, kept apart
// from the CLI's and every other plugin's. A plugin is never the operator: its spawn passes the spawn checks as any
// caller's, and its merge needs a passing verification and every plugin's gate (§11.3). Errors reach the plugin as
// PluginErrors (§8.3).
import type { AgentsService, AuthService, BoardService, BoardTask, CallOptions, GatesService, KvService, MessagesService, ProfilesService, RunsService, SandboxesService } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import type { PluginManifest } from "../../packages/plugin/src/manifest";
import type { SandboxProvider as SandboxSeam, SeamCall } from "../../packages/plugin/src/seams";
import type { Budget, PinnedSpec, Principal, Run } from "../../packages/plugin/src/shapes";
import type { ScopeAgent, ScopeOp, ScopeTask } from "../actors/scope";
import { RelayError } from "../core/errors";
import { classifySandboxError } from "../providers/seam";
import type { SandboxProvider } from "../providers/sandbox";
import { checkKey, leaseMs } from "../primitives/board";
import { paramsHash } from "../primitives/policy";
import { agentSeam, kindOf } from "./agents";
import { HOST_CONTRACT_KEYS, iso, skillHash, SKILL_BYTES_MAX, SKILLS_MAX, untrusted } from "./hooks";
import { describedSandboxes, sandboxSeam } from "./sandboxes";
import { agentOf, approvalOf, mergeOf, verificationOf } from "./shapes";

/** A kernel error as a plugin sees it (§8.3). */
export function asPluginError(e: unknown): never {
  if (e instanceof PluginError) throw e;
  if (e instanceof RelayError) {
    const code = e.reason === "unsupported" ? "unsupported" : e.code === "usage" || e.code === "config" ? "invalid" : e.code === "not_found" ? "not_found" : e.code === "engine_unreachable" ? "unavailable" : e.reason === "forbidden" ? "forbidden" : "conflict";
    throw new PluginError(code, e.message, e.hint, code === "unavailable");
  }
  throw e;
}

const RUN_ID = /^run-[A-Za-z0-9_-]+$/;
const AGENT_ID = /^agt-[A-Za-z0-9_-]+$/;
/** Notice kinds only plugins raise (§8.4): the kernel raises `idle`, `spinning`, `failing`, `quota` (and its own
 *  `sandbox_outage`); a plugin may raise these and clear only these. */
export const PLUGIN_NOTICES: ReadonlySet<string> = new Set(["stalled"]);

/** The run's scope, when the run exists: a plugin's call never creates one. */
async function scopeOf(runId: string) {
  if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new PluginError("invalid", `not a run id: ${String(runId).slice(0, 80)}`);
  const { existingActor } = await import("../core/relay");
  const s = await existingActor("scope", [runId]).catch((e) => { throw new PluginError("unavailable", `the engine didn't answer: ${(e as Error)?.message ?? e}`, undefined, true); });
  if (!s) throw new PluginError("not_found", `no run ${runId}`);
  return s;
}

async function agentRecord(runId: string, agentId: string) {
  if (typeof agentId !== "string" || !AGENT_ID.test(agentId)) throw new PluginError("invalid", `not an agent id: ${String(agentId).slice(0, 80)}`);
  const a = await (await scopeOf(runId)).getAgent({ agentId });
  if (!a) throw new PluginError("not_found", `agent ${agentId} not found in ${runId}`);
  return a;
}

/** Whether the agent's work shows as its files changing, for the built-in watchdog (§16.4): not a reviewer's, a
 *  report-only agent's or an orchestrate agent's, which change no files by design and are never checkpointed
 *  (src/agents/runner.ts). */
export async function showsFileChanges(runId: string, agentId: string): Promise<boolean> {
  const a = await agentRecord(runId, agentId);
  const contract = (a.contract ?? {}) as { review?: unknown; report?: unknown };
  return !contract.review && contract.report !== true && (a.spec as { toolMode?: string } | null)?.toolMode !== "orchestrate";
}

const ENDED = new Set(["done", "failed", "cancelled"]);
/** How long `agents.await` waits by default, and at most (§8.2 `timeoutMs`); how many agents it waits for. */
const AWAIT_MS = 30_000, AWAIT_MAX_MS = 60 * 60_000, AWAIT_IDS_MAX = 100;

/** `ctx.agents` for one plugin (§8.1, §8.4). */
export function pluginAgents(plugin: string, principal: Principal): AgentsService {
  const by = `plugin:${plugin}`;
  return {
    /**
     * `capcomd spawn` as the plugin: the spawn checks, checkSpawn (the parent's limits, or the run's, and the budget
     * share it carves from) and agent.spawning (told the plugin asked) as for any caller, never as the operator. The
     * spawn's `by` and its title's `setBy` are `plugin:<name>`; a key gives the same agent again.
     */
    async spawn(input, o) {
      if (!input || typeof input !== "object") throw invalid("agents.spawn takes {runId, profile, task, parent?, contract?, budget?, grant?, title?}");
      const extra = input as { operator?: unknown; review?: unknown };
      if (extra.operator !== undefined && extra.operator !== false) throw new PluginError("forbidden", "a plugin's spawn is never the operator's: it passes the spawn checks as any caller's (§8.4)");
      if (extra.review !== undefined && extra.review !== false) throw new PluginError("forbidden", "a reviewer is a verification's (its reviewer gate spawns it), never a plugin's spawn (§8.4)");
      if (typeof input.profile !== "string" || !PROFILE_NAME.test(input.profile)) throw invalid(`not a profile name: ${String(input.profile).slice(0, 80)}`);
      if (typeof input.task !== "string" || !input.task.trim()) throw invalid("a spawn has a task");
      if (input.contract !== undefined) {
        if (!input.contract || typeof input.contract !== "object" || Array.isArray(input.contract)) throw invalid("a contract is {key: value}");
        checkValue(input.contract, "contract");
        // Own keys only: `in` would also find Object.prototype's (a contract key `constructor` is the plugin's to set).
        const host = Object.keys(input.contract).find((k) => Object.hasOwn(HOST_CONTRACT_KEYS, k));
        if (host) throw new PluginError("forbidden", `contract.${host} isn't a plugin's to set: ${HOST_CONTRACT_KEYS[host]}`);
      }
      if (input.grant !== undefined && (!input.grant || typeof input.grant !== "object" || Array.isArray(input.grant))) throw invalid("a grant is {maxChildren?, maxDepth?, maxTotalDescendants?, allowedChildProfiles?, budgetShare?}");
      if (input.title !== undefined && typeof input.title !== "string") throw invalid("a title is a string");
      const budget = input.budget === undefined ? undefined : budgetOf(input.budget, "a spawn");
      const idem = keyOf(plugin, o);
      const { runId, parent } = input;
      if (parent !== undefined) await agentRecord(runId, parent); else await scopeOf(runId);
      const a = await (await ops()).spawnAgent({
        runId, profile: input.profile, task: input.task, ...(parent !== undefined ? { parent } : {}), ...(input.contract ? { contract: input.contract } : {}),
        ...(budget ? { budget } : {}), ...(input.grant ? { grant: input.grant } : {}), ...(input.title !== undefined ? { title: input.title } : {}),
        operator: false, principal, ...idem,
      }).catch(kernelError);
      return agentOf(await agentRecord(runId, a.agentId));
    },
    get: async (runId, agentId) => agentOf(await agentRecord(runId, agentId)),
    async tree(runId, root) {
      const all = await (await scopeOf(runId)).listAgents({});
      if (!root) return all.map(agentOf);
      const keep = new Set([root]);
      // Parents come before their children in spawn order; one more pass covers any that don't.
      for (let grew = true; grew;) { grew = false; for (const a of all as ScopeAgent[]) if (a.parent && keep.has(a.parent) && !keep.has(a.agentId)) { keep.add(a.agentId); grew = true; } }
      if (!(all as ScopeAgent[]).some((a) => a.agentId === root)) throw new PluginError("not_found", `agent ${root} not found in ${runId}`);
      return (all as ScopeAgent[]).filter((a) => keep.has(a.agentId)).map(agentOf);
    },
    /** Cancels the agent and its descendants, as `capcomd cancel` does, saying which plugin did and why. */
    async cancel(runId, agentId, reason) {
      await agentRecord(runId, agentId);
      const why = String(reason ?? "").trim().slice(0, 300) || "no reason given";
      const { cancelAgents } = await import("../primitives/ops");
      await cancelAgents(runId, agentId, `by the ${plugin} plugin: ${why}`, `plugin:${plugin}`).catch(asPluginError);
    },
    /** Raises a plugin's kind of notice on a running agent, or clears one (null): never one the kernel raised. */
    async notice(runId, agentId, notice) {
      await agentRecord(runId, agentId);
      if (notice !== null && (typeof notice !== "object" || !PLUGIN_NOTICES.has(notice.kind)))
        throw new PluginError("forbidden", `a plugin raises only ${[...PLUGIN_NOTICES].join(", ")} notices; ${String((notice as { kind?: unknown } | null)?.kind)} is the kernel's (§8.4)`);
      const s = await scopeOf(runId);
      if (notice === null) {
        for (const kind of PLUGIN_NOTICES) await s.notice({ agentId, notice: null, only: kind });
        return;
      }
      const detail = String(notice.detail ?? "").trim();
      if (!detail) throw new PluginError("invalid", "a notice says what is wrong (detail)");
      await s.notice({ agentId, notice: { kind: notice.kind, detail: detail.slice(0, 300) } });
    },
    /** `capcomd await` (with `any`: `wait-any`) for at most `o.timeoutMs` (default 30 s): what ended, and what hasn't. */
    async await(runId, ids, input, o) {
      if (!Array.isArray(ids) || !ids.length || ids.length > AWAIT_IDS_MAX || ids.some((id) => typeof id !== "string" || !AGENT_ID.test(id))) throw invalid(`ids are 1 to ${AWAIT_IDS_MAX} agent ids`);
      if (input?.any !== undefined && typeof input.any !== "boolean") throw invalid("any is true or false");
      const ms = o?.timeoutMs ?? AWAIT_MS;
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0 || ms > AWAIT_MAX_MS) throw invalid(`timeoutMs is a number of milliseconds, at most ${AWAIT_MAX_MS} (an hour)`);
      const unique = [...new Set(ids)];
      for (const id of unique) await agentRecord(runId, id);
      await (await ops()).awaitAgents(runId, unique, { timeoutMs: ms, any: !!input?.any }).catch(kernelError);
      const s = await scopeOf(runId);
      const now = await Promise.all(unique.map(async (agentId) => (await s.getAgent({ agentId })) as ScopeAgent));
      return { ended: now.filter((a) => ENDED.has(a.status)).map(agentOf), pending: now.filter((a) => !ENDED.has(a.status)).map((a) => a.agentId) };
    },
    /** `capcomd grant <run> <agent>` as the plugin: more budget for a live agent, carved from what its parent (or the
     *  run) has left. Never the run's own budget: only the operator raises that. */
    async grant(runId, agentId, add, o) {
      const b = budgetOf(add, "a grant");
      if (!Object.keys(b).length) throw invalid("a grant adds some usd, turns or wallSeconds");
      const idem = keyOf(plugin, o);
      await agentRecord(runId, agentId);
      await (await ops()).grantBudget(runId, { agentId, add: b, by, ...idem }).catch(kernelError);
    },
    /** Names the agent's tab from the host, as a driver does, `setBy` the plugin; a user's own title still holds the tab. */
    async title(runId, agentId, title, o) {
      if (typeof title !== "string") throw invalid("a title is a string");
      const idem = keyOf(plugin, o);
      await agentRecord(runId, agentId);
      await (await ops()).setAgentTitle(runId, agentId, title, { by: "driver", setBy: by, ...idem }).catch(kernelError);
    },
  };
}

// ---- the daemon's: runs, messages, kv, board, gates, profiles ---------------------------------------------------------

const ops = () => import("../primitives/ops");
/** An actor's error (its UserError code, src/primitives/ops.ts asRelay) or the kernel's, as a plugin sees it. */
async function kernelError(e: unknown): Promise<never> {
  // The kernel's own errors as they are: through asRelay, a plugin's refusal (refusedError) would lose its reason.
  if (e instanceof RelayError || e instanceof PluginError) return asPluginError(e);
  const { asRelay } = await ops();
  try { return asRelay(e); } catch (x) { return asPluginError(x); }
}
const invalid = (message: string) => new PluginError("invalid", message);
/** A mutating call's idempotency key (§8.2), the plugin's own: a run's scope keeps one table of keys for every caller. */
function keyOf(plugin: string, o?: CallOptions): { key?: string } {
  if (o?.key === undefined) return {};
  // Refused, not cut: two keys that differ past the cut would be one key.
  if (typeof o.key !== "string" || !o.key || o.key.length > KEY_MAX) throw invalid(`a call's key is a non-empty string of at most ${KEY_MAX} characters`);
  return { key: `plugin:${plugin}:${o.key}` };
}
const KEY_MAX = 200;
const VALUE_MAX = 64 * 1024;
function checkValue(value: unknown, what: string): void {
  let json: string | undefined;
  try { json = JSON.stringify(value); } catch { json = undefined; }
  // undefined, a function or a symbol has no JSON; a BigInt or a cycle throws.
  if (json === undefined) throw invalid(`a ${what} value is JSON (not undefined, a function, a BigInt or a cycle)`);
  if (Buffer.byteLength(json) > VALUE_MAX) throw invalid(`a ${what} value is at most 64 KB of JSON (§8.4)`);
}

/** The run as harness.v1 shows it (GET /v1/runs/{id}): its row of the runs index, else what its scope recorded. */
async function runOf(runId: string): Promise<Run> {
  const s = await scopeOf(runId);
  const meta = await s.getScope({}) as { label: string | null; createdAt: number } | null;
  if (!meta) throw new PluginError("not_found", `no run ${runId}`);
  const { RUN_REPO_KV } = await import("../merge/run-config");
  const row = (await ops()).recentRuns(500).find((r) => r.runId === runId)
    ?? { runId, label: meta.label, repo: ((await s.kvGet({ k: RUN_REPO_KV }).catch(() => null)) as { value?: Record<string, string> } | null)?.value?.CAPCOMD_REPO ?? null, cwd: "", createdAt: meta.createdAt };
  return runShape(await (await import("../api/rivet-source")).runOfRow(row));
}
const runShape = (r: Run): Run => ({ id: r.id, projectId: r.projectId, label: r.label, state: r.state, goal: r.goal, title: r.title, repo: r.repo, createdAt: r.createdAt });

const UNITS = new Set(["usd", "turns", "wallSeconds"]);
function budgetOf(b: unknown, of = "a run"): Budget {
  if (!b || typeof b !== "object" || Array.isArray(b)) throw invalid(`${of} has a budget: {usd?, turns?, wallSeconds?}`);
  for (const [k, v] of Object.entries(b)) if (!UNITS.has(k) || typeof v !== "number" || !Number.isFinite(v) || v <= 0) throw invalid(`budget ${k}: a positive number of usd, turns or wallSeconds`);
  return b as Budget;
}
function named<K extends string>(name: K, v: unknown): { [k in K]?: string } {
  if (v === undefined || v === null) return {};
  if (typeof v !== "string" || !v.trim()) throw invalid(`${name} is a non-empty string`);
  return { [name]: v } as { [k in K]?: string };
}

/** A run's goal, checked as POST /v1/runs checks one (src/api/contract.ts `CreateRunBody`): at most 16 KB, no NUL, no
 *  leading `[agent:…]` directive. */
async function goalOf(goal: unknown): Promise<{ goal?: string }> {
  if (goal === undefined || goal === null) return {};
  if (typeof goal !== "string") throw invalid("goal is a non-empty string");
  const checked = (await import("../api/contract")).CreateRunBody.shape.goal.safeParse(goal);
  if (!checked.success) throw invalid(`goal: ${checked.error.issues.map((i) => i.message).join("; ")}`);
  return { goal };
}

/** `ctx.runs` (§8.1): what `capcomd run new`, `pause`, `resume`, `cancel` and `title --run` do, as the plugin. */
export function pluginRuns(plugin: string, principal: Principal): RunsService {
  const by = `plugin:${plugin}`;
  return {
    /** A run with no agent yet (`ops.runNew`); run.creating says the plugin asked (§6.6.3). */
    new: async (input, o) => {
      if (!input || typeof input !== "object") throw invalid("runs.new takes {budget, label?, goal?, checks?, reviewer?, target?, sandbox?}");
      if (input.checks !== undefined && (!input.checks || typeof input.checks !== "object" || Object.values(input.checks).some((c) => typeof c !== "string" || !c.trim()))) throw invalid("checks name commands: {name: command}");
      const r = await (await ops()).runNew({
        budget: budgetOf(input.budget), ...named("label", input.label), ...(await goalOf(input.goal)), ...named("reviewer", input.reviewer), ...named("target", input.target), ...named("sandbox", input.sandbox),
        ...(input.checks && Object.keys(input.checks).length ? { checks: input.checks } : {}), ...keyOf(plugin, o), principal,
      }).catch(kernelError);
      return runOf(r.runId);
    },
    get: (runId) => runOf(runId),
    async list(input) {
      const limit = input?.limit ?? 20;
      if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw invalid("limit is a whole number from 1 to 500");
      const { runOfRow } = await import("../api/rivet-source");
      return Promise.all((await ops()).recentRuns(limit).map(async (r) => runShape(await runOfRow(r))));
    },
    /** Ends the run as `state` and cancels its agents, as `capcomd cancel <run>` does, saying which plugin did and why. */
    async end(runId, input) {
      await scopeOf(runId);
      if (input?.state !== "failed" && input?.state !== "cancelled") throw invalid("a run ends failed or cancelled");
      const why = `by the ${plugin} plugin: ${String(input.reason ?? "").trim().slice(0, 300) || "no reason given"}`;
      const { cancelAgents, endRun } = await ops();
      await endRun(runId, input.state, why, by, { evenIfAgentsEnded: true }).catch(kernelError);
      await cancelAgents(runId, undefined, why, by).catch(kernelError);
    },
    async pause(runId) {
      await scopeOf(runId);
      await (await ops()).pauseAgents(runId, undefined, by).catch(kernelError);
    },
    async resume(runId) {
      await scopeOf(runId);
      await (await ops()).resumeAgents(runId, undefined, by).catch(kernelError);
    },
    async title(runId, title, o) {
      await scopeOf(runId);
      if (typeof title !== "string") throw invalid("a title is a string");
      await (await ops()).setRunTitle(runId, title, { setBy: by, ...keyOf(plugin, o) }).catch(kernelError);
    },
  };
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** A message's skills (§8.1 `AttachedSkill`), each pinned by the hash of its text, as the kernel keeps them. */
function messageSkills(skills: unknown): Array<{ name: string; content: string }> {
  if (skills === undefined) return [];
  if (!Array.isArray(skills) || skills.length > SKILLS_MAX) throw invalid(`skills is a list of at most ${SKILLS_MAX}`);
  const out = skills.map((s: { name?: unknown; text?: unknown; hash?: unknown } | null) => {
    if (!s || typeof s.name !== "string" || !SKILL_NAME.test(s.name)) throw invalid("a skill has a name of lowercase letters, digits, ., _ and -");
    if (typeof s.text !== "string" || !s.text.trim()) throw invalid(`skill ${s.name}: text is its SKILL.md, a non-empty string`);
    if (s.hash !== skillHash(s.text)) throw invalid(`skill ${s.name}: hash is the sha256 of its text`);
    return { name: s.name, content: s.text };
  });
  if (out.reduce((n, s) => n + Buffer.byteLength(s.content), 0) > SKILL_BYTES_MAX) throw invalid(`a message's skills are at most ${SKILL_BYTES_MAX} bytes together`);
  return out;
}

/** `ctx.messages` (§8.1): `capcomd send` from `plugin:<name>`, and an agent's inbox. */
export function pluginMessages(plugin: string): MessagesService {
  const from = `plugin:${plugin}`;
  return {
    async send(runId, input, o) {
      await agentRecord(runId, input?.to);
      const body = input.body;
      if (typeof body !== "string" || !body.trim()) throw invalid("a message has a body");
      if (Buffer.byteLength(body) > VALUE_MAX) throw invalid("a message's body is at most 64 KB");
      const skills = messageSkills(input.skills);
      const r = await (await ops()).sendToAgent(runId, { to: input.to, from, body, ...keyOf(plugin, o), ...(skills.length ? { skills } : {}) }).catch(kernelError);
      // A key the scope has seen answers with its first message: this one again, or a conflict (§8.2).
      if ((r as { replayed?: boolean }).replayed) {
        const [m] = await (await scopeOf(runId)).inbox({ agentId: input.to, after: r.seq - 1 }) as Array<{ seq: number; from: string; body: string }>;
        if (!m || m.seq !== r.seq || m.from !== from || m.body !== body) throw new PluginError("conflict", `key ${o!.key} was already used with different parameters`);
      }
      return { seq: r.seq };
    },
    async inbox(runId, agentId, after) {
      await agentRecord(runId, agentId);
      if (after !== undefined && (!Number.isInteger(after) || after < 0)) throw invalid("after is a message's seq (0: from the first)");
      const rows = await (await scopeOf(runId)).inbox({ agentId, after: after ?? 0 }) as Array<{ seq: number; from: string; body: string; at: number }>;
      return rows.map((m) => ({ seq: m.seq, from: m.from, body: untrusted(m.body, m.from), at: iso(m.at) }));
    },
  };
}

/** Keys a plugin reads and never writes (§8.4): the run's settings (`_`), and what only capcomd writes. */
export const RESERVED_KV = ["_", "approval/", "recipe/", "handoff/", "plugin/"] as const;
function kvKey(key: unknown, write: boolean): string {
  try { checkKey(key as string); } catch { throw invalid(`kv key ${JSON.stringify(String(key).slice(0, 64))}: letters, digits and . _ : / - (at most 200)`); }
  const k = key as string;
  if (write && RESERVED_KV.some((p) => k.startsWith(p))) throw new PluginError("forbidden", `kv key ${k} is reserved for capcomd: a plugin reads the keys under ${RESERVED_KV.join(", ")} and writes others (§8.4)`);
  return k;
}
type KvRow = { value: unknown; version: number; deleted: boolean } | null;

/** `ctx.kv` (§8.1): the run's blackboard (src/primitives/state.ts), written as `plugin:<name>`. */
export function pluginKv(plugin: string): KvService {
  const writer = `plugin:${plugin}`;
  return {
    async get(runId, key) {
      const k = kvKey(key, false);
      const r = await (await scopeOf(runId)).kvGet({ k }) as KvRow;
      return r && !r.deleted ? r.value : undefined;
    },
    async put(runId, key, value, o) {
      const k = kvKey(key, true);
      checkValue(value, "kv");
      const idem = keyOf(plugin, o);
      await (await scopeOf(runId)).kvWrite({ k, value, writer, ...idem, paramsHash: paramsHash({ k, value, expect: null }) }).catch(kernelError);
    },
    /** Compare-and-swap on the JSON of the current value (`expect` undefined: the key must not exist). */
    async cas(runId, key, expect, value, o) {
      const k = kvKey(key, true);
      checkValue(value, "kv");
      const idem = keyOf(plugin, o);
      const s = await scopeOf(runId);
      const cur = await s.kvGet({ k }) as KvRow;
      const live = cur && !cur.deleted ? cur : null;
      const matches = expect === undefined ? !live : !!live && JSON.stringify(live.value) === JSON.stringify(expect);
      if (!matches && !idem.key) return false;
      // With a key and a value that no longer matches: a version that never matches, so only a call the scope recorded
      // under the key (this one, before) answers true.
      try {
        await s.kvWrite({ k, value, writer, expect: matches ? cur?.version ?? 0 : -1, ...idem, paramsHash: paramsHash({ k, value, cas: expect === undefined ? null : JSON.stringify(expect) }) });
        return true;
      } catch (e) {
        if ((e as { code?: string }).code === "cas_mismatch") return false;
        return kernelError(e);
      }
    },
    /** The keys under `prefix`, in order; the run's settings (`_`) only when the prefix asks for them. */
    async list(runId, prefix) {
      if (typeof prefix !== "string" || !/^[A-Za-z0-9._:/-]{0,200}$/.test(prefix)) throw invalid("a kv prefix uses the characters of a key");
      const rows = await (await scopeOf(runId)).kvList({ ...(prefix ? { prefix } : {}) }) as Array<{ k: string }>;
      return rows.map((r) => r.k).filter((k) => prefix.startsWith("_") || !k.startsWith("_"));
    },
  };
}

const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;
/** A board task as the plugin API shows it: open (`pending`; `released` once a lease on it ended), `leased`, `done`. */
function taskOf(t: ScopeTask): BoardTask {
  const state = t.status === "done" ? "done" : t.status === "claimed" ? "leased" : t.epoch > 0 ? "released" : "pending";
  return { id: t.taskId, goal: untrusted(t.title, "board"), state, holder: t.holder, after: t.after ?? [] };
}

/** `ctx.board` (§8.1): the run's task board (src/primitives/board.ts); what the plugin claims, `plugin:<name>` holds. */
export function pluginBoard(plugin: string): BoardService {
  const holder = `plugin:${plugin}`;
  const task = async (runId: string, id: unknown) => {
    if (typeof id !== "string" || !TASK_ID.test(id)) throw invalid(`not a task id: ${String(id).slice(0, 80)}`);
    const t = await (await scopeOf(runId)).taskGet({ taskId: id }) as ScopeTask | null;
    if (!t) throw new PluginError("not_found", `task ${id} not found in ${runId}`);
    return t;
  };
  const finish = async (runId: string, id: string, outcome: "done" | "released") => {
    const t = await task(runId, id);
    if (outcome === "done" && t.status === "done" && t.holder === holder) return;
    if (t.status !== "claimed" || t.holder !== holder) throw new PluginError("conflict", `task ${id} is ${t.status === "claimed" ? `held by ${t.holder}` : t.status}, not held by ${holder}`);
    await (await scopeOf(runId)).taskFinish({ taskId: id, holder, epoch: t.epoch, outcome, paramsHash: paramsHash({ taskId: id, holder, epoch: t.epoch, outcome, result: null }) }).catch(kernelError);
  };
  return {
    async add(runId, input, o) {
      const id = input?.id;
      if (typeof id !== "string" || !TASK_ID.test(id)) throw invalid("a task's id is letters, digits and . _ : - (at most 100)");
      if (typeof input.goal !== "string" || !input.goal.trim()) throw invalid("a task has a goal");
      if (input.after !== undefined && (!Array.isArray(input.after) || input.after.some((a) => typeof a !== "string" || !TASK_ID.test(a)))) throw invalid("after names task ids");
      const after = input.after?.length ? [...new Set(input.after)].sort() : undefined;
      const idem = keyOf(plugin, o);
      const r = await (await scopeOf(runId)).taskAdd({ taskId: id, title: input.goal, ...(after ? { after } : {}), ...idem, paramsHash: paramsHash({ title: input.goal, data: null, ...(after ? { after } : {}) }) }).catch(kernelError);
      return taskOf(r.task as ScopeTask);
    },
    /** The named task, or the next ready one; null when none is free. */
    async claim(runId, input, o) {
      if (input?.id !== undefined) await task(runId, input.id);
      const ms = leaseMs(undefined);
      const r = await (await scopeOf(runId)).taskClaim({ holder, ...(input?.id ? { taskId: input.id } : {}), leaseMs: ms, ...keyOf(plugin, o), paramsHash: paramsHash({ holder, taskId: input?.id ?? null, leaseMs: ms }) }).catch(kernelError) as { claimed?: boolean; taskId?: string };
      return !r.claimed || !r.taskId ? null : taskOf(await task(runId, r.taskId));
    },
    done: (runId, id) => finish(runId, id, "done"),
    release: (runId, id) => finish(runId, id, "released"),
    list: async (runId) => ((await (await scopeOf(runId)).taskList({})) as ScopeTask[]).map(taskOf),
  };
}

const VFY_ID = /^vfy-[A-Za-z0-9]+$/;
const REF_MAX = 200;
function refOf(ref: unknown): string {
  if (typeof ref !== "string" || !ref.trim() || ref.length > REF_MAX) throw invalid(`a ref is an agent id or a branch (at most ${REF_MAX} characters)`);
  return ref;
}
/** A verification's or a merge's record, as the scope keeps it. */
async function opOf(runId: string, opId: string): Promise<ScopeOp> {
  const op = await (await scopeOf(runId)).getOp({ opId }) as ScopeOp | null;
  if (!op) throw new PluginError("not_found", `${opId} not found in ${runId}`);
  return op;
}

/** `ctx.gates` (§8.1): `capcomd verify` and `capcomd merge` as the plugin, and the merges parked for a person. */
export function pluginGates(plugin: string): GatesService {
  const requester = `plugin:${plugin}`;
  return {
    /** The checks and every judge on the ref, as `capcomd verify` runs them; the run pays for its reviewer. Only a named
     *  check (`check`): check commands are the operator's. Resolves once it has passed or failed. */
    async verify(runId, input, o) {
      if (!input || typeof input !== "object") throw invalid("gates.verify takes {ref, check?, acceptance?, target?, reviewer?}");
      if ((input as { checks?: unknown }).checks !== undefined) throw new PluginError("forbidden", "check commands come only from the operator: name one of the run's checks (check)");
      const ref = refOf(input.ref);
      if (input.acceptance !== undefined) checkValue(input.acceptance, "acceptance");
      if (input.reviewer !== undefined && (typeof input.reviewer !== "string" || !PROFILE_NAME.test(input.reviewer))) throw invalid(`not a profile name: ${String(input.reviewer).slice(0, 80)}`);
      const picked = { ...named("check", input.check), ...named("target", input.target), ...keyOf(plugin, o) };
      await scopeOf(runId);
      const v = await (await ops()).verifyRef({
        runId, ref, ...picked, ...(input.acceptance !== undefined ? { acceptance: input.acceptance } : {}), ...(input.reviewer !== undefined ? { reviewProfile: input.reviewer } : {}), requester,
      }).catch(kernelError) as { id: string };
      return verificationOf(runId, await opOf(runId, v.id));
    },
    /** A verified ref landed as `capcomd merge --require` lands it: never as the operator, so every plugin's gate is
     *  asked and none is bypassed (§11.3). A protected target, or a gate's hold, parks it for a person (`parked`). */
    async merge(runId, input, o) {
      if (!input || typeof input !== "object") throw invalid("gates.merge takes {ref, require, target?}");
      const operator = (input as { operator?: unknown }).operator;
      if (operator !== undefined && operator !== false) throw new PluginError("forbidden", "a plugin can't merge as the operator: its merge needs a passing verification and every plugin's gate (§11.3)");
      const ref = refOf(input.ref);
      if (typeof input.require !== "string" || !VFY_ID.test(input.require)) throw invalid("require is the id of a passing verification (vfy-…)");
      const picked = { ...named("target", input.target), ...keyOf(plugin, o) };
      await scopeOf(runId);
      const m = await (await ops()).mergeRef({ runId, ref, require: input.require, ...picked, operator: false, requestApproval: true, requester }).catch(kernelError) as { id: string };
      return mergeOf(runId, await opOf(runId, m.id));
    },
    async pending(runId) {
      const parked = await (await scopeOf(runId)).listOps({ state: "awaiting_approval", kind: "merge" }) as ScopeOp[];
      const { approvalIdFor } = await import("../api/source");
      return parked.map((op) => approvalOf(runId, op, approvalIdFor(runId, op.id)));
    },
  };
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** Where a project's profiles are read (GET /v1/profiles?repo=): the daemon's own without one. */
async function profileSource(project: unknown): Promise<Record<string, string | undefined>> {
  if (project === undefined || project === null) return process.env;
  if (typeof project !== "string" || !project.trim()) throw invalid("project is a project's repository or directory");
  const { projectSource } = await import("../api/create-run");
  try { return projectSource(project, process.env); } catch (e) { throw invalid((e as Error).message); }
}

/** `ctx.profiles` (§8.1, ADR-024 §3): what a spawn of a profile would run, and what there is to spawn. */
export function pluginProfiles(plugin: string, principal: Principal): ProfilesService {
  return {
    /** The profile with the overrides applied (they only narrow), then profile.resolved (§6.6.5): the spec a spawn pins. */
    async resolve(name, input, o) {
      if (typeof name !== "string" || !PROFILE_NAME.test(name)) throw invalid(`not a profile name: ${String(name).slice(0, 80)}`);
      const overrides = input?.overrides;
      if (overrides !== undefined && (!overrides || typeof overrides !== "object" || Array.isArray(overrides))) throw invalid("overrides are {field: value}, as `--set` takes them");
      const source = await profileSource(input?.project);
      const P = await import("../profiles");
      let resolved: import("../profiles").ResolvedAgent;
      try {
        resolved = P.resolveAgent(P.encodeAgentRef(name, overrides && Object.keys(overrides).length ? { set: overrides } : undefined), source);
      } catch (e) {
        if (!(e instanceof P.AgentConfigError)) throw e;
        throw new PluginError(/unknown agent profile/.test(e.message) ? "not_found" : /would widen/.test(e.message) ? "widening" : "invalid", e.message);
      }
      const out = await (await ops()).resolvedProfile(resolved, overrides && Object.keys(overrides).length ? overrides : null, { principal, entity: `plugin:${plugin}/${name}${o?.key ? `/${o.key}` : ""}` }).catch(kernelError);
      const { kind: _kind, ...spec } = (out.spec ?? {}) as unknown as Record<string, unknown>;
      return { ...spec, ...(out.profile ? { profile: out.profile } : {}) } as unknown as PinnedSpec;
    },
    async list(input) {
      const set = (await import("../api/profiles")).profilesOf(await profileSource(input?.project));
      if (set.error) throw invalid(`the profiles can't be read: ${set.error}`);
      return set.profiles.map((p) => ({ name: p.name, version: p.version, source: p.source, description: p.description, tags: p.tags }));
    },
  };
}

/** A plugin's services in the daemon (§8.4), beside `jobs`, `storage` and `triggers`. */
export function daemonServices(m: PluginManifest) {
  const principal: Principal = { kind: "plugin", name: m.name, scopes: [...(m.scopes ?? [])] };
  return {
    runs: pluginRuns(m.name, principal), agents: pluginAgents(m.name, principal), messages: pluginMessages(m.name), kv: pluginKv(m.name),
    board: pluginBoard(m.name), gates: pluginGates(m.name), profiles: pluginProfiles(m.name, principal),
  };
}

// ---- every process's: sandboxes, auth ---------------------------------------------------------------------------------

/** A kernel sandbox error as a plugin sees it, by its class (§7.2.3). */
function sandboxError(e: unknown): never {
  if (e instanceof PluginError) throw e;
  const c = classifySandboxError(e, "");
  const message = (e as Error)?.message ?? String(e);
  if (c.kind === "not_found") throw new PluginError("not_found", message);
  if (c.kind === "timeout") throw new PluginError("timeout", message, undefined, true);
  if (c.kind === "transient" || c.kind === "quota") throw new PluginError("unavailable", message, "hint" in c ? c.hint : undefined, true);
  if (c.kind === "config" || c.kind === "auth") throw new PluginError("invalid", message, c.hint || undefined);
  throw e;
}

/**
 * The sandbox `name` as a plugin gets it (§7.1, §8.4): the kernel's provider for the place (src/dependencies.ts
 * `providerNamed`: traced, riding out outages, the sandbox hooks fired), shaped as the seam and made on first use. A
 * provider plugin asking for its own place gets this too, never its own object. A call waits until its deadline at most.
 */
function sandboxFor(name: string, seam: SandboxSeam): SandboxSeam {
  let kernel: SandboxProvider | null = null;
  const left = (c: SeamCall) => Math.max(1, Date.parse(c.deadline) - Date.now());
  const go = async <T>(c: SeamCall, f: (p: SandboxProvider) => Promise<T>): Promise<T> => {
    if (c?.signal?.aborted) throw new PluginError("timeout", `the call to the ${name} sandbox was cancelled`);
    const ms = Date.parse(c?.deadline) - Date.now();
    if (Number.isNaN(ms)) throw new PluginError("invalid", "a seam call's deadline is an ISO 8601 time (§7.1 SeamCall)");
    if (ms <= 0) throw new PluginError("timeout", `the call to the ${name} sandbox passed its deadline`);
    kernel ??= (await import("../dependencies")).providerNamed(name);
    let off = () => {};
    // The call's signal, or its deadline when the signal never fires (§8.4: a call waits until its deadline at most).
    const stopped = new Promise<never>((_, reject) => {
      const on = () => reject(new PluginError("timeout", `the call to the ${name} sandbox passed its deadline`));
      const timer = setTimeout(on, ms);
      c?.signal?.addEventListener("abort", on, { once: true });
      off = () => { clearTimeout(timer); c?.signal?.removeEventListener("abort", on); };
    });
    try { return await Promise.race([f(kernel), stopped]); } catch (e) { return sandboxError(e); } finally { off(); }
  };
  const extra = <K extends "extendTtl" | "probe">(p: SandboxProvider, what: K): NonNullable<SandboxProvider[K]> => {
    const f = p[what];
    if (!f) throw new PluginError("unsupported", `the ${name} sandbox has no ${what}`);
    return f.bind(p) as NonNullable<SandboxProvider[K]>;
  };
  const wrapped: SandboxSeam = {
    describe: () => seam.describe(),
    available: (c) => go(c, () => seam.available(c)),
    classifyError: (e) => seam.classifyError(e),
    ensure: (spec, c) => go(c, (p) => p.ensure(spec)),
    waitReady: (id, c) => go(c, (p) => p.waitReady(id, left(c))),
    exec: (id, cmd, opts, c) => go(c, (p) => p.exec(id, cmd, { ...(opts?.env ? { env: opts.env } : {}), ...(opts?.cwd ? { cwd: opts.cwd } : {}), timeoutMs: left(c) })),
    upload: (id, path, data, c) => go(c, (p) => p.upload(id, path, data)),
    download: (id, path, c) => go(c, (p) => p.download(id, path)),
    setEgress: (id, allow, c) => go(c, (p) => p.setEgress(id, allow)),
    snapshot: (id, n, c) => go(c, (p) => p.snapshot(id, n)),
    checkpoint: (id, n, c) => go(c, (p) => p.checkpoint(id, n)),
    restore: (id, n, c) => go(c, (p) => p.restore(id, n)),
    suspend: (id, c) => go(c, (p) => p.suspend(id)),
    resume: (id, c) => go(c, (p) => p.resume(id)),
    destroy: (id, c) => go(c, (p) => p.destroy(id)),
    list: (prefix, c) => go(c, (p) => p.list(prefix)),
    ...(seam.extendTtl ? { extendTtl: (id: string, seconds: number, c: SeamCall) => go(c, (p) => extra(p, "extendTtl")(id, seconds)) } : {}),
    ...(seam.probe ? { probe: (id: string | undefined, c: SeamCall) => go(c, (p) => extra(p, "probe")(id)) } : {}),
  };
  return Object.freeze(wrapped);
}

/** `ctx.sandboxes` (§8.1): the active places, by name or by the run that uses one. */
export function pluginSandboxes(): SandboxesService {
  const made = new Map<string, SandboxSeam>();
  const provider = (name: string): SandboxSeam => {
    const seam = typeof name === "string" ? sandboxSeam(name) : null;
    if (!seam) throw new PluginError("not_found", `no active plugin provides the ${String(name).slice(0, 64)} sandbox`, "See `capcomd plugins list`.");
    let p = made.get(name);
    if (!p) made.set(name, (p = sandboxFor(name, seam)));
    return p;
  };
  return {
    provider,
    /** The run's place: the one it was started on (`capcomd run --sandbox`), else this process's. */
    async forRun(runId) {
      await scopeOf(runId);
      const name = (await (await import("../providers/run-sandbox")).runSandbox(runId)) ?? (await import("../providers/registry")).sandboxName();
      return { provider: provider(name), name };
    },
    descriptors: () => describedSandboxes(),
  };
}

/** `ctx.auth` (§8.1, §11.4): how an agent of `provider` gets its credential here, and whether a login is there; facts,
 *  never a value. `redact` is the host's. */
export function pluginAuth(): Partial<AuthService> {
  const known = (provider: unknown): string => {
    if (typeof provider !== "string" || !agentSeam(provider)) throw new PluginError("not_found", `no active plugin provides the ${String(provider).slice(0, 64)} agent`, "See `capcomd plugins list`.");
    return provider;
  };
  return {
    credentialMode(provider, auth) {
      known(provider);
      if (auth !== "apikey" && auth !== "subscription") throw invalid("auth is apikey or subscription");
      const { credentialModeFor } = require("../agents/config") as typeof import("../agents/config");
      // None configured (or both, or a bad CAPCOMD_CREDENTIALS) is an error at spawn; here it is `none`.
      try { const m = credentialModeFor(kindOf(provider), process.env, auth); return m === "auto" ? "secret" : m; } catch { return "none"; }
    },
    async loginPresent(provider, sandbox) {
      known(provider);
      if (typeof sandbox !== "string" || !sandboxSeam(sandbox)) throw new PluginError("not_found", `no active plugin provides the ${String(sandbox).slice(0, 64)} sandbox`);
      return (await import("../api/settings")).logins(process.env).some((l) => l.provider === provider && l.sandbox === sandbox && l.loggedIn);
    },
  };
}

/** A plugin's services in any process (§8.4), like the gates: facts about this process's places and logins. */
export function localServices() {
  return { sandboxes: pluginSandboxes(), auth: pluginAuth() };
}
