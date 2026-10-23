import { expect, test } from "bun:test";
import { available, checkSpawn, childLimits, paramsHash, rootLimits, stableId, type AgentRow } from "../../src/primitives/policy";
import type { AgentSpec } from "../../src/agents/profiles";

const sup: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 40, children: { allowSpawn: true, maxDepth: 2, maxChildren: 2, maxTotalDescendants: 3, allowedChildProfiles: ["coder", "sup"], budgetShare: 0.5 } } as AgentSpec;
const coder: AgentSpec = { provider: "claude", auth: "subscription", maxTurns: 20 } as AgentSpec;
/** Billed per token, no dollar cap of its own: a spawn that names no usd reserves none (ADR-019). */
const payg: AgentSpec = { provider: "claude", auth: "apikey", maxTurns: 20 } as AgentSpec;
const row = (id: string, spec: AgentSpec, o: Partial<AgentRow> = {}): AgentRow => ({ agentId: id, parent: null, depth: 0, profile: id.split("-")[0]!, spec, limits: rootLimits(spec.children), status: "running", budget: { usd: 4 }, spent: {}, ...o });
const base = { ancestors: [] as AgentRow[], descendantCounts: [] as number[], siblings: [] as AgentRow[], runBudget: { usd: 10 } };

test("operator spawn carves from the run budget; explicit budget above it is rejected", () => {
  // Nothing named, no profile cap: nothing reserved (its spend is metered live against the run's).
  const d = checkSpawn({ ...base, parent: null, childProfile: "sup", childSpec: sup });
  expect(d).toMatchObject({ ok: true, budget: {}, depth: 0 });
  expect((d as any).budget.usd).toBeUndefined();
  expect(checkSpawn({ ...base, parent: null, childProfile: "sup", childSpec: sup, requested: { usd: 10 } })).toMatchObject({ ok: true, budget: { usd: 10 } });
  const held = [row("sup-a", sup, { budget: { usd: 7 } })];
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: coder, requested: { usd: 4 } })).toMatchObject({ ok: false, code: "budget" });
  expect(checkSpawn({ ...base, parent: null, siblings: held, childProfile: "coder", childSpec: payg, requested: { usd: 3 } })).toMatchObject({ ok: true, budget: { usd: 3 } });
  // a finished sibling only holds what it spent
  expect(available({ usd: 10 }, {}, [{ status: "done", budget: { usd: 7 }, spent: { usd: 1 } }])).toEqual({ usd: 9 });
});

test("children limits: allowSpawn, allowedChildProfiles, maxChildren, maxTotalDescendants, depth", () => {
  const leaf = row("coder-a", coder);
  expect(checkSpawn({ ...base, parent: leaf, ancestors: [leaf], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: false, code: "children_limit" });
  const p = row("sup-a", sup);
  const at = (siblings: AgentRow[] = [], desc = 0, profile = "coder", spec = coder) => checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [desc], siblings, childProfile: profile, childSpec: spec });
  expect(at([], 0, "critic")).toMatchObject({ ok: false, code: "children_limit" });
  const ok = at([], 0, "coder", payg);
  expect(ok).toMatchObject({ ok: true, budget: {}, depth: 1 }); // no usd named and payg has no dollar cap: none reserved
  expect((ok as any).budget.usd).toBeUndefined();
  expect(checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [0], childProfile: "coder", childSpec: payg, requested: { usd: 2.5 } })).toMatchObject({ ok: false, code: "budget" }); // 4 × budgetShare 0.5
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

