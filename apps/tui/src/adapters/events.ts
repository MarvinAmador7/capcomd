import type { RunEvent } from "./types";

/**
 * Accepts every event shape capcomd prints:
 *  - `capcomd run --json` stream lines: { schema, type, runId, ts, ...fields }
 *  - `capcomd events <id> --json`:       { schema, ok, events: [{ entity, seq, at, type, event }] }
 *  - `capcomd events <id> --follow --json` lines: { runId, seq, ts, epochMs, agentId, type, event: <record> }, then { end }
 *  - `capcomd inspect <id> --json [--follow]`: snapshot { events: [...] } and { type: "event", event: <record> } lines
 * Error envelopes ({ ok:false, error }) become a synthetic `cli.error` event so failures stay visible.
 */
export function parseEvents(text: string): RunEvent[] {
  const out: RunEvent[] = [];
  const t = text.trim();
  if (!t) return out;
  const lines = t.startsWith("{") && !t.includes("\n") ? [t] : t.split("\n");
  let lastAt = 0;
  for (const line of lines) {
    let v: any;
    try { v = JSON.parse(line); } catch { continue; }
    if (!v || typeof v !== "object") continue;
    if (Array.isArray(v.events)) { for (const r of v.events) push(fromRecord(r)); continue; }
    if (v.event && typeof v.event === "object") { push(fromRecord(v.event)); continue; }
    if (v.end !== undefined || /^inspect\./.test(v.type ?? "")) continue;
    if (v.ok === false && v.error) { push({ at: lastAt, type: "cli.error", entity: "cli", data: v.error }); continue; }
    if (typeof v.type === "string") push(fromRecord(v));
  }
  return out.sort((a, b) => a.at - b.at || (a.seq ?? 0) - (b.seq ?? 0));

  function push(e: RunEvent | null) { if (e) { out.push(e); lastAt = e.at; } }
}

/** Envelope fields the contract adds to every record. `ok` stays: on run.result it is payload. */
const META = new Set(["schema", "type", "ts", "at", "epochMs", "runId", "seq", "entitySeq", "agentId", "entity"]);

function fromRecord(r: any): RunEvent | null {
  if (!r || typeof r !== "object") return null;
  const inner = r.event && typeof r.event === "object" ? r.event : r;
  const type = String(r.type ?? inner.type ?? "unknown");
  const at = toMs(r.epochMs ?? r.at ?? r.ts ?? inner.epochMs ?? inner.at ?? inner.ts);
  if (at === null) return null;
  // harness.v1 envelopes ({ v: 1, ..., data }) carry the payload in `data`.
  const harness = r.v === 1 && r.data && typeof r.data === "object" && !Array.isArray(r.data);
  const data: Record<string, unknown> = harness ? { ...r.data } : {};
  if (!harness) for (const [k, v] of Object.entries(inner)) if (!META.has(k)) data[k] = v;
  const agentId = (r.agentId ?? inner.agentId ?? null) as string | null;
  const entity = String(r.entity ?? inner.taskId ?? agentId ?? "run");
  const ev: RunEvent = { at, type, entity, data };
  if (typeof r.seq === "number") ev.seq = r.seq;
  if (typeof r.entitySeq === "number") ev.entitySeq = r.entitySeq;
  if ("agentId" in r || "agentId" in inner) ev.agentId = agentId;
  return ev;
}

/** Contract dedupe key: (entity, entitySeq); falls back to seq, then the instant + type. */
export const eventKey = (e: RunEvent) => (e.entitySeq !== undefined ? `${e.entity}#${e.entitySeq}` : e.seq !== undefined ? `seq#${e.seq}` : `${e.entity}@${e.at}:${e.type}`);

export function mergeEvents(a: RunEvent[], b: RunEvent[]): RunEvent[] {
  const m = new Map<string, RunEvent>();
  for (const e of [...a, ...b]) m.set(eventKey(e), e);
  return [...m.values()].sort((x, y) => x.at - y.at || (x.seq ?? 0) - (y.seq ?? 0));
}

function toMs(x: unknown): number | null {
  if (typeof x === "number") return x;
  if (typeof x === "string") { const n = Date.parse(x); return Number.isNaN(n) ? null : n; }
  return null;
}

export type EventFamily = "all" | "run" | "plan" | "task" | "worker" | "agent" | "problems";
export const FAMILIES: EventFamily[] = ["all", "run", "plan", "task", "worker", "agent", "problems"];

const PROBLEM = /(fail|error|timeout|timed_out|conflict|cancel|expire|blocked|verify_failed)/i;
export const isProblem = (e: RunEvent) => PROBLEM.test(e.type) || (e.type === "run.result" && e.data.ok === false);
export const isWaiting = (e: RunEvent) => /awaiting|approval/.test(e.type);

export function filterEvents(events: RunEvent[], family: EventFamily, query = ""): RunEvent[] {
  const q = query.trim().toLowerCase();
  return events.filter((e) => {
    if (family === "problems" ? !isProblem(e) : family !== "all" && !e.type.startsWith(`${family}.`) && !(family === "task" && e.type.startsWith("tasks."))) return false;
    if (!q) return true;
    return `${e.type} ${e.entity} ${JSON.stringify(e.data)}`.toLowerCase().includes(q);
  });
}
