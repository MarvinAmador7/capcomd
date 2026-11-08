// The trigger intake (docs/spec/plugin-api.md §16.3, §17.2 step 10): what the kernel does with an external event a
// source plugin hands it (`ctx.triggers.emit`). It decides, in this order, and records every decision:
//  1. dedupe: the same (source, id) within 30 days is `deduped`;
//  2. subscription: a thread a run follows (a live run, or one that ended less than `until` ago) gets the trigger as a
//     message to the run's planner, `continued`, when a person sent it (a bot's reaches only a live run); on an ended
//     run, steps 3-5 then say whether its planner starts again on it (`continued` with `restarted`), or the observe mode
//     only records that it would have (`recorded {wouldHave: continue}`); a run the engine doesn't say anything about
//     makes it fail for now, never a new request (that could be a second run);
//  3. the kernel's gate, `triggers.sources.<source>` in the operator's config: an actor it allows or a thread it opened
//     to requests is `allowed`, else `denied {by: allowlist}`; addressed and allowed is `explicit`, else `inferred`;
//  4. `trigger.admitting`: a plugin may deny (`denied {by: plugin}`), never admit;
//  5. the accept mode (default `observe`): explicit acts in every mode; inferred is denied (`off`), only recorded with
//     what would have happened (`observe`), or acted on (`auto`);
//  6. act: a run on the source's project with the trigger's text as its goal (POST /v1/runs semantics: run.creating
//     fires), `started`, subscribed to the trigger's thread.
// A run a trigger started (or started again) answers on the trigger's thread when it ends, once, through the source's
// reply path (`ctx.triggers.onReply`), when the operator turned the source's replies on (§16.3.7).
// What the intake never does is judge content: the planner reads the goal and may decide there is nothing to do.
// Only the daemon has an intake (its plugins get `ctx.triggers`, src/plugins/host.ts); its records are files in the
// daemon's state (state/triggers/): `seen/` (dedupe), `subs/` (subscriptions), `runs/` (the trigger a run started
// from), `replies/` (the request a run answers when it ends), and `log.ndjson`, what `capcomd triggers log` reads. Its
// events (trigger.received, trigger.subscribed, trigger.unsubscribed, trigger.replied) go on the daemon stream;
// `trigger.changed` tells plugins each decision.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal, Timestamp, Trigger, TriggerDecision, TriggerReply, TriggerSubscription, Untrusted } from "../../packages/plugin/src/shapes";
import type { TriggerAdmitting } from "../../packages/plugin/src/hooks";
import type { TriggersService } from "../../packages/plugin/src/context";
import type { ContributionStore } from "../../packages/plugin/src/host/context";
import { PluginError } from "../../packages/plugin/src/errors";
import { Redactor } from "../agents/redact";
import { readConfig, userConfigPath } from "../config/store";
import { RelayError } from "../core/errors";
import { hooks, iso } from "../plugins/hooks";
import { INVISIBLE } from "../primitives/title-rules.mjs";
import { env } from "../utils/env";
import { stateDir } from "../utils/home";

// ---- config ----------------------------------------------------------------------------------------------------------

export type AcceptMode = "off" | "observe" | "auto";
export const ACCEPT_MODES: readonly AcceptMode[] = ["off", "observe", "auto"];
/** `triggers.sources.<source>` (§16.3.2 step 3): kernel-owned, written by the operator, never by a plugin. */
export interface SourceGate {
  /** The source's own actor ids (never mapped across sources) whose requests are allowed. */
  allowed?: string[];
  /** Threads opened to requests: anyone in them may ask. A pattern's `*` matches any run of characters. */
  opened?: string[];
  /** What an inferred trigger does: nothing (`off`), recorded only (`observe`, the default), acted on (`auto`). */
  mode?: AcceptMode;
  /** The project a started run works in: the absolute path of a checkout set up with `capcomd setup project`. Unset:
   *  the daemon's own repository (CAPCOMD_REPO). */
  project?: string;
  /** Whether a run a trigger started (or started again) answers on its thread when it ends, through the source's reply
   *  path (§16.3.7). Off by default: capcomd says nothing where people talk unless the operator turns it on. */
  reply?: boolean;
}
export interface TriggersConfig { sources?: Record<string, SourceGate> }

/**
 * The operator's trigger settings, read again for every trigger (a change applies to the next one, never to a run that
 * started): CAPCOMD_TRIGGERS_FILE, a JSON file of the `triggers` object, else `triggers` in ~/.capcomd/config.json
 * (off with CAPCOMD_NO_CONFIG, as every user setting). A file that doesn't parse is no settings: every source records.
 */
export function triggersConfig(source: Record<string, string | undefined> = process.env): TriggersConfig {
  const file = env("TRIGGERS_FILE", source);
  const raw: unknown = file ? readConfig(file) : source.CAPCOMD_NO_CONFIG ? {} : readConfig(userConfigPath(source)).triggers;
  return raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as TriggersConfig) : {};
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : []);
/** A source's gate, its values checked: a mode that isn't one is `observe`, a list that isn't one is empty. */
export function gateOf(cfg: TriggersConfig, source: string): { allowed: string[]; opened: string[]; mode: AcceptMode; project: string | null; reply: boolean } {
  const g = (cfg.sources?.[source] ?? {}) as SourceGate;
  return {
    allowed: strings(g.allowed), opened: strings(g.opened),
    mode: ACCEPT_MODES.includes(g.mode as AcceptMode) ? (g.mode as AcceptMode) : "observe",
    project: typeof g.project === "string" && g.project.trim() ? g.project.trim() : null,
    reply: g.reply === true,
  };
}

/** `opened` patterns: exact, or with `*` for any run of characters. Matched in linear passes, not as a regular
 *  expression: a pattern of many `*` against a long thread a source names would backtrack for minutes. */
export function threadMatches(pattern: string, thread: string): boolean {
  if (!pattern.includes("*")) return pattern === thread;
  const parts = pattern.split("*");
  const first = parts[0]!, last = parts.at(-1)!;
  if (thread.length < first.length + last.length || !thread.startsWith(first) || !thread.endsWith(last)) return false;
  // Each middle part at its earliest place after the one before: if that fails, no later place can do better.
  let at = first.length;
  const end = thread.length - last.length;
  for (const p of parts.slice(1, -1)) {
    const i = thread.indexOf(p, at);
    if (i < 0 || i + p.length > end) return false;
    at = i + p.length;
  }
  return true;
}

