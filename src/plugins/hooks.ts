// The kernel's side of the hooks (docs/spec/plugin-api.md §6, ADR-023 step 2): the daemon's hook registry, set by
// `capcomd serve` once its plugin host has started, and what the kernel's hook sites share (who caused an operation,
// how a refusal reaches the caller, the patch rules of §6.6). Only the daemon has a full registry; another process that
// runs a verify or a merge (the CLI, the MCP server, a run's driver) has only the built-in gates, started by `gates()`
// before it. Elsewhere, and for a hook no plugin listens to, `hooks.listening(h)` is false, so a site builds no payload
// and awaits nothing, and the kernel does exactly what it did before (§17.2 step 2).
// Each site names the hook and its mode as string literals (scripts/check-hook-modes.ts checks them).
import type { HookRegistry, Refusal } from "../../packages/plugin/src/host/registry";
import { PluginError } from "../../packages/plugin/src/errors";
import type { AgentPreparing, AgentSpawning, HookName, PreparePatch, ProfilePatch, ProfileResolved, RunCreatePatch, RunCreating, SandboxEnsuring, SandboxPatch, SpawnPatch } from "../../packages/plugin/src/hooks";
import type { Budget, Principal, Timestamp, Untrusted } from "../../packages/plugin/src/shapes";
import { RelayError, type ErrorCode } from "../core/errors";

let registry: HookRegistry | null = null;
/** This process is the daemon (`capcomd serve`): its gates wait for its own registry, never start a local one. */
let daemon: { ready: Promise<void>; set(): void } | null = null;
/** A process that isn't the daemon: the gates it runs itself (`gates()`), started once. */
type Local = { registry: HookRegistry | null; started: Promise<void> };
let local: Local | null = null;

/** The daemon's registry (`capcomd serve`), or null (stopping, tests). Null also forgets a local one (tests). */
export function useHooks(r: HookRegistry | null): void {
  registry = r;
  if (r) daemon?.set(); else local = null;
}

/** `capcomd serve`, before its engine starts: a verify it runs before its plugins have loaded (an agent's, resumed)
 *  waits for them (a reviewer configured for the run must judge it) instead of starting gates of its own. */
export function daemonHooks(): void {
  if (daemon) return;
  let set!: () => void;
  const ready = new Promise<void>((r) => { set = r; });
  daemon = { ready, set };
}

/**
 * Before a verify runs: the plugins that judge it are listening in this process. The daemon's are its host's. A
 * process that runs a verify against the engine itself (the CLI, the MCP server, a run's driver) starts the built-in
 * gates in a local host of its own (src/plugins/host.ts `localHost`), so the run's reviewer judges every verify wherever
 * it runs, until those front doors go through the daemon (plugin API §6.1, §17.2 step 8). (A merge's gate,
 * merge.landing, fires in the engine host, the daemon, where the merge runs.) Gates that fail to start leave a verify
 * with a reviewer failing closed (src/primitives/ops.ts reviewOfJudges).
 */
export async function gates(): Promise<void> {
  if (registry) return;
  if (daemon) return daemon.ready;
  if (!local) {
    const l: Local = { registry: null, started: Promise.resolve() };
    l.started = import("./host").then(async (h) => { l.registry = await h.localHost(); })
      .catch((e) => console.error(`capcomd: the built-in gates did not start: ${(e as Error)?.message ?? e}`));
    local = l;
  }
  await local.started;
}

const current = (): HookRegistry | null => registry ?? local?.registry ?? null;

const fire = ((hook: HookName, mode: "observe" | "veto" | "modify", payload: unknown, o: unknown) => {
  const r = current();
  if (!r) return mode === "observe" ? undefined : Promise.resolve(mode === "modify" ? { decision: "allow", payload, patches: [] } : { decision: "allow" });
  return (r.fire as (...a: unknown[]) => unknown)(hook, mode, payload, o);
}) as HookRegistry["fire"];

