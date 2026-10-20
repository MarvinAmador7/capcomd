import type { Span, SpanStatus, Trace } from "./types";

/** Raw span as written to .traces/<runId>.ndjson (SimpleSpan in src/utils/tracing-simple.ts). */
interface RawSpan {
  traceId?: string; spanId: string; parentSpanId?: string; name: string;
  startTime: number; endTime?: number; attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: number; attributes?: Record<string, unknown> }>;
  status?: { code: number; message?: string };
}

const statusOf = (s?: { code: number }): SpanStatus => (s?.code === 2 ? "error" : s?.code === 1 ? "ok" : "unset");

function isRaw(x: unknown): x is RawSpan {
  return !!x && typeof x === "object" && typeof (x as RawSpan).spanId === "string" && typeof (x as RawSpan).startTime === "number";
}

/**
 * Accepts either the raw trace NDJSON (one span per line) or `capcomd trace <runId> --json`
 * ({ schema, ok, trace: { runId, spans: [...] } }). Malformed lines are skipped, not fatal:
 * a trace being written while a run executes can end mid-line.
 */
export function parseTrace(text: string, runIdHint?: string): Trace | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let raw: RawSpan[] = [];
  let runId = runIdHint;
  if (trimmed.startsWith("{") && !trimmed.includes("\n")) {
    const doc = safeJson(trimmed) as any;
    if (doc?.trace?.spans) { raw = doc.trace.spans.filter(isRaw); runId ??= doc.trace.runId; }
    else if (isRaw(doc)) raw = [doc];
  } else {
    for (const line of trimmed.split("\n")) {
      const v = safeJson(line);
      if (isRaw(v)) raw.push(v);
    }
  }
  if (raw.length === 0) return null;
  runId ??= String(raw.find((s) => s.attributes?.["relay.run_id"])?.attributes?.["relay.run_id"] ?? "unknown");
  return buildTree(raw, runId);
}

function buildTree(raw: RawSpan[], runId: string): Trace {
  // Mirror loadTrace(): spans whose parent isn't in the file hang off one synthesized relay.run root.
  const ids0 = new Set(raw.map((s) => s.spanId));
  const orphans = raw.filter((s) => !s.parentSpanId || !ids0.has(s.parentSpanId));
  if (orphans.length > 1) {
    const rootId = "synthetic-root";
    raw = [
      { spanId: rootId, name: "relay.run", startTime: Math.min(...raw.map((s) => s.startTime)), endTime: Math.max(...raw.map((s) => s.endTime ?? s.startTime)), attributes: { "relay.run_id": runId, "relay.synthesized": true }, events: [], status: { code: 0 } },
      ...raw.map((s) => (orphans.includes(s) ? { ...s, parentSpanId: rootId } : s)),
    ];
  }
  const byId = new Map(raw.map((s) => [s.spanId, s]));
  const start = Math.min(...raw.map((s) => s.startTime));
  const end = Math.max(...raw.map((s) => s.endTime ?? s.startTime));
  const kids = new Map<string | null, RawSpan[]>();
  for (const s of raw) {
    const p = s.parentSpanId && byId.has(s.parentSpanId) ? s.parentSpanId : null;
    kids.set(p, [...(kids.get(p) ?? []), s]);
  }
  for (const list of kids.values()) list.sort((a, b) => a.startTime - b.startTime);
  const out: Span[] = [];
  const walk = (s: RawSpan, depth: number, parentId: string | null) => {
    const e = s.endTime ?? s.startTime;
    out.push({
      id: s.spanId, parentId, name: s.name, start: s.startTime, end: e, durationMs: e - s.startTime,
      offsetMs: s.startTime - start, depth, status: statusOf(s.status), message: s.status?.message,
      attrs: s.attributes ?? {},
      events: (s.events ?? []).map((ev) => ({ name: ev.name, at: ev.timestamp, attrs: ev.attributes ?? {} })),
    });
    for (const c of kids.get(s.spanId) ?? []) walk(c, depth + 1, s.spanId);
  };
  for (const r of kids.get(null) ?? []) walk(r, 0, null);
  return { runId, start, end, durationMs: end - start, spans: out };
}

function safeJson(s: string): unknown {
  try { return JSON.parse(s); } catch { return undefined; }
}

/** A row in the waterfall: one span, or a run of same-named siblings folded together. */
export interface WaterfallRow {
  key: string;
  span: Span; // first span of the group
  count: number;
  start: number;
  end: number;
  durationMs: number; // summed busy time for groups
  errors: number;
}

/**
 * Fold runs of ≥ minRun consecutive same-named siblings (770 sandbox.exec calls become one
 * row). Folded groups keep their own children hidden; unfold with the `expanded` set.
 */
export function waterfallRows(trace: Trace, expanded: Set<string> = new Set(), minRun = 4): WaterfallRow[] {
  const rows: WaterfallRow[] = [];
  const spans = trace.spans;
  let i = 0;
  while (i < spans.length) {
    const s = spans[i]!;
    // collect siblings with the same name and parent, skipping their subtrees
    const group: number[] = [i];
    let j = skipSubtree(spans, i);
    while (j < spans.length && spans[j]!.parentId === s.parentId && spans[j]!.name === s.name && spans[j]!.depth === s.depth) {
      group.push(j);
      j = skipSubtree(spans, j);
    }
    const key = `${s.parentId ?? "root"}/${s.name}@${s.start}`;
    if (group.length >= minRun && !expanded.has(key)) {
      const members = group.map((g) => spans[g]!);
      rows.push({
        key, span: s, count: members.length,
        start: Math.min(...members.map((m) => m.start)), end: Math.max(...members.map((m) => m.end)),
        durationMs: members.reduce((a, m) => a + m.durationMs, 0), errors: members.filter((m) => m.status === "error").length,
      });
      i = j;
    } else {
      rows.push({ key: `${s.id}`, span: s, count: 1, start: s.start, end: s.end, durationMs: s.durationMs, errors: s.status === "error" ? 1 : 0 });
      i += 1;
    }
  }
  return rows;
}

function skipSubtree(spans: Span[], i: number): number {
  const d = spans[i]!.depth;
  let j = i + 1;
  while (j < spans.length && spans[j]!.depth > d) j++;
  return j;
}

/** Span family used for grouping and color: "agent.claude_code" -> "agent". */
export const familyOf = (name: string) => name.split(".")[0] ?? name;
