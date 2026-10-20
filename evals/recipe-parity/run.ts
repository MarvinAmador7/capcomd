// Parity eval for ADR-016 step 4: the same goals through `capcomd run --legacy` and
// `capcomd run --recipe` (fake model + fake agent, real bare git repo, direct squash merges).
// Compares, per case: final state, judge verdict, which plan tasks merged, the files landed on
// trunk, and the number of task commits; also reports wall time. Exit 0 only on full parity.
//   bun evals/recipe-parity/run.ts [--json]
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawn, spawnSync } from "child_process";
import { testPort } from "../../tests/helpers/engine";
import { Engine, engineEnv } from "../../tests/chaos/engine";
import { seedRepo } from "../../tests/chaos/survive";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = process.env.EVAL_PORT ? Number(process.env.EVAL_PORT) : await testPort();
// No agents file: a profile selects a real agent on the legacy path (see the case list).
interface Case { name: string; goal: string; args?: string[]; env?: Record<string, string>; expect?: { merged: number }; approve?: boolean }
const CASES: Case[] = [
  { name: "plan-3-tasks", goal: "plan and build the feature", expect: { merged: 3 } },
  // A named profile always selects a real agent on the legacy path, so a profile case needs a fake
  // agent binary (as tests/agents/run-e2e-codex.test.ts uses); not in this fakes-only eval yet.
  { name: "explicit-target", goal: "plan the docs update", args: ["--target-branch", "trunk"] },
  // Protected target: every task parks in awaiting_approval; the eval approves them via the CLI.
  { name: "protected-approve", goal: "plan the release", args: ["--target-branch", "trunk"], env: { CAPCOMD_PROTECTED_BRANCHES: "trunk" }, approve: true, expect: { merged: 3 } },
  { name: "checks-fail", goal: "plan a change whose checks fail", env: { CAPCOMD_TEST_COMMAND: "false" }, expect: { merged: 0 } },
];

interface Outcome { contract: Record<string, unknown>; state: string; ok: boolean; judged: boolean | null; merged: string[]; files: string[]; commits: number; failedAttempts: Record<string, number>; ms: number; error?: string }

function git(bare: string, args: string[]) { return spawnSync("git", ["-C", bare, ...args], { encoding: "utf8" }).stdout; }

