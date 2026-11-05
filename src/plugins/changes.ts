// The `*.changed` hooks (docs/spec/plugin-api.md §6.6.4, .8, .14, .16, .18) from the one place every run, agent,
// verify, merge and approval change is committed: the run's scope actor and its event log (src/actors/scope.ts). Its
// actions are wrapped: while a plugin listens to one of these hooks, the events an action committed are read back
// after it (so only committed changes are told) and become observe calls, before the action answers. With no
// listener an action runs exactly as before. `started`/`finished` of a verify come from here; its `checked` and
// `judged`, which only the verify knows, from src/primitives/ops.ts.
import type { AgentChange, ApprovalChange, MergeChange, RunChange, VerifyChange } from "../../packages/plugin/src/hooks";
import type { HookName } from "../../packages/plugin/src/hooks";
import type { Run } from "../../packages/plugin/src/shapes";
import type { ScopeAgent, ScopeOp } from "../actors/scope";
import { hooks, iso, principalOf, untrusted } from "./hooks";
import { agentOf, approvalOf, mergeOf, verificationOf } from "./shapes";

const CHANGED: readonly HookName[] = ["run.changed", "agent.changed", "verify.changed", "merge.changed", "approval.changed"];

type Ev = { seq: number; at: number; type: string; agentId: string | null; data: Record<string, any> };
type Rows = { agent(r: any): ScopeAgent; op(r: any): ScopeOp };
type Db = { execute(sql: string, ...args: unknown[]): Promise<any[]> };
/** Per actor: the last event told (null until a listener first appears), and the flushes in order. */
type Tap = { mark: number; ready: Promise<void>; chain: Promise<void> };
const taps = new Map<string, Tap>();

/** Wrap a scope actor's actions (reads, named get…, pass through untouched). */
export function changedHooks<A extends Record<string, (c: any, ...args: any[]) => any>>(actions: A, rows: Rows): A {
  const out: Record<string, any> = {};
  for (const [name, fn] of Object.entries(actions)) {
    if (name.startsWith("get") || name.startsWith("list") || name === "driveMode" || name === "inbox" || name === "itemsHead" || name === "isRevoked") { out[name] = fn; continue; }
    out[name] = function (this: unknown, c: any, ...args: any[]) {
      if (!hooks.listeningAny(CHANGED)) return fn.call(this, c, ...args);
      return tapped(c, rows, () => fn.call(this, c, ...args));
    };
  }
  return out as A;
}

async function tapped(c: any, rows: Rows, run: () => unknown) {
  const db: Db = c.db;
  const runId = Array.isArray(c.key) && typeof c.key[0] === "string" ? (c.key[0] as string) : null;
  const id = String(c.actorId ?? runId);
  let t = taps.get(id);
  if (!t) {
    // The first action after a listener appeared: only what changes from now on is told.
    const tap: Tap = { mark: Number.MAX_SAFE_INTEGER, ready: Promise.resolve(), chain: Promise.resolve() };
    tap.ready = db.execute("SELECT COALESCE(MAX(seq), 0) AS s FROM scope_events").then((r) => { tap.mark = Number(r[0]?.s ?? 0); }, () => { taps.delete(id); });
    taps.set(id, t = tap);
    if (taps.size > 5000) taps.delete(taps.keys().next().value!);
  }
  await t.ready;
  try { return await run(); } finally {
    const tap = t;
    if (runId) await (tap.chain = tap.chain.then(() => flush(db, runId, tap, rows)).catch((e) => { console.error(`[plugins] ${runId}: telling plugins what changed failed: ${(e as Error)?.message ?? e}`); }));
  }
}