// ---- records ---------------------------------------------------------------------------------------------------------

export const DEDUPE_MS = 30 * 24 * 3_600_000;
/** A run's subscription lives this long after the run ends, unless it says otherwise (§16.3.5). */
export const KEEP_AFTER_END_MS = 14 * 24 * 3_600_000;
const LOG_MAX_BYTES = 4 * 1024 * 1024;
const TEXT_IN_LOG = 300;

const dir = (...p: string[]) => join(stateDir(), "triggers", ...p);
const sha = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 32);
function writeAtomic(path: string, data: string) {
  mkdirSync(join(path, ".."), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };

/** One line of `log.ndjson`: a decision, or a start that failed (`failed`, the trigger can come again). */
export type LoggedDecision = TriggerDecision | { kind: "failed"; reason: string };
export interface TriggerLogEntry {
  at: Timestamp;
  source: string; id: string; thread: string;
  actor: { id: string; display: string; bot: boolean };
  addressed: Trigger["addressed"];
  /** The first characters of what was said, redacted. */
  text: string;
  decision: LoggedDecision;
  gate: { allowed: boolean; strength: "explicit" | "inferred"; mode: AcceptMode } | null;
  /** What capcomd couldn't record about a run it started (the trigger a run was started from), when something failed. */
  unrecorded?: string[];
}

/** The intake's log, oldest first (`capcomd triggers log`; the daemon need not run). */
export function readTriggerLog(o: { source?: string; limit?: number } = {}): TriggerLogEntry[] {
  const path = dir("log.ndjson");
  if (!existsSync(path)) return [];
  const rows = readFileSync(path, "utf8").split("\n").flatMap((l) => { if (!l) return []; try { return [JSON.parse(l) as TriggerLogEntry]; } catch { return []; } });
  const mine = o.source ? rows.filter((r) => r.source === o.source) : rows;
  return o.limit ? mine.slice(-o.limit) : mine;
}

function appendLog(e: TriggerLogEntry) {
  const path = dir("log.ndjson");
  mkdirSync(dir(), { recursive: true, mode: 0o700 });
  appendFileSync(path, `${JSON.stringify(e)}\n`, { mode: 0o600 });
  // Past its size, it keeps its newer half.
  try {
    if (statSync(path).size > LOG_MAX_BYTES) {
      const lines = readFileSync(path, "utf8").split("\n").filter(Boolean);
      writeAtomic(path, `${lines.slice(Math.floor(lines.length / 2)).join("\n")}\n`);
    }
  } catch { /* the log is the audit's copy; the events are on the daemon stream too */ }
}

/** The kernel's record of a subscription: the plugin API's, plus what only the kernel keeps. */
interface SubRecord {
  runId: string; source: string; thread: string;
  /** Set by the subscriber: the subscription ends then, whatever the run does. */
  until: Timestamp | null;
  /** Else it ends this long after the run ends (`endedAt`, recorded when the intake first sees the run ended). */
  keepMs: number;
  endedAt: Timestamp | null;
  by: string;
  at: Timestamp;
}
const subPath = (s: Pick<SubRecord, "runId" | "source" | "thread">) => dir("subs", `${sha(`${s.runId}\0${s.source}\0${s.thread}`)}.json`);
function allSubs(): SubRecord[] {
  if (!existsSync(dir("subs"))) return [];
  return readdirSync(dir("subs")).filter((f) => f.endsWith(".json")).flatMap((f) => { const r = readJson<SubRecord>(dir("subs", f)); return r ? [r] : []; });
}
/** The plugin API's shape: `until` is when it ends; null while its run lives and nobody set one. */
const subOf = (r: SubRecord): TriggerSubscription => ({ runId: r.runId, source: r.source, thread: r.thread, until: r.until ?? (r.endedAt ? iso(Date.parse(r.endedAt) + r.keepMs) : null) });

/** The trigger a run was started from (harness.v1 `Run.trigger`), or null. */
export function triggerOfRun(runId: string): { source: string; id: string; thread: string; actor: { id: string; display: string; bot: boolean }; at: Timestamp } | null {
  return /^run-[A-Za-z0-9_-]+$/.test(runId) ? readJson(dir("runs", `${runId}.json`)) : null;
}

// ---- the kernel's side: where runs start and messages go (tests replace it) ------------------------------------------

/** Where a run stands for its subscriptions: whether it exists, still works, and when and how it ended. */
export interface RunStanding { exists: boolean; live: boolean; endedAt: number | null; stopped: boolean }
/** How a run ended, for its reply: its planner's state and summary (its error, when it failed). */
export interface RunOutcome { state: "completed" | "failed" | "cancelled"; summary: string | null }
type Message = { from: string; body: string; key: string };
export interface IntakeDeps {
  /** Start a run with `goal` (POST /v1/runs semantics; run.creating fires), in `repo` (a project checkout) or the daemon's. */
  startRun(input: { goal: string; repo?: string }, principal: Principal): Promise<{ runId: string }>;
  /** A message to the run's planner; null when the run has none to read it. */
  deliver(runId: string, m: Message): Promise<{ seq: number } | null>;
  /** An ended run's planner works again on `m` (§16.3.2 step 2): a new planner continues the one that finished, with
   *  `m` in its inbox (`started`); a planner already at it again gets `m` as a message. Null: the run has no planner. */
  restart(runId: string, m: Message): Promise<{ agentId: string; seq: number; started: boolean } | null>;
  standing(runId: string): Promise<RunStanding>;
  /** How the run's planner ended; null when it has none (or it hasn't ended). */
  outcome(runId: string): Promise<RunOutcome | null>;
  /** Post a reply through `source`'s reply path (§16.3.7); null when the source has none here. */
  reply(r: TriggerReply): Promise<{ url: string | null } | null>;
}

/** The run's planner: its `_planner` record, else its top-level agent spawned with the key "planner" (a run from before
 *  the record, or one whose driver spawned its planner that way); null for a run with neither. */
async function plannerOf(s: any, runId: string): Promise<string | null> {
  const { PLANNER_KV, rootAgentIdFor } = await import("../primitives/ops");
  const kv: any = await s.kvGet({ k: PLANNER_KV }).catch(() => null);
  if (typeof kv?.value?.agentId === "string" && !kv.deleted) return kv.value.agentId;
  const id = rootAgentIdFor(runId, "planner");
  return (await s.getAgent({ agentId: id }).catch(() => null)) ? id : null;
}

const RESTARTED = "\n\nThis run had ended: ";
/** What a planner started again on a trigger is told, after its first brief: the run had ended, and why it works again. */
export function restartBrief(task: string, was: { agentId: string; status: string }): string {
  // Its first brief, without what an earlier restart added.
  return `${task.split(RESTARTED)[0]}${RESTARTED}its planner ${was.agentId} finished (${was.status}; its result: \`capcomd inspect ${was.agentId}\`). You are its planner again because someone wrote on a thread this run follows: their message is in your inbox (\`capcomd inbox\`), in their words, not the operator's. Read it and decide what, if anything, it needs; work as before, and finish with \`capcomd result --summary\` again, saying what changed since. Your summary may be posted where they wrote: keep it short.`;
}

const TERMINAL = new Set(["done", "failed", "cancelled"]);

/** What starting an ended run's planner again asks of the run (the kernel's: its scope actor and spawnAgent). */
export interface PlannerKernel {
  /** The run's planner as the run records it (`_planner`, else the key "planner"), or null. */
  planner(): Promise<{ agentId: string; status: string; ref?: string | null; profile?: string | null; task: string; contract?: Record<string, unknown> | null } | null>;
  /** The id a top-level agent spawned with `key` gets (known before it exists). */
  idFor(key: string): string;
  send(to: string, m: Message): Promise<{ seq: number }>;
  /** spawnAgent in this run, started (idempotent by `key`: the same key, the same agent, started if it isn't). */
  spawn(o: { profile?: string; task: string; key: string; contract?: Record<string, unknown> }): Promise<{ agentId: string }>;
  /** The run's `_planner` from now on. */
  becomes(agentId: string): Promise<void>;
}

/**
 * §16.3.2 step 2: an ended run's planner works again on `m`. A new top-level planner continues the one that finished: its
 * profile (as it was spawned, overrides and all), its brief and its contract (a work contract's `from` is a worker's; a
 * planner continues by reading the run), one per trigger (the key). Its message is in its inbox before it starts (its id
 * is known before it exists), then it is spawned and started, and only then is it the run's planner: a restart that
 * fails part way is done again by the same trigger (the same key, the same agent, started if it wasn't), and never
 * leaves the run's planner one that doesn't start. A planner that works again already only gets the message.
 */
export async function restartPlanner(k: PlannerKernel, m: Message): Promise<{ agentId: string; seq: number; started: boolean } | null> {
  const was = await k.planner();
  if (!was) return null;
  if (!TERMINAL.has(was.status)) { const r = await k.send(was.agentId, m); return { agentId: was.agentId, seq: r.seq, started: false }; }
  const key = `planner-${sha(m.key).slice(0, 16)}`;
  const { from: _from, ...contract } = (was.contract ?? {}) as Record<string, unknown>;
  const r = await k.send(k.idFor(key), m);
  const profile = was.ref ?? was.profile;
  const a = await k.spawn({ ...(profile ? { profile } : {}), task: restartBrief(was.task, was), key, ...(Object.keys(contract).length ? { contract } : {}) });
  await k.becomes(a.agentId);
  return { agentId: a.agentId, seq: r.seq, started: true };
}

const kernelDeps: IntakeDeps = {
  async startRun(input, principal) {
    const { createRunAs } = await import("../api/rivet-source");
    const run = await createRunAs({ goal: input.goal, ...(input.repo ? { repo: input.repo } : {}) }, principal);
    return { runId: run.id };
  },
  async deliver(runId, m) {
    const { existingActor } = await import("../core/relay");
    const s = await existingActor("scope", [runId]);
    if (!s) return null;
    const to = await plannerOf(s, runId);
    if (!to) return null;
    const r = await s.sendMessage({ to, from: m.from, body: m.body, key: m.key });
    return { seq: r.seq };
  },
  async restart(runId, m) {
    const { existingActor } = await import("../core/relay");
    const s = await existingActor("scope", [runId]);
    if (!s) return null;
    const O = await import("../primitives/ops");
    return restartPlanner({
      planner: async () => { const to = await plannerOf(s, runId); return to ? await s.getAgent({ agentId: to }).catch(() => null) : null; },
      idFor: (key) => O.rootAgentIdFor(runId, key),
      send: (to, msg) => s.sendMessage({ to, from: msg.from, body: msg.body, key: msg.key }),
      spawn: (o) => O.spawnAgent({ runId, ...o }),
      becomes: async (agentId) => { await (await import("../primitives/state")).kvWrite(runId, { k: O.PLANNER_KV, value: { agentId }, writer: "operator" }); },
    }, m);
  },
  async outcome(runId) {
    const { existingActor } = await import("../core/relay");
    // The engine's error is passed on (the reply waits for the next sweep), never taken for a run with no outcome.
    const s = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]) : null;
    const to = s ? await plannerOf(s, runId) : null;
    const a: any = s && to ? await s.getAgent({ agentId: to }) : null;
    if (!a || !TERMINAL.has(a.status)) return null;
    const r = (a.result ?? {}) as Record<string, unknown>;
    const said = typeof r.summary === "string" && r.summary.trim() ? r.summary : typeof r.error === "string" && r.error.trim() ? r.error : null;
    return { state: a.status === "done" ? "completed" : a.status === "failed" ? "failed" : "cancelled", summary: said };
  },
  async reply(r) {
    const path = replyPaths?.get("reply", r.source);
    if (!path) return null;
    return path.value.reply(r, { key: r.key, timeoutMs: REPLY_TIMEOUT_MS, signal: AbortSignal.timeout(REPLY_TIMEOUT_MS) });
  },
  async standing(runId) {
    const { existingActor } = await import("../core/relay");
    // The engine's error is passed on: a run it can't say about isn't a run that doesn't exist (that would end the run's
    // subscriptions, and a trigger on its thread could start a second run).
    const s = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]).catch((e) => { throw new PluginError("unavailable", `the engine didn't answer: ${(e as Error)?.message ?? e}`, undefined, true); }) : null;
    if (!s) return { exists: false, live: false, endedAt: null, stopped: false };
    const { lifecycleEvents } = await import("../api/lifecycle");
    const evs = await s.getEvents({});
    const last = lifecycleEvents(runId, evs).filter((e) => /^run\.(started|resumed|paused|completed|failed|cancelled|deleted)$/.test(e.type)).at(-1);
    // A run with no agent yet (it is starting) works on.
    if (!last || /^run\.(started|resumed|paused)$/.test(last.type)) return { exists: true, live: true, endedAt: null, stopped: false };
    // A person's Stop (a run-wide cancel) ends its subscriptions at once (§16.3.5).
    return { exists: true, live: false, endedAt: last.epochMs, stopped: last.type === "run.cancelled" && (last.data as { cause?: string }).cause === "cancelled" };
  },
};
let deps: IntakeDeps = kernelDeps;
/** Tests: run starts, messages and run states of their own (null: the kernel's). */
export function useIntakeDeps(d: Partial<IntakeDeps> | null) { deps = d ? { ...kernelDeps, ...d } : kernelDeps; }

