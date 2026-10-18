import ELK from "elkjs/lib/elk.bundled";
import type { Graph } from "@statelyai/graph";
import type { NodeData } from "./graph-fold";

const elk = new ELK();

interface LayoutMessage {
  type: "LAYOUT_REQUEST";
  graph: Graph<NodeData>;
  id: string;
}

interface LayoutResponse {
  type: "LAYOUT_COMPLETE";
  graph: Graph<NodeData>;
  id: string;
}

self.onmessage = async (e: MessageEvent<LayoutMessage>) => {
  const { graph, id } = e.data;

  try {
    // Convert graph to ELK format
    const elkGraph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "80",
        "elk.layered.spacing.nodeNodeBetweenLayers": "80",
      },
      children: Object.values(graph.nodes).map((node) => ({
        id: node.id,
        width: 150,
        height: 50,
      })),
      edges: Object.values(graph.edges || {}).map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    };

    // Compute layout
    const laid = await elk.layout(elkGraph);

    // Update graph with positions
    const updatedNodes: Graph<NodeData>["nodes"] = {};
    for (const [nodeId, node] of Object.entries(graph.nodes)) {
      const elkNode = laid.children?.find((c) => c.id === nodeId);
      updatedNodes[nodeId] = {
        ...node,
        position: elkNode ? { x: elkNode.x || 0, y: elkNode.y || 0 } : { x: 0, y: 0 },
        size: elkNode ? { width: elkNode.width || 150, height: elkNode.height || 50 } : { width: 150, height: 50 },
      };
    }

    const response: LayoutResponse = {
      type: "LAYOUT_COMPLETE",
      graph: { ...graph, nodes: updatedNodes },
      id,
    };

    self.postMessage(response);
  } catch (error) {
    self.postMessage({
      type: "LAYOUT_ERROR",
      error: error instanceof Error ? error.message : String(error),
      id,
    });
  }
};

export {};
