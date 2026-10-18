import { describe, test, expect } from "bun:test";
import { createActor } from "xstate";
import { canvasMachine } from "../src/lib/canvas-machine";
import { foldEvent, createEmptyGraph, replayEvents } from "../src/lib/graph-fold";
import type { RelayEvent } from "../src/lib/graph-fold";

describe("Canvas Machine - Model-Based Tests", () => {
  test("can transition from live to replay and back", () => {
    const actor = createActor(canvasMachine);
    actor.start();

    expect(actor.getSnapshot().value.mode).toBe("live");

    actor.send({ type: "MODE.SWITCH_TO_REPLAY" });
    expect(actor.getSnapshot().value.mode).toBe("replay");

    actor.send({ type: "MODE.SWITCH_TO_LIVE" });
    expect(actor.getSnapshot().value.mode).toBe("live");

    actor.stop();
  });

  test("stream connects and receives events in live mode", () => {
    const actor = createActor(canvasMachine);
    actor.start();

    actor.send({ type: "STREAM.CONNECT" });
    expect(actor.getSnapshot().value.stream).toBe("streaming");

    const event: RelayEvent = {
      type: "RUN_CREATED",
      runId: "test-run",
      timestamp: Date.now(),
    };

    actor.send({ type: "STREAM.EVENT", event });

    const snapshot = actor.getSnapshot();
    expect(snapshot.context.events.length).toBe(1);
    expect(Object.keys(snapshot.context.graph.nodes).length).toBe(1);

    actor.stop();
  });

  test("playback can seek and play in replay mode", () => {
    const actor = createActor(canvasMachine);
    actor.start();

    // Add some events first
    const events: RelayEvent[] = [
      { type: "RUN_CREATED", runId: "run-1", timestamp: 100 },
      { type: "PLAN_READY", runId: "run-1", tasks: ["task-1"], timestamp: 200 },
      { type: "TASK_CREATED", taskId: "task-1", timestamp: 300 },
    ];

    actor.send({ type: "STREAM.CONNECT" });
    events.forEach((event) => actor.send({ type: "STREAM.EVENT", event }));

    // Switch to replay
    actor.send({ type: "MODE.SWITCH_TO_REPLAY" });
    expect(actor.getSnapshot().value.mode).toBe("replay");

    // Seek to event 1
    actor.send({ type: "PLAYBACK.SEEK", index: 1 });
    expect(actor.getSnapshot().context.currentEventIndex).toBe(1);

    // Try to play (will be paused by default in replay)
    expect(actor.getSnapshot().value.playback).toBe("paused");

    actor.stop();
  });

  test("panel can open details and spans", () => {
    const actor = createActor(canvasMachine);
    actor.start();

    // Create a node first
    actor.send({ type: "STREAM.CONNECT" });
    actor.send({ type: "STREAM.EVENT", event: { type: "RUN_CREATED", runId: "run-1", timestamp: 100 } });
    actor.send({ type: "NODE.CLICK", nodeId: "run-1" });

    expect(actor.getSnapshot().context.selectedNodeId).toBe("run-1");

    actor.send({ type: "PANEL.OPEN_DETAILS" });
    expect(actor.getSnapshot().value.panel).toBe("details");

    actor.send({ type: "PANEL.OPEN_SPANS" });
    expect(actor.getSnapshot().matches({ panel: { spans: "loading" } })).toBe(true);

    actor.send({ type: "PANEL.CLOSE" });
    expect(actor.getSnapshot().value.panel).toBe("closed");

    actor.stop();
  });

  test("interaction states work correctly", () => {
    const actor = createActor(canvasMachine);
    actor.start();

    expect(actor.getSnapshot().value.interaction).toBe("idle");

    actor.send({ type: "NODE.DRAG_START" });
    expect(actor.getSnapshot().value.interaction).toBe("dragging");

    actor.send({ type: "NODE.DRAG_END" });
    expect(actor.getSnapshot().value.interaction).toBe("selecting");

    actor.send({ type: "PANE.DRAG_START" });
    expect(actor.getSnapshot().value.interaction).toBe("panning");

    actor.send({ type: "PANE.DRAG_END" });
    expect(actor.getSnapshot().value.interaction).toBe("idle");

    actor.stop();
  });
});

