// Named agent profiles (`.capcomd/agents.json`, schema capcomd.agents/v1). ADR-015 §6.
// Each profile pins provider + exactly one auth mode + harness limits; tasks/runs select one by name.
// Env (CAPCOMD_AGENT, CAPCOMD_AGENT_*) stays an override on top.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { env as envVar } from "../utils/env";
import { defaultAgentsFile } from "../utils/home";

export const AGENTS_SCHEMA = "capcomd.agents/v1";
export type Provider = "claude" | "codex";
export type AuthMode = "apikey" | "subscription";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentSpec {
  provider: Provider;
  /** Exactly one: API key (env or boxd secret) or plan login (`capcomd auth login`). No fallback. */
  auth: AuthMode;
  description?: string;
  model?: string;
  /** Reasoning effort, one of the provider's levels (PROVIDER_EFFORTS); unset: the CLI's default. */
  effort?: string;
  /** Limits are optional (ADR-019): unset means none. An agent that reaches one is stopped and keeps its work. */
  maxTurns?: number;
  maxBudgetUsd?: number;
  timeoutMs?: number;
  /** Stop an agent whose CLI has produced no events for this long (default 30 min): a hung agent, not a long one. */
  idleAfterMs?: number;
  /** How often the in-VM supervisor checkpoints the workspace (default 10 min; a cadence, not a limit). */
  checkpointEveryMs?: number;
  stuckRepeats?: number;
  /** Opt-in: an agent that keeps working with no change in its workspace for this long is spinning (a notice; a stop
   *  after twice that). Off by default, since reading and thinking for a long time is normal. Needs the supervisor. */
  noChangeAfterMs?: number;
  /** codex --sandbox (claude ignores it; the VM is the boundary). */
  sandbox?: SandboxMode;
  /** Replaces the default egress allowlist (non-empty). */
  egress?: string[];
  /** claude: --system-prompt; codex: prepended to the prompt. */
  systemPrompt?: string;
  /** claude: --append-system-prompt; codex: appended to the instructions. */
  appendSystemPrompt?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  /** Sub-agent spawning policy (schema + validation now; runtime spawning later). */
  children?: ChildrenSpec;
}
export interface ChildrenSpec {
  /** Default false: this agent may not spawn children. */
  allowSpawn?: boolean;
  /** Max spawn depth below this agent (1 = children only). */
  maxDepth?: number;
  /** Max concurrently running children. */
  maxChildren?: number;
  /** Max children + grandchildren + … over the agent's lifetime. */
  maxTotalDescendants?: number;
  /** Profiles children may use (each must be no wider than this profile). Empty/absent = none. */
  allowedChildProfiles?: string[];
  /** Fraction (0,1] of this agent's remaining budget a single child may be given; children never exceed the parent. */
  budgetShare?: number;
}
export interface AgentsFile { schema: typeof AGENTS_SCHEMA; default?: string; agents: Record<string, AgentSpec> }

export const PROVIDER_KIND: Record<Provider, "claude-code" | "codex"> = { claude: "claude-code", codex: "codex" };

/**
 * Reasoning effort levels each provider's CLI takes, lowest to highest: claude `--effort <level>` (Claude Code
 * `--help`: low, medium, high, xhigh, max), codex `-c model_reasoning_effort=<level>`.
 */
export const PROVIDER_EFFORTS: Record<Provider, readonly string[]> = { claude: ["low", "medium", "high", "xhigh", "max"], codex: ["minimal", "low", "medium", "high"] };
/** The level a provider's CLI uses when none is set, when it is fixed (codex: medium); null: the CLI decides (claude: by model). */
export const PROVIDER_DEFAULT_EFFORT: Record<Provider, string | null> = { claude: null, codex: "medium" };

