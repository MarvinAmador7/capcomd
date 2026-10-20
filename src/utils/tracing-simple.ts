// Bun-safe tracing. See docs/adr-010-tracing.md for why this replaced the OTel SDK.
//
// Spans that carry `relay.run_id` are appended, one JSON object per line, to
// `<traceDir>/<runId>.ndjson` as soon as they end. The engine process (actors)
// and the CLI process both append to the same file, so `capcomd trace <runId>`
// sees the whole run. The trace id is derived from the run id, so every
// process agrees on it without passing context around.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { env } from "./env";

export interface SimpleSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, any>;
  events: Array<{ name: string; timestamp: number; attributes?: Record<string, any> }>;
  status: { code: number; message?: string };
}

let spans: SimpleSpan[] = [];
let currentSpan: SimpleSpan | null = null;
const als = new AsyncLocalStorage<SimpleSpan>();

export function traceDir(): string {
  return env("TRACE_DIR")
    ? resolve(env("TRACE_DIR")!)
    : resolve(new URL("../..", import.meta.url).pathname, ".traces");
}

export function tracePath(runId: string): string {
  return join(traceDir(), `${runId.replace(/[^a-zA-Z0-9._-]/g, "_")}.ndjson`);
}

function hex(input: string, len: number): string {
  return createHash("sha256").update(input).digest("hex").slice(0, len);
}

export function traceIdForRun(runId: string): string {
  return hex(`trace:${runId}`, 32);
}

/** Span id of the run's root span. Actor spans with no in-process parent hang off it. */
export function rootSpanIdForRun(runId: string): string {
  return hex(`root:${runId}`, 16);
}

/** ADR-017 trace parenting: an agent's span id is derived from (run, agent), so a child's span can
 *  name its parent's span without passing context across processes or VMs. */
export function agentSpanId(runId: string, agentId: string): string {
  return hex(`agent:${runId}:${agentId}`, 16);
}

export function activeSpan(): SimpleSpan | null {
  return als.getStore() ?? currentSpan;
}

export function startSpan(
  name: string,
  attributes: Record<string, any> = {},
  opts: { parent?: SimpleSpan | null; spanId?: string; parentSpanId?: string } = {}
): SimpleSpan {
  const parent = opts.parent === undefined ? activeSpan() : opts.parent;
  const runId: string | undefined = attributes["relay.run_id"] ?? parent?.attributes["relay.run_id"];
  const attrs = { ...attributes };
  if (runId && !attrs["relay.run_id"]) attrs["relay.run_id"] = runId;
  const span: SimpleSpan = {
    traceId: parent?.traceId ?? (runId ? traceIdForRun(runId) : randomBytes(16).toString("hex")),
    spanId: opts.spanId ?? randomBytes(8).toString("hex"),
    parentSpanId:
      opts.parentSpanId ??
      parent?.spanId ??
      (runId && opts.spanId !== rootSpanIdForRun(runId) ? rootSpanIdForRun(runId) : undefined),
    name,
    startTime: Date.now(),
    attributes: attrs,
    events: [],
    status: { code: 0 },
  };
  currentSpan = span;
  return span;
}

function persist(span: SimpleSpan) {
  const runId = span.attributes["relay.run_id"];
  if (!runId || env("TRACE") === "off") return;
  try {
    mkdirSync(traceDir(), { recursive: true });
    appendFileSync(tracePath(String(runId)), JSON.stringify(span) + "\n");
  } catch {
    // tracing must never break the run
  }
}

export function endSpan(span: SimpleSpan) {
  if (span.endTime !== undefined) return;
  span.endTime = Date.now();
  spans.push(span);
  if (spans.length > 5000) spans = spans.slice(-2500);
  if (currentSpan === span) currentSpan = null;
  persist(span);
}

export function setSpanAttributes(span: SimpleSpan, attributes: Record<string, any>) {
  Object.assign(span.attributes, attributes);
}

