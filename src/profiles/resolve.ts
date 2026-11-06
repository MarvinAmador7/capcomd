// Which profile an agent runs and with what (ADR-024 §2.3, §3): resolution by name (explicit, CAPCOMD_AGENT, the
// default), the spec pinned on the agent at spawn, per-run and per-spawn overrides (`--set`, `--overrides`) and the
// agent ref that carries them from goal to planner to worker (`name;ov=…[;op=1]`).
import { agentProviderNames, agentSeam, kindOf, unknownProviderText } from "../plugins/agents";
import { env as envVar } from "../utils/env";
import { agentsFilePath, readProfiles, type ProfileLayer } from "./load";
import type { ProfileSkill } from "./skills";
import { AgentConfigError, validateSpec, widenings, type AgentSpec } from "./v1";
import { LIST_PATHS, flatOverrides } from "./v2";

export interface ResolvedAgent {
  name: string | null; kind: "fake" | (string & {}); spec?: AgentSpec; overridden?: boolean;
  /** The profile resolved by name (absent for a pinned spec, or no profile): its version and where it came from. */
  profile?: { name: string; version: number; source: ProfileLayer };
  /** Its `permissions` block, when it has one (ADR-024 §2.2): `report: false` refuses a spawn with report. Not pinned. */
  permissions?: { report?: boolean };
  /** Its profile's skills (./skills.ts), resolved by name: pinned on the agent at spawn (src/primitives/ops.ts
   *  `spawnAgent`), its spec's `skills` then. */
  skills?: ProfileSkill[];
}

/**
 * Which agent runs: explicit profile name (task/run) → CAPCOMD_AGENT (profile name or provider
 * kind; env override) → the default profile → fake.
 */
export function resolveAgent(name?: string | null, source: Record<string, string | undefined> = process.env, pinned?: unknown): ResolvedAgent {
  const p = pinnedAgent(name, pinned);
  if (p) return p;
  const file = readProfiles(agentsFilePath(source), source);
  const pick = (n: string): ResolvedAgent | null => {
    const r = Object.hasOwn(file.profiles, n) ? file.profiles[n]! : null;
    if (!r) return null;
    const pm = r.manifest.permissions as { report?: unknown } | undefined;
    const permissions = pm && typeof pm === "object" && typeof pm.report === "boolean" ? { permissions: { report: pm.report } } : {};
    return { name: n, kind: kindOf(r.spec.provider), spec: r.spec, profile: { name: n, version: r.version, source: r.source }, ...permissions, ...(r.skills.length ? { skills: r.skills } : {}) };
  };
  if (name) {
    const ref = decodeAgentRef(name);
    name = ref.name;
    const r = pick(name);
    // An operator override may change the provider (`capcomd run --planner-provider`): the runner follows it.
    if (r && ref.overrides) { const spec = applyOverrides(name, r.spec!, ref.overrides); return { ...r, kind: kindOf(spec.provider), spec, overridden: true }; }
    if (!r) throw new AgentConfigError(`unknown agent profile "${name}" (defined: ${Object.keys(file.agents).join(", ") || "none"}; add one with \`capcomd profiles add\`)`);
    return r;
  }
  const env = envVar("AGENT", source)?.trim();
  if (env) {
    const v = env.toLowerCase();
    if (v === "fake") return { name: null, kind: v };
    // A provider by its runner kind (claude-code, codex) or its name (claude).
    const provider = agentProviderNames().find((n) => n === v || kindOf(n) === v);
    if (provider) return { name: null, kind: kindOf(provider) };
    const r = pick(env);
    if (r) return r;
    throw new AgentConfigError(`Unknown CAPCOMD_AGENT=${env} (expected fake|${agentProviderNames().map(kindOf).join("|")} or a profile name)`);
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
  if (typeof spec.provider !== "string" || !spec.provider) return null;
  if (spec.auth !== "apikey" && spec.auth !== "subscription") return null;
  // A provider whose plugin isn't active (disabled since the spawn) is refused, never resolved to another.
  if (!agentSeam(spec.provider)) throw new AgentConfigError(unknownProviderText(spec.provider));
  return { name, kind: kindOf(spec.provider), spec, ...(decoded?.overrides ? { overridden: true } : {}) };
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
  const LISTS = new Set(["egress", "allowedTools", "disallowedTools", "children.allowedChildProfiles", ...LIST_PATHS]);
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

/** Merge overrides (v2 paths or v1 names, ./v2.ts flatOverrides) onto a profile; they may only narrow it unless `operator` is set. */
export function applyOverrides(name: string, base: AgentSpec, ov: Overrides): AgentSpec {
  const { children: ch, ...rest } = flatOverrides(ov.set) as Record<string, any>;
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
    const { loadAgentConfig } = require("../agents/config") as typeof import("../agents/config");
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
