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
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Redactor } from "../agents/redact";

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
 * Before a verify runs, and before an agent is prepared (agent.preparing: the orchestration skill, src/primitives/ops.ts
 * `preparingHooks`): the plugins that judge or prepare it are listening in this process. The daemon's are its host's. A
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
    l.started = import("./host").then(async (h) => { l.registry = (await h.localHost()).hooks; })
      .catch((e) => console.error(`capcomd: the built-in gates did not start: ${(e as Error)?.message ?? e}`));
    local = l;
  }
  await local.started;
}

const current = (): HookRegistry | null => registry ?? local?.registry ?? null;

/** This process is the daemon: its hooks are its own host's, where every `*.changed` hook fires (§6.1). */
export const inDaemon = (): boolean => daemon !== null || registry !== null;

const fire = ((hook: HookName, mode: "observe" | "veto" | "modify", payload: unknown, o: unknown) => {
  const r = current();
  if (!r) return mode === "observe" ? undefined : Promise.resolve(mode === "modify" ? { decision: "allow", payload, patches: [] } : { decision: "allow" });
  return (r.fire as (...a: unknown[]) => unknown)(hook, mode, payload, o);
}) as HookRegistry["fire"];

export const hooks = {
  /** Whether a plugin listens to `hook` in this process (with `kind`, to that kind of change: job.changed's `changes`,
   *  §4.7). Synchronous: guard every site with it. */
  listening: (hook: HookName, kind?: string): boolean => current()?.listening(hook, kind) ?? false,
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
 *  harness client), `driver` or the MCP server's elicitation (a driving harness), `plugin:<name>`, else the operator. */
export function principalOf(by: string | null | undefined, runId: string | null = null): Principal {
  if (by && by.startsWith("agt-") && runId) return { kind: "agent", agentId: by, runId };
  if (by && by.startsWith("client:")) return { kind: "operator", clientId: by.slice("client:".length) };
  if (by === "driver" || by?.startsWith("driver:")) return { kind: "driver", clientId: null };
  // A plugin's own call (its ctx primitives write `plugin:<name>`): the scopes it had aren't recorded with it.
  if (by?.startsWith("plugin:") && by.length > "plugin:".length) return { kind: "plugin", name: by.slice("plugin:".length), scopes: [] };
  return { kind: "operator", clientId: null };
}

/** A refused operation as the caller sees it (§6.2): reason `plugin:<name>`, the plugin's text as the hint. */
export function refusedError(hook: HookName, r: Refusal, code: ErrorCode = "conflict"): RelayError {
  const who = r.plugin ? `the ${r.plugin} plugin` : "capcomd (the daemon is stopping)";
  return new RelayError(code, `${hook}: refused by ${who}`, r.text || "A plugin refused it.", { code: r.plugin ? `plugin:${r.plugin}` : "daemon_stopping" });
}
/** The same refusal as one line, for a record that fails instead of an error (a verification, a merge). */
export const refusedText = (r: Pick<Refusal, "plugin" | "text">) => `${r.plugin ? `plugin:${r.plugin}` : "daemon stopping"}: ${r.text}`;

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

/** A sandbox an active plugin provides here (§17.2 step 3: what `sandboxProvider` and the dependencies build from), so a
 *  run can be made on it. A listed provider whose plugin is disabled or failed to load isn't available. */
const sandboxAvailable = (name: string): boolean => (require("./sandboxes") as typeof import("./sandboxes")).sandboxSeam(name) !== null;

