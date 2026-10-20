import { createGraph, getGraphWithNode, getGraphWithUpdatedNode, getNode } from "@statelyai/graph";
import type { Graph, GraphNode } from "@statelyai/graph";

export type RelayEvent =
  | { type: "RUN_CREATED"; runId: string; timestamp: number }
  | { type: "PLAN_READY"; runId: string; tasks: string[]; timestamp: number }
  | { type: "TASK_CREATED"; taskId: string; timestamp: number }
  | { type: "LEASE_GRANTED"; taskId: string; epoch: number; workerId: string; timestamp: number }
  | { type: "WORKER_STARTED"; taskId: string; epoch: number; timestamp: number }
  | { type: "HANDOFF"; taskId: string; epoch: number; timestamp: number }
  | { type: "VERIFY_STARTED"; taskId: string; timestamp: number }
  | { type: "VERIFIED_AND_MERGED"; taskId: string; commitSha: string; timestamp: number }
  | { type: "ALL_TASKS_TERMINAL"; timestamp: number }
  | { type: "JUDGE_PASS"; timestamp: number };

export interface NodeData {
  label: string;
  status: "pending" | "running" | "completed" | "failed";
  taskId?: string;
  workerId?: string;
  epoch?: number;
  type: "run" | "task" | "worker" | "verifier" | "judge";
}

type StatelyGraph = Graph<NodeData>;

export type RelayGraph = Omit<StatelyGraph, "nodes"> & {
  nodes: Record<string, GraphNode<NodeData>>;
};

const SNAPSHOT_INTERVAL = 10;

export interface GraphSnapshot {
  graph: RelayGraph;
  eventIndex: number;
}

export interface GraphState {
  graph: RelayGraph;
  snapshots: GraphSnapshot[];
}

function publish(graph: StatelyGraph): RelayGraph {
  const nodes: Record<string, GraphNode<NodeData>> = {};
  for (const node of graph.nodes) nodes[node.id] = node;
  return { ...graph, nodes };
}

function materialize(graph: RelayGraph): StatelyGraph {
  return createGraph<NodeData>({
    id: graph.id,
    mode: graph.mode,
    initialNodeId: graph.initialNodeId,
    nodes: Object.values(graph.nodes).map((node) => ({
      id: node.id,
      parentId: node.parentId,
      label: node.data?.label ?? node.label,
      data: node.data,
    })),
    edges: graph.edges,
    data: graph.data,
  });
}

export function createEmptyGraph(): RelayGraph {
  return publish(createGraph<NodeData>());
}

function updateData(
  graph: StatelyGraph,
  id: string,
  patch: Partial<NodeData>
): StatelyGraph {
  const existing = getNode(graph, id);
  if (!existing) return graph;
  return getGraphWithUpdatedNode(graph, id, {
    data: { ...existing.data, ...patch },
  });
}

export function foldEvent(graph: RelayGraph, event: RelayEvent): RelayGraph {
  let current = materialize(graph);

  switch (event.type) {
    case "RUN_CREATED": {
      if (!getNode(current, event.runId)) {
        current = getGraphWithNode(current, {
          id: event.runId,
          data: {
            label: `Run ${event.runId.slice(0, 8)}`,
            status: "running",
            type: "run",
          },
        });
      }
      break;
    }

    case "PLAN_READY": {
      current = updateData(current, event.runId, { status: "running" });
      for (const taskId of event.tasks) {
        if (!getNode(current, taskId)) {
          current = getGraphWithNode(current, {
            id: taskId,
            parentId: event.runId,
            data: {
              label: taskId,
              status: "pending",
              taskId,
              type: "task",
            },
          });
        }
      }
      break;
    }

    case "TASK_CREATED": {
      if (!getNode(current, event.taskId)) {
        current = getGraphWithNode(current, {
          id: event.taskId,
          data: {
            label: event.taskId,
            status: "pending",
            taskId: event.taskId,
            type: "task",
          },
        });
      }
      break;
    }

    case "LEASE_GRANTED": {
      current = updateData(current, event.taskId, {
        status: "running",
        workerId: event.workerId,
        epoch: event.epoch,
      });
      break;
    }

    case "WORKER_STARTED": {
      current = updateData(current, event.taskId, {
        status: "running",
        epoch: event.epoch,
      });
      break;
    }

    case "HANDOFF":
    case "VERIFY_STARTED": {
      current = updateData(current, event.taskId, { status: "running" });
      break;
    }

    case "VERIFIED_AND_MERGED": {
      current = updateData(current, event.taskId, { status: "completed" });
      break;
    }

    case "ALL_TASKS_TERMINAL":
      break;

    case "JUDGE_PASS": {
      const runNode = current.nodes.find((node) => node.data?.type === "run");
      if (runNode) current = updateData(current, runNode.id, { status: "completed" });
      break;
    }

    default:
      break;
  }

  return publish(current);
}

export function replayEvents(events: RelayEvent[], toIndex: number): GraphState {
  let graph = createEmptyGraph();
  const snapshots: GraphSnapshot[] = [{ graph, eventIndex: 0 }];

  for (let i = 0; i <= toIndex && i < events.length; i++) {
    graph = foldEvent(graph, events[i]!);

    if ((i + 1) % SNAPSHOT_INTERVAL === 0 || i === toIndex) {
      snapshots.push({ graph, eventIndex: i + 1 });
    }
  }

  return { graph, snapshots };
}

export function seekToEvent(state: GraphState, events: RelayEvent[], targetIndex: number): GraphState {
  const lastSnapshot = state.snapshots.reduce((prev, curr) =>
    curr.eventIndex <= targetIndex && curr.eventIndex > prev.eventIndex ? curr : prev
  );

  let graph = lastSnapshot.graph;
  for (let i = lastSnapshot.eventIndex; i <= targetIndex && i < events.length; i++) {
    graph = foldEvent(graph, events[i]!);
  }

  return { ...state, graph };
}
