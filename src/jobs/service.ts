// The jobs service (docs/spec/plugin-api.md §16.2, §17.2 step 7): one primitive for work that outlives the call that
// started it, and for time. A job is a durable record: kv `_jobs/<id>` on its run (the scope actor writes it with its
// `job.started` / `job.ended` event), or a file in the daemon's state for a plugin's timer. Two kinds:
//  - exec: a command in its owner agent's machine (src/jobs/machine.ts), through the exec its spool pump uses. The pump
//    attaches the machine while the agent runs (src/subagents/driver.ts); while attached its jobs are looked at every
//    second. An agent's long command returns `running` and its result arrives as a message in its inbox. When the agent
//    ends its jobs are killed; when the daemon restarts, the agent's pump attaches again and its jobs are settled from
//    their files.
//  - timer: fires `at` a time, or every `everyMs` until `until`. Re-armed from its record when the daemon starts; a
//    missed fire fires once then.
// Changes reach plugins as `job.changed` hook calls (started, output, fired, ended) and the run's stream as events.
// Nobody polls a job; `wait` is a convenience bounded by its deadline. A run-owned job machine (`owner: {run: true}`
// for exec) is a later step's: refused as unsupported here.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Job, JobSpec, JobState, Principal } from "../../packages/plugin/src/shapes";
import type { JobChange } from "../../packages/plugin/src/hooks";
import type { JobsService } from "../../packages/plugin/src/context";
import { PluginError } from "../../packages/plugin/src/errors";
import { RelayError } from "../core/errors";
import { client } from "../core/relay";
import { hooks, iso } from "../plugins/hooks";
import { asPluginError } from "../plugins/services";
import { paramsHash, stableId, TERMINAL_AGENT } from "../primitives/policy";
import { env } from "../utils/env";
import { stateDir } from "../utils/home";
import { launch, look, noMessage, readFrom, signal, tails, type JobMachine } from "./machine";

export type { JobMachine } from "./machine";

/** The kernel's record of a job: the plugin API's `Job`, plus what only the kernel keeps. */
export type JobRecord = Job & {
  /** Who started it: an agent id, `plugin:<name>`, or `operator`. */
  by: string;
  /** exec: killed this long after it started (default the owner's `jobs.afterTurnMs`). */
  timeoutMs: number | null;
  /** timer: when it fires next (ms epoch), and how many times it fired. */
  nextAt?: number | null;
  fired?: number;
  /** The start's parameters, for an idempotent start by key. */
  paramsHash: string;
};

/** The limits of a job's owner (§16.2 rule 2): its profile's `jobs` block, else the daemon's `CAPCOMD_JOBS_*`. */
export interface JobLimits { max: number; foregroundMs: number; afterTurnMs: number }
const num = (v: string | undefined) => (v !== undefined && v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : undefined);
export function jobLimits(spec: { toolMode?: unknown; jobs?: { max?: number; foregroundMs?: number; afterTurnMs?: number } } | null | undefined): JobLimits {
  const j = spec?.jobs ?? {};
  return {
    max: j.max ?? num(env("JOBS_MAX")) ?? 8,
    // §16.1 item 6: an orchestrate agent's shell never blocks its inbox for long.
    foregroundMs: j.foregroundMs ?? num(env("JOBS_FOREGROUND_MS")) ?? (spec?.toolMode === "orchestrate" ? 5_000 : 60_000),
    afterTurnMs: j.afterTurnMs ?? num(env("JOBS_AFTER_TURN_MS")) ?? 1_800_000,
  };
}

/** The output kept on a settled record (§16.2: the last 64 KB, most of it stdout), and the most one output frame carries. */
const OUT_TAIL = 48 * 1024, ERR_TAIL = 16 * 1024, FRAME_MAX = 16 * 1024;
/** How much of its output a job's message to its agent quotes. */
const MESSAGE_TAIL = 4 * 1024;
const KILL_AFTER_MS = 5_000;
const AGENT_ENDED = "its agent ended";
/** A foreground wait is never longer than an in-VM call may be held (as a verify's, src/subagents/rpc.ts). */
export const FOREGROUND_MAX_MS = 90_000;
const pollMs = () => Number(env("JOBS_POLL_MS") ?? 1000);
const usage = (m: string, hint: string): never => { throw new RelayError("usage", m, hint); };

// ---- records ---------------------------------------------------------------------------------------------------------

/** The daemon's own records (plugin timers) and, for a run's job, a pointer to its run, for `get` by id and re-arming. */
const jobsDir = () => join(stateDir(), "jobs");
function writeFileAtomic(path: string, data: string) {
  mkdirSync(jobsDir(), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, { mode: 0o600 });
  renameSync(tmp, path);
}
const readJson = <T>(path: string): T | null => { try { return JSON.parse(readFileSync(path, "utf8")) as T; } catch { return null; } };
const JOB_ID = /^job-[A-Za-z0-9]{6,40}$/;

/** Where the daemon's events go (`capcomd serve` sets harnessState().recordDaemonEvent). */
type DaemonSink = (e: { type: string; entity: string; text: string; data: Record<string, unknown> }) => unknown;
let daemonSink: DaemonSink | null = null;
export function useDaemonEvents(sink: DaemonSink | null) { daemonSink = sink; }

