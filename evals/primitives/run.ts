// Regression eval for ADR-016 primitives (fakes; no VMs, no model calls). Runs the skill's
// recipes against a fresh engine and checks correctness plus latency against baseline.json.
//   bun evals/primitives/run.ts [--update-baseline]
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { Engine } from "../../tests/chaos/engine";

const PORT = Number(process.env.EVAL_PORT ?? 7681);
const agents = join(mkdtempSync(join(tmpdir(), "capcomd-eval-")), "agents.json");
writeFileSync(agents, JSON.stringify({ schema: "capcomd.agents/v1", agents: {
  sup: { provider: "claude", auth: "subscription", children: { allowSpawn: true, maxDepth: 2, maxChildren: 4, maxTotalDescendants: 8, allowedChildProfiles: ["coder", "sup"], budgetShare: 0.5 } },
  coder: { provider: "claude", auth: "subscription", maxTurns: 20 },
} }));
Object.assign(process.env, { CAPCOMD_AGENTS_FILE: agents, CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_AWAIT_POLL_MS: "100", CAPCOMD_DRIVER_LEASE_MS: "3000", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_ENDPOINT: `http://127.0.0.1:${PORT}` });
const engine = new Engine("eval-primitives", { port: PORT, dataDir: mkdtempSync(join(tmpdir(), "capcomd-eval-eng-")) });
await engine.start(null);
const P = await import("../../src/primitives/ops");

type Case = { name: string; ok: boolean; ms: number; detail?: string };
const cases: Case[] = [];
async function run(name: string, fn: () => Promise<string | void>) {
  const t = Date.now();
  try { const d = await fn(); cases.push({ name, ok: !d, ms: Date.now() - t, ...(d ? { detail: d } : {}) }); }
  catch (e) { cases.push({ name, ok: false, ms: Date.now() - t, detail: String((e as Error).message).slice(0, 300) }); }
}
const tag = Date.now().toString(36);

await run("single-loop", async () => {
  const { runId } = await P.runNew({ budgetUsd: 2, key: `single-${tag}` });
  const a = await P.spawnAgent({ runId, profile: "coder", task: "fix", key: "a" });
  const r: any = await P.awaitAgents(runId, [a.agentId], { timeoutMs: 60_000 });
  if (r.agents[0].status !== "done") return `status ${r.agents[0].status}`;
});
await run("fan-out-4/fan-in", async () => {
  const { runId } = await P.runNew({ budgetUsd: 4, key: `fan-${tag}` });
  const ids = [];
  for (let i = 0; i < 4; i++) ids.push((await P.spawnAgent({ runId, profile: "coder", task: `part ${i}`, key: `p${i}`, budgetUsd: 1, start: false })).agentId);
  // all $4 held by active agents: a 5th is rejected; finished agents release what they didn't spend
  const over = await P.spawnAgent({ runId, profile: "coder", task: "x", key: "over", budgetUsd: 1, start: false }).then(() => "accepted", (e) => (/exceeds|no budget/.test(String(e.message)) ? null : String(e.message)));
  if (over) return `5th spawn while $4 held: ${over}`;
  const r: any = await P.awaitAgents(runId, ids, { timeoutMs: 90_000 });
  const bad = r.agents.filter((a: any) => a.status !== "done");
  if (bad.length) return `${bad.length} not done`;
  const after = await P.spawnAgent({ runId, profile: "coder", task: "x", key: "after", budgetUsd: 1, start: false }).then(() => null, (e) => String(e.message));
  if (after) return `spawn after release rejected: ${after}`;
});
await run("best-of-3 + cancel rest", async () => {
  const { runId } = await P.runNew({ budgetUsd: 3, key: `best-${tag}` });
  const ids = [];
  for (let i = 0; i < 3; i++) ids.push((await P.spawnAgent({ runId, profile: "coder", task: "same", key: `n${i}`, budgetUsd: 1, start: i === 0 })).agentId);
  const r: any = await P.awaitAgents(runId, ids, { timeoutMs: 60_000, any: true });
  if (r.first?.status !== "done") return `first ${r.first?.status}`;
  const rest = ids.filter((i) => i !== r.first.agentId);
  for (const id of rest) await P.cancelAgents(runId, id, "lost");
  const t = await P.listScope(runId);
  const ok = rest.every((id) => ["cancelled", "done"].includes(t.agents.find((a) => a.agentId === id)!.status));
  if (!ok) return "losers not terminal";
});
await run("nested supervisor + cancel propagation", async () => {
  const { runId } = await P.runNew({ budgetUsd: 8, key: `nest-${tag}` });
  const root = await P.spawnAgent({ runId, profile: "sup", task: "plan", key: "root", budgetUsd: 8, start: false });
  const mid = await P.spawnAgent({ runId, parent: root.agentId, profile: "sup", task: "sub", key: "mid", start: false });
  const leaf = await P.spawnAgent({ runId, parent: mid.agentId, profile: "coder", task: "leaf", key: "leaf", start: false });
  if (mid.budgetUsd !== 4 || leaf.budgetUsd !== 2) return `carve ${mid.budgetUsd}/${leaf.budgetUsd}`;
  const deep = await P.spawnAgent({ runId, parent: leaf.agentId, profile: "coder", task: "too deep", start: false }).then(() => "accepted", () => null);
  if (deep) return "depth limit not enforced";
  const c = await P.cancelAgents(runId, root.agentId);
  if (c.cancelled.length !== 3) return `cancelled ${c.cancelled.length}/3`;
});
await run("idempotent spawn ×5", async () => {
  const { runId } = await P.runNew({ budgetUsd: 1, key: `idem-${tag}` });
  const xs = await Promise.all(Array.from({ length: 5 }, () => P.spawnAgent({ runId, profile: "coder", task: "t", key: "same", start: false })));
  if (new Set(xs.map((x) => x.agentId)).size !== 1) return "different ids";
  if (xs.filter((x) => x.created).length !== 1) return `created ×${xs.filter((x) => x.created).length}`;
  if ((await P.listScope(runId)).agents.length !== 1) return "duplicate rows";
});
await engine.stop();

const basePath = new URL("./baseline.json", import.meta.url).pathname;
const report = { at: new Date().toISOString(), cases };
const update = process.argv.includes("--update-baseline");
let regress: string[] = [];
if (existsSync(basePath) && !update) {
  const base = JSON.parse(readFileSync(basePath, "utf8")) as typeof report;
  for (const c of cases) {
    const b = base.cases.find((x) => x.name === c.name);
    if (b && c.ms > Math.max(b.ms * 2, b.ms + 3000)) regress.push(`${c.name} ${c.ms}ms > 2× baseline ${b.ms}ms`);
  }
}
for (const c of cases) console.log(`${c.ok ? "✓" : "✗"} ${c.name.padEnd(40)} ${String(c.ms).padStart(6)}ms ${c.detail ?? ""}`);
for (const r of regress) console.log(`✗ latency regression: ${r}`);
if (update) writeFileSync(basePath, JSON.stringify(report, null, 2) + "\n");
const failed = cases.filter((c) => !c.ok).length + regress.length;
console.log(JSON.stringify({ eval: "primitives", passed: cases.filter((c) => c.ok).length, total: cases.length, regressions: regress.length }));
process.exit(failed ? 1 : 0);
