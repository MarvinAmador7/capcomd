import type { GraphData, GraphNode, GraphEdge, RunSnapshot, RunEvent } from "../types/graph";

const STATE_COLORS: Record<string, { background: string; border: string }> = {
  // Run states
  planning: { background: "#1e3a5f", border: "#3b82f6" },
  executing: { background: "#1e3a5f", border: "#3b82f6" },
  judging: { background: "#3d2e1f", border: "#f59e0b" },
  completed: { background: "#1e3d2f", border: "#10b981" },
  failed: { background: "#3d1e1e", border: "#ef4444" },
  cancelled: { background: "#2d2d2d", border: "#6b7280" },
  degraded: { background: "#3d2e1f", border: "#f59e0b" },

  // Task states
  pending: { background: "#1a1a2e", border: "#64748b" },
  leased: { background: "#1e3a5f", border: "#3b82f6" },
  running: { background: "#1e3a5f", border: "#3b82f6" },
  handed_off: { background: "#3d2e1f", border: "#f59e0b" },
  verifying: { background: "#3d2e1f", border: "#f59e0b" },
  merged: { background: "#1e3d2f", border: "#10b981" },

  // Worker states
  provisioning: { background: "#1a1a2e", border: "#64748b" },
  idle: { background: "#1e3a5f", border: "#3b82f6" },
  busy: { background: "#1e3a5f", border: "#3b82f6" },
  draining: { background: "#3d2e1f", border: "#f59e0b" },
  destroyed: { background: "#2d2d2d", border: "#6b7280" },

  // Lease states
  free: { background: "#1a1a2e", border: "#64748b" },
  held: { background: "#1e3a5f", border: "#3b82f6" },
  released: { background: "#2d2d2d", border: "#6b7280" },
  expired: { background: "#2d2d2d", border: "#6b7280" },

  // Default
  default: { background: "#1a1a2e", border: "#475569" },
};

function getNodeColor(state?: string): { background: string; borderColor: string } {
  const colors = STATE_COLORS[state || "default"] || STATE_COLORS.default!;
  return {
    background: colors.background,
    borderColor: colors.border,
  };
}

export function eventsToGraph(events: RunEvent[], runId: string): GraphData {
  const snapshot = buildSnapshot(events, runId);
  return snapshotToGraph(snapshot);
}

function buildSnapshot(events: RunEvent[], runId: string): RunSnapshot {
  const snapshot: RunSnapshot = {
    runId,
    state: "planning",
    context: {},
    events: [],
    entities: {
      planners: new Map(),
      tasks: new Map(),
      leases: new Map(),
      workers: new Map(),
      verifiers: new Map(),
      judges: new Map(),
    },
  };

  for (const event of events) {
    if (event.entityId === runId) {
      snapshot.events.push(event);
      if (event.event.type === "PLAN_READY") {
        snapshot.state = "executing";
        snapshot.context = { ...snapshot.context, plan: event.event };
      } else if (event.event.type === "ALL_TASKS_TERMINAL") {
        snapshot.state = "judging";
      } else if (event.event.type === "JUDGE_PASS") {
        snapshot.state = "completed";
      } else if (event.event.type === "JUDGE_FAIL") {
        snapshot.state = "failed";
      } else if (event.event.type === "CANCEL") {
        snapshot.state = "cancelled";
      }
    } else if (event.entityId.includes("-planner")) {
      updateEntity(snapshot.entities.planners, event);
    } else if (event.entityId.includes("-lease")) {
      updateEntity(snapshot.entities.leases, event);
    } else if (event.entityId.includes("-worker")) {
      updateEntity(snapshot.entities.workers, event);
    } else if (event.entityId.includes("-verifier")) {
      updateEntity(snapshot.entities.verifiers, event);
    } else if (event.entityId.includes("-judge")) {
      updateEntity(snapshot.entities.judges, event);
    } else if (event.entityId.startsWith("task-")) {
      updateEntity(snapshot.entities.tasks, event);
    }
  }

  return snapshot;
}

function updateEntity(
  map: Map<string, { state: string; context: any; events: RunEvent[] }>,
  event: RunEvent
): void {
  const entity = map.get(event.entityId) || {
    state: "unknown",
    context: {},
    events: [],
  };

  entity.events.push(event);

  if (event.event.type === "CREATED") {
    entity.state = "pending";
  } else if (event.event.type === "LEASE_GRANTED") {
    entity.state = "leased";
    entity.context = { ...entity.context, ...event.event };
  } else if (event.event.type === "WORKER_STARTED") {
    entity.state = "running";
  } else if (event.event.type === "HANDOFF") {
    entity.state = "handed_off";
    entity.context = { ...entity.context, ...event.event };
  } else if (event.event.type === "VERIFY_STARTED") {
    entity.state = "verifying";
  } else if (event.event.type === "VERIFIED_AND_MERGED") {
    entity.state = "merged";
  } else if (event.event.type === "VM_READY") {
    entity.state = "idle";
    entity.context = { ...entity.context, ...event.event };
  } else if (event.event.type === "ASSIGN") {
    entity.state = "busy";
  } else if (event.event.type === "GRANT") {
    entity.state = "held";
    entity.context = { ...entity.context, ...event.event };
  }

  map.set(event.entityId, entity);
}