export const hooks = {
  /** Whether a plugin listens to `hook` in this process. Synchronous: guard every site with it. */
  listening: (hook: HookName): boolean => current()?.listening(hook) ?? false,
  /** Any of `names`: the scope's change tap asks once for all the `*.changed` hooks. */
  listeningAny: (names: readonly HookName[]): boolean => { const r = current(); return !!r && names.some((n) => r.listening(n)); },
  fire,
  /** The plugins listening to `hook`, in the order their listeners run (§6.3). */
  order: (hook: HookName): string[] => current()?.order(hook) ?? [],
  /** Resolves once every queued observe call has run (the daemon's stop, tests). */
  idle: (): Promise<void> => current()?.idle() ?? Promise.resolve(),
};

/**
 * A gate's audit event on the run's stream (plugin API §13.1): `plugin.gate_denied` (the registry's, through the host)
 * and `plugin.gate_bypassed` (`merge --operator`, §6.5). Written to the run's scope like its other events, from any
 * process that runs the gate.
 */
export async function recordGateEvent(runId: string, e: { type: "plugin.gate_denied" | "plugin.gate_bypassed"; data: Record<string, unknown>; key?: string }): Promise<void> {
  const { client } = await import("../core/relay");
  await client().scope.getOrCreate([runId]).recordGateEvent({ type: e.type === "plugin.gate_denied" ? "PLUGIN_GATE_DENIED" : "PLUGIN_GATE_BYPASSED", data: e.data, ...(e.key ? { key: e.key } : {}) });
}

/** What a gate left going after its answer: a reviewer it started or stops, a gate event it writes. */
const pending = new Set<Promise<void>>();
export function inBackground(p: Promise<unknown>): void {
  const q: Promise<void> = p.then(() => {}, () => {}).finally(() => { pending.delete(q); });
  pending.add(q);
}
/** A process that exits right after its command (the CLI) waits for that work first, bounded: else a reviewer started
 *  alongside checks that failed fast would be left running, and a denial would go unrecorded. */
export async function settled(maxMs = 30_000): Promise<void> {
  const until = Date.now() + maxMs;
  while (pending.size && Date.now() < until) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([Promise.all([...pending]), new Promise<void>((r) => { timer = setTimeout(r, until - Date.now()); })]);
    clearTimeout(timer);
  }
}

export const iso = (ms: number = Date.now()): Timestamp => new Date(ms).toISOString();
/** Agent-written text as a hook payload carries it (§11.5). */
export const untrusted = (text: string, by: string): Untrusted => ({ text, untrusted: true, by });

/** Who caused an operation (§3.2), from what the kernel records as its `by`: an agent id, `client:<id>` (an app or
 *  harness client), `driver` or the MCP server's elicitation (a driving harness), else the operator. */
export function principalOf(by: string | null | undefined, runId: string | null = null): Principal {
  if (by && by.startsWith("agt-") && runId) return { kind: "agent", agentId: by, runId };
  if (by && by.startsWith("client:")) return { kind: "operator", clientId: by.slice("client:".length) };
  if (by === "driver" || by?.startsWith("driver:")) return { kind: "driver", clientId: null };
  return { kind: "operator", clientId: null };
}

/** A refused operation as the caller sees it (§6.2): reason `plugin:<name>`, the plugin's text as the hint. */
export function refusedError(hook: HookName, r: Refusal, code: ErrorCode = "conflict"): RelayError {
  const who = r.plugin ? `the ${r.plugin} plugin` : "capcomd (the daemon is stopping)";
  return new RelayError(code, `${hook}: refused by ${who}`, r.text || "A plugin refused it.", { code: r.plugin ? `plugin:${r.plugin}` : "daemon_stopping" });
}
/** The same refusal as one line, for a record that fails instead of an error (a verification, a merge). */
export const refusedText = (r: Refusal) => `${r.plugin ? `plugin:${r.plugin}` : "daemon stopping"}: ${r.text}`;

// ---- the kernel's patch rules (§6.6): the payload with one plugin's patch applied, or a PluginError ----------------