/** JSON Schema (draft 2020-12) for `.capcomd/agents.json`; `capcomd agents schema` prints it. */
export const AGENTS_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://capcomd.dev/schema/agents-v1.json",
  title: "capcomd agent profiles",
  type: "object",
  additionalProperties: false,
  required: ["schema", "agents"],
  properties: {
    schema: { const: AGENTS_SCHEMA },
    default: { type: "string", description: "Profile used when a run/task names none" },
    agents: {
      type: "object",
      propertyNames: { pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" },
      additionalProperties: { $ref: "#/$defs/agent" },
    },
  },
  $defs: {
    agent: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "auth"],
      properties: {
        provider: { enum: ["claude", "codex"] },
        auth: { enum: ["apikey", "subscription"], description: "Exactly one credential kind; no fallback" },
        description: { type: "string" },
        model: { type: "string", minLength: 1 },
        effort: { enum: ["minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning effort: claude low|medium|high|xhigh|max, codex minimal|low|medium|high" },
        maxTurns: { type: "integer", minimum: 1 },
        maxBudgetUsd: { type: "number", exclusiveMinimum: 0 },
        timeoutMs: { type: "integer", minimum: 1000 },
        idleAfterMs: { type: "integer", minimum: 1000 },
        checkpointEveryMs: { type: "integer", minimum: 1000 },
        stuckRepeats: { type: "integer", minimum: 2 },
        noChangeAfterMs: { type: "integer", minimum: 1000 },
        sandbox: { enum: ["read-only", "workspace-write", "danger-full-access"] },
        egress: { type: "array", minItems: 1, items: { type: "string", pattern: "^[A-Za-z0-9.*-]+$" } },
        systemPrompt: { type: "string" },
        appendSystemPrompt: { type: "string" },
        allowedTools: { type: "array", items: { type: "string" } },
        disallowedTools: { type: "array", items: { type: "string" } },
        children: { $ref: "#/$defs/children" },
      },
    },
    children: {
      type: "object",
      additionalProperties: false,
      description: "Sub-agent policy. Children inherit and may only narrow tools, egress and limits.",
      properties: {
        allowSpawn: { type: "boolean", default: false },
        maxDepth: { type: "integer", minimum: 1 },
        maxChildren: { type: "integer", minimum: 1 },
        maxTotalDescendants: { type: "integer", minimum: 1 },
        allowedChildProfiles: { type: "array", items: { type: "string" }, uniqueItems: true },
        budgetShare: { type: "number", exclusiveMinimum: 0, maximum: 1 },
      },
    },
  },
} as const;

export class AgentConfigError extends Error { constructor(message: string) { super(message); this.name = "AgentConfigError"; } }

const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KEYS = new Set(Object.keys(AGENTS_JSON_SCHEMA.$defs.agent.properties));

/** Validate one profile; returns errors (empty = ok). */
export function validateSpec(name: string, raw: unknown): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`agents.${name}: ${m}`);
  if (!NAME.test(name)) at("name must match ^[a-z0-9][a-z0-9_-]{0,62}$");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { at("must be an object"); return e; }
  const s = raw as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!KEYS.has(k)) at(`unknown field "${k}"`);
  // Legacy/ambiguous credential fields: both → error, never a silent choice.
  const legacyKey = "apiKey" in s || "apikey" in s, legacySub = "subscription" in s;
  if (legacyKey && legacySub) at("both an API key and a subscription are configured; set exactly one via auth: \"apikey\" | \"subscription\"");
  if (!["claude", "codex"].includes(s.provider as string)) at(`provider must be "claude" or "codex"`);
  if (s.auth === undefined) at(legacyKey || legacySub ? `use auth: "${legacyKey ? "apikey" : "subscription"}" instead of a credential field` : "auth is required (\"apikey\" or \"subscription\"): neither is configured");
  else if (!["apikey", "subscription"].includes(s.auth as string)) at(`auth must be "apikey" or "subscription"`);
  const posInt = (k: string, min = 1) => { if (s[k] !== undefined && (!Number.isInteger(s[k]) || (s[k] as number) < min)) at(`${k} must be an integer >= ${min}`); };
  posInt("maxTurns"); posInt("timeoutMs", 1000); posInt("idleAfterMs", 1000); posInt("checkpointEveryMs", 1000); posInt("stuckRepeats", 2); posInt("noChangeAfterMs", 1000);
  if (s.maxBudgetUsd !== undefined && !(typeof s.maxBudgetUsd === "number" && s.maxBudgetUsd > 0)) at("maxBudgetUsd must be > 0");
  if (s.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(s.sandbox as string)) at("sandbox is invalid");
  if (s.model !== undefined && (typeof s.model !== "string" || !s.model)) at("model must be a non-empty string");
  if (s.effort !== undefined) {
    const levels = PROVIDER_EFFORTS[s.provider as Provider];
    if (typeof s.effort !== "string" || (levels && !levels.includes(s.effort))) at(`effort must be one of ${(levels ?? []).join(", ")} for provider ${s.provider}`);
  }
  for (const k of ["egress", "allowedTools", "disallowedTools"]) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== "string" || !x)) at(`${k} must be an array of non-empty strings`);
  }
  if (Array.isArray(s.egress) && s.egress.length === 0) at("egress must not be empty (boxd treats [] as unrestricted)");
  for (const k of ["systemPrompt", "appendSystemPrompt", "description"]) if (s[k] !== undefined && typeof s[k] !== "string") at(`${k} must be a string`);
  if (s.children !== undefined) e.push(...validateChildren(name, s.children));
  return e;
}

