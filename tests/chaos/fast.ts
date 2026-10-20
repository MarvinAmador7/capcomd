/**
 * Fast chaos gate: the same cases as the serial gate (subprocess.test.ts), run on N
 * isolated workers in parallel. Kill semantics and invariants are unchanged: every case
 * still SIGKILLs its runner's process group (plus that instance's rivet-engine, found by
 * its own ports), cold-restarts the engine on the same data dir and audits all 5 invariants.
 *
 * Isolation per worker slot: its own guard port (+1 api-peer, +10 metrics), its own engine
 * data dir, rivet-services disabled (it binds a fixed :8642). No global pkill anywhere;
 * runner reaping is scoped by `serve --port <port>`.
 *
 * Usage: bun tests/chaos/fast.ts [--rounds 3] [--workers N] [--only killpoints|primitives|recipe|seeds]
 */
import { classify, SLOW_FACTOR } from "./classify";
import { env as envVar } from "../../src/utils/env";
import { availableParallelism, freemem } from "os";
import { mkdirSync, rmSync } from "fs";
import { KILLPOINTS, RECIPE_KILLPOINTS } from "./cases";
import { PRIM_KILLPOINTS, survivePrimitives } from "./primitives";
import { randomKillpoint } from "./harness";
import { survive, type Phases } from "./survive";

const args = process.argv.slice(2);
const arg = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const rounds = Number(arg("rounds") ?? 3);
const only = arg("only");
const seeds = Number(arg("seeds") ?? 50);

// Measured: one worker peaks ~PER_WORKER_MB (runner + engine + client). Cases are mostly
// waiting on the engine's fixed 30s workflow-lease recovery, so N can exceed the core count;
// memory is the real limit.
const PER_WORKER_MB = Number(envVar("CHAOS_PER_WORKER_MB") ?? 250);
const autoN = Math.max(1, Math.min(availableParallelism() * 2, Math.floor((freemem() / 1048576 - 1024) / PER_WORKER_MB), 16));
const N = Number(arg("workers") ?? envVar("CHAOS_WORKERS") ?? autoN);
if (N < 16 && !arg("workers") && !envVar("CHAOS_WORKERS"))
  console.log(`⚠ chaos:fast memory-limited: ${N} workers (MemAvailable ${Math.round(freemem() / 1048576)}MB, ~${PER_WORKER_MB}MB each + 1GB reserve); wall ≈ serial/${N}. 16 workers need ~${16 * PER_WORKER_MB + 1024}MB.`);
const BASE_PORT = Number(envVar("CHAOS_BASE_PORT") ?? 7700);
const DATA_ROOT = envVar("CHAOS_DATA_ROOT") ?? "/tmp/capcomd-chaos-fast";

interface Job { round: number; kind: "killpoint" | "seed" | "primitive" | "recipe"; id: string; killpoint: string; iteration: number; requireKill: boolean }
const jobs: Job[] = [];
for (let round = 1; round <= rounds; round++) {
  if (!only || only === "recipe") for (const kp of RECIPE_KILLPOINTS) jobs.push({ round, kind: "recipe", id: `recipe ${kp}`, killpoint: kp, iteration: 1, requireKill: true });
  if (only !== "seeds" && only !== "primitives" && only !== "recipe") for (const kp of KILLPOINTS) jobs.push({ round, kind: "killpoint", id: kp, killpoint: kp, iteration: 1, requireKill: true });
  if (!only || only === "primitives") for (const kp of PRIM_KILLPOINTS) jobs.push({ round, kind: "primitive", id: `prim ${kp}`, killpoint: kp.split(":")[0]!, iteration: Number(kp.split(":")[1]), requireKill: true });
  if (only !== "killpoints" && only !== "primitives" && only !== "recipe") for (let seed = 1; seed <= seeds; seed++) {
    const pick = randomKillpoint(seed);
    jobs.push({ round, kind: "seed", id: `seed ${seed}`, killpoint: pick.killpoint, iteration: pick.iteration, requireKill: false });
  }
}
// Longest-first-ish: killpoint cases always crash+restart, start them first.
jobs.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "seed" ? 1 : b.kind === "seed" ? -1 : 0));

interface Result { job: Job; ok: boolean; killed: boolean; ms: number; error?: string; phases: Partial<Phases>; slot: number; start: number; end: number }
const results: Result[] = [];
const t0 = Date.now();
const stamp = () => `[${((Date.now() - t0) / 1000).toFixed(1)}s]`;
console.log(`=== chaos:fast start ${new Date().toISOString()} rounds=${rounds} jobs=${jobs.length} workers=${N} (cores=${availableParallelism()} freeMB=${Math.round(freemem() / 1048576)} perWorkerMB=${PER_WORKER_MB})`);

