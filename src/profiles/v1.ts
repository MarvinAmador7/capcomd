// The flat agent spec (`.capcomd/agents.json`, schema capcomd.agents/v1; ADR-015 §6): what every profile resolves to
// and what an agent is pinned with at spawn, v2 profiles included (ADR-024 §2.1, ./v2.ts). Each pins a provider,
// exactly one auth mode and harness limits; tasks and runs select one by name. Env (CAPCOMD_AGENT, CAPCOMD_AGENT_*)
// stays an override on top.
import { agentProviderNames, agentSeam, kindOf, unknownProviderText } from "../plugins/agents";
import type { ContextSpec } from "../../packages/plugin/src/context-layer";

export const AGENTS_SCHEMA = "capcomd.agents/v1";
/** An active agent provider's name (docs/spec/plugin-api.md §7.3; ADR-024 `harness.provider`): the built-ins are
 *  `claude` and `codex`, each its own plugin; another plugin may add one. Checked at validation, never at spawn. */
export type Provider = string;
export type ToolMode = "execute" | "orchestrate";
export type AuthMode = "apikey" | "subscription";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export interface AgentSpec {
  provider: Provider;
  /** Exactly one: API key (env or boxd secret) or plan login (`capcomd auth login`). No fallback. */
  auth: AuthMode;
  description?: string;
  model?: string;
  /** Reasoning effort, one of the provider's levels (its describe().efforts); unset: the CLI's default. */
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
  /** docs/spec/plugin-api.md §16.1 (ADR-024 `tools.mode`): `orchestrate` routes, plans, spawns and decides, and never
   *  edits files, runs work commands or pushes (its provider's tool policy, and capcomd refusing to verify or merge
   *  its own ref). Needs children.allowSpawn. Default `execute`. */
  toolMode?: ToolMode;
  /** docs/spec/plugin-api.md §16.2 (ADR-024 `jobs`): its background jobs (`capcomd job start`): how long a start waits
   *  for the result (default 60 s; 5 s for orchestrate), how many may run at once (8), and how long one may run
   *  (30 min). Unset: the daemon's CAPCOMD_JOBS_* or those defaults. */
  jobs?: JobsSpec;
  /** ADR-025 §10 (v2 `context`; ADR-024's `memory` is read as it): the context providers the kernel's router briefs the
   *  agent from at start (an index of the project's memory and facts, never their bodies), and their budgets. */
  context?: ContextSpec;
}
export interface JobsSpec { foregroundMs?: number; max?: number; afterTurnMs?: number }
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
export interface AgentsFile {
  schema: typeof AGENTS_SCHEMA; default?: string; agents: Record<string, AgentSpec>;
  /** A note for whoever opens the file (`capcomd profiles migrate` says where its profiles went); capcomd ignores it. */
  $comment?: string;
}

/** The runner's kind for a provider (`claude-code` for claude; another provider's is its name). */
export const providerKind = (p: Provider): string => kindOf(p);
/** Reasoning effort levels the provider's CLI takes, lowest to highest (its `describe().efforts`); [] when not active. */
export const providerEfforts = (p: Provider): readonly string[] => agentSeam(p)?.describe().efforts ?? [];
/** The level a provider's CLI uses when none is set, when it is fixed (codex: medium); null: the CLI decides (claude: by model). */
export const providerDefaultEffort = (p: Provider): string | null => agentSeam(p)?.describe().defaultEffort ?? null;

