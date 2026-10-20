import type { AgentNode, Spend, Trace } from "./types";

/** `capcomd tree <runId> --json` → nodes. Accepts the full envelope or a bare node array. */
export function parseTree(text: string): AgentNode[] {
  let v: any;
  try { v = JSON.parse(text); } catch { return []; }
  const nodes = Array.isArray(v) ? v : Array.isArray(v?.tree) ? v.tree : [];
  return nodes.map((n: any) => node(n, 0));
}

function node(n: any, depth: number): AgentNode {
  return {
    agentId: String(n.agentId), profile: n.profile ?? null, status: String(n.status ?? "unknown"),
    depth: typeof n.depth === "number" ? n.depth : depth, spent: n.spent ?? {}, budget: n.budget ?? {},
    rollup: n.rollup, stuck: n.stuck, children: (n.children ?? []).map((c: any) => node(c, depth + 1)),
  };
}

/**
 * Today's task-board runs have no `tree`; infer one agent per task from its agent.* spans
 * (agent.turns, agent.cost_usd, duration). Multiple attempts of a task are summed.
 */
export function agentsFromTrace(trace: Trace | null): AgentNode[] {
  if (!trace) return [];
  const by = new Map<string, AgentNode>();
  for (const s of trace.spans) {
    if (!s.name.startsWith("agent.") || s.name === "agent.install") continue;
    const id = String(s.attrs["relay.agent_id"] ?? s.attrs["relay.task_id"] ?? s.id);
    const cur = by.get(id) ?? {
      agentId: id, profile: (s.attrs["agent.profile"] as string) ?? (s.attrs["agent.kind"] as string) ?? null,
      status: "done", depth: 0, spent: {}, budget: {}, children: [],
    };
    add(cur.spent, "usd", num(s.attrs["agent.cost_usd"]));
    add(cur.spent, "turns", num(s.attrs["agent.turns"]));
    add(cur.spent, "wallSeconds", s.durationMs / 1000);
    if (s.attrs["agent.max_budget_usd"] !== undefined) cur.budget.usd = num(s.attrs["agent.max_budget_usd"]);
    if (s.attrs["agent.max_turns"] !== undefined) cur.budget.turns = num(s.attrs["agent.max_turns"]);
    if (s.status === "error") cur.status = "failed";
    by.set(id, cur);
  }
  return [...by.values()];
}

const num = (x: unknown) => (typeof x === "number" ? x : Number(x) || 0);
function add(s: Spend, k: string, v: number) { s[k] = Math.round(((s[k] ?? 0) + v) * 1e6) / 1e6; }

export function flattenAgents(nodes: AgentNode[]): AgentNode[] {
  const out: AgentNode[] = [];
  const walk = (n: AgentNode) => { out.push(n); n.children.forEach(walk); };
  nodes.forEach(walk);
  return out;
}
