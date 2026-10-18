// Simplified tracing for Bun compatibility
// Avoids OTel SDK issues by using a custom span implementation

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

function generateId(length: number): string {
  const chars = "0123456789abcdef";
  let result = "";
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

export function startSpan(name: string, attributes: Record<string, any> = {}): SimpleSpan {
  const span: SimpleSpan = {
    traceId: generateId(32),
    spanId: generateId(16),
    parentSpanId: currentSpan?.spanId,
    name,
    startTime: Date.now(),
    attributes: { ...attributes },
    events: [],
    status: { code: 0 }, // UNSET
  };

  currentSpan = span;
  return span;
}

export function endSpan(span: SimpleSpan) {
  span.endTime = Date.now();
  spans.push(span);
  currentSpan = null;
}

export function setSpanAttributes(span: SimpleSpan, attributes: Record<string, any>) {
  Object.assign(span.attributes, attributes);
}

export function addSpanEvent(
  span: SimpleSpan,
  name: string,
  attributes?: Record<string, any>
) {
  span.events.push({
    name,
    timestamp: Date.now(),
    attributes,
  });
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
  return {
    traceId: span.traceId,
    spanId: span.spanId,
  };
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, any>,
  fn: (span: SimpleSpan) => Promise<T> | T
): Promise<T> {
  const span = startSpan(name, attributes);
  try {
    const result = await fn(span);
    span.status.code = 1; // OK
    endSpan(span);
    return result;
  } catch (error) {
    span.status.code = 2; // ERROR
    span.status.message = error instanceof Error ? error.message : String(error);
    endSpan(span);
    throw error;
  }
}