/** The sources' reply paths (`ctx.triggers.onReply`): the daemon's plugin host's registrations (src/plugins/host.ts
 *  kernelHost with triggers sets it). */
let replyPaths: ContributionStore | null = null;
export function useTriggerReplies(store: ContributionStore | null) { replyPaths = store; }
const REPLY_TIMEOUT_MS = 30_000;

/** Where the intake's events go: the daemon stream (`capcomd serve` sets harnessState().recordDaemonEvent). */
type DaemonSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => unknown;
let daemonSink: DaemonSink | null = null;
export function useTriggerEvents(sink: DaemonSink | null) { daemonSink = sink; }
async function record(type: "trigger.received" | "trigger.subscribed" | "trigger.unsubscribed" | "trigger.replied", entity: string, data: Record<string, unknown>) {
  if (!daemonSink) return;
  const { describeEvent } = await import("../api/describe");
  daemonSink({ type, entity, text: describeEvent(type, data, null), data });
}

// ---- checking what a source emits ------------------------------------------------------------------------------------

const usage = (m: string, hint?: string): never => { throw new PluginError("invalid", m, hint); };
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEXT_MAX = 64 * 1024, DATA_MAX = 64 * 1024;
/** Control characters (a terminal's escapes among them), line and paragraph separators, and invisible format characters
 *  (bidi overrides that reorder what a terminal shows, zero-width spaces that make two ids look alike): a source's ids
 *  and threads have none, as `capcomd triggers log` and the planner's message show them. */