export function addSpanEvent(span: SimpleSpan, name: string, attributes?: Record<string, any>) {
  span.events.push({ name, timestamp: Date.now(), attributes });
}

export function recordStateTransition(
  span: SimpleSpan,
  from: string,
  to: string,
  event: string,
  version: number
) {
  setSpanAttributes(span, {
    "relay.state_from": from,
    "relay.state_to": to,
    "relay.event_type": event,
    "relay.machine_version": version,
  });
  addSpanEvent(span, "state_transition", { from, to, event });
}

export function recordModelCall(
  span: SimpleSpan,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number
) {
  setSpanAttributes(span, {
    "gen_ai.system": "fake",
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
    "gen_ai.response.cost": cost,
  });
}

export function getFinishedSpans(): SimpleSpan[] {
  return [...spans];
}

export function resetSpans() {
  spans = [];
  currentSpan = null;
}

export function getTraceContext(span: SimpleSpan): { traceId: string; spanId: string } {
  return { traceId: span.traceId, spanId: span.spanId };
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, any>,
  fn: (span: SimpleSpan) => Promise<T> | T,
  opts: { spanId?: string; parent?: SimpleSpan | null; parentSpanId?: string } = {}
): Promise<T> {
  const span = startSpan(name, attributes, opts);
  try {
    const result = await als.run(span, () => fn(span));
    span.status.code = 1;
    endSpan(span);
    return result;
  } catch (error) {
    span.status.code = 2;
    span.status.message = error instanceof Error ? error.message : String(error);
    endSpan(span);
    throw error;
  }
}

function runIdOf(c: any, params: any): string | undefined {
  if (params && typeof params === "object" && typeof params.runId === "string") return params.runId;
  const key = c?.key;
  if (Array.isArray(key) && typeof key[0] === "string" && key[0].startsWith("run-")) return key[0];
  if (Array.isArray(key) && typeof key[0] === "string") return key[0];
  return undefined;
}

/** Wrap every action of a Rivet actor in an `actor.<name>.<action>` span. */
export function traceActions<A extends Record<string, (c: any, ...args: any[]) => any>>(
  actorName: string,
  actions: A
): A {
  const out: Record<string, any> = {};
  for (const [action, fn] of Object.entries(actions)) {
    if (action.startsWith("get")) {
      out[action] = fn; // reads are noisy and not interesting in a waterfall
      continue;
    }
    out[action] = function (this: unknown, c: any, ...args: any[]) {
      const params = args[0];
      const runId = runIdOf(c, params);
      const attrs: Record<string, any> = { "relay.actor": actorName, "relay.action": action };
      if (runId) attrs["relay.run_id"] = runId;
      if (Array.isArray(c?.key)) attrs["relay.actor_key"] = c.key.join("/");
      for (const k of ["taskId", "workerId", "epoch"]) {
        if (params && params[k] !== undefined) attrs[`relay.${k.replace(/Id$/, "_id")}`] = params[k];
      }
      return withSpan(`actor.${actorName}.${action}`, attrs, () => fn.call(this, c, ...args));
    };
  }
  return out as A;
}

/** Proxy an object so each async method call becomes a `<prefix>.<method>` span. */
export function traceMethods<T extends object>(
  prefix: string,
  target: T,
  describe?: (method: string, args: any[], result?: any) => { name?: string; attributes?: Record<string, any> }
): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function" || typeof prop !== "string") return value;
      return (...args: any[]) => {
        const pre = describe?.(prop, args) ?? {};
        return withSpan(pre.name ?? `${prefix}.${prop}`, pre.attributes ?? {}, async (span) => {
          const result = await value.apply(obj, args);
          const post = describe?.(prop, args, result);
          if (post?.attributes) setSpanAttributes(span, post.attributes);
          return result;
        });
      };
    },
  });
}

export function readTrace(text: string): SimpleSpan[] {
  return text
    .split("\n")
    .filter((l) => l.trim())
    .flatMap((l) => {
      try {
        return [JSON.parse(l) as SimpleSpan];
      } catch {
        return [];
      }
    });
}