const runIdOf = (r: Pick<JobRecord, "spec">) => r.spec.runId;
const ownerAgent = (r: Pick<JobRecord, "spec">): string | null => ("agentId" in r.spec.owner ? r.spec.owner.agentId : null);
const ownerName = (r: Pick<JobRecord, "spec">) => ownerAgent(r) ?? ("run" in r.spec.owner ? "run" : "plugin");
const msOf = (r: Pick<JobRecord, "startedAt">) => Date.parse(r.startedAt);
const live = (s: JobState) => s === "running" || s === "stopping";

async function readRecord(runId: string | null, jobId: string): Promise<JobRecord | null> {
  if (runId === null) return readJson<JobRecord>(join(jobsDir(), `${jobId}.json`));
  const v = await client().scope.getOrCreate([runId]).kvGet({ k: `_jobs/${jobId}` });
  return v && !v.deleted && v.value ? (v.value as JobRecord) : null;
}

/** Write a record, with its event when it starts or ends. A record that already ended is never written again. */
async function writeRecord(rec: JobRecord, event?: "started" | "ended"): Promise<{ ended: boolean }> {
  const runId = runIdOf(rec);
  const data = event === "started" ? { jobId: rec.jobId, kind: rec.spec.kind, owner: ownerName(rec), label: rec.spec.label, plugin: rec.plugin }
    : event === "ended" ? { jobId: rec.jobId, state: rec.state, code: rec.result && "code" in rec.result ? rec.result.code : null, reason: rec.reason, ms: Math.max(0, Date.parse(rec.endedAt ?? iso()) - msOf(rec)) }
    : undefined;
  if (runId === null) {
    const path = join(jobsDir(), `${rec.jobId}.json`);
    const cur = readJson<JobRecord>(path);
    if (cur && !live(cur.state)) return { ended: true };
    writeFileAtomic(path, JSON.stringify(rec));
    if (event && data) {
      const { describeEvent } = await import("../api/describe");
      daemonSink?.({ type: `job.${event}`, entity: rec.jobId, text: describeEvent(`job.${event}`, data, null), data });
    }
    return { ended: false };
  }
  const r = await client().scope.getOrCreate([runId]).jobWrite({ job: rec, ...(event ? { event: event === "started" ? "JOB_STARTED" : "JOB_ENDED", agentId: ownerAgent(rec), data } : {}) });
  if (event === "started") try { writeFileAtomic(join(jobsDir(), `${rec.jobId}.run`), JSON.stringify({ runId, kind: rec.spec.kind })); } catch { /* get by id needs the run then */ }
  if (r.ended || !live(rec.state)) pointerSettled(rec.jobId);
  return { ended: !!r.ended };
}

/** A run's job pointer: its run, for `get` by id and re-arming; `endedAt` once the job settled. */
type Pointer = { runId: string; kind: string; endedAt?: number };
/** How long a settled job's pointer stays (`get` by id answers for a day), and how often they are pruned. */
const POINTER_KEEP_MS = 24 * 3_600_000, PRUNE_EVERY_MS = 3_600_000;
let prunedAt = 0;

/** The job settled (§16.2 rule 6): its pointer says when, and goes a day later; nothing re-arms it, its run's kv keeps the record. */
function pointerSettled(jobId: string) {
  const path = join(jobsDir(), `${jobId}.run`);
  const p = readJson<Pointer>(path);
  try {
    if (!p) rmSync(path, { force: true }); // none, or one that can't be read: nothing to keep
    else if (p.endedAt === undefined) writeFileAtomic(path, JSON.stringify({ ...p, endedAt: Date.now() }));
  } catch { /* looked at again at the next daemon start */ }
  if (Date.now() - prunedAt >= PRUNE_EVERY_MS) prunePointers();
}

/** The pointers of jobs that settled more than a day ago go (at a daemon's start, then at most hourly as jobs settle). */
function prunePointers(now = Date.now()) {
  prunedAt = now;
  if (!existsSync(jobsDir())) return;
  for (const f of readdirSync(jobsDir())) {
    if (!f.endsWith(".run")) continue;
    const at = readJson<Pointer>(join(jobsDir(), f))?.endedAt;
    if (typeof at === "number" && now - at > POINTER_KEEP_MS) try { rmSync(join(jobsDir(), f), { force: true }); } catch { /* next time */ }
  }
}

/** The run a job belongs to (null: the daemon's), from its pointer; undefined when capcomd doesn't know the job. */
function runOfJob(jobId: string): string | null | undefined {
  if (!JOB_ID.test(jobId)) return undefined;
  if (existsSync(join(jobsDir(), `${jobId}.json`))) return null;
  return readJson<{ runId: string }>(join(jobsDir(), `${jobId}.run`))?.runId;
}

async function listRecords(runId: string | null): Promise<JobRecord[]> {
  if (runId === null) {
    if (!existsSync(jobsDir())) return [];
    return readdirSync(jobsDir()).filter((f) => f.endsWith(".json")).flatMap((f) => { const r = readJson<JobRecord>(join(jobsDir(), f)); return r ? [r] : []; });
  }
  const rows = await client().scope.getOrCreate([runId]).kvList({ prefix: "_jobs/" });
  return (rows as Array<{ value: unknown }>).flatMap((r) => (r.value ? [r.value as JobRecord] : []));
}

/** The plugin API's `Job` (§3), without the kernel's own fields. */
export function jobOf(r: JobRecord): Job {
  return { jobId: r.jobId, plugin: r.plugin, spec: r.spec, state: r.state, startedAt: r.startedAt, endedAt: r.endedAt, result: r.result, reason: r.reason };
}

