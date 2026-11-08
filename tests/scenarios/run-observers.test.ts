// The runs index and each run's trace directory are written by the daemon's observers of run.changed (plugin API
// §6.6.4, §17.1: observe-runs-index, observe-traces, src/plugins/observe.ts), from what `run new` kept with the run,
// not by `run new` itself: the row is the one `run new` always wrote, in the daemon's index.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { CLI } from "../helpers/engine";
import { world, type World } from "./harness";

let w: World;
const work = mkdtempSync(join(tmpdir(), "capcomd-observers-"));
/** The daemon's runs index (the engine and the CLI share it, as they share the capcomd home). */
const index = join(work, "runs.jsonl");
beforeAll(async () => { w = await world("observers", { CAPCOMD_RUNS_INDEX: index }); }, 120_000);
afterAll(async () => { await w?.stop(); }, 60_000);

const rows = () => (existsSync(index) ? readFileSync(index, "utf8").split("\n").filter(Boolean) : []);
const rowOf = async (runId: string) => {
  for (let i = 0; i < 100; i++) { const l = rows().find((x) => JSON.parse(x).runId === runId); if (l) return l; await Bun.sleep(100); }
  return null;
};
/** `capcomd run new` from a folder of its own, with an environment of its own on top of the world's. */
async function runNew(cwd: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawn(["bun", CLI, "run", "new", "--json", ...args], { cwd, env: { ...process.env, ...w.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  if (code !== 0) throw new Error(`run new failed: ${out} ${err}`);
  return JSON.parse(out.trim().split("\n").pop()!).runId as string;
}

test("a created run's row is the one run new wrote: its creator's folder, repository and label, in the daemon's index", async () => {
  const project = realpathSync(mkdtempSync(join(tmpdir(), "capcomd-observers-project-")));
  // The CLI's own CAPCOMD_RUNS_INDEX names another file: the row isn't the CLI's to write any more.
  const theirs = join(work, "cli-runs.jsonl");
  const key = `obs-${Date.now()}`;
  const runId = await runNew(project, ["--label", "watch me", "--key", key], { CAPCOMD_RUNS_INDEX: theirs, CAPCOMD_TRACE_DIR: join(work, "cli-traces") });
  const line = await rowOf(runId);
  expect(line).not.toBeNull();
  const { client } = await import("../../src/core/relay");
  const created = (await client().scope.getOrCreate([runId]).getScope({}))!.createdAt;
  // Byte for byte: the same keys in the same order.
  expect(line).toBe(JSON.stringify({ runId, label: "watch me", repo: w.env.CAPCOMD_REPO ?? null, cwd: project, createdAt: created }));
  expect(existsSync(theirs)).toBe(false);
  // The trace directory is the creator's, for `capcomd trace` in another shell.
  let trace: unknown = null;
  for (let i = 0; i < 100 && !trace; i++) { trace = (await w.cj(["kv", "get", runId, "_trace"])).j?.value; if (!trace) await Bun.sleep(100); }
  expect(trace).toEqual({ dir: join(work, "cli-traces") });
  // A retry of the same run new is no second row.
  expect(await runNew(project, ["--label", "watch me", "--key", key])).toBe(runId);
  await Bun.sleep(500);
  expect(rows().filter((l) => JSON.parse(l).runId === runId)).toHaveLength(1);
}, 120_000);

test("a run whose run new failed partway is never created as far as plugins know: no row, so it holds no goal branch", async () => {
  await w.repo.seed.ok(["push", "-q", "origin", "main:dev"]);
  const G = `capcomd/obs-${Date.now().toString(36)}`;
  const args = (key: string) => ["--key", key, "--goal", "obs", "--goal-branch", G, "--base", "dev"];
  const first = await runNew(work, args(`obs-g1-${G}`));
  expect(JSON.parse((await rowOf(first))!)).toMatchObject({ runId: first, goalBranch: G });
  // Its scope is made, then the goal branch is refused (the first run holds it): the run isn't created.
  const failed = `run-obs-failed-${Date.now()}`;
  await expect(runNew(work, [...args(`obs-g2-${G}`), "--run-id", failed])).rejects.toThrow(/uses it/);
  const { client } = await import("../../src/core/relay");
  expect(await client().scope.getOrCreate([failed]).getScope({})).not.toBeNull();
  await Bun.sleep(1000);
  expect(rows().some((l) => JSON.parse(l).runId === failed)).toBe(false);
  // Once the first is cancelled, the branch is free again: the failed one doesn't hold it.
  expect((await w.cj(["cancel", first, "--reason", "start over"])).code).toBe(0);
  const third = await runNew(work, args(`obs-g3-${G}`));
  expect(await rowOf(third)).not.toBeNull();
}, 120_000);

test("a run the index doesn't have is recorded the next time it changes (a run made while the daemon's plugins started)", async () => {
  const runId = await runNew(work, ["--key", `obs-late-${Date.now()}`]);
  expect(await rowOf(runId)).not.toBeNull();
  // The index loses it (as if the run had been made before the observers were listening), and the daemon starts again.
  writeFileSync(index, rows().filter((l) => JSON.parse(l).runId !== runId).map((l) => `${l}\n`).join(""));
  await w.restart(500);
  expect(rows().some((l) => JSON.parse(l).runId === runId)).toBe(false);
  // Its first agent starts: the run starts, and its row comes back as it was.
  const done = w.script("obs-done", "capcomd result --summary ok >/dev/null");
  expect((await w.cj(["spawn", runId, "--profile", "worker", "--task", "say ok", "--key", "a1", "--contract", JSON.stringify({ script: done })])).code).toBe(0);
  const line = await rowOf(runId);
  expect(line).not.toBeNull();
  expect(JSON.parse(line!)).toMatchObject({ runId, label: null, cwd: realpathSync(work) });
}, 180_000);