const CHILD_KEYS = new Set(Object.keys(AGENTS_JSON_SCHEMA.$defs.children.properties));
export function validateChildren(name: string, raw: unknown): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`agents.${name}.children: ${m}`);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { at("must be an object"); return e; }
  const c = raw as Record<string, unknown>;
  for (const k of Object.keys(c)) if (!CHILD_KEYS.has(k)) at(`unknown field "${k}"`);
  if (c.allowSpawn !== undefined && typeof c.allowSpawn !== "boolean") at("allowSpawn must be a boolean");
  for (const k of ["maxDepth", "maxChildren", "maxTotalDescendants"]) if (c[k] !== undefined && (!Number.isInteger(c[k]) || (c[k] as number) < 1)) at(`${k} must be an integer >= 1`);
  if (c.budgetShare !== undefined && !(typeof c.budgetShare === "number" && c.budgetShare > 0 && c.budgetShare <= 1)) at("budgetShare must be in (0, 1]");
  if (c.allowedChildProfiles !== undefined) {
    const l = c.allowedChildProfiles;
    if (!Array.isArray(l) || l.some((x) => typeof x !== "string" || !NAME.test(x))) at("allowedChildProfiles must be profile names");
    else if (new Set(l).size !== l.length) at("allowedChildProfiles has duplicates");
  }
  if (Number.isInteger(c.maxChildren) && Number.isInteger(c.maxTotalDescendants) && (c.maxChildren as number) > (c.maxTotalDescendants as number)) at("maxChildren cannot exceed maxTotalDescendants");
  if (c.allowSpawn === true && !(Array.isArray(c.allowedChildProfiles) && c.allowedChildProfiles.length)) at("allowSpawn requires at least one allowedChildProfiles entry");
  return e;
}

const SANDBOX_RANK: Record<string, number> = { "read-only": 0, "workspace-write": 1, "danger-full-access": 2 };
const DEFAULT_SANDBOX = "workspace-write";

/**
 * Narrowing check: does `next` grant nothing beyond `base`? Returns the widenings found.
 * Limits must be <=, allow-lists subsets, deny-lists supersets, sandbox no looser,
 * children policy no broader. Unset in base = the harness default/unbounded for that field.
 */
