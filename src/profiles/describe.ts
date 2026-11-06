// What a resolved profile is, as `capcomd profiles list|show`, GET /v1/profiles and a planner say it (ADR-024 §4, §5,
// §7 steps 2 and 4): one row per profile, for `show` every value with the file that set it, and what a driver or a
// planner reads to choose one: the blocks that need no runtime (`identity.title`, `tags`, `permissions.report`,
// `sharing`) as written, and two facts capcomd writes itself from structured fields: `fit`, a sentence (never agent
// or package text: a shared package can't word its own pitch), and `cost`, the model's list price tier. `capacity`
// needs the place and the login ledger: src/providers/capacity.ts profileCapacity. Pure: readiness (is its login
// present?) is the caller's, which knows the environment it asks for. Read by capcomd_profiles (src/mcp/driver.ts),
// `capcomd profiles` and GET /v1/profiles.
import { agentSeam } from "../plugins/agents";
import { abilityText, leadText, readOnlyTools, type AgentSpec, type AuthMode } from "./v1";
import { PROFILE_JSON_SCHEMA, type ProfileDoc } from "./v2";
import type { AppliedFile, ProfileLayer, ProfileSet, ResolvedProfile } from "./load";

export interface ProfileRow {
  name: string;
  version: number;
  source: ProfileLayer;
  format: "v1" | "v2";
  path: string | null;
  default: boolean;
  provider: string;
  auth: AuthMode;
  model: string | null;
  effort: string | null;
  toolMode: "execute" | "orchestrate";
  canSpawn: boolean;
  /** Who it spawns, when it can lead a part (v1.ts leadText); null when it can't. */
  canLead: string | null;
  description?: string;
  tags: string[];
  /** What it is for, in plain words (v1.ts abilityText). */
  does: string;
  applied: AppliedFile[];
}

/** One row per profile, in the set's order. */
export function profileRows(set: ProfileSet): ProfileRow[] {
  return Object.values(set.profiles).map((p) => profileRow(p, set.default === p.name));
}
export function profileRow(p: ResolvedProfile, isDefault: boolean): ProfileRow {
  const s = p.spec, tags = p.manifest.tags;
  return {
    name: p.name, version: p.version, source: p.source, format: p.format, path: p.path, default: isDefault,
    provider: s.provider, auth: s.auth, model: s.model ?? null, effort: s.effort ?? null, toolMode: s.toolMode ?? "execute",
    canSpawn: !!s.children?.allowSpawn, canLead: leadText(s), ...(s.description ? { description: s.description } : {}),
    tags: Array.isArray(tags) ? (tags as string[]) : [], does: abilityText(s), applied: p.applied,
  };
}

/** One resolved value and the file that set it (`from`: one of the profile's `applied`). */
export interface ProfileValue { path: string; value: unknown; from: AppliedFile | null }

const blockOf = (k: string): Record<string, unknown> | undefined => {
  const s = (PROFILE_JSON_SCHEMA.properties as Record<string, { anyOf?: Array<{ properties?: Record<string, unknown> }> }>)[k];
  return s?.anyOf?.[0]?.properties;
};
const isMap = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Who the profile is is said by its header (`name`) and its schema id; everything else is a value. */
const HEADER = new Set(["$schema", "schema", "name"]);

/**
 * Every value of the resolved manifest, in the schema's order (top-level fields, then the blocks, each block's keys in
 * order; vendor `x-` fields last), with the file that set it (ADR-024 §2.6: `show` prints the layers and the result).
 */
export function profileValues(p: ResolvedProfile): ProfileValue[] {
  const order = Object.keys(PROFILE_JSON_SCHEMA.properties);
  const rank = (k: string, keys: string[]) => { const i = keys.indexOf(k); return i < 0 ? keys.length : i; };
  const sorted = (keys: string[], by: string[]) => [...keys].sort((a, b) => rank(a, by) - rank(b, by));
  const out: ProfileValue[] = [];
  const at = (path: string, value: unknown) => { const i = p.setBy[path]; out.push({ path, value, from: i === undefined ? null : p.applied[i] ?? null }); };
  const doc: ProfileDoc = p.manifest;
  for (const k of sorted(Object.keys(doc), order)) {
    if (HEADER.has(k)) continue;
    const v = doc[k];
    if (!isMap(v)) { at(k, v); continue; }
    for (const sub of sorted(Object.keys(v), Object.keys(blockOf(k) ?? {}))) at(`${k}.${sub}`, v[sub]);
  }
  return out;
}

/** A model's list price, relative to the others a harness offers: a planner gives mechanical parts the low one. */
export type CostTier = "low" | "medium" | "high";

