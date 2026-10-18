import { createGraph } from "@statelyai/graph";
import { toXYFlow } from "@statelyai/graph/xyflow";
import type { Node, Edge } from "@xyflow/react";
import type { NodeData, RelayGraph } from "./graph-fold";

export function graphToReactFlow(graph: RelayGraph, positions: Record<string, { x: number; y: number }> = {}): {
  nodes: Node[];
  edges: Edge[];
} {
  try {
    // Use @statelyai/graph's toXYFlow converter
    const stately = createGraph<NodeData>({
      nodes: Object.values(graph.nodes).map((node) => ({
        id: node.id,
        parentId: node.parentId,
        label: node.data?.label ?? node.id,
        data: node.data,
      })),
      edges: graph.edges ?? [],
    });
    const { nodes, edges } = toXYFlow(stately);

    // Map to React Flow format with our custom data
    // Fallback layout until ELK positions are applied: runs on row 0, other
    // nodes on row 1, spaced evenly. toXYFlow can return NaN positions.
    const rowCount: Record<number, number> = {};
    const reactFlowNodes: Node[] = nodes.map((node) => {
      const graphNode = graph.nodes[node.id];
      const row = graphNode?.data?.type === "run" ? 0 : 1;
      const col = (rowCount[row] = (rowCount[row] ?? -1) + 1);
      const p = node.position;
      const position = positions[node.id] ?? (
        p && Number.isFinite(p.x) && Number.isFinite(p.y) && (p.x !== 0 || p.y !== 0)
          ? p
          : { x: 40 + col * 200, y: 60 + row * 140 });
      return {
        id: node.id,
        position,
        data: graphNode?.data || { label: node.id, status: "pending", type: "task" },
        type: "default",
        style: {
          background: getStatusColor(graphNode?.data.status),
          padding: 10,
          borderRadius: 5,
          border: "2px solid #333",
          color: "#fff",
        },
      };
    });

    const reactFlowEdges: Edge[] = edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      type: "smoothstep",
      animated: false,
    }));

    return { nodes: reactFlowNodes, edges: reactFlowEdges };
  } catch (error) {
    console.error("Error converting graph to React Flow:", error);
    return { nodes: [], edges: [] };
  }
}

function getStatusColor(status?: string): string {
  switch (status) {
    case "pending":
      return "#94a3b8";
    case "running":
      return "#60a5fa";
    case "completed":
      return "#34d399";
    case "failed":
      return "#f87171";
    default:
      return "#94a3b8";
  }
}