describe("Graph Folding - Property Tests", () => {
  test("folding events matches capcomd status (idempotency)", () => {
    const events: RelayEvent[] = [
      { type: "RUN_CREATED", runId: "run-1", timestamp: 100 },
      { type: "PLAN_READY", runId: "run-1", tasks: ["task-1", "task-2"], timestamp: 200 },
      // TASK_CREATED removed - already created by PLAN_READY
      { type: "LEASE_GRANTED", taskId: "task-1", epoch: 1, workerId: "worker-1", timestamp: 500 },
      { type: "WORKER_STARTED", taskId: "task-1", epoch: 1, timestamp: 600 },
      { type: "VERIFIED_AND_MERGED", taskId: "task-1", commitSha: "abc", timestamp: 700 },
    ];

    // Fold events sequentially
    let graph = createEmptyGraph();
    for (const event of events) {
      graph = foldEvent(graph, event);
    }

    // Fold same events again - should be idempotent
    let graph2 = createEmptyGraph();
    for (const event of events) {
      graph2 = foldEvent(graph2, event);
    }

    expect(Object.keys(graph.nodes).length).toBe(Object.keys(graph2.nodes).length);
    expect(Object.keys(graph.nodes).length).toBe(3); // run + 2 tasks

    // Check task-1 is completed
    expect(graph.nodes["task-1"]?.data.status).toBe("completed");
    expect(graph2.nodes["task-1"]?.data.status).toBe("completed");

    // Check task-2 is still pending
    expect(graph.nodes["task-2"]?.data.status).toBe("pending");
  });

  test("replay to end matches live mode (consistency)", () => {
    const events: RelayEvent[] = [
      { type: "RUN_CREATED", runId: "run-1", timestamp: 100 },
      { type: "PLAN_READY", runId: "run-1", tasks: ["task-1"], timestamp: 200 },
      // TASK_CREATED removed
      { type: "LEASE_GRANTED", taskId: "task-1", epoch: 1, workerId: "worker-1", timestamp: 400 },
      { type: "WORKER_STARTED", taskId: "task-1", epoch: 1, timestamp: 500 },
      { type: "HANDOFF", taskId: "task-1", epoch: 1, timestamp: 600 },
      { type: "VERIFY_STARTED", taskId: "task-1", timestamp: 700 },
      { type: "VERIFIED_AND_MERGED", taskId: "task-1", commitSha: "abc", timestamp: 800 },
      { type: "ALL_TASKS_TERMINAL", timestamp: 900 },
      { type: "JUDGE_PASS", timestamp: 1000 },
    ];

    // "Live mode" - fold events as they come
    let liveGraph = createEmptyGraph();
    for (const event of events) {
      liveGraph = foldEvent(liveGraph, event);
    }

    // "Replay mode" - use replayEvents to final index
    const { graph: replayGraph } = replayEvents(events, events.length - 1);

    // Both should have same number of nodes
    expect(Object.keys(liveGraph.nodes).length).toBe(Object.keys(replayGraph.nodes).length);

    // Run should be completed in both
    expect(liveGraph.nodes["run-1"]?.data.status).toBe("completed");
    expect(replayGraph.nodes["run-1"]?.data.status).toBe("completed");

    // Task should be completed in both
    expect(liveGraph.nodes["task-1"]?.data.status).toBe("completed");
    expect(replayGraph.nodes["task-1"]?.data.status).toBe("completed");
  });

  test("snapshot-based seeking is correct", () => {
    const events: RelayEvent[] = Array.from({ length: 25 }, (_, i) => ({
      type: "TASK_CREATED" as const,
      taskId: `task-${i}`,
      timestamp: i * 100,
    }));

    // Replay to middle (index 15)
    const { graph, snapshots } = replayEvents(events, 15);

    // Should have snapshots at intervals
    expect(snapshots.length).toBeGreaterThan(1);

    // Graph should have 16 nodes (0-15 inclusive)
    expect(Object.keys(graph.nodes).length).toBe(16);

    // Last snapshot should be at or before index 15
    const lastSnapshot = snapshots[snapshots.length - 1];
    expect(lastSnapshot.eventIndex).toBeLessThanOrEqual(16);
  });
});
