import {
  trace,
  context,
  SpanStatusCode,
  type Span,
  type Context,
  type Tracer,
} from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  ConsoleSpanExporter,
  SimpleSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { writeFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

let provider: BasicTracerProvider | null = null;
let ndjsonExporter: NDJSONFileExporter | null = null;
let memoryExporter: InMemorySpanExporter | null = null;

export interface RelaySpanAttributes {
  "relay.run_id"?: string;
  "relay.task_id"?: string;
  "relay.lease_epoch"?: number;
  "relay.worker_id"?: string;
  "relay.actor_key"?: string;
  "relay.idempotency_key"?: string;
  "relay.state_from"?: string;
  "relay.state_to"?: string;
  "relay.event_type"?: string;
  "relay.machine_version"?: number;
  "gen_ai.system"?: string;
  "gen_ai.request.model"?: string;
  "gen_ai.response.model"?: string;
  "gen_ai.usage.input_tokens"?: number;
  "gen_ai.usage.output_tokens"?: number;
  "gen_ai.response.cost"?: number;
  "sandbox.provider"?: string;
  "sandbox.vm_id"?: string;
  "sandbox.operation"?: string;
  "git.operation"?: string;
  "git.ref"?: string;
  "git.sha"?: string;
}

class NDJSONFileExporter {
  private runTraces: Map<string, any[]> = new Map();
  private baseDir: string;

  constructor(baseDir: string = "./.traces") {
    this.baseDir = baseDir;
  }

  async export(span: any) {
    const runId = span.attributes?.["relay.run_id"];
    if (!runId) return;

    if (!this.runTraces.has(runId)) {
      this.runTraces.set(runId, []);
    }

    this.runTraces.get(runId)!.push({
      traceId: span.spanContext().traceId,
      spanId: span.spanContext().spanId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      kind: span.kind,
      startTime: span.startTime,
      endTime: span.endTime,
      attributes: span.attributes,
      status: span.status,
      events: span.events,
    });
  }

  async flush(runId: string) {
    const spans = this.runTraces.get(runId);
    if (!spans || spans.length === 0) return;

    if (!existsSync(this.baseDir)) {
      await mkdir(this.baseDir, { recursive: true });
    }

    const filePath = join(this.baseDir, `${runId}.ndjson`);
    const lines = spans.map((s) => JSON.stringify(s)).join("\n");
    await writeFile(filePath, lines);

    this.runTraces.delete(runId);
  }
}

export function initTracing(options?: {
  serviceName?: string;
  ndjsonDir?: string;
  otlpEndpoint?: string;
  testMode?: boolean;
}) {
  if (provider) return provider;

  // Simplified initialization without Resource (Bun compat issue)
  provider = new BasicTracerProvider();

  // Test mode: use InMemorySpanExporter
  if (options?.testMode || process.env.NODE_ENV === "test") {
    memoryExporter = new InMemorySpanExporter();
    provider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    trace.setGlobalTracerProvider(provider);
    return provider;
  }

  // NDJSON file exporter (default)
  ndjsonExporter = new NDJSONFileExporter(options?.ndjsonDir);

  // OTLP exporter (optional)
  if (options?.otlpEndpoint || process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
    const otlpExporter = new OTLPTraceExporter({
      url:
        options?.otlpEndpoint ||
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ||
        "http://localhost:4318/v1/traces",
    });
    provider.addSpanProcessor(new BatchSpanProcessor(otlpExporter));
  }

  // Console exporter for debugging
  if (process.env.RELAY_TRACE_DEBUG === "1") {
    provider.addSpanProcessor(new SimpleSpanProcessor(new ConsoleSpanExporter()));
  }

  // Register tracer provider globally
  trace.setGlobalTracerProvider(provider);

  return provider;
}

export function getTracer(name: string = "relay"): Tracer {
  if (!provider) {
    initTracing();
  }
  return trace.getTracer(name);
}

export function startSpan(
  name: string,
  attributes: RelaySpanAttributes = {},
  parentContext?: Context
): Span {
  const tracer = getTracer();
  const ctx = parentContext || context.active();

  return tracer.startSpan(
    name,
    {
      attributes: attributes as any,
    },
    ctx
  );
}

export function withSpan<T>(
  name: string,
  attributes: RelaySpanAttributes,
  fn: (span: Span) => Promise<T> | T
): Promise<T> {
  return new Promise<T>(async (resolve, reject) => {
    const span = startSpan(name, attributes);

    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      span.end();
      resolve(result);
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
      span.recordException(error as Error);
      span.end();
      reject(error);
    }
  });
}

export function recordStateTransition(
  span: Span,
  from: string,
  to: string,
  event: string,
  version: number
) {
  span.setAttributes({
    "relay.state_from": from,
    "relay.state_to": to,
    "relay.event_type": event,
    "relay.machine_version": version,
  });
  span.addEvent("state_transition", {
    from,
    to,
    event,
    timestamp: Date.now(),
  });
}

export function recordModelCall(
  span: Span,
  model: string,
  inputTokens: number,
  outputTokens: number,
  cost: number
) {
  span.setAttributes({
    "gen_ai.system": "fake", // or "openai", "anthropic", etc.
    "gen_ai.request.model": model,
    "gen_ai.response.model": model,
    "gen_ai.usage.input_tokens": inputTokens,
    "gen_ai.usage.output_tokens": outputTokens,
    "gen_ai.response.cost": cost,
  });
}

export function recordSandboxOp(
  span: Span,
  provider: string,
  vmId: string,
  operation: string
) {
  span.setAttributes({
    "sandbox.provider": provider,
    "sandbox.vm_id": vmId,
    "sandbox.operation": operation,
  });
}

export function recordGitOp(span: Span, operation: string, ref?: string, sha?: string) {
  const attrs: any = {
    "git.operation": operation,
  };
  if (ref) attrs["git.ref"] = ref;
  if (sha) attrs["git.sha"] = sha;
  span.setAttributes(attrs);
}

export async function flushRunTraces(runId: string) {
  if (ndjsonExporter) {
    await ndjsonExporter.flush(runId);
  }
}

export async function shutdownTracing() {
  if (provider) {
    await provider.shutdown();
    provider = null;
    memoryExporter = null;
    ndjsonExporter = null;
  }
}

export function getFinishedSpans(): ReadableSpan[] {
  if (!memoryExporter) return [];
  return memoryExporter.getFinishedSpans();
}

export function resetSpans() {
  if (memoryExporter) {
    memoryExporter.reset();
  }
}

// Context propagation helpers
export function serializeTraceContext(span: Span): {
  traceId: string;
  spanId: string;
} {
  const ctx = span.spanContext();
  return {
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  };
}

export function getTraceContext(span: Span): { traceId: string; spanId: string } {
  return serializeTraceContext(span);
}