const CONTROL = /[\p{Cc}\p{Cf}\u2028\u2029]/u;
const short = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) usage(`${what} is a non-empty string`);
  if ((v as string).length > max) usage(`${what} is longer than ${max} characters`);
  if (CONTROL.test(v as string)) usage(`${what} has a control or format character`, "A source names threads and actors with the characters they show; it never passes a terminal's escapes or invisible characters on.");
  return v as string;
};
/** A display name as one plain line: control characters and line breaks are spaces, format characters go (a zero-width
 *  joiner inside an emoji stays: it is part of one character). */
const plainName = (s: string) => s.replace(/[\p{Cc}\u2028\u2029]/gu, " ").replace(INVISIBLE, "").replace(/\s+/g, " ").trim();

/** A source's trigger as the kernel keeps it: checked, its text an `Untrusted` the source vouches for. */
export function checkTrigger(t: Trigger): Trigger {
  if (!t || typeof t !== "object") usage("a trigger is an object (packages/plugin/src/shapes.ts Trigger)");
  if (typeof t.source !== "string" || !SOURCE_NAME.test(t.source)) usage("trigger.source is a source's name");
  const id = short(t.id, "trigger.id", 200), thread = short(t.thread, "trigger.thread", 500);
  const at = typeof t.at === "string" && Number.isFinite(Date.parse(t.at)) ? new Date(t.at).toISOString() : usage("trigger.at is an ISO time");
  const a = t.actor as Trigger["actor"] | undefined;
  if (!a || typeof a !== "object" || typeof a.bot !== "boolean") usage("trigger.actor is {id, display, bot}", "Fill it from the source's own facts: who sent it, and whether a bot did.");
  const display = typeof a!.display === "string" ? plainName(a!.display).slice(0, 200) : "";
  const actor = { id: short(a!.id, "trigger.actor.id", 200), display: display || a!.id, bot: a!.bot };
  if (t.addressed !== null && t.addressed !== "mention" && t.addressed !== "direct") usage("trigger.addressed is mention, direct or null");
  const raw = t.text as Untrusted | string | undefined;
  const text = typeof raw === "string" ? raw : raw && typeof raw === "object" && typeof raw.text === "string" ? raw.text : usage("trigger.text is what was said: a string, or {text, untrusted: true, by}");
  if (Buffer.byteLength(text) > TEXT_MAX) usage(`trigger.text is over ${TEXT_MAX / 1024} KB`);
  if (t.replyTo !== null && t.replyTo !== undefined && typeof t.replyTo !== "string") usage("trigger.replyTo is a string or null");
  const data = t.data ?? {};
  if (typeof data !== "object" || Array.isArray(data)) usage("trigger.data is an object");
  if (Buffer.byteLength(JSON.stringify(data)) > DATA_MAX) usage("trigger.data is over 64 KB");
  return { source: t.source, id, thread, at, actor, addressed: t.addressed, text: { text, untrusted: true, by: `${t.source}:${actor.id}` }, replyTo: t.replyTo ?? null, data };
}

// ---- the intake --------------------------------------------------------------------------------------------------------

const redactor = new Redactor();
const said = (t: Trigger) => redactor.text(t.text.text).slice(0, TEXT_IN_LOG);
const entityOf = (t: Pick<Trigger, "source" | "id">) => `trigger:${t.source}/${sha(t.id).slice(0, 16)}`;
const decisionWord = (d: LoggedDecision) => d.kind;

/** What the planner of a run that follows the thread reads (src/agents/runner.ts messageText says who it's from). */
export function triggerMessage(t: Trigger): string {
  return `${t.actor.display}${t.actor.display !== t.actor.id ? ` (${t.actor.id})` : ""}${t.actor.bot ? ", a bot," : ""} wrote on ${t.thread}:\n\n${t.text.text}${t.replyTo ? `\n\n(A reply goes to ${t.replyTo}.)` : ""}`;
}

const why = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 500);

/** Records a decision: its line in the log, `trigger.received` on the daemon stream, `trigger.changed`. Each is tried
 *  whatever the others do, and what a record before it couldn't keep (`unrecorded`) goes in the ones that work. Returns
 *  whether the log's line was written; it never throws (the decision was made). */
