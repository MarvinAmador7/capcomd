// The trigger intake (docs/spec/plugin-api.md §16.3, §17.2 step 10): what the kernel does with an external event a
// source plugin hands it (`ctx.triggers.emit`). It decides, in this order, and records every decision:
//  1. dedupe: the same (source, id) within 30 days is `deduped`;
//  2. subscription: a thread a run follows (a live run, or one that ended less than `until` ago) gets the trigger as a
//     message to the run's planner, `continued`, when a person sent it (a bot's reaches only a live run);
//  3. the kernel's gate, `triggers.sources.<source>` in the operator's config: an actor it allows or a thread it opened
//     to requests is `allowed`, else `denied {by: allowlist}`; addressed and allowed is `explicit`, else `inferred`;
//  4. `trigger.admitting`: a plugin may deny (`denied {by: plugin}`), never admit;
//  5. the accept mode (default `observe`): explicit acts in every mode; inferred is denied (`off`), only recorded with
//     what would have happened (`observe`), or acted on (`auto`);
//  6. act: a run on the source's project with the trigger's text as its goal (POST /v1/runs semantics: run.creating
//     fires), `started`, subscribed to the trigger's thread.
// What the intake never does is judge content: the planner reads the goal and may decide there is nothing to do.
// Only the daemon has an intake (its plugins get `ctx.triggers`, src/plugins/host.ts); its records are files in the
// daemon's state (state/triggers/): `seen/` (dedupe), `subs/` (subscriptions), `runs/` (the trigger a run started
// from), and `log.ndjson`, what `capcomd triggers log` reads. Its events (trigger.received, trigger.subscribed,
// trigger.unsubscribed) go on the daemon stream; `trigger.changed` tells plugins each decision.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Principal, Timestamp, Trigger, TriggerDecision, TriggerSubscription, Untrusted } from "../../packages/plugin/src/shapes";
import type { TriggerAdmitting } from "../../packages/plugin/src/hooks";
import type { TriggersService } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import { Redactor } from "../agents/redact";
import { readConfig, userConfigPath } from "../config/store";
import { hooks, iso } from "../plugins/hooks";
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
export function gateOf(cfg: TriggersConfig, source: string): { allowed: string[]; opened: string[]; mode: AcceptMode; project: string | null } {
  const g = (cfg.sources?.[source] ?? {}) as SourceGate;
  return {
    allowed: strings(g.allowed), opened: strings(g.opened),
    mode: ACCEPT_MODES.includes(g.mode as AcceptMode) ? (g.mode as AcceptMode) : "observe",
    project: typeof g.project === "string" && g.project.trim() ? g.project.trim() : null,
  };
}

