// A place's settings and info rows (docs/spec/plugin-api.md §4.7.5, §17.1; ADR-021 §2) as its sandbox plugin's UI
// descriptors: each built-in sandbox plugin registers, with `ctx.ui.descriptor`, the rows its seam's descriptor lists
// (`settings`, `info`), and GET /v1/sandboxes/{name} serves them (src/api/sandboxes.ts sandboxDetail). A descriptor
// carries the row's fixed parts (its label, help, type and choices); its `read` answers the rest from the facts the
// daemon gathered for the request (the logins, Docker's memory, the stored settings), which only a built-in is given.
// The rows are the same on every provider that lists them, so they are written once here. Every string is fixed or
// built from trusted values: never a provider's error text, never a credential.
import type { PluginContext, UiDescriptor, UiRowValue } from "../../../packages/plugin/src/context";
import type { SandboxDescriptor } from "../../../packages/plugin/src/seams";
import { env as envVar } from "../../utils/env";
import {
  AGENT_MEMORY_DEFAULT_MB, AGENT_MEMORY_ENV, AGENT_MEMORY_PRESETS, currentAgentMemory, currentIdleLifetime, fileSettingsStore, IDLE_LIFETIME_DEFAULT, IDLE_LIFETIME_ENV,
  IDLE_LIFETIME_PRESETS, memorySettingsStore, settingsPath, type AgentMemory, type IdleLifetime, type SettingsStore,
} from "../../providers/settings";

type Env = Record<string, string | undefined>;

// ---- Fields (ADR-021 §2): choice, toggle, info, status; every one has a daemon-written `display` ----
export type FieldType = "choice" | "toggle" | "info" | "status";
export interface Field {
  id: string;
  type: FieldType;
  label: string;
  help: string | null;
  value: string | null;
  display: string;
  default: string | null;
  choices: Array<{ value: string; label: string }>;
  /** Where the value comes from: default (the descriptor's), env (an environment variable wins), config (the user
   *  config), daemon (an info row the daemon works out). */
  source: "default" | "env" | "config" | "daemon";
  editable: boolean;
  /** new_runs: a change applies to runs started after it; new_agents: to agents that start after it (those waiting
   *  for a slot too); null for info rows. */
  appliesTo: "new_runs" | "new_agents" | null;
  needsRestart: boolean;
  /** A status row's dot: ok, warn, bad or none; null on every other type. */
  state: "ok" | "warn" | "bad" | "none" | null;
}

/** What the Logins row reads of GET /v1/logins. */
export type LoginLike = { provider: "claude" | "codex"; sandbox: string; loggedIn: boolean; hostBound: boolean };
/** What the Agents at once row reads of Docker: its memory (null while unknown). */
export type SlotsLike = { memTotal: number | null };

/** "15 minutes", "1 hour", "90 seconds". */
export function durationLabel(seconds: number): string {
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
  if (seconds > 0 && seconds % 3600 === 0) return unit(seconds / 3600, "hour");
  if (seconds > 0 && seconds % 60 === 0) return unit(seconds / 60, "minute");
  return unit(seconds, "second");
}

/** The idle lifetime presets, the same on every provider (ADR-021, decided 2026-10-27). */
export const IDLE_LIFETIME_CHOICES: ReadonlyArray<{ value: string; label: string }> = IDLE_LIFETIME_PRESETS.map((n) => ({ value: String(n), label: durationLabel(n) }));

/**
 * The idle machine lifetime (ADR-021 §2): a lease a running agent renews every 10 minutes, so a machine left behind is
 * deleted this long after its last renewal. `life`: what applies now and where it comes from; `writable`: whether the
 * daemon can store a change (false while settings are off). An environment variable wins and makes it read-only.
 */
export function idleLifetimeField(d: Pick<SandboxDescriptor, "caps">, life: IdleLifetime, writable = true): Field {
  const sweep = d.caps.idleLifetime === "sweep";
  const env = life.source === "env";
  return {
    id: "idleLifetime", type: "choice", label: "Delete idle machines after",
    help: sweep
      ? "A container left behind (a crash, a stopped run) is deleted after this. capcomd checks every 5 minutes, so one can run up to 5 minutes over."
      : "A machine left behind (a crash, a stopped run) is deleted after this, so it stops billing.",
    value: String(life.seconds), display: env ? `Set by ${IDLE_LIFETIME_ENV} in capcomd's environment` : durationLabel(life.seconds),
    default: String(IDLE_LIFETIME_DEFAULT), choices: IDLE_LIFETIME_CHOICES.map((c) => ({ ...c })),
    source: life.source, editable: !env && writable, appliesTo: "new_runs", needsRestart: false, state: null,
  };
}

/** "512 MB", "1 GB", "1.5 GB". */
export function memoryLabel(mb: number): string {
  return mb >= 1024 && (mb * 10) % 1024 === 0 ? `${mb / 1024} GB` : `${mb} MB`;
}
/** The memory per agent presets (Docker, decided 2026-11-03). */
export const AGENT_MEMORY_CHOICES: ReadonlyArray<{ value: string; label: string }> = AGENT_MEMORY_PRESETS.map((n) => ({ value: String(n), label: memoryLabel(n) }));

