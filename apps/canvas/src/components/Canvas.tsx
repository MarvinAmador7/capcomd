import React, { useState, useEffect, useCallback } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { eventsToGraph, applyELKLayout } from "../lib/graph-reducer";
import { NodeDetailsPanel } from "./NodeDetailsPanel";
import { TimelineScrubber } from "./TimelineScrubber";
import type { RunEvent, GraphNode } from "../types/graph";

interface CanvasProps {
  events: RunEvent[];
  runId: string;
  mode: "live" | "replay";
}

export function Canvas({ events: allEvents, runId, mode }: CanvasProps) {
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [currentTime, setCurrentTime] = useState(Date.now());

  useEffect(() => {
    const events = mode === "replay" 
      ? allEvents.filter(e => e.at <= currentTime)
      : allEvents;

    const graphData = eventsToGraph(events, runId);

    applyELKLayout(graphData).then(({ nodes: layoutedNodes, edges: layoutedEdges }) => {
      setNodes(layoutedNodes as Node[]);
      setEdges(layoutedEdges as Edge[]);
    });
  }, [allEvents, runId, currentTime, mode, setNodes, setEdges]);

  const handleNodeClick = useCallback((_event: React.MouseEvent, node: Node) => {
    setSelectedNode(node as GraphNode);
  }, []);

  const handleSeek = useCallback((time: number) => {
    setCurrentTime(time);
  }, []);

  return (
    <div className="canvas-container">
      <div className="canvas-header">
        <h1>Relay Orchestrator</h1>
        <div className="mode-indicator">
          {mode === "live" ? (
            <span className="live-badge">● LIVE</span>
          ) : (
            <span className="replay-badge">⏯ REPLAY</span>
          )}
        </div>
      </div>

      <div className="canvas-main">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onNodeClick={handleNodeClick}
          fitView
          minZoom={0.1}
          maxZoom={2}
          defaultViewport={{ x: 0, y: 0, zoom: 0.8 }}
        >
          <Background color="#1a1a2e" gap={16} />
          <Controls />
          <MiniMap
            nodeColor={(node) => {
              const n = node as GraphNode;
              return n.style?.background || "#1a1a2e";
            }}
            maskColor="#0a0a1580"
          />
        </ReactFlow>

        <NodeDetailsPanel
          node={selectedNode}
          onClose={() => setSelectedNode(null)}
        />
      </div>

      {mode === "replay" && (
        <TimelineScrubber
          events={allEvents}
          currentTime={currentTime}
          onSeek={handleSeek}
        />
      )}
    </div>
  );
}