import { checkGrant, growRun, parseBudget } from "../../src/primitives/policy";
test("multi-unit budgets: per-unit carve/refund, unlimited units, caps narrow the profile", () => {
  expect(parseBudget("5")).toEqual({ usd: 5 });
  expect(parseBudget("usd=2,turns=100,wallSeconds=600")).toEqual({ usd: 2, turns: 100, wallSeconds: 600 });
  expect(() => parseBudget("tokens=5")).toThrow(/unknown budget unit/);
  const run = { usd: 10, turns: 100, wallSeconds: 3600 };
  const sib = [row("coder-a", coder, { budget: { usd: 5, turns: 60, wallSeconds: 600 } }), row("coder-b", coder, { status: "done", budget: { usd: 3, turns: 30, wallSeconds: 600 }, spent: { usd: 0, turns: 12, wallSeconds: 90 } })];
  expect(available(run, {}, sib)).toEqual({ usd: 5, turns: 28, wallSeconds: 2910 });
  const d = checkSpawn({ ...base, runBudget: run, parent: null, siblings: sib, childProfile: "coder", childSpec: coder, requested: { turns: 20 } });
  // usd and wallSeconds aren't named and coder caps neither: nothing reserved.
  expect(d).toMatchObject({ ok: true, budget: { turns: 20 } });
  expect((d as any).budget.usd).toBeUndefined();
  expect((d as any).budget.wallSeconds).toBeUndefined();
  expect(checkSpawn({ ...base, runBudget: run, parent: null, siblings: sib, childProfile: "coder", childSpec: coder, requested: { turns: 29 } })).toMatchObject({ ok: false, code: "budget", error: expect.stringContaining("29 turns exceeds 28 turns") });
  // a unit the run doesn't limit stays unlimited unless requested; an unnamed unit reserves the profile's cap (maxTurns 20)
  expect(checkSpawn({ ...base, runBudget: { turns: 50 }, parent: null, childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budget: { turns: 20 } });
  // subscription parent: turns × share, floored
  const p = row("sup-a", sup, { budget: { turns: 41 }, spent: { turns: 0 } });
  expect(checkSpawn({ ...base, parent: p, ancestors: [p], descendantCounts: [0], childProfile: "coder", childSpec: coder })).toMatchObject({ ok: true, budget: { turns: 20 } });
});

// ADR-019 §4: a grant gives a live agent more of a unit it has a budget in, from what its parent has left.
test("grant: more budget from the parent's remainder, only units it has, never above the profile's cap", () => {
  const g = (o: Partial<Parameters<typeof checkGrant>[0]>) => checkGrant({ agentId: "agt-c", budget: { usd: 1, turns: 10 }, used: {}, add: {}, avail: { usd: 2 }, from: "agt-p", caps: {}, ...o });
  expect(g({ add: { usd: 1.5 } })).toEqual({ ok: true, budget: { usd: 2.5, turns: 10 } });
  expect(g({ add: { usd: 3 } })).toMatchObject({ ok: false, error: "granting $3 needs $3, but agt-p has $2 left" });
  // already over its budget: it holds what it spent, so only the part above that is new
  expect(g({ used: { usd: 1.8 }, add: { usd: 2.5 } })).toMatchObject({ ok: true, budget: { usd: 3.5 } });
  // a unit the parent doesn't limit: nothing to carve from
  expect(g({ add: { turns: 100 } })).toMatchObject({ ok: true, budget: { turns: 110 } });
  expect(g({ add: { wallSeconds: 60 } })).toMatchObject({ ok: false, error: expect.stringContaining("has no wallSeconds budget of its own: its spend counts against agt-p's, so grant agt-p instead") });
  expect(g({ from: "run", add: { wallSeconds: 60 } })).toMatchObject({ ok: false, error: expect.stringContaining("against the run's, so grant the run instead") });
  expect(g({ caps: { usd: 1.5 }, add: { usd: 1 } })).toMatchObject({ ok: false, error: expect.stringContaining("profile caps it at $1.5 (maxBudgetUsd)") });
  expect(growRun({ usd: 5 }, { usd: 2.5 })).toEqual({ ok: true, budget: { usd: 7.5 } });
  expect(growRun({ usd: 5 }, { turns: 10 })).toMatchObject({ ok: false, error: "the run has no turns limit to raise" });
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

// Seen live (scripts/mac-plugin-e2e.sh): a driver spawned three workers with only `turns=20`; the first took every
// remaining usd and second, and the other two were refused. Unnamed units now reserve the profile's caps, else nothing.
import { profileDefaults } from "../../src/primitives/policy";
test("units a spawn doesn't name: the profile's caps, else nothing", () => {
  const run = { usd: 6, turns: 200, wallSeconds: 3600 };
  const worker = { provider: "claude", auth: "subscription", maxTurns: 25, timeoutMs: 900_000 } as AgentSpec;
  const rows: any[] = [];
  for (const n of ["add", "mul", "shout"]) {
    const d: any = checkSpawn({ ...base, runBudget: run, parent: null, siblings: rows, childProfile: "worker", childSpec: worker, requested: { turns: 20 } });
    expect(d).toMatchObject({ ok: true, budget: { turns: 20, wallSeconds: 900 } });
    expect(d.budget.usd).toBeUndefined();
    rows.push(row(n, worker, { budget: d.budget }));
  }
  expect(available(run, {}, rows)).toEqual({ usd: 6, turns: 140, wallSeconds: 900 });

  // An API-key profile with a dollar cap reserves that cap; without one it reserves nothing (spend is metered live).
  const capped = { provider: "claude", auth: "apikey", maxTurns: 25, maxBudgetUsd: 1.5 } as AgentSpec;
  expect(checkSpawn({ ...base, runBudget: run, parent: null, childProfile: "c", childSpec: capped, requested: { turns: 20 } })).toMatchObject({ ok: true, budget: { usd: 1.5 } });
  const open = { provider: "claude", auth: "apikey", maxTurns: 25 } as AgentSpec;
  expect((checkSpawn({ ...base, runBudget: run, parent: null, childProfile: "o", childSpec: open, requested: { turns: 20 } }) as any).budget).toEqual({ turns: 20 });
  // Nothing left of a unit: an agent that bills it is refused; a subscription worker (bills $0) isn't.
  const spentRun = [row("x", open, { status: "done", budget: {}, spent: { usd: 6 } })];
  expect(checkSpawn({ ...base, runBudget: run, parent: null, siblings: spentRun, childProfile: "o", childSpec: open, requested: { turns: 20 } })).toMatchObject({ ok: false, code: "budget", error: expect.stringContaining("no usd budget left") });
  expect(checkSpawn({ ...base, runBudget: run, parent: null, siblings: spentRun, childProfile: "worker", childSpec: worker, requested: { turns: 20 } })).toMatchObject({ ok: true });
  // A subscription agent that may spawn bills usd through its children.
  expect(profileDefaults(sup).none).toEqual([]);
  // What the spawn names always wins.
  expect(checkSpawn({ ...base, runBudget: run, parent: null, childProfile: "worker", childSpec: worker, requested: { turns: 20, usd: 1, wallSeconds: 300 } })).toMatchObject({ ok: true, budget: { usd: 1, turns: 20, wallSeconds: 300 } });
});

test("a profile that may spawn and sets no maxTotalDescendants gets the default (budgets are optional, the count isn't)", async () => {
  const { DEFAULT_MAX_DESCENDANTS } = await import("../../src/primitives/policy");
  expect(rootLimits({ allowSpawn: true, allowedChildProfiles: ["coder"] }).maxTotalDescendants).toBe(DEFAULT_MAX_DESCENDANTS);
  expect(rootLimits({ allowSpawn: true, maxTotalDescendants: 3 }).maxTotalDescendants).toBe(3);
  expect(rootLimits(undefined).maxTotalDescendants).toBeUndefined();
  expect(childLimits(rootLimits({ allowSpawn: true, maxDepth: 2, allowedChildProfiles: ["sup"] }), { allowSpawn: true, allowedChildProfiles: ["sup"] }).maxTotalDescendants).toBe(DEFAULT_MAX_DESCENDANTS - 1);
});

// ADR-019 step 1b: budgets are enforced from live spend, whatever a spawn reserved.
import { overBudget, treeSpend } from "../../src/primitives/policy";
test("live spend: subtree spend counts against every ancestor's budget and the run's", () => {
  const agents = [
    { agentId: "sup", parent: null, budget: { usd: 3 }, spent: { usd: 0.5 } },
    { agentId: "a", parent: "sup", budget: {}, spent: { usd: 1 } },
    { agentId: "b", parent: "sup", budget: { usd: 1 }, spent: { usd: 0.75 } },
    { agentId: "b1", parent: "b", budget: {}, spent: { usd: 0.2 } },
  ];
  expect(treeSpend(agents).get("sup")).toEqual({ usd: 2.45 });
  expect(treeSpend(agents).get("b")).toEqual({ usd: 0.95 });
  expect(overBudget("b1", agents, {})).toBeNull();
  // b1 pushes b's subtree over b's $1: stop, at b
  const more = agents.map((a) => (a.agentId === "b1" ? { ...a, spent: { usd: 0.3 } } : a));
  expect(overBudget("b1", more, {})).toMatchObject({ unit: "usd", at: "b", budget: 1 });
  // a reserved nothing; its spend counts against sup's $3
  const big = agents.map((a) => (a.agentId === "a" ? { ...a, spent: { usd: 1.6 } } : a));
  expect(overBudget("a", big, {})).toMatchObject({ unit: "usd", at: "sup" });
  // the run's cap counts everyone
  expect(overBudget("a", agents, { usd: 2 })).toMatchObject({ unit: "usd", at: "run", spent: 2.45 });
  // a live child that reserved nothing holds what its subtree spent; one that reserved holds the larger of the two
  const tree = treeSpend(agents);
  const kids = agents.filter((x) => x.parent === "sup").map((x) => ({ ...x, status: "running" as const, tree: tree.get(x.agentId) }));
  expect(available({ usd: 3 }, { usd: 0.5 }, kids)).toEqual({ usd: 0.5 }); // 3 − 0.5 − 1 (a) − 1 (b's reservation)
});