async function flush(db: Db, runId: string, t: Tap, rows: Rows) {
  const evs: Ev[] = (await db.execute("SELECT * FROM scope_events WHERE seq > ? ORDER BY seq", t.mark))
    .map((r: any) => ({ seq: Number(r.seq), at: Number(r.at), type: String(r.type), agentId: (r.agent_id as string | null) ?? null, data: JSON.parse(r.data) }));
  if (!evs.length) return;
  t.mark = evs.at(-1)!.seq;
  const at = (e: Ev) => ({ principal: principalOf(null), entity: `${runId}#${e.seq}`, runId, agentId: e.agentId });
  const agentRow = async (agentId: string) => { const r = await db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", agentId); return r.length ? rows.agent(r[0]) : null; };
  const opRow = async (opId: unknown) => { const r = typeof opId === "string" ? await db.execute("SELECT * FROM ops WHERE op_id = ?", opId) : []; return r.length ? rows.op(r[0]) : null; };
  const { approvalIdFor } = await import("../api/source");
  const runChanges = hooks.listening("run.changed") ? await runChangesOf(db, runId, evs) : [];
  for (const e of evs) {
    for (const r of runChanges.filter((x) => x.seq === e.seq)) hooks.fire("run.changed", "observe", { run: r.run, change: r.change }, at(e));
    if (e.agentId && hooks.listening("agent.changed")) {
      const change = agentChange(e);
      const a = change ? await agentRow(e.agentId) : null;
      if (change && a) hooks.fire("agent.changed", "observe", { agent: agentOf(a), change }, at(e));
    }
    const verify = verifyChange(e);
    if (verify && hooks.listening("verify.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("verify.changed", "observe", { verification: verificationOf(runId, op), change: verify }, at(e));
    }
    const merge = mergeChange(e, (opId) => approvalIdFor(runId, opId));
    if (merge && hooks.listening("merge.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("merge.changed", "observe", { merge: mergeOf(runId, op), change: merge }, at(e));
    }
    const approval = approvalChange(e, (opId) => approvalIdFor(runId, opId));
    if (approval && hooks.listening("approval.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("approval.changed", "observe", { approval: approvalOf(runId, op, approvalIdFor(runId, op.id)), change: approval }, at(e));
    }
  }
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export function agentChange(e: Ev): AgentChange | null {
  const d = e.data;
  switch (e.type) {
    case "AGENT_SPAWNED": return { kind: "spawned" };
    // Recorded when the agent is claimed, before its machine: sandbox.changed tells the machine.
    case "AGENT_STARTED": return { kind: "started", machine: null, attempt: 1 };
    case "AGENT_RESUMED": return { kind: "resumed", by: str(d.by) ?? "capcomd" };
    case "AGENT_STEP": return { kind: "step", step: { kind: String(d.kind), n: Number(d.n), startedAt: iso(Number(d.startedAt)), endedAt: iso(Number(d.endedAt)) } };
    case "AGENT_CHECKPOINT": return { kind: "checkpointed", files: Number(d.files ?? 0), commit: str(d.sha), at: iso(Number(d.at ?? e.at)) };
    case "AGENT_NOTICE": return { kind: "notice", notice: { kind: d.kind, detail: untrusted(String(d.detail ?? ""), "capcomd"), at: iso(Number(d.at ?? e.at)) } };
    case "AGENT_NOTICE_CLEARED": return { kind: "notice", notice: null };
    case "AGENT_PAUSED": return { kind: "paused", by: str(d.result?.by) ?? (d.result?.limit === "quota" ? "quota" : "capcomd") };
    case "AGENT_TITLED": return { kind: "titled" };
    case "AGENT_DONE": case "AGENT_FAILED": {
      const r = (d.result ?? {}) as Record<string, any>;
      const by = e.agentId ?? "agent";
      return { kind: "ended", status: e.type === "AGENT_DONE" ? "done" : "failed", result: {
        ok: e.type === "AGENT_DONE", summary: typeof r.summary === "string" ? untrusted(r.summary, by) : null, claim: typeof r.claim === "string" ? untrusted(r.claim, by) : null,
        data: r.data ?? null, spent: (d.spent ?? {}) as Record<string, number>,
      } };
    }
    case "AGENT_CANCELLED": case "AGENT_REAPED": return { kind: "ended", status: "cancelled", result: null };
    default: return null;
  }
}

export function verifyChange(e: Ev): VerifyChange | null {
  if (e.type === "VERIFY_STARTED") return { kind: "started" };
  if (e.type === "VERIFY_PASSED" || e.type === "VERIFY_FAILED") return { kind: "finished", passed: e.type === "VERIFY_PASSED" };
  return null;
}

export function mergeChange(e: Ev, approvalId: (opId: string) => string): MergeChange | null {
  const d = e.data;
  switch (e.type) {
    case "MERGE_STARTED": return { kind: "requested" };
    case "MERGED": return { kind: "landed", sha: String(d.sha ?? ""), pr: typeof d.pr?.number === "number" ? d.pr.number : typeof d.pr === "number" ? d.pr : null, bypassedVetoes: Array.isArray(d.bypassedVetoes) ? d.bypassedVetoes : [] };
    case "MERGE_FAILED": return { kind: "failed", reason: str(d.reason) ?? str(d.status) ?? "failed" };
    case "MERGE_DENIED": return { kind: "failed", reason: "denied" };
    case "MERGE_AWAITING_APPROVAL": return { kind: "parked", approvalId: approvalId(String(d.id)) };
    default: return null;
  }
}

export function approvalChange(e: Ev, approvalId: (opId: string) => string): ApprovalChange | null {
  if (e.type === "MERGE_AWAITING_APPROVAL") return { kind: "requested" };
  if (e.type !== "MERGE_APPROVED" && e.type !== "MERGE_DENIED") return null;
  const by = str(e.data.by);
  return { kind: "decided", decision: { approvalId: approvalId(String(e.data.id)), status: e.type === "MERGE_APPROVED" ? "approved" : "denied", decidedBy: by ? { clientId: by, principal: by } : null, decidedAt: iso(e.at), reason: str(e.data.reason) } };
}

/** The run's own changes in this batch, from the lifecycle feed's fold over its whole log (src/api/lifecycle.ts): its
 *  start, pause, resume and end follow from its agents' states. */
async function runChangesOf(db: Db, runId: string, batch: Ev[]): Promise<Array<{ seq: number; run: Run; change: RunChange }>> {
  if (!batch.some((e) => /^(RUN_|AGENT_(STARTED|RESUMED|PAUSED|DONE|FAILED|CANCELLED|REAPED))/.test(e.type))) return [];
  const { lifecycleEvents } = await import("../api/lifecycle");
  const all: Ev[] = (await db.execute("SELECT * FROM scope_events ORDER BY seq"))
    .map((r: any) => ({ seq: Number(r.seq), at: Number(r.at), type: String(r.type), agentId: (r.agent_id as string | null) ?? null, data: JSON.parse(r.data) }));
  const from = batch[0]!.seq;
  const meta = (await db.execute("SELECT k, v FROM scope_meta WHERE k IN ('init', 'run_title')")) as Array<{ k: string; v: string }>;
  const init = JSON.parse(meta.find((m) => m.k === "init")?.v ?? "{}");
  const title = meta.find((m) => m.k === "run_title") ? (JSON.parse(meta.find((m) => m.k === "run_title")!.v).title as string) : null;
  let state = "new";
  const out: Array<{ seq: number; run: Run; change: RunChange }> = [];
  for (const env of lifecycleEvents(runId, all)) {
    const change = runChange(env.type, env.data as Record<string, any>);
    if (!change) continue;
    state = change.kind === "ended" ? change.state : change.kind === "paused" ? "paused" : change.kind === "created" ? "new" : change.kind === "titled" ? state : "running";
    if (env.seq < from) continue;
    out.push({ seq: env.seq, change, run: { id: runId, projectId: null, label: init.label ?? null, state, goal: init.goal ?? null, title, repo: null, createdAt: init.createdAt ? iso(init.createdAt) : null } });
  }
  return out;
}

function runChange(type: string, d: Record<string, any>): RunChange | null {
  switch (type) {
    case "run.created": return { kind: "created" };
    case "run.started": return { kind: "started" };
    case "run.paused": return { kind: "paused", by: str(d.by) ?? "capcomd" };
    case "run.resumed": return { kind: "resumed", by: str(d.by) ?? "capcomd" };
    case "run.titled": return { kind: "titled" };
    case "run.completed": return { kind: "ended", state: "completed", reason: null };
    case "run.failed": return { kind: "ended", state: "failed", reason: str(d.reason) };
    case "run.cancelled": return { kind: "ended", state: "cancelled", reason: str(d.reason) };
    default: return null;
  }
}