export function widenings(base: AgentSpec, next: AgentSpec): string[] {
  const w: string[] = [];
  const le = (k: "maxTurns" | "maxBudgetUsd" | "timeoutMs" | "idleAfterMs" | "stuckRepeats" | "noChangeAfterMs") => { if (next[k] !== undefined && base[k] !== undefined && next[k]! > base[k]!) w.push(`${k} ${next[k]} > ${base[k]}`); if (base[k] !== undefined && next[k] === undefined) w.push(`${k} unset (would lift ${base[k]})`); };
  le("maxTurns"); le("maxBudgetUsd"); le("timeoutMs"); le("idleAfterMs"); le("stuckRepeats"); le("noChangeAfterMs");
  if (next.provider !== base.provider) w.push(`provider ${base.provider} → ${next.provider}`);
  if (next.auth !== base.auth) w.push(`auth ${base.auth} → ${next.auth}`);
  if (SANDBOX_RANK[next.sandbox ?? DEFAULT_SANDBOX]! > SANDBOX_RANK[base.sandbox ?? DEFAULT_SANDBOX]!) w.push(`sandbox ${base.sandbox ?? DEFAULT_SANDBOX} → ${next.sandbox}`);
  const subset = (k: "egress" | "allowedTools") => {
    if (base[k] === undefined) return; // default list; a custom list is checked at runtime against the default
    if (next[k] === undefined) { w.push(`${k} unset (would restore the default list)`); return; }
    const extra = next[k]!.filter((x) => !base[k]!.includes(x));
    if (extra.length) w.push(`${k} adds ${extra.join(",")}`);
  };
  subset("egress"); subset("allowedTools");
  if (base.disallowedTools) {
    const dropped = base.disallowedTools.filter((x) => !(next.disallowedTools ?? []).includes(x));
    if (dropped.length) w.push(`disallowedTools drops ${dropped.join(",")}`);
  }
  const bc = base.children ?? {}, nc = next.children ?? {};
  if (nc.allowSpawn && !bc.allowSpawn) w.push("children.allowSpawn false → true");
  for (const k of ["maxDepth", "maxChildren", "maxTotalDescendants", "budgetShare"] as const) {
    if (nc[k] !== undefined && bc[k] !== undefined && nc[k]! > bc[k]!) w.push(`children.${k} ${nc[k]} > ${bc[k]}`);
    if (bc[k] !== undefined && nc[k] === undefined && nc.allowSpawn) w.push(`children.${k} unset (would lift ${bc[k]})`);
  }
  const extraKids = (nc.allowedChildProfiles ?? []).filter((x) => !(bc.allowedChildProfiles ?? []).includes(x));
  if (extraKids.length) w.push(`children.allowedChildProfiles adds ${extraKids.join(",")}`);
  return w;
}

export function validateFile(raw: unknown): string[] {
  if (!raw || typeof raw !== "object") return ["file must be a JSON object"];
  const f = raw as Record<string, any>;
  const e: string[] = [];
  if (f.schema !== AGENTS_SCHEMA) e.push(`schema must be "${AGENTS_SCHEMA}"`);
  for (const k of Object.keys(f)) if (!["schema", "default", "agents", "$schema"].includes(k)) e.push(`unknown top-level field "${k}"`);
  if (!f.agents || typeof f.agents !== "object") e.push("agents must be an object");
  else for (const [n, s] of Object.entries(f.agents)) e.push(...validateSpec(n, s));
  if (f.default !== undefined && !f.agents?.[f.default]) e.push(`default "${f.default}" is not a defined agent`);
  if (!e.length && f.agents) {
    for (const [n, s] of Object.entries(f.agents as Record<string, AgentSpec>)) {
      for (const c of s.children?.allowedChildProfiles ?? []) {
        const child = f.agents[c] as AgentSpec | undefined;
        if (!child) { e.push(`agents.${n}.children.allowedChildProfiles: "${c}" is not a defined agent`); continue; }
        if (c === n && s.children?.allowSpawn) continue; // self-similar children are narrowing by definition
        // Children inherit from the parent and may only narrow (provider/auth may differ: each child has its own credential).
        const w = widenings({ ...s, provider: child.provider, auth: child.auth }, child).filter((x) => !x.startsWith("children."));
        if (w.length) e.push(`agents.${n}.children: child profile "${c}" is wider than its parent (${w.join("; ")})`);
      }
    }
  }
  return e;
}

export function agentsFilePath(source: Record<string, string | undefined> = process.env): string {
  return envVar("AGENTS_FILE", source) ?? defaultAgentsFile(source);
}
export function readAgentsFile(path = agentsFilePath()): AgentsFile {
  if (!existsSync(path)) return { schema: AGENTS_SCHEMA, agents: {} };
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch (e) { throw new AgentConfigError(`${path}: invalid JSON (${(e as Error).message})`); }
  const errs = validateFile(raw);
  if (errs.length) throw new AgentConfigError(`${path}: ${errs.join("; ")}`);
  return raw as AgentsFile;
}
export function writeAgentsFile(f: AgentsFile, path = agentsFilePath()) {
  const errs = validateFile(f);
  if (errs.length) throw new AgentConfigError(errs.join("; "));
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify({ $schema: AGENTS_JSON_SCHEMA.$id, ...f }, null, 2) + "\n");
  renameSync(tmp, path);
}

export interface ResolvedAgent { name: string | null; kind: "fake" | "claude-code" | "codex"; spec?: AgentSpec; overridden?: boolean }