/** A model id as the CLIs take them (`claude-opus-5-5`, `us.anthropic.claude-…`, `opus[1m]`, `gpt-5.6`). A profile's
 *  `model` is any string, so fit names one, and cost rates one, only when it is shaped like this (it is the one
 *  free-text field fit shows). */
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:/@\[\]-]{0,99}$/;

/**
 * The price tier of a model id, by its family (Anthropic: Haiku, Sonnet, Opus; OpenAI: the -mini/-nano, the base and
 * the -pro models). Null when the model is unset (the CLI picks one, which capcomd doesn't know), isn't shaped like a
 * model id or isn't a family listed here.
 */
export function costTier(model: string | undefined | null): CostTier | null {
  if (!model || !MODEL_ID.test(model)) return null;
  const m = model.toLowerCase();
  if (/\bhaiku\b|-(?:mini|nano)\b/.test(m)) return "low";
  if (/\bopus\b|-pro\b/.test(m)) return "high";
  if (/\bsonnet\b|^gpt-|^o\d\b|codex/.test(m)) return "medium";
  return null;
}

/** Whether the profile edits code, from its tools: what fit says first. */
function works(s: AgentSpec): string {
  if (s.toolMode === "orchestrate") return "orchestrates: sees everything, runs nothing";
  if (readOnlyTools(s.allowedTools) || s.sandbox === "read-only") return "read-only";
  return "edits and runs code";
}

const minutes = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : `${Math.round(ms / 1000)} s`);

/**
 * One sentence on what the profile is fit for, from its structured fields only ("read-only; answers with a report;
 * Claude Code, claude-opus-5-5, high effort, high cost; up to 40 turns, $3; can't spawn"). `report` is the profile's
 * `permissions.report` (null: unset).
 */
export function fitText(s: AgentSpec, report: boolean | null = null): string {
  const parts = [works(s)];
  if (report === true) parts.push("answers with a report (spawn it with report)");
  if (report === false) parts.push("never spawned with report");
  const cost = costTier(s.model);
  const label = agentSeam(s.provider)?.describe().label ?? s.provider;
  const model = s.model === undefined ? "the CLI's default model" : MODEL_ID.test(s.model) ? s.model : "a model id capcomd can't show";
  parts.push([label, model, ...(s.effort ? [`${s.effort} effort`] : []), ...(cost ? [`${cost} cost`] : [])].join(", "));
  const limits = [
    ...(s.maxTurns !== undefined ? [`${s.maxTurns} turns`] : []),
    ...(s.maxBudgetUsd !== undefined ? [`$${s.maxBudgetUsd}`] : []),
    ...(s.timeoutMs !== undefined ? [minutes(s.timeoutMs)] : []),
  ];
  if (limits.length) parts.push(`up to ${limits.join(", ")}`);
  if (s.egress?.length && !s.egress.includes("*")) parts.push(`network limited to ${s.egress.length} host${s.egress.length === 1 ? "" : "s"}`);
  const lead = leadText(s);
  parts.push(lead ? `leads ${lead}` : "can't spawn");
  return parts.join("; ");
}

/** What the planner matches on and the app shows, for one resolved profile. */
export interface ProfileFacts {
  /** `identity.title`: what the app shows; null: the name. */
  title: string | null;
  /** `tags`, as written ([] when none). */
  tags: string[];
  /** May it be spawned with `report` (`permissions.report`, unset: yes)? */
  canReport: boolean;
  fit: string;
  cost: CostTier | null;
  /** `sharing` (where an installed profile came from, its license), when it says. */
  sharing?: { source?: string; license?: string };
}

const block = (doc: Record<string, unknown>, k: string) => {
  const v = doc[k];
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
};

/** The step-4 blocks of a resolved profile, and the facts capcomd writes about it. */
export function profileFacts(p: Pick<ResolvedProfile, "manifest" | "spec">): ProfileFacts {
  const title = block(p.manifest, "identity").title;
  const report = block(p.manifest, "permissions").report;
  const sh = block(p.manifest, "sharing");
  const sharing = Object.fromEntries(["source", "license"].filter((k) => typeof sh[k] === "string").map((k) => [k, sh[k] as string]));
  return {
    title: typeof title === "string" ? title : null,
    tags: Array.isArray(p.manifest.tags) ? (p.manifest.tags as string[]) : [],
    canReport: report !== false,
    fit: fitText(p.spec, typeof report === "boolean" ? report : null),
    cost: costTier(p.spec.model),
    ...(Object.keys(sharing).length ? { sharing } : {}),
  };
}