/** JSON Schema (draft 2020-12) for `.capcomd/agents.json`; `capcomd profiles schema v1` prints it. */
export const AGENTS_JSON_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://capcomd.dev/schema/agents-v1.json",
  title: "capcomd agent profiles",
  type: "object",
  additionalProperties: false,
  required: ["schema", "agents"],
  properties: {
    schema: { const: AGENTS_SCHEMA },
    $comment: { type: "string", description: "A note for whoever opens the file; capcomd ignores it (capcomd profiles migrate leaves one)" },
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
        provider: { type: "string", minLength: 1, examples: ["claude", "codex"], description: "An active agent provider: claude and codex are built in; a plugin may add another (capcomd plugins list)" },
        auth: { enum: ["apikey", "subscription"], description: "Exactly one credential kind; no fallback" },
        description: { type: "string" },
        model: { type: "string", minLength: 1 },
        effort: { type: "string", minLength: 1, examples: ["minimal", "low", "medium", "high", "xhigh", "max"], description: "Reasoning effort, one of the provider's levels: claude low|medium|high|xhigh|max, codex minimal|low|medium|high" },
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
        toolMode: { enum: ["execute", "orchestrate"], default: "execute", description: "orchestrate: reads, spawns and decides; never edits files, runs work commands or pushes (needs children.allowSpawn)" },
        jobs: { $ref: "#/$defs/jobs" },
        context: { $ref: "#/$defs/context" },
      },
    },
    jobs: {
      type: "object",
      additionalProperties: false,
      description: "Background jobs (`capcomd job start`): a long command answers \"running\" after foregroundMs and its result comes as a message.",
      properties: {
        foregroundMs: { type: "integer", minimum: 0, description: "How long a start waits for the result before answering running (default 60000; 5000 for orchestrate)" },
        max: { type: "integer", minimum: 1, description: "Jobs running at once (default 8)" },
        afterTurnMs: { type: "integer", minimum: 1000, description: "How long a job may run before it is stopped (default 1800000)" },
      },
    },
    context: {
      type: "object",
      additionalProperties: false,
      description: "What the agent is briefed with at start (ADR-025): an index of the project's memory and facts from these context providers, never their bodies",
      properties: {
        providers: { type: "array", items: { type: "object", required: ["name"], properties: { name: { type: "string", pattern: "^[a-z0-9][a-z0-9_-]{0,62}$" }, layers: { type: "array", items: { enum: ["project", "run"] }, uniqueItems: true } }, description: "A context provider (capcomd plugins list) and its own settings" } },
        limits: { type: "object", additionalProperties: false, properties: Object.fromEntries(["briefBytes", "indexLines", "descriptionChars", "itemBytes", "proposalsPerRun"].map((k) => [k, { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] }])), description: "The brief's budgets; null: the eval's default for the model" },
        review: { enum: ["human", "lint"] },
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

export const NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
const KEYS = new Set(Object.keys(AGENTS_JSON_SCHEMA.$defs.agent.properties));

/**
 * How validation names what it reports on: v1 says `agents.<name>: maxTurns …`; a resolved v2 profile says
 * `profiles.<name>: limits.maxTurns …` (`key` maps a flat field to where it is written, ./v2.ts `V2_PATH`).
 */
export interface SpecLabels { prefix: string; key?: (field: string) => string }

/** Validate one profile; returns errors (empty = ok). */
export function validateSpec(name: string, raw: unknown, labels: SpecLabels = { prefix: `agents.${name}` }): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`${labels.prefix}: ${m}`);
  const k$ = labels.key ?? ((k: string) => k);
  if (!NAME.test(name)) at("name must match ^[a-z0-9][a-z0-9_-]{0,62}$");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) { at("must be an object"); return e; }
  const s = raw as Record<string, unknown>;
  for (const k of Object.keys(s)) if (!KEYS.has(k)) at(`unknown field "${k}"`);
  // Legacy/ambiguous credential fields: both → error, never a silent choice.
  const legacyKey = "apiKey" in s || "apikey" in s, legacySub = "subscription" in s;
  if (legacyKey && legacySub) at("both an API key and a subscription are configured; set exactly one via auth: \"apikey\" | \"subscription\"");
  if (s.provider === undefined && labels.key) at(`${k$("provider")} is required (${agentProviderNames().join(", ")}, or a plugin's agent provider)`);
  else if (typeof s.provider !== "string" || !agentProviderNames().includes(s.provider)) at(unknownProviderText(s.provider));
  if (s.auth === undefined) at(legacyKey || legacySub ? `use auth: "${legacyKey ? "apikey" : "subscription"}" instead of a credential field` : `${k$("auth")} is required ("apikey" or "subscription"): neither is configured`);
  else if (!["apikey", "subscription"].includes(s.auth as string)) at(`${k$("auth")} must be "apikey" or "subscription"`);
  const posInt = (k: string, min = 1) => { if (s[k] !== undefined && (!Number.isInteger(s[k]) || (s[k] as number) < min)) at(`${k$(k)} must be an integer >= ${min}`); };
  posInt("maxTurns"); posInt("timeoutMs", 1000); posInt("idleAfterMs", 1000); posInt("checkpointEveryMs", 1000); posInt("stuckRepeats", 2); posInt("noChangeAfterMs", 1000);
  if (s.maxBudgetUsd !== undefined && !(typeof s.maxBudgetUsd === "number" && Number.isFinite(s.maxBudgetUsd) && s.maxBudgetUsd > 0)) at(`${k$("maxBudgetUsd")} must be > 0`);
  if (s.sandbox !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(s.sandbox as string)) at(`${k$("sandbox")} is invalid`);
  if (s.model !== undefined && (typeof s.model !== "string" || !s.model)) at(`${k$("model")} must be a non-empty string`);
  if (s.effort !== undefined) {
    const levels = typeof s.provider === "string" ? agentSeam(s.provider)?.describe().efforts : undefined;
    if (typeof s.effort !== "string" || (levels && !levels.includes(s.effort))) at(`${k$("effort")} must be one of ${(levels ?? []).join(", ")} for provider ${s.provider}`);
  }
  for (const k of ["egress", "allowedTools", "disallowedTools"]) {
    if (s[k] === undefined) continue;
    if (!Array.isArray(s[k]) || (s[k] as unknown[]).some((x) => typeof x !== "string" || !x)) at(`${k$(k)} must be an array of non-empty strings`);
  }
  if (Array.isArray(s.egress) && s.egress.length === 0) at(`${k$("egress")} must not be empty (boxd treats [] as unrestricted)`);
  for (const k of ["systemPrompt", "appendSystemPrompt", "description"]) if (s[k] !== undefined && typeof s[k] !== "string") at(`${k$(k)} must be a string`);
  if (s.children !== undefined) e.push(...validateChildren(name, s.children, `${labels.prefix}.children`));
  if (s.jobs !== undefined) {
    const j = s.jobs as Record<string, unknown>;
    if (!j || typeof j !== "object" || Array.isArray(j)) at(`${k$("jobs")} must be an object`);
    else {
      for (const k of Object.keys(j)) if (!Object.hasOwn(AGENTS_JSON_SCHEMA.$defs.jobs.properties, k)) at(`${k$("jobs")}: unknown field "${k}"`);
      for (const [k, min] of [["foregroundMs", 0], ["max", 1], ["afterTurnMs", 1000]] as const) if (j[k] !== undefined && (!Number.isInteger(j[k]) || (j[k] as number) < min)) at(`${k$("jobs")}.${k} must be an integer >= ${min}`);
    }
  }
  if (s.toolMode !== undefined && s.toolMode !== "execute" && s.toolMode !== "orchestrate") at(`${k$("toolMode")} must be "execute" or "orchestrate"`);
  if (s.context !== undefined) {
    if (!s.context || typeof s.context !== "object" || Array.isArray(s.context)) at("context must be an object");
    else e.push(...validateContext(s.context as Record<string, unknown>).map((m) => `${labels.prefix}: ${m}`));
  }
  // §16.1: an orchestrator with no children can do nothing.
  if (s.toolMode === "orchestrate" && (s.children as ChildrenSpec | undefined)?.allowSpawn !== true) at(`${k$("toolMode")} orchestrate needs children.allowSpawn: an orchestrate agent does its work through the agents it spawns`);
  return e;
}