/**
 * Which agent runs: explicit profile name (task/run) → CAPCOMD_AGENT (profile name or provider
 * kind; env override) → the file's default → fake.
 */
export function resolveAgent(name?: string | null, source: Record<string, string | undefined> = process.env, pinned?: unknown): ResolvedAgent {
  const p = pinnedAgent(name, pinned);
  if (p) return p;
  const file = readAgentsFile(agentsFilePath(source));
  const pick = (n: string): ResolvedAgent | null => {
    const spec = file.agents[n];
    return spec ? { name: n, kind: PROVIDER_KIND[spec.provider], spec } : null;
  };
  if (name) {
    const ref = decodeAgentRef(name);
    name = ref.name;
    const r = pick(name);
    // An operator override may change the provider (`capcomd run --planner-provider`): the runner follows it.
    if (r && ref.overrides) { const spec = applyOverrides(name, r.spec!, ref.overrides); return { ...r, kind: PROVIDER_KIND[spec.provider], spec, overridden: true }; }
    if (!r) throw new AgentConfigError(`unknown agent profile "${name}" (defined: ${Object.keys(file.agents).join(", ") || "none"}; add one with \`capcomd agents add\`)`);
    return r;
  }
  const env = envVar("AGENT", source)?.trim();
  if (env) {
    const v = env.toLowerCase();
    if (v === "fake" || v === "claude-code" || v === "codex") return { name: null, kind: v };
    if (v === "claude") return { name: null, kind: "claude-code" };
    const r = pick(env);
    if (r) return r;
    throw new AgentConfigError(`Unknown CAPCOMD_AGENT=${env} (expected fake|claude-code|codex or a profile name)`);
  }
  if (file.default) return pick(file.default)!;
  return { name: null, kind: "fake" };
}

/**
 * The spec an agent was spawned with, as recorded with it (the scope's agent record, or a task of the legacy plan):
 * its profile with the ref's overrides applied, plus `kind`. The engine side resolves an agent from it: the process
 * that runs the worker (the daemon) need not see the project's agents file, and its own may define the name otherwise
 * or not at all; a provider swap (`--planner-provider`) is in it too. Null when there is none usable (older records):
 * the caller resolves by name.
 */
export function pinnedAgent(ref: string | null | undefined, pinned: unknown): ResolvedAgent | null {
  if (!pinned || typeof pinned !== "object" || Array.isArray(pinned)) return null;
  const { kind, ...rest } = pinned as Record<string, unknown>;
  const decoded = ref ? decodeAgentRef(ref) : null;
  const name = decoded?.name ?? null;
  if (kind === "fake" && rest.provider === undefined) return { name, kind: "fake" };
  const spec = rest as unknown as AgentSpec;
  if (spec.provider !== "claude" && spec.provider !== "codex") return null;
  if (spec.auth !== "apikey" && spec.auth !== "subscription") return null;
  return { name, kind: PROVIDER_KIND[spec.provider], spec, ...(decoded?.overrides ? { overridden: true } : {}) };
}
/** What to record with an agent so the engine can resolve it without the agents file (see pinnedAgent). */
export function pinSpec(r: ResolvedAgent): Record<string, unknown> {
  return { ...((r.spec ?? {}) as unknown as Record<string, unknown>), kind: r.kind };
}

/** Goal directive `[agent:NAME] …` selects a profile for that run/task. */
export function parseAgentDirective(goal: string): { agent?: string; goal: string } {
  const m = /^\s*\[agent:([a-z0-9][a-z0-9_-]{0,62}(?:;[A-Za-z0-9=_\-]+)*)\]\s*/i.exec(goal);
  return m ? { agent: m[1]!.replace(/^[^;]+/, (n) => n.toLowerCase()), goal: goal.slice(m[0].length) } : { goal };
}


// ---- Per-run overrides (`capcomd run --profile X --set k=v`, or JSON) ----

