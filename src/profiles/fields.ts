// A profile as the rows a client renders and edits (ADR-024 §3 "UI surfaces", §7 step 6): GET /v1/profiles/{name}
// serves them and PUT /v1/profiles/{name} takes their values, typed like a place's settings rows (ADR-021: `type`,
// `label`, `value`, `display`, `choices`, `editable`, `source`), so a new block shows up without an app release. Every
// value is a string in one encoding both ways (a list is a JSON array). Labels, help and `display` are written here,
// except for the free text a profile's file holds (`description`, `identity.title`, a value outside the catalog). No
// prompt text is ever served: a prompt row says only whether it is set.
import { agentSeams } from "../plugins/agents";
import { profileValues } from "./describe";
import type { ResolvedProfile } from "./load";
import { providerEfforts } from "./v1";
import { v1Field } from "./write";

/** How a row is rendered and what PUT takes for it. A client renders a type it doesn't know as a read-only `info` row. */
export type FieldType = "choice" | "toggle" | "number" | "text" | "list" | "info";
export interface ProfileField {
  /** The value's v2 path (`limits.maxTurns`): what PUT's `values` names it by. */
  id: string;
  type: FieldType;
  label: string;
  help: string | null;
  /** The value as PUT takes it (a number in decimal, a toggle "true"/"false", a list as a JSON array of strings);
   *  null when unset, and for a prompt and a row outside the catalog. */
  value: string | null;
  /** The value as a short sentence: what the row shows. */
  display: string;
  choices: Array<{ value: string; label: string }>;
  /** Which file sets it: unset (none), inherited (a profile it extends), profile (its own file), override (an override.yaml laid over it). */
  source: "unset" | "inherited" | "profile" | "override";
  /** The index of that file in the profile's `applied`; null when unset. */
  from: number | null;
  /** PUT can change it: a catalog row whose value the profile's own file can hold and no later file sets. */
  editable: boolean;
  /** The text is the profile file's own, not capcomd's (`description`, `identity.title`, a row outside the catalog). */
  untrusted: boolean;
}

type Unit = "turns" | "usd" | "ms" | "count" | "share" | "repeats";
export interface ProfileFieldSpec {
  id: string; type: FieldType; label: string; help?: string; unit?: Unit;
  /** What unset means, as `display` says it. */
  unset: string;
  choices?: (p: ResolvedProfile) => Array<{ value: string; label: string }>;
  untrusted?: boolean;
  /** A prompt: its text is never served. */
  prompt?: boolean;
}

