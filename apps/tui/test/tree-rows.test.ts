import { describe, expect, test } from "bun:test";
import type { AgentNode, RunEvent } from "../src/adapters/types";
import { labelOf, pipelines, treeRows } from "../src/views/tree-rows";

const node = (agentId: string, o: Partial<AgentNode> = {}): AgentNode => ({ agentId, profile: "worker", status: "done", depth: 1, spent: {}, budget: {}, children: [], ...o });
const ev = (at: number, type: string, agentId: string | null, data: Record<string, unknown> = {}): RunEvent => ({ at, type, agentId, entity: "scope", data });

// The 2026-10-21 live run: three workers in parallel, then verify (with a review) and merge one at a time.
const T = 1_000_000;
const add = node("agt-add", { key: "add", startedAt: T + 5_000, endedAt: T + 27_000 });
const mul = node("agt-mul", { key: "mul", startedAt: T + 7_000, endedAt: T + 27_000 });
const shout = node("agt-shout", { key: "shout", profile: "codex-worker", startedAt: T + 9_000, endedAt: T + 36_000 });
const rv = (of: string, at: number) => node(`agt-rv-${of}`, { key: `review-vfy-${of}`, profile: "reviewer", reviewOf: `agt-${of}`, startedAt: at, endedAt: at + 16_000 });
const planner = node("agt-planner", { key: "planner", profile: "planner", depth: 0, startedAt: T, endedAt: T + 181_000, children: [add, mul, shout, rv("add", T + 62_000), rv("mul", T + 85_000), rv("shout", T + 109_000)] });
const verified = (at: number, id: string, agt: string) => [ev(at, "VERIFY_STARTED", agt, { id }), ev(at + 18_000, "VERIFY_PASSED", agt, { id, checks: { passed: true }, review: { passed: true, reasons: [`${agt} looks right`] } })];
const merged = (at: number, id: string, agt: string) => [ev(at, "MERGE_STARTED", agt, { id }), ev(at + 12_000, "MERGED", agt, { id })];
const events = [...verified(T + 57_000, "vfy-a", "agt-add"), ...verified(T + 80_000, "vfy-m", "agt-mul"), ...verified(T + 104_000, "vfy-s", "agt-shout"),
  ...merged(T + 129_000, "mrg-a", "agt-add"), ...merged(T + 146_000, "mrg-m", "agt-mul"), ...merged(T + 161_000, "mrg-s", "agt-shout")];

const draw = (rows: ReturnType<typeof treeRows>) => rows.map((r) => r.kind === "agent" ? `${r.prefix}${r.label}` : r.kind === "group" ? `${r.prefix}parallel ×${r.count}` : `${r.prefix}${r.text}`);

describe("Live tree rows", () => {
  test("tree edges, a parallel group, reviewers under what they reviewed, the sequential ops phase", () => {
    expect(draw(treeRows([planner], events, T + 200_000))).toEqual([
      "planner",
      "├─┬ parallel ×3",
      "│ ├── add",
      "│ │   └── review",
      "│ ├── mul",
      "│ │   └── review",
      "│ └── shout",
      "│     └── review",
      "└─ sequential: verify → review → merge",
    ]);
  });

  test("each agent's pipeline and each reviewer's verdict come from the events", () => {
    const rows = treeRows([planner], events, T + 200_000).filter((r) => r.kind === "agent") as any[];
    expect(rows.find((r) => r.label === "add").pipeline).toEqual({ checks: true, review: true, merged: "merged" });
    expect(rows.find((r) => r.agent.agentId === "agt-rv-add").verdict).toBe("passed: agt-add looks right");
    expect(rows.find((r) => r.label === "planner").pipeline).toBeNull();
  });

  test("siblings that didn't overlap stay separate; an awaiting or denied merge shows as such", () => {
    const a = node("agt-a", { key: "a", startedAt: T, endedAt: T + 10 });
    const b = node("agt-b", { key: "b", startedAt: T + 20, endedAt: T + 30 });
    const root = node("agt-r", { key: "root", depth: 0, startedAt: T, endedAt: T + 40, children: [a, b] });
    expect(draw(treeRows([root], [], T + 50))).toEqual(["root", "├── a", "└── b"]);
    const p = pipelines([ev(T, "VERIFY_PASSED", "agt-a", { checks: { passed: true } }), ev(T + 1, "MERGE_AWAITING_APPROVAL", "agt-a", { id: "mrg-1" }), ev(T + 2, "MERGE_DENIED", "agt-b", { id: "mrg-2" })]);
    expect(p.get("agt-a")).toMatchObject({ checks: true, review: null, merged: "awaiting" });
    expect(p.get("agt-b")?.merged).toBe("denied");
  });

  test("labels: spawn key, 'review' for reviewers, else a short id (never an in-VM auto key)", () => {
    expect(labelOf(node("agt-x", { key: "add" }))).toBe("add");
    expect(labelOf(node("agt-x", { key: "review-vfy-1", reviewOf: "agt-y" }))).toBe("review");
    expect(labelOf(node("agt-k2585894d264a9c0a", { key: "r:req-17" }))).toBe("k2585894d2");
  });
});
