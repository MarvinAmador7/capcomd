import { describe, test, expect, beforeEach } from "bun:test";
import {
  startSpan,
  endSpan,
  withSpan,
  recordStateTransition,
  recordModelCall,
  getTraceContext,
  getFinishedSpans,
  resetSpans,
} from "../../src/utils/tracing-simple";

describe("Simple Tracing", () => {
  beforeEach(() => {
    resetSpans();
  });

  test("can create and end spans", () => {
    const span = startSpan("test-operation", {
      "relay.run_id": "test-run-1",
      "relay.task_id": "task-1",
    });

    expect(span).toBeDefined();
    expect(span.name).toBe("test-operation");
    expect(span.attributes["relay.run_id"]).toBe("test-run-1");

    const ctx = getTraceContext(span);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);

    endSpan(span);

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    expect(finished[0]!.name).toBe("test-operation");
    expect(finished[0]!.endTime).toBeDefined();
  });

  test("withSpan helper works", async () => {
    const result = await withSpan(
      "test-operation",
      { "relay.run_id": "test-run-2" },
      (span) => {
        expect(span.name).toBe("test-operation");
        return Promise.resolve(42);
      }
    );

    expect(result).toBe(42);

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    expect(finished[0]!.status.code).toBe(1); // OK
  });

  test("can record state transitions", () => {
    const span = startSpan("state-transition", {
      "relay.run_id": "test-run-3",
    });

    recordStateTransition(span, "pending", "running", "START", 1);

    expect(span.attributes["relay.state_from"]).toBe("pending");
    expect(span.attributes["relay.state_to"]).toBe("running");
    expect(span.attributes["relay.event_type"]).toBe("START");
    expect(span.attributes["relay.machine_version"]).toBe(1);
    expect(span.events.length).toBe(1);
    expect(span.events[0]!.name).toBe("state_transition");

    endSpan(span);
  });

  test("can record model calls with gen_ai conventions", () => {
    const span = startSpan("model-call", {
      "relay.run_id": "test-run-4",
    });

    recordModelCall(span, "gpt-4", 100, 50, 0.0015);

    expect(span.attributes["gen_ai.request.model"]).toBe("gpt-4");
    expect(span.attributes["gen_ai.usage.input_tokens"]).toBe(100);
    expect(span.attributes["gen_ai.usage.output_tokens"]).toBe(50);
    expect(span.attributes["gen_ai.response.cost"]).toBe(0.0015);

    endSpan(span);
  });

  test("trace context can be serialized", () => {
    const span = startSpan("serialization-test", {
      "relay.run_id": "test-run-5",
    });

    const ctx = getTraceContext(span);
    expect(ctx.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);

    endSpan(span);
  });

  test("handles errors in withSpan", async () => {
    try {
      await withSpan("error-test", {}, async () => {
        throw new Error("Test error");
      });
      expect(true).toBe(false); // Should not reach
    } catch (error) {
      expect((error as Error).message).toBe("Test error");
    }

    const finished = getFinishedSpans();
    expect(finished.length).toBe(1);
    expect(finished[0]!.status.code).toBe(2); // ERROR
    expect(finished[0]!.status.message).toBe("Test error");
  });
});