const cli = (env: NodeJS.ProcessEnv, args: string[]) => {
  const r = spawnSync(process.execPath, ["src/cli/index.ts", ...args], { cwd: ROOT, env, encoding: "utf8", timeout: 60_000 });
  let body: any = null; try { body = JSON.parse(r.stdout); } catch {}
  return { code: r.status, body };
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/**
 * Differences the eval reports but does not fail on. Each needs Marvin's sign-off (ADR-016).
 * git.merge on a run whose checks fail: legacy verifies and merges in one verifier call (span
 * git.merge even when checks fail first); the recipe verifies (git.verify) and only merges a
 * passing ref (git.merge), so a run that merges nothing has no git.merge span.
 */
const KNOWN_DIFFS: Array<{ key: string; when: (l: Outcome) => boolean; why: string }> = [
  { key: "contract.trace", when: (l) => l.merged.length === 0, why: "git.merge span absent when nothing merged (recipe verifies before merging)" },
];
const REQUIRED_SPANS = ["cli.run", "model.generate", "sandbox.ensure", "git.push", "git.merge"];

/** The public CLI contract Hermes consumes, reduced to comparable facts (ids/timestamps dropped). */
function contract(env: NodeJS.ProcessEnv, runId: string, approvals: Record<string, unknown>) {
  const st = cli(env, ["status", runId, "--json"]);
  const run = st.body?.run ?? {};
  const cancel = cli(env, ["cancel", runId, "--json"]).body ?? {};
  const evs: any[] = cli(env, ["events", runId, "--json"]).body?.events ?? [];
  const ledgerTypes: Record<string, number> = {};
  for (const e of evs) if (e.entity === "run" || /^task-/.test(e.entity)) ledgerTypes[`${e.entity === "run" ? "run" : "task"}:${e.type}`] = (ledgerTypes[`${e.entity === "run" ? "run" : "task"}:${e.type}`] ?? 0) + 1;
  const tr = cli(env, ["trace", runId, "--json"]).body?.trace;
  const names: string[] = (tr?.spans ?? []).map((x: any) => x.name);
  const oneTrace = (tr?.spans ?? []).every((x: any) => x.traceId === tr.traceId);
  return {
    statusCode: st.code,
    statusKeys: Object.keys(run).sort(),
    statusState: run.state,
    statusTasks: (run.tasks ?? []).map((t: any) => `${t.taskId}:${t.state}:${t.targetBranch ?? "-"}`),
    awaitingApproval: run.awaitingApproval ?? null,
    cancel: { ok: cancel.ok, changed: cancel.changed, state: cancel.state, keys: Object.keys(cancel).filter((k) => k !== "schema").sort() },
    ledgerEvents: ledgerTypes,
    trace: { first: names[0] ?? null, oneTrace, has: Object.fromEntries([...REQUIRED_SPANS, "actor.taskBoard.*", "transition.task"].map((n) => [n, n.endsWith("*") ? names.some((x) => x.startsWith(n.slice(0, -1))) : names.includes(n)])) },
    approvals,
  };
}

async function runPath(engineE: NodeJS.ProcessEnv, bare: string, c: Case, path: "legacy" | "recipe", runId: string): Promise<Outcome> {
  const before = new Set(git(bare, ["rev-list", "trunk"]).trim().split("\n"));
  const t = Date.now();
  const env = { ...process.env, ...engineE, CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_AWAIT_POLL_MS: "100", ...(c.env ?? {}) };
  const child = spawn(process.execPath, ["src/cli/index.ts", "run", c.goal, `--${path}`, "--json", "--run-id", runId, ...(c.args ?? [])], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.on("data", (d) => (stdout += d)); child.stderr.on("data", (d) => (stderr += d));
  const exited = new Promise<number | null>((res) => child.on("exit", (code) => res(code)));
  const timer = setTimeout(() => child.kill("SIGKILL"), 180_000);
  const approvals: Record<string, unknown> = {};
  if (c.approve) {
    // Drive the approval flow through the CLI exactly as Hermes does.
    let done = false; exited.then(() => (done = true));
    const approvedSet = new Set<string>();
    let probedEarly = false;
    while (!done) {
      await sleep(300);
      const s = cli(env, ["status", runId, "--json"]).body?.run;
      if (!s) continue;
      for (const taskId of s.awaitingApproval ?? []) {
        if (approvedSet.has(taskId)) continue;
        if (!probedEarly) {
          const other = (s.tasks ?? []).find((x: any) => x.taskId !== taskId && x.state !== "merged");
          if (other) { const e = cli(env, ["approve", runId, other.taskId, "--json"]); approvals.earlyApprove = { code: e.code, error: e.body?.error?.code ?? null }; }
          approvals.firstAwaiting = { runState: s.state, awaiting: s.awaitingApproval };
          probedEarly = true;
        }
        const a = cli(env, ["approve", runId, taskId, "--json"]);
        approvals[taskId] = { code: a.code, state: a.body?.state ?? null };
        approvedSet.add(taskId);
      }
    }
  }
  const code = await exited; clearTimeout(timer);
  const ms = Date.now() - t;
  writeFileSync(`${process.env.PARITY_DUMP ?? tmpdir()}/parity-${runId}.out`, `${stdout}\n--- stderr ---\n${stderr}`);
  const lines = stdout.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const result = lines.find((l) => l.type === "run.result");
  const final = lines.filter((l) => l.type === "run.completed" || l.type === "run.failed").pop();
  const merged = lines.filter((l) => l.type === "task.merged" || l.type === "task.approved").map((l) => l.taskId as string).sort();
  const failedAttempts: Record<string, number> = {};
  for (const l of lines) if (l.type === "task.verify_failed" || l.type === "task.conflict") failedAttempts[l.taskId] = (failedAttempts[l.taskId] ?? 0) + 1;
  const streamTypes = [...new Set(lines.map((l) => l.type).filter((x) => ["run.started", "plan.ready", "task.merged", "task.approved", "task.awaiting_approval", "task.verify_failed", "task.failed", "run.completed", "run.failed", "run.result"].includes(x)))].sort();
  const fresh = git(bare, ["rev-list", "trunk"]).trim().split("\n").filter((s) => s && !before.has(s));
  const files = fresh.flatMap((sha) => git(bare, ["show", "--name-only", "--format=", sha]).trim().split("\n")).filter(Boolean)
    .map((f) => (f.startsWith("tasks/") ? "tasks/<task>.md" : f)).sort();
  const judged = final?.type === "run.completed" ? true : final?.type === "run.failed" && final.feedback ? false : null;
  const ctr = { streamTypes, ...contract(env, runId, approvals) };
  return { contract: ctr, state: result?.state ?? (lines.find((l) => l.ok === false)?.error?.code ?? `exit ${code}`), ok: !!result?.ok, judged, merged, files, commits: fresh.length, failedAttempts, ms,
    ...(code !== 0 && !result ? { error: (stdout + stderr).slice(-400) } : {}) };
}

// One engine + bare repo per case: checks run in the engine, so the case env goes to the engine.
const tag = Date.now().toString(36);
const rows: { name: string; legacy: Outcome; recipe: Outcome; diffs: string[] }[] = [];
for (const c of CASES) {
  const dataDir = mkdtempSync(join(tmpdir(), "capcomd-parity-eng-"));
  const opts = { port: PORT, dataDir, repo: true, ...(c.env ? { env: c.env } : {}) };
  await seedRepo(opts);
  const engine = new Engine(`recipe-parity-${c.name}`, opts);
  await engine.start(null);
  const E = engineEnv(opts);
  const bare = `${dataDir}/git/origin.git`;
  try {
    const legacy = await runPath(E, bare, c, "legacy", `run-par-${tag}-${c.name}-L`);
    const recipe = await runPath(E, bare, c, "recipe", `run-par-${tag}-${c.name}-R`);
    const diffs: string[] = [];
    for (const k of ["state", "ok", "judged", "merged", "files", "commits", "failedAttempts"] as const) {
      if (JSON.stringify(legacy[k]) !== JSON.stringify(recipe[k])) diffs.push(`${k}: legacy=${JSON.stringify(legacy[k])} recipe=${JSON.stringify(recipe[k])}`);
    }
    for (const [k, lv] of Object.entries(legacy.contract)) {
      const rv = (recipe.contract as any)[k];
      if (JSON.stringify(lv) === JSON.stringify(rv)) continue;
      const known = KNOWN_DIFFS.find((d) => d.key === `contract.${k}` && d.when(legacy));
      if (known && k === "trace") {
        // only the git.merge flag may differ; everything else in the trace must still match
        const strip = (x: any) => JSON.stringify({ ...x, has: { ...x.has, "git.merge": null } });
        if (strip(lv) === strip(rv)) { console.log(`    known diff (${c.name}): ${known.why}`); continue; }
      }
      diffs.push(`contract.${k}: legacy=${JSON.stringify(lv)} recipe=${JSON.stringify(rv)}`);
    }
    if (legacy.error || recipe.error) diffs.push(`error: ${legacy.error ?? ""} ${recipe.error ?? ""}`.slice(0, 600));
    if (c.expect && legacy.merged.length !== c.expect.merged) diffs.push(`case expects ${c.expect.merged} merged, legacy merged ${legacy.merged.length}`);
    rows.push({ name: c.name, legacy, recipe, diffs });
    console.log(`${diffs.length ? "✗" : "✓"} ${c.name.padEnd(18)} state=${recipe.state} merged=${recipe.merged.length}/${legacy.merged.length} commits=${recipe.commits}/${legacy.commits} time recipe=${recipe.ms}ms legacy=${legacy.ms}ms${diffs.length ? "\n    " + diffs.join("\n    ") : ""}`);
  } finally {
    await engine.stop();
  }
}
const pass = rows.every((r) => r.diffs.length === 0);
if (process.argv.includes("--json")) console.log(JSON.stringify({ pass, rows }));
console.log(pass ? `PARITY OK (${rows.length} cases)` : `PARITY FAILED (${rows.filter((r) => r.diffs.length).length}/${rows.length})`);
process.exit(pass ? 0 : 1);