const widening = (what: string) => new PluginError("widening", what);
const invalid = (what: string) => new PluginError("invalid", what);
const UNITS = ["usd", "turns", "wallSeconds"] as const;

/** A budget that only lowers `base` per unit (an unset unit is unbounded, so any value lowers it). */
export function lowerBudget(base: Budget | null, patch: unknown): Budget {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw invalid("budget is an object of usd, turns, wallSeconds");
  const out: Budget = { ...(base ?? {}) };
  for (const [u, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!(UNITS as readonly string[]).includes(u)) throw invalid(`budget has no unit ${u}`);
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw invalid(`budget.${u} must be a non-negative number`);
    const was = base?.[u as (typeof UNITS)[number]];
    if (was !== undefined && v > was) throw widening(`budget.${u} ${v} > ${was}`);
    out[u as (typeof UNITS)[number]] = v;
  }
  return out;
}

/** §6.6.3: `label`; `budget` lowers each unit; `sandbox` a listed provider. */
export function applyRunPatch(p: RunCreating, patch: RunCreatePatch, isListed: (name: string) => boolean): RunCreating {
  const options = { ...p.options };
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || !patch.label.trim()) throw invalid("label is a non-empty string");
    options.label = patch.label.trim().slice(0, 200);
  }
  if (patch.budget !== undefined) options.budget = lowerBudget(options.budget, patch.budget);
  if (patch.sandbox !== undefined) {
    const n = String(patch.sandbox).toLowerCase();
    if (!isListed(n)) throw invalid(`sandbox ${JSON.stringify(patch.sandbox)} isn't a listed provider`);
    options.sandbox = n;
  }
  return { ...p, options };
}

/** §6.6.5: a ProfilePatch narrows the spec exactly as a user's override does (`applyOverrides`, `widenings()`). */
export function applyProfilePatch(p: ProfileResolved, patch: ProfilePatch, narrow: (spec: Record<string, unknown>, set: Record<string, unknown>) => Record<string, unknown>): ProfileResolved {
  try {
    return { ...p, spec: narrow(p.spec as unknown as Record<string, unknown>, patch as Record<string, unknown>) as unknown as ProfileResolved["spec"] };
  } catch (e) {
    if (e instanceof PluginError) throw e;
    const m = (e as Error).message;
    throw /widen/.test(m) ? widening(m) : invalid(m);
  }
}

/** §6.6.6: `budget` lowers; `grant` narrows what was asked (the scope still checks it against the parent's ceiling);
 *  `contract` adds keys, never changes one. */
export function applySpawnPatch(p: AgentSpawning, patch: SpawnPatch): AgentSpawning {
  const spawn = { ...p.spawn };
  if (patch.budget !== undefined) spawn.budget = lowerBudget(spawn.budget, patch.budget);
  if (patch.grant !== undefined) {
    if (!patch.grant || typeof patch.grant !== "object") throw invalid("grant is an object");
    const was = spawn.grant ?? {};
    const g = { ...was };
    for (const [k, v] of Object.entries(patch.grant)) {
      if (k === "allowSpawn") { if (v === true && was.allowSpawn !== true) throw widening("grant.allowSpawn → true"); g.allowSpawn = v === true; continue; }
      if (k === "allowedChildProfiles") {
        if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) throw invalid("grant.allowedChildProfiles is a list of profile names");
        const extra = was.allowedChildProfiles ? v.filter((x) => !was.allowedChildProfiles!.includes(x)) : [];
        if (extra.length) throw widening(`grant.allowedChildProfiles adds ${extra.join(",")}`);
        g.allowedChildProfiles = v;
        continue;
      }
      if (!["maxDepth", "maxChildren", "maxTotalDescendants", "budgetShare"].includes(k)) throw invalid(`grant has no ${k}`);
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw invalid(`grant.${k} must be a non-negative number`);
      const before = (was as Record<string, number | undefined>)[k];
      if (before !== undefined && v > before) throw widening(`grant.${k} ${v} > ${before}`);
      (g as Record<string, unknown>)[k] = v;
    }
    spawn.grant = g;
  }
  if (patch.contract !== undefined) {
    if (!patch.contract || typeof patch.contract !== "object" || Array.isArray(patch.contract)) throw invalid("contract is an object");
    const was = spawn.contract ?? {};
    const changed = Object.keys(patch.contract).filter((k) => k in was && JSON.stringify(was[k]) !== JSON.stringify(patch.contract![k]));
    if (changed.length) throw widening(`contract keys are the spawner's: ${changed.join(", ")}`);
    spawn.contract = { ...patch.contract, ...was };
  }
  return { ...p, spawn };
}