async function finish(t: Trigger, decision: LoggedDecision, gate: TriggerLogEntry["gate"], principal: Principal, unrecorded: string[] = []): Promise<{ logged: boolean; unrecorded: string[] }> {
  const runId = "runId" in decision ? decision.runId : null;
  const missing = [...unrecorded];
  const restarted = decision.kind === "continued" && decision.restarted ? { restarted: decision.restarted } : {};
  let logged = true;
  try {
    appendLog({ at: iso(), source: t.source, id: t.id, thread: t.thread, actor: t.actor, addressed: t.addressed, text: said(t), decision, gate, ...(missing.length ? { unrecorded: missing } : {}) });
  } catch (e) { logged = false; missing.push(`its line in the trigger log: ${why(e)}`); }
  try {
    await record("trigger.received", entityOf(t), { source: t.source, id: redactor.text(t.id), thread: redactor.text(t.thread), actor: redactor.text(t.actor.id), addressed: t.addressed, decision: decisionWord(decision), runId, ...restarted, ...(missing.length ? { unrecorded: missing.map((m) => redactor.text(m)) } : {}) });
  } catch (e) { missing.push(`its trigger.received event: ${why(e)}`); }
  if (decision.kind !== "failed" && hooks.listening("trigger.changed")) {
    hooks.fire("trigger.changed", "observe", { trigger: t, decision }, { principal, entity: `${entityOf(t)}#${decision.kind}`, runId });
  }
  if (missing.length) console.error(`[triggers] ${t.source}/${t.id} was ${decision.kind}${runId ? ` (${runId})` : ""}, but capcomd couldn't record ${missing.join("; ")}`);
  return { logged, unrecorded: missing };
}

/** The dedupe marker: created only if absent (one emit of a (source, id) wins); an old one is taken over. */
function firstSight(t: Trigger): { first: Timestamp } | null {
  const path = dir("seen", t.source, `${sha(t.id)}.json`);
  mkdirSync(dir("seen", t.source), { recursive: true, mode: 0o700 });
  const now = iso();
  try { writeFileSync(path, JSON.stringify({ id: t.id, first: now }), { flag: "wx", mode: 0o600 }); return null; } catch { /* seen */ }
  const had = readJson<{ first: string }>(path);
  if (had && Date.now() - Date.parse(had.first) < DEDUPE_MS) return { first: had.first };
  writeAtomic(path, JSON.stringify({ id: t.id, first: now }));
  return null;
}
const forget = (t: Trigger) => rmSync(dir("seen", t.source, `${sha(t.id)}.json`), { force: true });

/**
 * `ctx.triggers.emit` (§16.3.2): decide about one trigger, act on it, record the decision. `principal` is the source
 * plugin's. A start that failed is no decision: it is logged as `failed`, the trigger can come again, and the emit
 * rejects (`invalid` for the operator's settings, else `unavailable`). So is a decision that started nothing and whose
 * line in the log couldn't be written (it is decided again when the trigger comes again). A run that started is never
 * undone: whatever couldn't be recorded after it, the dedupe mark stays, so the trigger never starts a second run.
 */
export async function admit(input: Trigger, principal: Principal): Promise<TriggerDecision> {
  const t = checkTrigger(input);
  const dup = firstSight(t);
  if (dup) { const d: TriggerDecision = { kind: "deduped", first: dup.first }; await finish(t, d, null, principal); return d; }
  let d: Awaited<ReturnType<typeof decide>>;
  try {
    d = await decide(t, principal);
  } catch (e) {
    forget(t);
    const reason = why(e);
    await finish(t, { kind: "failed", reason }, null, principal);
    if (e instanceof PluginError) throw e;
    const config = e instanceof (await import("../api/source")).CreateRunError;
    throw new PluginError(config ? "invalid" : "unavailable", `trigger ${t.source}/${t.id} was not acted on: ${reason}`, config ? "Set triggers.sources.<source>.project to a project checkout (capcomd setup project), or give the daemon a repository (CAPCOMD_REPO)." : undefined, !config);
  }
  const done = await finish(t, d.decision, d.gate, principal, d.unrecorded);
  if (!done.logged && d.decision.kind !== "started") {
    // Nothing that can't be done again happened (a continued message is idempotent by its key): it comes again.
    forget(t);
    throw new PluginError("unavailable", `trigger ${t.source}/${t.id} was ${d.decision.kind}, but its line in the trigger log couldn't be written: ${done.unrecorded.join("; ")}`, undefined, true);
  }
  return d.decision;
}

/** Steps 3 to 5 for one trigger: the kernel's gate, `trigger.admitting`, the accept mode. `act`: it may start a run (or
 *  start an ended run's planner again); else it is `denied`, or only `recorded` (observe). */
type Judged = { gate: NonNullable<TriggerLogEntry["gate"]>; denied: Extract<TriggerDecision, { kind: "denied" }> | null; recorded: boolean; act: boolean };
async function judge(t: Trigger, principal: Principal, subscribed: string | null): Promise<Judged> {
  // 3. The kernel's gate.
  const g = gateOf(triggersConfig(), t.source);
  const allowed = g.allowed.includes(t.actor.id) || g.opened.some((p) => threadMatches(p, t.thread));
  const strength = t.addressed && allowed ? "explicit" as const : "inferred" as const;
  const gate = { allowed, strength, mode: g.mode };
  const no = (denied: Judged["denied"]): Judged => ({ gate, denied, recorded: false, act: false });
  if (!allowed) return no({ kind: "denied", by: "allowlist", reason: `${t.actor.id} isn't allowed on ${t.source}, and ${t.thread} isn't opened to requests (triggers.sources.${t.source})` });
  // 4. A plugin may deny what the gate allowed.
  if (hooks.listening("trigger.admitting")) {
    const payload: TriggerAdmitting = { trigger: t, gate: { ...gate, subscribed: subscribed ? { runId: subscribed } : null } };
    const out = await hooks.fire("trigger.admitting", "veto", payload, { principal, entity: entityOf(t) });
    if (out.decision === "deny") return no({ kind: "denied", by: "plugin", reason: `${out.plugin ? `the ${out.plugin} plugin` : "capcomd (the daemon is stopping)"}: ${out.text}`.slice(0, 500) });
  }
  // 5. The accept mode.
  if (strength === "inferred" && g.mode === "off") return no({ kind: "denied", by: "mode", reason: `${t.source} is off for requests that don't address capcomd (triggers.sources.${t.source}.mode)` });
  if (strength === "inferred" && g.mode === "observe") return { gate, denied: null, recorded: true, act: false };
  return { gate, denied: null, recorded: false, act: true };
}

