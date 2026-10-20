/** Normalized shapes the views render. Adapters map capcomd's CLI output onto these. */
export type SpanStatus = "ok" | "error" | "unset";

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  start: number; // epoch ms
  end: number;
  durationMs: number;
  offsetMs: number; // from trace start
  depth: number;
  status: SpanStatus;
  message?: string;
  attrs: Record<string, unknown>;
  events: Array<{ name: string; at: number; attrs: Record<string, unknown> }>;
}

export interface Trace {
  runId: string;
  start: number;
  end: number;
  durationMs: number;
  spans: Span[]; // depth-first, children by start time
}

export interface RunEvent {
  at: number; // epoch ms
  type: string;
  entity: string; // source entity ("run", a task id, "scope:agt-x")
  data: Record<string, unknown>;
  /** Global position in the run's merged log (contract: `seq`). */
  seq?: number;
  /** Per-entity counter; (entity, entitySeq) is the dedupe key. */
  entitySeq?: number;
  /** Scope agent the event is about, or null for run/task events. */
  agentId?: string | null;
}

export interface Spend { usd?: number; turns?: number; wallSeconds?: number; [unit: string]: number | undefined }

export interface AgentNode {
  agentId: string;
  profile: string | null;
  status: string;
  depth: number;
  spent: Spend;
  budget: Spend;
  rollup?: { agents: number; usd: number; turns: number; wallSeconds: number; byStatus: Record<string, number> };
  stuck?: string;
  parent?: string | null;
  taskId?: string;
  /** The agent's `agent.run` span id (tree → trace join). */
  spanId?: string;
  startedAt?: number;
  endedAt?: number | null;
  /** agent.error_kind from the agent's CLI span, when it failed. */
  errorKind?: string;
  children: AgentNode[];
}

export interface PendingApproval { taskId: string; kind?: string; targetBranch?: string; since: number }

export interface RunData {
  runId: string;
  source: string; // "fixture:<name>" or "live"
  goal?: string;
  state?: string;
  trace: Trace | null;
  events: RunEvent[];
  agents: AgentNode[];
  /** Agents came from `capcomd tree` (true) or were inferred from trace spans (false). */
  agentsFromTree: boolean;
  /** From `status.pendingApprovals[]`. */
  pendingApprovals: PendingApproval[];
}
