// The `*.changed` hooks (docs/spec/plugin-api.md §6.6.4, .8, .14, .16, .18) from the one place every run, agent,
// verify, merge and approval change is committed: the run's scope actor and its event log (src/actors/scope.ts). Its
// actions are wrapped: while a plugin listens to one of these hooks, the events an action committed are read back
// after it (so only committed changes are told) and become observe calls, before the action answers. With no
// listener an action runs exactly as before. `started`/`finished` of a verify come from here; its `checked` and
// `judged`, which only the verify knows, from src/primitives/ops.ts.
import type { AgentChange, ApprovalChange, MergeChange, RunChange, VerifyChange } from "../../packages/plugin/src/hooks";
import type { HookName } from "../../packages/plugin/src/hooks";
import type { Principal, Run } from "../../packages/plugin/src/shapes";
import type { ScopeAgent, ScopeOp } from "../actors/scope";
import { pinnedRuntime } from "../profiles/runtime";
import { hooks, iso, principalOf, untrusted } from "./hooks";
import { agentOf, approvalOf, mergeOf, verificationOf } from "./shapes";

const CHANGED: readonly HookName[] = ["run.changed", "agent.changed", "verify.changed", "merge.changed", "approval.changed"];

type Ev = { seq: number; at: number; type: string; agentId: string | null; data: Record<string, any> };
type Rows = { agent(r: any): ScopeAgent; op(r: any): ScopeOp };
type Db = { execute(sql: string, ...args: unknown[]): Promise<any[]> };
/** Per actor: the last event told (null until a listener first appears), and the flushes in order. */
type Tap = { mark: number; ready: Promise<void>; chain: Promise<void> };
const taps = new Map<string, Tap>();
const runOf = (c: any): string | null => (Array.isArray(c?.key) && typeof c.key[0] === "string" ? (c.key[0] as string) : null);
const tapOf = (c: any): string => String(c?.actorId ?? runOf(c));

/** Wrap a scope actor's actions (reads, named get…, pass through untouched). */
export function changedHooks<A extends Record<string, (c: any, ...args: any[]) => any>>(actions: A, rows: Rows): A {
  const out: Record<string, any> = {};
  for (const [name, fn] of Object.entries(actions)) {
    if (name.startsWith("get") || name.startsWith("list") || name === "driveMode" || name === "inbox" || name === "itemsHead" || name === "isRevoked") { out[name] = fn; continue; }
    out[name] = function (this: unknown, c: any, ...args: any[]) {
      if (!hooks.listeningAny(CHANGED)) {
        // Nobody listens: what this action commits is told to no one, then or later. The tap is dropped, so a listener
        // that comes back is told only what changes from then on (the next tapped action marks where that starts).
        if (taps.size) taps.delete(tapOf(c));
        return fn.call(this, c, ...args);
      }
      return tapped(c, rows, () => fn.call(this, c, ...args));
    };
  }
  return out as A;
}

