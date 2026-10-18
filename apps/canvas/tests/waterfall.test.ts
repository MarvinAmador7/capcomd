import { describe, expect, test } from "bun:test";
import { createActor, waitFor } from "xstate";
import { canvasMachine } from "../src/lib/canvas-machine";
import { layoutWaterfall, parseNdjson, spanKind, type TraceSpan } from "../src/lib/waterfall";
import demoTrace from "../src/fixtures/demo-trace.ndjson" with { type: "text" };

const S = (id: string, name: string, start: number, end: number, parent?: string, attrs: Record<string, unknown> = {}): TraceSpan => ({
  traceId: "t", spanId: id, parentSpanId: parent, name, startTime: start, endTime: end, attributes: { "relay.run_id": "run-1", ...attrs }, status: { code: 1 },
});

const spans: TraceSpan[] = [
  S("r", "cli.run", 0, 1000),
  S("a1", "actor.taskBoard.grantLease", 100, 200, "r", { "relay.task_id": "task-1" }),
  S("t1", "transition.task", 150, 160, "a1", { "relay.entity_id": "task-1", "relay.state_from": "pending", "relay.state_to": "leased" }),
  S("a2", "actor.worker.pushBranch", 300, 500, "r", { "relay.task_id": "task-2" }),
  S("g2", "git.push", 350, 450, "a2"),
  { ...S("k", "killpoint.push.mid", 460, 460, "a2"), status: { code: 2 } },
];

describe("layoutWaterfall", () => {
  test("run node: whole trace, depth-first, offsets and widths in percent", () => {
    const w = layoutWaterfall(spans, "run-1");
    expect(w.map((s) => [s.name, s.depth])).toEqual([
      ["cli.run", 0],
      ["actor.taskBoard.grantLease", 1],
      ["transition.task", 2],
      ["actor.worker.pushBranch", 1],
      ["git.push", 2],
      ["killpoint.push.mid", 2],
    ]);
    const lease = w[1]!;
    expect(lease.offsetPct).toBeCloseTo(10);
    expect(lease.widthPct).toBeCloseTo(10);
    expect(w[5]!.widthPct).toBe(0.5); // instant span stays visible
    expect(w[5]!.error).toBe(true);
    expect(w[0]!.attributes["relay.run_id"]).toBeUndefined();
  });

  test("task node: only its spans and their descendants, window rescaled", () => {
    const w = layoutWaterfall(spans, "task-2");
    expect(w.map((s) => [s.name, s.depth])).toEqual([
      ["actor.worker.pushBranch", 0],
      ["git.push", 1],
      ["killpoint.push.mid", 1],
    ]);
    expect(w[0]!.offsetPct).toBe(0);
    expect(w[0]!.widthPct).toBe(100);
    expect(w[1]!.offsetPct).toBeCloseTo(25);
  });

  test("span kinds", () => {
    expect(spanKind("relay.run")).toBe("run");
    expect(spanKind("actor.run.createRun")).toBe("actor");
    expect(spanKind("transition.task")).toBe("transition");
    expect(spanKind("model.generate")).toBe("model");
    expect(spanKind("sandbox.ensure")).toBe("sandbox");
    expect(spanKind("git.merge_cas")).toBe("git");
    expect(spanKind("whatever")).toBe("other");
  });

  test("parseNdjson skips bad lines", () => {
    expect(parseNdjson('{"spanId":"a"}\nnot json\n\n{"spanId":"b"}').map((s) => s.spanId)).toEqual(["a", "b"]);
  });
});

describe("canvas machine spans state", () => {
  test("PANEL.OPEN_SPANS with a loaded trace reaches ready with real spans", async () => {
    const actor = createActor(canvasMachine).start();
    actor.send({ type: "TRACE.LOADED", spans });
    actor.send({ type: "NODE.CLICK", nodeId: "task-1" });
    actor.send({ type: "PANEL.OPEN_SPANS" });
    const snap = await waitFor(actor, (s) => s.matches({ panel: { spans: "ready" } }), { timeout: 1000 });
    expect(snap.context.traceData?.source).toBe("trace");
    expect(snap.context.traceData?.spans.map((s) => s.name)).toEqual(["actor.taskBoard.grantLease", "transition.task"]);
    actor.stop();
  });

  test("without a trace it falls back to event pseudo-spans", async () => {
    const actor = createActor(canvasMachine).start();
    actor.send({ type: "STREAM.CONNECT" });
    actor.send({ type: "STREAM.EVENT", event: { type: "RUN_CREATED", runId: "run-9", timestamp: 100 } });
    actor.send({ type: "STREAM.EVENT", event: { type: "PLAN_READY", runId: "run-9", tasks: [], timestamp: 300 } });
    actor.send({ type: "NODE.CLICK", nodeId: "run-9" });
    actor.send({ type: "PANEL.OPEN_SPANS" });
    const snap = await waitFor(actor, (s) => s.matches({ panel: { spans: "ready" } }), { timeout: 1000 });
    expect(snap.context.traceData?.source).toBe("events");
    expect(snap.context.traceData?.spans.map((s) => s.name)).toEqual(["event.RUN_CREATED", "event.PLAN_READY"]);
    actor.stop();
  });

  test("demo fixture is a real relay trace with every span kind", () => {
    const parsed = parseNdjson(demoTrace as unknown as string);
    expect(parsed.length).toBeGreaterThan(20);
    const kinds = new Set(layoutWaterfall(parsed, null).map((s) => s.kind));
    for (const k of ["run", "actor", "transition", "model", "sandbox", "git"]) expect(kinds.has(k as any)).toBe(true);
  });
});
