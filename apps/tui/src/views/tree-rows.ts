// The Live view's agent tree as rows to draw: real tree edges, concurrent siblings grouped under a
// "parallel ×N" bracket, each reviewer nested under the agent it reviewed, and each agent's pipeline
// (checks → review → merge) read from the event log. Pure, so the layout is testable without Ink.
import type { AgentNode, RunEvent } from "../adapters/types";

export type MergeState = "merged" | "awaiting" | "denied" | "failed";
export interface Pipeline { checks: boolean | null; review: boolean | null; merged: MergeState | null }

export type TreeRow =
  | { kind: "agent"; prefix: string; agent: AgentNode; label: string; pipeline: Pipeline | null; verdict: string | null }
  | { kind: "group"; prefix: string; count: number; window: [number, number] }
  | { kind: "note"; prefix: string; text: string; window: [number, number] };

interface Item { kind: "agent"; node: AgentNode }
type Entry = Item | { kind: "group"; nodes: AgentNode[]; window: [number, number] } | { kind: "note"; text: string; window: [number, number] };

/** "add" from the spawn key; reviewers read "review"; else a short id. */
export function labelOf(a: AgentNode): string {
  if (a.reviewOf) return "review";
  if (a.key && !a.key.startsWith("r:") && !a.key.startsWith("review-")) return a.key;
  return a.agentId.replace(/^agt-/, "").slice(0, 10);
}

/** Each agent's latest verify (checks, review) and merge outcome, from the events about it. */
export function pipelines(events: RunEvent[]): Map<string, Pipeline & { reasons: string[] }> {
  const out = new Map<string, Pipeline & { reasons: string[] }>();
  for (const e of events) {
    if (!e.agentId) continue;
    const p = out.get(e.agentId) ?? { checks: null, review: null, merged: null, reasons: [] };
    const d: any = e.data ?? {};
    if (e.type === "VERIFY_PASSED" || e.type === "VERIFY_FAILED") {
      p.checks = d.checks?.passed ?? (e.type === "VERIFY_PASSED");
      p.review = d.review ? d.review.passed === true : null;
      p.reasons = Array.isArray(d.review?.reasons) ? d.review.reasons.map(String) : d.review?.error ? [String(d.review.error)] : [];
    } else if (e.type === "MERGED") p.merged = "merged";
    else if (e.type === "MERGE_AWAITING_APPROVAL" && p.merged !== "merged") p.merged = "awaiting";
    else if (e.type === "MERGE_DENIED") p.merged = "denied";
    else if (e.type === "MERGE_FAILED" && p.merged !== "merged") p.merged = "failed";
    else continue;
    out.set(e.agentId, p);
  }
  return out;
}

const startOf = (a: AgentNode) => a.startedAt ?? Number.POSITIVE_INFINITY;
const endOf = (a: AgentNode, now: number) => a.endedAt ?? now;

/** Siblings in start order, overlapping ones grouped (a group of 2+ ran in parallel). */
function phases(kids: AgentNode[], now: number): Entry[] {
  const sorted = kids.slice().sort((x, y) => startOf(x) - startOf(y));
  const out: Entry[] = [];
  let cur: AgentNode[] = [];
  let curEnd = -Infinity;
  const flush = () => {
    if (cur.length >= 2) out.push({ kind: "group", nodes: cur, window: [Math.min(...cur.map(startOf)), curEnd] });
    else for (const n of cur) out.push({ kind: "agent", node: n });
    cur = [];
  };
  for (const k of sorted) {
    const s = startOf(k);
    if (cur.length && !(Number.isFinite(s) && s < curEnd)) { flush(); curEnd = -Infinity; }
    cur.push(k);
    curEnd = Math.max(curEnd, endOf(k, now));
  }
  flush();
  return out;
}

