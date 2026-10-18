// Span waterfall layout for the canvas panel. Input is the NDJSON span format
// written by relay's tracing-simple (`.traces/<runId>.ndjson`).

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, unknown>;
  status?: { code: number; message?: string };
}

export type SpanKind = "run" | "actor" | "transition" | "model" | "sandbox" | "git" | "killpoint" | "other";

export interface WaterfallSpan {
  spanId: string;
  name: string;
  startTime: number;
  endTime: number;
  durationMs: number;
  depth: number;
  /** Left edge, percent of the visible window. */
  offsetPct: number;
  /** Bar width, percent of the visible window (min 0.5 so instant spans stay visible). */
  widthPct: number;
  kind: SpanKind;
  error: boolean;
  attributes: Record<string, string>;
}

export function spanKind(name: string): SpanKind {
  if (name === "relay.run" || name === "cli.run") return "run";
  const head = name.split(".")[0];
  if (head === "actor" || head === "transition" || head === "model" || head === "sandbox" || head === "git" || head === "killpoint") {
    return head;
  }
  return "other";
}

export function parseNdjson(text: string): TraceSpan[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as TraceSpan];
      } catch {
        return [];
      }
    });
}

function matchesNode(span: TraceSpan, nodeId: string): boolean {
  const a = span.attributes ?? {};
  return a["relay.task_id"] === nodeId || a["relay.entity_id"] === nodeId || a["relay.worker_id"] === nodeId;
}

/**
 * Lay out spans for one canvas node. A run node (or an unknown id) shows the
 * whole trace; a task or worker node shows spans tagged with it plus their
 * descendants. Order is depth-first by start time; depth is relative to the
 * shallowest visible span.
 */
export function layoutWaterfall(spans: TraceSpan[], nodeId: string | null): WaterfallSpan[] {
  if (spans.length === 0) return [];
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  const children = new Map<string, TraceSpan[]>();
  const roots: TraceSpan[] = [];
  for (const s of spans) {
    if (s.parentSpanId && byId.has(s.parentSpanId)) {
      children.set(s.parentSpanId, [...(children.get(s.parentSpanId) ?? []), s]);
    } else {
      roots.push(s);
    }
  }
  const byStart = (a: TraceSpan, b: TraceSpan) => a.startTime - b.startTime || a.name.localeCompare(b.name);
  roots.sort(byStart);
  for (const list of children.values()) list.sort(byStart);

  const isRunNode = !nodeId || spans.some((s) => s.attributes?.["relay.run_id"] === nodeId) || !spans.some((s) => matchesNode(s, nodeId));
  const ordered: Array<{ span: TraceSpan; depth: number }> = [];
  const walk = (s: TraceSpan, depth: number, include: boolean) => {
    const here = include || isRunNode || matchesNode(s, nodeId!);
    if (here) ordered.push({ span: s, depth });
    for (const c of children.get(s.spanId) ?? []) walk(c, depth + 1, here);
  };
  for (const r of roots) walk(r, 0, false);
  if (ordered.length === 0) return [];

  const minDepth = Math.min(...ordered.map((o) => o.depth));
  const start = Math.min(...ordered.map((o) => o.span.startTime));
  const end = Math.max(...ordered.map((o) => o.span.endTime ?? o.span.startTime));
  const total = Math.max(1, end - start);

  return ordered.map(({ span, depth }) => {
    const endTime = span.endTime ?? span.startTime;
    const durationMs = Math.max(0, endTime - span.startTime);
    const attributes: Record<string, string> = {};
    for (const [k, v] of Object.entries(span.attributes ?? {})) {
      if (v !== undefined && v !== null && k !== "relay.run_id") attributes[k] = String(v);
    }
    return {
      spanId: span.spanId,
      name: span.name,
      startTime: span.startTime,
      endTime,
      durationMs,
      depth: depth - minDepth,
      offsetPct: ((span.startTime - start) / total) * 100,
      widthPct: Math.max(0.5, (durationMs / total) * 100),
      kind: spanKind(span.name),
      error: span.status?.code === 2,
      attributes,
    };
  });
}

export const KIND_COLORS: Record<SpanKind, string> = {
  run: "#a78bfa",
  actor: "#38bdf8",
  transition: "#facc15",
  model: "#f472b6",
  sandbox: "#34d399",
  git: "#fb923c",
  killpoint: "#ef4444",
  other: "#94a3b8",
};