function principalOf(by: string, runId: string | null): Principal {
  if (by.startsWith("agt-") && runId) return { kind: "agent", agentId: by, runId };
  if (by.startsWith("plugin:")) return { kind: "plugin", name: by.slice("plugin:".length), scopes: [] };
  return { kind: "operator", clientId: null };
}
let frames = 0;
/** §6.6.19: a change told to the plugins that listen (never awaited). */
function tell(r: JobRecord, change: JobChange) {
  if (!hooks.listening("job.changed")) return;
  hooks.fire("job.changed", "observe", { job: jobOf(r), change }, { principal: principalOf(r.by, runIdOf(r)), entity: `${r.jobId}#${change.kind}${++frames}`, runId: runIdOf(r), agentId: ownerAgent(r) });
}

// ---- waiting --------------------------------------------------------------------------------------------------------

const waiters = new Map<string, Set<(r: JobRecord) => void>>();
function settled(r: JobRecord) {
  for (const w of waiters.get(r.jobId) ?? []) w(r);
  waiters.delete(r.jobId);
}
/** Resolves with the settled record, or null at `ms`. */
function until(jobId: string, ms: number): Promise<JobRecord | null> {
  return new Promise((resolve) => {
    const set = waiters.get(jobId) ?? new Set();
    waiters.set(jobId, set);
    const done = (r: JobRecord | null) => { clearTimeout(t); set.delete(done as (r: JobRecord) => void); resolve(r); };
    const t = setTimeout(() => done(null), Math.max(0, ms));
    set.add(done as (r: JobRecord) => void);
  });
}

// ---- exec jobs in an agent's machine ---------------------------------------------------------------------------------

interface Watch {
  rec: JobRecord;
  /** Output already told (`job.changed` output), in bytes. */
  out: number; err: number; frameAt: number;
  /** A foreground start waits for this job: its result goes to that caller, not to a message. */
  fg: ((r: JobRecord) => void) | null;
  /** When to send SIGKILL (5 s after SIGTERM). */
  killAt: number | null;
  settling: boolean;
  /** Its agent stopped it itself: no message about it. */
  quiet: boolean;
}
interface Attached { m: JobMachine; watches: Map<string, Watch>; loop: ReturnType<typeof setInterval> | null; busy: boolean }
const machines = new Map<string, Attached>();
const machineKey = (runId: string, agentId: string) => `${runId}/${agentId}`;

/**
 * The agent's machine, while it runs (its spool pump, src/subagents/driver.ts): its jobs, started now or before a
 * restart, are watched from here. `detach({ended: true})` when the agent ended: its jobs are killed (§16.2 rule 4).
 */
export async function attachMachine(m: JobMachine): Promise<{ detach: (o: { ended: boolean }) => Promise<void> }> {
  const key = machineKey(m.runId, m.agentId);
  const at: Attached = machines.get(key) ?? { m, watches: new Map(), loop: null, busy: false };
  at.m = m;
  machines.set(key, at);
  // A restart: the jobs it had running are watched again, and settled from their files (§16.2 rule 6).
  const recs = await listRecords(m.runId).catch(() => [] as JobRecord[]);
  for (const r of recs) {
    if (r.spec.kind !== "exec" || ownerAgent(r) !== m.agentId || !live(r.state) || at.watches.has(r.jobId)) continue;
    // One that was being stopped gets its SIGKILL now if it is still there.
    watch(at, r).killAt = r.state === "stopping" ? Date.now() : null;
  }
  return { detach: (o) => detach(key, o) };
}

function watch(at: Attached, rec: JobRecord, fg: Watch["fg"] = null): Watch {
  const w: Watch = { rec, out: 0, err: 0, frameAt: 0, fg, killAt: null, settling: false, quiet: false };
  at.watches.set(rec.jobId, w);
  if (!at.loop) {
    at.loop = setInterval(() => { if (!at.busy) { at.busy = true; tick(at).catch(() => {}).finally(() => { at.busy = false; }); } }, pollMs());
    at.loop.unref?.();
  }
  return w;
}

function unwatch(at: Attached, jobId: string) {
  at.watches.delete(jobId);
  if (!at.watches.size && at.loop) { clearInterval(at.loop); at.loop = null; }
}

async function tick(at: Attached) {
  const ws = [...at.watches.values()].filter((w) => !w.settling);
  if (!ws.length) return;
  const seen = await look(at.m, ws.map((w) => w.rec.jobId)).catch(() => null);
  if (!seen) return; // the machine didn't answer: next time
  const now = Date.now();
  for (const w of ws) {
    const s = seen.get(w.rec.jobId);
    if (!s) continue;
    if (s.state === "exited") { void settleExec(at, w, s.killed ? "killed" : s.code === 0 ? "done" : "failed", s.code, s.killed, { endedAt: s.at }); continue; }
    if (s.state === "gone") { void settleExec(at, w, "lost", null, s.why); continue; }
    if (hooks.listening("job.changed") && (s.out > w.out || s.err > w.err) && now - w.frameAt >= 1000) {
      w.frameAt = now;
      const f = await readFrom(at.m, w.rec.jobId, { out: w.out, err: w.err }, FRAME_MAX).catch(() => null);
      if (f) { w.out += Buffer.byteLength(f.stdout); w.err += Buffer.byteLength(f.stderr); tell(w.rec, { kind: "output", stdout: f.stdout, stderr: f.stderr }); }
    }
    if (w.killAt !== null && now >= w.killAt) { w.killAt = null; await signal(at.m, w.rec.jobId, "KILL").catch(() => {}); continue; }
    if (w.rec.state === "stopping") continue;
    const timeout = w.rec.timeoutMs ?? jobLimits(null).afterTurnMs;
    if (now - msOf(w.rec) > timeout) void stopExec(at, w, `its timeout (${secs(timeout)}) passed`);
  }
}