/** The verify/merge phase of a parent's children: when it ran, and whether those ops overlapped. */
function opsNote(childIds: Set<string>, events: RunEvent[], reviewed: boolean): Entry | null {
  const spans = new Map<string, [number, number]>();
  for (const e of events) {
    if (!e.agentId || !childIds.has(e.agentId)) continue;
    const id = String((e.data as any)?.id ?? "");
    if (!id) continue;
    if (e.type === "VERIFY_STARTED" || e.type === "MERGE_STARTED") spans.set(id, [e.at, e.at]);
    else if (/^(VERIFY_PASSED|VERIFY_FAILED|MERGED|MERGE_FAILED|MERGE_AWAITING_APPROVAL|MERGE_DENIED)$/.test(e.type) && spans.has(id)) spans.get(id)![1] = e.at;
  }
  if (!spans.size) return null;
  const list = [...spans.values()].sort((a, b) => a[0] - b[0]);
  const overlap = list.some((s, i) => i > 0 && s[0] < list[i - 1]![1]);
  const steps = reviewed ? "verify → review → merge" : "verify → merge";
  return { kind: "note", text: `${overlap ? "overlapping" : "sequential"}: ${steps}`, window: [list[0]![0], Math.max(...list.map((s) => s[1]))] };
}

/**
 * Rows for the agent tree. Reviewers move under the agent they reviewed (their tree parent is the caller
 * that paid for them); everything else keeps its place.
 */
export function treeRows(roots: AgentNode[], events: RunEvent[], now = Date.now()): TreeRow[] {
  const all: AgentNode[] = [];
  const walk = (n: AgentNode) => { all.push(n); n.children.forEach(walk); };
  roots.forEach(walk);
  const ids = new Set(all.map((a) => a.agentId));
  const reviewsOf = new Map<string, AgentNode[]>();
  for (const a of all) if (a.reviewOf && ids.has(a.reviewOf)) reviewsOf.set(a.reviewOf, [...(reviewsOf.get(a.reviewOf) ?? []), a]);
  const moved = new Set([...reviewsOf.values()].flat().map((a) => a.agentId));
  const pipe = pipelines(events);
  const rows: TreeRow[] = [];

  const agentRow = (n: AgentNode, prefix: string) => {
    const p = pipe.get(n.agentId);
    const reviewed = n.reviewOf ? pipe.get(n.reviewOf) : undefined;
    const verdict = n.reviewOf && reviewed && reviewed.review !== null
      ? reviewed.review ? `passed${reviewed.reasons[0] ? `: ${reviewed.reasons[0]}` : ""}` : `failed${reviewed.reasons[0] ? `: ${reviewed.reasons[0]}` : ""}`
      : null;
    rows.push({ kind: "agent", prefix, agent: n, label: labelOf(n), pipeline: p && (p.checks !== null || p.merged !== null) ? { checks: p.checks, review: p.review, merged: p.merged } : null, verdict });
  };

  // Draw `n`'s children (and its reviewers) below it; `cont` is the prefix for the lines under `n`.
  const children = (n: AgentNode, cont: string) => {
    const kids = n.children.filter((k) => !moved.has(k.agentId));
    const entries: Entry[] = [...phases(kids, now)];
    const note = opsNote(new Set(kids.map((k) => k.agentId)), events, kids.some((k) => reviewsOf.has(k.agentId)));
    if (note && kids.length > 1) entries.push(note);
    for (const r of reviewsOf.get(n.agentId) ?? []) entries.push({ kind: "agent", node: r });
    entries.forEach((e, i) => {
      const last = i === entries.length - 1;
      const branch = cont + (last ? "└─" : "├─");
      const below = cont + (last ? "  " : "│ ");
      if (e.kind === "agent") { agentRow(e.node, branch + "─ "); children(e.node, below + "  "); }
      else if (e.kind === "note") rows.push({ kind: "note", prefix: branch + " ", text: e.text, window: e.window });
      else {
        rows.push({ kind: "group", prefix: branch + "┬ ", count: e.nodes.length, window: e.window });
        e.nodes.forEach((m, j) => {
          const mLast = j === e.nodes.length - 1;
          agentRow(m, below + (mLast ? "└── " : "├── "));
          children(m, below + (mLast ? "    " : "│   "));
        });
      }
    });
  };

  for (const r of roots) { agentRow(r, ""); children(r, ""); }
  return rows;
}
