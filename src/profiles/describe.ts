// What a resolved profile is, as `capcomd profiles list|show` and GET /v1/profiles say it (ADR-024 §5): one row per
// profile, and for `show` every value with the file that set it. Pure: readiness (is its login present?) is the
// caller's, which knows the environment it asks for.
import { abilityText, leadText, type AuthMode } from "./v1";
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
