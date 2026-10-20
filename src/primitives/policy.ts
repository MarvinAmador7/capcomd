// ADR-016 step 1: pure spawn policy. Children limits are narrowed down the tree and the
// budget is carved from the parent. Kept free of I/O so it can be unit-tested and so the
// scope actor applies the same rules inside its spawn transaction.
import { createHash } from "crypto";
import { widenings, type AgentSpec, type ChildrenSpec } from "../agents/profiles";

export const TERMINAL_AGENT = new Set(["done", "failed", "cancelled"]);
export type AgentStatus = "pending" | "running" | "done" | "failed" | "cancelled";

/** Effective children limits held by one agent instance (already narrowed by its ancestors). */
export interface Limits {
  allowSpawn: boolean;
  maxDepth: number;            // further levels allowed below this agent (0 = none)
  maxChildren?: number;        // concurrent, direct
  maxTotalDescendants?: number;
  allowedChildProfiles: string[];
  budgetShare: number;         // of remaining budget per child
}

/** Budget units. A unit a parent doesn't set is unlimited for its children. */
export const UNITS = ["usd", "turns", "wallSeconds"] as const;
export type Unit = (typeof UNITS)[number];
export type Budget = Partial<Record<Unit, number>>;

export function parseBudget(raw: unknown): Budget {
  if (raw === undefined || raw === null || raw === "") return {};
  if (typeof raw === "number") return { usd: raw };
  if (typeof raw === "object") {
    const b: Budget = {};
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (!(UNITS as readonly string[]).includes(k)) throw new Error(`unknown budget unit "${k}" (expected ${UNITS.join(", ")})`);
      const n = Number(v);
      if (!Number.isFinite(n) || n <= 0) throw new Error(`budget ${k} must be a positive number`);
      b[k as Unit] = n;
    }
    return b;
  }
  const str = String(raw).trim();
  if (/^[0-9.]+$/.test(str)) return parseBudget(Number(str));
  return parseBudget(Object.fromEntries(str.split(",").map((kv) => { const [k, v] = kv.split("="); return [k!.trim(), v]; })));
}

export interface AgentRow {
  agentId: string;
  parent: string | null;
  depth: number;
  profile: string | null;
  spec: AgentSpec | null;
  limits: Limits;
  status: AgentStatus;
  budget: Budget;
  spent: Budget;
}

const minDef = (a: number | undefined, b: number | undefined) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** Limits for a root agent (spawned by the operator): its profile's children block as-is. */
export function rootLimits(c: ChildrenSpec | undefined): Limits {
  const allow = !!c?.allowSpawn;
  return {
    allowSpawn: allow,
    maxDepth: allow ? (c?.maxDepth ?? 1) : 0,
    maxChildren: c?.maxChildren,
    maxTotalDescendants: c?.maxTotalDescendants,
    allowedChildProfiles: [...(c?.allowedChildProfiles ?? [])],
    budgetShare: c?.budgetShare ?? 1,
  };
}

/** Child limits: the child's own policy, narrowed by every limit the parent passes down. */
export function childLimits(parent: Limits, own: ChildrenSpec | undefined): Limits {
  const o = rootLimits(own);
  const depth = Math.min(o.maxDepth, Math.max(0, parent.maxDepth - 1));
  const allowed = o.allowedChildProfiles.filter((p) => parent.allowedChildProfiles.includes(p));
  return {
    allowSpawn: o.allowSpawn && depth > 0 && allowed.length > 0,
    maxDepth: depth,
    maxChildren: minDef(o.maxChildren, parent.maxChildren),
    maxTotalDescendants: minDef(o.maxTotalDescendants, parent.maxTotalDescendants === undefined ? undefined : parent.maxTotalDescendants - 1),
    allowedChildProfiles: allowed,
    budgetShare: Math.min(o.budgetShare, 1),
  };
}

/** Per unit, what a parent still controls: its allocation − its own spend − what children hold
 *  (a live child holds its allocation; a finished one only what it spent). Units the parent
 *  doesn't limit are absent (unlimited). */
export function available(budget: Budget, spent: Budget, children: Array<Pick<AgentRow, "status" | "budget" | "spent">>): Budget {
  const out: Budget = {};
  for (const u of UNITS) {
    if (budget[u] === undefined) continue;
    const held = children.reduce((a, c) => a + ((TERMINAL_AGENT.has(c.status) ? c.spent[u] : c.budget[u] ?? c.spent[u]) ?? 0), 0);
    out[u] = Math.max(0, round(budget[u]! - (spent[u] ?? 0) - held));
  }
  return out;
}
const round = (x: number) => Math.round(x * 1e6) / 1e6;

export interface SpawnCheck {
  /** null = spawned by the operator (top level of the run). */
  parent: AgentRow | null;
  /** Ancestors of the new agent, nearest first (parent, grandparent, …). */
  ancestors: AgentRow[];
  /** Number of descendants each ancestor already has (same order as ancestors). */
  descendantCounts: number[];
  /** Direct children of the parent (or the run's top-level agents). */
  siblings: AgentRow[];
  childProfile: string | null;
  childSpec: AgentSpec | null;
  requested?: Budget;
  /** Run budget, used when the parent is the operator. */
  runBudget: Budget;
  /** Bypass narrow-only spec checks (not limits or budget). */
  operator?: boolean;
}