/** Restarts in flight, per run (the intake is the daemon's only: one process). */
const restarting = new Map<string, Promise<unknown>>();
function oneAtATime<T>(runId: string, f: () => Promise<T>): Promise<T> {
  const turn = (restarting.get(runId) ?? Promise.resolve()).then(f);
  const done = turn.then(() => {}, () => {});
  restarting.set(runId, done);
  void done.then(() => { if (restarting.get(runId) === done) restarting.delete(runId); });
  return turn;
}

async function decide(t: Trigger, principal: Principal): Promise<{ decision: TriggerDecision; gate: TriggerLogEntry["gate"]; unrecorded?: string[] }> {
  // 2. A run follows the thread: a person's trigger reaches its planner, with no further gate; a bot's only a live run.
  const { followed, unanswered } = await following(t.source, t.thread);
  // Steps 3 to 5 are asked once, the first time they matter.
  let judged: Judged | null = null;
  const judging = async () => (judged ??= await judge(t, principal, followed[0]?.sub.runId ?? null));
  for (const f of followed) {
    if (t.actor.bot && !f.standing.live) continue;
    const runId = f.sub.runId, m = { from: `trigger:${t.source}`, body: triggerMessage(t), key: `trigger-${t.source}-${sha(t.id)}` };
    // Idempotent by its key: a delivery the engine didn't confirm in time is sent again with the trigger.
    const deliver = () => engine(`delivering to ${runId}`, deps.deliver(runId, m));
    if (f.standing.live) {
      const sent = await deliver();
      if (sent) return { decision: { kind: "continued", runId, seq: sent.seq }, gate: null };
      continue;
    }
    // The run ended: a person's trigger lands in its planner's inbox, and starts the planner again only when the gate
    // would let it start a run (a restart spends as a start does): allowed and addressed, or allowed in `auto`. In
    // `observe` it is recorded with what would have happened; refused, it is only in the inbox.
    const j = await judging();
    if (j.act) {
      // One restart of a run at a time: a second trigger finds the planner the first started, and only messages it. One
      // the engine doesn't finish in time fails for now; sent again, the same trigger finishes it (the same planner).
      const asked = iso();
      const again = await engine(`starting ${runId}'s planner again`, oneAtATime(runId, () => deps.restart(runId, m))).catch((e) => { throw restartRefused(t, runId, e); });
      if (again) {
        if (again.started) awaitReply(runId, t, asked);
        return { decision: { kind: "continued", runId, seq: again.seq, ...(again.started ? { restarted: again.agentId } : {}) }, gate: j.gate };
      }
      continue;
    }
    const sent = await deliver();
    if (sent) return { decision: j.recorded ? { kind: "recorded", wouldHave: "continue", runId } : { kind: "continued", runId, seq: sent.seq }, gate: j.gate };
  }
  // A run that may follow the thread didn't say where it stands: the trigger may be its to read, so it isn't taken for a
  // new request (that could start a second run on the thread). It fails for now, and the source sends it again.
  if (unanswered) throw new PluginError("unavailable", `trigger ${t.source}/${t.id} was not acted on: ${unanswered.runId} follows ${t.thread}, and the engine didn't say where it stands (${unanswered.reason})`, "It is tried again when the source sends it again.", true);
  const j = await judging();
  if (j.denied) return { decision: j.denied, gate: j.gate };
  if (j.recorded) return { decision: { kind: "recorded", wouldHave: "start", runId: null }, gate: j.gate };
  const { gate } = j, g = gateOf(triggersConfig(), t.source);
  // 6. Act: a run on the source's project, following the thread from now on. Its goal is checked as POST /v1/runs checks
  // one: above all, a source's words never pick the run's agent profile (a leading `[agent:NAME]`).
  const goal = t.text.text.trim();
  const checked = (await import("../api/contract")).CreateRunBody.shape.goal.safeParse(goal);
  if (!checked.success) throw new PluginError("invalid", `trigger ${t.source}/${t.id} can't be a run's goal: ${checked.error.issues[0]?.message ?? "invalid"}`);
  const asked = iso();
  const { runId } = await deps.startRun({ goal, ...(g.project ? { repo: g.project } : {}) }, principal);
  // The run exists from here on: nothing below undoes the decision; what fails is recorded with it.
  const unrecorded: string[] = [];
  try { writeAtomic(dir("runs", `${runId}.json`), JSON.stringify({ source: t.source, id: t.id, thread: t.thread, actor: t.actor, at: t.at })); } catch (e) { unrecorded.push(`the trigger ${runId} started from: ${why(e)}`); }
  await subscribe({ runId, source: t.source, thread: t.thread }, "intake", { started: true }).catch((e) => unrecorded.push(`${runId}'s subscription to ${t.thread}: ${why(e)}`));
  awaitReply(runId, t, asked);
  return { decision: { kind: "started", runId }, gate, ...(unrecorded.length ? { unrecorded } : {}) };
}

// ---- subscriptions (§16.3.5) -----------------------------------------------------------------------------------------

type Cause = "expired" | "unsubscribed" | "stopped";
const STARTING_GRACE_MS = 5 * 60_000;
/** Whether a subscription still holds, given where its run stands: the cause it ends with, else null. Notes when its
 *  run ended (its default lifetime counts from then) and forgets it if the run works again. */
function endOf(r: SubRecord, s: RunStanding, now = Date.now()): Cause | null {
  // A run the intake just started may not have registered yet (its process starts it): it gets a few minutes.
  if (!s.exists) return now - Date.parse(r.at) < STARTING_GRACE_MS ? null : "expired";
  if (s.stopped) return "stopped";
  if (r.until && Date.parse(r.until) <= now) return "expired";
  if (s.live) { if (r.endedAt) writeAtomic(subPath(r), JSON.stringify({ ...r, endedAt: null })); return null; }
  const ended = r.endedAt ? Date.parse(r.endedAt) : s.endedAt ?? now;
  if (!r.endedAt) writeAtomic(subPath(r), JSON.stringify({ ...r, endedAt: iso(ended) }));
  return !r.until && ended + r.keepMs <= now ? "expired" : null;
}

async function end(r: SubRecord, cause: Cause) {
  if (!existsSync(subPath(r))) return;
  rmSync(subPath(r), { force: true });
  await record("trigger.unsubscribed", `run:${r.runId}`, { source: r.source, thread: redactor.text(r.thread), runId: r.runId, cause });
}

/** How long the intake waits for the engine to say where a run stands, or to take a message (CAPCOMD_TRIGGERS_ENGINE_MS,
 *  15 s): past it, the trigger fails for now (`unavailable`) instead of holding its source's poll. */