/** `opened` patterns: exact, or with `*` for any run of characters. */
export function threadMatches(pattern: string, thread: string): boolean {
  if (!pattern.includes("*")) return pattern === thread;
  return new RegExp(`^${pattern.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*")}$`, "s").test(thread);
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
export interface IntakeDeps {
  /** Start a run with `goal` (POST /v1/runs semantics; run.creating fires), in `repo` (a project checkout) or the daemon's. */
  startRun(input: { goal: string; repo?: string }, principal: Principal): Promise<{ runId: string }>;
  /** A message to the run's planner; null when the run has none to read it. */
  deliver(runId: string, m: { from: string; body: string; key: string }): Promise<{ seq: number } | null>;
  standing(runId: string): Promise<RunStanding>;
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
    const { PLANNER_KV, rootAgentIdFor } = await import("../primitives/ops");
    const kv: any = await s.kvGet({ k: PLANNER_KV }).catch(() => null);
    let to: string | null = typeof kv?.value?.agentId === "string" && !kv.deleted ? kv.value.agentId : null;
    // A run from before the record, or one whose driver spawned its planner with the key "planner".
    if (!to) { const id = rootAgentIdFor(runId, "planner"); if (await s.getAgent({ agentId: id }).catch(() => null)) to = id; }
    if (!to) return null;
    const r = await s.sendMessage({ to, from: m.from, body: m.body, key: m.key });
    return { seq: r.seq };
  },
  async standing(runId) {
    const { existingActor } = await import("../core/relay");
    const s = /^run-[A-Za-z0-9_-]+$/.test(runId) ? await existingActor("scope", [runId]).catch(() => null) : null;
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

/** Where the intake's events go: the daemon stream (`capcomd serve` sets harnessState().recordDaemonEvent). */
type DaemonSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => unknown;
let daemonSink: DaemonSink | null = null;
export function useTriggerEvents(sink: DaemonSink | null) { daemonSink = sink; }
async function record(type: "trigger.received" | "trigger.subscribed" | "trigger.unsubscribed", entity: string, data: Record<string, unknown>) {
  if (!daemonSink) return;
  const { describeEvent } = await import("../api/describe");
  daemonSink({ type, entity, text: describeEvent(type, data, null), data });
}

// ---- checking what a source emits ------------------------------------------------------------------------------------

const usage = (m: string, hint?: string): never => { throw new PluginError("invalid", m, hint); };
const SOURCE_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const TEXT_MAX = 64 * 1024, DATA_MAX = 64 * 1024;
const short = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string" || !v.trim()) usage(`${what} is a non-empty string`);
  if ((v as string).length > max) usage(`${what} is longer than ${max} characters`);
  return v as string;
};

/** A source's trigger as the kernel keeps it: checked, its text an `Untrusted` the source vouches for. */
export function checkTrigger(t: Trigger): Trigger {
  if (!t || typeof t !== "object") usage("a trigger is an object (packages/plugin/src/shapes.ts Trigger)");
  if (typeof t.source !== "string" || !SOURCE_NAME.test(t.source)) usage("trigger.source is a source's name");
  const id = short(t.id, "trigger.id", 200), thread = short(t.thread, "trigger.thread", 500);
  const at = typeof t.at === "string" && Number.isFinite(Date.parse(t.at)) ? new Date(t.at).toISOString() : usage("trigger.at is an ISO time");
  const a = t.actor as Trigger["actor"] | undefined;
  if (!a || typeof a !== "object" || typeof a.bot !== "boolean") usage("trigger.actor is {id, display, bot}", "Fill it from the source's own facts: who sent it, and whether a bot did.");
  const actor = { id: short(a!.id, "trigger.actor.id", 200), display: typeof a!.display === "string" && a!.display.trim() ? a!.display.slice(0, 200) : a!.id, bot: a!.bot };
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

async function finish(t: Trigger, decision: LoggedDecision, gate: TriggerLogEntry["gate"], principal: Principal): Promise<void> {
  const runId = "runId" in decision ? decision.runId : null;
  appendLog({ at: iso(), source: t.source, id: t.id, thread: t.thread, actor: t.actor, addressed: t.addressed, text: said(t), decision, gate });
  await record("trigger.received", entityOf(t), { source: t.source, id: redactor.text(t.id), thread: redactor.text(t.thread), actor: redactor.text(t.actor.id), addressed: t.addressed, decision: decisionWord(decision), runId }).catch(() => {});
  if (decision.kind !== "failed" && hooks.listening("trigger.changed")) {
    hooks.fire("trigger.changed", "observe", { trigger: t, decision }, { principal, entity: `${entityOf(t)}#${decision.kind}`, runId });
  }
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
 * rejects (`invalid` for the operator's settings, else `unavailable`).
 */
export async function admit(input: Trigger, principal: Principal): Promise<TriggerDecision> {
  const t = checkTrigger(input);
  const dup = firstSight(t);
  if (dup) { const d: TriggerDecision = { kind: "deduped", first: dup.first }; await finish(t, d, null, principal); return d; }
  try {
    const d = await decide(t, principal);
    await finish(t, d.decision, d.gate, principal);
    return d.decision;
  } catch (e) {
    forget(t);
    const reason = String((e as Error)?.message ?? e).slice(0, 500);
    await finish(t, { kind: "failed", reason }, null, principal).catch(() => {});
    if (e instanceof PluginError) throw e;
    const config = e instanceof (await import("../api/source")).CreateRunError;
    throw new PluginError(config ? "invalid" : "unavailable", `trigger ${t.source}/${t.id} was not acted on: ${reason}`, config ? "Set triggers.sources.<source>.project to a project checkout (capcomd setup project), or give the daemon a repository (CAPCOMD_REPO)." : undefined, !config);
  }
}

async function decide(t: Trigger, principal: Principal): Promise<{ decision: TriggerDecision; gate: TriggerLogEntry["gate"] }> {
  // 2. A run follows the thread: a person's trigger reaches its planner, with no further gate; a bot's only a live run.
  const followed = await following(t.source, t.thread);
  for (const f of followed) {
    if (t.actor.bot && !f.standing.live) continue;
    const sent = await deps.deliver(f.sub.runId, { from: `trigger:${t.source}`, body: triggerMessage(t), key: `trigger-${t.source}-${sha(t.id)}` });
    if (sent) return { decision: { kind: "continued", runId: f.sub.runId, seq: sent.seq }, gate: null };
  }
  // 3. The kernel's gate.
  const g = gateOf(triggersConfig(), t.source);
  const allowed = g.allowed.includes(t.actor.id) || g.opened.some((p) => threadMatches(p, t.thread));
  const strength = t.addressed && allowed ? "explicit" as const : "inferred" as const;
  const gate = { allowed, strength, mode: g.mode };
  if (!allowed) return { decision: { kind: "denied", by: "allowlist", reason: `${t.actor.id} isn't allowed on ${t.source}, and ${t.thread} isn't opened to requests (triggers.sources.${t.source})` }, gate };
  // 4. A plugin may deny what the gate allowed.
  if (hooks.listening("trigger.admitting")) {
    const payload: TriggerAdmitting = { trigger: t, gate: { ...gate, subscribed: followed[0] ? { runId: followed[0].sub.runId } : null } };
    const out = await hooks.fire("trigger.admitting", "veto", payload, { principal, entity: entityOf(t) });
    if (out.decision === "deny") return { decision: { kind: "denied", by: "plugin", reason: `${out.plugin ? `the ${out.plugin} plugin` : "capcomd (the daemon is stopping)"}: ${out.text}`.slice(0, 500) }, gate };
  }
  // 5. The accept mode.
  if (strength === "inferred" && g.mode === "off") return { decision: { kind: "denied", by: "mode", reason: `${t.source} is off for requests that don't address capcomd (triggers.sources.${t.source}.mode)` }, gate };
  if (strength === "inferred" && g.mode === "observe") return { decision: { kind: "recorded", wouldHave: "start", runId: null }, gate };
  // 6. Act: a run on the source's project, following the thread from now on.
  const { runId } = await deps.startRun({ goal: t.text.text.trim(), ...(g.project ? { repo: g.project } : {}) }, principal);
  writeAtomic(dir("runs", `${runId}.json`), JSON.stringify({ source: t.source, id: t.id, thread: t.thread, actor: t.actor, at: t.at }));
  await subscribe({ runId, source: t.source, thread: t.thread }, "intake", { started: true }).catch((e) => console.error(`[triggers] ${runId}: subscribing to ${t.thread}: ${(e as Error)?.message ?? e}`));
  return { decision: { kind: "started", runId }, gate };
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

/** The live subscriptions to a thread, newest first, each with where its run stands; ended ones end now. */
async function following(source: string, thread: string): Promise<Array<{ sub: SubRecord; standing: RunStanding }>> {
  const out: Array<{ sub: SubRecord; standing: RunStanding }> = [];
  for (const r of allSubs().filter((x) => x.source === source && x.thread === thread).sort((a, b) => b.at.localeCompare(a.at))) {
    const s = await deps.standing(r.runId).catch(() => null);
    if (!s) continue; // the engine didn't answer: not this time
    const cause = endOf(r, s);
    if (cause) await end(r, cause);
    else out.push({ sub: r, standing: s });
  }
  return out;
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
    if (!standing.has(r.runId)) standing.set(r.runId, await deps.standing(r.runId).catch(() => null));
    const s = standing.get(r.runId);
    const cause = s ? endOf(r, s) : null;
    if (cause) await end(r, cause);
    else out.push(subOf(readJson<SubRecord>(subPath(r)) ?? r));
  }
  return out.sort((a, b) => a.runId.localeCompare(b.runId) || a.thread.localeCompare(b.thread));
}

/** The subscriptions as `capcomd triggers subscriptions` lists them, without asking the engine (the daemon need not run). */
export function listSubscriptionRecords(): TriggerSubscription[] { return allSubs().map(subOf); }

// ---- the daemon's sweep ----------------------------------------------------------------------------------------------

let sweeper: ReturnType<typeof setInterval> | null = null;
/** One round: subscriptions whose run was stopped or whose time is up end; dedupe markers past 30 days go. */
export async function sweepTriggers(): Promise<void> {
  await subscriptions().catch((e) => console.error(`[triggers] sweeping subscriptions: ${(e as Error)?.message ?? e}`));
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
export function pluginTriggers(plugin: string, scopes: readonly ("read" | "steer" | "configure")[] = []): TriggersService {
  const principal: Principal = { kind: "plugin", name: plugin, scopes };
  return {
    emit: (t) => admit(t, principal),
    subscribe: (s) => subscribe(s, `plugin:${plugin}`),
    unsubscribe: (s) => unsubscribe(s),
    subscriptions: (f) => subscriptions(f ?? {}),
  };
}

/** Tests: stop the sweep and forget the sink and the injected kernel. */
export function resetTriggers() {
  if (sweeper) clearInterval(sweeper);
  sweeper = null;
  daemonSink = null;
  deps = kernelDeps;
}
