import { describe, expect, test } from "bun:test";
import { createElkLayout, positionsFrom, toElkGraph } from "../src/lib/elk-layout";
import { replayEvents } from "../src/lib/graph-fold";
import type { RelayEvent } from "../src/lib/graph-fold";

const events: RelayEvent[] = [
  { type: "RUN_CREATED", runId: "run-1", timestamp: 1 },
  { type: "PLAN_READY", runId: "run-1", tasks: ["task-1", "task-2", "task-3"], timestamp: 2 },
  { type: "TASK_CREATED", taskId: "task-1", timestamp: 3 },
  { type: "TASK_CREATED", taskId: "task-2", timestamp: 4 },
  { type: "TASK_CREATED", taskId: "task-3", timestamp: 5 },
];
const graph = replayEvents(events, events.length).graph;

describe("ELK layout", () => {
  test("toElkGraph links every task under the run", () => {
    const g = toElkGraph(graph);
    expect(g.children!.map((c) => c.id).sort()).toEqual(["run-1", "task-1", "task-2", "task-3"]);
    const targets = new Set(g.edges!.map((e: any) => e.targets[0]));
    for (const t of ["task-1", "task-2", "task-3"]) expect(targets.has(t)).toBe(true);
  });

  test("real ELK in the real layout.worker (Bun Web Worker) lays out run above tasks", async () => {
    const elk = createElkLayout(() => new Worker(new URL("../src/workers/layout.worker.ts", import.meta.url).href));
    const p = await elk.layout(graph);
    elk.terminate();
    expect(Object.keys(p).sort()).toEqual(["run-1", "task-1", "task-2", "task-3"]);
    for (const t of ["task-1", "task-2", "task-3"]) expect(p[t]!.y).toBeGreaterThan(p["run-1"]!.y);
    expect(new Set(["task-1", "task-2", "task-3"].map((t) => p[t]!.x)).size).toBe(3);
  });

  test("createElkLayout rejects when the worker fails, so the app falls back", async () => {
    let onmessage: ((e: { data: any }) => void) | null = null;
    const broken = () => ({
      set onmessage(f: any) { onmessage = f; },
      postMessage(msg: any) { if (msg.cmd === "layout") setTimeout(() => onmessage?.({ data: { id: msg.id, error: "worker crashed" } }), 0); },
      terminate() {},
    }) as unknown as Worker;
    const elk = createElkLayout(broken);
    await expect(elk.layout(graph)).rejects.toThrow("worker crashed");
  });

  test("createElkLayout talks to the worker via the elk-api protocol", async () => {
    // Stand-in worker that answers like elk-worker would.
    let onmessage: ((e: { data: any }) => void) | null = null;
    const fake = {
      set onmessage(f: any) { onmessage = f; },
      postMessage(msg: any) {
        if (msg.cmd !== "layout") return;
        const children = msg.graph.children.map((c: any, i: number) => ({ ...c, x: i * 10, y: i * 20 }));
        setTimeout(() => onmessage?.({ data: { id: msg.id, data: { ...msg.graph, children } } }), 0);
      },
      terminate() {},
    } as unknown as Worker;
    const elk = createElkLayout(() => fake);
    const p = await elk.layout(graph);
    expect(Object.keys(p).length).toBe(4);
  });
});
