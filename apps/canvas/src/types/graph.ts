export interface RunEvent {
  seq: number;
  at: number;
  event: {
    type: string;
    [key: string]: any;
  };
  entityId: string;
  entityType: "run" | "planner" | "task" | "lease" | "worker" | "verifier" | "judge";
}

export interface GraphNode {
  id: string;
  type: "run" | "planner" | "task" | "lease" | "worker" | "verifier" | "judge" | "group";
  data: {
    label: string;
    state?: string;
    context?: any;
    events?: RunEvent[];
    budget?: { spent: number; maxCost: number };
    epoch?: number;
  };
  position: { x: number; y: number };
  style?: {
    background?: string;
    borderColor?: string;
  };
  parentId?: string;
}

export interface GraphEdge {
  id: string;
  source: string;
  target: string;
  type?: "spawn" | "lease" | "handoff" | "verify";
  label?: string;
  animated?: boolean;
  style?: {
    stroke?: string;
    strokeDasharray?: string;
  };
}

export interface GraphData {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface RunSnapshot {
  runId: string;
  state: string;
  context: any;
  events: RunEvent[];
  entities: {
    planners: Map<string, { state: string; context: any; events: RunEvent[] }>;
    tasks: Map<string, { state: string; context: any; events: RunEvent[] }>;
    leases: Map<string, { state: string; context: any; events: RunEvent[] }>;
    workers: Map<string, { state: string; context: any; events: RunEvent[] }>;
    verifiers: Map<string, { state: string; context: any; events: RunEvent[] }>;
    judges: Map<string, { state: string; context: any; events: RunEvent[] }>;
  };
}