const engineMs = () => { const v = Number(env("TRIGGERS_ENGINE_MS") ?? 15_000); return Number.isFinite(v) && v >= 10 ? v : 15_000; };
async function engine<T>(what: string, p: Promise<T>): Promise<T> {
  const ms = engineMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the engine didn't answer ${what} within ${ms} ms`)), ms); });
  try { return await Promise.race([p, late]); } finally { clearTimeout(timer); }
}

/** The live subscriptions to a thread, newest first, each with where its run stands; ended ones end now. `unanswered`:
 *  a subscription whose run the engine said nothing about (an error or no answer in time), which may still hold. */
async function following(source: string, thread: string): Promise<{ followed: Array<{ sub: SubRecord; standing: RunStanding }>; unanswered: { runId: string; reason: string } | null }> {
  const followed: Array<{ sub: SubRecord; standing: RunStanding }> = [];
  let unanswered: { runId: string; reason: string } | null = null;
  for (const r of allSubs().filter((x) => x.source === source && x.thread === thread).sort((a, b) => b.at.localeCompare(a.at))) {
    let s: RunStanding;
    try { s = await engine(`where ${r.runId} stands`, deps.standing(r.runId)); } catch (e) { unanswered ??= { runId: r.runId, reason: why(e) }; continue; }
    const cause = endOf(r, s);
    if (cause) await end(r, cause);
    else followed.push({ sub: r, standing: s });
  }
  return { followed, unanswered };
}

/** `ctx.triggers.subscribe`: later triggers on `thread` reach the run's planner. Idempotent; `until` may be changed. */
export async function subscribe(sub: { runId: string; source: string; thread: string; until?: Timestamp }, by: string, o: { started?: boolean } = {}): Promise<TriggerSubscription> {
  if (typeof sub?.runId !== "string" || !/^run-[A-Za-z0-9_-]+$/.test(sub.runId)) usage("runId is a run id (run-…)");
  if (typeof sub.source !== "string" || !SOURCE_NAME.test(sub.source)) usage("source is a source's name");
  const thread = short(sub.thread, "thread", 500);
  let until: Timestamp | null = null;
  if (sub.until !== undefined) {
    if (typeof sub.until !== "string" || !Number.isFinite(Date.parse(sub.until))) usage("until is an ISO time");
    until = new Date(sub.until).toISOString();
  }
  // `started`: the intake's own run, just handed to its process (it may not have registered yet).
  if (!o.started && !(await deps.standing(sub.runId)).exists) throw new PluginError("not_found", `no run ${sub.runId}`);
  const key = { runId: sub.runId, source: sub.source, thread };
  const had = readJson<SubRecord>(subPath(key));
  const rec: SubRecord = { ...key, until, keepMs: KEEP_AFTER_END_MS, endedAt: had?.endedAt ?? null, by: had?.by ?? by, at: had?.at ?? iso() };
  if (had && had.until === rec.until) return subOf(had);
  writeAtomic(subPath(key), JSON.stringify(rec));
  await record("trigger.subscribed", `run:${rec.runId}`, { source: rec.source, thread: redactor.text(rec.thread), runId: rec.runId, until: subOf(rec).until });
  return subOf(rec);
}

export async function unsubscribe(sub: Pick<TriggerSubscription, "runId" | "source" | "thread">): Promise<void> {
  const r = readJson<SubRecord>(subPath(sub));
  if (r) await end(r, "unsubscribed");
}

/** The subscriptions that still hold (ended ones end as they are read). */
export async function subscriptions(filter: { runId?: string; source?: string } = {}): Promise<TriggerSubscription[]> {
  const out: TriggerSubscription[] = [];
  const standing = new Map<string, RunStanding | null>();
  for (const r of allSubs().filter((x) => (!filter.runId || x.runId === filter.runId) && (!filter.source || x.source === filter.source))) {
    if (!standing.has(r.runId)) standing.set(r.runId, await engine(`where ${r.runId} stands`, deps.standing(r.runId)).catch(() => null));
    const s = standing.get(r.runId);
    const cause = s ? endOf(r, s) : null;
    if (cause) await end(r, cause);
    else out.push(subOf(readJson<SubRecord>(subPath(r)) ?? r));
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId) || a.thread.localeCompare(b.thread));
}

/** The subscriptions as `capcomd triggers subscriptions` lists them, without asking the engine (the daemon need not run). */
export function listSubscriptionRecords(): TriggerSubscription[] { return allSubs().map(subOf); }

/** A planner that couldn't start again: refused for good (the operator's or the run's settings: its profile, budget,
 *  sandbox) unless the engine was out of reach, which may pass (the source sends the trigger again). */
function restartRefused(t: Trigger, runId: string, e: unknown): Error {
  if (e instanceof PluginError) return e;
  const message = `trigger ${t.source}/${t.id} couldn't start ${runId}'s planner again: ${String((e as Error)?.message ?? e).slice(0, 400)}`;
  if (e instanceof RelayError && e.code !== "engine_unreachable" && !e.retryable) return new PluginError("invalid", message, e.hint);
  return new PluginError("unavailable", message, undefined, true);
}

// ---- replies (§16.3.7) -----------------------------------------------------------------------------------------------

/** The request a run answers when it ends: the trigger that started it, or that started its planner again. One per run
 *  (the newest request is the one its planner works on). */
interface ReplyTarget { runId: string; source: string; thread: string; replyTo: string | null; triggerId: string; at: Timestamp; attempts: number }
const REPLY_ATTEMPTS = 3;
/** §16.5: under 100 words, with the line that says who wrote it. */
const REPLY_WORDS = 90, REPLY_CHARS = 1500;

/** A run a trigger started (or started again) answers on its thread when it ends, if the operator turned replies on.
 *  `at`: when it was asked, before the run (or its planner) started, so an end however soon after is its answer's. */
function awaitReply(runId: string, t: Trigger, at: Timestamp) {
  if (!gateOf(triggersConfig(), t.source).reply) return;
  try {
    writeAtomic(dir("replies", `${runId}.json`), JSON.stringify({ runId, source: t.source, thread: t.thread, replyTo: t.replyTo, triggerId: t.id, at, attempts: 0 } satisfies ReplyTarget));
  } catch (e) { console.error(`[triggers] ${runId}: noting its reply on ${t.thread}: ${(e as Error)?.message ?? e}`); }
}

