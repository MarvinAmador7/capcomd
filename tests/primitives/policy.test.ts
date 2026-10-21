import { expect, test } from "bun:test";
import { available, checkSpawn, childLimits, paramsHash, rootLimits, stableId, type AgentRow } from "../../src/primitives/policy";
import type { AgentSpec } from "../../src/agents/profiles";

const sup: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, maxTotalDescendants: 3, allowedChildProfiles: ["coder", "sup"], budgetShare: 0.5 } } as AgentSpec;
const coder: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 20 } as AgentSpec;
const row = (id: string, spec: AgentSpec, o: Partial<AgentRow> = {}): AgentRow => ({ agentId: id, parent: null, depth: 0, profile: id.split("-")[0]!, spec, limits: rootLimits(spec.children), status: "running", budget: { usd: 4 }, spent: {}, ...o });
const base = { ancestors: [] as AgentRow[], descendantCounts: [] as number[], siblings: [] as AgentRow[], runBudget: { usd: 10 } };

test("operator spawn carves from the run budget; explicit budget above it is rejected", () => {
  const d = checkSpawn({ ...base, parent: null, childProfile: "sup", childSpec: sup });
  expect(d).toMatchObject({ ok: true, budget: { usd: 10 }, depth: 0 });
  const held = [row("sup-a", sup, { budget: { usd: 7 } })];
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: coder, requested: { usd: 4 } })).toMatchObject({ ok: false, code: "budget" });
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budget: { usd: 3 } });
  // a finished sibling only holds what it spent
  expect(available({ usd: 10 }, {}, [{ status: "done", budget: { usd: 7 }, spent: { usd: 1 } }])).toEqual({ usd: 9 });
});

