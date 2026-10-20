// Parity eval for ADR-016 step 4: the same goals through `capcomd run --legacy` and
// `capcomd run --recipe` (fake model + fake agent, real bare git repo, direct squash merges).
// Compares, per case: final state, judge verdict, which plan tasks merged, the files landed on
// trunk, and the number of task commits; also reports wall time. Exit 0 only on full parity.
//   bun evals/recipe-parity/run.ts [--json]
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { Engine, engineEnv } from "../../tests/chaos/engine";
import { seedRepo } from "../../tests/chaos/survive";

const ROOT = new URL("../..", import.meta.url).pathname;
const PORT = Number(process.env.EVAL_PORT ?? 7701);
// No agents file: a profile selects a real agent on the legacy path (see the case list).
interface Case { name: string; goal: string; args?: string[]; env?: Record<string, string>; expect?: { merged: number } }
const CASES: Case[] = [
  { name: "plan-3-tasks", goal: "plan and build the feature", expect: { merged: 3 } },
  // A named profile always selects a real agent on the legacy path, so a profile case needs a fake
  // agent binary (as tests/agents/run-e2e-codex.test.ts uses); not in this fakes-only eval yet.
  { name: "explicit-target", goal: "plan the docs update", args: ["--target-branch", "trunk"] },
  { name: "checks-fail", goal: "plan a change whose checks fail", env: { CAPCOMD_TEST_COMMAND: "false" }, expect: { merged: 0 } },
];

interface Outcome { state: string; ok: boolean; judged: boolean | null; merged: string[]; files: string[]; commits: number; failedAttempts: Record<string, number>; ms: number; error?: string }

function git(bare: string, args: string[]) { return spawnSync("git", ["-C", bare, ...args], { encoding: "utf8" }).stdout; }

async function runPath(engineE: NodeJS.ProcessEnv, bare: string, c: Case, path: "legacy" | "recipe", runId: string): Promise<Outcome> {
  const before = new Set(git(bare, ["rev-list", "trunk"]).trim().split("\n"));
  const t = Date.now();
  const env = { ...process.env, ...engineE, CAPCOMD_SPAWN_EXEC: "fake", CAPCOMD_SKIP_PREFLIGHT: "1", CAPCOMD_AWAIT_POLL_MS: "100", ...(c.env ?? {}) };
  const r = spawnSync(process.execPath, ["src/cli/index.ts", "run", c.goal, `--${path}`, "--json", "--run-id", runId, ...(c.args ?? [])], { cwd: ROOT, env, encoding: "utf8", timeout: 180_000 });
  const ms = Date.now() - t;
  writeFileSync(`${process.env.PARITY_DUMP ?? tmpdir()}/parity-${runId}.out`, `${r.stdout}\n--- stderr ---\n${r.stderr}`);
  const lines = r.stdout.trim().split("\n").flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const result = lines.find((l) => l.type === "run.result");
  const final = lines.filter((l) => l.type === "run.completed" || l.type === "run.failed").pop();
  const merged = lines.filter((l) => l.type === "task.merged").map((l) => l.taskId as string).sort();
  const failedAttempts: Record<string, number> = {};
  for (const l of lines) if (l.type === "task.verify_failed" || l.type === "task.conflict") failedAttempts[l.taskId] = (failedAttempts[l.taskId] ?? 0) + 1;
  const fresh = git(bare, ["rev-list", "trunk"]).trim().split("\n").filter((s) => s && !before.has(s));
  const files = fresh.flatMap((sha) => git(bare, ["show", "--name-only", "--format=", sha]).trim().split("\n")).filter(Boolean)
    // task files are named by the task (legacy) or the agent (recipe); compare the count and the non-task files
    .map((f) => (f.startsWith("tasks/") ? "tasks/<task>.md" : f)).sort();
  const judged = final?.type === "run.completed" ? true : final?.type === "run.failed" && final.feedback ? false : null;
  return { state: result?.state ?? (lines.find((l) => l.ok === false)?.error?.code ?? `exit ${r.status}`), ok: !!result?.ok, judged, merged, files, commits: fresh.length, failedAttempts, ms,
    ...(r.status !== 0 && !result ? { error: (r.stdout + r.stderr).slice(-400) } : {}) };
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