rmSync(DATA_ROOT, { recursive: true, force: true });
let next = 0;
async function worker(slot: number) {
  const port = BASE_PORT + slot * 20;
  const dataDir = `${DATA_ROOT}/w${slot}`;
  mkdirSync(DATA_ROOT, { recursive: true });
  while (next < jobs.length) {
    const job = jobs[next++]!;
    const started = Date.now();
    const r = job.kind === "primitive"
      ? await survivePrimitives(`${job.killpoint}:${job.iteration}`, { port, dataDir })
      : await survive(job.killpoint, job.iteration, job.requireKill, { port, dataDir, repo: process.env.CAPCOMD_CHAOS_REPO !== "0", runPath: job.kind === "recipe" ? "recipe" : "legacy" }, true);
    const res: Result = { job, ok: r.ok, killed: r.killed, ms: Date.now() - started, error: r.error, phases: r.phases, slot, start: started, end: Date.now() };
    results.push(res);
    const p = r.phases;
    console.log(
      `${stamp()} ${r.ok ? "✓" : "✗"} r${job.round} ${job.id} ${job.killpoint}:${job.iteration} w${slot} killed=${r.killed} ${res.ms}ms ` +
      `[up=${p.engineUp ?? "-"} first=${p.firstClient ?? "-"} stop=${p.stop ?? "-"} restart=${p.restart ?? "-"} resume=${p.resume ?? "-"} audit=${p.audit ?? "-"}]` +
      (r.error ? ` ERROR ${r.error.replace(/\s+/g, " ").slice(0, 400)}` : "")
    );
  }
}
await Promise.all(Array.from({ length: N }, (_, i) => worker(i)));
const wall = Date.now() - t0;

const stat = (xs: number[]) => {
  if (xs.length === 0) return "n=0";
  const s = [...xs].sort((a, b) => a - b);
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  return `n=${s.length} mean=${Math.round(mean)} p50=${s[Math.floor(s.length / 2)]} max=${s[s.length - 1]} sum=${s.reduce((a, b) => a + b, 0)}`;
};
console.log(`\n=== per-phase timing (ms, per case)`);
for (const phase of ["wipe", "engineUp", "firstClient", "stop", "restart", "resume", "audit"] as const) {
  console.log(`  ${phase.padEnd(12)} ${stat(results.map((r) => r.phases[phase]).filter((x): x is number => typeof x === "number"))}`);
}
console.log(`  case total   ${stat(results.map((r) => r.ms))}`);
console.log(`\n=== pass counts`);
for (let round = 1; round <= rounds; round++) {
  for (const kind of ["killpoint", "recipe", "primitive", "seed"] as const) {
    const rs = results.filter((r) => r.job.round === round && r.job.kind === kind);
    if (rs.length) console.log(`  round ${round} ${kind}s: ${rs.filter((r) => r.ok).length}/${rs.length} passed (killed ${rs.filter((r) => r.killed).length})`);
  }
}
const verdicts = classify(results);
const failed = results.filter((_, i) => verdicts[i]!.outcome === "fail");
const stalled = results.map((r, i) => ({ r, v: verdicts[i]! })).filter(({ v }) => v.outcome === "host-stall");
// Host stalls do not fail the run unless strict, or unless they are frequent
// enough (>5% of cases) that the box itself is the problem worth surfacing.
const stallLimit = Math.max(1, Math.floor(results.length * 0.05));
// Strict by default in CI (CI=true); locally a stall rate up to 5% is tolerated. CHAOS_STRICT=0|1 overrides.
const strict = process.env.CHAOS_STRICT !== undefined ? process.env.CHAOS_STRICT === "1" : process.env.CI === "true";
const exitCode = failed.length || (stalled.length && (strict || stalled.length > stallLimit)) ? 1 : 0;
console.log(`  TOTAL: ${results.length - failed.length - stalled.length}/${results.length} passed, ${failed.length} failed, ${stalled.length} host-stall (limit ${stallLimit}${strict ? ", strict" : ""}); serial-equivalent case time ${Math.round(results.reduce((a, r) => a + r.ms, 0) / 1000)}s`);
for (const f of failed) console.log(`  FAILED r${f.job.round} ${f.job.id} ${f.job.killpoint}:${f.job.iteration}: ${f.error}`);
for (const { r, v } of stalled) console.log(`  HOST-STALL r${r.job.round} ${r.job.id} ${r.job.killpoint}:${r.job.iteration}: ${v.slowPeers} overlapping cases >${SLOW_FACTOR}x median phase; error: ${(r.error ?? "").replace(/\s+/g, " ").slice(0, 240)}`);
console.log(`=== chaos:fast end ${new Date().toISOString()} wall=${(wall / 1000).toFixed(1)}s exit=${exitCode}`);
process.exit(exitCode);