test("children limits: allowSpawn, allowedChildProfiles, maxChildren, maxTotalDescendants, depth", () => {
  const leaf = row("coder-a", coder);
  expect(checkSpawn({ ...base, parent: leaf, ancestors: [leaf], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: false, code: "children_limit" });
  const p = row("sup-a", sup);
  const at = (siblings: AgentRow[] = [], desc = 0, profile = "coder", spec = coder) => checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [desc], siblings, childProfile: profile, childSpec: spec });
  expect(at([], 0, "critic")).toMatchObject({ ok: false, code: "children_limit" });
  const ok = at();
  expect(ok).toMatchObject({ ok: true, budget: { usd: 2 }, depth: 1 }); // 4 × budgetShare 0.5
  expect(at([row("coder-b", coder, { parent: "sup-a", budget: { usd: 1 } }), row("coder-c", coder, { parent: "sup-a", budget: { usd: 1 } })])).toMatchObject({ ok: false, error: expect.stringContaining("maxChildren=2") });
  expect(at([row("coder-b", coder, { status: "done", parent: "sup-a", budget: { usd: 1 }, spent: { usd: 1 } })], 3)).toMatchObject({ ok: false, error: expect.stringContaining("maxTotalDescendants=3") });
  // nested supervisor gets narrowed limits: depth 2→1, descendants 3→2, allowed ∩
  const child = childLimits(p.limits, sup.children);
  expect(child).toMatchObject({ allowSpawn: true, maxDepth: 1, maxTotalDescendants: 2, maxChildren: 2 });
  const grand = childLimits(child, sup.children);
  expect(grand).toMatchObject({ allowSpawn: false, maxDepth: 0 });
  const mid = row("sup-b", sup, { depth: 1, parent: "sup-a", limits: child });
  expect(checkSpawn({ ...base, parent: mid, ancestors: [mid, p], descendantCounts: [0, 3], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: false, error: expect.stringContaining("maxTotalDescendants=3 reached at sup-a") });
  const g = row("sup-c", sup, { depth: 2, limits: grand });
  expect(checkSpawn({ ...base, parent: g, ancestors: [g], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: false, code: "children_limit" });
});

test("child spec may only narrow the parent unless operator; terminal parent can't spawn", () => {
  const p = row("sup-a", sup);
  const wide = { ...coder, maxTurns: 99 } as AgentSpec;
  const x = { ...base, parent: p, ancestors: [p], descendantCounts: [0], childProfile: "coder", childSpec: wide };
  expect(checkSpawn(x)).toMatchObject({ ok: false, code: "widening" });
  expect(checkSpawn({ ...x, operator: true })).toMatchObject({ ok: true });
  expect(checkSpawn({ ...x, parent: { ...p, status: "cancelled" } })).toMatchObject({ ok: false, code: "parent_terminal" });
});

test("stable ids and params hash", () => {
  expect(stableId("agt", "run-1\0operator", "k1")).toBe(stableId("agt", "run-1\0operator", "k1"));
  expect(stableId("agt", "run-1\0operator", "k1")).not.toBe(stableId("agt", "run-2\0operator", "k1"));
  expect(stableId("agt", "r", "k")).toMatch(/^agt-k[0-9a-f]{16}$/);
  expect(stableId("run", "run")).not.toBe(stableId("run", "run"));
  expect(paramsHash({ a: 1, b: [1, { c: 2 }] })).toBe(paramsHash({ b: [1, { c: 2 }], a: 1, z: undefined }));
});

import { budgetCaps, parseBudget } from "../../src/primitives/policy";
test("multi-unit budgets: per-unit carve/refund, unlimited units, caps narrow the profile", () => {
  expect(parseBudget("5")).toEqual({ usd: 5 });
  expect(parseBudget("usd=2,turns=100,wallSeconds=600")).toEqual({ usd: 2, turns: 100, wallSeconds: 600 });
  expect(() => parseBudget("tokens=5")).toThrow(/unknown budget unit/);
  const run = { usd: 10, turns: 100, wallSeconds: 3600 };
  const sib = [row("coder-a", coder, { budget: { usd: 5, turns: 60, wallSeconds: 600 } }), row("coder-b", coder, { status: "done", budget: { usd: 3, turns: 30, wallSeconds: 600 }, spent: { usd: 0, turns: 12, wallSeconds: 90 } })];
  expect(available(run, {}, sib)).toEqual({ usd: 5, turns: 28, wallSeconds: 2910 });
  const d = checkSpawn({ ...base, runBudget: run, parent: null, siblings: sib, childProfile: "coder", childSpec: coder, requested: { turns: 20 } });
  expect(d).toMatchObject({ ok: true, budget: { usd: 5, turns: 20, wallSeconds: 2910 } });
  expect(checkSpawn({ ...base, runBudget: run, parent: null, siblings: sib, childProfile: "coder", childSpec: coder, requested: { turns: 29 } })).toMatchObject({ ok: false, code: "budget", error: expect.stringContaining("29 turns exceeds 28 turns") });
  // a unit the run doesn't limit stays unlimited unless requested
  expect(checkSpawn({ ...base, runBudget: { turns: 50 }, parent: null, childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budget: { turns: 50 } });
  // subscription parent: turns × share, floored
  const p = row("sup-a", sup, { budget: { turns: 41 }, spent: { turns: 0 } });
  expect(checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budget: { turns: 20 } });
  expect(budgetCaps({ maxTurns: 20, timeoutMs: 600_000 }, { turns: 12, wallSeconds: 900, usd: 1 })).toEqual({ maxTurns: 12, maxBudgetUsd: 1 });
  expect(budgetCaps({ maxTurns: 5 }, { turns: 12 })).toEqual({});
});

// ADR-017: the parent sets the child's fan-out at spawn time; it may only narrow the ceiling.
import { applyGrant, parseGrant } from "../../src/primitives/policy";
test("grants: parent narrows child fan-out; above the ceiling is refused, not clamped", () => {
  const ceiling = { allowSpawn: true, maxDepth: 2, maxChildren: 4, maxTotalDescendants: 8, allowedChildProfiles: ["coder", "sup"], budgetShare: 0.5 };
  const g = applyGrant(ceiling, parseGrant({ maxChildren: "2", maxDepth: 1, allowedChildProfiles: "coder" }));
  expect(g).toMatchObject({ ok: true, limits: { maxChildren: 2, maxDepth: 1, allowedChildProfiles: ["coder"], maxTotalDescendants: 8 } });
  expect(applyGrant(ceiling, { maxChildren: 5 })).toMatchObject({ ok: false, error: expect.stringContaining("children.maxChildren=5 exceeds the ceiling 4") });
  expect(applyGrant(ceiling, { maxDepth: 3 })).toMatchObject({ ok: false });
  expect(applyGrant(ceiling, { allowedChildProfiles: ["admin"] })).toMatchObject({ ok: false, error: expect.stringContaining("admin") });
  expect(applyGrant(ceiling, { budgetShare: 0.9 })).toMatchObject({ ok: false });
  const none = { ...ceiling, allowSpawn: false, maxDepth: 0, allowedChildProfiles: [] };
  expect(applyGrant(none, { allowSpawn: true })).toMatchObject({ ok: false });
  expect(applyGrant(none, { maxChildren: 1 })).toMatchObject({ ok: false });
  expect(applyGrant(none, { maxChildren: 0 })).toMatchObject({ ok: true });
  expect(applyGrant(ceiling, { maxChildren: 0 })).toMatchObject({ ok: true, limits: { allowSpawn: false, maxDepth: 0 } });
  expect(() => parseGrant({ maxKids: 1 })).toThrow(/unknown children grant/);
});

test("maxChildren saturation is backpressure (retryable), not a hard refusal", () => {
  const r = checkSpawn({
    parent: row("sup-a", sup, { budget: { usd: 4 } }), ancestors: [row("sup-a", sup, { budget: { usd: 4 } })], descendantCounts: [2],
    siblings: [row("c1", coder, { parent: "sup-a", budget: { usd: 1 } }), row("c2", coder, { parent: "sup-a", budget: { usd: 1 } })],
    childProfile: "coder", childSpec: coder, runBudget: {},
  });
  expect(r).toMatchObject({ ok: false, code: "backpressure", retryable: true });
});

test("verify's reviewer: exempt from the caller's fan-out, paid from its budget (clamped), never spawns", () => {
  const leaf = row("coder-1", coder, { limits: rootLimits(undefined), budget: { usd: 2, turns: 20 }, spent: { turns: 4 } });
  const reviewer = { provider: "claude", auth: "subscription", maxTurns: 8 } as AgentSpec;
  // A normal child of a leaf (allowSpawn=false) is refused; the reviewer is not.
  expect(checkSpawn({ ...base, parent: leaf, ancestors: [leaf], descendantCounts: [0], childProfile: "reviewer", childSpec: reviewer })).toMatchObject({ ok: false, code: "children_limit" });
  const d = checkSpawn({ ...base, parent: leaf, ancestors: [leaf], descendantCounts: [0], childProfile: "reviewer", childSpec: reviewer, review: true, requested: { turns: 50 } });
  expect(d).toMatchObject({ ok: true, depth: 1, budget: { turns: 16 }, limits: { allowSpawn: false, maxChildren: 0, allowedChildProfiles: [] } }); // 20 - 4 left, request clamped
  // Operator verify: top level, paid by the run; a finished caller can't pay.
  expect(checkSpawn({ ...base, parent: null, childProfile: "reviewer", childSpec: reviewer, review: true, requested: { usd: 1 } })).toMatchObject({ ok: true, depth: 0, budget: { usd: 1 } });
  expect(checkSpawn({ ...base, parent: { ...leaf, status: "done" }, ancestors: [leaf], descendantCounts: [0], childProfile: "reviewer", childSpec: reviewer, review: true })).toMatchObject({ ok: false, code: "parent_terminal" });
});
