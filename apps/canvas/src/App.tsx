import { useEffect, useRef, useState } from "react";
import { ReactFlow, Background, Controls, MiniMap, Panel } from "@xyflow/react";
import { useMachine } from "@xstate/react";
import { canvasMachine, type WaterfallSpan } from "./lib/canvas-machine";
import { KIND_COLORS, parseNdjson } from "./lib/waterfall";
import demoTrace from "./fixtures/demo-trace.ndjson?raw";
import { graphToReactFlow } from "./lib/react-flow-adapter";
import { createElkLayout, type Positions } from "./lib/elk-layout";
import { preferencesStore } from "./lib/preferences-store";
import type { RelayEvent } from "./lib/graph-fold";
import "@xyflow/react/dist/style.css";

export default function App() {
  const [state, send] = useMachine(canvasMachine);
  const [prefs, setPrefs] = useState(preferencesStore.getSnapshot().context);
  const layoutRef = useRef<ReturnType<typeof createElkLayout> | null>(null);
  const [positions, setPositions] = useState<Positions>({});
  const [layoutStatus, setLayoutStatus] = useState<"pending" | "elk" | "fallback">("pending");
  const { nodes, edges } = graphToReactFlow(state.context.graph, positions);

  useEffect(() => {
    const unsub = preferencesStore.subscribe((snapshot) => {
      setPrefs(snapshot.context);
    });
    return () => unsub.unsubscribe();
  }, []);

  useEffect(() => {
    layoutRef.current = createElkLayout();
    send({ type: "STREAM.CONNECT" });

    // Real spans: ?run=<runId> loads .traces/<runId>.ndjson through the dev server;
    // otherwise use a trace captured from a real `capcomd run` (src/fixtures/demo-trace.ndjson).
    const runParam = new URLSearchParams(window.location.search).get("run");
    if (runParam) {
      fetch(`/api/trace/${encodeURIComponent(runParam)}`)
        .then((r) => (r.ok ? r.text() : ""))
        .then((text) => send({ type: "TRACE.LOADED", spans: parseNdjson(text) }))
        .catch(() => {});
    } else {
      send({ type: "TRACE.LOADED", spans: parseNdjson(demoTrace) });
    }

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
        send({ type: "STREAM.EVENT", event: demoEvents[i]! });
        i++;
      } else {
        clearInterval(interval);
      }
    }, 200);

    return () => {
      clearInterval(interval);
      layoutRef.current?.terminate();
    };
  }, [send]);

  // Trigger layout when graph changes
  useEffect(() => {
    const elk = layoutRef.current;
    if (!prefs.autoLayout || !elk || layoutStatus === "fallback" || Object.keys(state.context.graph.nodes).length === 0) return;
    let stale = false;
    elk
      .layout(state.context.graph)
      .then((p) => {
        if (stale) return;
        setPositions(p);
        setLayoutStatus("elk");
      })
      .catch((err) => {
        // Only a real worker/ELK failure gets here; the grid fallback in graphToReactFlow takes over.
        console.warn("[layout] ELK worker failed, using fallback grid layout:", err);
        setLayoutStatus("fallback");
      });
    return () => {
      stale = true;
    };
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
            <div data-testid="layout-status">Layout: {layoutStatus}</div>
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
              {(state.value.panel as unknown) === "spans" || state.matches({ panel: { spans: "loading" } }) || state.matches({ panel: { spans: "ready" } }) || state.matches({ panel: { spans: "error" } }) ? (
                <div>
                  <h4 style={{ marginBottom: 8 }}>Span waterfall</h4>
                  {state.matches({ panel: { spans: "loading" } }) && <p>Loading spans…</p>}
                  {state.matches({ panel: { spans: "error" } }) && <p>Error loading traces</p>}
                  {state.matches({ panel: { spans: "ready" } }) && (
                    <SpanWaterfall spans={state.context.traceData?.spans ?? []} source={state.context.traceData?.source} />
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

function SpanWaterfall({ spans, source }: { spans: WaterfallSpan[]; source?: "trace" | "events" }) {
  if (spans.length === 0) {
    return <p data-testid="waterfall-empty">No spans for this node.</p>;
  }
  const total = Math.max(...spans.map((s) => s.endTime)) - Math.min(...spans.map((s) => s.startTime));
  const kinds = [...new Set(spans.map((s) => s.kind))];

  return (
    <div data-testid="waterfall" style={{ display: "grid", gap: 3, width: 560, maxHeight: "60vh", overflowY: "auto" }}>
      <div style={{ fontSize: 11, color: "#94a3b8", display: "flex", gap: 10, flexWrap: "wrap" }}>
        <span>{spans.length} spans · {total}ms · {source === "trace" ? "from trace" : "from events (no trace loaded)"}</span>
        {kinds.map((k) => (
          <span key={k}><span style={{ display: "inline-block", width: 8, height: 8, background: KIND_COLORS[k], marginRight: 3 }} />{k}</span>
        ))}
      </div>
      {spans.map((span) => {
        const detail =
          span.attributes["relay.state_from"] !== undefined
            ? `${span.attributes["relay.entity_id"] ?? ""} ${span.attributes["relay.state_from"]} → ${span.attributes["relay.state_to"]}`
            : span.attributes["gen_ai.request.model"]
              ? `tokens ${span.attributes["gen_ai.usage.input_tokens"] ?? "?"}/${span.attributes["gen_ai.usage.output_tokens"] ?? "?"}`
              : span.attributes["git.ref"] ?? "";
        return (
          <div key={span.spanId} title={JSON.stringify(span.attributes, null, 1)} style={{ display: "grid", gridTemplateColumns: "230px 1fr 52px", alignItems: "center", gap: 6, fontSize: 11 }}>
            <span style={{ paddingLeft: span.depth * 10, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: span.error ? "#fca5a5" : "#e2e8f0" }}>
              {span.name}
              {detail ? <span style={{ color: "#64748b" }}> {detail}</span> : null}
            </span>
            <div style={{ position: "relative", height: 9, background: "#1f2937", borderRadius: 3 }}>
              <div
                data-kind={span.kind}
                style={{ position: "absolute", left: `${span.offsetPct}%`, width: `${Math.min(span.widthPct, 100 - span.offsetPct)}%`, minWidth: 2, height: "100%", background: span.error ? "#ef4444" : KIND_COLORS[span.kind], borderRadius: 3 }}
              />
            </div>
            <span style={{ textAlign: "right", color: "#94a3b8" }}>{span.durationMs}ms</span>
          </div>
        );
      })}
    </div>
  );
}