/** §6.6.3: `label`; `budget` lowers each unit; `sandbox` a listed, available provider. */
export function applyRunPatch(p: RunCreating, patch: RunCreatePatch, isListed: (name: string) => boolean, isAvailable: (name: string) => boolean = sandboxAvailable): RunCreating {
  const options = { ...p.options };
  if (patch.label !== undefined) {
    if (typeof patch.label !== "string" || !patch.label.trim()) throw invalid("label is a non-empty string");
    options.label = patch.label.trim().slice(0, 200);
  }
  if (patch.budget !== undefined) options.budget = lowerBudget(options.budget, patch.budget);
  if (patch.sandbox !== undefined) {
    const n = String(patch.sandbox).toLowerCase();
    if (!isListed(n)) throw invalid(`sandbox ${JSON.stringify(patch.sandbox)} isn't a listed provider`);
    if (!isAvailable(n)) throw invalid(`sandbox ${JSON.stringify(n)} isn't available: no active plugin provides it`);
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

/** Contract keys only the host sets: a spawn from an agent's VM has them stripped (src/subagents/rpc.ts), and an
 *  agent.spawning patch may not add them (§6.6.6). */
export const HOST_CONTRACT_KEYS: Readonly<Record<string, string>> = {
  checks: "check commands come only from the operator",
  orphansPolicyOverride: "set only by the operator",
  review: "review mode is verify's alone",
  from: "set by --continue",
};

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
    // The keys spawnAgent checks when the spawner sends them, checked the same way when a plugin adds one (they are
    // checked before this hook): the host's own keys no agent may send (`from` is --continue's, `review` verify's,
    // `checks` the operator's), `report` is `true`, `check` is a check's name (spawnAgent looks an added one up).
    const added = patch.contract as Record<string, unknown>;
    for (const [k, why] of Object.entries(HOST_CONTRACT_KEYS)) if (Object.hasOwn(added, k) && !Object.hasOwn(was, k)) throw widening(`contract.${k}: ${why}`);
    if (Object.hasOwn(added, "report") && added.report !== true) throw invalid("contract.report must be true");
    if (Object.hasOwn(added, "check") && typeof added.check !== "string") throw invalid("contract.check must be a check name");
    spawn.contract = { ...patch.contract, ...was };
  }
  return { ...p, spawn };
}

const SKILL_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SKILL_SOURCES = ["builtin", "user", "project", "plugin"];
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
/** At most this many skills on one agent, together at most this many bytes (as on a message, src/agents/skills.ts). */
export const SKILLS_MAX = 8, SKILL_BYTES_MAX = 256 * 1024;
/** At most this many variables a plugin adds, each value at most this long. */
const ENV_MAX = 32, ENV_VALUE_MAX = 4096;
/**
 * Names a plugin never sets, even when the agent's environment doesn't have them yet: the kernel's (`CAPCOMD_*`), the
 * agent providers' families (where their CLIs send the credential and which login they read), what a shell or a runtime
 * loads before the agent's code (`LD_PRELOAD`, `NODE_OPTIONS`, `BASH_ENV`…), the proxy and certificates its traffic
 * trusts, and git's. Any one of them would steer the agent without a word of prompt text (§6.6.7).
 */
const RESERVED_ENV_PREFIXES = ["CAPCOMD_", "ANTHROPIC_", "CLAUDE_", "OPENAI_", "CODEX_", "LD_", "DYLD_", "NODE_", "NPM_CONFIG_", "PYTHON", "PERL5", "RUBY", "GIT_"];
const RESERVED_ENV = new Set(["BASH_ENV", "ENV", "SHELL", "IFS", "CDPATH", "PS4", "PROMPT_COMMAND", "ZDOTDIR", "TMPDIR", "USER", "LOGNAME",
  "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE"]);
/**
 * The agent agent.preparing fires for (src/primitives/ops.ts `agentPreparing`), its record as the kernel just read it:
 * kernel-internal, for the kernel's own listeners: the orchestration skill (src/plugins/skill-orchestration.ts), which
 * needs the agent's limits and budget the payload doesn't carry, and the context router (src/plugins/context.ts), which
 * leaves in `bundles` what its brief cites, for the attempt's runner to place (ADR-025 §6.2). A plugin's listener never
 * sees it.
 */
export const preparingAgent = new AsyncLocalStorage<{ runId: string; agentId: string; record: unknown; bundles?: unknown[] }>();

