// Chaos client for ADR-016 primitives. Idempotent end to end: every step uses a fixed --key,
// so rerunning after an engine kill must converge to the same tree, with no duplicates.
//   bun tests/chaos/primitives-scenario.ts <tag>
import { runNew, spawnAgent, cancelAgents, awaitAgents } from "../../src/primitives/ops";

const tag = process.argv[2] ?? "default";
const { runId } = await runNew({ budgetUsd: 8, label: `chaos ${tag}`, key: `chaos-${tag}` });
const sup = await spawnAgent({ runId, profile: "sup", task: "supervise", key: "sup", budgetUsd: 4, start: false });
const c1 = await spawnAgent({ runId, parent: sup.agentId, profile: "coder", task: "part 1", key: "c1", start: false });
const c2 = await spawnAgent({ runId, parent: sup.agentId, profile: "coder", task: "part 2", key: "c2", start: false });
const d = await spawnAgent({ runId, profile: "coder", task: "do work", key: "d", budgetUsd: 1 });
await cancelAgents(runId, sup.agentId, "chaos");
const r: any = await awaitAgents(runId, [d.agentId], { timeoutMs: 60_000 });
if (r.timeout || r.agents[0].status !== "done") { console.log(`✗ d not done: ${JSON.stringify(r.agents[0])}`); process.exit(1); }
console.log(`PRIM ${JSON.stringify({ runId, sup: sup.agentId, c1: c1.agentId, c2: c2.agentId, d: d.agentId })}`);
console.log("✓ primitives scenario ok");
process.exit(0);