/**
 * Memory per agent (Docker, src/providers/capacity.ts): how much of Docker's memory each agent gets, so how many run at
 * once (the Agents at once row). An environment variable wins and makes it read-only. A change applies to the next
 * agent that starts, those waiting for a slot included.
 */
export function agentMemoryField(memory: AgentMemory, writable = true): Field {
  const env = memory.source === "env";
  return {
    id: "agentMemory", type: "choice", label: "Memory per agent",
    help: "Agents here share Docker's memory: each gets this much, so a smaller amount runs more at once. An agent CLI uses about 0.3-0.6 GB; builds and tests need more.",
    value: String(memory.mb), display: env ? `Set by ${AGENT_MEMORY_ENV} in capcomd's environment` : memoryLabel(memory.mb),
    default: String(AGENT_MEMORY_DEFAULT_MB), choices: AGENT_MEMORY_CHOICES.map((c) => ({ ...c })),
    source: memory.source, editable: !env && writable, appliesTo: "new_agents", needsRestart: false, state: null,
  };
}

const AI_NAME: Record<LoginLike["provider"], string> = { claude: "Claude Code", codex: "Codex" };
/** The Logins row: a summary of GET /v1/logins?sandbox=name. "Bound" only when every logged-in login is bound to its
 *  AI's API host; otherwise it names the ones that aren't. `hostBound`: the place swaps bound secrets in (its caps). */
export function loginsRow(name: string, all: LoginLike[], hostBound: boolean): Field {
  const here = all.filter((l) => l.sandbox === name && l.loggedIn);
  const loose = here.filter((l) => !l.hostBound).map((l) => AI_NAME[l.provider]);
  const value = !here.length ? "none" : !loose.length ? "bound" : loose.length === here.length ? "unbound" : "partial";
  const display = value === "none" ? "No logins yet"
    : value === "bound" ? "Bound"
    : `${loose.join(" and ")} ${loose.length === 1 ? "isn't" : "aren't"} bound to ${loose.length === 1 ? "its" : "their"} API host`;
  return {
    id: "logins", type: "info", label: "Logins",
    help: hostBound
      ? "A bound login is swapped in on the way to its AI's API, so agents only ever see a placeholder. Plan logins kept in the agent environment aren't bound."
      : "Logins here are kept in the agent environment or passed to the agent, so agents can read them.",
    value, display, default: null, choices: [], source: "daemon", editable: false, appliesTo: null, needsRestart: false, state: null,
  };
}

/** The Checkpoints row: git checkpoints by the in-VM supervisor (ADR-019 §3), the same on every provider. */
export function checkpointsField(source: Env = process.env): Field {
  const set = envVar("AGENT_CHECKPOINT_MS", source);
  const n = set === undefined || set.trim() === "" ? NaN : Number(set);
  const ms = Number.isFinite(n) && n >= 0 ? Math.floor(n) : 10 * 60_000;
  const secs = Math.round(ms / 1000);
  const every = secs <= 0 ? null : `every ${durationLabel(secs).replace(/^1 /, "")}`;
  return {
    id: "checkpoints", type: "info", label: "Checkpoints",
    help: "Agents save their work to a git checkpoint as they go, so a machine that's lost costs at most the work since the last one.",
    value: String(ms), display: every ? `After each commit and ${every}` : "After each commit", default: null, choices: [], source: "daemon",
    editable: false, appliesTo: null, needsRestart: false, state: null,
  };
}

/**
 * The Agents at once row (src/providers/capacity.ts): agents here share Docker's memory, so at most its memory over the
 * per-agent budget (the Memory per agent setting, as it is now) run at once; more wait as pending and start as others
 * finish.
 */
export function agentSlotsField(s: SlotsLike & { memory: AgentMemory }): Field {
  // Loaded only once Docker's memory is known, never with the plugins: capacity reads Docker, which reads the sandbox
  // registry the plugins make.
  const C = s.memTotal ? (require("../../providers/capacity") as typeof import("../../providers/capacity")) : null;
  const budget = memoryLabel(s.memory.mb);
  const n = C && s.memTotal ? C.agentSlots(s.memTotal, s.memory.mb) : null;
  const env = s.memory.source === "env";
  return {
    id: "agentSlots", type: "info", label: "Agents at once",
    help: `Agents here share Docker's memory, ${budget} each. More wait (pending) and start as others finish. ${env ? `Set by ${AGENT_MEMORY_ENV} in capcomd's environment.` : "Change it with Memory per agent."}`,
    value: n !== null ? String(n) : null,
    display: n !== null ? `${n} (${C!.gb(s.memTotal!)} ÷ ${budget} per agent)` : `${budget} per agent (Docker's memory isn't known yet)`,
    default: null, choices: [], source: env ? "env" : "daemon", editable: false, appliesTo: null, needsRestart: false, state: null,
  };
}

// ---- The rows as UI descriptors (§4.7.5) ----

/** What the daemon knows when it serves a place's rows (GET /v1/sandboxes/{name}, PATCH …/settings): given to a
 *  built-in's `read`, never to another plugin's. */
