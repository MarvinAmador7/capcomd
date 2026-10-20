import type { AgentNode, Spend, Trace } from "./types";

/** `capcomd tree <runId> --json` → nodes. Accepts the full envelope or a bare node array. */
export function parseTree(text: string): AgentNode[] {
  let v: any;
  try { v = JSON.parse(text); } catch { return []; }
  const nodes = Array.isArray(v) ? v : Array.isArray(v?.tree) ? v.tree : [];
  return nodes.map((n: any) => node(n, 0));
}

const ms = (x: unknown): number | null => (typeof x === "number" ? x : typeof x === "string" && !Number.isNaN(Date.parse(x)) ? Date.parse(x) : null);

/** Accepts the `tree --json` envelope, an inspect snapshot/tree line, or a bare node array. */
export function nodesFrom(v: any): AgentNode[] {
  const nodes = Array.isArray(v) ? v : Array.isArray(v?.tree) ? v.tree : [];
  return nodes.map((n: any) => node(n, 0));
}

function node(n: any, depth: number): AgentNode {
  return {
    agentId: String(n.agentId), profile: n.profile ?? null, status: String(n.status ?? "unknown"),
    depth: typeof n.depth === "number" ? n.depth : depth, spent: n.spent ?? {}, budget: n.budget ?? {},
    rollup: n.rollup, stuck: n.stuck, parent: n.parent ?? null, taskId: n.taskId, spanId: n.spanId,
    startedAt: ms(n.startedAt) ?? undefined, endedAt: n.endedAt === null ? null : ms(n.endedAt) ?? undefined,
    children: (n.children ?? []).map((c: any) => node(c, depth + 1)),
  };
}

/**
 * No tree available: infer agents from spans. Since the output contract, every scope agent has
 * exactly one `agent.run` span carrying its own cost/turns, and the CLI span under it
 * (agent.claude_code / agent.codex) carries the same numbers again. So: sum agent.run spans when
 * any exist (nested by relay.parent_agent_id); only for older traces without them, sum the CLI
 * spans per task.
 */
export function agentsFromTrace(trace: Trace | null): AgentNode[] {
  if (!trace) return [];
  const runs = trace.spans.filter((s) => s.name === "agent.run");
  return runs.length ? fromAgentRuns(trace, runs) : fromCliSpans(trace);
}

function fromAgentRuns(trace: Trace, runs: Trace["spans"]): AgentNode[] {
  const by = new Map<string, AgentNode>();
  for (const s of runs) {
    const id = String(s.attrs["relay.agent_id"] ?? s.attrs["agent.id"] ?? s.id);
    const cur = by.get(id) ?? {
      agentId: id, profile: (s.attrs["agent.profile"] as string) ?? null, status: String(s.attrs["agent.status"] ?? (s.status === "error" ? "failed" : "done")),
      depth: 0, spent: {}, budget: {}, children: [], parent: (s.attrs["relay.parent_agent_id"] ?? s.attrs["agent.parent"] ?? null) as string | null,
      spanId: s.id, startedAt: s.start, endedAt: s.end,
    };
    add(cur.spent, "usd", num(s.attrs["agent.cost_usd"]));
    add(cur.spent, "turns", num(s.attrs["agent.turns"]));
    add(cur.spent, "wallSeconds", s.durationMs / 1000);
    by.set(id, cur);
  }
  attachErrorKinds(trace, by);
  return nest([...by.values()]);
}

function fromCliSpans(trace: Trace): AgentNode[] {
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
    if (s.attrs["agent.error_kind"]) cur.errorKind = String(s.attrs["agent.error_kind"]);
    by.set(id, cur);
  }
  return [...by.values()];
}

/** The latest agent.error_kind on any of an agent's spans. */
export function attachErrorKinds(trace: Trace | null, by: Map<string, AgentNode>) {
  for (const s of trace?.spans ?? []) {
    const k = s.attrs["agent.error_kind"];
    const id = s.attrs["relay.agent_id"] as string | undefined;
    if (k && id && by.has(id)) by.get(id)!.errorKind = String(k);
  }
}

function nest(flat: AgentNode[]): AgentNode[] {
  const ids = new Set(flat.map((a) => a.agentId));
  const roots: AgentNode[] = [];
  for (const a of flat) {
    const p = a.parent && ids.has(a.parent) ? flat.find((x) => x.agentId === a.parent)! : null;
    (p ? p.children : roots).push(a);
  }
  const depth = (n: AgentNode, d: number) => { n.depth = d; n.children.sort((x, y) => (x.startedAt ?? 0) - (y.startedAt ?? 0)); n.children.forEach((c) => depth(c, d + 1)); };
  roots.forEach((r) => depth(r, 0));
  return roots;
}

const num = (x: unknown) => (typeof x === "number" ? x : Number(x) || 0);
function add(s: Spend, k: string, v: number) { s[k] = Math.round(((s[k] ?? 0) + v) * 1e6) / 1e6; }

export function flattenAgents(nodes: AgentNode[]): AgentNode[] {
  const out: AgentNode[] = [];
  const walk = (n: AgentNode) => { out.push(n); n.children.forEach(walk); };
  nodes.forEach(walk);
  return out;
}