/** SIGTERM now, SIGKILL in 5 s if it is still there; the job settles `killed` when it exits. */
async function stopExec(at: Attached, w: Watch, reason: string) {
  if (w.rec.state === "stopping") return;
  w.rec = { ...w.rec, state: "stopping", reason };
  await writeRecord(w.rec).catch(() => {});
  w.killAt = Date.now() + KILL_AFTER_MS;
  await signal(at.m, w.rec.jobId, "TERM", reason).catch(() => {});
}

/** `endedAt`: when it exited, as its runner wrote it (it may have ended while the daemon was down). */
async function settleExec(at: Attached, w: Watch, state: "done" | "failed" | "killed" | "lost", code: number | null, reason: string | null, o: { quiet?: boolean; endedAt?: number | null } = {}) {
  if (w.settling) return;
  w.settling = true;
  try {
    const t = state === "lost" ? null : await tails(at.m, w.rec.jobId, OUT_TAIL, ERR_TAIL).catch(() => null);
    const rec: JobRecord = {
      ...w.rec, state, endedAt: iso(o.endedAt && o.endedAt <= Date.now() ? Math.max(o.endedAt, msOf(w.rec)) : Date.now()), reason: state === "done" || state === "failed" ? null : reason ?? w.rec.reason,
      result: code === null && !t ? null : { code: code ?? -1, stdout: t?.stdout ?? "", stderr: t?.stderr ?? "", truncated: t?.truncated ?? false },
    };
    const { ended } = await writeRecord(rec, "ended");
    unwatch(at, rec.jobId);
    if (ended) return; // another watcher settled it first
    tell(rec, { kind: "ended", state });
    const fg = w.fg, message = !fg && !o.quiet && !w.quiet && rec.by === ownerAgent(rec);
    if (fg) fg(rec);
    else if (message) await notifyAgent(rec).catch((e) => console.error(`[jobs] ${rec.jobId}: telling ${rec.by}: ${(e as Error)?.message ?? e}`));
    // No message comes for it: its supervisor doesn't hold the agent's input open waiting for one (an agent that is
    // ending, o.quiet, has nobody waiting). Never awaited: at worst the supervisor waits as if one might come.
    if (!message && !o.quiet) void noMessage(at.m, rec.jobId).catch(() => {});
    settled(rec);
  } catch (e) {
    w.settling = false; // next tick tries again
    console.error(`[jobs] ${w.rec.jobId}: settling: ${(e as Error)?.message ?? e}`);
  }
}

/** §16.2 rule 1: the result of a job that answered `running` arrives as a message its supervisor delivers. */
async function notifyAgent(r: JobRecord) {
  const agentId = ownerAgent(r)!;
  const a = await client().scope.getOrCreate([r.spec.runId!]).getAgent({ agentId });
  if (!a || TERMINAL_AGENT.has(a.status)) return;
  await client().scope.getOrCreate([r.spec.runId!]).sendMessage({ to: agentId, from: r.jobId, body: jobMessage(r), key: `job-ended-${r.jobId}` });
}