export interface RowFacts {
  /** capcomd's environment (CAPCOMD_SANDBOX_IDLE_SECONDS, CAPCOMD_AGENT_CHECKPOINT_MS, …). */
  env: Env;
  /** GET /v1/logins (every place). */
  logins: LoginLike[];
  /** The idle machine lifetime as it applies to this place now. */
  idleLifetime: IdleLifetime;
  /** Whether a change can be stored (false while settings are off). */
  writable: boolean;
  /** Docker's memory, for a place with a memory cap; null when unknown or without one. */
  slots: SlotsLike | null;
  /** Where the settings are kept. */
  store: SettingsStore;
}

/** The facts as they are now, read from the files and the environment (a read the daemon didn't give facts to). */
export function factsNow(name: string, env: Env = process.env): RowFacts {
  const store = fileSettingsStore(settingsPath(env));
  return { env, logins: [], idleLifetime: currentIdleLifetime(name, { env, store }), writable: store.writable(), slots: null, store };
}

/** What a row's `read` answers: its value and the rest of the field (§4.7.5: the `SandboxField` shape). */
const answer = (f: Field): UiRowValue => ({
  value: f.value, display: f.display, source: f.source, editable: f.editable, help: f.help, default: f.default, appliesTo: f.appliesTo, needsRestart: f.needsRestart,
  ...(f.state !== null ? { state: f.state } : {}),
});

type Row = { kind: "settings" | "info"; build(name: string, d: SandboxDescriptor, f: RowFacts): Field };
const memoryOf = (name: string, f: RowFacts) => currentAgentMemory(name, { env: f.env, store: f.store });
/** Every row a place can list, by id (src/providers/registry.ts SETTING_IDS, INFO_IDS). */
const ROWS: Record<string, Row> = {
  idleLifetime: { kind: "settings", build: (_n, d, f) => idleLifetimeField(d, f.idleLifetime, f.writable) },
  // Memory per agent as it is now (read from the store each time): the setting and the Agents at once row agree.
  agentMemory: { kind: "settings", build: (n, _d, f) => agentMemoryField(memoryOf(n, f), f.writable) },
  logins: { kind: "info", build: (n, d, f) => loginsRow(n, f.logins, d.caps.hostBoundSecrets) },
  checkpoints: { kind: "info", build: (_n, _d, f) => checkpointsField(f.env) },
  agentSlots: { kind: "info", build: (n, _d, f) => agentSlotsField({ memTotal: f.slots?.memTotal ?? null, memory: memoryOf(n, f) }) },
};

/** The rows a place's descriptor lists, in its order: a place whose machines nobody deletes has no idle lifetime. */
function listedRows(d: SandboxDescriptor): Array<{ id: string; row: Row }> {
  return [...d.settings, ...d.info]
    .filter((id) => id !== "idleLifetime" || d.caps.idleLifetime !== "none")
    .flatMap((id) => (ROWS[id] ? [{ id, row: ROWS[id]! }] : []));
}

/** The manifest's `contributes.ui` for a sandbox plugin: one descriptor per row its descriptor lists. */
export function rowContributions(d: SandboxDescriptor): Array<{ kind: "settings" | "info"; id: string }> {
  return listedRows(d).map(({ id, row }) => ({ kind: row.kind, id }));
}

/** Facts with nothing set (no environment, no stored settings, no logins): the rows' fixed parts are read from them,
 *  with no file or Docker read while the plugins activate. */
const NEUTRAL = (): RowFacts => ({ env: {}, logins: [], idleLifetime: { seconds: IDLE_LIFETIME_DEFAULT, source: "default" }, writable: true, slots: null, store: memorySettingsStore() });

/** Register a place's rows (its plugin's `activate`). Their fixed parts (label, help, type, choices) are the field's;
 *  `read(facts)` builds it from the daemon's facts, its help too where that depends on them. */
export function contributeRows(ctx: Pick<PluginContext, "ui">, d: SandboxDescriptor): void {
  for (const { id, row } of listedRows(d)) {
    const base = row.build(d.name, d, NEUTRAL());
    ctx.ui.descriptor({
      kind: row.kind, id, label: base.label, help: base.help, type: base.type,
      ...(base.choices.length ? { choices: base.choices.map((c) => ({ ...c })) } : {}),
      async read(facts?: RowFacts) { return answer(row.build(d.name, d, facts ?? factsNow(d.name))); },
    });
  }
}

/** A row as GET /v1/sandboxes/{name} serves it: the descriptor's fixed parts and what its `read` answered. */
export function fieldOf(d: Extract<UiDescriptor, { kind: "settings" | "info" }>, r: UiRowValue): Field {
  return {
    id: d.id, type: d.type, label: d.label, help: r.help !== undefined ? r.help : d.help, value: r.value, display: r.display, default: r.default ?? null,
    choices: (d.choices ?? []).map((c) => ({ ...c })), source: r.source as Field["source"], editable: r.editable, appliesTo: r.appliesTo ?? null,
    needsRestart: r.needsRestart ?? false, state: r.state ?? null,
  };
}
