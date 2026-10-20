import { expect, test } from "bun:test";
import { available, checkSpawn, childLimits, paramsHash, rootLimits, stableId, type AgentRow } from "../../src/primitives/policy";
import type { AgentSpec } from "../../src/agents/profiles";

const sup: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, maxTotalDescendants: 3, allowedChildProfiles: ["coder", "sup"], budgetShare: 0.5 } } as AgentSpec;
const coder: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 20 } as AgentSpec;
const row = (id: string, spec: AgentSpec, o: Partial<AgentRow> = {}): AgentRow => ({ agentId: id, parent: null, depth: 0, profile: id.split("-")[0]!, spec, limits: rootLimits(spec.children), status: "running", budgetUsd: 4, spentUsd: 0, ...o });
const base = { ancestors: [] as AgentRow[], descendantCounts: [] as number[], siblings: [] as AgentRow[], runBudgetUsd: 10 };

test("operator spawn carves from the run budget; explicit budget above it is rejected", () => {
  const d = checkSpawn({ ...base, parent: null, childProfile: "sup", childSpec: sup });
  expect(d).toMatchObject({ ok: true, budgetUsd: 10, depth: 0 });
  const held = [row("sup-a", sup, { budgetUsd: 7 })];
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: coder, requestedBudgetUsd: 4 })).toMatchObject({ ok: false, code: "budget" });
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budgetUsd: 3 });
  // a finished sibling only holds what it spent
  expect(available(10, 0, [{ status: "done", budgetUsd: 7, spentUsd: 1 }])).toBe(9);
});

test("children limits: allowSpawn, allowedChildProfiles, maxChildren, maxTotalDescendants, depth", () => {
  const leaf = row("coder-a", coder);
  expect(checkSpawn({ ...base, parent: leaf, ancestors: [leaf], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: false, code: "children_limit" });
  const p = row("sup-a", sup);
  const at = (siblings: AgentRow[] = [], desc = 0, profile = "coder", spec = coder) => checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [desc], siblings, childProfile: profile, childSpec: spec });
  expect(at([], 0, "critic")).toMatchObject({ ok: false, code: "children_limit" });
  const ok = at();
  expect(ok).toMatchObject({ ok: true, budgetUsd: 2, depth: 1 }); // 4 × budgetShare 0.5
  expect(at([row("coder-b", coder, { parent: "sup-a", budgetUsd: 1 }), row("coder-c", coder, { parent: "sup-a", budgetUsd: 1 })])).toMatchObject({ ok: false, error: expect.stringContaining("maxChildren=2") });
  expect(at([row("coder-b", coder, { status: "done", parent: "sup-a", budgetUsd: 1, spentUsd: 1 })], 3)).toMatchObject({ ok: false, error: expect.stringContaining("maxTotalDescendants=3") });
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
