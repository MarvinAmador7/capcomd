import type { RunEvent } from "./types";

/**
 * Accepts every event shape capcomd prints:
 *  - `capcomd run --json` stream lines: { schema, type, runId, ts, ...fields }
 *  - `capcomd events <id> --json`:       { schema, ok, events: [{ entity, seq, at, type, event }] }
 *  - `capcomd events <id> --follow --json` lines: { schema, ok, runId, event: {...} } and a final { end }
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
    if (v.end !== undefined) continue;
    if (v.ok === false && v.error) { push({ at: lastAt, type: "cli.error", entity: "cli", data: v.error }); continue; }
    if (typeof v.type === "string") push(fromRecord(v));
  }
  return out.sort((a, b) => a.at - b.at);

  function push(e: RunEvent | null) { if (e) { out.push(e); lastAt = e.at; } }
}

function fromRecord(r: any): RunEvent | null {
  if (!r || typeof r !== "object") return null;
  const inner = r.event && typeof r.event === "object" ? r.event : r;
  const type = String(r.type ?? inner.type ?? "unknown");
  const at = toMs(r.at ?? r.ts ?? inner.at ?? inner.ts);
  if (at === null) return null;
  const { schema: _s, type: _t, ts: _ts, at: _at, runId: _r, ...data } = inner;
  const entity = String(r.entity ?? inner.taskId ?? inner.agentId ?? "run");
  return { at, type, entity, data };
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