/** `a.b=v` pairs → nested object; values parse as JSON, else comma lists for list fields, else strings. */
export function parseSetPairs(pairs: string[]): Record<string, unknown> {
  const LISTS = new Set(["egress", "allowedTools", "disallowedTools", "children.allowedChildProfiles"]);
  const out: Record<string, any> = {};
  for (const pair of pairs) {
    const i = pair.indexOf("=");
    if (i <= 0) throw new AgentConfigError(`--set expects key=value, got "${pair}"`);
    const key = pair.slice(0, i).trim(), raw = pair.slice(i + 1);
    let v: unknown;
    try { v = JSON.parse(raw); } catch { v = LISTS.has(key) ? raw.split(",").map((x) => x.trim()).filter(Boolean) : raw; }
    if (LISTS.has(key) && typeof v === "string") v = v.split(",").map((x) => x.trim()).filter(Boolean);
    const parts = key.split(".");
    let o = out;
    for (const p of parts.slice(0, -1)) o = o[p] ??= {};
    o[parts[parts.length - 1]!] = v;
  }
  return out;
}

export interface Overrides { set: Record<string, unknown>; operator?: boolean }

/** Merge overrides onto a profile; they may only narrow it unless `operator` is set. */
export function applyOverrides(name: string, base: AgentSpec, ov: Overrides): AgentSpec {
  const { children: ch, ...rest } = ov.set as Record<string, any>;
  const next = { ...base, ...rest, ...(ch !== undefined ? { children: { ...(base.children ?? {}), ...ch } } : {}) } as AgentSpec;
  for (const [k, v] of Object.entries(next)) if (v === null) delete (next as any)[k];
  const errs = validateSpec(name, next);
  if (errs.length) throw new AgentConfigError(`override invalid: ${errs.join("; ")}`);
  if (!ov.operator) {
    const w = widenings(base, next);
    if (w.length) throw new AgentConfigError(`override would widen profile "${name}" (${w.join("; ")}); overrides may only narrow unless --operator is given`);
  }
  return next;
}

/**
 * Opaque agent reference carried through goal → planner → worker: `name` or
 * `name;ov=<base64url JSON>[;op=1]`.
 */
export function encodeAgentRef(name: string, ov?: Overrides): string {
  if (!ov || !Object.keys(ov.set).length) return name;
  return `${name};ov=${Buffer.from(JSON.stringify(ov.set)).toString("base64url")}${ov.operator ? ";op=1" : ""}`;
}
export function decodeAgentRef(ref: string): { name: string; overrides?: Overrides } {
  const [name, ...parts] = ref.split(";");
  let set: Record<string, unknown> | undefined, operator = false;
  for (const p of parts) {
    if (p.startsWith("ov=")) { try { set = JSON.parse(Buffer.from(p.slice(3), "base64url").toString("utf8")); } catch { throw new AgentConfigError(`bad agent override in "${ref}"`); } }
    else if (p === "op=1") operator = true;
  }
  return { name: name!, ...(set ? { overrides: { set, operator } } : {}) };
}

/** Effective, fully resolved agent spec for the event log (no credentials, only modes). */
export function effectiveAgentRecord(ref?: string | null, source: Record<string, string | undefined> = process.env, pinned?: unknown): Record<string, unknown> {
  try {
    const ra = resolveAgent(ref, source, pinned);
    if (ra.kind === "fake") return { kind: "fake" };
    const { loadAgentConfig } = require("./config") as typeof import("./config");
    const c = loadAgentConfig(source, ref, pinned);
    return {
      name: ra.name, kind: ra.kind, overridden: !!ra.overridden, operator: ref ? !!decodeAgentRef(ref).overrides?.operator : false,
      auth: c.credentialMode === "subscription" ? "subscription" : "apikey", credentialMode: c.credentialMode,
      model: c.model ?? null, effort: c.effort ?? null, maxTurns: c.maxTurns ?? null, maxBudgetUsd: c.maxBudgetUsd ?? null, timeoutMs: c.timeoutMs ?? null, idleAfterMs: c.idleAfterMs, stuckRepeats: c.stuckRepeats, noChangeAfterMs: c.noChangeAfterMs || null, checkpointEveryMs: c.checkpointEveryMs,
      sandbox: c.codexSandbox, egress: c.egress, allowedTools: c.allowedTools ?? null, disallowedTools: c.disallowedTools,
      systemPrompt: !!c.systemPrompt, appendSystemPrompt: !!c.appendSystemPrompt,
      children: { allowSpawn: false, ...(ra.spec?.children ?? {}) },
    };
  } catch (e) {
    return { error: (e as Error).message };
  }
}