/** ADR-025 §6.4 `ContextLimits`: null is the eval's default for the profile's model. */
export const CONTEXT_LIMITS = ["briefBytes", "indexLines", "descriptionChars", "itemBytes", "proposalsPerRun"] as const;
const CONTEXT_KEYS = ["providers", "limits", "review"];
const LAYERS = ["project", "run"];
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** A `context` block (ADR-025 §10): `providers` (each a provider's name, the layers it reads and its own settings),
 *  `limits`, `review`. Messages name the field from `context.`. */
export function validateContext(c: Record<string, unknown>): string[] {
  const e: string[] = [];
  for (const k of Object.keys(c)) if (!CONTEXT_KEYS.includes(k)) e.push(`context.${k}: unknown field (${CONTEXT_KEYS.join(", ")})`);
  if (c.providers != null) {
    if (!Array.isArray(c.providers) || c.providers.some((p) => !isMap(p) || typeof p.name !== "string" || !NAME.test(p.name))) e.push("context.providers: must be a list of { name: <a context provider>, … its settings }");
    else {
      const names = c.providers.map((p) => (p as { name: string }).name);
      const twice = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
      if (twice.length) e.push(`context.providers: names ${twice.join(", ")} more than once`);
      for (const p of c.providers as Array<Record<string, unknown>>)
        if (p.layers !== undefined && !(Array.isArray(p.layers) && p.layers.length && p.layers.every((l) => LAYERS.includes(l as string)) && new Set(p.layers).size === p.layers.length))
          e.push(`context.providers.${p.name}.layers: must be a list of ${LAYERS.join(", ")} (the layers that exist, ADR-025 §4)`);
    }
  }
  if (c.limits != null) {
    if (!isMap(c.limits)) e.push("context.limits: must be a map");
    else for (const [k, v] of Object.entries(c.limits)) {
      if (!(CONTEXT_LIMITS as readonly string[]).includes(k)) e.push(`context.limits.${k}: unknown field (${CONTEXT_LIMITS.join(", ")})`);
      else if (v !== null && !(Number.isInteger(v) && (v as number) >= 1)) e.push(`context.limits.${k}: must be an integer >= 1, or null for the default`);
    }
  }
  if (c.review != null && c.review !== "human" && c.review !== "lint") e.push(`context.review: must be "human" or "lint"`);
  return e;
}

const CHILD_KEYS = new Set(Object.keys(AGENTS_JSON_SCHEMA.$defs.children.properties));
export function validateChildren(name: string, raw: unknown, prefix = `agents.${name}.children`): string[] {
  const e: string[] = [];
  const at = (m: string) => e.push(`${prefix}: ${m}`);
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
 * Whether a profile can lead (spawn helpers), in plain words for a driver choosing a team shape: "up to 3 worker
 * helpers, one level"; null when it can't spawn (then fan-out in `children` on its spawn is refused: it would do nothing).
 */
export function leadText(s: Pick<AgentSpec, "children">): string | null {
  const c = s.children;
  if (!c?.allowSpawn || !c.allowedChildProfiles?.length) return null;
  const who = c.allowedChildProfiles.join(" or ");
  const many = c.maxChildren === undefined ? `any number of ${who} helpers` : `up to ${c.maxChildren} ${who} helper${c.maxChildren === 1 ? "" : "s"}`;
  const depth = c.maxDepth === undefined ? "any depth" : c.maxDepth === 1 ? "one level" : `${c.maxDepth} levels`;
  return `${many}, ${depth}`;
}

/**
 * What `toolMode: orchestrate` means for whoever gives the agent a task (plugin API §16.1), in plain words: the
 * profile descriptions (capcomd_profiles, `capcomd profiles list`), the planner's brief and the orchestration skill say it.
 */
export const ORCHESTRATE_TEXT = "It orchestrates: it sees everything (the code, git history and any branch, every agent's logs, verify and merge reports with their full check output) and runs nothing (no edits, commits, installs, builds or tests), so give it no task that needs it to run code itself (its helpers write and test the code). Checks run at verify and merge, and their results are readable; capcomd check runs them on the combined code when it asks";

/**
 * Whether an allow-list leaves the agent read-only: it names tools, none of them edits files, and its shell, if any,
 * is limited to commands (`Bash(bun test:*)`, as `capcomd setup` gives a reviewer). A plain `Bash` (or `Bash(*)`)
 * can write any file.
 */
export function readOnlyTools(allowed: readonly string[] | undefined): boolean {
  return !!allowed?.length && !allowed.some((t) => /^(Edit|Write|MultiEdit|NotebookEdit)\b/.test(t) || /^Bash(\((:?\*)?\))?$/.test(t.trim()));
}

/**
 * Whether the profile can't edit files, from what its provider applies: Claude Code its tool allow-list
 * (readOnlyTools; it ignores `sandbox.codex`), Codex its own sandbox (`sandbox.codex: read-only`; it has no per-tool
 * allow-list, so `tools.allowed` doesn't limit it). Another provider's: not known, so not read-only. No provider (a
 * bare spec): its allow-list.
 */
export function readOnlySpec(s: { provider?: string; allowedTools?: readonly string[]; sandbox?: string }): boolean {
  const kind = s.provider === undefined ? "claude-code" : kindOf(s.provider);
  return kind === "claude-code" ? readOnlyTools(s.allowedTools) : kind === "codex" ? s.sandbox === "read-only" : false;
}

/** What a profile is for, in plain words (capcomd_profiles, `capcomd profiles list`). */
export function abilityText(s: Pick<AgentSpec, "children" | "allowedTools"> & Partial<Pick<AgentSpec, "provider" | "sandbox">> & { toolMode?: string }): string {
  const lead = leadText(s);
  const mode = s.toolMode === "orchestrate" ? `. ${ORCHESTRATE_TEXT}` : "";
  if (lead) return `leads a part: spawns ${lead}, and verifies and merges their work (spawn it with children: {maxChildren, maxDepth} to size it)${mode}`;
  return readOnlySpec(s) ? "reads and runs its allowed commands (read-only: a reviewer); can't spawn helpers" : "does its task itself; can't spawn helpers (fan-out for it is refused)";
}

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
  // §16.1: the mode is a limit; an orchestrate agent's override or patch can't give it back its tools.
  if (base.toolMode === "orchestrate" && next.toolMode !== "orchestrate") w.push(`toolMode orchestrate → ${next.toolMode ?? "execute"}`);
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
  // ADR-025 §8: what an agent is briefed with is its profile's; an override may drop it, never add or change it.
  if (next.context !== undefined && JSON.stringify(next.context) !== JSON.stringify(base.context)) w.push("context changed (only the profile sets it; an override may only remove it)");
  return w;
}

export function validateFile(raw: unknown): string[] {
  const e = validateFileShape(raw);
  if (!e.length) e.push(...childNarrowing((raw as AgentsFile).agents));
  return e;
}

/** Everything validateFile checks but the parent → child narrowing, which runs on resolved specs (`childNarrowing`).
 *  `defined`: the names a `default` may name (the v2 loader passes every profile it resolved). */
export function validateFileShape(raw: unknown, defined?: (name: string) => boolean): string[] {
  if (!raw || typeof raw !== "object") return ["file must be a JSON object"];
  const f = raw as Record<string, any>;
  const e: string[] = [];
  if (f.schema !== AGENTS_SCHEMA) e.push(`schema must be "${AGENTS_SCHEMA}"`);
  for (const k of Object.keys(f)) if (!["schema", "default", "agents", "$schema", "$comment"].includes(k)) e.push(`unknown top-level field "${k}"`);
  if (f.$comment !== undefined && typeof f.$comment !== "string") e.push("$comment must be a string");
  if (!f.agents || typeof f.agents !== "object") e.push("agents must be an object");
  else for (const [n, s] of Object.entries(f.agents)) e.push(...validateSpec(n, s));
  if (f.default !== undefined && !(defined ? defined(f.default) : f.agents?.[f.default])) e.push(`default "${f.default}" is not a defined agent`);
  return e;
}

/**
 * Narrowing down the spawn relation, on resolved specs (ADR-024 §2.3): each `allowedChildProfiles` entry must exist and
 * be no wider than the profile that may spawn it. `extends` is authoring, not delegation, so it is never checked here.
 * `label`: how a profile is named in an error (`agents.<name>`, or `profiles.<name>` for a v2 one).
 */
export function childNarrowing(agents: Record<string, AgentSpec>, label = (n: string) => `agents.${n}`): string[] {
  const e: string[] = [];
  for (const [n, s] of Object.entries(agents)) {
    for (const c of s.children?.allowedChildProfiles ?? []) {
      const child = Object.hasOwn(agents, c) ? agents[c] : undefined;
      if (!child) { e.push(`${label(n)}.children.allowedChildProfiles: "${c}" is not a defined agent`); continue; }
      if (c === n && s.children?.allowSpawn) continue; // self-similar children are narrowing by definition
      // Children inherit from the parent and may only narrow (provider/auth may differ: each child has its own credential;
      // so may the tool mode: an orchestrator's children do the work; and its context: each profile is briefed with its own,
      // ADR-025 D12).
      const w = widenings({ ...s, provider: child.provider, auth: child.auth, toolMode: child.toolMode, context: child.context }, child).filter((x) => !x.startsWith("children."));
      if (w.length) e.push(`${label(n)}.children: child profile "${c}" is wider than its parent (${w.join("; ")})`);
    }
  }
  return e;
}