/** A reply's words: the run's result, redacted and cut to under 100 words, and who wrote it. */
export function replyText(runId: string, o: RunOutcome): string {
  const said = o.summary ? redactor.text(o.summary).trim() : "";
  let cut = said;
  let n = 0;
  for (const w of said.matchAll(/\S+/g)) if (++n > REPLY_WORDS) { cut = `${said.slice(0, w.index).trimEnd()} …`; break; }
  if (cut.length > REPLY_CHARS) cut = `${cut.slice(0, REPLY_CHARS).trimEnd()} …`;
  const body = o.state === "completed" ? cut || "Done." : `The run stopped before it finished${cut ? `: ${cut}` : "."}`;
  return `${body}\n\n— capcomd (${runId})`;
}

/**
 * The sweep's replies: each run that ended since its request posts once through its source's reply path, if it
 * completed or failed (a person's stop needs no answer) and the source's replies are still on. A reply is claimed before
 * it is posted, so a crash while posting never posts it twice; a retryable failure, or no reply path for the source yet,
 * is tried again at the next sweep (at most three times).
 */
export async function sendReplies(): Promise<void> {
  if (!existsSync(dir("replies"))) return;
  for (const f of readdirSync(dir("replies")).filter((x) => x.endsWith(".json"))) {
    const path = dir("replies", f), r = readJson<ReplyTarget>(path);
    if (!r) { rmSync(path, { force: true }); continue; }
    const s = await deps.standing(r.runId).catch(() => null);
    if (!s) continue; // the engine didn't answer: not this time
    if (!s.exists) { if (Date.now() - Date.parse(r.at) >= STARTING_GRACE_MS) rmSync(path, { force: true }); continue; }
    // Still working, or ended before the request (an ended run's planner, starting again).
    if (s.live || s.endedAt === null || s.endedAt < Date.parse(r.at)) continue;
    if (s.stopped || !gateOf(triggersConfig(), r.source).reply) { rmSync(path, { force: true }); continue; }
    // How it ended, asked before the claim: an engine that doesn't answer now loses no reply.
    const out = await deps.outcome(r.runId).then((o) => ({ o }), () => null);
    if (!out) continue;
    if (!out.o || out.o.state === "cancelled") { rmSync(path, { force: true }); continue; }
    const claim = dir("replies", `${r.runId}.posting`);
    try { renameSync(path, claim); } catch { continue; } // another sweep took it
    const done = () => rmSync(claim, { force: true });
    const reply: TriggerReply = { source: r.source, thread: r.thread, replyTo: r.replyTo, triggerId: r.triggerId, runId: r.runId, text: replyText(r.runId, out.o), key: `reply-${r.runId}-${sha(r.triggerId).slice(0, 16)}` };
    try {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new PluginError("timeout", `the ${r.source} source didn't post the reply within ${REPLY_TIMEOUT_MS} ms`)), REPLY_TIMEOUT_MS); });
      const posted = await Promise.race([deps.reply(reply), late]).finally(() => clearTimeout(timer));
      // No reply path for the source now (its plugin is still loading, or restarting): tried again, as GitHub's own
      // trouble is, and dropped after the last try.
      if (!posted) throw new PluginError("unavailable", `the ${r.source} source has no reply path`, undefined, true);
      done();
      await record("trigger.replied", `run:${r.runId}`, { source: r.source, thread: redactor.text(r.thread), runId: r.runId, id: redactor.text(r.triggerId), url: typeof posted.url === "string" ? redactor.text(posted.url) : null }).catch(() => {});
    } catch (e) {
      // A reply that may have been posted (no answer in time) is not posted again.
      const again = e instanceof PluginError && e.retryable && e.code !== "timeout" && r.attempts + 1 < REPLY_ATTEMPTS;
      if (again) writeAtomic(path, JSON.stringify({ ...r, attempts: r.attempts + 1 }));
      done();
      console.error(`[triggers] ${r.runId}: replying on ${r.thread} through ${r.source}${again ? " (tried again at the next sweep)" : ""}: ${(e as Error)?.message ?? e}`);
    }
  }
}

// ---- the daemon's sweep ----------------------------------------------------------------------------------------------

let sweeper: ReturnType<typeof setInterval> | null = null;
/** One round: subscriptions whose run was stopped or whose time is up end; runs that ended since their request answer
 *  it (§16.3.7); dedupe markers past 30 days go. */
export async function sweepTriggers(): Promise<void> {
  await subscriptions().catch((e) => console.error(`[triggers] sweeping subscriptions: ${(e as Error)?.message ?? e}`));
  await sendReplies().catch((e) => console.error(`[triggers] sending replies: ${(e as Error)?.message ?? e}`));
  if (!existsSync(dir("seen"))) return;
  for (const source of readdirSync(dir("seen"))) {
    for (const f of readdirSync(dir("seen", source))) {
      const p = dir("seen", source, f);
      const r = readJson<{ first: string }>(p);
      if (!r || Date.now() - Date.parse(r.first) >= DEDUPE_MS) rmSync(p, { force: true });
    }
  }
}

/** `capcomd serve`: the intake's events go on the daemon stream, and its sweep runs (CAPCOMD_TRIGGERS_SWEEP_MS, 1 min). */
export function startTriggers(sink: DaemonSink): void {
  useTriggerEvents(sink);
  if (sweeper) return;
  const every = Number(env("TRIGGERS_SWEEP_MS") ?? 60_000);
  sweeper = setInterval(() => { void sweepTriggers(); }, Number.isFinite(every) && every >= 100 ? every : 60_000);
  sweeper.unref?.();
}

// ---- ctx.triggers ----------------------------------------------------------------------------------------------------

/** `ctx.triggers` for one plugin (§8.1): only the daemon has it. That `emit` names a source the plugin contributes is
 *  the host's check (packages/plugin/src/host/context.ts). */
export function pluginTriggers(plugin: string, scopes: readonly ("read" | "steer" | "configure")[] = []): Omit<TriggersService, "onReply"> {
  const principal: Principal = { kind: "plugin", name: plugin, scopes };
  return {
    emit: (t) => admit(t, principal),
    subscribe: (s) => subscribe(s, `plugin:${plugin}`),
    unsubscribe: (s) => unsubscribe(s),
    subscriptions: (f) => subscriptions(f ?? {}),
  };
}

/** Tests: stop the sweep and forget the sink, the injected kernel and the reply paths. */
export function resetTriggers() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  daemonSink = null;
  deps = kernelDeps;
  replyPaths = null;
}