async function tapped(c: any, rows: Rows, run: () => unknown) {
  const db: Db = c.db;
  const runId = runOf(c);
  const id = tapOf(c);
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
  const agentRow = async (agentId: string) => { const r = await db.execute("SELECT * FROM agents_v2 WHERE agent_id = ?", agentId); return r.length ? rows.agent(r[0]) : null; };
  const opRow = async (opId: unknown) => { const r = typeof opId === "string" ? await db.execute("SELECT * FROM ops WHERE op_id = ?", opId) : []; return r.length ? rows.op(r[0]) : null; };
  // Who caused each change (§3.2, §6.1): read once per event, and only for an event something is told about.
  const causes = new Map<number, Promise<Principal>>();
  const cause = (e: Ev) => {
    let p = causes.get(e.seq);
    if (!p) {
      p = (async () => causeOf(e, runId, OP_EVENTS.has(e.type) ? await opRow(e.data.id) : null, e.type === "AGENT_STARTED" && e.agentId ? await agentRow(e.agentId) : null))();
      causes.set(e.seq, p);
    }
    return p;
  };
  const at = async (e: Ev) => ({ principal: await cause(e), entity: `${runId}#${e.seq}`, runId, agentId: e.agentId });
  const { approvalIdFor } = await import("../api/source");
  const runChanges = hooks.listening("run.changed") ? await runChangesOf(db, runId, evs) : [];
  for (const e of evs) {
    for (const r of runChanges.filter((x) => x.seq === e.seq)) hooks.fire("run.changed", "observe", { run: r.run, change: r.change }, await at(e));
    if (e.agentId && hooks.listening("agent.changed")) {
      const change = agentChange(e);
      const a = change ? await agentRow(e.agentId) : null;
      // ADR-024 `lifecycle`: the plugins its profile names hear that they were named (they filter on it, §6.6.8).
      const lifecycle = a ? pinnedRuntime(a.spec).lifecycle : undefined;
      if (change && a) hooks.fire("agent.changed", "observe", { agent: agentOf(a), change, ...(lifecycle ? { lifecycle } : {}) }, await at(e));
    }
    const verify = verifyChange(e);
    if (verify && hooks.listening("verify.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("verify.changed", "observe", { verification: verificationOf(runId, op), change: verify }, await at(e));
    }
    const merge = mergeChange(e, (opId) => approvalIdFor(runId, opId));
    if (merge && hooks.listening("merge.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("merge.changed", "observe", { merge: mergeOf(runId, op), change: merge }, await at(e));
    }
    const approval = approvalChange(e, (opId) => approvalIdFor(runId, opId));
    if (approval && hooks.listening("approval.changed")) {
      const op = await opRow(e.data.id);
      if (op) hooks.fire("approval.changed", "observe", { approval: approvalOf(runId, op, approvalIdFor(runId, op.id)), change: approval }, await at(e));
    }
  }
}

/**
 * `agent.changed` `worked` (§6.6.8, §16.4): what the agent's runner saw it doing (its files changed, a foreground command
 * running), told from the scope's `worked` once the agent's record says it runs. It is no event in the run's log (one
 * every heartbeat for each working agent would crowd it), so it is told when seen and never replayed. The agent's own.
 */
export function tellWorked(runId: string, a: ScopeAgent, w: { files: boolean; commandSince: number | null; at: number }): void {
  if (!hooks.listening("agent.changed")) return;
  const lifecycle = pinnedRuntime(a.spec).lifecycle;
  const change: AgentChange = { kind: "worked", files: w.files, command: w.commandSince ? { since: iso(w.commandSince) } : null, at: iso(w.at) };
  hooks.fire("agent.changed", "observe", { agent: agentOf(a), change, ...(lifecycle ? { lifecycle } : {}) },
    { principal: principalOf(a.agentId, runId), entity: `${runId}#worked-${a.agentId}-${w.at}`, runId, agentId: a.agentId });
}

/** The events about a verification or a merge: their asker is the op's (`askedBy`), their approver the event's `by`. */
const OP_EVENTS = new Set(["VERIFY_STARTED", "VERIFY_PASSED", "VERIFY_FAILED", "MERGE_STARTED", "MERGED", "MERGE_FAILED", "MERGE_AWAITING_APPROVAL", "MERGE_APPROVED", "MERGE_DENIED"]);

/**
 * Who caused a committed change (plugin API §3.2), from what the kernel records with it: an agent's own work (its
 * steps, checkpoints, notices, result) is the agent's; its spawn and start are its spawner's (the parent agent, else the
 * operator); a pause, resume, cancel or title names who did it (`by`, `setBy`); a verification's and a merge's changes
 * are their asker's (an agent's in-VM call), and an approval's decision its approver's. What the kernel did on its own
 * or nobody recorded is the operator's (§3.2 has no kernel principal; principalOf's default).
 */
export function causeOf(e: Ev, runId: string, op: { data: Record<string, unknown> } | null = null, agent: { parent: string | null } | null = null): Principal {
  const d = e.data;
  const by = (v: unknown) => principalOf(typeof v === "string" ? v : null, runId);
  switch (e.type) {
    case "AGENT_SPAWNED": return by(d.parent);
    case "AGENT_STARTED": return by(agent?.parent);
    case "AGENT_RESUMED": case "AGENT_CANCELLED": case "RUN_ENDED": return by(d.by);
    case "AGENT_PAUSED": return by(d.result?.by);
    case "AGENT_REAPED": return by(d.orphanOf);
    case "AGENT_TITLED": case "RUN_TITLED": return by(d.setBy);
    case "MERGE_APPROVED": case "MERGE_DENIED": return by(d.by);
    default:
      if (OP_EVENTS.has(e.type)) return by(op?.data.askedBy);
      return e.agentId && e.type.startsWith("AGENT_") ? principalOf(e.agentId, runId) : principalOf(null);
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


