import { existsSync, readFileSync } from "fs";
import { readTrace, rootSpanIdForRun, tracePath, traceIdForRun, type SimpleSpan } from "../../utils/tracing-simple";

export interface TraceTree {
  runId: string;
  traceId: string;
  durationMs: number;
  spanCount: number;
  spans: Array<SimpleSpan & { depth: number; offsetMs: number; durationMs: number }>;
}

/** Load a run's spans and order them depth-first under a (possibly synthesized) root. */
export function loadTrace(runId: string, dir?: string): TraceTree | null {
  const path = tracePath(runId, dir);
  if (!existsSync(path)) return null;
  const raw = readTrace(readFileSync(path, "utf8"));
  if (raw.length === 0) return null;

  const rootId = rootSpanIdForRun(runId);
  const all: SimpleSpan[] = [...raw];
  if (!all.some((s) => s.spanId === rootId)) {
    all.push({
      traceId: traceIdForRun(runId),
      spanId: rootId,
      name: "relay.run",
      startTime: Math.min(...raw.map((s) => s.startTime)),
      endTime: Math.max(...raw.map((s) => s.endTime ?? s.startTime)),
      attributes: { "relay.run_id": runId, "relay.synthesized": true },
      events: [],
      status: { code: 0 },
    });
  }
  const ids = new Set(all.map((s) => s.spanId));
  const children = new Map<string, SimpleSpan[]>();
  const roots: SimpleSpan[] = [];
  for (const s of all) {
    const parent = s.parentSpanId && ids.has(s.parentSpanId) ? s.parentSpanId : s.spanId === rootId ? null : rootId;
    if (parent === null) roots.push(s);
    else children.set(parent, [...(children.get(parent) ?? []), s]);
  }
  for (const list of children.values()) list.sort((a, b) => a.startTime - b.startTime);

  const min = Math.min(...all.map((s) => s.startTime));
  const max = Math.max(...all.map((s) => s.endTime ?? s.startTime));
  const out: TraceTree["spans"] = [];
  const walk = (s: SimpleSpan, depth: number) => {
    out.push({ ...s, depth, offsetMs: s.startTime - min, durationMs: (s.endTime ?? s.startTime) - s.startTime });
    for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1);
  };
  roots.sort((a, b) => a.startTime - b.startTime).forEach((r) => walk(r, 0));
  return { runId, traceId: traceIdForRun(runId), durationMs: max - min, spanCount: raw.length, spans: out };
}

export function renderTrace(tree: TraceTree, width = 40): string {
  const lines = [`Trace: ${tree.runId}`, `Trace ID: ${tree.traceId}`, `Spans: ${tree.spanCount}  Duration: ${tree.durationMs}ms`, ""];
  const total = Math.max(1, tree.durationMs);
  for (const s of tree.spans) {
    const start = Math.min(width - 1, Math.floor((s.offsetMs / total) * width));
    const len = Math.max(1, Math.round((s.durationMs / total) * width));
    const bar = " ".repeat(start) + "█".repeat(Math.min(len, width - start));
    const label = ("  ".repeat(s.depth) + s.name).slice(0, 48).padEnd(48);
    const flag = s.status.code === 2 ? " ✗" : "";
    const a = s.attributes ?? {};
    const detail =
      a["relay.state_from"] !== undefined
        ? ` ${a["relay.entity_id"] ?? ""} ${a["relay.state_from"]}→${a["relay.state_to"]}`
        : a["gen_ai.request.model"]
          ? ` model=${a["gen_ai.request.model"]} tokens=${a["gen_ai.usage.input_tokens"] ?? "?"}/${a["gen_ai.usage.output_tokens"] ?? "?"}`
          : a["git.ref"]
            ? ` ref=${a["git.ref"]}`
            : "";
    lines.push(`${label} ${String(s.durationMs).padStart(6)}ms |${bar.padEnd(width)}|${flag}${detail}`);
  }
  return lines.join("\n");
}