const secs = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : ms < 120_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60_000)} min`);
const lastBytes = (s: string, n: number) => (Buffer.byteLength(s) <= n ? s : Buffer.from(s).subarray(-n).toString("utf8").replace(/^�+/, ""));
/** What the agent reads when its background job ended. */
export function jobMessage(r: JobRecord): string {
  const res = r.result && "code" in r.result ? r.result : null;
  const took = secs(Math.max(0, Date.parse(r.endedAt ?? iso()) - msOf(r)));
  const how = r.state === "done" ? "finished (exit 0)" : r.state === "failed" ? `failed (exit ${res?.code ?? "?"})` : r.state === "killed" ? `was stopped: ${r.reason ?? "killed"}` : `was lost: ${r.reason ?? "its process went away"}`;
  const out = [res?.stdout ? `stdout (last part):\n${lastBytes(res.stdout, MESSAGE_TAIL)}` : "", res?.stderr ? `stderr (last part):\n${lastBytes(res.stderr, MESSAGE_TAIL / 2)}` : ""].filter(Boolean).join("\n\n");
  return `Your background job ${r.jobId} (${r.spec.label}) ${how} after ${took}.${out ? `\n\n${out}` : " It printed nothing."}\n\nAll of its output: capcomd job output ${r.jobId}`;
}

/**
 * The agent ended for good (it failed, or was cancelled after its attempt stopped): its jobs settle now, not when next
 * read (§16.2 rule 4). While its machine is attached here they are killed in it; otherwise (its attempt let go of the
 * machine, which goes with the agent) an exec job settles `lost`. Its timers end.
 */
export async function endAgentJobs(runId: string, agentId: string, reason: string): Promise<void> {
  const key = machineKey(runId, agentId);
  if (machines.has(key)) return detach(key, { ended: true });
  await endAgentTimers(runId, agentId);
  for (const r of await listRecords(runId)) {
    if (r.spec.kind === "exec" && live(r.state) && ownerAgent(r) === agentId) await settleLost(r, reason).catch((e) => console.error(`[jobs] ${r.jobId}: settling: ${(e as Error)?.message ?? e}`));
  }
}

async function detach(key: string, o: { ended: boolean }) {
  const at = machines.get(key);
  if (!at) return;
  machines.delete(key);
  if (at.loop) { clearInterval(at.loop); at.loop = null; }
  if (!o.ended) return; // a restart attaches again
  // The agent ended: its jobs end with it (§16.2 rule 4), its timers too. TERM, up to 5 s to exit, then KILL.
  await endAgentTimers(at.m.runId, at.m.agentId);
  const ws = [...at.watches.values()].filter((w) => !w.settling);
  if (!ws.length) return;
  const reason = AGENT_ENDED;
  await Promise.all(ws.map((w) => signal(at.m, w.rec.jobId, "TERM", reason).catch(() => {})));
  const deadline = Date.now() + KILL_AFTER_MS;
  let left = ws;
  while (left.length && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 250));
    const seen = await look(at.m, left.map((w) => w.rec.jobId)).catch(() => null);
    if (!seen) break;
    left = left.filter((w) => seen.get(w.rec.jobId)?.state === "running");
  }
  await Promise.all(left.map((w) => signal(at.m, w.rec.jobId, "KILL").catch(() => {})));
  await Promise.all(ws.map((w) => settleExec(at, w, "killed", null, reason, { quiet: true })));
}

// ---- timers ---------------------------------------------------------------------------------------------------------

const armed = new Map<string, ReturnType<typeof setTimeout>>();
const MAX_DELAY = 2 ** 31 - 1;

function arm(r: JobRecord) {
  clearTimeout(armed.get(r.jobId));
  if (!live(r.state) || r.nextAt == null) { armed.delete(r.jobId); return; }
  const t = setTimeout(() => { armed.delete(r.jobId); void fire(runIdOf(r), r.jobId); }, Math.min(MAX_DELAY, Math.max(0, r.nextAt - Date.now())));
  t.unref?.();
  armed.set(r.jobId, t);
}

/** A timer stops: `killed`, with why. */
async function endTimer(r: JobRecord, why: string): Promise<JobRecord> {
  clearTimeout(armed.get(r.jobId)); armed.delete(r.jobId);
  const rec: JobRecord = { ...r, state: "killed", endedAt: iso(), reason: why, nextAt: null };
  if (!(await writeRecord(rec, "ended")).ended) { tell(rec, { kind: "ended", state: "killed" }); settled(rec); }
  return rec;
}

/** §16.2 rule 4: timers owned by an agent end with it (run-owned and plugin-owned ones don't). */
async function endAgentTimers(runId: string, agentId: string) {
  const recs = await listRecords(runId).catch(() => [] as JobRecord[]);
  for (const r of recs) if (r.spec.kind === "timer" && live(r.state) && ownerAgent(r) === agentId) await endTimer(r, AGENT_ENDED).catch(() => {});
}

async function fire(runId: string | null, jobId: string) {
  const r = await readRecord(runId, jobId).catch(() => null);
  if (!r || !live(r.state) || r.spec.kind !== "timer" || r.nextAt == null) return;
  if (r.nextAt > Date.now() + 50) { arm(r); return; } // a long delay armed in parts
  // An agent's timer whose agent ended where no pump saw it end (an agent with no spool): it ends now, unfired.
  const agentId = ownerAgent(r);
  if (agentId && runId) {
    const a = await client().scope.getOrCreate([runId]).getAgent({ agentId }).catch(() => "unreachable" as const);
    if (a === "unreachable") { arm({ ...r, nextAt: Date.now() + 5_000 }); return; } // the engine didn't answer: soon
    if (!a || TERMINAL_AGENT.has(a.status)) { await endTimer(r, AGENT_ENDED).catch(() => {}); return; }
  }
  const n = (r.fired ?? 0) + 1, now = Date.now(), spec = r.spec;
  const untilMs = spec.until ? Date.parse(spec.until) : Infinity;
  const next = spec.everyMs ? Math.max(now, r.nextAt) + spec.everyMs : null;
  const last = next === null || next > untilMs;
  const rec: JobRecord = { ...r, fired: n, nextAt: last ? null : next, result: { fired: n }, ...(last ? { state: "done" as const, endedAt: iso(now) } : {}) };
  const { ended } = await writeRecord(rec, last ? "ended" : undefined).catch(() => ({ ended: true }));
  if (ended) return;
  tell(rec, { kind: "fired", n });
  if (last) { tell(rec, { kind: "ended", state: "done" }); settled(rec); return; }
  arm(rec);
}

/**
 * `capcomd serve`, once its plugins are loaded: the timers of the daemon and of its runs are armed again from their
 * records (§16.2 rule 6); one that should have fired while the daemon was down fires once now. A run's pointer whose
 * job settled unmarked (or whose run is gone) is marked settled, without making the run again to look, and old ones go.
 */
export async function resumeTimers(): Promise<number> {
  if (!existsSync(jobsDir())) return 0;
  prunePointers();
  let n = 0;
  for (const f of readdirSync(jobsDir())) {
    const id = f.replace(/\.(json|run)$/, "");
    if (armed.has(id) || !JOB_ID.test(id)) continue;
    let r: JobRecord | null = null;
    if (f.endsWith(".json")) r = readJson<JobRecord>(join(jobsDir(), f));
    else if (f.endsWith(".run")) {
      const p = readJson<Pointer>(join(jobsDir(), f));
      if (p?.endedAt !== undefined) continue;
      const got = typeof p?.runId === "string" ? await existingRecord(p.runId, id).catch(() => undefined) : null;
      if (got === undefined) continue; // the engine didn't answer: looked at again at the next start
      if (!got || !live(got.state)) { pointerSettled(id); continue; }
      r = got;
    }
    if (r && r.spec.kind === "timer" && live(r.state)) { arm(r); n++; }
  }
  return n;
}

/** A run's job record, without making the run when it is gone (null then). */
async function existingRecord(runId: string, jobId: string): Promise<JobRecord | null> {
  const { existingActor } = await import("../core/relay");
  const s = await existingActor("scope", [runId]);
  const v = s ? await s.kvGet({ k: `_jobs/${jobId}` }) : null;
  return v && !v.deleted && v.value ? (v.value as JobRecord) : null;
}

// ---- the primitives -------------------------------------------------------------------------------------------------

export interface StartOptions {
  /** Who starts it: an agent id, `plugin:<name>`, or `operator`. */
  by: string;
  plugin?: string | null;
  key?: string;
  /** exec: the machine it runs in (the caller's, in-VM; else the owner agent's attached one). */
  machine?: JobMachine;
  /** exec: the longest the caller can wait for the answer (an in-VM call's time). */
  foregroundCapMs?: number;
}

function checkSpec(spec: JobSpec) {
  if (!spec || (spec.kind !== "exec" && spec.kind !== "timer")) usage("a job is kind exec or timer", "exec runs a command; timer fires at a time or on an interval.");
  if (typeof spec.label !== "string" || !spec.label.trim() || spec.label.length > 200) usage("a job needs a label (1-200 characters)", "Say what it is, e.g. \"tests\".");
  const o = spec.owner as Record<string, unknown>;
  const owner = o && typeof o === "object" ? (typeof o.agentId === "string" ? "agent" : o.run === true ? "run" : o.plugin === true ? "plugin" : null) : null;
  if (!owner) usage("a job's owner is {agentId}, {run: true} or {plugin: true}", "An agent's job ends with it; a run's or a plugin's doesn't.");
  if (spec.runId !== null && (typeof spec.runId !== "string" || !/^run-[A-Za-z0-9_-]+$/.test(spec.runId))) usage(`not a run id: ${String(spec.runId).slice(0, 80)}`, "A run id is run-…, or null for a plugin's own timer.");
  if (spec.runId === null && owner !== "plugin") usage("only a plugin's timer lives outside a run", "Name the run (runId), or own it as the plugin.");
  if (spec.kind === "exec") {
    if (owner === "run") throw new RelayError("conflict", "a run-owned job needs a job machine of its run, which this capcomd doesn't make yet", "Own it as an agent: it runs in that agent's machine.", { code: "unsupported" });
    if (owner === "plugin") usage("an exec job is owned by an agent", "It runs in that agent's machine.");
    if (!Array.isArray(spec.cmd) || !spec.cmd.length || spec.cmd.length > 256 || spec.cmd.some((x) => typeof x !== "string")) usage("cmd is a non-empty list of strings", "One string runs with sh -c; more are argv.");
    if (Buffer.byteLength(JSON.stringify(spec.cmd)) > 16 * 1024) usage("cmd is over 16 KB", "Put a long script in a file and run that.");
    if (spec.cwd !== undefined && (typeof spec.cwd !== "string" || !spec.cwd.startsWith("/") || spec.cwd.split("/").includes(".."))) usage("cwd is an absolute path", "Where the command runs, e.g. your checkout.");
    if (spec.env !== undefined && (!spec.env || typeof spec.env !== "object" || Object.entries(spec.env).some(([k, v]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) || typeof v !== "string"))) usage("env is an object of strings", "Names are letters, digits and _.");
    for (const k of ["foregroundMs", "timeoutMs"] as const) if (spec[k] !== undefined && !(Number.isInteger(spec[k]) && spec[k]! >= 0)) usage(`${k} is a whole number of milliseconds`, "e.g. 60000.");
    if (spec.timeoutMs !== undefined && spec.timeoutMs < 1000) usage("timeoutMs is at least 1000", "A job gets at least a second.");
  } else {
    if (spec.at === undefined && spec.everyMs === undefined) usage("a timer needs at or everyMs", "at: once; everyMs: on an interval (until `until`).");
    if (spec.everyMs !== undefined && !(Number.isInteger(spec.everyMs) && spec.everyMs >= 1000)) usage("everyMs is at least 1000", "A timer fires at most once a second.");
    for (const k of ["at", "until"] as const) if (spec[k] !== undefined && !Number.isFinite(Date.parse(String(spec[k])))) usage(`${k} is an ISO time`, "e.g. 2026-11-05T12:00:00.000Z.");
  }
}

/** The spec as it is recorded: env values are not kept (a run's records are readable in it). */
const recordedSpec = (spec: JobSpec): JobSpec => (spec.kind === "exec" && spec.env ? { ...spec, env: Object.fromEntries(Object.keys(spec.env).map((k) => [k, "[set]"])) } : spec);

/**
 * Start a job (§16.2 rule 1). An exec job that ends within its foreground wait (the spec's `foregroundMs`, else the
 * owner's `jobs.foregroundMs`) returns `done` or `failed` with its result; otherwise `running`, and its result arrives
 * later (`job.changed`, and a message to the agent that started it). Idempotent by `key`. Refused past the owner's
 * `jobs.max` running jobs.
 */
export async function startJob(spec: JobSpec, o: StartOptions): Promise<Job> {
  checkSpec(spec);
  const runId = spec.runId;
  const owner = "agentId" in spec.owner ? spec.owner.agentId : null;
  const ph = paramsHash({ spec: { ...spec, foregroundMs: undefined }, by: o.by });
  const jobId = o.key ? stableId("job", `${runId ?? `daemon:${o.plugin ?? o.by}`}\0${o.by}`, o.key) : stableId("job", runId ?? "daemon");
  const have = await readRecord(runId, jobId);
  if (have) {
    if (have.paramsHash !== ph) throw new RelayError("conflict", `job key ${o.key} was used with other parameters`, "Use a new key for a different job.", { code: "idempotency_conflict" });
    if (have.spec.kind === "timer" && live(have.state) && !armed.has(have.jobId)) arm(have);
    if (have.spec.kind === "exec" && live(have.state) && o.machine) { const at = machines.get(machineKey(o.machine.runId, o.machine.agentId)); if (at && !at.watches.has(have.jobId)) watch(at, have); }
    return jobOf(have);
  }
  const a = owner && runId ? await client().scope.getOrCreate([runId]).getAgent({ agentId: owner }) : null;
  if (owner && (!a || TERMINAL_AGENT.has(a.status))) throw new RelayError("conflict", `agent ${owner} ${a ? `is ${a.status}` : "isn't in this run"}: its jobs would end at once`, "Start jobs for an agent that is running.", { code: "not_running" });
  const limits = jobLimits(a?.spec as Parameters<typeof jobLimits>[0]);
  // §16.2 rule 2: at most `max` running jobs per owner.
  const mine = (await listRecords(runId)).filter((r) => live(r.state) && (owner ? ownerAgent(r) === owner : r.plugin === (o.plugin ?? null)));
  if (mine.length >= limits.max) throw new RelayError("conflict", `${owner ?? `the ${o.plugin} plugin`} has ${mine.length} running jobs, its most (jobs.max ${limits.max})`, "Wait for one to end (its result arrives as a message), or kill one: capcomd job kill <id>.", { code: "too_many_jobs" });
  const now = Date.now();
  const base: JobRecord = { jobId, plugin: o.plugin ?? null, spec: recordedSpec(spec), state: "running", startedAt: iso(now), endedAt: null, result: null, reason: null, by: o.by, timeoutMs: null, paramsHash: ph };

  if (spec.kind === "timer") {
    const first = spec.at ? Date.parse(spec.at) : now + spec.everyMs!;
    const rec: JobRecord = { ...base, nextAt: first, fired: 0, result: { fired: 0 } };
    await writeRecord(rec, "started");
    tell(rec, { kind: "started" });
    arm(rec);
    return jobOf(rec);
  }

  const at = machines.get(machineKey(runId!, owner!));
  const m = o.machine ?? at?.m;
  if (!m) throw new RelayError("engine_unreachable", `agent ${owner}'s machine isn't reachable from here: its jobs run where its spool is pumped`, "Start it from the agent (capcomd job start), or while the agent runs in this daemon.", { code: "unavailable", retryable: true });
  const att = machines.get(machineKey(m.runId, m.agentId)) ?? (await attachMachine(m), machines.get(machineKey(m.runId, m.agentId))!);
  // §16.2 rule 2: a job's own timeout, by default the owner's afterTurnMs.
  const rec: JobRecord = { ...base, timeoutMs: spec.timeoutMs ?? limits.afterTurnMs };
  await writeRecord(rec, "started");
  try {
    await launch(m, jobId, { cmd: spec.cmd, cwd: spec.cwd ?? m.cwd, ...(spec.env ? { env: spec.env } : {}) });
  } catch (e) {
    const failed: JobRecord = { ...rec, state: "failed", endedAt: iso(), result: { code: 127, stdout: "", stderr: String((e as Error)?.message ?? e).slice(0, 2000), truncated: false } };
    await writeRecord(failed, "ended");
    tell(failed, { kind: "ended", state: "failed" });
    return jobOf(failed);
  }
  tell(rec, { kind: "started" });
  const fgMs = Math.min(FOREGROUND_MAX_MS, o.foregroundCapMs ?? Infinity, spec.foregroundMs ?? limits.foregroundMs);
  let resolveFg!: (r: JobRecord | null) => void;
  const fg = new Promise<JobRecord | null>((r) => { resolveFg = r; });
  const w = watch(att, rec, (r) => resolveFg(r));
  const timer = setTimeout(() => { w.fg = null; resolveFg(null); }, fgMs);
  const done = await fg;
  clearTimeout(timer);
  return jobOf(done ?? w.rec);
}

/** A job by id: its run's record, or the daemon's. A job whose agent ended while nobody watched settles `lost`. */
export async function getJob(jobId: string, runId?: string | null): Promise<Job> {
  const run = runId !== undefined ? runId : runOfJob(jobId);
  const r = run === undefined || !JOB_ID.test(jobId) ? null : await readRecord(run, jobId);
  if (!r) throw new RelayError("not_found", `job ${jobId} not found`, "List jobs with capcomd job list.");
  return jobOf(await orphaned(r));
}

/** An agent's exec job still `running` on record, nobody watching it here, and its agent ended: settled `lost`. */
async function orphaned(r: JobRecord): Promise<JobRecord> {
  const agentId = ownerAgent(r);
  if (r.spec.kind !== "exec" || !live(r.state) || !agentId || machines.get(machineKey(r.spec.runId!, agentId))?.watches.has(r.jobId)) return r;
  const a = await client().scope.getOrCreate([r.spec.runId!]).getAgent({ agentId }).catch(() => null);
  if (a && !TERMINAL_AGENT.has(a.status)) return r;
  return settleLost(r, "its agent ended while capcomd wasn't watching the job");
}

/** An exec job nobody here watches settles `lost`: its machine goes, or went, with its agent. */
async function settleLost(r: JobRecord, reason: string): Promise<JobRecord> {
  const rec: JobRecord = { ...r, state: "lost", endedAt: iso(), reason };
  const { ended } = await writeRecord(rec, "ended");
  if (ended) return (await readRecord(r.spec.runId, r.jobId)) ?? rec;
  tell(rec, { kind: "ended", state: "lost" });
  settled(rec);
  return rec;
}

export async function listJobs(filter: { runId?: string | null; agentId?: string; plugin?: string; state?: JobState }): Promise<Job[]> {
  const runId = filter.runId ?? null;
  const recs = await Promise.all((await listRecords(runId)).filter((r) => (!filter.agentId || ownerAgent(r) === filter.agentId) && (!filter.plugin || r.plugin === filter.plugin)).map(orphaned));
  return recs.filter((r) => !filter.state || r.state === filter.state).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(jobOf);
}

/** §16.2 rule 5: stop it (exec: SIGTERM, SIGKILL after 5 s; it settles `killed` once it exited). */
export async function cancelJob(jobId: string, reason: string, o: { runId?: string | null; byOwner?: boolean } = {}): Promise<Job> {
  const run = o.runId !== undefined ? o.runId : runOfJob(jobId);
  const r = run === undefined ? null : await readRecord(run, jobId);
  if (!r) throw new RelayError("not_found", `job ${jobId} not found`, "List jobs with capcomd job list.");
  if (!live(r.state)) return jobOf(r);
  const why = reason.trim().slice(0, 300) || "killed";
  if (r.spec.kind === "timer") return jobOf(await endTimer(r, why));
  const at = machines.get(machineKey(r.spec.runId!, ownerAgent(r)!));
  const w = at?.watches.get(jobId);
  if (!at || !w) return jobOf(await orphaned(r));
  if (o.byOwner) w.quiet = true;
  await stopExec(at, w, why);
  return jobOf(w.rec);
}

/** Resolves when the job settled, or at `timeoutMs` (default 30 s) with its record as it is then. */
export async function waitJob(jobId: string, o: { runId?: string | null; timeoutMs?: number } = {}): Promise<Job> {
  const now = await getJob(jobId, o.runId);
  if (!live(now.state)) return now;
  const r = await until(jobId, o.timeoutMs ?? 30_000);
  return r ? jobOf(r) : getJob(jobId, o.runId);
}

// ---- ctx.jobs ---------------------------------------------------------------------------------------------------------

/**
 * `ctx.jobs` for one plugin (§8.1): its jobs are `plugin:<name>`'s; only the daemon has it. One owner (§16.2 rule 8):
 * it reaches its own jobs and a run's jobs no other plugin started (an agent's, the operator's); another plugin's job
 * is `not_found`, as one that doesn't exist, and its lists leave it out.
 */
export function pluginJobs(plugin: string): JobsService {
  const by = `plugin:${plugin}`;
  const mine = (j: Job) => (j.plugin === null ? j.spec.runId !== null : j.plugin === plugin);
  const reach = async (jobId: string) => {
    const j = await getJob(jobId);
    if (!mine(j)) throw new RelayError("not_found", `job ${jobId} not found`, "List jobs with capcomd job list.");
    return j;
  };
  return {
    start: (spec, o) => startJob(spec, { by, plugin, ...(o?.key ? { key: o.key } : {}) }).catch(asPluginError),
    get: (jobId) => reach(jobId).catch(asPluginError),
    list: (f) => (f.runId ? listJobs({ runId: f.runId, ...(f.agentId ? { agentId: f.agentId } : {}), ...(f.state ? { state: f.state } : {}) }) : listJobs({ runId: null, plugin, ...(f.state ? { state: f.state } : {}) })).then((js) => js.filter(mine)).catch(asPluginError),
    cancel: (jobId, reason) => reach(jobId).then((j) => cancelJob(j.jobId, `by the ${plugin} plugin: ${reason}`, { runId: j.spec.runId })).catch(asPluginError),
    wait: (jobId, o) => reach(jobId).then((j) => waitJob(j.jobId, { runId: j.spec.runId, ...(o?.timeoutMs !== undefined ? { timeoutMs: o.timeoutMs } : {}) })).catch(asPluginError),
  };
}

/** Tests: forget this process's watches and timers. */
export function resetJobs() {
  for (const at of machines.values()) if (at.loop) clearInterval(at.loop);
  machines.clear();
  for (const t of armed.values()) clearTimeout(t);
  armed.clear();
  waiters.clear();
}