const minutes = (ms: number) => (ms % 60_000 === 0 ? `${ms / 60_000} min` : ms % 1000 === 0 ? `${ms / 1000} s` : `${ms} ms`);
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** The rows, in the order a details screen shows them. */
export const PROFILE_FIELDS: readonly ProfileFieldSpec[] = [
  { id: "identity.title", type: "text", label: "Title", help: "What the app calls it; its name when unset", unset: "Its name", untrusted: true },
  { id: "description", type: "text", label: "Description", help: "What it is for, in your words: a planner reads it when it picks a profile", unset: "None", untrusted: true },
  { id: "tags", type: "list", label: "Tags", help: "Lowercase words a planner matches on (review, security)", unset: "None" },
  { id: "extends", type: "info", label: "Extends", help: "The profile it is laid over; change it in its file", unset: "Nothing" },
  { id: "harness.provider", type: "choice", label: "Agent", unset: "Not set", choices: () => agentSeams().map((p) => ({ value: p.describe().name, label: p.describe().label })) },
  { id: "harness.auth", type: "choice", label: "Login", help: "Exactly one: a plan login (capcomd auth login) or an API key", unset: "Not set", choices: () => [{ value: "subscription", label: "Plan login" }, { value: "apikey", label: "API key" }] },
  { id: "harness.model", type: "text", label: "Model", unset: "The agent's default" },
  { id: "harness.effort", type: "choice", label: "Effort", unset: "The agent's default", choices: (p) => providerEfforts(p.spec.provider).map((e) => ({ value: e, label: capital(e) })) },
  { id: "tools.mode", type: "choice", label: "Works by", help: "Orchestrating needs it to be allowed to spawn agents", unset: "Executing", choices: () => [{ value: "execute", label: "Executing: edits and runs code" }, { value: "orchestrate", label: "Orchestrating: sees everything, runs nothing" }] },
  { id: "tools.allowed", type: "list", label: "Allowed tools", help: "The agent CLI's tools it may use (Read, \"Bash(git diff:*)\"); unset: the CLI's own", unset: "The agent's own" },
  { id: "tools.disallowed", type: "list", label: "Denied tools", unset: "None" },
  { id: "prompt.system", type: "info", label: "System prompt", help: "Replaces the agent's system prompt; change it in the profile's file", unset: "The agent's own", prompt: true },
  { id: "prompt.append", type: "info", label: "Added to the prompt", help: "Change it in the profile's file", unset: "Nothing", prompt: true },
  { id: "limits.maxTurns", type: "number", label: "Turns", unit: "turns", unset: "No limit" },
  { id: "limits.maxBudgetUsd", type: "number", label: "Budget", unit: "usd", help: "In US dollars", unset: "No limit" },
  { id: "limits.timeoutMs", type: "number", label: "Time limit", unit: "ms", help: "In milliseconds", unset: "No limit" },
  { id: "limits.idleAfterMs", type: "number", label: "Stopped when silent for", unit: "ms", help: "In milliseconds: no output from the agent for this long", unset: "30 min" },
  { id: "limits.stuckRepeats", type: "number", label: "Stuck after", unit: "repeats", help: "The same step this many times in a row", unset: "capcomd's default" },
  { id: "limits.noChangeAfterMs", type: "number", label: "Spinning after", unit: "ms", help: "In milliseconds: working with no change to its files for this long", unset: "Off" },
  { id: "sandbox.egress", type: "list", label: "Network", help: "The hosts it may reach (github.com); unset: any", unset: "Open" },
  { id: "sandbox.codex", type: "choice", label: "Codex sandbox", help: "Codex only", unset: "Codex's default", choices: () => [{ value: "read-only", label: "Read only" }, { value: "workspace-write", label: "Writes its workspace" }, { value: "danger-full-access", label: "Full access" }] },
  { id: "lifecycle.checkpointEveryMs", type: "number", label: "Saves its work every", unit: "ms", help: "In milliseconds", unset: "10 min" },
  { id: "permissions.report", type: "toggle", label: "May answer with a report", help: "Spawned with report: read-only, its result is its final message", unset: "Yes" },
  { id: "children.allowSpawn", type: "toggle", label: "May spawn agents", unset: "No" },
  { id: "children.allowedChildProfiles", type: "list", label: "Profiles it may spawn", unset: "None" },
  { id: "children.maxChildren", type: "number", label: "Agents at once", unit: "count", unset: "No limit" },
  { id: "children.maxDepth", type: "number", label: "Levels below it", unit: "count", unset: "No limit" },
  { id: "children.maxTotalDescendants", type: "number", label: "Agents in all", unit: "count", unset: "No limit" },
  { id: "children.budgetShare", type: "number", label: "Budget share per agent", unit: "share", help: "Of its own budget, from 0 to 1", unset: "All of it" },
  { id: "jobs.foregroundMs", type: "number", label: "A job's wait for its result", unit: "ms", help: "In milliseconds", unset: "capcomd's default" },
  { id: "jobs.max", type: "number", label: "Jobs at once", unit: "count", unset: "capcomd's default" },
  { id: "jobs.afterTurnMs", type: "number", label: "A job's time limit", unit: "ms", help: "In milliseconds", unset: "capcomd's default" },
];
const BY_ID = new Map(PROFILE_FIELDS.map((f) => [f.id, f]));
/** Said by the profile's summary row, not as a field. */
const NOT_A_ROW = new Set(["name", "version", "default"]);

const get = (doc: Record<string, unknown>, path: string): unknown => {
  const [a, b] = path.split(".") as [string, string?];
  const v = doc[a];
  return b === undefined ? v : v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[b] : undefined;
};

/** A value as a row shows it. */
function displayOf(f: ProfileFieldSpec, v: unknown, choices: ProfileField["choices"]): string {
  if (v === undefined || v === null) return f.unset;
  if (f.prompt) return `Set (${String(v).length} characters)`;
  if (f.type === "toggle") return v ? "Yes" : "No";
  if (f.type === "choice") return choices.find((c) => c.value === v)?.label ?? String(v);
  if (f.type === "list") return Array.isArray(v) && v.length ? v.join(", ") : "None";
  if (typeof v === "number") {
    switch (f.unit) {
      case "turns": return `${v} turns`;
      case "usd": return `$${v}`;
      case "ms": return minutes(v);
      case "share": return `${Math.round(v * 100)}%`;
      case "repeats": return `${v} repeats`;
      default: return String(v);
    }
  }
  return String(v);
}

/** A value in the rows' encoding (PUT's): null for unset and for a prompt. */
function encode(f: ProfileFieldSpec, v: unknown): string | null {
  if (v === undefined || v === null || f.prompt) return null;
  if (f.type === "list") return JSON.stringify(v);
  return typeof v === "string" ? v : JSON.stringify(v);
}

