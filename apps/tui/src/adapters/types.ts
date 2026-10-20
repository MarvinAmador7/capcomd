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
  entity: string; // "run", a task id, an agent id
  data: Record<string, unknown>;
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
  children: AgentNode[];
}

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
}