function snapshotToGraph(snapshot: RunSnapshot): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];

  // Run node
  nodes.push({
    id: snapshot.runId,
    type: "run",
    data: {
      label: `Run\n${snapshot.runId.substring(0, 12)}`,
      state: snapshot.state,
      context: snapshot.context,
      events: snapshot.events,
    },
    position: { x: 0, y: 0 },
    style: getNodeColor(snapshot.state),
  });

  let yOffset = 150;

  // Planners
  snapshot.entities.planners.forEach((planner, id) => {
    nodes.push({
      id,
      type: "planner",
      data: {
        label: id.includes("root") ? "Root Planner" : `Sub-Planner\n${id.split("-").pop()}`,
        state: planner.state,
        context: planner.context,
        events: planner.events,
      },
      position: { x: 0, y: yOffset },
      style: getNodeColor(planner.state),
    });

    edges.push({
      id: `${snapshot.runId}-${id}`,
      source: snapshot.runId,
      target: id,
      type: "spawn",
      style: { stroke: "#64748b" },
    });

    yOffset += 100;
  });

  // Tasks
  let xOffset = 300;
  snapshot.entities.tasks.forEach((task, id) => {
    nodes.push({
      id,
      type: "task",
      data: {
        label: `Task\n${id}`,
        state: task.state,
        context: task.context,
        events: task.events,
      },
      position: { x: xOffset, y: 200 },
      style: getNodeColor(task.state),
    });

    // Find planner that created this task
    const plannerId = `${snapshot.runId}-planner`;
    if (snapshot.entities.planners.has(plannerId)) {
      edges.push({
        id: `${plannerId}-${id}`,
        source: plannerId,
        target: id,
        type: "spawn",
        style: { stroke: "#64748b" },
      });
    }

    // Lease edges
    const leaseId = `${id}-lease`;
    if (snapshot.entities.leases.has(leaseId)) {
      const lease = snapshot.entities.leases.get(leaseId)!;
      edges.push({
        id: `${id}-${leaseId}`,
        source: id,
        target: leaseId,
        type: "lease",
        label: `epoch ${lease.context.epoch || 0}`,
        style: { stroke: "#3b82f6" },
      });

      nodes.push({
        id: leaseId,
        type: "lease",
        data: {
          label: `Lease\ne${lease.context.epoch || 0}`,
          state: lease.state,
          context: lease.context,
          events: lease.events,
          epoch: lease.context.epoch,
        },
        position: { x: xOffset, y: 350 },
        style: getNodeColor(lease.state),
      });

      // Worker edges
      if (lease.context.workerId) {
        edges.push({
          id: `${leaseId}-${lease.context.workerId}`,
          source: leaseId,
          target: lease.context.workerId,
          type: "lease",
          style: { stroke: "#3b82f6" },
        });
      }
    }

    // Handoff edges
    if (task.state === "handed_off" || task.state === "verifying" || task.state === "merged") {
      const verifierId = `${id}-verifier`;
      edges.push({
        id: `${id}-${verifierId}`,
        source: id,
        target: verifierId,
        type: "handoff",
        style: { stroke: "#f59e0b", strokeDasharray: "5,5" },
      });
    }

    xOffset += 200;
  });

  // Workers
  yOffset = 500;
  snapshot.entities.workers.forEach((worker, id) => {
    nodes.push({
      id,
      type: "worker",
      data: {
        label: `Worker\n${id.split("-").pop()}`,
        state: worker.state,
        context: worker.context,
        events: worker.events,
      },
      position: { x: 300, y: yOffset },
      style: getNodeColor(worker.state),
    });

    yOffset += 100;
  });

  // Verifiers
  xOffset = 600;
  snapshot.entities.verifiers.forEach((verifier, id) => {
    nodes.push({
      id,
      type: "verifier",
      data: {
        label: "Verifier",
        state: verifier.state,
        context: verifier.context,
        events: verifier.events,
      },
      position: { x: xOffset, y: 400 },
      style: getNodeColor(verifier.state),
    });

    // Verify edge to run
    if (verifier.state === "passed") {
      edges.push({
        id: `${id}-${snapshot.runId}-verify`,
        source: id,
        target: snapshot.runId,
        type: "verify",
        label: "merged",
        style: { stroke: "#10b981" },
      });
    }

    xOffset += 150;
  });

  return { nodes, edges };
}

export function applyELKLayout(graphData: GraphData): Promise<GraphData> {
  return import("elkjs").then(({ default: ELK }) => {
    const elk = new ELK();

    const graph = {
      id: "root",
      layoutOptions: {
        "elk.algorithm": "layered",
        "elk.direction": "DOWN",
        "elk.spacing.nodeNode": "80",
        "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      },
      children: graphData.nodes.map((node) => ({
        id: node.id,
        width: 150,
        height: 60,
      })),
      edges: graphData.edges.map((edge) => ({
        id: edge.id,
        sources: [edge.source],
        targets: [edge.target],
      })),
    };

    return elk.layout(graph).then((layouted) => {
      const newNodes = graphData.nodes.map((node) => {
        const layoutNode = layouted.children?.find((n) => n.id === node.id);
        if (layoutNode) {
          return {
            ...node,
            position: { x: layoutNode.x || 0, y: layoutNode.y || 0 },
          };
        }
        return node;
      });

      return { nodes: newNodes, edges: graphData.edges };
    });
  });
}