/** A name agent.preparing's `env` may not add (src/agents/config.ts drops one from an attempt's spec too). */
export const reservedEnvName = (name: string): boolean => RESERVED_ENV.has(name) || RESERVED_ENV_PREFIXES.some((p) => name.startsWith(p));
export const skillHash = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * §6.6.7: `prompt.append` after the profile's own; `skills` are added, each pinned by the sha256 of its text (a skill
 * already attached, by name, is refused); `env` adds variables whose names are new (not one the agent's environment
 * has, `p.env`, nor a reserved one, `reservedEnvName`) and whose values look like no secret (the redactor's shapes); `egress`
 * only removes hosts. The kernel attaches skills and variables to the attempt's run (src/primitives/ops.ts
 * `agentPreparing`); the payload carries a variable's name only, its value stays in the patch.
 */
export function applyPreparePatch(p: AgentPreparing, patch: PreparePatch, looksSecret: (value: string) => boolean = (v) => new Redactor().text(v) !== v): AgentPreparing {
  const next = { ...p, prompt: { ...p.prompt } };
  if (patch.env !== undefined) {
    if (!patch.env || typeof patch.env !== "object" || Array.isArray(patch.env)) throw invalid("env is an object of variable names to values");
    const add = Object.entries(patch.env);
    if (add.length > ENV_MAX) throw invalid(`env: at most ${ENV_MAX} variables from one plugin`);
    for (const [k, v] of add) {
      if (!ENV_NAME.test(k)) throw invalid(`env ${JSON.stringify(k)}: a name is upper case letters, digits and _ (^[A-Z][A-Z0-9_]*$)`);
      if (p.env.includes(k)) throw widening(`env ${k} is set already: a plugin only adds new variables`);
      if (reservedEnvName(k)) throw widening(`env ${k} is reserved: it steers the agent's provider, loader, proxy or git, which a plugin never sets`);
      if (typeof v !== "string" || v.length > ENV_VALUE_MAX) throw invalid(`env ${k}: a string of at most ${ENV_VALUE_MAX} characters`);
      if (looksSecret(v)) throw invalid(`env ${k}: its value looks like a secret; secrets reach a sandbox as placeholders, never through a plugin (§11.4)`);
    }
    next.env = [...p.env, ...add.map(([k]) => k)];
  }
  if (patch.prompt !== undefined) {
    if (!patch.prompt || typeof patch.prompt !== "object") throw invalid("prompt is an object");
    if (patch.prompt.skills !== undefined) {
      if (!Array.isArray(patch.prompt.skills)) throw invalid("prompt.skills is a list of skills");
      const skills = [...p.prompt.skills];
      for (const s of patch.prompt.skills) {
        if (!s || typeof s !== "object" || typeof s.name !== "string" || !SKILL_NAME.test(s.name)) throw invalid("a skill has a name of lowercase letters, digits, ., _ and -");
        if (typeof s.text !== "string" || !s.text.trim()) throw invalid(`skill ${s.name}: text is its SKILL.md, a non-empty string`);
        if (!SKILL_SOURCES.includes(s.source)) throw invalid(`skill ${s.name}: source is one of ${SKILL_SOURCES.join(", ")}`);
        if (s.hash !== skillHash(s.text)) throw invalid(`skill ${s.name}: hash is the sha256 of its text (pinned, src/agents/skills.ts)`);
        if (skills.some((x) => x.name === s.name)) throw invalid(`skill ${s.name} is attached already`);
        skills.push({ name: s.name, hash: s.hash, source: s.source, text: s.text });
      }
      if (skills.length > SKILLS_MAX) throw invalid(`at most ${SKILLS_MAX} skills on one agent`);
      if (skills.reduce((n, s) => n + Buffer.byteLength(s.text), 0) > SKILL_BYTES_MAX) throw invalid(`an agent's skills are at most ${SKILL_BYTES_MAX} bytes together`);
      next.prompt.skills = skills;
    }
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