/** A value outside the catalog, shown as the file has it: one line, at most 80 characters. */
function shown(v: unknown): string {
  const t = typeof v === "string" ? v : JSON.stringify(v);
  const line = t.split("\n")[0]!;
  return line.length > 80 ? `${line.slice(0, 79)}…` : line === t ? line : `${line}…`;
}

/** Can a write to the profile's own file hold this path? (A v2 file holds every path; an agents.json entry its v1 fields.) */
function holds(p: ResolvedProfile, id: string): boolean {
  if (p.format === "v2") return true;
  return v1Field(id.split(".")) !== null;
}

/** Every row of a resolved profile: the catalog's, then each other value it sets (read-only, as its file has it). */
export function profileFields(p: ResolvedProfile): ProfileField[] {
  const own = p.applied.findIndex((a) => a.as === "profile");
  const writable = own >= 0 && p.applied[own]!.path !== null;
  const row = (f: ProfileFieldSpec, v: unknown): ProfileField => {
    const from = p.setBy[f.id] ?? null;
    const as = from === null ? null : p.applied[from]?.as;
    const choices = f.choices?.(p) ?? [];
    let editable = f.type !== "info" && writable && holds(p, f.id) && !(from !== null && from > own);
    let help = f.help ?? null;
    if (f.type !== "info" && !editable) {
      const why = !writable ? "It is bundled with capcomd, which a write doesn't change"
        : !holds(p, f.id) ? "An agents.json entry can't hold it: move the profile to a profile file to set it"
        : `${p.applied[from!]!.path ?? "A later file"} sets it after the profile's own file: change it there`;
      help = help ? `${help}. ${why}` : why;
      editable = false;
    }
    return {
      id: f.id, type: f.type, label: f.label, help, value: encode(f, v), display: displayOf(f, v, choices), choices,
      source: as === undefined || as === null ? "unset" : as === "extends" ? "inherited" : as, from, editable, untrusted: !!f.untrusted,
    };
  };
  const rows = PROFILE_FIELDS.map((f) => row(f, get(p.manifest, f.id)));
  for (const v of profileValues(p)) {
    if (BY_ID.has(v.path) || NOT_A_ROW.has(v.path)) continue;
    const r = row({ id: v.path, type: "info", label: v.path, help: "capcomd shows it as the profile's file has it; change it there", unset: "Not set", untrusted: true }, v.value);
    // An MCP server by its name: its command line may carry a token, and the rows are served to any reading client.
    const value = v.path === "tools.mcp" && Array.isArray(v.value) ? v.value.map((s) => (s && typeof s === "object" && typeof (s as { name?: unknown }).name === "string" ? (s as { name: string }).name : "?")).join(", ") : v.value;
    rows.push({ ...r, value: null, display: shown(value) });
  }
  return rows;
}

/**
 * PUT's `values` (row id → its encoded value, or null to unset) as an edit (./write.ts ProfileEdit): each must be an
 * editable row of this profile with a value of its type. The rest (ranges, a provider's efforts, narrowing) is checked
 * on the profiles the write would leave. Returns the problem, or the edit.
 */
export function editOf(p: ResolvedProfile, values: Record<string, string | null>): { edit: Record<string, unknown> } | { field: string; message: string } {
  const rows = new Map(profileFields(p).map((r) => [r.id, r]));
  const edit: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(values)) {
    const r = rows.get(id), f = BY_ID.get(id);
    if (!r || !f) return { field: id, message: `${id}: not a field of this profile (GET /v1/profiles/{name} lists them)` };
    if (!r.editable) return { field: id, message: `${id}: can't be changed here (${r.help ?? "read-only"})` };
    if (raw === null) { edit[id] = null; continue; }
    switch (f.type) {
      case "number": {
        if (!/^-?\d+(\.\d+)?$/.test(raw.trim())) return { field: id, message: `${id}: must be a number` };
        edit[id] = Number(raw);
        break;
      }
      case "toggle":
        if (raw !== "true" && raw !== "false") return { field: id, message: `${id}: must be "true" or "false"` };
        edit[id] = raw === "true";
        break;
      case "choice":
        if (!r.choices.some((c) => c.value === raw)) return { field: id, message: `${id}: must be one of ${r.choices.map((c) => c.value).join(", ") || "its choices"}` };
        edit[id] = raw;
        break;
      case "list": {
        let v: unknown;
        try { v = JSON.parse(raw); } catch { v = undefined; }
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) return { field: id, message: `${id}: must be a JSON array of strings` };
        edit[id] = v;
        break;
      }
      default: edit[id] = raw;
    }
  }
  return { edit };
}
