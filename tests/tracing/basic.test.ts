import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  initTracing,
  startSpan,
  withSpan,
  recordStateTransition,
  recordModelCall,
  getTraceContext,
  shutdownTracing,
  getFinishedSpans,
  resetSpans,
} from "../../src/utils/tracing";

describe("Tracing Infrastructure", () => {
  beforeEach(() => {
    resetSpans();
  });

  afterEach(async () => {
    await shutdownTracing();
  });

  test("can create and end spans", async () => {
    initTracing({ serviceName: "relay-test", testMode: true });

    const span = startSpan("test-operation", {
      "relay.run_id": "test-run-1",
      "relay.task_id": "task-1",
    });

    expect(span).toBeDefined();
    const ctx = getTraceContext(span);
    expect(ctx.traceId).toBeDefined();
    expect(ctx.spanId).toBeDefined();

    span.end();

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    expect(finished[0].name).toBe("test-operation");
  });

  test("withSpan helper works", async () => {
    initTracing({ serviceName: "relay-test", testMode: true });

    let spanId: string | undefined;

    const result = await withSpan(
      "test-operation",
      { "relay.run_id": "test-run-2" },
      (span) => {
        spanId = getTraceContext(span).spanId;
        return Promise.resolve(42);
      }
    );

    expect(result).toBe(42);
    expect(spanId).toBeDefined();

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    expect(finished[0].status.code).toBe(1); // OK
  });

  test("can record state transitions", () => {
    initTracing({ serviceName: "relay-test", testMode: true });

    const span = startSpan("state-transition", {
      "relay.run_id": "test-run-3",
    });

    recordStateTransition(span, "pending", "running", "START", 1);

    span.end();

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    
    const attrs = finished[0].attributes;
    expect(attrs["relay.state_from"]).toBe("pending");
    expect(attrs["relay.state_to"]).toBe("running");
    expect(attrs["relay.event_type"]).toBe("START");
    expect(attrs["relay.machine_version"]).toBe(1);
  });

  test("can record model calls with gen_ai conventions", () => {
    initTracing({ serviceName: "relay-test", testMode: true });

    const span = startSpan("model-call", {
      "relay.run_id": "test-run-4",
    });

    recordModelCall(span, "gpt-4", 100, 50, 0.0015);

    span.end();

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    
    const attrs = finished[0].attributes;
    expect(attrs["gen_ai.request.model"]).toBe("gpt-4");
    expect(attrs["gen_ai.usage.input_tokens"]).toBe(100);
    expect(attrs["gen_ai.usage.output_tokens"]).toBe(50);
    expect(attrs["gen_ai.response.cost"]).toBe(0.0015);
  });

  test("trace context can be serialized", () => {
    initTracing({ serviceName: "relay-test", testMode: true });

    const span = startSpan("serialization-test", {
      "relay.run_id": "test-run-5",
    });

    const ctx = getTraceContext(span);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);

    span.end();
  });
});