/** §6.6.7: `prompt.append` after the profile's own; `egress` only removes hosts. `skills` and `env` are refused
 *  (`invalid`) until the step that attaches them to the agent's run (ADR-024 skills, §17.2 step 8). */
export function applyPreparePatch(p: AgentPreparing, patch: PreparePatch): AgentPreparing {
  const next = { ...p, prompt: { ...p.prompt } };
  if (patch.env !== undefined) throw invalid("env is not supported by this capcomd yet");
  if (patch.prompt !== undefined) {
    if (!patch.prompt || typeof patch.prompt !== "object") throw invalid("prompt is an object");
    if (patch.prompt.skills !== undefined) throw invalid("prompt.skills is not supported by this capcomd yet");
    if (patch.prompt.append !== undefined) {
      if (typeof patch.prompt.append !== "string") throw invalid("prompt.append is a string");
      const add = patch.prompt.append.trim();
      if (add) next.prompt.append = next.prompt.append ? `${next.prompt.append}\n\n${add}` : add;
    }
  }
  if (patch.egress !== undefined) {
    if (!Array.isArray(patch.egress) || !patch.egress.every((h) => typeof h === "string")) throw invalid("egress is a list of hosts");
    const extra = patch.egress.filter((h) => !p.egress.includes(h));
    if (extra.length) throw widening(`egress adds ${extra.join(",")}`);
    next.egress = patch.egress;
  }
  return next;
}

const LABEL_KEY = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
/** §6.6.10: labels added under `plugin.<name>.`; `size` and `ttlSeconds` never grow. */
export function applySandboxPatch(p: SandboxEnsuring, patch: SandboxPatch, plugin: string): SandboxEnsuring {
  const spec = { ...p.spec, labels: { ...p.spec.labels } };
  if (patch.labels !== undefined) {
    if (!patch.labels || typeof patch.labels !== "object") throw invalid("labels is an object of strings");
    for (const [k, v] of Object.entries(patch.labels)) {
      if (!LABEL_KEY.test(k) || typeof v !== "string" || v.length > 256) throw invalid(`label ${JSON.stringify(k)}: a short key and a string value`);
      spec.labels[`plugin.${plugin}.${k}`] = v;
    }
  }
  if (patch.size !== undefined) {
    const vcpu = patch.size?.vcpu;
    if (![1, 2, 4, 8].includes(vcpu as number)) throw invalid("size.vcpu is 1, 2, 4 or 8");
    // No size asked: the provider's default, which the kernel can't compare with: only the smallest is a lowering.
    if (p.spec.size ? vcpu > p.spec.size.vcpu : vcpu !== 1) throw widening(`size.vcpu ${vcpu} > ${p.spec.size?.vcpu ?? "the provider's default"}`);
    spec.size = { vcpu };
  }
  if (patch.ttlSeconds !== undefined) {
    if (typeof patch.ttlSeconds !== "number" || !Number.isFinite(patch.ttlSeconds) || patch.ttlSeconds <= 0) throw invalid("ttlSeconds is a positive number");
    if (patch.ttlSeconds > p.spec.ttlSeconds) throw widening(`ttlSeconds ${patch.ttlSeconds} > ${p.spec.ttlSeconds}`);
    spec.ttlSeconds = Math.floor(patch.ttlSeconds);
  }
  return { ...p, spec };
}
