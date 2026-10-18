import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Panel } from "@xyflow/react";
import { useMachine } from "@xstate/react";
import { canvasMachine, type WaterfallSpan } from "./lib/canvas-machine";
import { createLayoutWorker, graphToReactFlow, requestLayout } from "./lib/react-flow-adapter";
import { preferencesStore } from "./lib/preferences-store";
import type { RelayEvent } from "./lib/graph-fold";
import "@xyflow/react/dist/style.css";

export default function App() {
  const [state, send] = useMachine(canvasMachine);
  const [prefs, setPrefs] = useState(preferencesStore.getSnapshot().context);
  const layoutWorkerRef = useRef<Worker | null>(null);
  const { nodes, edges } = graphToReactFlow(state.context.graph);

  useEffect(() => {
    const unsub = preferencesStore.subscribe((snapshot) => {
      setPrefs(snapshot.context);
    });
    return unsub;
  }, []);

  useEffect(() => {
    layoutWorkerRef.current = createLayoutWorker();
    send({ type: "STREAM.CONNECT" });

    // Simulate some events for demo
    const demoEvents: RelayEvent[] = [
      { type: "RUN_CREATED", runId: "run-demo-123", timestamp: Date.now() },
      { type: "PLAN_READY", runId: "run-demo-123", tasks: ["task-1", "task-2"], timestamp: Date.now() + 100 },
      { type: "TASK_CREATED", taskId: "task-1", timestamp: Date.now() + 200 },
      { type: "TASK_CREATED", taskId: "task-2", timestamp: Date.now() + 300 },
      { type: "LEASE_GRANTED", taskId: "task-1", epoch: 1, workerId: "worker-1", timestamp: Date.now() + 400 },
      { type: "WORKER_STARTED", taskId: "task-1", epoch: 1, timestamp: Date.now() + 500 },
      { type: "HANDOFF", taskId: "task-1", epoch: 1, timestamp: Date.now() + 600 },
      { type: "VERIFY_STARTED", taskId: "task-1", timestamp: Date.now() + 700 },
      { type: "VERIFIED_AND_MERGED", taskId: "task-1", commitSha: "abc123", timestamp: Date.now() + 800 },
      { type: "LEASE_GRANTED", taskId: "task-2", epoch: 1, workerId: "worker-1", timestamp: Date.now() + 900 },
      { type: "WORKER_STARTED", taskId: "task-2", epoch: 1, timestamp: Date.now() + 1000 },
      { type: "HANDOFF", taskId: "task-2", epoch: 1, timestamp: Date.now() + 1100 },
      { type: "VERIFY_STARTED", taskId: "task-2", timestamp: Date.now() + 1200 },
      { type: "VERIFIED_AND_MERGED", taskId: "task-2", commitSha: "def456", timestamp: Date.now() + 1300 },
      { type: "ALL_TASKS_TERMINAL", timestamp: Date.now() + 1400 },
      { type: "JUDGE_PASS", timestamp: Date.now() + 1500 },
    ];

    let i = 0;
    const interval = setInterval(() => {
      if (i < demoEvents.length) {
        send({ type: "STREAM.EVENT", event: demoEvents[i] });
        i++;
      } else {
        clearInterval(interval);
      }
    }, 200);

    return () => {
      clearInterval(interval);
      layoutWorkerRef.current?.terminate();
    };
  }, [send]);

  // Trigger layout when graph changes
  useEffect(() => {
    if (prefs.autoLayout && layoutWorkerRef.current && Object.keys(state.context.graph.nodes).length > 0) {
      requestLayout(layoutWorkerRef.current, state.context.graph).catch((err) => {
        console.error("Layout failed:", err);
      });
    }
  }, [state.context.graph, prefs.autoLayout]);

  const handleNodeClick = (_: React.MouseEvent, node: { id: string }) => {
    send({ type: "NODE.CLICK", nodeId: node.id });
    send({ type: "PANEL.OPEN_DETAILS" });
  };

  return (
    <div style={{ width: "100vw", height: "100vh", background: prefs.theme === "dark" ? "#1a1a1a" : "#fff" }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodeClick={handleNodeClick}
        onNodeDragStart={() => send({ type: "NODE.DRAG_START" })}
        onNodeDragStop={() => send({ type: "NODE.DRAG_END" })}
        onMoveStart={() => send({ type: "PANE.DRAG_START" })}
        onMoveEnd={() => send({ type: "PANE.DRAG_END" })}
        fitView
      >
        <Background />
        <Controls />
        {prefs.miniMapEnabled && <MiniMap />}

        <Panel position="top-right">
          <div style={{ background: "#333", padding: 10, borderRadius: 5, color: "#fff" }}>
            <div>Mode: {state.value.mode}</div>
            <div>Events: {state.context.events.length}</div>
            <div>Nodes: {Object.keys(state.context.graph.nodes).length}</div>
            <button
              onClick={() => send({ type: state.context.mode === "live" ? "MODE.SWITCH_TO_REPLAY" : "MODE.SWITCH_TO_LIVE" })}
              style={{ marginTop: 10, padding: "5px 10px" }}
            >
              Switch to {state.context.mode === "live" ? "Replay" : "Live"}
            </button>
          </div>
        </Panel>

        {state.value.mode === "replay" && (
          <Panel position="bottom-center">
            <div style={{ background: "#333", padding: 10, borderRadius: 5, color: "#fff", minWidth: 400 }}>
              <input
                type="range"
                min={0}
                max={Math.max(0, state.context.events.length - 1)}
                value={state.context.currentEventIndex}
                onChange={(e) => send({ type: "PLAYBACK.SEEK", index: parseInt(e.target.value) })}
                style={{ width: "100%" }}
              />
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <button onClick={() => send({ type: "PLAYBACK.PLAY" })}>Play</button>
                <button onClick={() => send({ type: "PLAYBACK.PAUSE" })}>Pause</button>
                <span>
                  {state.context.currentEventIndex + 1} / {state.context.events.length}
                </span>
              </div>
            </div>
          </Panel>
        )}

        {state.value.panel !== "closed" && state.context.selectedNodeId && (
          <Panel position="top-left">
            <div style={{ background: "#333", padding: 20, borderRadius: 5, color: "#fff", minWidth: 300 }}>
              <h3>Node Details</h3>
              <button onClick={() => send({ type: "PANEL.CLOSE" })} style={{ float: "right" }}>
                ×
              </button>
              <p>ID: {state.context.selectedNodeId}</p>
              <p>Status: {state.context.graph.nodes[state.context.selectedNodeId]?.data.status}</p>
              {state.value.panel === "spans" || state.matches({ panel: { spans: "loading" } }) || state.matches({ panel: { spans: "ready" } }) || state.matches({ panel: { spans: "error" } }) ? (
                <div>
                  <h4 style={{ marginBottom: 8 }}>Span waterfall</h4>
                  {state.matches({ panel: { spans: "loading" } }) && <p>Loading spans…</p>}
                  {state.matches({ panel: { spans: "error" } }) && <p>Error loading traces</p>}
                  {state.matches({ panel: { spans: "ready" } }) && (
                    <SpanWaterfall spans={state.context.traceData?.spans ?? []} />
                  )}
                </div>
              ) : null}
              <button onClick={() => send({ type: "PANEL.OPEN_SPANS" })} style={{ marginTop: 10 }}>
                View Spans
              </button>
            </div>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}

function SpanWaterfall({ spans }: { spans: WaterfallSpan[] }) {
  if (spans.length === 0) {
    return <p>No spans for this node.</p>;
  }

  const min = Math.min(...spans.map((span) => span.startTime));
  const max = Math.max(...spans.map((span) => span.endTime));
  const total = Math.max(1, max - min);

  return (
    <div style={{ display: "grid", gap: 6, minWidth: 360 }}>
      {spans.map((span, index) => {
        const offset = ((span.startTime - min) / total) * 100;
        const width = Math.max(2, ((span.endTime - span.startTime) / total) * 100);
        const detail = Object.entries(span.attributes)
          .map(([key, value]) => `${key}: ${value}`)
          .join(" · ");
        return (
          <div key={`${span.name}-${index}`}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
              <span>{span.name}</span>
              <span>{span.endTime - span.startTime}ms</span>
            </div>
            <div style={{ position: "relative", height: 10, background: "#1f2937", borderRadius: 4 }}>
              <div
                style={{
                  position: "absolute",
                  left: `${offset}%`,
                  width: `${width}%`,
                  height: "100%",
                  background: "#38bdf8",
                  borderRadius: 4,
                }}
              />
            </div>
            {detail ? <div style={{ fontSize: 11, color: "#cbd5e1" }}>{detail}</div> : null}
          </div>
        );
      })}
    </div>
  );
}