export type SpawnDecision =
  | { ok: true; budget: Budget; limits: Limits; depth: number }
  | { ok: false; code: "children_limit" | "budget" | "widening" | "parent_terminal"; error: string };

export function checkSpawn(x: SpawnCheck): SpawnDecision {
  const own = x.childSpec?.children;
  if (!x.parent) {
    const avail = available(x.runBudget, {}, x.siblings);
    return carve(avail, 1, x.requested, () => ({ limits: rootLimits(own), depth: 0 }), "run");
  }
  const p = x.parent;
  if (TERMINAL_AGENT.has(p.status)) return { ok: false, code: "parent_terminal", error: `parent ${p.agentId} is ${p.status}` };
  const L = p.limits;
  if (!L.allowSpawn) return { ok: false, code: "children_limit", error: `${p.agentId} (profile ${p.profile ?? "-"}) has children.allowSpawn=false` };
  if (L.maxDepth < 1) return { ok: false, code: "children_limit", error: `children.maxDepth reached at ${p.agentId} (depth ${p.depth})` };
  if (!x.childProfile || !L.allowedChildProfiles.includes(x.childProfile))
    return { ok: false, code: "children_limit", error: `profile ${x.childProfile ?? "(none)"} is not in ${p.agentId}'s children.allowedChildProfiles [${L.allowedChildProfiles.join(", ")}]` };
  const active = x.siblings.filter((s) => !TERMINAL_AGENT.has(s.status)).length;
  if (L.maxChildren !== undefined && active >= L.maxChildren)
    return { ok: false, code: "children_limit", error: `children.maxChildren=${L.maxChildren} reached at ${p.agentId} (${active} active)` };
  for (let i = 0; i < x.ancestors.length; i++) {
    const a = x.ancestors[i]!;
    const max = a.limits.maxTotalDescendants;
    if (max !== undefined && (x.descendantCounts[i] ?? 0) + 1 > max)
      return { ok: false, code: "children_limit", error: `children.maxTotalDescendants=${max} reached at ${a.agentId}` };
  }
  if (!x.operator && p.spec && x.childSpec) {
    const w = widenings(p.spec, x.childSpec).filter((s) => !s.startsWith("provider ") && !s.startsWith("auth "));
    if (w.length) return { ok: false, code: "widening", error: `child spec widens parent ${p.agentId}: ${w.join("; ")} (pass --operator to allow)` };
  }
  const avail = available(p.budget, p.spent, x.siblings);
  return carve(avail, L.budgetShare, x.requested, () => ({ limits: childLimits(L, own), depth: p.depth + 1 }), p.agentId);
}

const fmt = (u: Unit, n: number) => (u === "usd" ? `$${n}` : `${n} ${u}`);
function carve(avail: Budget, share: number, requested: Budget | undefined, rest: () => { limits: Limits; depth: number }, from: string): SpawnDecision {
  const budget: Budget = {};
  for (const u of UNITS) {
    const req = requested?.[u];
    if (avail[u] === undefined) { if (req !== undefined) budget[u] = req; continue; }
    const cap = u === "turns" ? Math.floor(avail[u]! * share) : round(avail[u]! * share);
    if (req !== undefined && req > cap)
      return { ok: false, code: "budget", error: `requested ${fmt(u, req)} exceeds ${fmt(u, cap)} available from ${from} (remaining ${fmt(u, avail[u]!)} × budgetShare ${share})` };
    budget[u] = req ?? cap;
    if (budget[u]! <= 0) return { ok: false, code: "budget", error: `no ${u} budget left in ${from}` };
  }
  return { ok: true, budget, ...rest() };
}

/** Effective agent limits from a carved budget: the profile's own limits, narrowed. */
export function budgetCaps(spec: { maxTurns?: number; timeoutMs?: number; maxBudgetUsd?: number } | null, b: Budget): Record<string, number> {
  const out: Record<string, number> = {};
  const min = (a: number | undefined, c: number | undefined) => (a === undefined ? c : c === undefined ? a : Math.min(a, c));
  const t = min(spec?.maxTurns, b.turns); if (t !== undefined && t !== spec?.maxTurns) out.maxTurns = Math.max(1, Math.floor(t));
  const w = min(spec?.timeoutMs, b.wallSeconds === undefined ? undefined : b.wallSeconds * 1000); if (w !== undefined && w !== spec?.timeoutMs) out.timeoutMs = Math.max(1000, Math.floor(w));
  const d = min(spec?.maxBudgetUsd, b.usd); if (d !== undefined && d !== spec?.maxBudgetUsd) out.maxBudgetUsd = d;
  return out;
}

/** Stable IDs: a caller key always maps to the same ID; without a key the ID is random. */
export function stableId(prefix: "run" | "agt" | "vfy" | "mrg", scope: string, key?: string): string {
  if (!key) return `${prefix}-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${prefix}-k${createHash("sha256").update(`${scope}\0${key}`).digest("hex").slice(0, 16)}`;
}

/** Hash of the parameters that define a spawn; the same key with different params is a conflict. */
export function paramsHash(v: unknown): string {
  const canon = (x: any): any => (Array.isArray(x) ? x.map(canon) : x && typeof x === "object" ? Object.fromEntries(Object.keys(x).sort().filter((k) => x[k] !== undefined).map((k) => [k, canon(x[k])])) : x);
  return createHash("sha256").update(JSON.stringify(canon(v))).digest("hex").slice(0, 16);
}
